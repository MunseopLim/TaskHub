import { createJenkinsScope } from './lifecycle';
import { ChildProcess, spawn } from 'child_process';

export class JenkinsGitError extends Error {
    constructor(readonly code: 'notRepository' | 'detachedHead' | 'dirty' | 'noUpstream' | 'notPushed' | 'remoteUnavailable') {
        super(code);
        this.name = 'JenkinsGitError';
    }
}

/** Terminate only this owned process tree, including Git's SSH/credential helper children. */
function stopGit(child: ChildProcess): Promise<void> {
    if (!child.pid) { return Promise.resolve(); }
    if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const finish = (): void => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* Already exited. */ } resolve(); };
        const timer = setTimeout(() => { killer.kill(); finish(); }, 2000);
        killer.once('error', finish); killer.once('exit', finish);
    });
}

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('GIT_CANCELLED')); return; }
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        const stop = (error: Error): void => {
            if (settled) { return; }
            settled = true; cleanup();
            void stopGit(child).then(() => reject(error), () => reject(error));
        };
        const cancel = (): void => stop(new Error('GIT_CANCELLED'));
        const child = spawn('git', args, {
            cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true,
        });
        const output: Buffer[] = [];
        let bytes = 0;
        const collect = (chunk: Buffer, retain: boolean): void => {
            if (settled) { return; }
            bytes += chunk.length;
            if (bytes > 1024 * 1024) { stop(new Error('GIT_OUTPUT_LIMIT')); return; }
            if (retain) { output.push(chunk); }
        };
        child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
        child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
        child.once('error', stop);
        child.once('close', code => {
            if (settled) { return; }
            if (code !== 0) { stop(Object.assign(new Error('GIT_EXIT'), { code })); }
            else { settled = true; cleanup(); resolve(Buffer.concat(output).toString('utf8').trim()); }
        });
        child.stdin?.end();
        timer = setTimeout(() => stop(new Error('GIT_TIMEOUT')), 20000);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) { cancel(); }
    });
}

export interface JenkinsGitSnapshot {
    repoPath: string;
    branch: string;
    sha: string;
    remote: string;
    remoteRef: string;
    repoRemote?: string;
}

/** Repository identity must never persist credentials or signed URL query parameters. */
export function sanitizeJenkinsGitRemote(remote: string): string | undefined {
    const value = remote.trim();
    if (!value || /[\r\n\0]/.test(value)) { return undefined; }
    if (value.includes('://')) {
        try {
            const url = new URL(value);
            if (!['http:', 'https:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) { return undefined; }
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.href;
        } catch { return undefined; }
    }
    if (!/^[A-Za-z]:[\\/]/.test(value)) {
        const scp = /^(?:[^/@:]+@)?(\[[^\]]+\]|[^/:]+):([^:].*)$/.exec(value);
        if (scp) { return sanitizeJenkinsGitRemote(`ssh://${scp[1]}/${scp[2]}`); }
        if (value.includes('::') || value.includes('@')) { return undefined; }
    }
    return value;
}

export async function readJenkinsGitSnapshot(cwd: string, signal?: AbortSignal): Promise<JenkinsGitSnapshot> {
    const scope = createJenkinsScope([signal], 30000);
    try {
        const runGit = (directory: string, args: string[]): Promise<string> => git(directory, args, scope.signal);
        let repoPath: string;
        try { repoPath = await runGit(cwd, ['rev-parse', '--show-toplevel']); } catch { throw new JenkinsGitError('notRepository'); }
        let branch: string;
        try { branch = await runGit(repoPath, ['symbolic-ref', '--short', 'HEAD']); } catch { throw new JenkinsGitError('detachedHead'); }
        let sha: string;
        try { sha = await runGit(repoPath, ['rev-parse', 'HEAD']); } catch { throw new JenkinsGitError('notPushed'); }
        if (await runGit(repoPath, ['status', '--porcelain'])) { throw new JenkinsGitError('dirty'); }
        let remote: string;
        let remoteRef: string;
        try {
            remote = await runGit(repoPath, ['config', '--get', `branch.${branch}.remote`]);
            remoteRef = await runGit(repoPath, ['config', '--get', `branch.${branch}.merge`]);
        } catch { throw new JenkinsGitError('noUpstream'); }
        if (!remote || remote === '.' || remote.startsWith('-') || !remoteRef.startsWith('refs/heads/')) {
            throw new JenkinsGitError('noUpstream');
        }
        let repoRemote: string | undefined;
        try { repoRemote = sanitizeJenkinsGitRemote(await runGit(repoPath, ['remote', 'get-url', '--', remote])); }
        catch { /* An unavailable remote is reported by the remote-head check below. */ }
        let remoteHeads: string;
        try { remoteHeads = await runGit(repoPath, ['ls-remote', '--exit-code', '--heads', '--', remote, remoteRef]); }
        catch (error) {
            const exitCode = (error as { code?: unknown }).code;
            throw new JenkinsGitError(exitCode === 2 ? 'notPushed' : 'remoteUnavailable');
        }
        const actual = remoteHeads.split(/\r?\n/).map(line => line.split(/\s+/)).find(([, ref]) => ref === remoteRef)?.[0];
        if (actual !== sha) { throw new JenkinsGitError('notPushed'); }
        return { repoPath, branch, sha, remote, remoteRef, repoRemote };
    } finally { scope.dispose(); }
}
