import * as assert from 'assert';
import * as vm from 'vm';
import * as vscode from 'vscode';
import {
    buildHexConverterHtml,
    buildHexConverterStrings,
    HexConverterSavedValue,
    HexConverterPreferences,
    hexConverterPanelRegistry,
    normalizeHexConverterSavedValues,
    showHexConverter,
} from '../hexConverter';

function withLanguage<T>(language: string, body: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.env, 'language');
    assert.ok(descriptor && (descriptor.configurable || typeof descriptor.set === 'function'));
    Object.defineProperty(vscode.env, 'language', { value: language, configurable: true });
    try {
        return body();
    } finally {
        Object.defineProperty(vscode.env, 'language', descriptor);
    }
}

class FakeWebviewElement {
    value = '';
    textContent = '';
    innerHTML = '';
    disabled = false;
    focused = false;
    hidden = false;
    placeholder = '';
    scrollTop = 0;
    selectionStart = 0;
    selectionEnd = 0;
    dataset: Record<string, string> = {};
    readonly classes = new Set<string>();
    readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly classList = {
        toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
    };
    addEventListener(type: string, listener: (event: any) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }
    dispatch(type: string, event: any = {}): void {
        for (const listener of this.listeners.get(type) ?? []) { listener(event); }
    }
    focus(): void { this.focused = true; }
    setSelectionRange(start: number, end: number): void {
        this.selectionStart = start;
        this.selectionEnd = end;
    }
    closest(selector: string): FakeWebviewElement | null {
        return selector === 'button[data-action]' ? this : null;
    }
}

function runHexConverterWebview(options: {
    restoredState?: unknown;
    savedValues?: readonly HexConverterSavedValue[];
    preferences?: HexConverterPreferences;
} = {}) {
    const ids = [
        'textInput', 'hexInput', 'encoding', 'hexGroup', 'bytesPerRow', 'endian', 'textCount', 'hexCount',
        'copyText', 'copyHex', 'saveText', 'saveHex', 'clearButton', 'status',
        'statusText', 'valueGrid', 'hexOffsets', 'hexGroupWarning', 'hexGroupMessage',
        'hexGroupPreviewLabel', 'hexGroupPresent', 'hexGroupMissing', 'savedList', 'savedCount',
    ];
    const elements = Object.fromEntries(ids.map(id => [id, new FakeWebviewElement()])) as Record<string, FakeWebviewElement>;
    elements.encoding.value = 'utf8';
    elements.hexGroup.value = '1';
    elements.bytesPerRow.value = '16';
    elements.endian.value = 'little';
    const posted: any[] = [];
    let persisted: any;
    let nextTimerId = 1;
    const timers = new Map<number, () => void>();
    const windowListeners = new Map<string, Array<(event: any) => void>>();
    const html = buildHexConverterHtml(undefined, options.savedValues ?? [], options.preferences);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.ok(script.length > 0);
    const sandbox = {
        acquireVsCodeApi: () => ({
            getState: () => options.restoredState,
            setState: (value: any) => { persisted = value; },
            postMessage: (message: any) => { posted.push(message); },
        }),
        document: {
            documentElement: { lang: 'ko' },
            getElementById: (id: string) => elements[id],
        },
        window: {
            addEventListener: (type: string, listener: (event: any) => void) => {
                const list = windowListeners.get(type) ?? [];
                list.push(listener);
                windowListeners.set(type, list);
            },
        },
        setTimeout: (callback: () => void) => {
            const id = nextTimerId++;
            timers.set(id, callback);
            return id;
        },
        clearTimeout: (id: number) => { timers.delete(id); },
        Element: FakeWebviewElement,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        DataView,
        Intl,
        Date,
    };
    vm.runInNewContext(script, sandbox);
    return {
        elements,
        posted,
        html,
        persisted: () => persisted,
        pendingTimerCount: () => timers.size,
        flushTimers(): void {
            while (timers.size > 0) {
                const callbacks = Array.from(timers.values());
                timers.clear();
                for (const callback of callbacks) { callback(); }
            }
        },
        dispatchWindowMessage(message: unknown): void {
            for (const listener of windowListeners.get('message') ?? []) { listener({ data: message }); }
        },
    };
}

suite('Hex/Text 변환기 Webview', () => {
    test('Command Palette 명령이 실제 extension host에 등록된다', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('taskhub.showHexConverter'));
    });

    test('인라인 스크립트가 문법적으로 유효하다', () => {
        const html = buildHexConverterHtml();
        const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
        assert.ok(match, '실행 스크립트를 찾지 못했다');
        assert.doesNotThrow(() => new Function(match![1]));
    });

    test('두 입력은 input 이벤트에서 즉시 반대 방향 변환을 실행한다', () => {
        const html = buildHexConverterHtml();
        assert.match(html, /textInput\.addEventListener\('input', \(\) => scheduleConversion\('text'\)\)/);
        assert.match(html, /hexInput\.addEventListener\('input', \(\) => scheduleConversion\('hex'\)\)/);
        assert.ok(!/<button[^>]*>[^<]*(변환|Convert)[^<]*<\/button>/i.test(html), '별도 변환 버튼이 남아 있다');
    });

    test('실제 Webview 스크립트에서 입력·역변환·오류·저장이 즉시 동작한다', () => {
        const saved = [{
            id: 'saved-1', kind: 'text' as const, value: 'OK', encoding: 'utf8' as const,
            endian: 'big' as const, byteCount: 2, savedAt: Date.now(),
        }];
        const harness = runHexConverterWebview({ savedValues: saved });
        const { elements, posted } = harness;

        elements.textInput.value = 'Hi';
        elements.textInput.dispatch('input');
        assert.strictEqual(elements.hexInput.value, '48 69');
        assert.match(elements.statusText.textContent, /2/);
        assert.strictEqual(harness.persisted().source, 'text');

        elements.hexInput.value = 'EC 95 88';
        elements.hexInput.dispatch('input');
        assert.strictEqual(elements.textInput.value, '안');
        assert.match(elements.textCount.textContent, /1/);
        assert.strictEqual(harness.persisted().source, 'hex');

        elements.hexInput.value = 'GG';
        elements.hexInput.dispatch('input');
        assert.ok(elements.status.classes.has('is-error'));
        assert.strictEqual(elements.textInput.value, '');

        const loadButton = new FakeWebviewElement();
        loadButton.dataset.action = 'load';
        loadButton.dataset.id = 'saved-1';
        elements.savedList.dispatch('click', { target: loadButton });
        assert.strictEqual(elements.textInput.value, 'OK');
        assert.strictEqual(elements.hexInput.value, '4F 4B');
        assert.strictEqual(elements.endian.value, 'big');
        assert.ok(elements.textInput.focused);

        elements.saveText.dispatch('click');
        assert.strictEqual(JSON.stringify(posted.at(-1)), JSON.stringify({
            command: 'saveValue', kind: 'text', value: 'OK', encoding: 'utf8', endian: 'big',
        }));
        harness.dispatchWindowMessage({ command: 'saveResult', ok: false, reason: 'too-large' });
        assert.match(elements.statusText.textContent, /16\s?KB/i);
    });

    test('큰 입력은 키 입력을 막지 않고 마지막 이벤트 하나로 합쳐 변환한다', () => {
        const harness = runHexConverterWebview();
        const { elements } = harness;
        elements.textInput.value = 'A'.repeat(70 * 1024);
        elements.textInput.dispatch('input');

        assert.strictEqual(elements.hexInput.value, '', '지연 중 이전 결과를 최신 결과처럼 남기면 안 된다');
        assert.strictEqual(harness.pendingTimerCount(), 1);
        assert.strictEqual(elements.saveText.disabled, true);

        elements.textInput.value += 'B';
        elements.textInput.dispatch('input');
        assert.strictEqual(harness.pendingTimerCount(), 1, '연속 입력이 변환 timer를 누적하면 안 된다');

        harness.flushTimers();
        assert.strictEqual(harness.pendingTimerCount(), 0);
        assert.ok(elements.hexInput.value.startsWith('41 41'));
        assert.ok(elements.hexInput.value.endsWith('42'));
        assert.match(elements.hexCount.textContent, /71681/);
    });

    test('큰 Hex 입력은 오프셋 계산도 변환 완료까지 미룬다', () => {
        const harness = runHexConverterWebview();
        const { elements } = harness;
        elements.hexInput.value = '41'.repeat(40 * 1024) + '\n42';
        elements.hexInput.dispatch('input');
        assert.strictEqual(harness.pendingTimerCount(), 1);
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n—');
        elements.bytesPerRow.value = '8';
        elements.bytesPerRow.dispatch('change');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n—');
        harness.flushTimers();
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x0000A000');
        assert.strictEqual(elements.textInput.value, 'A'.repeat(40 * 1024) + 'B');
    });

    test('Hex 연속 입력·중간 수정·구분자 삭제는 입력 원문과 커서를 유지한다', () => {
        const { elements } = runHexConverterWebview();
        const input = elements.hexInput;
        const insert = (text: string) => {
            const start = input.selectionStart;
            input.value = input.value.slice(0, start) + text + input.value.slice(input.selectionEnd);
            input.setSelectionRange(start + text.length, start + text.length);
            input.dispatch('input');
        };
        for (const character of '4865') { insert(character); }
        assert.strictEqual(input.value, '4865');
        assert.strictEqual(input.selectionStart, 4);
        assert.strictEqual(elements.textInput.value, 'He');
        input.setSelectionRange(2, 4);
        insert('69');
        assert.strictEqual(elements.textInput.value, 'Hi');
        assert.strictEqual(input.selectionStart, 4);
        input.dispatch('blur');
        assert.strictEqual(input.value, '48 69');
        input.setSelectionRange(2, 3);
        insert('');
        assert.strictEqual(input.value, '4869', '구분자를 지워도 즉시 다시 삽입하지 않는다');
        assert.strictEqual(input.selectionStart, 2);
        assert.strictEqual(elements.textInput.value, 'Hi');
    });

    test('0x 접두사와 구분자는 미완성 입력에서도 지워지지 않는다', () => {
        const { elements } = runHexConverterWebview();
        for (const value of ['0', '0x', '0x4', '0x48', '0x48, 0x', '0x48, 0x65']) {
            elements.hexInput.value = value;
            elements.hexInput.setSelectionRange(value.length, value.length);
            elements.hexInput.dispatch('input');
            assert.strictEqual(elements.hexInput.value, value);
            assert.strictEqual(elements.hexInput.selectionStart, value.length);
        }
        assert.strictEqual(elements.textInput.value, 'He');
        elements.hexInput.dispatch('blur');
        assert.strictEqual(elements.hexInput.value, '48 65');
    });

    test('표시 단위·행 크기·Endian 변경은 UTF-8 및 ASCII 디코딩 오류를 유지한다', () => {
        for (const encoding of ['utf8', 'ascii']) {
            const { elements } = runHexConverterWebview();
            elements.encoding.value = encoding;
            elements.hexInput.value = 'FF';
            elements.hexInput.dispatch('input');
            const message = elements.statusText.textContent;
            assert.ok(elements.status.classes.has('is-error'));
            for (const [id, value] of [['hexGroup', '2'], ['bytesPerRow', '8'], ['endian', 'big']]) {
                elements[id].value = value;
                elements[id].dispatch('change');
                assert.ok(elements.status.classes.has('is-error'), id);
                assert.strictEqual(elements.statusText.textContent, message, id);
                assert.strictEqual(elements.textInput.value, '');
                assert.strictEqual(elements.copyText.disabled, true);
            }
        }
    });

    test('Hex 표시를 1·2·4바이트로 즉시 다시 묶고 바이트 순서는 유지한다', () => {
        const harness = runHexConverterWebview();
        const { elements } = harness;
        elements.textInput.value = 'Hello';
        elements.textInput.dispatch('input');
        assert.strictEqual(elements.hexInput.value, '48 65 6C 6C 6F');

        elements.hexGroup.value = '2';
        elements.hexGroup.dispatch('change');
        assert.strictEqual(elements.hexInput.value, '4865 6C6C 6F');
        assert.strictEqual(elements.hexInput.placeholder, '4865 6C6C 6F');
        assert.strictEqual(harness.persisted().hexGroup, 2);

        elements.endian.value = 'big';
        elements.endian.dispatch('change');
        assert.strictEqual(elements.hexInput.value, '4865 6C6C 6F', 'Endian이 원본 Hex 바이트를 재정렬하면 안 된다');

        elements.hexGroup.value = '4';
        elements.hexGroup.dispatch('change');
        assert.strictEqual(elements.hexInput.value, '48656C6C 6F');
        assert.strictEqual(elements.hexInput.placeholder, '48656C6C 6F');

        elements.hexInput.value = '0x41, 0x42, 0x43';
        elements.hexInput.dispatch('input');
        elements.hexInput.dispatch('blur');
        assert.strictEqual(elements.hexInput.value, '414243');
        assert.strictEqual(elements.textInput.value, 'ABC');
    });

    test('2·4바이트의 마지막 그룹이 덜 차면 실제 값을 패딩하지 않고 warning으로 표시한다', () => {
        const harness = withLanguage('ko', () => runHexConverterWebview());
        const { elements } = harness;
        elements.hexGroup.value = '4';
        elements.hexGroup.dispatch('change');
        elements.textInput.value = 'o';
        elements.textInput.dispatch('input');

        assert.strictEqual(elements.hexInput.value, '6F', '표시용 0이 실제 Hex 값에 들어가면 안 된다');
        assert.strictEqual(elements.textInput.value, 'o', '표시용 패딩이 Text에 NUL을 추가하면 안 된다');
        assert.strictEqual(elements.hexGroupWarning.hidden, false);
        assert.strictEqual(elements.hexGroupPreviewLabel.textContent, '미리보기:');
        assert.strictEqual(elements.hexGroupPresent.textContent, '6F');
        assert.strictEqual(elements.hexGroupMissing.textContent, '·· ·· ··');
        assert.ok(!harness.html.includes('hexGroupWarning.innerHTML'), '동적 warning을 innerHTML로 조립하면 안 된다');
        assert.match(elements.statusText.textContent, /1\/4/);
        assert.match(elements.statusText.textContent, /3/);

        elements.hexGroup.value = '2';
        elements.hexGroup.dispatch('change');
        assert.strictEqual(elements.hexGroupMissing.textContent, '··');
        assert.match(elements.statusText.textContent, /1\/2/);

        elements.hexGroup.value = '1';
        elements.hexGroup.dispatch('change');
        assert.strictEqual(elements.hexGroupWarning.hidden, true);
        assert.doesNotMatch(elements.statusText.textContent, /1\/1/);

        elements.hexGroup.value = '4';
        elements.hexGroup.dispatch('change');
        elements.textInput.value = 'ABCD';
        elements.textInput.dispatch('input');
        assert.strictEqual(elements.hexGroupWarning.hidden, true, '완성된 그룹에 warning을 남기면 안 된다');
        assert.strictEqual(elements.hexGroupPresent.textContent, '');
        assert.strictEqual(elements.hexGroupMissing.textContent, '');
    });

    test('영어 미완성 그룹 안내는 1 bytes 복수형을 만들지 않는다', () => {
        const harness = withLanguage('en', () => runHexConverterWebview());
        const { elements } = harness;
        elements.hexGroup.value = '2';
        elements.hexGroup.dispatch('change');
        elements.textInput.value = 'A';
        elements.textInput.dispatch('input');

        assert.strictEqual(elements.hexGroupMessage.textContent, 'Last group 1/2 bytes · missing 1');
        assert.strictEqual(elements.hexGroupPreviewLabel.textContent, 'Preview:');
        assert.doesNotMatch(elements.hexGroupMessage.textContent, /1 bytes/);

        elements.hexGroup.value = '4';
        elements.hexGroup.dispatch('change');
        elements.textInput.value = 'ABC';
        elements.textInput.dispatch('input');
        assert.strictEqual(elements.hexGroupMessage.textContent, 'Last group 3/4 bytes · missing 1');
        assert.doesNotMatch(elements.hexGroupMessage.textContent, /1 bytes/);
    });

    test('한 줄 바이트 수에 맞춰 Hex 행과 0 기반 Offset을 표시하고 함께 스크롤한다', () => {
        const harness = runHexConverterWebview();
        const { elements } = harness;
        elements.textInput.value = 'ABCDEFGHIJKLMNOPQRST';
        elements.textInput.dispatch('input');

        assert.strictEqual(elements.hexInput.value.split('\n').length, 2);
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x00000010');

        elements.bytesPerRow.value = '8';
        elements.bytesPerRow.dispatch('change');
        assert.strictEqual(elements.hexInput.value.split('\n').length, 3);
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x00000008\n0x00000010');
        assert.strictEqual(harness.persisted().bytesPerRow, 8);

        elements.hexInput.scrollTop = 48;
        elements.hexInput.dispatch('scroll');
        assert.strictEqual(elements.hexOffsets.scrollTop, 48);

        elements.hexInput.value = elements.hexInput.value.slice(0, -1);
        elements.hexInput.dispatch('input');
        assert.strictEqual(elements.hexInput.value.split('\n').length, 3);
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x00000008\n0x00000010',
            '홀수 자릿수 편집 중 gutter가 한 줄로 접히면 안 된다');

        elements.hexInput.value = '41 42 GG\n43 44\n45 46';
        elements.hexInput.dispatch('input');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n—\n—',
            '잘못된 행 뒤의 오프셋은 계산할 수 없음을 표시해야 한다');
    });

    test('직접 입력한 행의 실제 바이트 오프셋을 표시하고 blur 정렬과 함께 갱신한다', () => {
        const { elements } = runHexConverterWebview();
        elements.hexInput.value = '48\n65';
        elements.hexInput.dispatch('input');
        assert.strictEqual(elements.textInput.value, 'He');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x00000001');
        elements.hexInput.dispatch('blur');
        assert.strictEqual(elements.hexInput.value, '48 65');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000');

        elements.hexInput.value = '41'.repeat(20);
        elements.hexInput.dispatch('input');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000');
        elements.hexInput.dispatch('blur');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x00000010');

        elements.hexInput.value = '0x48, 0x65\n6\n6C';
        elements.hexInput.dispatch('input');
        assert.strictEqual(elements.hexOffsets.textContent, '0x00000000\n0x00000002\n—');
    });

    test('호스트에서 받은 최근 변환 옵션을 초기값으로 사용한다', () => {
        const harness = runHexConverterWebview({
            preferences: { encoding: 'ascii', hexGroup: 4, endian: 'big' },
        });
        assert.strictEqual(harness.elements.encoding.value, 'ascii');
        assert.strictEqual(harness.elements.hexGroup.value, '4');
        assert.strictEqual(harness.elements.endian.value, 'big');
        assert.strictEqual(harness.elements.hexInput.placeholder, '48656C6C 6F');
    });

    test('저장된 source·encoding·표시 단위·행 너비·endian과 입력을 실제 초기화 경로에서 복원한다', () => {
        const fromHex = runHexConverterWebview({
            restoredState: {
                source: 'hex', text: 'stale', hex: '4142', encoding: 'ascii', hexGroup: 2,
                bytesPerRow: 8, endian: 'big',
            },
        });
        assert.strictEqual(fromHex.elements.textInput.value, 'AB');
        assert.strictEqual(fromHex.elements.hexInput.value, '4142');
        assert.strictEqual(fromHex.elements.encoding.value, 'ascii');
        assert.strictEqual(fromHex.elements.hexGroup.value, '2');
        assert.strictEqual(fromHex.elements.bytesPerRow.value, '8');
        assert.strictEqual(fromHex.elements.endian.value, 'big');
        assert.strictEqual(fromHex.persisted().source, 'hex');

        const fromText = runHexConverterWebview({
            restoredState: {
                source: 'text', text: '안', hex: 'stale', encoding: 'utf8', endian: 'little',
            },
        });
        assert.strictEqual(fromText.elements.hexInput.value, 'EC 95 88');
        assert.strictEqual(fromText.persisted().source, 'text');
    });

    test('저장값 preview의 태그와 따옴표를 innerHTML에 실행 가능한 형태로 넣지 않는다', () => {
        const dangerous = '<img src=x onerror="alert(1)"> & "quoted"';
        const harness = runHexConverterWebview({
            savedValues: [{
                id: 'dangerous', kind: 'text', value: dangerous, encoding: 'utf8', endian: 'little',
                byteCount: Buffer.byteLength(dangerous), savedAt: Date.now(),
            }],
        });
        const rendered = harness.elements.savedList.innerHTML;
        assert.ok(!rendered.includes('<img'), rendered);
        assert.ok(rendered.includes('&lt;img'), rendered);
        assert.ok(rendered.includes('&quot;'), rendered);
        assert.ok(!harness.html.includes(dangerous), '초기 JSON 주입도 raw 태그를 포함하면 안 된다');
    });

    test('손상된 저장값을 버리고 유효한 항목만 24개로 제한한다', () => {
        const valid = Array.from({ length: 26 }, (_, index): HexConverterSavedValue => ({
            id: `valid-${index}`, kind: 'text', value: 'A', encoding: 'ascii', endian: 'little',
            byteCount: 1, savedAt: index,
        }));
        const normalized = normalizeHexConverterSavedValues([
            { ...valid[0], id: 'wrong-count', byteCount: 2 },
            { ...valid[0], id: 'invalid-ascii', value: '한' },
            { id: 'missing-fields' },
            ...valid,
        ]);
        assert.strictEqual(normalized.length, 24);
        assert.deepStrictEqual(normalized.map(entry => entry.id), valid.slice(0, 24).map(entry => entry.id));
    });

    test('입력·옵션 레이블, live status, 반응형 레이아웃과 상태 복원이 있다', () => {
        const html = buildHexConverterHtml();
        for (const id of ['encoding', 'hexGroup', 'bytesPerRow', 'endian', 'textInput', 'hexInput']) {
            assert.ok(html.includes(`for="${id}"`), `${id}에 연결된 label이 없다`);
            assert.ok(html.includes(`id="${id}"`), `${id} 컨트롤이 없다`);
        }
        assert.match(html, /id="hexOffsets"[^>]*aria-hidden="true"/);
        assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
        assert.ok(html.includes('@media (max-width: 720px)'), '좁은 폭 단일 열 전환이 없다');
        assert.match(html, /\.card-title\s*\{[^}]*white-space:\s*nowrap/,
            '양쪽 카드 헤더 높이를 어긋나게 하는 제목 줄바꿈을 막아야 한다');
        assert.match(html, /\.value-item:last-child::after[\s\S]*?border-top:/,
            '마지막 값 행의 빈 영역까지 이어지는 구분선이 없다');
        assert.ok(html.includes('vscode.getState()'), '입력 복원 경로가 없다');
        assert.ok(html.includes('vscode.setState({'), '입력 저장 경로가 없다');
    });

    test('문자열 번들이 비어 있지 않고 Webview의 직접 S 참조를 모두 제공한다', () => {
        const strings = buildHexConverterStrings();
        const empty = Object.entries(strings).filter(([, value]) => value.trim().length === 0);
        assert.deepStrictEqual(empty, []);
        const html = buildHexConverterHtml();
        const referenced = new Set(Array.from(html.matchAll(/\bS\.([A-Za-z][A-Za-z0-9]*)/g), match => match[1]));
        for (const key of referenced) {
            assert.ok(key in strings, `S.${key}가 문자열 번들에 없다`);
        }
        for (const key of ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'float32', 'float64']) {
            assert.ok(key in strings, `동적 값 행 S[${key}]가 문자열 번들에 없다`);
        }
    });

    suite('패널 수명주기와 복사', () => {
        let originalCreateWebviewPanel: typeof vscode.window.createWebviewPanel;
        let originalClipboardDescriptor: PropertyDescriptor | undefined;

        setup(() => {
            hexConverterPanelRegistry.clear();
            originalCreateWebviewPanel = vscode.window.createWebviewPanel;
            originalClipboardDescriptor = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard');
        });

        teardown(() => {
            hexConverterPanelRegistry.clear();
            (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
            if (originalClipboardDescriptor) {
                Object.defineProperty(vscode.env, 'clipboard', originalClipboardDescriptor);
            }
        });

        test('명령을 다시 실행하면 기존 패널을 표시하고 클립보드 결과를 돌려준다', async () => {
            let html = '';
            let revealCount = 0;
            let createCount = 0;
            let disposeHandler: (() => void) | undefined;
            let messageHandler: ((message: any) => Promise<void>) | undefined;
            const posted: any[] = [];
            const copied: string[] = [];
            const persisted = new Map<string, unknown>();
            const panel = {
                webview: {
                    cspSource: 'vscode-webview:',
                    get html() { return html; },
                    set html(value: string) { html = value; },
                    onDidReceiveMessage(handler: (message: any) => Promise<void>) {
                        messageHandler = handler;
                        return { dispose() { messageHandler = undefined; } };
                    },
                    postMessage(message: any) { posted.push(message); return Promise.resolve(true); },
                },
                reveal() { revealCount++; },
                onDidDispose(handler: () => void) {
                    disposeHandler = handler;
                    return { dispose() { disposeHandler = undefined; } };
                },
                dispose() { disposeHandler?.(); },
            } as unknown as vscode.WebviewPanel;
            (vscode.window as any).createWebviewPanel = () => { createCount++; return panel; };
            Object.defineProperty(vscode.env, 'clipboard', {
                configurable: true,
                value: { writeText: async (value: string) => { copied.push(value); } },
            });
            const subscriptions: vscode.Disposable[] = [];
            const context = {
                subscriptions,
                globalState: {
                    get(key: string, fallback: unknown) { return persisted.has(key) ? persisted.get(key) : fallback; },
                    async update(key: string, value: unknown) { persisted.set(key, value); },
                },
            } as unknown as vscode.ExtensionContext;

            showHexConverter(context);
            showHexConverter(context);

            assert.strictEqual(createCount, 1);
            assert.strictEqual(revealCount, 1);
            assert.strictEqual(subscriptions.length, 0, '닫힌 변환기 패널을 extension context에 계속 쌓으면 안 된다');
            assert.ok(hexConverterPanelRegistry.hasPanel());
            assert.ok((hexConverterPanelRegistry.getHtml() ?? '').includes('id="textInput"'));
            assert.ok(messageHandler, '복사 메시지 핸들러가 없다');
            await messageHandler!({ command: 'copy', kind: 'hex', text: '48 69' });
            assert.deepStrictEqual(copied, ['48 69']);
            assert.deepStrictEqual(posted.at(-1), { command: 'copyResult', ok: true, kind: 'hex' });

            await messageHandler!({
                command: 'updatePreferences', encoding: 'ascii', hexGroup: 4, endian: 'big',
            });
            assert.deepStrictEqual(persisted.get('taskhub.hexConverter.preferences.v1'), {
                encoding: 'ascii', hexGroup: 4, endian: 'big',
            });
            await messageHandler!({
                command: 'updatePreferences', encoding: 'invalid', hexGroup: 8, endian: 'middle',
            });
            assert.deepStrictEqual(persisted.get('taskhub.hexConverter.preferences.v1'), {
                encoding: 'ascii', hexGroup: 4, endian: 'big',
            }, '잘못된 Webview 설정 메시지가 최근 옵션을 덮으면 안 된다');

            panel.dispose();
            showHexConverter(context);
            assert.strictEqual(createCount, 2);
            assert.ok(html.includes(
                'const INITIAL_PREFERENCES = {"encoding":"ascii","hexGroup":4,"endian":"big"};'
            ), '패널을 다시 열 때 최근 옵션을 Webview에 주입하지 않았다');
            assert.ok(messageHandler, '다시 연 패널의 메시지 핸들러가 없다');

            await messageHandler!({
                command: 'saveValue', kind: 'text', value: 'Hi', encoding: 'utf8', endian: 'little',
            });
            assert.strictEqual(posted.at(-1).command, 'savedValues');
            assert.strictEqual(posted.at(-1).action, 'saved');
            assert.strictEqual(posted.at(-1).values.length, 1);
            assert.strictEqual(posted.at(-1).values[0].byteCount, 2);
            const savedId = posted.at(-1).values[0].id;

            await messageHandler!({
                command: 'saveValue', kind: 'text', value: 'Hi', encoding: 'utf8', endian: 'little',
            });
            assert.strictEqual(posted.at(-1).values.length, 1, '같은 값을 중복 저장하면 안 된다');
            assert.notStrictEqual(posted.at(-1).values[0].id, savedId, '다시 저장한 값은 최신 항목으로 갱신돼야 한다');

            for (let index = 0; index < 25; index++) {
                await messageHandler!({
                    command: 'saveValue', kind: 'text', value: `value-${index}`,
                    encoding: 'utf8', endian: 'little',
                });
            }
            assert.strictEqual(posted.at(-1).values.length, 24, '저장값 상한을 넘겼다');
            const newestId = posted.at(-1).values[0].id;

            await messageHandler!({
                command: 'saveValue', kind: 'text', value: 'A'.repeat(16 * 1024 + 1),
                encoding: 'utf8', endian: 'little',
            });
            assert.deepStrictEqual(posted.at(-1), { command: 'saveResult', ok: false, reason: 'too-large' });

            await messageHandler!({ command: 'deleteSavedValue', id: newestId });
            assert.strictEqual(posted.at(-1).command, 'savedValues');
            assert.strictEqual(posted.at(-1).action, 'deleted');
            assert.strictEqual(posted.at(-1).values.length, 23);
        });
    });
});
