import * as path from 'node:path';
import { createZipArchive, extractZipArchive } from '../archiveUtils';
import { attachPipelineTaskIds, buildBuiltinVariableContext } from '../builtinVariables';
import { applyDiagnosticMatchers } from '../diagnosticMatcher';
import { applyOutputCapture, buildForEachValue, buildTaskGraph, evaluateTaskCondition, expandArgTemplate, formatGraphIssue,
    getCommandString, inferTaskDependencies, INTERACTIVE_TASK_TYPES, interpolateCommandPreservingTokens,
    interpolatePipelineVariables, interpolateToolValue, materializeSwitchBranchTask, PipelineBuiltinUnavailableError,
    quickPickUsesItemsFromCommand, resolveForEachItems, resolveTaskWorkingDirectory, referencesSkippedTask,
    taskReferencesSensitiveBuiltin, TaskScheduler, validateTaskGraph, writeWorkspaceFileSync } from '../pipelineUtils';
import { mergeProcessEnvironment } from '../processEnvironment';
import { parsePickLines } from '../quickPickValues';
import { ActionRunLogCollector, type TaskRunLogOutput } from '../runLogStore';
import type { ActionItem, Action, Task } from '../schema';
import { aggregateForEachResults, transformString, writeTaskFile } from '../taskValues';
import { TaskHubError } from './errors';
import { inputResult, missingInput, type Inputs } from './inputs';
import { t } from './language';
import { ProcessFailure, ProcessInterrupted, runProcess, type ProcessStreams } from './process';

type Result = Record<string, unknown>;
type Runnable = ActionItem & { action: Action };

function unsupported(task: Task): string | undefined {
    if (task.type === 'browser') { return 'browser'; }
    if (task.interactiveTerminal) { return 'interactiveTerminal'; }
    if (task.isOneShot) { return 'isOneShot'; }
    if (task.type === 'switch') {
        for (const branch of [...Object.values(task.cases ?? {}), task.defaultCase]) {
            if (branch) {
                const reason = unsupported(materializeSwitchBranchTask(task, branch));
                if (reason) { return reason; }
            }
        }
    }
}

export function executionIssues(tasks: Task[]): string[] {
    const issues = validateTaskGraph(tasks, buildTaskGraph(tasks)).map(formatGraphIssue);
    for (const task of tasks) {
        const reason = unsupported(task);
        if (reason) { issues.push(t(`${task.id}: 독립 실행에서 지원하지 않는 설정 ${reason}`, `${task.id}: unsupported in standalone execution: ${reason}`)); }
    }
    return issues;
}

interface Execution {
    root: string;
    inputs: Inputs;
    sensitive: boolean;
    secrets: Set<string>;
    captureOutput: boolean;
    signal: AbortSignal;
    log: ActionRunLogCollector;
    /** Set while a forEach runs so the iterations' outputs are logged once, as the extension does. */
    outputSink?: IterationSink;
}

/** Logged outputs of a forEach's iterations, and their streams for a secret scan of the joined text. */
interface IterationSink {
    outputs: TaskRunLogOutput[];
    streams: ProcessStreams[];
    bytes: number;
}

/** Upper bound for the iterations' logged output that a forEach keeps in memory. */
const ITERATION_LOG_LIMIT = 32 * 1024 * 1024;

/**
 * The extension logs a forEach task's aggregate result, whose streams join the iterations with newlines.
 * The joined text is checked for secrets again: a multi-line credential printed one line per iteration
 * appears only once the iterations are joined.
 */
function mergeIterationOutputs(sink: IterationSink, exec: Execution): TaskRunLogOutput | undefined {
    // Scan even when nothing is logged: the sensitive mark also guards the results passed to later tasks.
    const scanned = commandLogOutput({ output: sink.streams.map(streams => streams.output).join('\n'),
        stderr: sink.streams.map(streams => streams.stderr).join('\n') }, exec);
    const { outputs } = sink;
    if (!outputs.length) { return undefined; }
    if (exec.sensitive || outputs.some(output => output.availability === 'redacted')) { return { availability: 'redacted' }; }
    return outputs.find(output => output.availability !== 'captured') ?? scanned;
}

function commandLogOutput(streams: ProcessStreams, exec: Execution): TaskRunLogOutput {
    // Inspect complete streams before exposing them, including secrets split across chunks.
    for (const secret of exec.secrets) {
        const value = secret.trim();
        if (value && (streams.output.includes(value) || streams.stderr.includes(value))) {
            exec.sensitive = true;
            break;
        }
    }
    return exec.captureOutput && !exec.sensitive
        ? { availability: 'captured', stdout: streams.output, stderr: streams.stderr }
        : { availability: 'redacted' };
}

async function executeBody(task: Task, context: Result, exec: Execution): Promise<Result> {
    exec.signal.throwIfAborted();
    const expand = (v: string) => interpolatePipelineVariables(v, context);
    if (task.type === 'switch') {
        if (task.forEach !== undefined) {
            throw new TaskConfigError(t(`태스크 '${task.id}'에서 'switch'와 'forEach'를 함께 사용할 수 없습니다.`, `Task '${task.id}' cannot combine 'switch' with 'forEach'.`));
        }
        const selected = expand(task.on!);
        const matched = Object.hasOwn(task.cases!, selected);
        const branch = matched ? task.cases![selected] : task.defaultCase;
        const result = branch ? await executeBody(materializeSwitchBranchTask(task, branch), context, exec) : {};
        return { ...result, matched, selected };
    }
    if (task.forEach !== undefined) {
        const items = resolveForEachItems(task.forEach, context);
        const values: Result[] = [];
        let size = 0;
        const outerSink = exec.outputSink;
        const sink: IterationSink = { outputs: [], streams: [], bytes: 0 };
        exec.outputSink = sink;
        try {
            for (const [index, item] of items.entries()) {
                const local = Object.assign(Object.create(null), context, { each: buildForEachValue(item, index, items.length) });
                const value = await executeBody({ ...task, forEach: undefined }, local, exec);
                size += Buffer.byteLength(JSON.stringify(value));
                if (size > 32 * 1024 * 1024) { throw new Error(t('반복 결과 한도 초과', 'Iteration result limit exceeded')); }
                values.push(value);
            }
        } finally { exec.outputSink = outerSink; }
        recordTaskOutput(task, exec, mergeIterationOutputs(sink, exec));
        return aggregateForEachResults(values);
    }

    const processTask = (raw: boolean, command: string, args: string[], capture: boolean) => {
        const env = Object.fromEntries(Object.entries(task.env ?? {}).map(([key, value]) => [key, expand(value)]));
        addCredentialValues(exec.secrets, env);
        const cwd = resolveTaskWorkingDirectory(task.cwd && expand(task.cwd), exec.root)!;
        return runProcess(raw, command, args, cwd, mergeProcessEnvironment(process.env, env), exec.signal, capture);
    };
    const checkSecretWrite = () => {
        if (exec.sensitive && !task.allowSecretContent) {
            throw new TaskHubError(2, t('민감한 파일 쓰기에는 allowSecretContent가 필요합니다.', 'Writing sensitive content requires allowSecretContent.'));
        }
    };
    let result: Result;
    let output: TaskRunLogOutput | undefined;
    if (INTERACTIVE_TASK_TYPES.has(task.type)) {
        if (!Object.hasOwn(exec.inputs, task.id)) { throw missingInput(task); }
        let dynamicItems;
        if (quickPickUsesItemsFromCommand(task)) {
            const command = expand(getCommandString(task.itemsFromCommand));
            const { output: text } = await processTask(true, command, [], true);
            // itemsExclude is a literal field (docs/actions.md), as in the extension.
            const exclude = [task.itemsExclude ?? []].flat();
            dynamicItems = parsePickLines(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean), task.itemsFromCommandFormat ?? 'lines', exclude, t);
        }
        result = { ...inputResult(task, exec.inputs, context, exec.root, dynamicItems) };
    } else if (task.type === 'command' || task.type === 'shell') {
        const raw = task.type === 'shell';
        const template = getCommandString(task.command);
        if (!template) { throw new TaskHubError(2, t('현재 플랫폼 명령이 없습니다.', 'Missing command for this platform.')); }
        const command = raw ? expand(template) : interpolateCommandPreservingTokens(template, context);
        const args = (task.args ?? []).flatMap(arg => expandArgTemplate(arg, context));
        const recordOutput = exec.captureOutput && !exec.sensitive;
        const streams = await processTask(raw, command, args, task.passTheResultToNextTask === true || recordOutput).catch(error => {
            if (error instanceof ProcessFailure && error.captured) {
                const logged = commandLogOutput(error.streams, exec);
                if (exec.captureOutput) { exec.log.recordOutput(task.id, logged); }
                // The extension also reports diagnostics of a failed build, the case where they matter most.
                recordDiagnostics(task, exec, error.streams.output, error.streams.stderr);
            } else if (error instanceof ProcessInterrupted && exec.captureOutput) {
                // The extension keeps the capture state without content for a stopped command.
                exec.log.recordOutput(task.id, { availability: exec.sensitive ? 'redacted' : 'captured' });
            }
            throw error;
        });
        if (exec.outputSink && exec.outputSink.bytes <= ITERATION_LOG_LIMIT) { exec.outputSink.streams.push(streams); }
        output = commandLogOutput(streams, exec);
        result = task.passTheResultToNextTask ? streams : {};
    } else if (task.type === 'stringManipulation') {
        result = transformString({ ...task, input: task.input === undefined ? undefined : expand(task.input) }, t);
    } else if (task.type === 'writeFile' || task.type === 'appendFile') {
        checkSecretWrite();
        result = writeTaskFile(t, task, context, [exec.root], exec.root, task.type === 'appendFile', exec.sensitive);
    } else if (task.type === 'zip' || task.type === 'unzip') {
        const previous = (id?: string) => id ? context[id] as Result | undefined : undefined;
        const from = previous(task.inputs?.archive ?? task.inputs?.file);
        const dest = previous(task.inputs?.destination);
        const source = task.archive ? expand(task.archive) : from?.path ?? from?.archivePath ?? from?.output;
        if (typeof source !== 'string' || !source) { throw new TaskHubError(2, t('압축 파일 경로가 필요합니다.', 'An archive path is required.')); }
        const cwd = resolveTaskWorkingDirectory(task.cwd && expand(task.cwd), exec.root)!;
        const archive = path.resolve(cwd, source);
        const tool = task.tool && interpolateToolValue(task.tool, context);
        if (tool === undefined && path.extname(archive).toLowerCase() !== '.zip') {
            throw new TaskHubError(2, t('내장 엔진에는 .zip 파일이 필요합니다.', 'Built-in archive operations require .zip.'));
        }
        if (task.type === 'zip') {
            const sources = [task.source ?? []].flat().map(v => path.resolve(cwd, expand(v)));
            if (!sources.length) { throw new TaskHubError(2, t('압축할 경로가 필요합니다.', 'Archive sources are required.')); }
            if (tool !== undefined) { await processTask(false, tool, ['a', archive, ...sources], false); }
            else { await createZipArchive(archive, sources, { signal: exec.signal }); }
            result = { archivePath: archive };
        } else {
            const target = task.destination ? expand(task.destination) : dest?.path ?? dest?.outputDir ?? from?.dir ?? path.dirname(archive);
            if (typeof target !== 'string') { throw new TaskHubError(2, t('해제 경로가 필요합니다.', 'An extraction path is required.')); }
            const outputDir = path.resolve(cwd, target);
            if (tool !== undefined) { await processTask(false, tool, ['x', archive, '-o' + outputDir, '-aoa'], false); }
            else { await extractZipArchive(archive, outputDir, { signal: exec.signal }); }
            result = { outputDir };
        }
    } else {
        throw new TaskHubError(2, t('지원하지 않는 태스크입니다.', 'Unsupported task type.'));
    }

    if (typeof result.output === 'string') {
        Object.assign(result, applyOutputCapture(result.output, task.output?.capture));
        recordDiagnostics(task, exec, result.output, typeof result.stderr === 'string' ? result.stderr : '');
    }
    if (task.passTheResultToNextTask && task.output?.mode) {
        const content = task.output.content ? expand(task.output.content)
            : typeof result.output === 'string' ? result.output : JSON.stringify(result, null, 2);
        if (task.output.mode === 'file') {
            checkSecretWrite();
            const overwrite = task.output.overwrite;
            writeWorkspaceFileSync(expand(task.output.filePath ?? ''), [exec.root], exec.root, content, {
                overwrite: typeof overwrite === 'string' ? expand(overwrite).trim().toLowerCase() === 'true' : overwrite === true,
                mode: exec.sensitive ? 0o600 : undefined,
            });
        } else if (exec.captureOutput && !exec.sensitive) {
            output = { availability: 'captured', stdout: content, stderr: output?.stderr };
        }
    }
    recordTaskOutput(task, exec, output);
    return result;
}

function recordDiagnostics(task: Task, exec: Execution, stdout: string, stderr: string) {
    if (!task.output?.diagnostics || exec.sensitive) { return; }
    const totals = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const d of applyDiagnosticMatchers([stdout, stderr].filter(Boolean).join('\n'), task.output.diagnostics)) {
        totals[d.severity]++;
    }
    exec.log.recordDiagnostics(task.id, totals);
}

function recordTaskOutput(task: Task, exec: Execution, output: TaskRunLogOutput | undefined) {
    if (!output) { return; }
    const sink = exec.outputSink;
    if (!sink) { exec.log.recordOutput(task.id, output); return; }
    sink.bytes += Buffer.byteLength(output.stdout ?? '') + Buffer.byteLength(output.stderr ?? '');
    // Past the limit the content is dropped, so the log reports a truncated capture instead of growing without bound.
    sink.outputs.push(sink.bytes > ITERATION_LOG_LIMIT && output.availability === 'captured'
        ? { availability: 'capture-truncated', truncated: true } : output);
}

/** A task definition the executor rejects at run time. Like the extension, continueOnError still applies. */
class TaskConfigError extends TaskHubError {
    constructor(message: string) { super(2, message); }
}

/** Names the missing variable without its value. IDE-only values (editor, selection, clipboard) never exist here. */
function unavailableBuiltinMessage(error: PipelineBuiltinUnavailableError): string {
    const variable = error.variable;
    if (variable?.startsWith('env:')) {
        const name = variable.slice('env:'.length);
        return t(`환경변수 ${name}이(가) 정의되지 않았습니다.`, `Environment variable ${name} is not defined.`);
    }
    return variable
        ? t(`독립 실행에서는 IDE 내장 변수 \${${variable}}를 사용할 수 없습니다.`, `IDE built-in variable \${${variable}} is unavailable in standalone execution.`)
        : t('사용할 수 없는 내장 변수를 참조합니다.', 'References an unavailable built-in variable.');
}

function addCredentialValues(secrets: Set<string>, environment: NodeJS.ProcessEnv) {
    for (const [key, value] of Object.entries(environment)) {
        if (value && /(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i.test(key)) { secrets.add(value); }
    }
}

export async function runPipeline(item: Runnable, root: string, extensionPath: string, inputs: Inputs,
    signal: AbortSignal, captureOutput: boolean) {
    const tasks = item.action.tasks;
    const issues = executionIssues(tasks);
    if (issues.length) { throw new TaskHubError(2, issues.join('\n')); }
    const graph = buildTaskGraph(tasks);
    const ids = new Set(graph.order);
    const interactiveIds = new Set(tasks.filter(task => INTERACTIVE_TASK_TYPES.has(task.type)).map(task => task.id));
    if (Object.keys(inputs).some(id => !interactiveIds.has(id))) {
        throw new TaskHubError(2, t('알 수 없는 입력 태스크 ID입니다.', 'Unknown input task ID.'));
    }
    for (const task of tasks) {
        if (interactiveIds.has(task.id) && !task.when && graph.nodes.get(task.id)!.inferredDeps.size === 0 && !Object.hasOwn(inputs, task.id)) {
            throw missingInput(task);
        }
    }
    const secrets = new Set<string>();
    addCredentialValues(secrets, process.env);
    for (const task of tasks) {
        const value = inputs[task.id];
        if (task.password && typeof value === 'string' && value) { secrets.add(value); }
    }
    const context = attachPipelineTaskIds(buildBuiltinVariableContext({ workspaceFolder: root, extensionPath, strict: true }), ids);
    const scheduler = new TaskScheduler(graph, { maxConcurrency: 4 });
    const log = new ActionRunLogCollector(item.id, item.title, Date.now(), tasks);
    const skipped = new Set<string>();
    const sensitive = new Set<string>();
    const active = new Map<string, Promise<void>>();
    const stop = new AbortController();
    const runSignal = AbortSignal.any([signal, stop.signal]);
    let failure: TaskHubError | undefined;
    let resultBytes = 0;

    const execute = async (task: Task) => {
        // Like the extension, envPick yields a variable name, not its value; `${env:...}` references stay sensitive.
        const hidden = task.password === true || taskReferencesSensitiveBuiltin(task, ids)
            || inferTaskDependencies(task, sensitive).size > 0;
        const timeout = new AbortController();
        const taskSignal = AbortSignal.any([runSignal, timeout.signal]);
        const timer = task.timeoutSeconds ? setTimeout(() => timeout.abort(), Math.min(task.timeoutSeconds * 1000, 2147483647)) : undefined;
        try {
            taskSignal.throwIfAborted();
            if (referencesSkippedTask(task, skipped, context) ||
                (task.when && !evaluateTaskCondition(task.when, interpolatePipelineVariables(task.when.var, context)))) {
                skipped.add(task.id);
                log.skipTask(task.id, t('조건에 따라 건너뜀', 'Skipped by condition'), Date.now());
            } else {
                log.startTask(task.id, Date.now());
                const execution = { root, inputs, sensitive: hidden, secrets, captureOutput, signal: taskSignal, log };
                const result = await executeBody(task, context, execution);
                taskSignal.throwIfAborted();
                resultBytes += Buffer.byteLength(JSON.stringify(result));
                if (resultBytes > 64 * 1024 * 1024) { throw new TaskHubError(1, t('액션 결과 용량 초과', 'Action result limit exceeded')); }
                context[task.id] = result;
                if (execution.sensitive) { sensitive.add(task.id); }
                log.finishTask(task.id, { status: 'success', finishedAt: Date.now() });
            }
            scheduler.markCompleted(task.id);
        } catch (err) {
            // System errors can embed interpolated paths, argv or stderr. Only deliberately public messages cross this boundary.
            const cancelled = runSignal.aborted || (err instanceof TaskHubError && err.exitCode === 130);
            const detail = cancelled ? t('실행 취소', 'Cancelled') : timeout.signal.aborted ? t('시간 초과', 'Timed out')
                : err instanceof TaskHubError || err instanceof ProcessFailure ? err.message
                : err instanceof PipelineBuiltinUnavailableError ? unavailableBuiltinMessage(err)
                : hidden ? t('민감한 태스크 실패', 'Sensitive task failed') : t('태스크 실행 실패', 'Task execution failed');
            const exitCode = cancelled ? 130 : err instanceof TaskHubError ? err.exitCode : err instanceof PipelineBuiltinUnavailableError ? 2 : 1;
            const error = new TaskHubError(exitCode, task.id + ': ' + detail);
            // Missing or invalid CLI input must not be skipped silently. Configuration errors the extension
            // continues past (an unavailable built-in, a rejected task shape) keep continueOnError.
            const continued = task.continueOnError === true && !cancelled
                && (error.exitCode !== 2 || err instanceof PipelineBuiltinUnavailableError || err instanceof TaskConfigError);
            // Like the extension, a failed command that used sensitive data never reports its output.
            if (hidden && (task.type === 'command' || task.type === 'shell')) { log.recordOutput(task.id, { availability: 'redacted' }); }
            log.finishTask(task.id, { status: continued ? 'continued' : 'failure', finishedAt: Date.now(), error: detail,
                ...(hidden && !(err instanceof TaskHubError) ? { errorCode: 'sensitive-hidden' as const } : {}),
                ...(err instanceof ProcessFailure ? { exitCode: err.code, signal: err.signal } : {}) });
            if (continued) {
                context[task.id] = {};
                scheduler.markCompleted(task.id);
            } else {
                failure ??= error;
                scheduler.markFailed(task.id);
                stop.abort();
            }
        } finally { clearTimeout(timer); }
    };

    while (!scheduler.isFinished()) {
        for (const id of scheduler.nextReady()) {
            scheduler.markStarted(id);
            active.set(id, execute(tasks[graph.nodes.get(id)!.index]).finally(() => active.delete(id)));
        }
        await Promise.race(active.values());
    }
    const exitCode = signal.aborted ? 130 : failure?.exitCode ?? 0;
    const outcome = exitCode === 130 ? 'cancelled' : exitCode ? 'failure' : 'success';
    return { exitCode, log: log.finish(outcome, Date.now(), failure?.message) };
}
