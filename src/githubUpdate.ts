import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import { IncomingMessage } from 'http';
import { Readable } from 'stream';
import * as semver from 'semver';
import * as yauzl from 'yauzl';

const REPOSITORY_URL = 'https://github.com/MunseopLim/TaskHub';
const LATEST_RELEASE_URL = 'https://api.github.com/repos/MunseopLim/TaskHub/releases/latest';
export const GITHUB_UPDATE_MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const GITHUB_UPDATE_MAX_METADATA_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const MAX_REDIRECTS = 3;

export interface GithubRelease {
    version: string;
    assetUrl: string;
    size: number;
    sha256: string;
    releaseUrl: string;
}

export type GithubUpdateErrorCode = 'network' | 'timeout' | 'cancelled' | 'invalidMetadata'
    | 'invalidUrl' | 'tooLarge' | 'digestMismatch' | 'invalidVsix' | 'incompatibleVscode' | 'fileSystem';

/** Codes are localized by the VS Code host; never expose response bodies or signed URLs. */
export class GithubUpdateError extends Error {
    constructor(public readonly code: GithubUpdateErrorCode) {
        super(`GitHub update failed: ${code}`);
        this.name = 'GithubUpdateError';
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new GithubUpdateError('cancelled');
    }
}

function strictVersion(value: unknown): value is string {
    return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
        && semver.valid(value) !== null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
    return strictVersion(candidate) && strictVersion(current) && semver.gt(candidate, current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSize(size: unknown): size is number {
    return typeof size === 'number' && Number.isSafeInteger(size) && size > 0
        && size <= GITHUB_UPDATE_MAX_ASSET_BYTES;
}

function parseRelease(value: unknown): GithubRelease | undefined {
    if (!isRecord(value) || typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') {
        throw new GithubUpdateError('invalidMetadata');
    }
    if (value.draft || value.prerelease) {
        return undefined;
    }
    const tag = value.tag_name;
    const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : tag;
    if (!strictVersion(version) || typeof tag !== 'string' || !Array.isArray(value.assets)) {
        throw new GithubUpdateError('invalidMetadata');
    }
    if (semver.prerelease(version) !== null) {
        return undefined;
    }
    const releaseUrl = `${REPOSITORY_URL}/releases/tag/${tag}`;
    const assetName = `taskhub-${version}.vsix`;
    const matches = value.assets.filter(asset => isRecord(asset) && asset.name === assetName);
    if (value.html_url !== releaseUrl || matches.length !== 1) {
        throw new GithubUpdateError('invalidMetadata');
    }
    const asset = matches[0] as Record<string, unknown>;
    if (!validSize(asset.size) || typeof asset.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) {
        throw new GithubUpdateError('invalidMetadata');
    }
    const assetUrl = `${REPOSITORY_URL}/releases/download/${tag}/${assetName}`;
    if (asset.browser_download_url !== assetUrl) {
        throw new GithubUpdateError('invalidUrl');
    }
    return { version, assetUrl, size: asset.size, sha256: asset.digest.slice(7).toLowerCase(), releaseUrl };
}

/** A separate boundary check protects callers passing a restored or mutated release object. */
function validateRelease(release: GithubRelease): void {
    if (!strictVersion(release.version) || semver.prerelease(release.version) !== null
        || !validSize(release.size) || !/^[a-fA-F0-9]{64}$/.test(release.sha256)) {
        throw new GithubUpdateError('invalidMetadata');
    }
    const tags = [release.version, `v${release.version}`];
    if (!tags.some(tag => release.releaseUrl === `${REPOSITORY_URL}/releases/tag/${tag}`
        && release.assetUrl === `${REPOSITORY_URL}/releases/download/${tag}/taskhub-${release.version}.vsix`)) {
        throw new GithubUpdateError('invalidUrl');
    }
}

function assertAllowedUrl(url: URL, initialUrl: string, asset: boolean): void {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || (url.href !== initialUrl && (!asset || url.hostname !== 'release-assets.githubusercontent.com'))) {
        throw new GithubUpdateError('invalidUrl');
    }
}

async function withDeadline<T>(signal: AbortSignal, milliseconds: number, work: (bounded: AbortSignal) => Promise<T>): Promise<T> {
    throwIfAborted(signal);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
    try {
        const result = await work(controller.signal);
        throwIfAborted(controller.signal);
        return result;
    } catch (error) {
        if (controller.signal.aborted) {
            throw new GithubUpdateError(timedOut ? 'timeout' : 'cancelled');
        }
        throw error instanceof GithubUpdateError ? error : new GithubUpdateError('network');
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}

function getResponse(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let response: IncomingMessage | undefined;
        const request = https.get(url, {
            headers: {
                'User-Agent': 'TaskHub-GitHub-Updater',
                'Accept': url.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream',
                'Accept-Encoding': 'identity',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        }, incoming => {
            response = incoming;
            incoming.once('close', cleanup);
            // Keep an error listener even before an async iterator is attached.
            incoming.on('error', () => { /* The body consumer reports this failure. */ });
            if (signal.aborted) {
                abort();
                reject(new GithubUpdateError('cancelled'));
                return;
            }
            resolve(incoming);
        });
        const cleanup = () => signal.removeEventListener('abort', abort);
        const abort = () => {
            const error = new GithubUpdateError('cancelled');
            response?.destroy(error);
            request.destroy(error);
            reject(error);
        };
        request.on('error', () => {
            cleanup();
            const error = new GithubUpdateError(signal.aborted ? 'cancelled' : 'network');
            response?.destroy(error);
            reject(error);
        });
        request.once('close', () => {
            if (!response) { cleanup(); }
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); }
    });
}

async function requestFollowingRedirects(initialUrl: string, asset: boolean, signal: AbortSignal): Promise<IncomingMessage> {
    let url = new URL(initialUrl);
    for (let count = 0; ; count++) {
        assertAllowedUrl(url, initialUrl, asset);
        const response = await getResponse(url, signal);
        if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            return response;
        }
        response.destroy();
        if (count >= MAX_REDIRECTS || !response.headers.location) {
            throw new GithubUpdateError('invalidUrl');
        }
        try {
            url = new URL(response.headers.location, url);
        } catch {
            throw new GithubUpdateError('invalidUrl');
        }
    }
}

async function readBounded(stream: Readable, maximum: number, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const piece of stream) {
        throwIfAborted(signal);
        const chunk: Buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        size += chunk.length;
        if (size > maximum) { throw new GithubUpdateError('tooLarge'); }
        chunks.push(chunk);
    }
    throwIfAborted(signal);
    return Buffer.concat(chunks, size);
}

export async function fetchLatestRelease(signal: AbortSignal): Promise<GithubRelease | undefined> {
    return withDeadline(signal, 15000, async bounded => {
        const response = await requestFollowingRedirects(LATEST_RELEASE_URL, false, bounded);
        try {
            if (response.statusCode === 404) { return undefined; }
            if (response.statusCode !== 200) { throw new GithubUpdateError('network'); }
            if (Number(response.headers['content-length']) > GITHUB_UPDATE_MAX_METADATA_BYTES) {
                throw new GithubUpdateError('tooLarge');
            }
            const body = await readBounded(response, GITHUB_UPDATE_MAX_METADATA_BYTES, bounded);
            let value: unknown;
            try { value = JSON.parse(body.toString('utf8')); } catch { throw new GithubUpdateError('invalidMetadata'); }
            return parseRelease(value);
        } finally {
            response.destroy();
        }
    });
}

function validateManifest(data: Buffer, release: GithubRelease, vscodeVersion: string): void {
    let manifest: unknown;
    try { manifest = JSON.parse(data.toString('utf8')); } catch { throw new GithubUpdateError('invalidVsix'); }
    if (!isRecord(manifest) || manifest.publisher !== 'Munseop' || manifest.name !== 'taskhub'
        || manifest.version !== release.version || !isRecord(manifest.engines)
        || typeof manifest.engines.vscode !== 'string' || !semver.validRange(manifest.engines.vscode)) {
        throw new GithubUpdateError('invalidVsix');
    }
    // VS Code compares the product's numeric version, so Insiders at the minimum version is compatible.
    const productVersion = strictVersion(vscodeVersion) ? new semver.SemVer(vscodeVersion) : undefined;
    if (!productVersion || !semver.satisfies(
        `${productVersion.major}.${productVersion.minor}.${productVersion.patch}`, manifest.engines.vscode,
    )) {
        throw new GithubUpdateError('incompatibleVscode');
    }
}

async function verifyVsix(filePath: string, release: GithubRelease, vscodeVersion: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, file) => {
            if (error) { reject(new GithubUpdateError('invalidVsix')); } else { resolve(file); }
        });
    });
    await new Promise<void>((resolve, reject) => {
        let manifestFound = false;
        let finished = false;
        let failure: GithubUpdateError | undefined;
        let stream: Readable | undefined;
        const finish = (error?: unknown) => {
            if (finished) { return; }
            finished = true;
            failure = error instanceof GithubUpdateError ? error : error ? new GithubUpdateError('invalidVsix') : undefined;
            signal.removeEventListener('abort', abort);
            stream?.destroy();
            zip.close();
        };
        const abort = () => finish(new GithubUpdateError('cancelled'));
        zip.once('close', () => {
            signal.removeEventListener('abort', abort);
            if (!finished || failure) { reject(failure ?? new GithubUpdateError('invalidVsix')); } else { resolve(); }
        });
        zip.on('error', finish);
        zip.on('end', () => finish(manifestFound ? undefined : new GithubUpdateError('invalidVsix')));
        zip.on('entry', (entry: yauzl.Entry) => {
            if (finished) { return; }
            if (entry.fileName.toLowerCase() !== 'extension/package.json') { zip.readEntry(); return; }
            if (manifestFound || entry.fileName !== 'extension/package.json' || entry.isEncrypted()
                || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
                || entry.uncompressedSize > MAX_MANIFEST_BYTES) {
                finish(new GithubUpdateError('invalidVsix'));
                return;
            }
            manifestFound = true;
            zip.openReadStream(entry, (error, opened) => {
                if (error) { finish(error); return; }
                if (finished) { opened.destroy(); return; }
                stream = opened;
                readBounded(opened, MAX_MANIFEST_BYTES, signal).then(data => {
                    if (finished) { return; }
                    try {
                        validateManifest(data, release, vscodeVersion);
                        zip.readEntry();
                    } catch (validationError) { finish(validationError); }
                }, finish);
            });
        });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); } else if (zip.entryCount > MAX_ZIP_ENTRIES) {
            finish(new GithubUpdateError('invalidVsix'));
        } else { zip.readEntry(); }
    });
}

/** Creates a new private file, never overwrites one; all failure paths remove only our file. */
export async function downloadAndVerifyRelease(release: GithubRelease, destination: string, vscodeVersion: string, signal: AbortSignal): Promise<void> {
    validateRelease(release);
    let created = false;
    try {
        await withDeadline(signal, 120000, async bounded => {
            const response = await requestFollowingRedirects(release.assetUrl, true, bounded);
            try {
                if (response.statusCode !== 200) { throw new GithubUpdateError('network'); }
                const advertised = response.headers['content-length'];
                if (advertised !== undefined && Number(advertised) !== release.size) {
                    throw new GithubUpdateError('invalidMetadata');
                }
                let file: fs.promises.FileHandle;
                try { file = await fs.promises.open(destination, 'wx', 0o600); } catch { throw new GithubUpdateError('fileSystem'); }
                created = true;
                const hash = createHash('sha256');
                let size = 0;
                try {
                    for await (const piece of response) {
                        throwIfAborted(bounded);
                        const chunk: Buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
                        size += chunk.length;
                        if (size > release.size) { throw new GithubUpdateError('tooLarge'); }
                        hash.update(chunk);
                        let offset = 0;
                        while (offset < chunk.length) {
                            throwIfAborted(bounded);
                            try {
                                const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
                                if (bytesWritten <= 0) { throw new GithubUpdateError('fileSystem'); }
                                offset += bytesWritten;
                            } catch { throw new GithubUpdateError('fileSystem'); }
                        }
                    }
                } finally {
                    try { await file.close(); } catch { throw new GithubUpdateError('fileSystem'); }
                }
                if (size !== release.size || !timingSafeEqual(hash.digest(), Buffer.from(release.sha256, 'hex'))) {
                    throw new GithubUpdateError('digestMismatch');
                }
            } finally {
                response.destroy();
            }
            await verifyVsix(destination, release, vscodeVersion, bounded);
        });
    } catch (error) {
        if (created) {
            try { await fs.promises.unlink(destination); } catch { throw new GithubUpdateError('fileSystem'); }
        }
        throw error;
    }
}
