import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { executeActionPipeline } from '../extension';
import { Action as PipelineAction } from '../schema';

suite('스트리밍 VS Code Task 실행 식별', function () {
    this.timeout(30000);

    for (const mode of ['args', 'cwd', 'env'] as const) {
        const label = { args: '인자', cwd: '작업 폴더', env: '환경변수' }[mode];
        test(`${label}가 다른 병렬 명령을 실제로 각각 실행하고 각자의 종료 결과를 기다린다`, async () => {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-streamed-identity-'));
            const actionId = `streamed-identity-${process.pid}-${Date.now()}`;
            const release = path.join(workspace, 'release');
            const script = path.join(workspace, 'record.cjs');
            fs.writeFileSync(script, `
                const fs = require('fs');
                const path = require('path');
                const folder = process.argv[2] || process.env.TASKHUB_IDENTITY_FOLDER || path.dirname(process.cwd());
                const id = process.argv[3] || process.env.TASKHUB_IDENTITY_ID || path.basename(process.cwd());
                const exit = process.argv[4] || (id === 'second' ? '7' : '0');
                fs.writeFileSync(path.join(folder, id + '.started'), String(process.pid));
                const timer = setInterval(() => {
                    if (fs.existsSync(path.join(folder, 'release'))) {
                        clearInterval(timer);
                        fs.writeFileSync(path.join(folder, id + '.finished'), String(process.pid));
                        process.exitCode = Number(exit);
                    }
                }, 25);
                setTimeout(() => process.exit(19), 20000).unref();
            `);
            const tasks: vscode.TaskExecution[] = [];
            const subscription = vscode.tasks.onDidStartTask(event => {
                if (event.execution.task.name.includes(actionId)) {
                    tasks.push(event.execution);
                }
            });
            const configuration = vscode.workspace.getConfiguration('taskhub');
            const previous = configuration.get<number>('pipeline.maxParallelTasks');
            await configuration.update('pipeline.maxParallelTasks', 4, vscode.ConfigurationTarget.Global);
            for (const id of ['first', 'second']) { fs.mkdirSync(path.join(workspace, id)); }
            const action: PipelineAction = { description: '', tasks: ['first', 'second'].map(id => ({
                id, type: 'command', command: 'node', parallel: true,
                args: mode === 'args' ? [script, workspace, id, id === 'second' ? '7' : '0'] : [script],
                cwd: mode === 'cwd' ? path.join(workspace, id) : workspace,
                env: mode === 'env' ? { TASKHUB_IDENTITY_FOLDER: workspace, TASKHUB_IDENTITY_ID: id } : undefined,
            })) };
            let settled = false;
            const execution = executeActionPipeline(
                action, { extensionPath: path.resolve(__dirname, '..', '..') } as vscode.ExtensionContext,
                actionId, workspace, [workspace]
            ).then(() => { settled = true; return undefined; }, error => { settled = true; return error as Error; });
            try {
                const deadline = Date.now() + 10000;
                while ((!fs.existsSync(path.join(workspace, 'first.started')) || !fs.existsSync(path.join(workspace, 'second.started')))
                    && Date.now() < deadline && !settled) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                // 두 명령이 모두 실행되었는지는 scheduler running 이벤트가 아니라 실제 PID로 확인한다.
                assert.ok(fs.existsSync(path.join(workspace, 'first.started')), 'The first command did not run.');
                assert.ok(fs.existsSync(path.join(workspace, 'second.started')), 'The second command was silently replaced by another VS Code Task.');
                assert.notStrictEqual(
                    fs.readFileSync(path.join(workspace, 'first.started'), 'utf8'),
                    fs.readFileSync(path.join(workspace, 'second.started'), 'utf8')
                );
                assert.strictEqual(settled, false, 'The pipeline must wait for both running commands.');
                fs.writeFileSync(release, 'release');
                const error = await execution;
                assert.ok(error instanceof Error, 'The second command exits 7, so the pipeline cannot report success.');
                assert.match(error.message, /second/);
                assert.match(error.message, /7/);
                assert.ok(fs.existsSync(path.join(workspace, 'first.finished')));
                assert.ok(fs.existsSync(path.join(workspace, 'second.finished')));
                assert.strictEqual(tasks.length, 2, 'VS Code must start two independent executions.');
                assert.notStrictEqual(tasks[0], tasks[1]);
            } finally {
                fs.writeFileSync(release, 'release');
                if (!settled) {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        await Promise.race([execution, new Promise(resolve => { timer = setTimeout(resolve, 4000); })]);
                    } finally {
                        if (timer) { clearTimeout(timer); }
                    }
                }
                if (!settled) {
                    for (const task of tasks) { try { task.terminate(); } catch { /* Already finished. */ } }
                    await execution;
                }
                subscription.dispose();
                for (const terminal of vscode.window.terminals) {
                    if (terminal.name.includes(actionId)) { terminal.dispose(); }
                }
                await configuration.update('pipeline.maxParallelTasks', previous, vscode.ConfigurationTarget.Global);
                fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
        });
    }
});
