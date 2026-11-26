import { spawn } from 'node:child_process';
import { terminateProcessTree } from '../processTree';
import { windowsPowerShellPath } from '../processEnvironment';
import { buildNativeCommandInvocation, buildPowerShellInvocation, buildPowerShellUtf8Preamble, buildRawPowerShellCommandLine,
    buildRawShellCommandLine, encodePowerShellScript, mergeCommandAndArgs, rawCommandUsesChainOperators, resolvePwshPath,
    resolveWindowsTaskSpawn, selectWindowsRawShell, withPowerShellExitCode, type WindowsExecutableLookup } from '../pipelineUtils';
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

export class ProcessFailure extends Error {
    constructor(readonly code: number | null, readonly signal: NodeJS.Signals | null) {
        super(signal ? t(`프로세스 종료 신호 ${signal}`, `Process terminated by ${signal}`)
            : t(`프로세스 종료 코드 ${code}`, `Process exited with code ${code}`));
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
        signal.throwIfAborted();
        if (size > limit) { throw new Error(t('프로세스 출력이 8 MiB를 초과했습니다.', 'Process output exceeds 8 MiB.')); }
        if (code !== 0) { throw new ProcessFailure(code, stoppedBy); }
        return { output: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() };
    } finally {
        signal.removeEventListener('abort', stop);
        await termination;
    }
}
