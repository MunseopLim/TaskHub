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
    open = false;
    placeholder = '';
    scrollTop = 0;
    selectionStart = 0;
    selectionEnd = 0;
    dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
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
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
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
        'bitwisePanel', 'bitwiseExpression', 'bitwiseWidth', 'bitwiseStatus',
        'bitwiseHex', 'bitwiseDecimal', 'bitwiseBinary',
        'copyBitwiseHex', 'copyBitwiseDecimal', 'copyBitwiseBinary', 'bitwiseClear',
    ];
    const elements = Object.fromEntries(ids.map(id => [id, new FakeWebviewElement()])) as Record<string, FakeWebviewElement>;
    elements.encoding.value = 'utf8';
    elements.hexGroup.value = '1';
    elements.bytesPerRow.value = '16';
    elements.endian.value = 'little';
    elements.bitwiseWidth.value = '32';
    elements.bitwisePanel.open = true;
    const posted: any[] = [];
    let persisted: any;
    let nextTimerId = 1;
    let timerTime = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    function advanceTimers(milliseconds: number): void {
        const targetTime = timerTime + milliseconds;
        while (true) {
            const next = Array.from(timers.entries())
                .filter(([, timer]) => timer.due <= targetTime)
                .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
            if (!next) { break; }
            timerTime = next[1].due;
            timers.delete(next[0]);
            next[1].callback();
        }
        timerTime = targetTime;
    }
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
        setTimeout: (callback: () => void, delay = 0) => {
            const id = nextTimerId++;
            timers.set(id, { callback, due: timerTime + Math.max(0, delay) });
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
        advanceTimers,
        flushTimers(): void {
            while (timers.size > 0) {
                advanceTimers(Math.min(...Array.from(timers.values(), timer => timer.due)) - timerTime);
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

    suite('비트 계산', () => {
        test('입력 중 오류 결과는 즉시 지우고 마지막 입력에서 350ms 뒤에만 오류를 알린다', () => {
            const strings = buildHexConverterStrings();
            const harness = runHexConverterWebview();
            const { elements } = harness;
            elements.bitwiseExpression.value = '1';
            elements.bitwiseExpression.dispatch('input');
            elements.bitwiseExpression.value = '1 <<';
            elements.bitwiseExpression.dispatch('input');
            for (const format of ['Hex', 'Decimal', 'Binary']) {
                assert.strictEqual(elements['bitwise' + format].textContent, '—');
                assert.strictEqual(elements['copyBitwise' + format].disabled, true);
            }
            assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
            assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseEditing);
            assert.ok(!elements.bitwiseStatus.classes.has('is-error'));
            assert.ok(!elements.bitwiseStatus.classes.has('is-success'));
            assert.strictEqual(harness.pendingTimerCount(), 1);
            harness.advanceTimers(349);
            assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseEditing);
            assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');

            elements.bitwiseExpression.value = '(1 2)';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(harness.pendingTimerCount(), 1, '연속 입력은 기존 오류 timer를 취소해야 한다');
            harness.advanceTimers(1);
            assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseEditing,
                '첫 입력의 350ms 시점에 새 입력 오류를 알리면 안 된다');
            harness.advanceTimers(348);
            assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
            harness.advanceTimers(1);
            assert.strictEqual(harness.pendingTimerCount(), 0);
            assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseErrorPosition
                .replace('{message}', strings.bitwiseInvalidExpression).replace('{position}', '4'));
            assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'true');
            assert.ok(elements.bitwiseStatus.classes.has('is-error'));
            assert.ok(!elements.bitwiseStatus.classes.has('is-success'));
        });

        test('유효 입력·지우기·blur·폭 변경은 대기 오류를 취소하고 최종 상태를 유지한다', () => {
            const strings = buildHexConverterStrings();
            for (const action of ['valid', 'clear', 'blur', 'width']) {
                const harness = runHexConverterWebview();
                const { elements } = harness;
                elements.bitwiseExpression.value = '1 <<';
                elements.bitwiseExpression.dispatch('input');
                harness.advanceTimers(200);
                assert.strictEqual(harness.pendingTimerCount(), 1);
                if (action === 'valid') {
                    elements.bitwiseExpression.value = '2';
                    elements.bitwiseExpression.dispatch('input');
                    assert.strictEqual(elements.bitwiseDecimal.textContent, '2');
                    assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseSuccess.replace('{width}', '32'));
                    assert.ok(elements.bitwiseStatus.classes.has('is-success'));
                } else if (action === 'clear') {
                    elements.bitwiseClear.dispatch('click');
                    assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseReady);
                    assert.ok(!elements.bitwiseStatus.classes.has('is-success'));
                } else if (action === 'blur') {
                    elements.bitwiseExpression.dispatch('blur');
                } else {
                    elements.bitwiseWidth.value = '8';
                    elements.bitwiseWidth.dispatch('change');
                }
                const errorExpected = action === 'blur' || action === 'width';
                assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), String(errorExpected), action);
                assert.strictEqual(elements.bitwiseStatus.classes.has('is-error'), errorExpected, action);
                if (errorExpected) {
                    assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseErrorPosition
                        .replace('{message}', strings.bitwiseInvalidExpression).replace('{position}', '5'), action);
                }
                assert.strictEqual(harness.pendingTimerCount(), 0, action);
                const finalStatus = elements.bitwiseStatus.textContent;
                harness.advanceTimers(350);
                assert.strictEqual(elements.bitwiseStatus.textContent, finalStatus, action);
            }
        });

        test('복원된 잘못된 수식은 기다리지 않고 오류와 위치를 표시한다', () => {
            const strings = buildHexConverterStrings();
            const harness = runHexConverterWebview({
                restoredState: { bitwise: { expression: '1 <<', width: 32, open: true } },
            });
            assert.strictEqual(harness.pendingTimerCount(), 0);
            assert.strictEqual(harness.elements.bitwiseExpression.getAttribute('aria-invalid'), 'true');
            assert.strictEqual(harness.elements.bitwiseStatus.textContent, strings.bitwiseErrorPosition
                .replace('{message}', strings.bitwiseInvalidExpression).replace('{position}', '5'));
            assert.ok(harness.elements.bitwiseStatus.classes.has('is-error'));
        });

        test('모든 오류 유형의 한국어·영어 문구와 1부터 시작하는 위치를 정확히 표시한다', () => {
            const cases = [
                { expression: '1', width: 128, key: 'bitwiseInvalidWidth', position: 1 },
                { expression: '1 + 2', width: 32, key: 'bitwiseInvalidToken', position: 3 },
                { expression: '1 <<', width: 32, key: 'bitwiseInvalidExpression', position: 5 },
                { expression: '(1 2)', width: 32, key: 'bitwiseInvalidExpression', position: 4 },
                { expression: '1 | 0x100', width: 8, key: 'bitwiseOutOfRange', position: 5 },
                { expression: '1 << 8', width: 8, key: 'bitwiseInvalidShift', position: 6 },
                { expression: '1'.repeat(4097), width: 32, key: 'bitwiseTooComplex', position: 4097 },
            ];
            for (const language of ['ko', 'en']) {
                withLanguage(language, () => {
                    const strings = buildHexConverterStrings();
                    const harness = runHexConverterWebview();
                    const { elements } = harness;
                    for (const { expression, width, key, position } of cases) {
                        elements.bitwiseWidth.value = String(width);
                        elements.bitwiseExpression.value = expression;
                        elements.bitwiseExpression.dispatch('input');
                        elements.bitwiseExpression.dispatch('blur');
                        const message = strings[key].replace('{width}', String(width)).replace('{max}', String(width - 1));
                        assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseErrorPosition
                            .replace('{message}', message).replace('{position}', String(position)), `${language}: ${key}`);
                        assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'true');
                        assert.ok(elements.bitwiseStatus.classes.has('is-error'));
                        assert.ok(!elements.bitwiseStatus.classes.has('is-success'));
                        assert.strictEqual(harness.pendingTimerCount(), 0);
                    }
                });
            }
        });

        test('성공·빈 입력·복사 성공과 실패의 한국어·영어 상태 및 클래스를 정확히 표시한다', () => {
            for (const language of ['ko', 'en']) {
                withLanguage(language, () => {
                    const strings = buildHexConverterStrings();
                    const harness = runHexConverterWebview();
                    const { elements, posted } = harness;
                    assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseReady);
                    assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
                    for (const width of [8, 16, 32, 64]) {
                        elements.bitwiseWidth.value = String(width);
                        elements.bitwiseExpression.value = '010';
                        elements.bitwiseExpression.dispatch('input');
                        assert.strictEqual(elements.bitwiseDecimal.textContent, '10');
                        assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseSuccess.replace('{width}', String(width)));
                        assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
                        assert.ok(elements.bitwiseStatus.classes.has('is-success'));
                        assert.ok(!elements.bitwiseStatus.classes.has('is-error'));
                    }
                    assert.match(strings.bitwiseHint, /010\s*=\s*10/);
                    assert.match(strings.bitwiseHint, language === 'ko' ? /8진수/ : /octal/i);
                    for (const ok of [false, true]) {
                        elements.copyBitwiseHex.dispatch('click');
                        harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok, requestId: posted.at(-1).requestId });
                        assert.strictEqual(elements.bitwiseStatus.textContent, ok ? strings.bitwiseCopied : strings.copyFailed);
                        assert.strictEqual(elements.bitwiseStatus.classes.has('is-success'), ok);
                        assert.strictEqual(elements.bitwiseStatus.classes.has('is-error'), !ok);
                        assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
                        assert.strictEqual(elements.bitwiseDecimal.textContent, '10');
                        assert.strictEqual(elements.copyBitwiseHex.disabled, false);
                    }
                    elements.bitwiseExpression.value = '   ';
                    elements.bitwiseExpression.dispatch('input');
                    assert.strictEqual(elements.bitwiseStatus.textContent, strings.bitwiseReady);
                    assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
                    assert.ok(!elements.bitwiseStatus.classes.has('is-error'));
                    assert.ok(!elements.bitwiseStatus.classes.has('is-success'));
                    assert.strictEqual(harness.pendingTimerCount(), 0);
                });
            }
        });

        test('결과에 접근 가능한 이름을 붙이고 상태 영역 하나만 읽어 주며 summary 키보드 포커스를 표시한다', () => {
            const html = buildHexConverterHtml();
            const panel = html.match(/<details\b[^>]*id="bitwisePanel"[^>]*>([\s\S]*?)<\/details>/)?.[1];
            assert.ok(panel);
            assert.match(panel!, /<summary\b[^>]*aria-labelledby="bitwiseTitle"[^>]*>\s*<h2\b[^>]*id="bitwiseTitle"/);
            assert.match(html, /summary:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
            assert.match(html, /summary:focus-visible\s*\{[^}]*outline:\s*(?!none)[^;}]+/);
            assert.strictEqual(Array.from(panel!.matchAll(/aria-live="polite"/g)).length, 1);
            assert.match(panel!, /id="bitwiseStatus"[^>]*role="status"[^>]*aria-live="polite"/);
            for (const format of ['Hex', 'Decimal', 'Binary']) {
                const output = panel!.match(new RegExp(`<output\\b[^>]*id="bitwise${format}"[^>]*>`))?.[0];
                assert.ok(output, format);
                assert.match(output!, /aria-live="off"/);
                const labelId = output!.match(/aria-labelledby="([^"]+)"/)?.[1];
                assert.ok(labelId, `${format} 결과의 접근 가능한 이름이 없다`);
                assert.match(panel!, new RegExp(`<label\\b[^>]*id="${labelId}"[^>]*>`));
            }
        });

        test('기본 32비트에서 즉시 계산하고 64비트 정밀도와 논리 우측 이동을 유지한다', () => {
            const { elements } = runHexConverterWebview();
            assert.strictEqual(elements.bitwiseWidth.value, '32');
            assert.strictEqual(elements.bitwisePanel.open, true);
            elements.bitwiseExpression.value = '(0x1234 >> 8) & 0xFF';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(elements.bitwiseHex.textContent, '0x00000012');
            assert.strictEqual(elements.bitwiseDecimal.textContent, '18');
            assert.strictEqual(elements.bitwiseBinary.textContent, '0b00000000000000000000000000010010');

            elements.bitwiseWidth.value = '64';
            elements.bitwiseWidth.dispatch('change');
            elements.bitwiseExpression.value = '~0';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(elements.bitwiseHex.textContent, '0xFFFFFFFFFFFFFFFF');
            assert.strictEqual(elements.bitwiseDecimal.textContent, '18446744073709551615');
            assert.strictEqual(elements.bitwiseBinary.textContent, '0b' + '1'.repeat(64));
            assert.strictEqual(elements.copyBitwiseHex.disabled, false);
            assert.strictEqual(elements.copyBitwiseDecimal.disabled, false);
            assert.strictEqual(elements.copyBitwiseBinary.disabled, false);

            elements.bitwiseExpression.value = '0x8000000000000000 >> 63';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(elements.bitwiseHex.textContent, '0x0000000000000001');
            assert.strictEqual(elements.bitwiseDecimal.textContent, '1');
        });

        test('식이 잘못되거나 폭을 줄여 범위를 넘으면 이전 결과와 복사 가능 상태를 지운다', () => {
            const harness = runHexConverterWebview();
            const { elements } = harness;
            elements.bitwiseExpression.value = '0x1234 & 0xFF';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(elements.bitwiseDecimal.textContent, '52');
            for (const invalid of ['0x1234 &', '-1', '1 << 32', '0x100000000']) {
                elements.bitwiseExpression.value = invalid;
                elements.bitwiseExpression.dispatch('input');
                for (const format of ['Hex', 'Decimal', 'Binary']) {
                    assert.strictEqual(elements['bitwise' + format].textContent, '—', invalid);
                    assert.strictEqual(elements['copyBitwise' + format].disabled, true, invalid);
                }
                harness.advanceTimers(350);
                assert.ok(elements.bitwiseStatus.classes.has('is-error'), invalid);
                assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'true');
            }
            elements.bitwiseExpression.value = '0x100';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(elements.bitwiseDecimal.textContent, '256');
            assert.ok(!elements.bitwiseStatus.classes.has('is-error'));
            assert.strictEqual(elements.bitwiseExpression.getAttribute('aria-invalid'), 'false');
            elements.bitwiseWidth.value = '8';
            elements.bitwiseWidth.dispatch('change');
            assert.strictEqual(elements.bitwiseHex.textContent, '—');
            assert.strictEqual(elements.copyBitwiseHex.disabled, true);
            assert.ok(elements.bitwiseStatus.classes.has('is-error'));
        });

        test('수식·폭·접힘 상태를 복원하고 기존 변환 상태와 함께 저장한다', () => {
            const harness = runHexConverterWebview({
                restoredState: {
                    source: 'text', text: 'A', encoding: 'ascii', endian: 'big',
                    bitwise: { expression: '0x8000000000000000 | 1', width: 64, open: false },
                },
            });
            const { elements } = harness;
            assert.strictEqual(elements.bitwiseExpression.value, '0x8000000000000000 | 1');
            assert.strictEqual(elements.bitwiseWidth.value, '64');
            assert.strictEqual(elements.bitwisePanel.open, false);
            assert.strictEqual(elements.bitwiseDecimal.textContent, '9223372036854775809');
            assert.strictEqual(elements.textInput.value, 'A');
            assert.strictEqual(elements.hexInput.value, '41');

            elements.bitwisePanel.open = true;
            elements.bitwisePanel.dispatch('toggle');
            assert.strictEqual(harness.persisted().bitwise.open, true);
            assert.strictEqual(harness.persisted().bitwise.width, 64);
            elements.textInput.value = 'AB';
            elements.textInput.dispatch('input');
            assert.strictEqual(harness.persisted().bitwise.expression, '0x8000000000000000 | 1');
            assert.strictEqual(harness.persisted().text, 'AB');
        });

        test('기존 변환 옵션은 초기 비트 폭에 영향을 주지 않고 손상된 비트 상태를 기본값으로 복원한다', () => {
            const harness = runHexConverterWebview({
                preferences: { encoding: 'ascii', hexGroup: 4, endian: 'big' },
                restoredState: { bitwise: { expression: null, width: 128, open: 'false' } },
            });
            assert.strictEqual(harness.elements.bitwiseWidth.value, '32');
            assert.strictEqual(harness.elements.bitwiseExpression.value, '');
            assert.strictEqual(harness.elements.bitwisePanel.open, true);
            assert.strictEqual(harness.elements.encoding.value, 'ascii');
            assert.strictEqual(harness.elements.endian.value, 'big');
        });

        test('Endian·UTF-8 오류·계산 지우기는 서로의 결과와 상태를 덮어쓰지 않는다', () => {
            const harness = runHexConverterWebview();
            const { elements } = harness;
            elements.hexInput.value = 'FF';
            elements.hexInput.dispatch('input');
            const conversionError = elements.statusText.textContent;
            assert.ok(elements.status.classes.has('is-error'));
            elements.bitwiseExpression.value = '0x1234';
            elements.bitwiseExpression.dispatch('input');
            assert.strictEqual(elements.bitwiseHex.textContent, '0x00001234');
            assert.strictEqual(elements.statusText.textContent, conversionError);
            elements.endian.value = 'big';
            elements.endian.dispatch('change');
            assert.strictEqual(elements.bitwiseHex.textContent, '0x00001234');
            assert.strictEqual(elements.statusText.textContent, conversionError);
            elements.bitwiseClear.dispatch('click');
            assert.strictEqual(elements.bitwiseExpression.value, '');
            assert.strictEqual(elements.bitwiseHex.textContent, '—');
            assert.strictEqual(elements.copyBitwiseHex.disabled, true);
            assert.strictEqual(elements.hexInput.value, 'FF');
            assert.strictEqual(elements.statusText.textContent, conversionError);
            assert.ok(elements.status.classes.has('is-error'));
            assert.strictEqual(harness.persisted().bitwise.expression, '');
        });

        test('복사는 원본 수식과 폭·형식을 전달하고 늦은 응답이 새 결과를 덮어쓰지 않는다', () => {
            const harness = runHexConverterWebview();
            const { elements, posted } = harness;
            elements.bitwiseExpression.value = '0x1234 & 0xFF';
            elements.bitwiseExpression.dispatch('input');
            for (const [button, format] of [
                ['copyBitwiseHex', 'hex'], ['copyBitwiseDecimal', 'decimal'], ['copyBitwiseBinary', 'binary'],
            ]) {
                elements[button].dispatch('click');
                assert.strictEqual(posted.at(-1).command, 'copyBitwiseResult');
                assert.strictEqual(posted.at(-1).expression, '0x1234 & 0xFF');
                assert.strictEqual(posted.at(-1).width, 32);
                assert.strictEqual(posted.at(-1).format, format);
                assert.ok(Number.isSafeInteger(posted.at(-1).requestId));
            }
            const latestRequestId = posted.at(-1).requestId;
            harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok: false, requestId: latestRequestId });
            assert.ok(elements.bitwiseStatus.classes.has('is-error'));
            assert.strictEqual(elements.bitwiseDecimal.textContent, '52');

            elements.bitwiseExpression.value = '0xFF';
            elements.bitwiseExpression.dispatch('input');
            const latestStatus = elements.bitwiseStatus.textContent;
            harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok: true, requestId: latestRequestId });
            assert.strictEqual(elements.bitwiseStatus.textContent, latestStatus);
            assert.strictEqual(elements.bitwiseDecimal.textContent, '255');
            assert.ok(!elements.bitwiseStatus.classes.has('is-error'));

            elements.copyBitwiseHex.dispatch('click');
            const oldRequestId = posted.at(-1).requestId;
            elements.copyBitwiseDecimal.dispatch('click');
            const newRequestId = posted.at(-1).requestId;
            assert.notStrictEqual(oldRequestId, newRequestId);
            harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok: true, requestId: newRequestId });
            const copiedStatus = elements.bitwiseStatus.textContent;
            harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok: false, requestId: oldRequestId });
            assert.strictEqual(elements.bitwiseStatus.textContent, copiedStatus);
            assert.ok(!elements.bitwiseStatus.classes.has('is-error'));

            elements.copyBitwiseHex.dispatch('click');
            const resizedRequestId = posted.at(-1).requestId;
            elements.bitwiseWidth.value = '16';
            elements.bitwiseWidth.dispatch('change');
            const resizedStatus = elements.bitwiseStatus.textContent;
            harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok: false, requestId: resizedRequestId });
            assert.strictEqual(elements.bitwiseStatus.textContent, resizedStatus);
            assert.strictEqual(elements.bitwiseHex.textContent, '0x00FF');
            assert.ok(!elements.bitwiseStatus.classes.has('is-error'));

            elements.copyBitwiseBinary.dispatch('click');
            const clearedRequestId = posted.at(-1).requestId;
            elements.bitwiseClear.dispatch('click');
            const clearedStatus = elements.bitwiseStatus.textContent;
            harness.dispatchWindowMessage({ command: 'bitwiseCopyResult', ok: false, requestId: clearedRequestId });
            assert.strictEqual(elements.bitwiseStatus.textContent, clearedStatus);
            assert.ok(!elements.bitwiseStatus.classes.has('is-error'));
        });
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

        test('비트 복사는 호스트가 64비트 결과를 재계산하고 잘못된 메시지와 클립보드 실패를 처리한다', async () => {
            let messageHandler: ((message: any) => Promise<void>) | undefined;
            const copied: string[] = [];
            const posted: any[] = [];
            let clipboardFails = false;
            const panel = {
                webview: {
                    cspSource: 'vscode-webview:',
                    html: '',
                    onDidReceiveMessage(handler: (message: any) => Promise<void>) {
                        messageHandler = handler;
                        return { dispose() {} };
                    },
                    postMessage(message: any) { posted.push(message); return Promise.resolve(true); },
                },
                onDidDispose() { return { dispose() {} }; },
                dispose() {},
            } as unknown as vscode.WebviewPanel;
            (vscode.window as any).createWebviewPanel = () => panel;
            Object.defineProperty(vscode.env, 'clipboard', {
                configurable: true,
                value: { writeText: async (value: string) => {
                    if (clipboardFails) { throw new Error('clipboard unavailable'); }
                    copied.push(value);
                } },
            });
            const context = {
                globalState: { get(_key: string, fallback: unknown) { return fallback; } },
            } as unknown as vscode.ExtensionContext;
            showHexConverter(context);
            assert.ok(messageHandler);
            const validRequest = {
                command: 'copyBitwiseResult', expression: '~0', width: 64, format: 'decimal', requestId: 0,
                text: 'untrusted result',
            };
            await messageHandler!(validRequest);
            assert.deepStrictEqual(copied, ['18446744073709551615']);
            assert.deepStrictEqual(posted.at(-1), { command: 'bitwiseCopyResult', ok: true, requestId: 0 });
            await messageHandler!({ ...validRequest, format: 'hex', requestId: 8 });
            assert.strictEqual(copied.at(-1), '0xFFFFFFFFFFFFFFFF');
            await messageHandler!({ ...validRequest, format: 'binary', requestId: 9 });
            assert.strictEqual(copied.at(-1), '0b' + '1'.repeat(64));

            for (const invalid of [
                { expression: '' }, { expression: 1 }, { expression: '0x100', width: 8 },
                { expression: '1 << 64' }, { expression: '1 <<' }, { expression: '(1 2)' },
                { expression: '1'.repeat(10000) },
                { width: '64' }, { width: 128 }, { format: 'toString' },
            ]) {
                const postedBefore = posted.length;
                await messageHandler!({ ...validRequest, ...invalid });
                assert.strictEqual(copied.length, 3, JSON.stringify(invalid));
                assert.strictEqual(posted.length, postedBefore + 1, '유효한 requestId에는 실패 응답을 한 번 보내야 한다');
                assert.deepStrictEqual(posted.at(-1), { command: 'bitwiseCopyResult', ok: false, requestId: 0 });
            }
            for (const requestId of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '7', null, undefined]) {
                const postedBefore = posted.length;
                await messageHandler!({ ...validRequest, requestId });
                assert.strictEqual(copied.length, 3, String(requestId));
                assert.strictEqual(posted.length, postedBefore, '잘못된 requestId에는 응답을 보내면 안 된다');
            }

            clipboardFails = true;
            await messageHandler!(validRequest);
            assert.deepStrictEqual(posted.at(-1), { command: 'bitwiseCopyResult', ok: false, requestId: 0 });
            assert.strictEqual(copied.length, 3);
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
