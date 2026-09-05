import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { executeActionPipeline, handleQuickPick, runCommandCaptureLines } from '../extension';
import { resolveTaskWorkingDirectory } from '../pipelineUtils';

suite('실행 작업 디렉터리와 UTF-8 목록', () => {
    test('상대 cwd는 명시한 액션 워크스페이스 기준이고 기준 없이는 해석하지 않는다', () => {
        const workspace = path.join(os.tmpdir(), 'second-workspace');
        assert.strictEqual(resolveTaskWorkingDirectory('build', workspace), path.join(workspace, 'build'));
        assert.strictEqual(resolveTaskWorkingDirectory('', workspace), workspace);
        assert.strictEqual(resolveTaskWorkingDirectory(workspace, undefined), workspace);
        assert.strictEqual(resolveTaskWorkingDirectory('build', undefined), undefined);
    });

    for (const stream of ['stdout', 'stderr'] as const) {
        test(`${stream}: UTF-8 바이트가 모든 청크 경계에서 나뉘어도 값을 보존한다`, async () => {
            // OS의 파이프 병합 타이밍과 무관하게 한 바이트씩 전달한다.
            const childProcess = require('child_process') as typeof import('child_process');
            const originalSpawn = childProcess.spawn;
            const expected = '한글 파일🙂';
            const child = Object.assign(new EventEmitter(), {
                stdout: new EventEmitter(), stderr: new EventEmitter(),
            });
            (childProcess as any).spawn = () => {
                queueMicrotask(() => {
                    for (const byte of Buffer.from(`${expected}\n`, 'utf8')) {
                        child[stream].emit('data', Buffer.from([byte]));
                    }
                    child.emit('close', stream === 'stdout' ? 0 : 1);
                });
                return child;
            };
            try {
                if (stream === 'stdout') {
                    assert.deepStrictEqual(await runCommandCaptureLines('unused', undefined), [expected]);
                } else {
                    await assert.rejects(runCommandCaptureLines('unused', undefined), error =>
                        error instanceof Error && error.message === expected);
                }
            } finally {
                childProcess.spawn = originalSpawn;
            }
        });
    }

    test('캡처 command와 shell이 액션 워크스페이스의 상대 cwd에서 실행한다', async function () {
        this.timeout(15000);
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-relative-cwd-'));
        const build = path.join(workspace, 'build');
        fs.mkdirSync(build);
        fs.writeFileSync(path.join(build, 'working.js'), 'process.stdout.write(process.cwd());');
        try {
            for (const type of ['command', 'shell'] as const) {
                const output = path.join(workspace, `${type}.txt`);
                await executeActionPipeline({ description: '', tasks: [
                    {
                        id: 'run', type, command: 'node', args: ['working.js'], cwd: 'build',
                        passTheResultToNextTask: true,
                        output: { mode: 'file', filePath: output },
                    },
                ] }, { extensionPath: path.resolve(__dirname, '..', '..') } as vscode.ExtensionContext,
                `relative-cwd-${type}`, workspace, [workspace]);
                assert.strictEqual(fs.realpathSync(fs.readFileSync(output, 'utf8').trim()), fs.realpathSync(build));
            }
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    test('동적 QuickPick은 액션 워크스페이스의 상대 cwd에서 항목을 생성한다', async function () {
        this.timeout(15000);
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-pick-cwd-'));
        fs.mkdirSync(path.join(workspace, 'build'));
        fs.writeFileSync(path.join(workspace, 'build', 'items.js'), 'process.stdout.write("한글 파일\\n");');
        const original = vscode.window.showQuickPick;
        let shownLabels: string[] = [];
        (vscode.window as any).showQuickPick = async (items: any[]) => {
            shownLabels = items.map(item => item.label);
            return items[0];
        };
        try {
            const result = await handleQuickPick({ id: 'pick', type: 'quickPick', cwd: 'build', itemsFromCommand: 'node items.js' }, workspace);
            assert.deepStrictEqual(shownLabels, ['한글 파일']);
            assert.strictEqual(result.value, '한글 파일');
        } finally {
            (vscode.window as any).showQuickPick = original;
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });
});
