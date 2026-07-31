import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 웹뷰 ↔ 호스트 **메시지 계약** 검사.
 *
 * 0.6.52 리뷰에서 `hexViewer` 의 `copySelection` 핸들러가 **보내는 쪽 없이**
 * 살아 있는 것이 드러났다. `git log --all -S "command: 'copySelection'"` 이
 * 아무 커밋도 내놓지 않는다 — 0.2.47 에서 핸들러만 추가되고 발신은 한 번도
 * 존재한 적이 없었다. 5년 가까이 아무 테스트도 그것을 몰랐다.
 *
 * 두 방향 모두 위험하다:
 *  - **고아 핸들러**: 죽은 코드가 권한(클립보드 쓰기 등)을 열어 둔 채 남고,
 *    읽는 사람은 그 기능이 동작한다고 믿는다.
 *  - **고아 발신**: 웹뷰가 보내는데 호스트가 처리하지 않으면 **버튼이 아무
 *    동작도 하지 않는다.** 화면에 오류도 남지 않아 조용히 깨진다.
 *
 * 정적 분석이다 — 웹뷰 스크립트는 호스트 파일 안의 문자열이라 실행할 수 없고,
 * 실행하지 않아도 두 집합을 뽑을 수 있다. `docConsistency.test.ts` 와 같은
 * 방식(pure node file IO)이라 vscode API 없이 돌고 빠르다.
 *
 * 새 웹뷰를 추가하면 아래 `WEBVIEWS` 에 등록한다.
 */

// 테스트는 out/test/*.test.js 로 컴파일되므로 저장소 루트는 두 단계 위다.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface WebviewSource {
    /** 리포지터리 상대 경로. */
    file: string;
    /** `onDidReceiveMessage` 콜백을 찾기 위한 앵커. */
    handlerAnchor: string;
}

const WEBVIEWS: WebviewSource[] = [
    { file: 'src/hexViewer.ts', handlerAnchor: 'onDidReceiveMessage' },
    { file: 'src/jsonEditor.ts', handlerAnchor: 'onDidReceiveMessage' },
    { file: 'src/memoryMapViewer.ts', handlerAnchor: 'onDidReceiveMessage' },
];

function readRepoFile(relPath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
}

/**
 * `onDidReceiveMessage(` 뒤의 **콜백 본문만** 잘라낸다.
 *
 * 파일 전체에서 `case 'x':` 를 긁으면 무관한 switch 까지 걸린다 — 실제로
 * `memoryMapViewer` 에는 컬럼 이름(`case 'addr':`)을, `hexViewer` 에는 키
 * 이름(`case 'ArrowDown':`)을 다루는 switch 가 따로 있다. 괄호 짝을 세어
 * 콜백 범위를 정확히 잡는다.
 */
function extractHandlerBody(source: string, anchor: string): string {
    const anchorAt = source.indexOf(anchor);
    assert.notStrictEqual(anchorAt, -1, `핸들러 앵커 '${anchor}' 를 찾지 못했다`);
    const open = source.indexOf('(', anchorAt);
    assert.notStrictEqual(open, -1, `'${anchor}' 뒤에 여는 괄호가 없다`);

    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === '(') { depth++; }
        else if (ch === ')') {
            depth--;
            if (depth === 0) { return source.slice(open, i + 1); }
        }
    }
    assert.fail(`'${anchor}' 의 콜백 범위를 닫지 못했다`);
}

/** 웹뷰 스크립트가 호스트로 보내는 command 이름. */
function sentCommands(source: string): Set<string> {
    const found = new Set<string>();
    // 웹뷰 안에서는 `vscode` 가 acquireVsCodeApi() 핸들이다. 호스트 쪽
    // `webview.postMessage` 는 반대 방향이므로 잡히지 않아야 한다.
    for (const m of source.matchAll(/vscode\.postMessage\(\s*\{\s*command:\s*'([A-Za-z][A-Za-z0-9]*)'/g)) {
        found.add(m[1]);
    }
    return found;
}

/** 호스트가 처리하는 command 이름 (`===` 비교와 `switch` 두 형태 모두). */
function handledCommands(handlerBody: string): Set<string> {
    const found = new Set<string>();
    for (const m of handlerBody.matchAll(/message\.command\s*===\s*'([A-Za-z][A-Za-z0-9]*)'/g)) {
        found.add(m[1]);
    }
    for (const m of handlerBody.matchAll(/case\s*'([A-Za-z][A-Za-z0-9]*)'\s*:/g)) {
        found.add(m[1]);
    }
    return found;
}

suite('웹뷰 ↔ 호스트 메시지 계약', () => {

    for (const webview of WEBVIEWS) {
        suite(webview.file, () => {
            const source = readRepoFile(webview.file);
            const body = extractHandlerBody(source, webview.handlerAnchor);
            const sent = sentCommands(source);
            const handled = handledCommands(body);

            test('추출 자체가 성립한다 (정규식이 조용히 빈 집합을 내지 않는다)', () => {
                // 이 검사가 없으면 정규식이 깨졌을 때 두 집합이 모두 비어
                // 아래 두 테스트가 **통과해 버린다** — 계약을 검사하지 않으면서
                // 검사한 척하는 상태가 가장 나쁘다.
                assert.ok(sent.size > 0, `웹뷰가 보내는 command 를 하나도 찾지 못했다 (정규식이 깨졌을 수 있다)`);
                assert.ok(handled.size > 0, `호스트가 처리하는 command 를 하나도 찾지 못했다`);
            });

            test('호스트가 처리하는 command 는 모두 웹뷰가 실제로 보낸다 (고아 핸들러 금지)', () => {
                const orphaned = Array.from(handled).filter(cmd => !sent.has(cmd)).sort();
                assert.deepStrictEqual(
                    orphaned, [],
                    `보내는 쪽이 없는 핸들러: ${orphaned.join(', ')}. ` +
                    `죽은 분기는 지우거나, 실제로 보내도록 연결하세요 — ` +
                    `hexViewer 의 'copySelection' 이 이 상태로 0.2.47부터 남아 있었습니다.`
                );
            });

            test('웹뷰가 보내는 command 는 모두 호스트가 처리한다 (조용히 죽은 버튼 금지)', () => {
                const unhandled = Array.from(sent).filter(cmd => !handled.has(cmd)).sort();
                assert.deepStrictEqual(
                    unhandled, [],
                    `호스트가 처리하지 않는 발신: ${unhandled.join(', ')}. ` +
                    `이 경로의 UI 컨트롤은 눌러도 아무 일도 일어나지 않고 오류도 남지 않습니다.`
                );
            });
        });
    }

    test('알려진 웹뷰를 빠짐없이 검사한다', () => {
        // 새 웹뷰가 생겼는데 WEBVIEWS 에 등록하지 않으면 이 스위트가 조용히
        // 그것을 건너뛴다. `onDidReceiveMessage` 를 가진 src 파일과 대조한다.
        const srcDir = path.join(REPO_ROOT, 'src');
        const withHandlers = fs.readdirSync(srcDir)
            .filter(name => name.endsWith('.ts'))
            .filter(name => readRepoFile(path.join('src', name)).includes('onDidReceiveMessage'))
            .map(name => `src/${name}`)
            .sort();
        assert.deepStrictEqual(
            withHandlers,
            WEBVIEWS.map(w => w.file).sort(),
            'onDidReceiveMessage 를 가진 파일이 WEBVIEWS 목록과 다르다 — 새 웹뷰를 등록하세요'
        );
    });
});
