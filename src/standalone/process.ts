import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { terminateProcessTree } from '../processTree';
import { windowsPowerShellPath } from '../processEnvironment';
import { buildNativeCommandInvocation, buildPowerShellInvocation, buildPowerShellUtf8Preamble, buildRawPowerShellCommandLine,
    buildRawShellCommandLine, encodePowerShellScript, mergeCommandAndArgs, rawCommandUsesChainOperators, resolvePwshPath,
    resolveWindowsTaskSpawn, selectWindowsRawShell, withPowerShellExitCode, type WindowsExecutableLookup } from '../pipelineUtils';
import { TaskHubError } from './errors';
import { t } from './language';

export function launchPlan(raw: boolean, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
    platform = process.platform, isFile?: WindowsExecutableLookup['isFile']) {
    if (platform !== 'win32') {
        return raw ? { executable: '/bin/sh', args: ['-c', buildRawShellCommandLine(command, args)] } : mergeCommandAndArgs(command, args);
    }
    const lookup = { cwd, env, ...(isFile && { isFile }) };
    const plan = resolveWindowsTaskSpawn(raw, command, args, lookup);
    if (plan.strategy === 'native') { return buildNativeCommandInvocation(command, args, plan.executable); }
    const chain = raw && rawCommandUsesChainOperators(command);
    const executable = raw ? selectWindowsRawShell(chain, chain ? resolvePwshPath(lookup) : undefined) : windowsPowerShellPath();
    if (!executable) { throw new Error(t('이 명령에는 PowerShell 7이 필요합니다.', 'This command requires PowerShell 7.')); }
    const script = raw ? buildPowerShellUtf8Preamble(true) + buildRawPowerShellCommandLine(command, args)
        : buildPowerShellInvocation(command, args, true).script;
    return { executable, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(withPowerShellExitCode(script))] };
}

export interface ProcessStreams {
    output: string;
    stderr: string;
}

export class ProcessFailure extends Error {
    /** `captured` is false when the streams were not collected, so empty streams mean nothing. */
    constructor(readonly code: number | null, readonly signal: NodeJS.Signals | null, readonly streams: ProcessStreams,
        readonly captured: boolean) {
        super(signal ? t(`프로세스 종료 신호 ${signal}`, `Process terminated by ${signal}`)
            : t(`프로세스 종료 코드 ${code}`, `Process exited with code ${code}`));
    }
}

/**
 * A timeout or cancellation stopped the process. Like the extension, its partial output is not logged:
 * collection stops at termination, so a credential could be cut mid-value and escape the secret scan.
 */
export class ProcessInterrupted extends Error {
    constructor(readonly reason: unknown) {
        super(t('프로세스 실행이 중단되었습니다.', 'Process execution was interrupted.'));
    }
}

export async function runProcess(raw: boolean, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
    signal: AbortSignal, capture: boolean) {
    signal.throwIfAborted();
    const plan = launchPlan(raw, command, args, cwd, env);
    const child = spawn(plan.executable, plan.args, { cwd, env, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let termination: Promise<boolean> | undefined;
    const stop = () => { termination ??= terminateProcessTree(child); };
    signal.addEventListener('abort', stop, { once: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const limit = 8 * 1024 * 1024;
    const collect = (chunks: Buffer[], chunk: Buffer) => {
        if (!capture || termination) { return; }
        size += chunk.length;
        if (size > limit) { stop(); }
        else { chunks.push(chunk); }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    try {
        const [code, stoppedBy] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, stoppedBy) => resolve([code, stoppedBy]));
        });
        const output = Buffer.concat(stdout).toString('utf8');
        const errors = Buffer.concat(stderr).toString('utf8');
        if (signal.aborted) { throw new ProcessInterrupted(signal.reason); }
        if (size > limit) { throw new Error(t('프로세스 출력이 8 MiB를 초과했습니다.', 'Process output exceeds 8 MiB.')); }
        // Like the extension, a failure keeps the streams as printed while a success trims them for reuse.
        if (code !== 0) { throw new ProcessFailure(code, stoppedBy, { output, stderr: errors }, capture); }
        return { output: output.trim(), stderr: errors.trim() };
    } catch (error) {
        if (error instanceof ProcessInterrupted) { throw error; }
        signal.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            // spawn uses ENOENT for both an absent executable and a missing working directory.
            const directory = await stat(cwd).catch((statError: NodeJS.ErrnoException) => {
                if (statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR') { throw statError; }
            });
            throw new TaskHubError(1, directory?.isDirectory()
                ? t('실행 파일을 찾을 수 없습니다.', 'Executable not found.')
                : t('태스크 작업 디렉터리를 열 수 없습니다.', 'Cannot open the task working directory.'));
        }
        throw error;
    } finally {
        signal.removeEventListener('abort', stop);
        await termination;
    }
}
