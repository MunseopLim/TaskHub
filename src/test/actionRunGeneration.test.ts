import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    MainViewProvider,
    executeAction,
    executeActionPipeline,
    isActionCancelled,
    stopRunningAction,
} from '../extension';
import { actionStates } from '../providers/actionStatus';
import { ActionItem, Action as PipelineAction } from '../schema';

/**
 * A total-output abort may stop draining while a native dialog from that run
 * is still open. The next run can then reuse the same action id. Runtime state
 * must therefore be tied to a concrete generation, not looked up by id after
 * an await: otherwise the old dialog adopts the new run's live token and its
 * output side effects execute after the old action already failed.
 */
suite('action run generation isolation', () => {
    function makeContext(): vscode.ExtensionContext {
        const store = new Map<string, unknown>();
        const memento = {
            get: <T>(key: string, defaultValue?: T) =>
                (store.has(key) ? store.get(key) as T : defaultValue),
            update: async (key: string, value: unknown) => { store.set(key, value); },
            keys: () => Array.from(store.keys()),
            setKeysForSync: () => { /* no-op */ },
        };
        return {
            extensionPath: path.resolve(__dirname, '..', '..'),
            subscriptions: [],
            workspaceState: memento,
            globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-test' } },
        } as unknown as vscode.ExtensionContext;
    }

    async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) { clearTimeout(timer); }
        }
    }

    test('late native-dialog response cannot adopt a newer same-id run or write output', async function () {
        this.timeout(20000);

        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-run-generation-'));
        const pickedPath = path.join(tempWorkspace, 'picked.txt');
        const staleOutputPath = path.join(tempWorkspace, 'stale-output.txt');
        fs.writeFileSync(pickedPath, 'picked');

        const config = vscode.workspace.getConfiguration('taskhub');
        const previousTotalLimit = config.get<number>('pipeline.totalOutputLimitMb');
        const previousCaptureLimit = config.get<number>('pipeline.outputCaptureLimitMb');
        const previousParallelism = config.get<number>('pipeline.maxParallelTasks');

        const originalShowOpenDialog = vscode.window.showOpenDialog;
        const originalShowInputBox = vscode.window.showInputBox;
        let resolveOldDialog!: (value: vscode.Uri[] | undefined) => void;
        let reportOldDialogOpened!: () => void;
        const oldDialogOpened = new Promise<void>(resolve => { reportOldDialogOpened = resolve; });
        let reportRun2PromptOpened!: () => void;
        const run2PromptOpened = new Promise<void>(resolve => { reportRun2PromptOpened = resolve; });
        let run2Token: vscode.CancellationToken | undefined;
        let run2: Promise<unknown> | undefined;

        try {
            await config.update('pipeline.totalOutputLimitMb', 1, vscode.ConfigurationTarget.Global);
            await config.update('pipeline.outputCaptureLimitMb', 1, vscode.ConfigurationTarget.Global);
            await config.update('pipeline.maxParallelTasks', 4, vscode.ConfigurationTarget.Global);

            (vscode.window as any).showOpenDialog = () => {
                reportOldDialogOpened();
                return new Promise<vscode.Uri[] | undefined>(resolve => { resolveOldDialog = resolve; });
            };
            (vscode.window as any).showInputBox = (
                _options: vscode.InputBoxOptions,
                token?: vscode.CancellationToken
            ) => {
                run2Token = token;
                reportRun2PromptOpened();
                return new Promise<string | undefined>(resolve => {
                    if (!token || token.isCancellationRequested) {
                        resolve(undefined);
                        return;
                    }
                    token.onCancellationRequested(() => resolve(undefined));
                });
            };

            const chunk = 'x'.repeat(600 * 1024);
            const run1Action: PipelineAction = {
                description: 'abandon a native dialog after the total-output limit',
                tasks: [
                    {
                        id: 'old-dialog',
                        type: 'fileDialog',
                        parallel: true,
                        passTheResultToNextTask: true,
                        output: {
                            mode: 'file',
                            filePath: path.basename(staleOutputPath),
                            content: 'stale run wrote this',
                            overwrite: true,
                        },
                    },
                    {
                        id: 'bulk-a',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: chunk,
                        parallel: true,
                        passTheResultToNextTask: true,
                    },
                    {
                        id: 'bulk-b',
                        type: 'stringManipulation',
                        function: 'trim',
                        input: chunk,
                        parallel: true,
                        passTheResultToNextTask: true,
                    },
                ],
            };

            const actionId = 'generation-reuse';
            const run1 = executeActionPipeline(
                run1Action,
                makeContext(),
                actionId,
                tempWorkspace,
                [tempWorkspace],
                { abortDrainTimeoutMs: 25 }
            );
            const run1Outcome = run1.then(
                () => { throw new Error('run1 unexpectedly succeeded'); },
                error => error as unknown
            );

            await within(oldDialogOpened, 3000, 'run1 native dialog');
            const run1Error = await within(run1Outcome, 3000, 'run1 total-output abort');
            assert.ok(run1Error instanceof Error);
            assert.match(run1Error.message, /combined task output exceeded/i);

            const context = makeContext();
            const run2Item: ActionItem = {
                id: actionId,
                title: 'new generation',
                action: {
                    description: 'keeps the replacement generation alive',
                    tasks: [{ id: 'new-prompt', type: 'inputBox', prompt: 'new run value?' }],
                },
            } as unknown as ActionItem;
            const mainView = new MainViewProvider(context, () => [run2Item]);
            run2 = executeAction(run2Item, context, mainView);
            run2.catch(() => { /* settled and asserted after Stop below */ });

            assert.strictEqual(isActionCancelled(actionId), false, 'run2 must start with a live token');

            // The old file-dialog task still owns the global interactive lock.
            // Resolving it lets its late continuation run before run2's prompt
            // acquires that lock, so prompt-open is a deterministic fence for
            // checking whether the stale output side effect happened.
            resolveOldDialog([vscode.Uri.file(pickedPath)]);
            await within(run2PromptOpened, 3000, 'run2 prompt after old dialog');

            assert.ok(run2Token, 'run2 inputBox must receive its own cancellation token');
            assert.strictEqual(run2Token!.isCancellationRequested, false, 'run1 cleanup must not cancel run2');
            assert.strictEqual(isActionCancelled(actionId), false, 'the current same-id run must remain live');
            assert.ok(
                !fs.existsSync(staleOutputPath),
                'the abandoned run resumed after its dialog and executed output.mode=file'
            );

            assert.strictEqual(stopRunningAction(actionId), true, 'run2 should still be the stoppable current run');
            await within(run2, 3000, 'run2 stop');
        } finally {
            // Never leave an interactive run or a fake native dialog pending if
            // an assertion above fails; either one would poison the global
            // prompt mutex for every later test file.
            resolveOldDialog?.(undefined);
            stopRunningAction('generation-reuse');
            if (run2) {
                await within(run2.then(() => undefined, () => undefined), 3000, 'run2 cleanup').catch(() => undefined);
            }
            (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            (vscode.window as any).showInputBox = originalShowInputBox;
            await config.update('pipeline.totalOutputLimitMb', previousTotalLimit, vscode.ConfigurationTarget.Global);
            await config.update('pipeline.outputCaptureLimitMb', previousCaptureLimit, vscode.ConfigurationTarget.Global);
            await config.update('pipeline.maxParallelTasks', previousParallelism, vscode.ConfigurationTarget.Global);
            actionStates.clear();
            try { fs.rmSync(tempWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('fileDialog task timeout discards a late response before output.mode=file', async function () {
        this.timeout(10000);

        const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-task-timeout-'));
        const pickedPath = path.join(tempWorkspace, 'picked.txt');
        const staleOutputPath = path.join(tempWorkspace, 'timed-out-output.txt');
        fs.writeFileSync(pickedPath, 'picked');

        const originalShowOpenDialog = vscode.window.showOpenDialog;
        const originalShowInputBox = vscode.window.showInputBox;
        let resolveTimedOutDialog!: (value: vscode.Uri[] | undefined) => void;
        let reportDialogOpened!: () => void;
        const dialogOpened = new Promise<void>(resolve => { reportDialogOpened = resolve; });
        let reportFencePromptOpened!: () => void;
        const fencePromptOpened = new Promise<void>(resolve => { reportFencePromptOpened = resolve; });
        let fenceRun: Promise<void> | undefined;

        try {
            (vscode.window as any).showOpenDialog = () => {
                reportDialogOpened();
                return new Promise<vscode.Uri[] | undefined>(resolve => { resolveTimedOutDialog = resolve; });
            };
            (vscode.window as any).showInputBox = () => {
                reportFencePromptOpened();
                return Promise.resolve('done');
            };

            const timedOutAction: PipelineAction = {
                description: 'native dialog outlives its task timeout',
                tasks: [{
                    id: 'timed-out-dialog',
                    type: 'fileDialog',
                    timeoutSeconds: 0.025,
                    passTheResultToNextTask: true,
                    output: {
                        mode: 'file',
                        filePath: path.basename(staleOutputPath),
                        content: 'a timed-out task must never write this',
                        overwrite: true,
                    },
                }],
            };

            const timedOutRun = executeActionPipeline(
                timedOutAction,
                makeContext(),
                'native-dialog-timeout',
                tempWorkspace,
                [tempWorkspace]
            );
            const timedOutOutcome = timedOutRun.then(
                () => { throw new Error('timed-out dialog task unexpectedly succeeded'); },
                error => error as unknown
            );

            await within(dialogOpened, 3000, 'timed-out native dialog');
            const timeoutError = await within(timedOutOutcome, 3000, 'dialog task timeout');
            assert.ok(timeoutError instanceof Error);
            assert.match(timeoutError.message, /timed out/i);

            // A second interactive pipeline queues behind the still-open native
            // dialog. Its prompt opening is a deterministic fence proving the
            // old executeSingleTask continuation (including output handling)
            // has fully settled after we return the late selection.
            fenceRun = executeActionPipeline(
                {
                    description: 'prompt-lock fence',
                    tasks: [{ id: 'fence', type: 'inputBox', prompt: 'fence' }],
                },
                makeContext(),
                'native-dialog-timeout-fence',
                tempWorkspace,
                [tempWorkspace]
            );
            resolveTimedOutDialog([vscode.Uri.file(pickedPath)]);
            await within(fencePromptOpened, 3000, 'prompt-lock fence');
            await within(fenceRun, 3000, 'fence pipeline');

            assert.ok(
                !fs.existsSync(staleOutputPath),
                'a fileDialog response that arrived after timeout executed output.mode=file'
            );
        } finally {
            resolveTimedOutDialog?.(undefined);
            if (fenceRun) {
                await within(fenceRun.then(() => undefined, () => undefined), 3000, 'fence cleanup').catch(() => undefined);
            }
            (vscode.window as any).showOpenDialog = originalShowOpenDialog;
            (vscode.window as any).showInputBox = originalShowInputBox;
            actionStates.clear();
            try { fs.rmSync(tempWorkspace, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('one-shot TaskExecution may resolve after pipeline finalization without being terminated', async function () {
        this.timeout(10000);

        const originalExecuteTask = vscode.tasks.executeTask;
        const originalOnDidEndTaskProcess = vscode.tasks.onDidEndTaskProcess;
        let resolveExecuteTask!: (execution: vscode.TaskExecution) => void;
        const delayedExecution = new Promise<vscode.TaskExecution>(resolve => { resolveExecuteTask = resolve; });
        let reportExecuteTaskCalled!: () => void;
        const executeTaskCalled = new Promise<void>(resolve => { reportExecuteTaskCalled = resolve; });
        let requestedTask: vscode.Task | undefined;
        let endListener: ((event: vscode.TaskProcessEndEvent) => unknown) | undefined;
        let fakeExecution: vscode.TaskExecution | undefined;
        let executionResolved = false;
        let endReported = false;
        let terminateCalls = 0;

        const reportEnd = () => {
            if (!endReported && endListener && fakeExecution) {
                endReported = true;
                endListener({ execution: fakeExecution, exitCode: 0 } as vscode.TaskProcessEndEvent);
            }
        };

        try {
            (vscode.tasks as any).onDidEndTaskProcess = (
                listener: (event: vscode.TaskProcessEndEvent) => unknown
            ): vscode.Disposable => {
                endListener = listener;
                return { dispose: () => { /* listener ownership is asserted through reportEnd */ } };
            };
            (vscode.tasks as any).executeTask = (task: vscode.Task) => {
                requestedTask = task;
                reportExecuteTaskCalled();
                return delayedExecution;
            };

            const pipeline = executeActionPipeline(
                {
                    description: 'one-shot launch outlives its pipeline',
                    tasks: [{
                        id: 'background',
                        type: 'shell',
                        command: 'background-command',
                        isOneShot: true,
                    }],
                },
                makeContext(),
                'late-one-shot-execution'
            );

            await within(executeTaskCalled, 3000, 'one-shot executeTask call');
            await within(pipeline, 3000, 'one-shot pipeline finalization');
            assert.ok(requestedTask, 'executeTask must receive the prepared VS Code task');
            assert.ok(endListener, 'executeStreamedTask must register its process-end listener');

            fakeExecution = {
                task: requestedTask,
                terminate: () => { terminateCalls++; },
            } as vscode.TaskExecution;
            executionResolved = true;
            resolveExecuteTask(fakeExecution);

            // Promise resolution queues executeStreamedTask's await continuation
            // before this test continuation. Two turns make the assignment and
            // any accidental registry mutation deterministic without a timer.
            await Promise.resolve();
            await Promise.resolve();
            assert.strictEqual(
                stopRunningAction('late-one-shot-execution'),
                false,
                'a detached one-shot must not recreate a phantom stoppable action after finalization'
            );
            reportEnd();
            await Promise.resolve();

            assert.strictEqual(
                terminateCalls,
                0,
                'one-shot explicitly outlives its finalized pipeline and must not be killed as stale'
            );
        } finally {
            if (!executionResolved && requestedTask) {
                fakeExecution = {
                    task: requestedTask,
                    terminate: () => { terminateCalls++; },
                } as vscode.TaskExecution;
                executionResolved = true;
                resolveExecuteTask(fakeExecution);
                await Promise.resolve();
                await Promise.resolve();
            }
            reportEnd();
            (vscode.tasks as any).executeTask = originalExecuteTask;
            (vscode.tasks as any).onDidEndTaskProcess = originalOnDidEndTaskProcess;
        }
    });
});
