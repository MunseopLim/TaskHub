import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../i18n';
import {
    extensionOf,
    isMarkdownUri,
    isHtmlUri,
    coerceToUri,
    openMarkdownPreview,
    openHtmlInBrowser,
    PreviewOpenerDeps,
} from '../previewOpener';

interface CapturedExec {
    command: string;
    args: unknown[];
}

function makeFakeDeps(overrides?: { activeUri?: vscode.Uri }): {
    deps: PreviewOpenerDeps;
    execs: CapturedExec[];
    externals: vscode.Uri[];
    errors: string[];
} {
    const execs: CapturedExec[] = [];
    const externals: vscode.Uri[] = [];
    const errors: string[] = [];
    const deps: PreviewOpenerDeps = {
        executeCommand: <T = unknown>(command: string, ...rest: unknown[]) => {
            execs.push({ command, args: rest });
            return Promise.resolve(undefined as unknown as T);
        },
        openExternal: (target: vscode.Uri) => {
            externals.push(target);
            return Promise.resolve(true);
        },
        showErrorMessage: (message: string) => {
            errors.push(message);
            return Promise.resolve(undefined);
        },
        activeTextEditor: () => overrides?.activeUri
            ? ({ document: { uri: overrides.activeUri } } as unknown as vscode.TextEditor)
            : undefined,
    };
    return { deps, execs, externals, errors };
}

function fakeScmResourceState(uri: vscode.Uri): { resourceUri: vscode.Uri; decorations?: unknown } {
    // Mirrors the minimal shape of vscode.SourceControlResourceState that
    // VS Code passes as the first argument to scm/resourceState/context
    // commands. Only `resourceUri` matters for our normalize path.
    return { resourceUri: uri, decorations: { strikeThrough: false } };
}

suite('previewOpener', () => {
    // =====================================================================
    // Unit — pure helpers
    // =====================================================================
    suite('extensionOf / isMarkdownUri / isHtmlUri', () => {
        test('extensionOf returns lowercased extension for plain file URI', () => {
            assert.strictEqual(extensionOf(vscode.Uri.file('/tmp/README.MD')), '.md');
            assert.strictEqual(extensionOf(vscode.Uri.file('/tmp/index.HTML')), '.html');
            assert.strictEqual(extensionOf(vscode.Uri.file('/tmp/page.htm')), '.htm');
        });

        test('extensionOf returns "" for files without extension', () => {
            assert.strictEqual(extensionOf(vscode.Uri.file('/tmp/Makefile')), '');
        });

        test('extensionOf ignores leading-dot files (".gitignore")', () => {
            assert.strictEqual(extensionOf(vscode.Uri.file('/tmp/.gitignore')), '');
        });

        test('extensionOf only considers the basename, not earlier dots in the path', () => {
            assert.strictEqual(extensionOf(vscode.Uri.file('/some.dir/notes.md')), '.md');
        });

        test('isMarkdownUri matches .md and .markdown only', () => {
            assert.strictEqual(isMarkdownUri(vscode.Uri.file('/a.md')), true);
            assert.strictEqual(isMarkdownUri(vscode.Uri.file('/a.markdown')), true);
            assert.strictEqual(isMarkdownUri(vscode.Uri.file('/a.html')), false);
            assert.strictEqual(isMarkdownUri(vscode.Uri.file('/a.txt')), false);
        });

        test('isHtmlUri matches .html and .htm only', () => {
            assert.strictEqual(isHtmlUri(vscode.Uri.file('/a.html')), true);
            assert.strictEqual(isHtmlUri(vscode.Uri.file('/a.htm')), true);
            assert.strictEqual(isHtmlUri(vscode.Uri.file('/a.md')), false);
        });
    });

    // =====================================================================
    // Unit — coerceToUri normalizes the heterogeneous menu argument shapes
    // =====================================================================
    suite('coerceToUri', () => {
        test('returns a Uri argument unchanged', () => {
            const uri = vscode.Uri.file('/tmp/a.md');
            assert.strictEqual(coerceToUri(uri), uri);
        });

        test('extracts resourceUri from a SourceControlResourceState-shaped object (SCM path)', () => {
            const uri = vscode.Uri.file('/tmp/changed.md');
            const state = fakeScmResourceState(uri);
            assert.strictEqual(coerceToUri(state), uri);
        });

        test('returns first Uri from an array of Uris (explorer multi-select)', () => {
            const first = vscode.Uri.file('/tmp/a.md');
            const second = vscode.Uri.file('/tmp/b.md');
            assert.strictEqual(coerceToUri([first, second]), first);
        });

        test('returns first resourceUri from an array of SCM resource states (SCM multi-select)', () => {
            const first = vscode.Uri.file('/tmp/a.md');
            const second = vscode.Uri.file('/tmp/b.md');
            assert.strictEqual(coerceToUri([fakeScmResourceState(first), fakeScmResourceState(second)]), first);
        });

        test('skips garbage entries inside an array and returns the first usable Uri', () => {
            const uri = vscode.Uri.file('/tmp/a.md');
            assert.strictEqual(coerceToUri([null, 'string', 42, fakeScmResourceState(uri)]), uri);
        });

        test('returns undefined for unrecognized inputs', () => {
            assert.strictEqual(coerceToUri(undefined), undefined);
            assert.strictEqual(coerceToUri(null), undefined);
            assert.strictEqual(coerceToUri('not a uri'), undefined);
            assert.strictEqual(coerceToUri(42), undefined);
            assert.strictEqual(coerceToUri({}), undefined);
            assert.strictEqual(coerceToUri({ resourceUri: 'not a uri' }), undefined);
            assert.strictEqual(coerceToUri([]), undefined);
            assert.strictEqual(coerceToUri([null, undefined, {}]), undefined);
        });
    });

    // =====================================================================
    // Unit — handler delegation via injected deps
    // =====================================================================
    suite('openMarkdownPreview', () => {
        test('forwards .md URI to markdown.showPreviewToSide', async () => {
            const { deps, execs, errors } = makeFakeDeps();
            const uri = vscode.Uri.file('/tmp/notes.md');
            await openMarkdownPreview(uri, deps);
            assert.strictEqual(execs.length, 1);
            assert.strictEqual(execs[0].command, 'markdown.showPreviewToSide');
            assert.deepStrictEqual(execs[0].args, [uri]);
            assert.deepStrictEqual(errors, []);
        });

        test('accepts SCM resource state shape and routes to the underlying resourceUri', async () => {
            const { deps, execs, errors } = makeFakeDeps();
            const uri = vscode.Uri.file('/tmp/changed.md');
            await openMarkdownPreview(fakeScmResourceState(uri), deps);
            assert.strictEqual(execs.length, 1);
            assert.deepStrictEqual(execs[0].args, [uri]);
            assert.deepStrictEqual(errors, []);
        });

        test('accepts a multi-select array and uses the first matching URI', async () => {
            const { deps, execs, errors } = makeFakeDeps();
            const first = vscode.Uri.file('/tmp/a.md');
            const second = vscode.Uri.file('/tmp/b.md');
            await openMarkdownPreview([first, second], deps);
            assert.strictEqual(execs.length, 1);
            assert.deepStrictEqual(execs[0].args, [first]);
            assert.deepStrictEqual(errors, []);
        });

        test('shows an error and skips delegation when extension is unsupported', async () => {
            const { deps, execs, errors } = makeFakeDeps();
            await openMarkdownPreview(vscode.Uri.file('/tmp/notes.txt'), deps);
            assert.strictEqual(execs.length, 0);
            assert.deepStrictEqual(errors, [t(
                '마크다운(.md/.markdown) 파일이 아닙니다.',
                'Not a Markdown (.md/.markdown) file.'
            )]);
        });

        test('falls back to active editor URI when no explicit arg is passed', async () => {
            const activeUri = vscode.Uri.file('/tmp/from-editor.md');
            const { deps, execs, errors } = makeFakeDeps({ activeUri });
            await openMarkdownPreview(undefined, deps);
            assert.strictEqual(execs.length, 1);
            assert.deepStrictEqual(execs[0].args, [activeUri]);
            assert.deepStrictEqual(errors, []);
        });

        test('errors out when no arg is given and active editor is not a Markdown file', async () => {
            const { deps, execs, errors } = makeFakeDeps({
                activeUri: vscode.Uri.file('/tmp/main.ts'),
            });
            await openMarkdownPreview(undefined, deps);
            assert.strictEqual(execs.length, 0);
            assert.deepStrictEqual(errors, [t(
                '열려 있는 Markdown 파일이 없습니다. 파일을 열고 다시 실행하세요.',
                'No Markdown file is open. Open a file and run the command again.'
            )]);
        });
    });

    suite('openHtmlInBrowser', () => {
        test('forwards .html URI to env.openExternal', async () => {
            const { deps, execs, externals, errors } = makeFakeDeps();
            const uri = vscode.Uri.file('/tmp/page.htm');
            await openHtmlInBrowser(uri, deps);
            assert.strictEqual(execs.length, 0);
            assert.strictEqual(externals.length, 1);
            assert.strictEqual(externals[0].toString(), uri.toString());
            assert.deepStrictEqual(errors, []);
        });

        test('accepts SCM resource state shape', async () => {
            const { deps, externals, errors } = makeFakeDeps();
            const uri = vscode.Uri.file('/tmp/page.html');
            await openHtmlInBrowser(fakeScmResourceState(uri), deps);
            assert.strictEqual(externals.length, 1);
            assert.strictEqual(externals[0].toString(), uri.toString());
            assert.deepStrictEqual(errors, []);
        });

        test('rejects non-HTML files', async () => {
            const { deps, externals, errors } = makeFakeDeps();
            await openHtmlInBrowser(vscode.Uri.file('/tmp/notes.md'), deps);
            assert.strictEqual(externals.length, 0);
            assert.deepStrictEqual(errors, [t(
                'HTML(.html/.htm) 파일이 아닙니다.',
                'Not an HTML (.html/.htm) file.'
            )]);
        });

        test('explains how to recover when no HTML file is open', async () => {
            const { deps, externals, errors } = makeFakeDeps();
            await openHtmlInBrowser(undefined, deps);
            assert.strictEqual(externals.length, 0);
            assert.deepStrictEqual(errors, [t(
                '열려 있는 HTML 파일이 없습니다. 파일을 열고 다시 실행하세요.',
                'No HTML file is open. Open a file and run the command again.'
            )]);
        });
    });

    // =====================================================================
    // Integration — commands are registered on the live extension and the
    // package.json menu matrix matches the documented design.
    // =====================================================================
    suite('integration: registered commands and menu surfaces', () => {
        const COMMANDS = ['taskhub.openMarkdownPreview', 'taskhub.openHtmlInBrowser'] as const;
        const SURFACES = ['explorer/context', 'editor/title/context', 'scm/resourceState/context'] as const;

        test('IT-PRV-001: extension registers all preview/browser commands', async () => {
            const all = await vscode.commands.getCommands(true);
            for (const id of COMMANDS) {
                assert.ok(all.includes(id), `command not registered: ${id}`);
            }
            // Sanity: removed Simple Browser command must NOT be present.
            assert.ok(
                !all.includes('taskhub.openHtmlInSimpleBrowser'),
                'taskhub.openHtmlInSimpleBrowser was removed and must not be registered',
            );
        });

        test('IT-PRV-002: package.json declares each command', () => {
            // Tests compile to out/test/*.test.js → repo root is two levels up.
            const repoRoot = path.resolve(__dirname, '..', '..');
            const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
            const declared = new Set<string>(
                (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command),
            );
            for (const id of COMMANDS) {
                assert.ok(declared.has(id), `command not declared in package.json: ${id}`);
            }
            assert.ok(
                !declared.has('taskhub.openHtmlInSimpleBrowser'),
                'taskhub.openHtmlInSimpleBrowser must be removed from package.json',
            );
        });

        test('IT-PRV-003: every command appears on every menu surface (full matrix)', () => {
            const repoRoot = path.resolve(__dirname, '..', '..');
            const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
            const menus = pkg.contributes?.menus ?? {};
            const missing: string[] = [];
            for (const surface of SURFACES) {
                const entries = (menus[surface] ?? []) as Array<{ command: string }>;
                const present = new Set(entries.map(e => e.command));
                for (const id of COMMANDS) {
                    if (!present.has(id)) {
                        missing.push(`${surface} ⟶ ${id}`);
                    }
                }
            }
            assert.deepStrictEqual(
                missing,
                [],
                `Each preview command must appear on each menu surface; missing:\n  ${missing.join('\n  ')}`,
            );
        });

        test('IT-PRV-004: SCM preview menus are gated only by the Source Control visibility setting', () => {
            const repoRoot = path.resolve(__dirname, '..', '..');
            const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
            const entries = (pkg.contributes?.menus?.['scm/resourceState/context'] ?? []) as Array<{
                command: string;
                when?: string;
            }>;
            for (const id of COMMANDS) {
                const entry = entries.find(e => e.command === id);
                assert.ok(entry, `SCM preview menu entry is missing: ${id}`);
                assert.strictEqual(
                    entry.when,
                    'config.taskhub.preview.showSourceControlContextMenu',
                    'SCM resource context does not reliably provide resourceLangId/resourceExtname; gate only by the user-facing setting',
                );
            }
        });
    });
});
