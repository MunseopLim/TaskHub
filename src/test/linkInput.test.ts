import * as assert from 'assert';
import * as vscode from 'vscode';
import { promptLinkTitle, readClipboardLinkUrl } from '../linkInput';

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

/** 네트워크 없이 제목 조회와 사용자 입력의 완료 순서를 직접 제어한다. */
class LinkTitleInputBox {
    private currentValue = '';
    private readonly changeEmitter = new vscode.EventEmitter<string>();
    private readonly acceptEmitter = new vscode.EventEmitter<void>();
    private readonly hideEmitter = new vscode.EventEmitter<void>();

    readonly onDidChangeValue = this.changeEmitter.event;
    readonly onDidAccept = this.acceptEmitter.event;
    readonly onDidHide = this.hideEmitter.event;
    busy = false;
    shown = false;
    disposed = false;
    validationMessage: string | vscode.InputBoxValidationMessage | undefined;

    get value(): string {
        return this.currentValue;
    }

    set value(value: string) {
        if (value !== this.currentValue) {
            this.currentValue = value;
            this.changeEmitter.fire(value);
        }
    }

    show(): void {
        this.shown = true;
        this.changeEmitter.fire(this.value);
    }

    hide(): void {
        this.shown = false;
        this.hideEmitter.fire();
    }

    accept(): void {
        this.acceptEmitter.fire();
    }

    dispose(): void {
        this.disposed = true;
        this.changeEmitter.dispose();
        this.acceptEmitter.dispose();
        this.hideEmitter.dispose();
    }
}

function flushAsyncWork(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

suite('링크 추가 입력', () => {
    const originalCreateInputBox = vscode.window.createInputBox;
    let boxes: LinkTitleInputBox[];

    setup(() => {
        boxes = [];
        vscode.window.createInputBox = () => {
            const box = new LinkTitleInputBox();
            boxes.push(box);
            return box as unknown as vscode.InputBox;
        };
    });

    teardown(() => {
        vscode.window.createInputBox = originalCreateInputBox;
        for (const box of boxes) {
            if (!box.disposed) {
                box.hide();
                box.dispose();
            }
        }
    });

    suite('클립보드 URL 제안', () => {
        test('앞뒤 공백만 제거하고 허용된 URL의 경로·쿼리·fragment를 보존한다', async () => {
            for (const url of [
                'https://example.com/path?q=hello%20world#section',
                'http://localhost:3000/docs',
                'mailto:user@example.com?subject=Hello',
            ]) {
                assert.strictEqual(await readClipboardLinkUrl(async () => `  ${url}\n`), url);
            }
        });

        test('일반 텍스트·잘못된 URL·허용하지 않은 스킴을 제안하지 않는다', async () => {
            for (const value of [
                '',
                '  ',
                'copied source code',
                'example.com/path',
                'https://',
                'javascript:alert(1)',
                'command:workbench.action.closeWindow',
                'file:///tmp/example.txt',
                'data:text/html,hello',
            ]) {
                assert.strictEqual(await readClipboardLinkUrl(async () => value), undefined, value);
            }
        });

        test('URL 파서가 정규화할 수 있는 줄바꿈과 너무 긴 클립보드를 거른다', async () => {
            for (const value of [
                'https://example.com/\nsecond-line',
                'https://example.com/\rsecond-line',
                `https://example.com/${'a'.repeat(16 * 1024)}`,
            ]) {
                assert.strictEqual(await readClipboardLinkUrl(async () => value), undefined);
            }
        });

        test('클립보드 접근 실패는 URL 입력을 막지 않는다', async () => {
            const result = await readClipboardLinkUrl(async () => {
                throw new Error('Clipboard unavailable');
            });
            assert.strictEqual(result, undefined);
        });
    });

    suite('사이트 제목 제안', () => {
        test('조회 중에도 기본 제목을 즉시 보여주고 조회 결과로 채운다', async () => {
            const title = deferred<string | undefined>();
            let requestedUrl: string | undefined;
            const result = promptLinkTitle('https://example.com/docs', 'example.com', async url => {
                requestedUrl = url;
                return title.promise;
            });
            const box = boxes[0];
            assert.ok(box?.shown, '제목 조회가 끝나기 전에 입력창을 표시해야 한다');
            assert.strictEqual(box.value, 'example.com');
            assert.strictEqual(box.busy, true);
            title.resolve('Example Documentation');
            await flushAsyncWork();

            assert.strictEqual(requestedUrl, 'https://example.com/docs');
            assert.strictEqual(box.value, 'Example Documentation');
            assert.strictEqual(box.busy, false);
            box.accept();
            assert.strictEqual(await result, 'Example Documentation');
            assert.strictEqual(box.disposed, true);
        });

        test('늦게 도착한 사이트 제목이 사용자가 쓴 제목을 덮어쓰지 않는다', async () => {
            const title = deferred<string | undefined>();
            const result = promptLinkTitle('https://example.com', 'example.com', () => title.promise);
            const box = boxes[0];
            box.value = '  프로젝트 문서  ';
            title.resolve('Example Home');
            await flushAsyncWork();

            assert.strictEqual(box.value, '  프로젝트 문서  ');
            assert.strictEqual(box.busy, false);
            box.accept();
            assert.strictEqual(await result, '프로젝트 문서');
        });

        test('사용자가 기본 제목으로 다시 고쳐도 자동 제목으로 바꾸지 않는다', async () => {
            const title = deferred<string | undefined>();
            const result = promptLinkTitle('https://example.com', 'example.com', () => title.promise);
            const box = boxes[0];
            box.value = '다른 이름';
            box.value = 'example.com';
            title.resolve('Example Home');
            await flushAsyncWork();

            assert.strictEqual(box.value, 'example.com');
            box.accept();
            assert.strictEqual(await result, 'example.com');
        });

        test('제목 조회 전에 Enter를 누르면 바로 확정하고 요청을 취소한다', async () => {
            const title = deferred<string | undefined>();
            let requestSignal: AbortSignal | undefined;
            const result = promptLinkTitle('https://example.com', 'example.com', (_url, signal) => {
                requestSignal = signal;
                return title.promise;
            });
            await flushAsyncWork();
            const box = boxes[0];
            box.accept();

            assert.strictEqual(await result, 'example.com');
            assert.strictEqual(requestSignal?.aborted, true);
            assert.strictEqual(box.disposed, true);
            title.resolve('Late Title');
            await flushAsyncWork();
            assert.strictEqual(box.value, 'example.com', '닫힌 입력창에 늦은 결과를 반영하면 안 된다');
        });

        test('입력창을 즉시 확정하거나 닫으면 예약된 제목 조회를 시작하지 않는다', async () => {
            for (const accept of [true, false]) {
                let requests = 0;
                const result = promptLinkTitle('https://example.com', 'example.com', async () => {
                    requests++;
                    return 'Unexpected title';
                });
                const box = boxes.at(-1)!;
                if (accept) {
                    box.accept();
                } else {
                    box.hide();
                }

                assert.strictEqual(await result, accept ? 'example.com' : undefined);
                await flushAsyncWork();
                assert.strictEqual(requests, 0, '이미 완료된 입력을 위해 네트워크 요청을 시작하면 안 된다');
                assert.strictEqual(box.disposed, true);
                assert.strictEqual(box.value, 'example.com');
            }
        });

        test('Escape는 등록을 취소하고 늦은 조회 결과를 무시한다', async () => {
            const title = deferred<string | undefined>();
            let requestSignal: AbortSignal | undefined;
            const result = promptLinkTitle('https://example.com', 'example.com', (_url, signal) => {
                requestSignal = signal;
                return title.promise;
            });
            await flushAsyncWork();
            const box = boxes[0];
            box.hide();

            assert.strictEqual(await result, undefined);
            assert.strictEqual(requestSignal?.aborted, true);
            assert.strictEqual(box.disposed, true);
            title.resolve('Late Title');
            await flushAsyncWork();
            assert.strictEqual(box.value, 'example.com');
        });

        test('빈 제목은 확정하지 않고 고친 제목으로 계속 등록할 수 있다', async () => {
            const result = promptLinkTitle('https://example.com', 'example.com', async () => undefined);
            await flushAsyncWork();
            const box = boxes[0];
            box.value = '   ';
            box.accept();

            assert.ok(box.validationMessage, '공백 제목에는 검증 메시지를 표시해야 한다');
            assert.strictEqual(box.disposed, false);
            box.value = '수정한 제목';
            assert.ok(!box.validationMessage, '제목을 고치면 이전 검증 메시지를 지워야 한다');
            box.accept();
            assert.strictEqual(await result, '수정한 제목');
        });

        test('제목이 없으면 기본 제목을 유지하고 조회 표시를 끝낸다', async () => {
            const result = promptLinkTitle('https://example.com', 'example.com', async () => undefined);
            await flushAsyncWork();
            const box = boxes[0];

            assert.strictEqual(box.value, 'example.com');
            assert.strictEqual(box.busy, false);
            box.accept();
            assert.strictEqual(await result, 'example.com');
        });

        test('제목 조회 예외가 발생해도 기본 제목으로 등록할 수 있다', async () => {
            const result = promptLinkTitle('https://example.com', 'example.com', async () => {
                throw new Error('Metadata request failed');
            });
            await flushAsyncWork();
            const box = boxes[0];

            assert.strictEqual(box.value, 'example.com');
            assert.strictEqual(box.busy, false);
            box.accept();
            assert.strictEqual(await result, 'example.com');
        });
    });
});
