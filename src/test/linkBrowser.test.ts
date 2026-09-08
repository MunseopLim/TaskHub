import * as assert from 'assert';
import * as vscode from 'vscode';
import { openLinkInIntegratedBrowser } from '../extension';
import { Link, LinkGroup } from '../providers/linkViewProvider';

function makeLink(url: string): Link {
    return new Link({ title: 'Documentation', link: url, tags: ['reference'] });
}

suite('Links Integrated Browser', () => {
    suite('링크 행', () => {
        test('HTTP(S) 링크만 내장 브라우저 버튼을 표시할 컨텍스트를 가진다', () => {
            for (const url of [
                'https://example.com/docs',
                'http://localhost:3000/',
                'http://127.0.0.1:8080/report',
                'https://[::1]:8443/',
                'HTTPS://EXAMPLE.COM/docs',
            ]) {
                const item = makeLink(url);
                assert.strictEqual(item.canOpenInIntegratedBrowser(), true, url);
                assert.strictEqual(item.contextValue, 'linkItem.browser', url);
            }

            for (const url of [
                'mailto:help@example.com',
                'vscode://file/path/to/project',
                'file:///tmp/report.html',
                'ftp://example.com/report',
                'javascript:alert(1)',
                'https://',
                'https://bad host/',
                'example.com',
                '',
            ]) {
                const item = makeLink(url);
                assert.strictEqual(item.canOpenInIntegratedBrowser(), false, url);
                assert.strictEqual(item.contextValue, 'linkItem', url);
            }
        });

        test('브라우저 버튼 자격과 관계없이 행 클릭 명령과 원본 링크를 보존한다', () => {
            for (const url of ['https://example.com/docs?q=a%26b#summary', 'mailto:help@example.com']) {
                const item = makeLink(url);
                assert.strictEqual(item.command?.command, 'taskhub.openLink');
                assert.deepStrictEqual(item.command?.arguments, [url]);
                assert.strictEqual(item.getLink(), url);
                assert.strictEqual(item.getEntry().link, url);
                assert.strictEqual(item.description, 'reference');
            }
        });
    });

    suite('내장 브라우저 명령', () => {
        let originalGetCommands: typeof vscode.commands.getCommands;
        let originalExecuteCommand: typeof vscode.commands.executeCommand;
        let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
        let originalOpenExternal: typeof vscode.env.openExternal;
        let originalAsExternalUri: typeof vscode.env.asExternalUri;
        let calls: Array<{ command: string; args: unknown[] }>;
        let discoveryCalls: Array<boolean | undefined>;
        let errors: string[];
        let externalUris: vscode.Uri[];
        let commandFailure: Error | undefined;

        setup(() => {
            originalGetCommands = vscode.commands.getCommands;
            originalExecuteCommand = vscode.commands.executeCommand;
            originalShowErrorMessage = vscode.window.showErrorMessage;
            originalOpenExternal = vscode.env.openExternal;
            originalAsExternalUri = vscode.env.asExternalUri;
            calls = [];
            discoveryCalls = [];
            errors = [];
            externalUris = [];
            commandFailure = undefined;

            vscode.commands.getCommands = async filterInternal => {
                discoveryCalls.push(filterInternal);
                return ['workbench.action.browser.open', 'simpleBrowser.show'];
            };
            vscode.commands.executeCommand = async <T>(command: string, ...args: unknown[]) => {
                calls.push({ command, args });
                if (commandFailure) {
                    throw commandFailure;
                }
                return undefined as T;
            };
            vscode.window.showErrorMessage = ((message: string) => {
                errors.push(message);
                return Promise.resolve(undefined);
            }) as typeof vscode.window.showErrorMessage;
            vscode.env.openExternal = async uri => {
                externalUris.push(uri);
                return true;
            };
            vscode.env.asExternalUri = async uri => uri;
        });

        teardown(() => {
            vscode.commands.getCommands = originalGetCommands;
            vscode.commands.executeCommand = originalExecuteCommand;
            vscode.window.showErrorMessage = originalShowErrorMessage;
            vscode.env.openExternal = originalOpenExternal;
            vscode.env.asExternalUri = originalAsExternalUri;
        });

        test('선택한 링크의 쿼리와 fragment를 내장 브라우저 명령에 전달한다', async () => {
            const url = 'https://example.com/search?q=a%26b&r=x%3Dy#summary';

            await openLinkInIntegratedBrowser(makeLink(url));

            assert.deepStrictEqual(calls, [{
                command: 'workbench.action.browser.open',
                args: [url],
            }]);
            assert.deepStrictEqual(discoveryCalls, [true]);
            assert.deepStrictEqual(externalUris, []);
            assert.deepStrictEqual(errors, []);
        });

        test('내장 브라우저 실행 실패를 알리고 외부 브라우저를 열지 않는다', async () => {
            commandFailure = new Error('browser command failed');

            await openLinkInIntegratedBrowser(makeLink('https://example.com/docs'));

            assert.strictEqual(errors.length, 1);
            assert.ok(errors[0].includes(commandFailure.message));
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].command, 'workbench.action.browser.open');
            assert.deepStrictEqual(externalUris, []);
        });

        test('숨겨진 버튼 명령을 직접 호출해도 비웹 주소와 잘못된 URL을 거부한다', async () => {
            const urls = ['mailto:help@example.com', 'file:///tmp/report.html', 'https://'];
            for (const url of urls) {
                await openLinkInIntegratedBrowser(makeLink(url));
            }

            assert.strictEqual(errors.length, urls.length);
            assert.ok(errors.every(message => message.includes('HTTP') || message.includes('http')));
            assert.deepStrictEqual(discoveryCalls, []);
            assert.deepStrictEqual(calls, []);
            assert.deepStrictEqual(externalUris, []);
        });

        test('링크 항목이 없는 호출과 다른 트리 항목은 무시한다', async () => {
            await openLinkInIntegratedBrowser();
            await openLinkInIntegratedBrowser(null as unknown as Link);
            await openLinkInIntegratedBrowser(new LinkGroup('Docs', []) as unknown as Link);
            await openLinkInIntegratedBrowser('https://example.com/' as unknown as Link);

            assert.deepStrictEqual(discoveryCalls, []);
            assert.deepStrictEqual(calls, []);
            assert.deepStrictEqual(externalUris, []);
            assert.deepStrictEqual(errors, []);
        });
    });
});
