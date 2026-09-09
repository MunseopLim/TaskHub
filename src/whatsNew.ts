import * as vscode from 'vscode';
import * as semver from 'semver';
import * as fs from 'fs';
import * as path from 'path';
import { t } from './i18n';

export const WHATS_NEW_COMMAND = 'taskhub.showWhatsNew';
export const WHATS_NEW_STORAGE_DIRECTORY = 'whats-new';
const CONTENT_SCHEME = 'taskhub-whats-new';

/** vsce는 CHANGELOG.md를 소문자로 패키징하므로 실제 디렉터리 항목의 철자를 사용한다. */
export async function resolveChangelogUri(extensionUri: vscode.Uri): Promise<vscode.Uri> {
    const files = (await vscode.workspace.fs.readDirectory(extensionUri))
        .filter(([, type]) => (type & vscode.FileType.File) !== 0);
    const entry = files.find(([name]) => name === 'CHANGELOG.md')
        ?? files.find(([name]) => name.toLowerCase() === 'changelog.md');
    if (!entry) {
        throw vscode.FileSystemError.FileNotFound(vscode.Uri.joinPath(extensionUri, 'CHANGELOG.md'));
    }
    return vscode.Uri.joinPath(extensionUri, entry[0]);
}

export interface ChangelogRelease {
    version: string;
    date: string;
    titles: string[];
    markdown: string;
}

export interface WhatsNewState {
    installedVersion: string;
    readThroughVersion: string;
    viewedVersions: string[];
}

export interface WhatsNewController {
    readonly onDidChange: vscode.Event<void>;
    getUnreadCount(): number;
}

function isVersion(value: unknown): value is string {
    return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) && semver.valid(value) !== null;
}

/** CHANGELOG의 본문은 그대로 보존하되 코드 예제/주석의 제목을 릴리스로 해석하지 않는다. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
    const releases: ChangelogRelease[] = [];
    const seenVersions = new Set<string>();
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    let current: { release: ChangelogRelease; lines: string[] } | undefined;
    let fence: { marker: string; length: number } | undefined;
    let inComment = false;
    const finish = () => {
        if (current && !seenVersions.has(current.release.version)) {
            current.release.markdown = current.lines.join('\n').trim();
            releases.push(current.release);
            seenVersions.add(current.release.version);
        }
    };
    for (const line of lines) {
        let headingLine = line;
        if (!fence) {
            // 한 줄 안에서 주석을 닫고 다시 여는 경우도 처리한다.
            headingLine = '';
            let offset = 0;
            while (offset < line.length) {
                const boundary = line.indexOf(inComment ? '-->' : '<!--', offset);
                if (boundary < 0) {
                    if (!inComment) { headingLine += line.slice(offset); }
                    break;
                }
                if (!inComment) { headingLine += line.slice(offset, boundary); }
                offset = boundary + (inComment ? 3 : 4);
                inComment = !inComment;
            }
        }
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(headingLine);
        const insideFence = Boolean(fence);
        if (delimiter) {
            if (!fence) {
                fence = { marker: delimiter[1][0], length: delimiter[1].length };
            } else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length
                && delimiter[2].trim() === '') {
                fence = undefined;
            }
        }
        if (!insideFence && !delimiter) {
            const releaseHeading = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/.exec(headingLine);
            if (releaseHeading && isVersion(releaseHeading[1])) {
                finish();
                current = {
                    release: { version: releaseHeading[1], date: releaseHeading[2], titles: [], markdown: '' },
                    lines: [line],
                };
                continue;
            }
            const title = /^###\s+(.+?)(?:\s+#+)?\s*$/.exec(headingLine);
            if (current && title) { current.release.titles.push(title[1]); }
            // 미발행/다른 섹션의 내용이 직전 릴리스에 섞이지 않게 한다.
            if (/^##\s+/.test(headingLine)) {
                finish();
                current = undefined;
            }
        }
        current?.lines.push(line);
    }
    finish();
    return releases.sort((a, b) => semver.rcompare(a.version, b.version));
}

export function initializeWhatsNewState(value: unknown, currentVersion: string): WhatsNewState {
    const saved = value && typeof value === 'object' ? value as Partial<WhatsNewState> : undefined;
    const baseline = isVersion(saved?.readThroughVersion) ? saved.readThroughVersion : currentVersion;
    return {
        installedVersion: currentVersion,
        readThroughVersion: baseline,
        viewedVersions: Array.isArray(saved?.viewedVersions)
            ? [...new Set(saved.viewedVersions.filter(isVersion))].filter(version => semver.gt(version, baseline))
            : [],
    };
}

export function getUnreadReleases(releases: readonly ChangelogRelease[], state: WhatsNewState): ChangelogRelease[] {
    return releases.filter(release => semver.gt(release.version, state.readThroughVersion)
        && semver.lte(release.version, state.installedVersion) && !state.viewedVersions.includes(release.version));
}

export function markReleasesViewed(
    state: WhatsNewState, displayed: readonly ChangelogRelease[]
): WhatsNewState {
    return {
        ...state,
        viewedVersions: [...new Set([...state.viewedVersions, ...displayed.map(release => release.version)])]
            .filter(version => semver.gt(version, state.readThroughVersion)),
    };
}

interface WhatsNewMarkers {
    baseline?: string;
    viewedVersions: string[];
}

async function readMarkers(directory: string): Promise<WhatsNewMarkers> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { viewedVersions: [] }; }
        throw error;
    }
    const baselines: string[] = [];
    const viewedVersions: string[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) { continue; }
        const match = /^(baseline|read)-(\d+\.\d+\.\d+)$/.exec(entry.name);
        if (!match || !isVersion(match[2])) { continue; }
        (match[1] === 'baseline' ? baselines : viewedVersions).push(match[2]);
    }
    return { baseline: baselines.sort(semver.compare)[0], viewedVersions };
}

/** 서로 다른 창의 읽음 저장은 독립 파일을 추가할 뿐, 기존 상태를 덮어쓰지 않는다. */
async function writeMarker(directory: string, kind: 'baseline' | 'read', version: string): Promise<void> {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, `${kind}-${version}`), '', { flag: 'a', mode: 0o600 });
}

/** 가상 문서의 상대 링크도 확장에 동봉된 문서를 기준으로 연다. */
export function buildWhatsNewMarkdown(releases: readonly ChangelogRelease[], extensionUri: vscode.Uri): string {
    const body = releases.map(release => release.markdown).join('\n\n');
    const withLinks = body.replace(/\]\(([^\s)]+)\)/g, (match, target: string) => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) { return match; }
        const hash = target.indexOf('#');
        const filePath = hash < 0 ? target : target.slice(0, hash);
        const uri = vscode.Uri.joinPath(extensionUri, filePath)
            .with({ fragment: hash < 0 ? '' : target.slice(hash + 1) });
        return `](${uri.toString()})`;
    });
    return `# ${t('TaskHub 새로운 기능', 'TaskHub What’s New')}\n\n`
        + `${t('변경 내용은 CHANGELOG의 한국어 원문입니다.', 'Release notes below are the original Korean CHANGELOG text.')}\n\n`
        + withLinks + '\n';
}

interface ReleaseItem extends vscode.QuickPickItem {
    releases: ChangelogRelease[];
}

export function registerWhatsNew(context: vscode.ExtensionContext): WhatsNewController {
    const changed = new vscode.EventEmitter<void>();
    const version: unknown = context.extension.packageJSON.version;
    let state = initializeWhatsNewState(undefined, isVersion(version) ? version : '0.0.0');
    const directory = path.join(context.globalStorageUri.fsPath, WHATS_NEW_STORAGE_DIRECTORY);
    let releases: ChangelogRelease[] = [];
    let loadError: unknown;
    let disposed = false;
    let hasBaseline = false;
    const refreshStoredState = async (): Promise<void> => {
        const stored = await readMarkers(directory);
        hasBaseline = stored.baseline !== undefined;
        state = {
            ...state,
            readThroughVersion: stored.baseline ?? state.readThroughVersion,
            viewedVersions: [...new Set([...state.viewedVersions, ...stored.viewedVersions])],
        };
    };
    const ready = (async () => {
        try {
            await refreshStoredState();
            if (!hasBaseline) {
                // 최초 시작이 여러 창에서 겹치면 기준 표식도 병합된다. 가장 오래된
                // 기준부터 안내해 중간 업데이트를 읽지 않은 채 건너뛰지 않는다.
                await writeMarker(directory, 'baseline', state.readThroughVersion);
                await refreshStoredState();
            }
        } catch {
            // 저장소 오류로 확장 활성화나 동봉된 변경 내용 열기를 막지 않는다.
        }
        try {
            const content = await vscode.workspace.fs.readFile(await resolveChangelogUri(context.extensionUri));
            releases = parseChangelog(Buffer.from(content).toString('utf8'));
        } catch (error) {
            loadError = error;
        }
        if (!disposed) { changed.fire(); }
    })();

    const provider = vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, {
        provideTextDocumentContent: async uri => {
            await ready;
            // URI에 버전만 담아 탭 복원 후에도 같은 내용을 제공한다. 본문은 항상 동봉된 파일에서 읽는다.
            const requested = new Set(uri.query.split(','));
            const selected = releases.filter(release => requested.has(release.version)
                && semver.lte(release.version, state.installedVersion));
            return selected.length > 0 ? buildWhatsNewMarkdown(selected, context.extensionUri) : t(
                '이 업데이트 안내를 찾을 수 없습니다. TaskHub: 새로운 기능 명령으로 다시 여세요.',
                'These release notes are unavailable. Open them again with TaskHub: What’s New.'
            );
        },
    });
    const command = vscode.commands.registerCommand(WHATS_NEW_COMMAND, async () => {
        await ready;
        if (disposed) { return; }
        try {
            // 다른 창의 읽음 표식도 목록을 열 때 반영한다.
            await refreshStoredState();
            changed.fire();
        } catch { /* 현재 창의 상태로 계속 열 수 있다. */ }
        if (loadError) {
            await vscode.window.showWarningMessage(t('CHANGELOG.md 파일을 읽을 수 없습니다.', 'Could not read CHANGELOG.md.'));
            return;
        }
        const unread = getUnreadReleases(releases, state);
        const available = unread.length > 0 ? unread : releases.filter(release => release.version === state.installedVersion);
        if (available.length === 0) {
            await vscode.window.showInformationMessage(t('현재 버전의 변경 내용이 없습니다.', 'No release notes are available for this version.'));
            return;
        }
        const items: ReleaseItem[] = available.map(release => ({
            label: release.titles.join(' · ') || t('변경 내용', 'Release notes'),
            description: `${release.version} · ${release.date} ${t('(한국어)', '(Korean)')}`,
            releases: [release],
        }));
        if (available.length > 1) {
            items.unshift({
                label: `$(book) ${t('업데이트 내용 모두 보기', 'View all update notes')}`,
                description: t(`${available.length}개 버전 (한국어)`, `${available.length} versions (Korean)`),
                releases: available,
            });
        }
        const selected = await vscode.window.showQuickPick(items, {
            title: t('TaskHub 새로운 기능', 'TaskHub What’s New'),
            placeHolder: t('버전을 선택해 자세한 변경 내용을 확인하세요.', 'Select a release to read its details.'),
            matchOnDescription: true,
        });
        if (!selected || disposed) { return; }
        const uri = vscode.Uri.from({
            scheme: CONTENT_SCHEME,
            path: `/TaskHub-${selected.releases[0].version}.md`,
            query: selected.releases.map(release => release.version).join(','),
        });
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            try {
                await vscode.commands.executeCommand('markdown.showPreview', uri);
            } catch {
                // 기본 Markdown 확장이 꺼져 있어도 읽기 전용 원문으로 내용을 확인할 수 있다.
                await vscode.window.showTextDocument(document, { preview: true });
            }
            state = markReleasesViewed(state, selected.releases);
            try {
                if (!hasBaseline) { await writeMarker(directory, 'baseline', state.readThroughVersion); }
                await Promise.all(selected.releases.map(release => writeMarker(directory, 'read', release.version)));
                await refreshStoredState();
            } catch {
                await vscode.window.showWarningMessage(t(
                    '변경 내용은 열었지만 읽음 상태를 저장하지 못했습니다. 다음 실행에서 다시 표시될 수 있습니다.',
                    'The release notes opened, but their read status could not be saved. They may appear as unread next time.'
                ));
            }
            if (!disposed) { changed.fire(); }
        } catch {
            await vscode.window.showErrorMessage(t('변경 내용을 열 수 없습니다.', 'Could not open the release notes.'));
        }
    });
    context.subscriptions.push(command, provider, changed, new vscode.Disposable(() => {
        disposed = true;
    }));
    return {
        onDidChange: changed.event,
        getUnreadCount: () => getUnreadReleases(releases, state).length,
    };
}
