import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import * as path from 'path';

export const RUN_LOG_DIRECTORY = '.taskhub/logs';
export const RUN_LOG_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const RUN_LOG_DEFAULT_MAX_FILES = 100;
export const RUN_LOG_DEFAULT_RETENTION_DAYS = 30;
export const RUN_LOG_DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export type ActionRunLogOutcome = 'success' | 'failure' | 'stopped' | 'cancelled';
/**
 * TaskHub가 스스로 만든 실패 사유는 **문장이 아니라 코드로** 남긴다.
 *
 * 로그는 영속 파일이라 쓴 세션과 읽는 세션의 UI 언어가 다를 수 있다. 문장을
 * 그대로 저장하면 한국어 보고서 안에서 정작 읽으러 온 한 줄만 다른 언어로
 * 남는다. 도구가 뱉은 stderr/오류 메시지는 번역 대상이 아니므로 `error`에
 * 원문 그대로 둔다.
 */
export type ActionRunLogErrorCode = 'stopped-by-user' | 'sensitive-hidden';
export type TaskRunLogErrorCode = 'sensitive-hidden';
export type TaskRunLogStatus =
    | 'not-run'
    | 'running'
    | 'success'
    | 'failure'
    | 'continued'
    | 'condition-skipped'
    | 'unfinished';
export type TaskRunLogOutputAvailability =
    | 'captured'
    | 'redacted'
    | 'terminal'
    | 'background-one-shot'
    | 'capture-truncated'
    | 'not-applicable';

export interface TaskRunLogOutput {
    availability: TaskRunLogOutputAvailability;
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
    originalBytes?: number;
}

export interface TaskRunLogDiagnostics {
    error: number;
    warning: number;
    info: number;
    hint: number;
}

export interface TaskRunLogRecord {
    taskId: string;
    type: string;
    index: number;
    status: TaskRunLogStatus;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
    command?: string;
    cwd?: string;
    output: TaskRunLogOutput;
    error?: string;
    errorCode?: TaskRunLogErrorCode;
    exitCode?: number | null;
    signal?: string | null;
    diagnostics?: TaskRunLogDiagnostics;
    artifacts?: string[];
}

export interface ActionRunLog {
    version: 1;
    actionId: string;
    actionTitle: string;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    outcome: ActionRunLogOutcome;
    error?: string;
    errorCode?: ActionRunLogErrorCode;
    truncated?: boolean;
    tasks: TaskRunLogRecord[];
}

export interface ActionRunLogTaskSpec {
    id: string;
    type: string;
}

export interface TaskRunLogCompletion {
    status: Extract<TaskRunLogStatus, 'success' | 'failure' | 'continued'>;
    finishedAt: number;
    error?: string;
    errorCode?: TaskRunLogErrorCode;
    exitCode?: number | null;
    signal?: string | null;
    output?: TaskRunLogOutput;
}

/**
 * 한 실행의 구조화 로그를 메모리에서 조립한다.
 *
 * 원본 비밀을 판정하는 책임은 실행기 쪽에 있다. 이 수집기는 이미 마스킹된
 * command/cwd와 저장 가능한 출력만 받으며, JSON 직렬화 외의 해석을 하지 않는다.
 */
export class ActionRunLogCollector {
    private readonly records: TaskRunLogRecord[];
    private readonly byId = new Map<string, TaskRunLogRecord>();

    constructor(
        private readonly actionId: string,
        private readonly actionTitle: string,
        private readonly startedAt: number,
        tasks: readonly ActionRunLogTaskSpec[]
    ) {
        this.records = tasks.map((task, index) => ({
            taskId: task.id,
            type: task.type,
            index: index + 1,
            status: 'not-run',
            output: { availability: 'not-applicable' },
        }));
        for (const record of this.records) {
            this.byId.set(record.taskId, record);
        }
    }

    startTask(taskId: string, startedAt: number): void {
        const record = this.byId.get(taskId);
        if (!record || record.status !== 'not-run') { return; }
        record.status = 'running';
        record.startedAt = startedAt;
    }

    recordCommand(
        taskId: string,
        command: string,
        cwd: string | undefined,
        availability: TaskRunLogOutputAvailability
    ): void {
        const record = this.byId.get(taskId);
        if (!record) { return; }
        // forEach는 같은 논리 태스크를 여러 번 실행한다. 실행 보고서에서 마지막
        // 명령만 남기지 않고 실제 순서대로 모두 보이게 줄 단위로 누적한다.
        record.command = record.command ? `${record.command}\n${command}` : command;
        if (cwd) { record.cwd = cwd; }
        record.output = { availability };
    }

    skipTask(taskId: string, reason: string, finishedAt: number): void {
        const record = this.byId.get(taskId);
        if (!record) { return; }
        record.status = 'condition-skipped';
        record.finishedAt = finishedAt;
        record.error = reason;
    }

    finishTask(taskId: string, completion: TaskRunLogCompletion): void {
        const record = this.byId.get(taskId);
        if (!record) { return; }
        record.status = completion.status;
        record.finishedAt = completion.finishedAt;
        if (record.startedAt !== undefined) {
            record.durationMs = Math.max(0, completion.finishedAt - record.startedAt);
        }
        if (completion.error) { record.error = completion.error; }
        if (completion.errorCode) { record.errorCode = completion.errorCode; }
        if (completion.exitCode !== undefined) { record.exitCode = completion.exitCode; }
        if (completion.signal !== undefined) { record.signal = completion.signal; }
        if (completion.output) { record.output = completion.output; }
    }

    recordDiagnostics(taskId: string, diagnostics: TaskRunLogDiagnostics): void {
        const record = this.byId.get(taskId);
        if (!record) { return; }
        const current = record.diagnostics ?? { error: 0, warning: 0, info: 0, hint: 0 };
        record.diagnostics = {
            error: current.error + diagnostics.error,
            warning: current.warning + diagnostics.warning,
            info: current.info + diagnostics.info,
            hint: current.hint + diagnostics.hint,
        };
    }

    recordArtifact(taskId: string, artifactPath: string): void {
        const record = this.byId.get(taskId);
        if (!record || !artifactPath) { return; }
        const artifacts = record.artifacts ?? [];
        if (!artifacts.includes(artifactPath)) {
            record.artifacts = [...artifacts, artifactPath];
        }
    }

    finish(
        outcome: ActionRunLogOutcome,
        finishedAt: number,
        error?: string,
        errorCode?: ActionRunLogErrorCode
    ): ActionRunLog {
        for (const record of this.records) {
            if (record.status === 'running') {
                record.status = 'unfinished';
                record.finishedAt = finishedAt;
                if (record.startedAt !== undefined) {
                    record.durationMs = Math.max(0, finishedAt - record.startedAt);
                }
            }
        }
        return {
            version: 1,
            actionId: this.actionId,
            actionTitle: this.actionTitle,
            startedAt: this.startedAt,
            finishedAt,
            durationMs: Math.max(0, finishedAt - this.startedAt),
            outcome,
            ...(error ? { error } : {}),
            ...(errorCode ? { errorCode } : {}),
            tasks: this.records.map(record => ({
                ...record,
                output: { ...record.output },
                ...(record.diagnostics ? { diagnostics: { ...record.diagnostics } } : {}),
                ...(record.artifacts ? { artifacts: [...record.artifacts] } : {}),
            })),
        };
    }
}

export interface RunLogRetentionPolicy {
    maxFiles: number;
    retentionDays: number;
    maxTotalBytes: number;
    maxFileBytes?: number;
}

export interface RunLogWriteResult {
    absolutePath: string;
    workspaceRelativePath: string;
    rotationWarning?: string;
}

interface StoredLogFile {
    path: string;
    size: number;
    mtimeMs: number;
}

export type RunLogReadErrorCode =
    | 'missing'
    | 'workspace-missing'
    | 'unsafe-path'
    | 'too-large'
    | 'invalid'
    | 'mismatch';

export class RunLogReadError extends Error {
    constructor(public readonly code: RunLogReadErrorCode, message: string) {
        super(message);
        this.name = 'RunLogReadError';
    }
}

function isOutside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isOptionalNullableNumber(value: unknown): value is number | null | undefined {
    return value === undefined || value === null || isFiniteNumber(value);
}

function isDiagnosticSummary(value: unknown): value is TaskRunLogDiagnostics {
    if (!isRecord(value)) { return false; }
    return ['error', 'warning', 'info', 'hint'].every(key =>
        Number.isInteger(value[key]) && (value[key] as number) >= 0
    );
}

const ACTION_OUTCOMES = new Set<ActionRunLogOutcome>(['success', 'failure', 'stopped', 'cancelled']);
const TASK_STATUSES = new Set<TaskRunLogStatus>([
    'not-run', 'running', 'success', 'failure', 'continued', 'condition-skipped', 'unfinished',
]);
const OUTPUT_AVAILABILITIES = new Set<TaskRunLogOutputAvailability>([
    'captured', 'redacted', 'terminal', 'background-one-shot', 'capture-truncated', 'not-applicable',
]);
const ACTION_ERROR_CODES = new Set<ActionRunLogErrorCode>(['stopped-by-user', 'sensitive-hidden']);
const TASK_ERROR_CODES = new Set<TaskRunLogErrorCode>(['sensitive-hidden']);

/** 워크스페이스의 JSON 로그를 UI가 소비하기 전에 버전 1 계약으로 좁힌다. */
export function parseActionRunLog(value: unknown): ActionRunLog {
    if (!isRecord(value) || value.version !== 1) {
        throw new RunLogReadError('invalid', 'Unsupported or missing action run log version.');
    }
    if (
        typeof value.actionId !== 'string'
        || typeof value.actionTitle !== 'string'
        || !isFiniteNumber(value.startedAt)
        || !isFiniteNumber(value.finishedAt)
        || !isFiniteNumber(value.durationMs)
        || !ACTION_OUTCOMES.has(value.outcome as ActionRunLogOutcome)
        || !isOptionalString(value.error)
        || (value.errorCode !== undefined && !ACTION_ERROR_CODES.has(value.errorCode as ActionRunLogErrorCode))
        || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
        || !Array.isArray(value.tasks)
    ) {
        throw new RunLogReadError('invalid', 'Action run log metadata is invalid.');
    }

    for (const task of value.tasks) {
        if (!isRecord(task) || !isRecord(task.output)) {
            throw new RunLogReadError('invalid', 'Action run log contains an invalid task record.');
        }
        const output = task.output;
        if (
            typeof task.taskId !== 'string'
            || typeof task.type !== 'string'
            || !Number.isInteger(task.index)
            || (task.index as number) < 1
            || !TASK_STATUSES.has(task.status as TaskRunLogStatus)
            || (task.startedAt !== undefined && !isFiniteNumber(task.startedAt))
            || (task.finishedAt !== undefined && !isFiniteNumber(task.finishedAt))
            || (task.durationMs !== undefined && !isFiniteNumber(task.durationMs))
            || !isOptionalString(task.command)
            || !isOptionalString(task.cwd)
            || !isOptionalString(task.error)
            || (task.errorCode !== undefined && !TASK_ERROR_CODES.has(task.errorCode as TaskRunLogErrorCode))
            || !isOptionalNullableNumber(task.exitCode)
            || !(task.signal === undefined || task.signal === null || typeof task.signal === 'string')
            || !OUTPUT_AVAILABILITIES.has(output.availability as TaskRunLogOutputAvailability)
            || !isOptionalString(output.stdout)
            || !isOptionalString(output.stderr)
            || (output.truncated !== undefined && typeof output.truncated !== 'boolean')
            || (output.originalBytes !== undefined && (!Number.isInteger(output.originalBytes) || (output.originalBytes as number) < 0))
            || (task.diagnostics !== undefined && !isDiagnosticSummary(task.diagnostics))
            || (task.artifacts !== undefined && (
                !Array.isArray(task.artifacts) || !task.artifacts.every(item => typeof item === 'string')
            ))
        ) {
            throw new RunLogReadError('invalid', 'Action run log contains an invalid task record.');
        }
    }
    return value as unknown as ActionRunLog;
}

function validateRunLogRelativePath(relativePath: string): string[] {
    if (typeof relativePath !== 'string' || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)) {
        throw new RunLogReadError('unsafe-path', 'Run log reference is not a safe relative path.');
    }
    const segments = relativePath.split('/');
    if (
        segments.length !== 4
        || segments[0] !== '.taskhub'
        || segments[1] !== 'logs'
        || !segments[2]
        || !segments[3].endsWith('.log')
        || segments.some(segment => !segment || segment === '.' || segment === '..')
        || path.posix.normalize(relativePath) !== relativePath
    ) {
        throw new RunLogReadError('unsafe-path', 'Run log reference is outside the managed log directory.');
    }
    return segments;
}

/**
 * History가 가리키는 로그를 읽는다. workspaceState와 워크스페이스 파일은 둘 다
 * 수정 가능하므로 상대 경로·중간 symlink·파일 종류·크기·JSON 구조를 다시 검증한다.
 */
export async function readActionRunLog(workspaceRoot: string, relativePath: string): Promise<ActionRunLog> {
    const segments = validateRunLogRelativePath(relativePath);
    const targetPath = path.join(workspaceRoot, ...segments);
    // 루트가 사라진 경우와 로그 파일이 회전된 경우는 사용자가 할 일이 서로
    // 다르다. 아래의 일괄 ENOENT → 'missing' 매핑에 삼켜지면 폴더가 통째로
    // 없어졌는데 "보관 정책으로 회전됐습니다"라고 안내하게 된다.
    let realRoot: string;
    try {
        realRoot = await fs.realpath(workspaceRoot);
    } catch (rootError) {
        const code = (rootError as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new RunLogReadError('workspace-missing', `Workspace root is no longer readable: ${workspaceRoot}`);
        }
        throw rootError;
    }
    try {
        let current = workspaceRoot;
        for (const segment of segments.slice(0, -1)) {
            current = path.join(current, segment);
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new RunLogReadError('unsafe-path', `Run log parent is not a real directory: ${current}`);
            }
            if (isOutside(realRoot, await fs.realpath(current))) {
                throw new RunLogReadError('unsafe-path', 'Run log path escapes the workspace.');
            }
        }

        const linkStat = await fs.lstat(targetPath);
        if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
            throw new RunLogReadError('unsafe-path', 'Run log target is not a regular file.');
        }
        const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
        const handle = await fs.open(targetPath, fsConstants.O_RDONLY | noFollow);
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) {
                throw new RunLogReadError('unsafe-path', 'Run log target is not a regular file.');
            }
            if (stat.size > RUN_LOG_MAX_FILE_BYTES) {
                throw new RunLogReadError('too-large', `Run log exceeds the ${RUN_LOG_MAX_FILE_BYTES}-byte read limit.`);
            }
            const text = await handle.readFile('utf8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                throw new RunLogReadError('invalid', 'Run log is not valid JSON.');
            }
            return parseActionRunLog(parsed);
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof RunLogReadError) { throw error; }
        const code = (error as NodeJS.ErrnoException).code;
        // ENOTDIR: 관리 디렉터리 자리에 파일이 생긴 경우. 회전·수동 삭제와
        // 마찬가지로 "더 이상 보관되지 않음"이며, raw Node 메시지를 토스트에
        // 그대로 흘리지 않는다.
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new RunLogReadError('missing', 'Run log file no longer exists.');
        }
        throw error;
    }
}

async function ensureSafeDirectory(root: string, segments: string[]): Promise<string> {
    const realRoot = await fs.realpath(root);
    let current = root;
    for (const segment of segments) {
        current = path.join(current, segment);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(`Run log path is not a real directory: ${current}`);
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') { throw error; }
            try {
                await fs.mkdir(current, { mode: 0o700 });
            } catch (mkdirError) {
                if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') { throw mkdirError; }
            }
            const created = await fs.lstat(current);
            if (created.isSymbolicLink() || !created.isDirectory()) {
                throw new Error(`Run log path is not a real directory: ${current}`);
            }
        }
        const realCurrent = await fs.realpath(current);
        if (isOutside(realRoot, realCurrent)) {
            throw new Error(`Run log path escapes the workspace: ${current}`);
        }
    }
    return current;
}

function actionDirectoryName(actionId: string): string {
    const readable = actionId
        .normalize('NFKC')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'action';
    const digest = createHash('sha256').update(actionId).digest('hex').slice(0, 16);
    return `${readable}-${digest}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
    if (maxBytes <= 0) { return ''; }
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) { return value; }
    let low = 0;
    let high = value.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    if (
        low > 0 && low < value.length
        && value.charCodeAt(low - 1) >= 0xD800 && value.charCodeAt(low - 1) <= 0xDBFF
        && value.charCodeAt(low) >= 0xDC00 && value.charCodeAt(low) <= 0xDFFF
    ) {
        low--;
    }
    return value.slice(0, low);
}

/** 직렬화 자체가 영속 로그 상한을 넘으면 가장 큰 stdout/stderr부터 줄인다. */
export function serializeActionRunLog(log: ActionRunLog, maxBytes = RUN_LOG_MAX_FILE_BYTES): string {
    const cloned = JSON.parse(JSON.stringify(log)) as ActionRunLog;
    let encoded = `${JSON.stringify(cloned, null, 2)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) { return encoded; }

    cloned.truncated = true;
    const streams: Array<{ output: TaskRunLogOutput; key: 'stdout' | 'stderr'; original: string }> = [];
    for (const task of cloned.tasks) {
        for (const key of ['stdout', 'stderr'] as const) {
            const value = task.output[key];
            if (typeof value === 'string' && value.length > 0) {
                streams.push({ output: task.output, key, original: value });
                task.output[key] = '';
                task.output.truncated = true;
                task.output.originalBytes = (task.output.originalBytes ?? 0) + Buffer.byteLength(value, 'utf8');
            }
        }
    }

    encoded = `${JSON.stringify(cloned, null, 2)}\n`;
    const baseBytes = Buffer.byteLength(encoded, 'utf8');
    if (baseBytes > maxBytes || streams.length === 0) {
        throw new Error(`Run log metadata exceeds the ${maxBytes}-byte file limit.`);
    }

    let remainingBudget = Math.max(0, maxBytes - baseBytes - 1024);
    for (let i = 0; i < streams.length; i++) {
        const stream = streams[i];
        const share = Math.floor(remainingBudget / (streams.length - i));
        const text = truncateUtf8(stream.original, share);
        stream.output[stream.key] = text;
        remainingBudget -= Buffer.byteLength(text, 'utf8');
    }

    encoded = `${JSON.stringify(cloned, null, 2)}\n`;
    while (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
        const populated = streams
            .map(stream => ({ stream, bytes: Buffer.byteLength(stream.output[stream.key] ?? '', 'utf8') }))
            .filter(item => item.bytes > 0)
            .sort((a, b) => b.bytes - a.bytes)[0];
        if (!populated) {
            throw new Error(`Run log metadata exceeds the ${maxBytes}-byte file limit.`);
        }
        const excess = Buffer.byteLength(encoded, 'utf8') - maxBytes;
        populated.stream.output[populated.stream.key] = truncateUtf8(
            populated.stream.output[populated.stream.key] ?? '',
            Math.max(0, populated.bytes - excess - 256)
        );
        encoded = `${JSON.stringify(cloned, null, 2)}\n`;
    }
    return encoded;
}

async function writeExclusive(filePath: string, content: string, mode: number): Promise<void> {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const handle = await fs.open(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        mode
    );
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function collectLogFiles(logsRoot: string): Promise<StoredLogFile[]> {
    const files: StoredLogFile[] = [];
    for (const entry of await fs.readdir(logsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) { continue; }
        const actionDir = path.join(logsRoot, entry.name);
        for (const child of await fs.readdir(actionDir, { withFileTypes: true })) {
            if (!child.isFile() || !child.name.endsWith('.log')) { continue; }
            const filePath = path.join(actionDir, child.name);
            const stat = await fs.lstat(filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) { continue; }
            files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    return files;
}

async function rotateLogs(
    logsRoot: string,
    newestPath: string,
    policy: RunLogRetentionPolicy,
    now: number
): Promise<void> {
    let files = await collectLogFiles(logsRoot);
    const retentionDays = Math.max(0, Math.floor(policy.retentionDays));
    if (retentionDays > 0) {
        const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
        for (const file of files) {
            if (file.path !== newestPath && file.mtimeMs < cutoff) {
                await fs.unlink(file.path);
            }
        }
        files = await collectLogFiles(logsRoot);
    }

    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    const maxFiles = Math.max(1, Math.floor(policy.maxFiles));
    while (files.length > maxFiles) {
        const index = files.findIndex(file => file.path !== newestPath);
        if (index < 0) { break; }
        const [oldest] = files.splice(index, 1);
        await fs.unlink(oldest.path);
    }

    const maxTotalBytes = Math.max(1, Math.floor(policy.maxTotalBytes));
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    while (totalBytes > maxTotalBytes) {
        const index = files.findIndex(file => file.path !== newestPath);
        if (index < 0) { break; }
        const [oldest] = files.splice(index, 1);
        await fs.unlink(oldest.path);
        totalBytes -= oldest.size;
    }
}

/**
 * 워크스페이스별 직렬 쓰기 큐를 가진 로그 저장소.
 *
 * 쓰기 성공 뒤 회전은 best-effort다. 회전 실패는 결과의 warning으로 돌려 액션
 * 성공/실패를 바꾸지 않으며, 다음 실행에서 다시 정리한다.
 */
export class RunLogStore {
    private tail: Promise<void> = Promise.resolve();

    constructor(
        private readonly workspaceRoot: string,
        private readonly now: () => number = Date.now,
        private readonly makeNonce: () => string = () => randomUUID().replace(/-/g, '').slice(0, 12)
    ) {}

    write(log: ActionRunLog, policy: RunLogRetentionPolicy): Promise<RunLogWriteResult> {
        const operation = this.tail.then(() => this.writeNow(log, policy));
        this.tail = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async writeNow(log: ActionRunLog, policy: RunLogRetentionPolicy): Promise<RunLogWriteResult> {
        const logsRoot = await ensureSafeDirectory(this.workspaceRoot, ['.taskhub', 'logs']);
        const actionDirName = actionDirectoryName(log.actionId);
        const actionDir = await ensureSafeDirectory(this.workspaceRoot, ['.taskhub', 'logs', actionDirName]);

        const ignorePath = path.join(logsRoot, '.gitignore');
        try {
            await writeExclusive(ignorePath, '# TaskHub generated run logs\n*\n!.gitignore\n', 0o644);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        }

        const stamp = new Date(log.startedAt).toISOString().replace(/[:.]/g, '-');
        const nonce = this.makeNonce();
        const fileName = `${stamp}-${nonce}.log`;
        const targetPath = path.join(actionDir, fileName);
        const tempPath = path.join(actionDir, `.${fileName}.tmp-${this.makeNonce()}`);
        const content = serializeActionRunLog(log, policy.maxFileBytes ?? RUN_LOG_MAX_FILE_BYTES);
        try {
            await writeExclusive(tempPath, content, 0o600);
            await fs.rename(tempPath, targetPath);
        } catch (error) {
            await fs.unlink(tempPath).catch(() => undefined);
            throw error;
        }

        let rotationWarning: string | undefined;
        try {
            await rotateLogs(logsRoot, targetPath, policy, this.now());
        } catch (error) {
            rotationWarning = error instanceof Error ? error.message : String(error);
        }
        return {
            absolutePath: targetPath,
            workspaceRelativePath: path.relative(this.workspaceRoot, targetPath).split(path.sep).join('/'),
            rotationWarning,
        };
    }
}
