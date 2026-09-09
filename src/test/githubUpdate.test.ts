import * as assert from 'assert';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import https = require('https');
import { IncomingMessage, ClientRequest } from 'http';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';
import {
    downloadAndVerifyRelease, fetchLatestRelease, GithubRelease, GithubUpdateError,
    GITHUB_UPDATE_MAX_ASSET_BYTES, GITHUB_UPDATE_MAX_METADATA_BYTES, isNewerVersion,
} from '../githubUpdate';

interface Exchange {
    status?: number;
    headers?: Record<string, string>;
    body?: Buffer;
    networkError?: boolean;
    bodyError?: boolean;
    stall?: boolean;
}

const ROOT = 'https://github.com/MunseopLim/TaskHub';
const VERSION = '0.8.25';
const DOWNLOAD_URL = `${ROOT}/releases/download/v${VERSION}/taskhub-${VERSION}.vsix`;
const MANIFEST = { publisher: 'Munseop', name: 'taskhub', version: VERSION, engines: { vscode: '^1.75.0' } };

function makeVsix(manifest: unknown = MANIFEST, extras: Array<{ name: string; body: string }> = []): Buffer {
    const zip = new AdmZip();
    zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)));
    for (const extra of extras) { zip.addFile(extra.name, Buffer.from(extra.body)); }
    for (const entry of zip.getEntries()) { entry.header.time = new Date(2020, 0, 1); }
    return zip.toBuffer();
}

function releaseFor(bytes: Buffer): GithubRelease {
    return {
        version: VERSION,
        assetUrl: DOWNLOAD_URL,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        releaseUrl: `${ROOT}/releases/tag/v${VERSION}`,
    };
}

function metadata() {
    const release = releaseFor(makeVsix());
    return {
        tag_name: `v${VERSION}`, draft: false, prerelease: false, html_url: release.releaseUrl,
        assets: [{ name: `taskhub-${VERSION}.vsix`, browser_download_url: release.assetUrl,
            size: release.size, digest: `sha256:${release.sha256}`, state: 'uploaded' }],
    };
}

function rejectsCode(code: string): (error: unknown) => boolean {
    return error => error instanceof GithubUpdateError && error.code === code;
}

suite('GitHub update transport and VSIX verification', () => {
    let originalGet: typeof https.get;
    let exchanges: Exchange[];
    let requested: string[];
    let responses: Readable[];
    let directory: string;
    let destination: string;

    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-update-'));
        destination = path.join(directory, 'update.vsix');
        exchanges = [];
        requested = [];
        responses = [];
        originalGet = https.get;
        // Only the transport is replaced. Every test still crosses production URL validation.
        https.get = ((url: URL, _options: unknown, callback: (response: IncomingMessage) => void) => {
            requested.push(url.href);
            const exchange = exchanges.shift();
            assert.ok(exchange, `Unexpected request: ${url.origin}`);
            const request = new EventEmitter() as ClientRequest;
            let destroyed = false;
            request.destroy = ((error?: Error) => {
                if (!destroyed) {
                    destroyed = true;
                    queueMicrotask(() => {
                        if (error) { request.emit('error', error); }
                        request.emit('close');
                    });
                }
                return request;
            }) as ClientRequest['destroy'];
            queueMicrotask(() => {
                if (destroyed) { return; }
                if (exchange.networkError) { request.destroy(new Error('private network detail')); return; }
                let read = false;
                const response = new Readable({
                    read() {
                        if (read || exchange.stall) { return; }
                        read = true;
                        if (exchange.body) { this.push(exchange.body); }
                        if (exchange.bodyError) { this.destroy(new Error('private body detail')); } else { this.push(null); }
                    },
                }) as IncomingMessage;
                response.statusCode = exchange.status ?? 200;
                response.headers = exchange.headers ?? {};
                response.once('close', () => request.emit('close'));
                responses.push(response);
                callback(response);
            });
            return request;
        }) as typeof https.get;
    });

    teardown(() => {
        https.get = originalGet;
        for (const response of responses) { response.destroy(); }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function answer(value: unknown): void {
        exchanges.push({ body: Buffer.from(JSON.stringify(value)) });
    }

    async function download(bytes: Buffer, release = releaseFor(bytes), vscodeVersion = '1.95.0'): Promise<void> {
        exchanges.push({ body: bytes });
        return downloadAndVerifyRelease(release, destination, vscodeVersion, new AbortController().signal);
    }

    test('strict semantic versions compare numerically, including prereleases and build metadata', () => {
        assert.strictEqual(isNewerVersion('0.8.10', '0.8.9'), true);
        assert.strictEqual(isNewerVersion('0.8.25', '0.8.25-beta.1'), true);
        assert.strictEqual(isNewerVersion('0.8.25+build.1', '0.8.24'), true);
        assert.strictEqual(isNewerVersion('0.8.25+build.1', '0.8.25+build.2'), false);
        for (const invalid of ['v1.2.3', ' 1.2.3', '01.2.3', '1.2', '1.2.3-beta.01', '99999999999999999.0.0']) {
            assert.strictEqual(isNewerVersion(invalid, '0.8.24'), false, invalid);
            assert.strictEqual(isNewerVersion('1.2.3', invalid), false, invalid);
        }
    });

    test('selects only the exact stable VSIX and checksum from the fixed GitHub repository', async () => {
        const value = metadata();
        answer(value);
        const result = await fetchLatestRelease(new AbortController().signal);
        assert.deepStrictEqual(result, releaseFor(makeVsix()));
        assert.deepStrictEqual(requested, ['https://api.github.com/repos/MunseopLim/TaskHub/releases/latest']);
    });

    test('no published release, draft, and prerelease metadata do not offer an update', async () => {
        exchanges.push({ status: 404 });
        assert.strictEqual(await fetchLatestRelease(new AbortController().signal), undefined);
        for (const flags of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.8.25-beta.1' }]) {
            answer({ ...metadata(), ...flags });
            assert.strictEqual(await fetchLatestRelease(new AbortController().signal), undefined);
        }
    });

    test('rejects malformed metadata, absent digest, wrong filename, and ambiguous assets', async () => {
        const value = metadata();
        for (const invalid of [null, [], {}, { ...value, draft: 'false' }, { ...value, tag_name: 'v01.2.3' },
            { ...value, assets: [] }, { ...value, assets: [value.assets[0], value.assets[0]] },
            { ...value, assets: [{ ...value.assets[0], name: 'other.vsix' }] },
            { ...value, assets: [{ ...value.assets[0], digest: undefined }] },
            { ...value, assets: [{ ...value.assets[0], digest: 'sha1:' + 'a'.repeat(40) }] },
            { ...value, assets: [{ ...value.assets[0], size: 0 }] },
            { ...value, assets: [{ ...value.assets[0], size: 1.5 }] },
            { ...value, assets: [{ ...value.assets[0], size: GITHUB_UPDATE_MAX_ASSET_BYTES + 1 }] }]) {
            answer(invalid);
            await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('invalidMetadata'));
        }
    });

    test('rejects untrusted release links and asset URLs before making an asset request', async () => {
        const value = metadata();
        answer({ ...value, html_url: 'https://example.com/release' });
        await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('invalidMetadata'));
        for (const url of ['http://github.com/MunseopLim/TaskHub/releases/download/v0.8.25/taskhub-0.8.25.vsix',
            'https://github.com/other/TaskHub/releases/download/v0.8.25/taskhub-0.8.25.vsix',
            DOWNLOAD_URL + '?token=secret', DOWNLOAD_URL + '#fragment',
            'https://github.com.evil.test/asset', 'https://user:password@github.com/asset']) {
            answer({ ...value, assets: [{ ...value.assets[0], browser_download_url: url }] });
            await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('invalidUrl'));
        }
        assert.strictEqual(requested.length, 7);
    });

    test('bounds metadata even without Content-Length and rejects malformed JSON', async () => {
        exchanges.push({ body: Buffer.alloc(GITHUB_UPDATE_MAX_METADATA_BYTES + 1) });
        await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('tooLarge'));
        exchanges.push({ headers: { 'content-length': String(GITHUB_UPDATE_MAX_METADATA_BYTES + 1) } });
        await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('tooLarge'));
        exchanges.push({ body: Buffer.from('not JSON') });
        await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('invalidMetadata'));
    });

    test('downloads through the official asset redirect and verifies the VSIX without extraction', async () => {
        const bytes = makeVsix();
        exchanges.push({ status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=secret' } });
        await download(bytes);
        assert.deepStrictEqual(fs.readFileSync(destination), bytes);
        assert.deepStrictEqual(fs.readdirSync(directory), ['update.vsix']);
        assert.strictEqual(requested.length, 2);
    });

    test('forbids cross-repository, insecure, credential-bearing, and lookalike redirects', async () => {
        for (const location of ['https://example.com/asset', 'https://api.github.com/repos/other/repo/releases/latest',
            'https://github.com/other/repo/releases/download/v1/asset.vsix',
            'http://release-assets.githubusercontent.com/file',
            'https://release-assets.githubusercontent.com.evil.test/file',
            'https://user:secret@release-assets.githubusercontent.com/file',
            'https://release-assets.githubusercontent.com:8443/file',
            'https://release-assets.githubusercontent.com/file#fragment']) {
            exchanges.push({ status: 302, headers: { location } });
            const before = requested.length;
            await assert.rejects(downloadAndVerifyRelease(releaseFor(makeVsix()), destination, '1.95.0', new AbortController().signal), rejectsCode('invalidUrl'));
            assert.strictEqual(requested.length, before + 1);
            assert.strictEqual(fs.existsSync(destination), false);
        }
        exchanges.push({ status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } });
        await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('invalidUrl'));
    });

    test('stops redirect loops after three redirects', async () => {
        for (let i = 0; i < 4; i++) {
            exchanges.push({ status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } });
        }
        await assert.rejects(downloadAndVerifyRelease(releaseFor(makeVsix()), destination, '1.95.0', new AbortController().signal), rejectsCode('invalidUrl'));
        assert.strictEqual(requested.length, 4);
    });

    test('revalidates supplied release objects before network activity', async () => {
        const good = releaseFor(makeVsix());
        for (const invalid of [{ ...good, sha256: 'bad' }, { ...good, size: GITHUB_UPDATE_MAX_ASSET_BYTES + 1 },
            { ...good, version: 'v0.8.25' }]) {
            await assert.rejects(downloadAndVerifyRelease(invalid, destination, '1.95.0', new AbortController().signal), rejectsCode('invalidMetadata'));
        }
        await assert.rejects(downloadAndVerifyRelease({ ...good, assetUrl: 'https://example.com/file' }, destination, '1.95.0', new AbortController().signal), rejectsCode('invalidUrl'));
        assert.strictEqual(requested.length, 0);
    });

    test('rejects checksum mismatch, truncated payload, and payload exceeding declared size, deleting partial files', async () => {
        const bytes = makeVsix();
        for (const [release, code] of [
            [{ ...releaseFor(bytes), sha256: '0'.repeat(64) }, 'digestMismatch'],
            [{ ...releaseFor(bytes), size: bytes.length + 1 }, 'digestMismatch'],
            [{ ...releaseFor(bytes), size: bytes.length - 1 }, 'tooLarge'],
        ] as const) {
            await assert.rejects(download(bytes, release), rejectsCode(code));
            assert.strictEqual(fs.existsSync(destination), false);
        }
    });

    test('checks HTTP Content-Length against the release before creating a file', async () => {
        const bytes = makeVsix();
        exchanges.push({ body: bytes, headers: { 'content-length': String(bytes.length + 1) } });
        await assert.rejects(downloadAndVerifyRelease(releaseFor(bytes), destination, '1.95.0', new AbortController().signal), rejectsCode('invalidMetadata'));
        assert.strictEqual(fs.existsSync(destination), false);
    });

    test('rejects corrupt ZIPs, unrelated extensions, mismatched versions, and malformed engines', async () => {
        const invalid = [Buffer.from('not a ZIP'), makeVsix(null), makeVsix({ ...MANIFEST, publisher: 'SomeoneElse' }),
            makeVsix({ ...MANIFEST, name: 'other' }), makeVsix({ ...MANIFEST, version: '0.8.24' }),
            makeVsix({ ...MANIFEST, engines: { vscode: 'not a range' } }), makeVsix({ ...MANIFEST, engines: {} })];
        for (const bytes of invalid) {
            await assert.rejects(download(bytes), rejectsCode('invalidVsix'));
            assert.strictEqual(fs.existsSync(destination), false);
        }
    });

    test('rejects an absent, case-ambiguous, duplicated, or oversized package manifest', async () => {
        const empty = new AdmZip();
        empty.addFile('other.txt', Buffer.from('x'));
        const duplicate = makeVsix(MANIFEST, [{ name: 'extension/package.jsoN', body: JSON.stringify(MANIFEST) }]);
        const duplicateBytes = Buffer.from(duplicate);
        const oldName = Buffer.from('extension/package.jsoN');
        for (let index = duplicateBytes.indexOf(oldName); index !== -1; index = duplicateBytes.indexOf(oldName, index + oldName.length)) {
            Buffer.from('extension/package.json').copy(duplicateBytes, index);
        }
        for (const bytes of [empty.toBuffer(), duplicateBytes,
            makeVsix(MANIFEST, [{ name: 'Extension/package.json', body: JSON.stringify(MANIFEST) }]),
            makeVsix({ ...MANIFEST, padding: 'x'.repeat(1024 * 1024) })]) {
            await assert.rejects(download(bytes), rejectsCode('invalidVsix'));
            assert.strictEqual(fs.existsSync(destination), false);
        }
    });

    test('bounds ZIP entry enumeration before reading a suspicious archive', async () => {
        const bytes = makeVsix();
        bytes.writeUInt16LE(10001, bytes.length - 22 + 8);
        bytes.writeUInt16LE(10001, bytes.length - 22 + 10);
        await assert.rejects(download(bytes), rejectsCode('invalidVsix'));
        assert.strictEqual(fs.existsSync(destination), false);
    });

    test('rejects an encrypted or symlink manifest without opening it', async () => {
        for (const mode of ['encrypted', 'symlink']) {
            const bytes = makeVsix();
            const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
            assert.ok(central >= 0);
            if (mode === 'encrypted') {
                bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
            } else {
                bytes.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
            }
            await assert.rejects(download(bytes), rejectsCode('invalidVsix'));
            assert.strictEqual(fs.existsSync(destination), false);
        }
    });

    test('checks the running VS Code engine, including valid insiders versions', async () => {
        const bytes = makeVsix();
        await assert.rejects(download(bytes, releaseFor(bytes), '1.74.0'), rejectsCode('incompatibleVscode'));
        assert.strictEqual(fs.existsSync(destination), false);
        await download(bytes, releaseFor(bytes), '1.95.0-insider');
        assert.strictEqual(fs.existsSync(destination), true);
    });

    test('accepts Insiders at the minimum VS Code engine version while rejecting older cores', async () => {
        const bytes = makeVsix();
        await assert.rejects(download(bytes, releaseFor(bytes), '1.74.0-insider'), rejectsCode('incompatibleVscode'));
        assert.strictEqual(fs.existsSync(destination), false);
        await download(bytes, releaseFor(bytes), '1.75.0-insider');
        assert.strictEqual(fs.existsSync(destination), true);
    });

    test('network and server failures are typed and do not disclose raw errors', async () => {
        for (const exchange of [{ networkError: true }, { status: 403 }, { status: 429 }, { status: 500 }, { bodyError: true }]) {
            exchanges.push(exchange);
            await assert.rejects(fetchLatestRelease(new AbortController().signal), error => {
                assert.ok(error instanceof GithubUpdateError);
                assert.strictEqual(error.code, 'network');
                assert.strictEqual(error.message.includes('private'), false);
                return true;
            });
        }
    });

    test('does not overwrite or delete a pre-existing destination', async () => {
        fs.writeFileSync(destination, 'existing file');
        await assert.rejects(download(makeVsix()), rejectsCode('fileSystem'));
        assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'existing file');
    });

    test('cleans up a download interrupted by a response stream error', async () => {
        const bytes = makeVsix();
        exchanges.push({ body: bytes.subarray(0, 30), bodyError: true });
        await assert.rejects(downloadAndVerifyRelease(releaseFor(bytes), destination, '1.95.0', new AbortController().signal), rejectsCode('network'));
        assert.strictEqual(fs.existsSync(destination), false);
    });

    test('pre-cancellation avoids the network, and in-flight cancellation destroys the response and removes files', async () => {
        const already = new AbortController();
        already.abort();
        await assert.rejects(fetchLatestRelease(already.signal), rejectsCode('cancelled'));
        assert.strictEqual(requested.length, 0);
        exchanges.push({ stall: true });
        const controller = new AbortController();
        const running = downloadAndVerifyRelease(releaseFor(makeVsix()), destination, '1.95.0', controller.signal);
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        controller.abort();
        await assert.rejects(running, rejectsCode('cancelled'));
        assert.strictEqual(fs.existsSync(destination), false);
        assert.ok(responses.every(response => response.destroyed));
    });

    test('the absolute deadline terminates a stalled response', async () => {
        exchanges.push({ stall: true });
        const originalSetTimeout = global.setTimeout;
        global.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
            originalSetTimeout(callback, delay === 15000 ? 10 : delay, ...args)) as typeof setTimeout;
        try {
            await assert.rejects(fetchLatestRelease(new AbortController().signal), rejectsCode('timeout'));
            assert.ok(responses.every(response => response.destroyed));
        } finally {
            global.setTimeout = originalSetTimeout;
        }
    });
});
