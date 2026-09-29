import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { __testHook_resetShellEnvNamesCache, executeActionPipeline, handleEnvPick, handleQuickPick, runCommandCaptureLines } from '../extension';
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

    test('Windows 목록 명령은 cmd 문법을 재인용하지 않고 POSIX는 로그인 셸을 유지한다', async () => {
        const childProcess = require('child_process') as typeof import('child_process');
        const originalSpawn = childProcess.spawn;
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const command = '"C:\\Program Files\\nodejs\\node.exe" -e "console.log(\'Debug\')" && echo Release';
        try {
            for (const platform of ['win32', 'linux', 'darwin']) {
                let captured: { shell: string; args: string[]; options: import('child_process').SpawnOptions } | undefined;
                const child = Object.assign(new EventEmitter(), {
                    stdout: new EventEmitter(), stderr: new EventEmitter(),
                });
                (childProcess as any).spawn = (shell: string, args: string[], options: import('child_process').SpawnOptions) => {
                    captured = { shell, args, options };
                    queueMicrotask(() => {
                        child.stdout.emit('data', Buffer.from('Debug\nRelease\n'));
                        child.emit('close', 0);
                    });
                    return child;
                };
                Object.defineProperty(process, 'platform', { value: platform });
                const result = runCommandCaptureLines(command, '/selected/workspace');
                Object.defineProperty(process, 'platform', platformDescriptor);
                assert.deepStrictEqual(await result, ['Debug', 'Release']);
                assert.ok(captured);
                const isWindows = platform === 'win32';
                assert.strictEqual(captured.shell, isWindows ? 'cmd.exe' : (process.env.SHELL || '/bin/sh'));
                assert.deepStrictEqual(captured.args, isWindows ? ['/d', '/s', '/c', `"${command}"`] : ['-l', '-c', command]);
                assert.strictEqual(captured.options.windowsVerbatimArguments, isWindows);
                assert.strictEqual(captured.options.detached, !isWindows);
                assert.strictEqual(captured.options.cwd, '/selected/workspace');
                assert.deepStrictEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe']);
            }
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
            childProcess.spawn = originalSpawn;
        }
    });

    test('itemsFromCommand 문서의 큰따옴표가 든 node -e 예제가 실제 목록을 만든다', async function () {
        this.timeout(15000);
        assert.deepStrictEqual(
            await runCommandCaptureLines('node -e "console.log(\'Debug\'); console.log(\'Release\')"', undefined),
            ['Debug', 'Release']
        );
    });

    test('Windows 목록 명령은 공백이 든 실행 파일 경로와 내부 인용·명령 연결을 보존한다', async function () {
        if (process.platform !== 'win32') { this.skip(); }
        this.timeout(15000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub quoted command '));
        const wrapper = path.join(dir, 'node wrapper.cmd');
        fs.writeFileSync(wrapper, '@echo off\r\nnode %*\r\n');
        try {
            assert.deepStrictEqual(
                await runCommandCaptureLines(`"${wrapper}" -e "console.log('quoted path')" && echo tail`, dir),
                ['quoted path', 'tail']
            );
            await assert.rejects(
                runCommandCaptureLines(`"${wrapper}" -e "console.error('quoted failure'); process.exit(7)"`, dir),
                /quoted failure/
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('envPick은 exit 뒤 도착한 마지막 stdout까지 읽고 close에서 목록을 만든다', async () => {
        const childProcess = require('child_process') as typeof import('child_process');
        const originalSpawn = childProcess.spawn;
        const originalPick = vscode.window.showQuickPick;
        const firstName = 'TASKHUB_CAPTURE_FIRST';
        const lastName = 'TASKHUB_CAPTURE_LAST';
        const previousFirst = process.env[firstName];
        const previousLast = process.env[lastName];
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(), stderr: new EventEmitter(),
        });
        let seenNames: string[] | undefined;
        (childProcess as any).spawn = () => child;
        (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
            seenNames = items.map(item => item.label);
            return items.find(item => item.label === lastName);
        };
        process.env[firstName] = 'first';
        process.env[lastName] = 'last';
        __testHook_resetShellEnvNamesCache();
        try {
            const pick = handleEnvPick({ id: 'env-probe' });
            void pick.catch(() => { /* 아래에서 결과를 검증한다. */ });
            child.stdout.emit('data', Buffer.from(`${firstName}=first\n`));
            child.emit('exit', 0);
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(seenNames, undefined, '파이프가 닫히기 전에 목록을 표시했다');
            child.stdout.emit('data', Buffer.from(`${lastName}=last\n`));
            child.emit('close', 0);
            assert.deepStrictEqual(await pick, { value: lastName });
            assert.deepStrictEqual(seenNames, [firstName, lastName]);
        } finally {
            child.emit('close', 1);
            childProcess.spawn = originalSpawn;
            (vscode.window as any).showQuickPick = originalPick;
            if (previousFirst === undefined) { delete process.env[firstName]; } else { process.env[firstName] = previousFirst; }
            if (previousLast === undefined) { delete process.env[lastName]; } else { process.env[lastName] = previousLast; }
            __testHook_resetShellEnvNamesCache();
        }
    });

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
