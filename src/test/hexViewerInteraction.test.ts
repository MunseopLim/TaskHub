import * as assert from 'assert';
import * as vm from 'vm';
import { buildHexViewerHtml, buildHexViewerStrings } from '../hexViewer';
import { parseBinary, parseIntelHex, parseSrec } from '../hexParser';

/** 실제 생성된 스크립트 전체를 실행한다. DOM은 이벤트·포커스·표 조회 경계만 제공한다. */
function runViewer(bytes: number[]) {
    let focused: FakeElement | null = null;
    let selectedText = '';
    class FakeElement {
        value = '';
        textContent = '';
        className = '';
        isContentEditable = false;
        clientHeight = 200;
        scrollTop = 0;
        style: Record<string, string> = {};
        dataset: Record<string, string> = {};
        children: FakeElement[] = [];
        private html = '';
        readonly listeners = new Map<string, Array<(event: any) => unknown>>();
        constructor(readonly tagName = 'DIV') {}
        get innerHTML(): string { return this.html; }
        set innerHTML(value: string) { this.html = value; this.children = []; }
        readonly classList = {
            add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
            remove: (...names: string[]) => { this.className = this.className.split(' ').filter(x => !names.includes(x)).join(' '); },
            contains: (name: string) => this.className.split(' ').includes(name),
            toggle: (name: string) => {
                if (this.classList.contains(name)) { this.classList.remove(name); } else { this.classList.add(name); }
            },
        };
        addEventListener(name: string, listener: (event: any) => unknown): void {
            const list = this.listeners.get(name) ?? [];
            list.push(listener);
            this.listeners.set(name, list);
        }
        async dispatch(name: string, event: any = {}): Promise<void> {
            for (const listener of this.listeners.get(name) ?? []) { await listener({ target: this, ...event }); }
        }
        appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
        setAttribute(): void {}
        focus(): void { focused = this; }
        scrollIntoView(): void {}
        all(): FakeElement[] { return [this, ...this.children.flatMap(child => child.all())]; }
        contains(element: FakeElement | null): boolean { return this.all().includes(element!); }
        matches(selector: string): boolean {
            return selector.split(',').some(part => {
                const token = part.trim();
                if (/^[a-z]+$/i.test(token)) { return this.tagName.toLowerCase() === token.toLowerCase(); }
                const classes = [...token.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
                if (!classes.every(name => this.classList.contains(name))) { return false; }
                const offset = token.match(/\[data-offset(?:="([^"]+)")?\]/);
                return !offset || (this.dataset.offset !== undefined && (offset[1] === undefined || this.dataset.offset === offset[1]));
            });
        }
        closest(selector: string): FakeElement | null { return this.matches(selector) ? this : null; }
        querySelectorAll(selector: string): FakeElement[] { return this.children.flatMap(child => child.all()).filter(child => child.matches(selector)); }
        querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
    }
    const ids = [
        'hexContainer', 'hexHead', 'hexBody', 'statusBar', 'unitSize', 'endian', 'gotoInput',
        'gotoBtn', 'findBar', 'findMode', 'findHexInput', 'findInfo', 'findBtn', 'findClose',
        'findNext', 'findPrev', 'hexLoading',
    ];
    const elements = Object.fromEntries(ids.map(id => [id,
        new FakeElement(['gotoInput', 'findHexInput'].includes(id) ? 'INPUT' : 'DIV')
    ]));
    elements.unitSize.value = '1';
    elements.endian.value = 'little';
    elements.findMode.value = 'value';
    elements.hexContainer.appendChild(elements.hexBody);
    const documentEvents = new FakeElement();
    const windowEvents = new FakeElement();
    let nextTimer = 0;
    const delayed = new Map<number, { callback: () => unknown; delay: number }>();
    const html = buildHexViewerHtml('interaction.bin', parseBinary(Buffer.from(bytes)));
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    vm.runInNewContext(script, {
        Element: FakeElement,
        Uint8Array,
        acquireVsCodeApi: () => ({ postMessage: () => {} }),
        document: {
            get activeElement() { return focused; },
            getElementById: (id: string) => elements[id],
            createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
            createDocumentFragment: () => new FakeElement(),
            querySelectorAll: (selector: string) => [...new Set(Object.values(elements).flatMap(element => element.all()))]
                .filter(element => element.matches(selector)),
            addEventListener: documentEvents.addEventListener.bind(documentEvents),
        },
        window: {
            addEventListener: windowEvents.addEventListener.bind(windowEvents),
            getSelection: () => ({ toString: () => selectedText }),
        },
        requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
        setTimeout: (callback: () => unknown, delay: number) => {
            delayed.set(++nextTimer, { callback, delay });
            return nextTimer;
        },
        clearTimeout: (id: number) => { delayed.delete(id); },
    });
    return {
        elements,
        documentEvents,
        async flushSearch() {
            for (const [id, timer] of delayed) {
                if (timer.delay !== 250) { continue; }
                delayed.delete(id);
                await timer.callback();
            }
        },
        setSelectedText(text: string) { selectedText = text; },
        async load() { await windowEvents.dispatch('message', { data: { command: 'hexData', data: Uint8Array.from(bytes) } }); },
        async clickByte(offset: number) {
            const cell = elements.hexBody.querySelector(`.hex-cell[data-offset="${offset}"]`);
            assert.ok(cell, `offset ${offset} cell`);
            await elements.hexBody.dispatch('click', { target: cell });
        },
        async copy(target: FakeElement) {
            let copied: string | undefined;
            let prevented = false;
            await documentEvents.dispatch('copy', {
                target,
                clipboardData: { setData: (_: string, value: string) => { copied = value; } },
                preventDefault: () => { prevented = true; },
            });
            return { copied, prevented };
        },
    };
}

suite('Hex Viewer 연속 조작', () => {
    test('Endian 변경은 Value 검색 위치와 선택 숫자 해석을 함께 갱신한다', async () => {
        const viewer = runViewer([1, 2, 0, 2, 1]);
        const { elements } = viewer;
        await viewer.load();
        await elements.findBtn.dispatch('click');
        elements.unitSize.value = '2';
        await elements.unitSize.dispatch('change');
        elements.findHexInput.value = '0102';
        await elements.findHexInput.dispatch('input');
        await viewer.flushSearch();
        assert.match(elements.statusBar.innerHTML, /0x00000003/);
        elements.endian.value = 'big';
        await elements.endian.dispatch('change');
        assert.match(elements.statusBar.innerHTML, /0x00000000/);
        assert.match(elements.statusBar.innerHTML, /u16: 0x0102 \(258\)/);
        await viewer.clickByte(0);
        elements.findHexInput.value = '';
        await elements.findHexInput.dispatch('input');
        await viewer.flushSearch();
        elements.endian.value = 'little';
        await elements.endian.dispatch('change');
        assert.match(elements.statusBar.innerHTML, /u16: 0x0201 \(513\)/);
        elements.unitSize.value = '1';
        await elements.unitSize.dispatch('change');
        assert.strictEqual(elements.statusBar.textContent, buildHexViewerStrings().statusHint);
    });

    test('검색 닫기는 예약 검색을 취소하고 Endian 변경으로 다시 열리지 않는다', async () => {
        const viewer = runViewer([1, 2, 0, 2, 1]);
        const { elements } = viewer;
        await viewer.load();
        await elements.findBtn.dispatch('click');
        elements.findHexInput.value = '0102';
        await elements.findHexInput.dispatch('input');
        await viewer.flushSearch();
        assert.match(elements.statusBar.innerHTML, /0x00000003/);
        await elements.findClose.dispatch('click');
        elements.endian.value = 'big';
        await elements.endian.dispatch('change');
        assert.strictEqual(elements.findInfo.textContent, '');
        assert.match(elements.statusBar.innerHTML, /0x00000003/, '닫은 검색이 선택을 첫 결과로 이동하면 안 된다');
        for (const closeId of ['findClose', 'findBtn']) {
            await elements.findBtn.dispatch('click');
            elements.findHexInput.value = '0102';
            await elements.findHexInput.dispatch('input');
            await elements[closeId].dispatch('click');
            await viewer.flushSearch();
            assert.strictEqual(elements.findInfo.textContent, '');
            assert.strictEqual(elements.findBar.classList.contains('visible'), false);
            assert.match(elements.statusBar.innerHTML, /0x00000003/);
        }
    });

    test('바이트 선택 후 입력 필드·일반 텍스트·그리드의 복사 대상이 섞이지 않는다', async () => {
        const viewer = runViewer([0xAA, 0xBB]);
        await viewer.load();
        await viewer.clickByte(0);
        assert.deepStrictEqual(await viewer.copy(viewer.elements.hexContainer), { copied: 'AA', prevented: true });
        for (const id of ['findHexInput', 'gotoInput']) {
            const input = viewer.elements[id];
            input.value = '1234';
            input.focus();
            assert.deepStrictEqual(await viewer.copy(input), { copied: undefined, prevented: false });
        }
        viewer.elements.statusBar.isContentEditable = true;
        viewer.elements.statusBar.focus();
        assert.strictEqual((await viewer.copy(viewer.elements.statusBar)).prevented, false);
        viewer.elements.hexContainer.focus();
        viewer.setSelectedText('selected ordinary text');
        assert.strictEqual((await viewer.copy(viewer.elements.hexContainer)).prevented, false);
        viewer.setSelectedText('');
        assert.deepStrictEqual(await viewer.copy(viewer.elements.hexContainer), { copied: 'AA', prevented: true });
    });
});

suite('HEX/SREC 손상 레코드', () => {
    const intelRecord = (type: number, bytes: number[], address = 0): string => {
        const payload = [bytes.length, address >>> 8, address & 0xFF, type, ...bytes];
        const checksum = -payload.reduce((sum, byte) => sum + byte, 0) & 0xFF;
        return ':' + [...payload, checksum].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    };

    test('16진수가 아닌 접미사는 바이트·주소·체크섬에 사용할 수 없다', () => {
        for (const text of [':010000000ZFF', ':010Z000000FF', ':01000000FFFZ']) {
            const result = parseIntelHex(text);
            assert.strictEqual(result.byteCount, 0, text);
            assert.strictEqual(result.invalidRecordCount, 1);
        }
        const result = parseSrec('S10400000ZFB');
        assert.strictEqual(result.byteCount, 0);
        assert.strictEqual(result.invalidRecordCount, 1);
    });

    test('손상 레코드를 제외하고 읽은 파일에는 불완전한 데이터임을 표시한다', () => {
        const result = parseIntelHex(':010000000ZFF\n:01000100AA54\n:00000001FF');
        assert.deepStrictEqual([...result.data], [[1, 0xAA]]);
        assert.strictEqual(result.invalidRecordCount, 1);
        const html = buildHexViewerHtml('damaged.hex', result);
        assert.ok(html.includes(buildHexViewerStrings().invalidRecords.replace('{n}', '1')));
    });

    test('잘못된 주소 확장 뒤의 데이터를 이전 기준 주소로 표시하지 않는다', () => {
        const result = parseIntelHex(':00000004FC\n:01000000AA55');
        assert.deepStrictEqual([...result.data], []);
        assert.strictEqual(result.invalidRecordCount, 1);
        assert.strictEqual(result.unaddressedRecordCount, 1);
    });

    test('주소 확장이 손상되면 정상 확장 레코드가 나올 때까지 데이터를 제외한다', () => {
        for (const type of [2, 4]) {
            for (const damaged of [
                intelRecord(type, [0, 1], 1), // 주소 필드는 0000이어야 한다.
                intelRecord(type, [0]),
                intelRecord(type, [0, 1]).slice(0, -2) + '00',
            ]) {
                const result = parseIntelHex([
                    intelRecord(2, [0, 1]), intelRecord(0, [0xAA]),
                    damaged, intelRecord(0, [0xBB], 1), intelRecord(0, [0xCC], 2),
                    intelRecord(type, [0, 2]), intelRecord(0, [0xDD]),
                ].join('\n'));
                assert.deepStrictEqual([...result.data], [[0x10, 0xAA], [type === 2 ? 0x20 : 0x20000, 0xDD]]);
                assert.strictEqual(result.invalidRecordCount, 1);
                assert.strictEqual(result.unaddressedRecordCount, 2);
                const html = buildHexViewerHtml('damaged-base.hex', result);
                assert.ok(html.includes(buildHexViewerStrings().unaddressedRecords.replace('{n}', '2')));
            }
        }
    });

    test('접두사가 깨진 입력 줄은 계수하고 빈 줄·명시적 주석은 제외한다', () => {
        for (const [parse, valid, damaged] of [
            [parseIntelHex, ':01000000AA55', '!01000000BB44'],
            [parseSrec, 'S1040000AA51', '!1040000BB40'],
        ] as const) {
            const result = parse(['', '; comment', '# comment', '// comment', valid, damaged, 'garbage'].join('\n'));
            assert.deepStrictEqual([...result.data], [[0, 0xAA]]);
            assert.strictEqual(result.invalidRecordCount, 2);
            const html = buildHexViewerHtml('damaged-prefix', result);
            assert.ok(html.includes(buildHexViewerStrings().invalidRecords.replace('{n}', '2')));
        }
    });
});
