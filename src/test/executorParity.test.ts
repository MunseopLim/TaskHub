import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildBuiltinVariableContext } from '../builtinVariables';
import { initDialogMemory } from '../dialogMemory';
import { __testHook_resetShellEnvNamesCache, ActionStoppedError, executeActionPipeline, PromptCancelledError } from '../extension';
import { INTERACTIVE_TASK_TYPES } from '../pipelineUtils';
import { ActionRunLogCollector, type ActionRunLog } from '../runLogStore';
import type { ActionItem, Action, Task } from '../schema';
import { parseInputs } from '../standalone/inputs';
import { runPipeline } from '../standalone/runner';

/**
 * 같은 actions.json을 VS Code 확장 실행기와 독립 실행기(CLI·MCP)에서 돌려 사용자에게
 * 보이는 결과가 같은지 비교한다. 두 실행기를 하나의 Core로 합치기 전의 안전망이다.
 *
 * 비교 대상은 호스트와 무관하게 관찰되는 것만 둔다: 액션 결과, 태스크별 상태·종료 코드·오류 코드·
 * 진단 개수, 캡처된 출력, 워크스페이스에 남은 파일. 오류 문구·소요 시간은 호스트별로 다르다.
 * `passTheResultToNextTask`가 없는 명령은 확장이 VS Code 터미널에 띄우므로 fixture에서 쓰지 않는다.
 *
 * 차이가 있으면 확장의 동작을 기준으로 독립 실행기를 고친다. 호스트 특성상 의도한 차이는
 * `known`에 이유와 그 차이가 나는 필드만 가리는 `mask`를 적는다. 가린 나머지는 그대로 같아야 하고,
 * 가리기 전에는 차이가 **남아 있어야** 한다 — 차이가 사라지면 실패해 `known`을 지우도록 알린다.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

interface Fixture {
    name: string;
    tasks: Task[];
    /** CLI `--inputs-file` 형식의 비대화형 입력. 확장에는 같은 원시 값을 프롬프트 응답으로 준다. */
    inputs?: Record<string, string | string[] | boolean>;
    /** 의도한 호스트 차이. `mask`는 그 차이가 나는 필드만 같은 값으로 바꾼다. */
    known?: { reason: string; mask: (observed: Observed) => void };
}

interface Observed {
    outcome: string;
    tasks: Record<string, unknown>[];
    files: Record<string, string>;
}

const SCRIPTS: Record<string, string> = {
    // 인자와 선택한 환경변수를 한 줄 JSON으로 출력한다.
    'emit.cjs': [
        'const args = process.argv.slice(2);',
        'const at = args.indexOf("--env");',
        'const env = at >= 0 ? { [args[at + 1]]: process.env[args[at + 1]] } : undefined;',
        'console.log(JSON.stringify(env ? { args: args.slice(0, at), env } : { args }));',
    ].join('\n'),
    // stdout과 stderr에 쓰고 지정한 코드로 끝난다.
    'fail.cjs': 'console.log("partial"); console.error("main.c:3:1: error: boom"); process.exit(Number(process.argv[2] || 1));',
    // 인자를 한 줄씩 출력한다(itemsFromCommand용).
    'lines.cjs': 'for (const line of process.argv.slice(2)) { console.log(line); }',
    // 지정한 밀리초 동안 기다린다(timeout용). `--print`면 먼저 한 줄을 출력한다.
    'sleep.cjs': 'if (process.argv[3] === "--print") { console.log("before"); }\nsetTimeout(() => console.log("woke"), Number(process.argv[2] || 10000));',
};

function makeWorkspace(): string {
    // 실제 CLI처럼 native realpath로 정규화한다. Windows 러너의 임시 경로는 8.3 짧은 이름이다.
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-parity-')));
    for (const [name, content] of Object.entries(SCRIPTS)) {
        fs.writeFileSync(path.join(root, name), content);
    }
    // 폴더 선택용. 두 실행의 임시 폴더 이름은 달라서 워크스페이스 자체를 고르면 비교할 수 없다.
    fs.mkdirSync(path.join(root, 'assets'));
    return root;
}

function removeWorkspace(root: string) {
    // 정리 실패가 원래의 실패를 가리지 않게 한다. 남은 임시 폴더는 OS가 정리한다.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
}

function normalizePaths(value: string, root: string): string {
    // VS Code의 Uri.fsPath는 Windows 드라이브 문자를 소문자로 바꾼다. 경로 표기 차이는 비교하지 않는다.
    const flags = process.platform === 'win32' ? 'gi' : 'g';
    const variants = [root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')];
    return variants.reduce((text, variant) =>
        text.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), '<ws>'), value);
}

function snapshotFiles(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (relative === '.taskhub' || Object.hasOwn(SCRIPTS, relative)) { continue; }
            if (entry.isDirectory()) { walk(full); continue; }
            // ZIP 바이트는 생성 시각을 담으므로 존재만 비교하고, 내용은 해제 결과로 비교한다.
            files[relative] = relative.endsWith('.zip') ? '<zip>' : normalizePaths(fs.readFileSync(full, 'utf8'), root);
        }
    };
    walk(root);
    return files;
}

function observe(log: ActionRunLog, root: string): Observed {
    return {
        outcome: log.outcome,
        tasks: log.tasks.map(task => ({
            taskId: task.taskId,
            status: task.status,
            ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
            ...(task.errorCode !== undefined ? { errorCode: task.errorCode } : {}),
            ...(task.diagnostics !== undefined ? { diagnostics: task.diagnostics } : {}),
            output: task.output.availability === 'captured'
                ? { stdout: normalizePaths(task.output.stdout ?? '', root), stderr: normalizePaths(task.output.stderr ?? '', root) }
                : task.output.availability,
        })),
        files: snapshotFiles(root),
    };
}

function actionItem(fixture: Fixture): ActionItem & { action: Action } {
    return { id: 'parity', title: fixture.name, action: { description: fixture.name, tasks: fixture.tasks } };
}

function makeContext(): vscode.ExtensionContext {
    const memento = () => {
        const store = new Map<string, unknown>();
        return {
            keys: () => Array.from(store.keys()),
            get: <T>(key: string, fallback?: T) => (store.has(key) ? store.get(key) as T : fallback),
            update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
            setKeysForSync: () => undefined,
        };
    };
    return { extensionPath: EXTENSION_ROOT, workspaceState: memento(), globalState: memento() } as unknown as vscode.ExtensionContext;
}

/**
 * 확장의 프롬프트가 fixture 입력을 사용자가 고른 것처럼 돌려주게 한다. CLI 입력과 같은 원시
 * 값을 넣어야 CLI가 따로 구현한 입력 변환까지 비교된다.
 *
 * 대체 함수는 suite 동안만 설치한다. 예상 밖의 프롬프트·검증 거부는 예외 대신 사용자 취소로
 * 응답하고 `errors`에 남긴다 — 예외를 던지면 프롬프트가 끝나지 않아 테스트가 멈출 수 있다.
 */
interface PromptSession {
    root: string;
    queue: { task: Task; value: string | string[] | boolean }[];
    errors: string[];
}

let session: PromptSession | undefined;
const STUBBED = ['showInputBox', 'showWarningMessage', 'showOpenDialog', 'showQuickPick', 'createQuickPick'] as const;
let originals: Record<string, unknown> | undefined;

function nextInput(...types: string[]) {
    if (!session) { return undefined; }
    const entry = session.queue.shift();
    if (!entry || !types.includes(entry.task.type)) {
        session.errors.push(`unexpected ${types.join('/')} prompt (next input: ${entry?.task.id ?? 'none'})`);
        return undefined;
    }
    return entry;
}

function installPromptStubs() {
    const window = vscode.window as any;
    originals = Object.fromEntries(STUBBED.map(name => [name, window[name]]));
    const keys = (value: unknown) => [value].flat().map(String);
    const pick = (items: readonly any[], value: unknown) =>
        items.filter(item => keys(value).some(key => item.taskHubItemId === key || item.label === key));
    window.showInputBox = async (options?: vscode.InputBoxOptions) => {
        const entry = nextInput('inputBox');
        if (!entry) { return undefined; }
        const value = String(entry.value);
        // 확장은 validatePattern을 입력 상자의 validateInput으로만 강제한다. 거부되면 사용자는 고치거나 닫는다.
        if (await options?.validateInput?.(value)) { return undefined; }
        return value;
    };
    window.showWarningMessage = async (_message: string, options: unknown, ...items: string[]) => {
        if (!(options as { modal?: boolean } | undefined)?.modal) { return undefined; }
        const entry = nextInput('confirm');
        return entry && (entry.value === true || entry.value === 'true') ? items[0] : items[1];
    };
    window.showOpenDialog = async () => {
        const entry = nextInput('fileDialog', 'folderDialog', 'pathDialog');
        return entry && keys(entry.value).map(value => vscode.Uri.file(path.resolve(session!.root, value)));
    };
    // envPick과 일반 quickPick은 showQuickPick을, 직접 입력·기본값이 있는 quickPick은 createQuickPick을 쓴다.
    window.showQuickPick = async (items: unknown, options?: { canPickMany?: boolean }) => {
        const list = await (items as Promise<any[]>);
        const entry = nextInput('envPick', 'quickPick');
        if (!entry) { return undefined; }
        const matched = pick(list, entry.value);
        return options?.canPickMany ? matched : matched[0];
    };
    window.createQuickPick = () => {
        const accept: Array<() => void> = [];
        const hide: Array<() => void> = [];
        const event = (listeners: Array<() => void>) => (listener: () => void) => { listeners.push(listener); return { dispose: () => undefined }; };
        const none = () => ({ dispose: () => undefined });
        const picker: any = {
            items: [], selectedItems: [], activeItems: [], value: '', canSelectMany: false,
            onDidAccept: event(accept), onDidHide: event(hide),
            onDidChangeValue: none, onDidChangeSelection: none, onDidChangeActive: none, onDidTriggerButton: none,
            show: () => queueMicrotask(() => {
                const entry = nextInput('quickPick');
                if (!entry) { for (const listener of [...hide]) { listener(); } return; }
                picker.selectedItems = pick(picker.items, entry.value);
                for (const listener of [...accept]) { listener(); }
            }),
            hide: () => { for (const listener of [...hide]) { listener(); } },
            dispose: () => undefined,
        };
        return picker;
    };
}

function restorePromptStubs() {
    if (originals) { Object.assign(vscode.window as any, originals); }
    originals = undefined;
}

async function runExtension(fixture: Fixture): Promise<{ observed: Observed; error?: string }> {
    const root = makeWorkspace();
    const queue = fixture.tasks.filter(task => INTERACTIVE_TASK_TYPES.has(task.type) && Object.hasOwn(fixture.inputs ?? {}, task.id))
        .map(task => ({ task, value: fixture.inputs![task.id] }));
    // 프롬프트는 작업 ID를 알려 주지 않으므로 입력 순서로 대응한다. 순서가 모호한 fixture는 만들지 않는다.
    assert.ok(queue.length <= 1, `${fixture.name}: a fixture may answer at most one prompt`);
    session = { root, queue, errors: [] };
    try {
        const item = actionItem(fixture);
        const context = makeContext();
        initDialogMemory(context);
        const collector = new ActionRunLogCollector(item.id, item.title, Date.now(), fixture.tasks);
        let outcome: 'success' | 'failure' | 'cancelled' = 'success';
        let failure: string | undefined;
        try {
            await executeActionPipeline(item.action, context, item.id, root, [root], {
                runLogCollector: collector,
                // 운영 실행과 같은 strict 문맥과 환경 스냅숏을 쓴다. 에디터·클립보드는 CLI처럼 비운다.
                builtinVariables: buildBuiltinVariableContext({ workspaceFolder: root, extensionPath: EXTENSION_ROOT,
                    environment: process.env, strict: true }),
            });
        } catch (error) {
            outcome = error instanceof ActionStoppedError || error instanceof PromptCancelledError ? 'cancelled' : 'failure';
            failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        assert.deepStrictEqual(session.errors, [], `${fixture.name}: prompt stubs`);
        return { observed: observe(collector.finish(outcome, Date.now()), root), error: failure };
    } finally {
        session = undefined;
        removeWorkspace(root);
    }
}

async function runStandalone(fixture: Fixture): Promise<Observed> {
    const root = makeWorkspace();
    try {
        const result = await runPipeline(actionItem(fixture), root, EXTENSION_ROOT, parseInputs(fixture.inputs ?? {}),
            new AbortController().signal, true);
        return observe(result.log, root);
    } finally {
        removeWorkspace(root);
    }
}

const node = (id: string, args: string[], extra: Partial<Task> = {}): Task =>
    ({ id, type: 'command', command: 'node', args, passTheResultToNextTask: true, ...extra } as Task);

const FIXTURES: Fixture[] = [
    {
        name: 'command 인자와 이전 출력 연결',
        tasks: [node('first', ['emit.cjs', 'hello world', 'a"b']), node('second', ['emit.cjs', '${first.output}'])],
    },
    {
        name: '${env:...} 참조 명령 출력은 가림',
        tasks: [node('envref', ['emit.cjs', '${env:TASKHUB_PARITY_ENV}'])],
    },
    {
        name: 'shell 명령줄',
        tasks: [{ id: 'sh', type: 'shell', command: 'node emit.cjs one two', passTheResultToNextTask: true } as Task],
    },
    {
        name: 'task env 치환',
        tasks: [
            { id: 'base', type: 'stringManipulation', function: 'toUpperCase', input: 'value' } as Task,
            node('env', ['emit.cjs', '--env', 'PARITY_VALUE'], { env: { PARITY_VALUE: '${base.output}' } }),
        ],
    },
    {
        name: 'when 건너뛰기와 참조 전파',
        tasks: [
            { id: 'flag', type: 'stringManipulation', function: 'trim', input: ' no ' } as Task,
            node('gated', ['emit.cjs', 'gated'], { when: { var: '${flag.output}', equals: 'yes' } }),
            { id: 'dependent', type: 'writeFile', path: 'dependent.txt', content: '${gated.output}' } as Task,
            { id: 'independent', type: 'writeFile', path: 'independent.txt', content: '${flag.output}' } as Task,
        ],
    },
    {
        name: 'switch case와 defaultCase',
        tasks: [
            { id: 'mode', type: 'stringManipulation', function: 'toLowerCase', input: 'RELEASE' } as Task,
            {
                id: 'pick', type: 'switch', on: '${mode.output}',
                cases: { release: { type: 'writeFile', path: 'release.txt', content: 'r' } },
                defaultCase: { type: 'writeFile', path: 'default.txt', content: 'd' },
            } as Task,
            {
                id: 'fallback', type: 'switch', on: 'unknown',
                cases: { release: { type: 'writeFile', path: 'never.txt', content: 'x' } },
                defaultCase: { type: 'writeFile', path: 'fallback.txt', content: '${pick.selected}:${pick.matched}' },
            } as Task,
        ],
    },
    {
        name: 'forEach 결과 집계',
        tasks: [
            node('loop', ['emit.cjs', '${each.value}'], { forEach: ['x', 'y', 'z'] } as Partial<Task>),
            { id: 'joined', type: 'writeFile', path: 'loop.txt', content: '${loop.count}\n${loop.output}' } as Task,
        ],
    },
    {
        name: 'continueOnError 뒤 계속 실행',
        tasks: [
            node('bad', ['fail.cjs', '3'], { continueOnError: true }),
            { id: 'after', type: 'writeFile', path: 'after.txt', content: 'ran' } as Task,
        ],
    },
    {
        name: '실패하면 뒤 태스크를 실행하지 않음',
        tasks: [
            node('bad', ['fail.cjs', '4']),
            { id: 'after', type: 'writeFile', path: 'after.txt', content: 'ran' } as Task,
        ],
    },
    {
        name: 'writeFile·appendFile과 줄바꿈',
        tasks: [
            { id: 'write', type: 'writeFile', path: 'out/nested/a.txt', content: 'line1\n', eol: 'crlf' } as Task,
            { id: 'append', type: 'appendFile', path: 'out/nested/a.txt', content: 'line2\n' } as Task,
            { id: 'keep', type: 'writeFile', path: 'out/nested/a.txt', content: 'replaced', overwrite: false, continueOnError: true } as Task,
        ],
    },
    {
        name: 'output.capture로 값 추출',
        tasks: [
            node('cap', ['emit.cjs', 'version=1.2.3'], { output: { capture: { name: 'ver', regex: 'version=([0-9.]+)', group: 1 } } } as Partial<Task>),
            { id: 'use', type: 'writeFile', path: 'version.txt', content: '${cap.ver}' } as Task,
        ],
    },
    {
        name: 'zip·unzip 내장 엔진',
        tasks: [
            { id: 'seed', type: 'writeFile', path: 'payload/data.txt', content: 'zipped' } as Task,
            { id: 'pack', type: 'zip', source: ['payload'], archive: 'bundle.zip' } as Task,
            { id: 'unpack', type: 'unzip', archive: 'bundle.zip', destination: 'extracted' } as Task,
        ],
    },
];

const write = (id: string, content: string): Task => ({ id, type: 'writeFile', path: id + '.txt', content } as Task);

const INTERACTIVE_FIXTURES: Fixture[] = [
    {
        name: 'inputBox 접두사·접미사와 검증',
        tasks: [{ id: 'name', type: 'inputBox', prefix: 'pre-', suffix: '-suf', validatePattern: '^[a-z]+$' } as Task,
            write('use', '${name.value}')],
        inputs: { name: 'abc' },
    },
    {
        name: 'confirm 승인',
        tasks: [{ id: 'ok', type: 'confirm', message: 'go?' } as Task, write('use', '${ok.confirmed}')],
        inputs: { ok: true },
    },
    {
        name: 'confirm 거절은 취소',
        tasks: [{ id: 'ok', type: 'confirm', message: 'go?' } as Task, write('use', 'ran')],
        inputs: { ok: false },
    },
    {
        name: 'quickPick 단일 선택과 값 매핑',
        tasks: [{ id: 'mode', type: 'quickPick', items: [{ label: 'Debug', value: 'dbg' }, { id: 'rel', label: 'Release', value: 'rel-value' }] } as Task,
            write('use', '${mode.value}|${mode.label}|${mode.custom}|${mode.valueList}|${mode.labelList}')],
        inputs: { mode: 'rel' },
    },
    {
        name: 'quickPick 다중 선택',
        tasks: [{ id: 'many', type: 'quickPick', canPickMany: true, items: ['a', 'b', 'c'] } as Task,
            write('use', '${many.values}|${many.labels}|${many.valueList}|${many.value}')],
        inputs: { many: ['a', 'c'] },
    },
    {
        name: 'quickPick 배열 값은 인자로 펼침',
        tasks: [
            { id: 'flags', type: 'quickPick', items: [{ id: 'dbg', label: 'Debug', value: ['--mode', 'debug'] }] } as Task,
            node('run', ['emit.cjs', '${flags}']),
        ],
        inputs: { flags: 'dbg' },
    },
    {
        name: 'fileDialog 경로 정보',
        tasks: [{ id: 'file', type: 'fileDialog' } as Task,
            write('use', '${file.path}|${file.dir}|${file.name}|${file.fileNameOnly}|${file.fileExt}')],
        inputs: { file: 'emit.cjs' },
    },
    {
        name: 'fileDialog 다중 선택 결과',
        tasks: [{ id: 'files', type: 'fileDialog', options: { canSelectMany: true } } as Task,
            write('use', '${files.path}|${files.paths}|${files.names}|${files.count}')],
        inputs: { files: ['emit.cjs', 'fail.cjs'] },
    },
    {
        name: 'folderDialog 경로 정보',
        tasks: [{ id: 'dir', type: 'folderDialog' } as Task, write('use', '${dir.path}|${dir.name}')],
        inputs: { dir: 'assets' },
    },
    {
        name: 'envPick 변수 이름',
        tasks: [{ id: 'env', type: 'envPick' } as Task, { ...write('use', '${env.value}'), allowSecretContent: true } as Task],
        inputs: { env: 'TASKHUB_PARITY_ENV' },
    },
    {
        name: 'envPick 결과의 파일 쓰기 정책',
        tasks: [{ id: 'env', type: 'envPick' } as Task, write('use', '${env.value}')],
        inputs: { env: 'TASKHUB_PARITY_ENV' },
    },
    {
        name: 'password 입력의 파일 쓰기 정책',
        tasks: [{ id: 'secret', type: 'inputBox', password: true } as Task, write('use', '${secret.value}')],
        inputs: { secret: 'hunter2' },
    },
    {
        name: 'password 파생 명령 출력은 가림',
        tasks: [{ id: 'secret', type: 'inputBox', password: true } as Task, node('echo', ['emit.cjs', '${secret.value}'])],
        inputs: { secret: 'hunter2' },
    },
];

const EXTRA_FIXTURES: Fixture[] = [
    {
        name: 'forEach 중간 반복 실패',
        tasks: [node('loop', ['fail.cjs', '${each.value}'], { forEach: ['0', '5', '0'] } as Partial<Task>), write('after', 'ran')],
    },
    {
        name: 'timeoutSeconds 초과',
        tasks: [node('slow', ['sleep.cjs', '10000'], { timeoutSeconds: 1 }), write('after', 'ran')],
    },
    {
        name: 'parallel과 dependsOn',
        tasks: [
            node('a', ['emit.cjs', 'a'], { parallel: true }),
            node('b', ['emit.cjs', 'b'], { parallel: true }),
            { ...write('joined', '${a.output}+${b.output}'), dependsOn: ['a', 'b'] } as Task,
        ],
    },
    {
        name: 'switch와 forEach 조합은 거부',
        tasks: [{
            id: 'pick', type: 'switch', on: 'x', forEach: ['1'],
            cases: { x: { type: 'writeFile', path: 'never.txt', content: 'x' } },
        } as Task],
    },
    {
        name: 'switch와 forEach 조합도 continueOnError를 따름',
        tasks: [
            { id: 'pick', type: 'switch', on: 'x', forEach: ['1'], continueOnError: true,
                cases: { x: { type: 'writeFile', path: 'never.txt', content: 'x' } } } as Task,
            write('after', 'ran'),
        ],
    },
    {
        name: '정의되지 않은 ${env:...}는 실패하고 continueOnError를 따름',
        tasks: [
            node('missing', ['emit.cjs', '${env:TASKHUB_PARITY_MISSING}'], { continueOnError: true }),
            node('stop', ['emit.cjs', '${env:TASKHUB_PARITY_MISSING}']),
            write('after', 'ran'),
        ],
    },
    {
        name: '출력 뒤 시간 초과된 명령의 로그',
        // 셸 연결 연산자는 Windows에서 호스트마다 다른 셸을 고르므로 한 프로세스로 출력 뒤 대기한다.
        tasks: [node('slow', ['sleep.cjs', '10000', '--print'], { timeoutSeconds: 1 })],
    },
    {
        name: 'password로 실패한 명령은 상세를 숨김',
        tasks: [{ id: 'secret', type: 'inputBox', password: true } as Task, node('use', ['fail.cjs', '${secret.value}'])],
        inputs: { secret: '7' },
    },
    {
        name: '실패한 명령에도 진단 적용',
        tasks: [node('build', ['fail.cjs', '2'], {
            output: { diagnostics: '$gcc' },
        } as Partial<Task>)],
    },
    {
        name: 'output.content는 에디터에 표시',
        tasks: [node('show', ['emit.cjs', 'raw'], { output: { mode: 'editor', content: 'shown ${show.output}' } } as Partial<Task>)],
        known: {
            reason: 'CLI에는 에디터가 없어 에디터에 띄울 내용을 실행 로그에 남긴다. 확장 로그는 명령 출력을 남긴다',
            mask: observed => { observed.tasks[0].output = '<editor content>'; },
        },
    },
];

const EXTRA_INTERACTIVE_FIXTURES: Fixture[] = [
    {
        name: 'inputBox 검증 실패',
        tasks: [{ id: 'name', type: 'inputBox', validatePattern: '^[a-z]+$' } as Task, write('use', '${name.value}')],
        inputs: { name: 'ABC' },
        known: {
            reason: '확장은 입력 상자를 열어 둔 채 고치게 하고 닫으면 취소된다. CLI는 다시 물을 수 없어 입력 오류로 실패한다',
            mask: observed => { observed.outcome = '<ended>'; observed.tasks[0].status = '<ended>'; },
        },
    },
    {
        name: 'itemsFromCommand와 리터럴 itemsExclude',
        tasks: [
            { id: 'skip', type: 'stringManipulation', function: 'trim', input: 'b' } as Task,
            { id: 'choice', type: 'quickPick', itemsFromCommand: 'node lines.cjs a b ${skip.output}x', itemsExclude: ['${skip.output}x'] } as Task,
            write('use', '${choice.value}'),
        ],
        inputs: { choice: 'bx' },
    },
];

suite('실행기 동등성 (확장 ↔ CLI·MCP)', function () {
    this.timeout(60000);

    // envPick은 셸이 보는 변수 목록을 확장 호스트 수명 동안 캐시한다. 앞선 suite가 채운 캐시에는
    // 이 변수가 없으므로 설정 뒤와 정리 뒤에 비운다.
    suiteSetup(() => {
        process.env.TASKHUB_PARITY_ENV = 'parity';
        __testHook_resetShellEnvNamesCache();
        installPromptStubs();
    });
    suiteTeardown(() => {
        restorePromptStubs();
        delete process.env.TASKHUB_PARITY_ENV;
        __testHook_resetShellEnvNamesCache();
    });
    // output.mode editor가 연 문서가 다음 테스트의 활성 에디터 내장값에 섞이지 않게 한다.
    teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

    const groups: [string, Fixture[]][] = [
        ['입력: ', [...INTERACTIVE_FIXTURES, ...EXTRA_INTERACTIVE_FIXTURES]],
        ['', [...FIXTURES, ...EXTRA_FIXTURES]],
    ];
    for (const [prefix, fixtures] of groups) {
        for (const fixture of fixtures) {
            test((fixture.known ? '[의도한 차이] ' : '') + prefix + fixture.name, async () => {
                const { observed: extension, error } = await runExtension(fixture);
                const standalone = await runStandalone(fixture);
                if (fixture.known) {
                    assert.notDeepStrictEqual(standalone, extension, `차이가 사라졌다면 known을 지운다: ${fixture.known.reason}`);
                    const masked = (observed: Observed) => {
                        const copy = structuredClone(observed);
                        fixture.known!.mask(copy);
                        return copy;
                    };
                    assert.deepStrictEqual(masked(standalone), masked(extension), error && `extension failed with ${error}`);
                } else {
                    // 확장 쪽 실패 원인을 함께 보여 줘야 하네스 문제와 실제 차이를 구분할 수 있다.
                    assert.deepStrictEqual(standalone, extension, error && `extension failed with ${error}`);
                }
            });
        }
    }
});
