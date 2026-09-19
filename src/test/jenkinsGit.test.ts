import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JenkinsGitError, readJenkinsGitSnapshot, sanitizeJenkinsGitRemote } from '../jenkins/git';

suite('Jenkins Git remote identity', () => {
    test('removes URL credentials, query secrets and fragments before persistence', () => {
        assert.strictEqual(sanitizeJenkinsGitRemote('https://user:password@example.com/team/firmware.git?token=secret#private'),
            'https://example.com/team/firmware.git');
        assert.strictEqual(sanitizeJenkinsGitRemote('ssh://user:password@example.com:2222/team/firmware.git'),
            'ssh://example.com:2222/team/firmware.git');
    });

    test('normalizes SCP user syntax without changing local filesystem identities', () => {
        assert.strictEqual(sanitizeJenkinsGitRemote('git@example.com:team/firmware.git'), 'ssh://example.com/team/firmware.git');
        assert.strictEqual(sanitizeJenkinsGitRemote('git@[::1]:team/firmware.git'), 'ssh://[::1]/team/firmware.git');
        assert.strictEqual(sanitizeJenkinsGitRemote('C:\\repos\\firmware.git'), 'C:\\repos\\firmware.git');
        assert.strictEqual(sanitizeJenkinsGitRemote('/repo with spaces/firmware.git'), '/repo with spaces/firmware.git');
    });

    test('does not persist unsupported helper commands or malformed credential URLs', () => {
        assert.strictEqual(sanitizeJenkinsGitRemote('ext::command credential-secret'), undefined);
        assert.strictEqual(sanitizeJenkinsGitRemote('https://user:password@'), undefined);
        assert.strictEqual(sanitizeJenkinsGitRemote('https://example.com/repo\nsecret'), undefined);
    });
});

suite('Jenkins Git preflight with a local remote', function () {
    this.timeout(30_000);
    let directory: string;
    let repository: string;
    let remote: string;
    let originalGlobalConfig: string | undefined;
    let originalNoSystem: string | undefined;

    function git(...args: string[]): string {
        return execFileSync('git', args, {
            cwd: repository, encoding: 'utf8', timeout: 15_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    }

    function commit(content: string): string {
        fs.writeFileSync(path.join(repository, 'firmware.c'), content);
        git('add', '--', 'firmware.c');
        git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture change');
        return git('rev-parse', 'HEAD');
    }

    function rejectsCode(code: JenkinsGitError['code']): (error: unknown) => boolean {
        return error => error instanceof JenkinsGitError && error.code === code;
    }

    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-jenkins-git-'));
        repository = path.join(directory, 'repository with spaces 한글');
        remote = path.join(directory, 'remote with spaces.git');
        fs.mkdirSync(repository);
        const emptyConfig = path.join(directory, 'empty-gitconfig');
        fs.writeFileSync(emptyConfig, '');
        originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
        originalNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
        process.env.GIT_CONFIG_GLOBAL = emptyConfig;
        process.env.GIT_CONFIG_NOSYSTEM = '1';
        git('init', '--quiet');
        git('symbolic-ref', 'HEAD', 'refs/heads/main');
        git('config', 'user.name', 'Jenkins fixture');
        git('config', 'user.email', 'jenkins-fixture@example.invalid');
        git('config', 'core.autocrlf', 'false');
        git('config', 'core.fsmonitor', 'false');
        git('config', 'core.hooksPath', path.join(directory, 'unused-hooks'));
        git('init', '--quiet', '--bare', remote);
        commit('int main(void) { return 0; }\n');
        git('remote', 'add', 'origin', remote);
        git('push', '--quiet', '--set-upstream', 'origin', 'main');
    });

    teardown(() => {
        if (originalGlobalConfig === undefined) { delete process.env.GIT_CONFIG_GLOBAL; }
        else { process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig; }
        if (originalNoSystem === undefined) { delete process.env.GIT_CONFIG_NOSYSTEM; }
        else { process.env.GIT_CONFIG_NOSYSTEM = originalNoSystem; }
        if (directory) { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    });

    test('captures the exact pushed commit from a nested path with spaces and Unicode', async () => {
        const nested = path.join(repository, 'source', 'nested');
        fs.mkdirSync(nested, { recursive: true });
        const snapshot = await readJenkinsGitSnapshot(nested);
        assert.strictEqual(fs.realpathSync(snapshot.repoPath), fs.realpathSync(repository));
        assert.strictEqual(snapshot.branch, 'main');
        assert.strictEqual(snapshot.sha, git('rev-parse', 'HEAD'));
        assert.strictEqual(snapshot.remote, 'origin');
        assert.strictEqual(snapshot.remoteRef, 'refs/heads/main');
        assert.strictEqual(snapshot.repoRemote, remote);
    });

    test('rejects a directory outside a Git repository', async () => {
        await assert.rejects(readJenkinsGitSnapshot(directory), rejectsCode('notRepository'));
    });

    test('rejects tracked working tree changes', async () => {
        fs.appendFileSync(path.join(repository, 'firmware.c'), '// unsaved test change\n');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('dirty'));
    });

    test('rejects staged changes and untracked files', async () => {
        fs.writeFileSync(path.join(repository, 'new-test.c'), 'int test;\n');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('dirty'));
        git('add', '--', 'new-test.c');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('dirty'));
    });

    test('rejects detached HEAD even when that commit was pushed', async () => {
        git('checkout', '--quiet', '--detach', 'HEAD');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('detachedHead'));
    });

    test('rejects branches without a configured remote upstream', async () => {
        git('checkout', '--quiet', '-b', 'feature/local');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('noUpstream'));
    });

    test('rejects a local-only upstream and option-shaped remote names', async () => {
        git('config', 'branch.main.remote', '.');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('noUpstream'));
        git('config', 'branch.main.remote', '--upload-pack=unexpected-command');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('noUpstream'));
    });

    test('rejects a clean commit until it is actually present at the remote branch tip', async () => {
        const sha = commit('int main(void) { return 1; }\n');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('notPushed'));
        git('push', '--quiet', 'origin', 'main');
        assert.strictEqual((await readJenkinsGitSnapshot(repository)).sha, sha);
    });

    test('queries the live remote instead of trusting stale remote-tracking refs', async () => {
        const oldSha = git('rev-parse', 'HEAD');
        commit('int main(void) { return 2; }\n');
        git('push', '--quiet', 'origin', 'main');
        git('reset', '--hard', '--quiet', oldSha);
        git('update-ref', 'refs/remotes/origin/main', oldSha);
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('notPushed'));
    });

    test('a missing remote branch is not pushed, while an inaccessible remote is unavailable', async () => {
        git('config', 'branch.main.merge', 'refs/heads/missing');
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('notPushed'));
        git('config', 'branch.main.merge', 'refs/heads/main');
        git('remote', 'set-url', 'origin', path.join(directory, 'missing-remote.git'));
        await assert.rejects(readJenkinsGitSnapshot(repository), rejectsCode('remoteUnavailable'));
    });

    test('uses the configured upstream branch even when its name differs from the local branch', async () => {
        git('push', '--quiet', 'origin', 'main:refs/heads/validation/firmware');
        git('config', 'branch.main.merge', 'refs/heads/validation/firmware');
        const snapshot = await readJenkinsGitSnapshot(repository);
        assert.strictEqual(snapshot.branch, 'main');
        assert.strictEqual(snapshot.remoteRef, 'refs/heads/validation/firmware');
        assert.strictEqual(snapshot.sha, git('rev-parse', 'HEAD'));
    });

    test('an unborn branch produces a preflight error instead of leaking a raw Git exception', async () => {
        const empty = path.join(directory, 'empty-repository');
        git('init', '--quiet', empty);
        await assert.rejects(readJenkinsGitSnapshot(empty), rejectsCode('notPushed'));
    });
    test('cancelled preflight returns promptly without changing the worktree or Git index', async () => {
        const before = git('status', '--porcelain');
        const controller = new AbortController(); controller.abort();
        await assert.rejects(readJenkinsGitSnapshot(repository, controller.signal), error => error instanceof JenkinsGitError);
        assert.strictEqual(git('status', '--porcelain'), before);
    });

});
