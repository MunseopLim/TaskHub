import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ParsedDiagnostic } from '../diagnosticMatcher';
import { MainViewProvider, executeAction, executeActionPipeline, stopRunningAction } from '../extension';
import { actionStates } from '../providers/actionStatus';
import * as regexWorkerClient from '../regexWorkerClient';
import type { Action as PipelineAction, ActionItem } from '../schema';

/**
 * 실행기가 worker 정규식 작업의 중지·시간 초과를 지키는지 (0.8.39 후속 리뷰 §12.3).
 *
 * worker 로 옮기면 정규식이 도는 동안에도 태스크 timeout·Stop 이 먼저 끝날 수 있다.
 * 그 뒤 늦게 도착한 캡처·진단 결과가 파일을 쓰거나 Problems 에 게시되면 안 된다.
 */
suite('정규식 worker 작업과 실행기 수명', function () {
    this.timeout(15000);
    const CATASTROPHIC = '^(a+)+$';
    const runaway = 'a'.repeat(35) + '!';
    // tsc 의 CommonJS 출력은 호출 때마다 exports 속성을 읽으므로 여기서 바꾼 함수를 실행기가 부른다.
    const mutableClient = regexWorkerClient as { -readonly [K in keyof typeof regexWorkerClient]: typeof regexWorkerClient[K] };
    let temp: string;

    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
            promise,
            new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('test bound exceeded')), ms); }),
        ]).finally(() => clearTimeout(timer));
    }
    function fakeContext(): vscode.ExtensionContext {
        const store = new Map<string, unknown>();
        const memento = {
            get: (key: string, fallback?: unknown) => store.has(key) ? store.get(key) : fallback,
            update: async (key: string, value: unknown) => { store.set(key, value); },
            keys: () => [...store.keys()],
            setKeysForSync: () => undefined,
        };
        return {
            extensionPath: path.resolve(__dirname, '..', '..'),
            subscriptions: [],
            workspaceState: memento,
            globalState: memento,
            extensionMode: vscode.ExtensionMode.Test,
            extension: { packageJSON: { version: '0.0.0-regex-worker-lifecycle' } },
        } as unknown as vscode.ExtensionContext;
    }

    setup(() => { temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-regex-lifecycle-'))); });
    teardown(() => {
        regexWorkerClient.disposeRegexWorkerPool();
        fs.rmSync(temp, { recursive: true, force: true });
    });

    test('캡처 worker 가 도는 중에도 태스크 시간 초과가 정규식 예산을 기다리지 않는다', async () => {
        const action = {
            description: 'capture timeout',
            tasks: [{
                id: 'capture', type: 'stringManipulation', function: 'trim', input: runaway, timeoutSeconds: 0.2,
                passTheResultToNextTask: true,
                output: { capture: { name: 'x', regex: CATASTROPHIC }, mode: 'file', filePath: 'late.txt', content: 'should not exist', overwrite: true },
            }],
        } as unknown as PipelineAction;
        const started = Date.now();
        await assert.rejects(bounded(executeActionPipeline(action, fakeContext(), 'regex.capture.timeout', temp, [temp])), /timed out/);
        assert.ok(Date.now() - started < 2000, 'worker 예산(3초)을 기다리면 호스트가 막힌 것이다');
    });

    test('시간 초과 뒤 늦게 도착한 캡처 결과로 출력 파일을 쓰지 않는다', async () => {
        const original = mutableClient.applyOutputCaptureOffThread;
        let release: ((value: Record<string, string>) => void) | undefined;
        mutableClient.applyOutputCaptureOffThread = (() => new Promise(resolve => { release = resolve; })) as typeof original;
        try {
            const action = {
                description: 'late capture',
                tasks: [{
                    id: 'late', type: 'stringManipulation', function: 'trim', input: 'ok', timeoutSeconds: 0.1,
                    passTheResultToNextTask: true,
                    output: { capture: { name: 'x', regex: 'ok' }, mode: 'file', filePath: 'late.txt', content: '${late.x}', overwrite: true },
                }],
            } as unknown as PipelineAction;
            await assert.rejects(bounded(executeActionPipeline(action, fakeContext(), 'regex.capture.late', temp, [temp])), /timed out/);
            assert.ok(release, '캡처 작업이 시작돼야 한다');
            release!({ x: '1' });
            await wait(100);
            assert.strictEqual(fs.existsSync(path.join(temp, 'late.txt')), false);
        } finally {
            mutableClient.applyOutputCaptureOffThread = original;
        }
    });

    test('진단 worker 가 도는 중 태스크가 시간 초과되면 곧바로 끝나고 Problems 에 게시하지 않는다', async () => {
        const source = path.join(temp, 'main.c');
        const action = {
            description: 'diagnostics timeout',
            tasks: [{
                id: 'diag', type: 'stringManipulation', function: 'trim', input: `${source}:1: issue\n${runaway}`, timeoutSeconds: 0.2,
                output: { diagnostics: [{ pattern: '^(.*):(\\d+): (.*)$', file: 1, line: 2, message: 3 }, { pattern: CATASTROPHIC, file: 1, line: 1, message: 1 }] },
            }],
        } as unknown as PipelineAction;
        const started = Date.now();
        await assert.rejects(bounded(executeActionPipeline(action, fakeContext(), 'regex.diag.timeout', temp, [temp])), /timed out/);
        assert.ok(Date.now() - started < 2000, 'worker 예산(3초)을 기다리면 호스트가 막힌 것이다');
        await wait(100);
        assert.deepStrictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(source)), []);
    });

    test('시간 초과 뒤 늦게 도착한 진단 결과는 버린다', async () => {
        const source = path.join(temp, 'late.c');
        const original = mutableClient.applyDiagnosticMatchersOffThread;
        let release: ((value: ParsedDiagnostic[]) => void) | undefined;
        mutableClient.applyDiagnosticMatchersOffThread = (() => new Promise(resolve => { release = resolve; })) as typeof original;
        try {
            const action = {
                description: 'late diagnostics',
                tasks: [{ id: 'late', type: 'stringManipulation', function: 'trim', input: 'ok', timeoutSeconds: 0.1, output: { diagnostics: '$gcc' } }],
            } as unknown as PipelineAction;
            await assert.rejects(bounded(executeActionPipeline(action, fakeContext(), 'regex.diag.late', temp, [temp])), /timed out/);
            assert.ok(release, '진단 작업이 시작돼야 한다');
            release!([{ file: source, line: 1, message: 'stale', severity: 'error' }]);
            await wait(100);
            assert.deepStrictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(source)), []);
        } finally {
            mutableClient.applyDiagnosticMatchersOffThread = original;
        }
    });

    test('진단 worker 가 도는 중 Stop 을 누르면 바로 멈추고 게시하지 않는다', async () => {
        const context = fakeContext();
        const source = path.join(temp, 'stop.c');
        const item = {
            id: 'regex.diag.stop',
            title: 'Regex stop',
            action: {
                description: 'stop during diagnostics',
                tasks: [{
                    id: 'stop', type: 'stringManipulation', function: 'trim', input: `${source}:1: issue\n${runaway}`,
                    output: { diagnostics: [{ pattern: '^(.*):(\\d+): (.*)$', file: 1, line: 2, message: 3 }, { pattern: CATASTROPHIC, file: 1, line: 1, message: 1 }] },
                }],
            },
        } as unknown as ActionItem;
        const provider = new MainViewProvider(context, () => [item]);
        const original = mutableClient.applyDiagnosticMatchersOffThread;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        mutableClient.applyDiagnosticMatchersOffThread = ((...args: Parameters<typeof original>) => {
            const running = original(...args);
            entered();
            return running;
        }) as typeof original;
        const config = vscode.workspace.getConfiguration('taskhub');
        const previous = config.inspect('runLogs.enabled')?.globalValue;
        await config.update('runLogs.enabled', false, vscode.ConfigurationTarget.Global);
        let running: Promise<unknown> | undefined;
        try {
            running = executeAction(item, context, provider);
            await bounded(started);
            await wait(100);
            const begin = Date.now();
            assert.strictEqual(stopRunningAction(item.id), true);
            await bounded(running);
            assert.ok(Date.now() - begin < 2000, 'Stop 은 정규식 예산을 기다리지 않아야 한다');
            assert.deepStrictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(source)), []);
        } finally {
            stopRunningAction(item.id);
            if (running) { await bounded(running).catch(() => undefined); }
            mutableClient.applyDiagnosticMatchersOffThread = original;
            provider.dispose();
            actionStates.clear();
            await config.update('runLogs.enabled', previous, vscode.ConfigurationTarget.Global);
        }
    });
});
