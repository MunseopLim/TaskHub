import * as assert from 'assert';
import { once } from 'node:events';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import { fetchLinkTitle } from '../linkTitle';

suite('링크 제목 조회', () => {
    let server: http.Server;
    let origin: string;
    let requests: string[];
    let sockets: Set<Socket>;
    let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void;

    setup(async () => {
        requests = [];
        sockets = new Set();
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<title>기본 제목</title>');
        };
        server = http.createServer((request, response) => {
            requests.push(request.url ?? '');
            handler(request, response);
        });
        server.on('connection', socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        origin = `http://127.0.0.1:${address.port}`;
    });

    teardown(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    });

    function serveHtml(html: string, contentType = 'text/html; charset=utf-8'): void {
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': contentType });
            response.end(html);
        };
    }

    test('한국어·entity·줄바꿈을 한 줄 제목으로 정리하고 URL query를 보존한다', async () => {
        serveHtml('<html><head><TITLE>\n 안내 &amp; &#x1f680; &#54620; &quot;문서&quot;&nbsp; — \t 다음\u202e </TITLE></head></html>');

        assert.strictEqual(await fetchLinkTitle(`${origin}/docs?q=a%26b#summary`), '안내 & 🚀 한 "문서" — 다음');
        assert.deepStrictEqual(requests, ['/docs?q=a%26b']);
    });

    test('주석과 script·style 속 예시 title을 제목으로 쓰지 않는다', async () => {
        serveHtml('<!-- <title>주석</title> --><script>const s = "<title>스크립트</title>";</script>'
            + '<style>/* <title>스타일</title> */</style><title>실제 제목</title>');

        assert.strictEqual(await fetchLinkTitle(origin), '실제 제목');
    });

    test('알 수 없는 entity를 객체 프로퍼티로 해석하지 않는다', async () => {
        serveHtml('<title>&constructor; &toString; &unknown;</title>');
        assert.strictEqual(await fetchLinkTitle(origin), '&constructor; &toString; &unknown;');
    });

    test('끝나지 않는 title 태그가 반복되어도 정상적으로 폴백한다', async () => {
        serveHtml('<title>'.repeat(30000));
        assert.strictEqual(await fetchLinkTitle(origin), undefined);
        serveHtml('<title'.repeat(30000));
        assert.strictEqual(await fetchLinkTitle(origin), undefined);
    });

    test('숫자 entity의 잘못된 코드포인트는 실패 없이 대체하고 길이를 제한한다', async () => {
        serveHtml('<title>&#x110000;&#0;&#xD800;' + '🚀'.repeat(250) + '</title>');
        const title = await fetchLinkTitle(origin);

        assert.ok(title);
        assert.ok(title.startsWith('\ufffd\ufffd\ufffd'));
        assert.strictEqual(Array.from(title).length, 200);
        assert.ok(title.endsWith('🚀'));
    });

    test('응답 헤더의 charset으로 제목을 디코딩한다', async () => {
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset="windows-1252"' });
            response.end(Buffer.from('<title>Caf\xe9</title>', 'latin1'));
        };

        assert.strictEqual(await fetchLinkTitle(origin), 'Café');
    });

    test('BOM·HTTP 헤더·meta 순서로 인코딩을 선택해 비UTF-8 페이지의 제목을 보존한다', async () => {
        const legacyHtml = '<meta charset="windows-1252"><title>Caf\xe9</title>';
        const utf16Html = '<meta charset="windows-1252"><title>한글 🚀</title>';
        const utf16le = Buffer.from(utf16Html, 'utf16le');
        for (const [body, contentType, expected] of [
            [Buffer.from(legacyHtml, 'latin1'), 'text/html', 'Café'],
            [Buffer.from('<meta charset="utf-8"><title>Caf\xe9</title>', 'latin1'), 'text/html; charset=windows-1252', 'Café'],
            [Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]), 'text/html; charset=windows-1252', '한글 🚀'],
            [Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16le).swap16()]), 'text/html; charset=utf-8', '한글 🚀'],
        ] as const) {
            handler = (_request, response) => {
                response.writeHead(200, { 'Content-Type': contentType });
                response.end(body);
            };

            assert.strictEqual(await fetchLinkTitle(origin), expected, `${contentType}: ${body.subarray(0, 2).toString('hex')}`);
        }
    });

    test('제목 누락·빈 제목·불완전한 title·알 수 없는 charset은 폴백한다', async () => {
        for (const html of ['<html>no title</html>', '<title> \n &nbsp; </title>', '<title>unfinished']) {
            serveHtml(html);
            assert.strictEqual(await fetchLinkTitle(origin), undefined, html);
        }
        serveHtml('<title>Title</title>', 'text/html; charset=unknown-encoding');
        assert.strictEqual(await fetchLinkTitle(origin), undefined);
    });

    test('HTTP(S) 외 주소·잘못된 URL·credentials·미리 취소된 요청은 조회하지 않는다', async () => {
        const controller = new AbortController();
        controller.abort();
        for (const url of ['', 'https://', 'file:///tmp/index.html', 'mailto:a@example.com', origin.replace('http://', 'http://user:secret@')]) {
            assert.strictEqual(await fetchLinkTitle(url), undefined, url);
        }
        assert.strictEqual(await fetchLinkTitle(origin, controller.signal), undefined);
        assert.deepStrictEqual(requests, []);
    });

    test('세 번의 상대 redirect는 따르며 쿠키와 인증 정보를 전달하지 않는다', async () => {
        handler = (request, response) => {
            assert.strictEqual(request.headers.cookie, undefined);
            assert.strictEqual(request.headers.authorization, undefined);
            const count = Number(request.url?.slice(1));
            if (count > 0) {
                response.writeHead(302, { Location: `/${count - 1}`, 'Set-Cookie': 'session=secret' });
                response.end();
            } else {
                response.writeHead(200, { 'Content-Type': 'text/html' });
                response.end('<title>마지막 페이지</title>');
            }
        };

        assert.strictEqual(await fetchLinkTitle(`${origin}/3`), '마지막 페이지');
        assert.deepStrictEqual(requests, ['/3', '/2', '/1', '/0']);
        requests = [];
        assert.strictEqual(await fetchLinkTitle(`${origin}/4`), undefined);
        assert.deepStrictEqual(requests, ['/4', '/3', '/2', '/1']);
    });

    test('잘못된 redirect·credentials가 붙은 redirect는 추가 요청 없이 폴백한다', async () => {
        for (const location of ['file:///tmp/page.html', `${origin.replace('http://', 'http://user:secret@')}/private`, 'https://']) {
            handler = (_request, response) => {
                response.writeHead(302, { Location: location });
                response.end();
            };
            requests = [];
            assert.strictEqual(await fetchLinkTitle(origin), undefined, location);
            assert.deepStrictEqual(requests, ['/']);
        }
    });

    test('오류 HTTP 상태·비HTML·압축 응답은 제목처럼 보이는 내용도 쓰지 않는다', async () => {
        for (const [status, contentType, encoding] of [
            [401, 'text/html', 'identity'],
            [500, 'text/html', 'identity'],
            [200, 'application/json', 'identity'],
            [200, 'text/plain', 'identity'],
            [200, 'text/html', 'gzip'],
        ] as const) {
            handler = (_request, response) => {
                response.writeHead(status, { 'Content-Type': contentType, 'Content-Encoding': encoding });
                response.end('<title>Title</title>');
            };
            assert.strictEqual(await fetchLinkTitle(origin), undefined);
        }
    });

    test('256 KiB 경계는 허용하고 한도를 넘어서야 나타나는 제목은 조회하지 않는다', async () => {
        const title = '<title>Boundary</title>';
        serveHtml(' '.repeat(256 * 1024 - Buffer.byteLength(title)) + title);
        assert.strictEqual(await fetchLinkTitle(origin), 'Boundary');

        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html', 'Transfer-Encoding': 'chunked' });
            response.end(' '.repeat(256 * 1024) + title);
        };
        assert.strictEqual(await fetchLinkTitle(origin), undefined);
    });

    test('큰 문서도 제목이 먼저 완성되면 나머지 본문을 기다리지 않는다', async () => {
        let responseClosed: Promise<unknown> | undefined;
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': 1024 * 1024 });
            responseClosed = once(response, 'close');
            response.write('<html><title>일찍 찾은 제목</title>');
        };

        assert.strictEqual(await fetchLinkTitle(origin), '일찍 찾은 제목');
        await responseClosed;
    });

    test('완성된 제목 뒤에 UTF-8 문자가 일부만 도착해도 제목을 반환한다', async () => {
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.write(Buffer.concat([Buffer.from('<title>완성된 제목</title>'), Buffer.from([0xed, 0x95])]));
        };

        assert.strictEqual(await fetchLinkTitle(origin), '완성된 제목');
    });

    test('응답 대기 중 취소하면 Promise와 서버 연결이 함께 종료된다', async () => {
        const controller = new AbortController();
        let responseClosed: Promise<unknown> | undefined;
        let requestArrived!: () => void;
        const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
        handler = (_request, response) => {
            responseClosed = once(response, 'close');
            requestArrived();
        };

        const pending = fetchLinkTitle(origin, controller.signal);
        await arrived;
        controller.abort();

        assert.strictEqual(await pending, undefined);
        await responseClosed;
    });

    test('중간에 끊긴 응답과 연결 실패는 오류를 던지지 않는다', async () => {
        handler = (request, _response) => request.socket.destroy();
        assert.strictEqual(await fetchLinkTitle(origin), undefined);

        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.write('<title>unfinished');
            setImmediate(() => response.destroy());
        };
        assert.strictEqual(await fetchLinkTitle(origin), undefined);
    });

    test('본문이 계속 들어와도 총 2초 deadline에 연결을 닫는다', async function () {
        this.timeout(7000);
        let responseClosed: Promise<unknown> | undefined;
        handler = (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html' });
            response.write('<html>');
            const interval = setInterval(() => response.write(' '), 20);
            response.on('close', () => clearInterval(interval));
            responseClosed = once(response, 'close');
        };
        const started = Date.now();

        assert.strictEqual(await fetchLinkTitle(origin), undefined);
        assert.ok(Date.now() - started >= 1800);
        await responseClosed;
    });
});
