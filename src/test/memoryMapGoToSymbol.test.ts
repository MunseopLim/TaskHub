import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    buildGoToSymbolItems,
    buildGoToSymbolTitle,
    buildRevealEntryMessage,
    collectPickEntries,
    limitSymbolPickEntries,
    openMemoryMapPanel,
    panelRegistry,
    MEMORY_MAP_MAX_SYMBOL_PICK_ITEMS,
    PanelEntry,
} from '../memoryMapViewer';
import { MemoryUsage, MemoryUsageEntry } from '../elfParser';
import { buildElf32WithSymbols } from './fixtures/elfFixtures';

/**
 * *Go to Symbol* (0.7.13).
 *
 * 0.7.12까지 이 명령은 이름과 달리 **영역 목록**만 보여 줬다. 심볼 테이블을
 * 이미 파싱해 표에 그려 놓고도 Quick Pick 은 region 이름만 담았다.
 *
 * 이 파일이 지키는 것은 두 가지다.
 *
 * 1. **목록에 오르는 항목은 전부 표에 실제로 있는 행이다.** 하나라도 어긋나면
 *    고른 뒤 아무 일도 일어나지 않는데, 사용자에게는 명령이 죽은 것으로 보인다.
 *    호스트가 만드는 목록과 웹뷰에 실린 행 데이터(RD)를 대조해 확인한다.
 * 2. **행을 못 찾게 만드는 세 가지 상태를 revealEntry 가 모두 푼다** — 접힌
 *    영역, 대상을 걸러 내는 검색, 아직 그려지지 않은 가상 스크롤 행. 정규식으로
 *    "코드가 있는지"만 보면 로직이 틀려도 통과하므로 웹뷰 함수를 꺼내 실행한다.
 */
suite('Memory Map — Go to Symbol', () => {
    const entry = (over: Partial<PanelEntry> = {}): PanelEntry => ({
        name: 'sym', addr: 0x100, size: 16, type: 'CODE', region: 'FLASH', regionIndex: 0, ...over,
    });

    /** 웹뷰 HTML 한 벌. 스크립트를 꺼내 쓰는 검사들이 공유한다. */
    let webviewHtml = '';

    /** 웹뷰 스크립트에서 4칸 들여쓴 함수 하나를 통째로 꺼낸다. */
    function extractFn(signature: string): string {
        const start = webviewHtml.indexOf(signature);
        assert.ok(start >= 0, `${signature} 를 찾지 못했다`);
        const end = webviewHtml.indexOf('\n    }', start);
        assert.ok(end > start, `${signature} 의 끝을 찾지 못했다`);
        return webviewHtml.slice(start, end + '\n    }'.length);
    }

    suiteSetup(() => {
        panelRegistry.clear();
        const filePath = path.join(os.tmpdir(), `taskhub-mm-webview-${process.pid}.axf`);
        fs.writeFileSync(filePath, buildElf32WithSymbols());
        const ctx = { extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [] } as unknown as vscode.ExtensionContext;
        assert.ok(openMemoryMapPanel(ctx, filePath, { regions: [{ name: 'FLASH', origin: 0x08000000, size: 512 * 1024 }] }));
        webviewHtml = panelRegistry.getHtml(filePath) ?? '';
        panelRegistry.clear();
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
    });

    suite('Quick Pick 목록', () => {
        let filePath: string;
        let html: string;

        suiteSetup(() => {
            panelRegistry.clear();
            filePath = path.join(os.tmpdir(), `taskhub-mm-goto-${process.pid}.axf`);
            fs.writeFileSync(filePath, buildElf32WithSymbols());
            const ctx = { extensionPath: path.resolve(__dirname, '..', '..'), subscriptions: [] } as unknown as vscode.ExtensionContext;
            // 영역을 주지 않으면 memoryUsage 가 비어 목록도 표도 만들어지지 않는다.
            const config = {
                regions: [
                    { name: 'FLASH', origin: 0x08000000, size: 512 * 1024 },
                    { name: 'RAM', origin: 0x20000000, size: 128 * 1024 },
                ],
            };
            assert.ok(openMemoryMapPanel(ctx, filePath, config), '패널이 열려야 목록을 검사할 수 있다');
            html = panelRegistry.getHtml(filePath) ?? '';
        });

        suiteTeardown(() => {
            panelRegistry.clear();
            try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        });

        test('영역 이름이 아니라 실제 심볼이 목록에 오른다', () => {
            const entries = panelRegistry.getEntries(filePath) ?? [];
            const names = entries.map(e => e.name);
            for (const sym of ['main', 'SystemInit', 'HAL_GPIO_Init', 'g_config', 'g_buffer']) {
                assert.ok(names.includes(sym), `심볼 ${sym} 이 목록에 없다: ${names.join(', ')}`);
            }
            // 0.7.12의 목록은 정확히 영역 이름 두 개뿐이었다.
            assert.ok(entries.length > 2, `항목이 ${entries.length}개뿐이다 — 영역 목록으로 되돌아갔다`);
        });

        test('심볼마다 주소·크기·타입·영역이 함께 실린다', () => {
            const main = (panelRegistry.getEntries(filePath) ?? []).find(e => e.name === 'main');
            assert.ok(main, 'main 심볼을 찾지 못했다');
            assert.strictEqual(main!.addr, 0x08000000);
            assert.strictEqual(main!.size, 0x120);
            assert.strictEqual(main!.type, 'CODE', 'STT_FUNC 는 CODE 로 분류된다');
            assert.strictEqual(main!.region, 'FLASH');

            const buf = (panelRegistry.getEntries(filePath) ?? []).find(e => e.name === 'g_buffer');
            assert.strictEqual(buf?.type, 'DATA', 'STT_OBJECT 는 DATA 로 분류된다');
            assert.strictEqual(buf?.region, 'RAM', '영역이 섞이면 엉뚱한 카드로 이동한다');
        });

        test('목록의 모든 항목이 웹뷰 표에 실제로 있는 행이다', () => {
            // 이동은 region + name + addr 로 행을 찾는다. 표에 없는 항목이
            // 목록에 있으면 고른 뒤 아무 일도 일어나지 않는다.
            const rdMatch = html.match(/^const RD = (.*);$/m);
            assert.ok(rdMatch, '웹뷰에 실린 RD 를 찾지 못했다');
            const rd: { name: string; segments: { n: string; a: number }[] }[] = JSON.parse(rdMatch![1]);
            const rows = new Set<string>();
            for (const region of rd) {
                for (const seg of region.segments) { rows.add(`${region.name}|${seg.n}|${seg.a}`); }
            }

            const entries = panelRegistry.getEntries(filePath) ?? [];
            assert.ok(entries.length > 0, '목록이 비어 있으면 이 검사는 아무것도 보지 않는다');
            for (const e of entries) {
                assert.ok(
                    rows.has(`${e.region}|${e.name}|${e.addr}`),
                    `목록의 ${e.region}/${e.name} @${e.addr} 에 대응하는 행이 표에 없다`
                );
            }
        });
    });

    suite('collectPickEntries', () => {
        const usage = (over: Partial<MemoryUsage> = {}): MemoryUsage => ({
            region: 'FLASH', used: 0, total: 0, sections: [], freeSpaces: [], ...over,
        });
        const section = (over: Partial<MemoryUsageEntry> = {}): MemoryUsageEntry => ({
            name: 'sym', addr: 0x100, size: 16, type: 'CODE', ...over,
        });

        test('크기 0 인 행은 목록에 넣지 않는다', () => {
            // 웹뷰가 같은 조건으로 걸러 표를 그린다. 넣어 두면 고른 뒤 아무 일도
            // 일어나지 않는 항목이 된다 — 이 릴리스가 없애려던 바로 그 증상이다.
            const entries = collectPickEntries([usage({
                sections: [section({ name: 'real' }), section({ name: 'empty', size: 0 }), section({ name: 'negative', size: -4 })],
            })]);
            assert.deepStrictEqual(entries.map(e => e.name), ['real']);
        });

        test('영역 순번을 함께 싣는다 — 이름이 겹쳐도 갈린다', () => {
            const entries = collectPickEntries([
                usage({ region: 'RAM', sections: [section({ name: 'a' })] }),
                usage({ region: 'RAM', sections: [section({ name: 'b' })] }),
            ]);
            assert.deepStrictEqual(entries.map(e => e.regionIndex), [0, 1], '순번이 없으면 둘째 RAM 의 행이 첫째 카드로 간다');
        });

        test('부모 섹션(object)과 함수명을 잃지 않는다', () => {
            const [e] = collectPickEntries([usage({
                sections: [section({ object: '.text', section: '.text.main', func: 'main' })],
            })]);
            assert.strictEqual(e.object, '.text', 'ELF 심볼의 부모 섹션은 object 로 온다 — 없으면 설명으로 검색할 수 없다');
            assert.strictEqual(e.section, '.text.main');
            assert.strictEqual(e.func, 'main');
        });
    });

    suite('limitSymbolPickEntries', () => {
        test('상한 아래면 전부 남기고 주소순으로 세운다', () => {
            const result = limitSymbolPickEntries([
                entry({ name: 'c', addr: 0x300 }),
                entry({ name: 'a', addr: 0x100 }),
                entry({ name: 'b', addr: 0x200 }),
            ]);
            assert.deepStrictEqual(result.map(e => e.name), ['a', 'b', 'c']);
        });

        test('주소가 같으면 이름순으로 갈라 순서를 고정한다', () => {
            const result = limitSymbolPickEntries([
                entry({ name: 'zzz', addr: 0x100 }),
                entry({ name: 'aaa', addr: 0x100 }),
            ]);
            assert.deepStrictEqual(result.map(e => e.name), ['aaa', 'zzz']);
        });

        test('상한을 넘으면 큰 것부터 남기되 화면 순서는 주소순이다', () => {
            const entries = [
                entry({ name: 'tiny', addr: 0x100, size: 1 }),
                entry({ name: 'huge', addr: 0x900, size: 900 }),
                entry({ name: 'big', addr: 0x500, size: 500 }),
            ];
            const result = limitSymbolPickEntries(entries, 2);
            assert.deepStrictEqual(result.map(e => e.name), ['big', 'huge'], '큰 둘이 주소순으로 남아야 한다');
        });

        test('원본 배열을 건드리지 않는다', () => {
            const entries = [entry({ name: 'b', addr: 0x200 }), entry({ name: 'a', addr: 0x100 })];
            limitSymbolPickEntries(entries);
            assert.deepStrictEqual(entries.map(e => e.name), ['b', 'a'], '패널 상태 배열이 제자리에서 뒤바뀌었다');
        });

        test('상한 기본값이 파서 상한(100만)보다 훨씬 작다', () => {
            // Quick Pick 은 항목을 전부 렌더한다 — 파서 상한을 그대로 쓰면 목록을
            // 여는 순간 UI 가 멈춘다.
            assert.ok(MEMORY_MAP_MAX_SYMBOL_PICK_ITEMS <= 20000, '상한이 너무 크다');
        });
    });

    suite('buildGoToSymbolItems', () => {
        const regions = [{ name: 'FLASH', addr: 0x08000000, info: '1.0 KB / 512.0 KB' }];

        test('심볼이 먼저, 영역이 뒤 — 각각 구분선을 갖는다', () => {
            const items = buildGoToSymbolItems([entry({ name: 'main' })], regions);
            const separators = items
                .map((it, i) => ({ it, i }))
                .filter(({ it }) => it.kind === vscode.QuickPickItemKind.Separator);
            assert.strictEqual(separators.length, 2, '구분선이 둘이어야 두 묶음이 구분된다');
            assert.ok(separators[0].i < items.findIndex(it => it.label === 'main'), '심볼 구분선이 심볼보다 앞이다');
            assert.ok(
                items.findIndex(it => it.label === 'main') < items.findIndex(it => it.label === 'FLASH'),
                '목록을 열면 첫 항목이 선택되므로 심볼이 앞이어야 한다'
            );
        });

        test('심볼 항목만 entry 를 갖는다 — 이동 방식이 여기서 갈린다', () => {
            const items = buildGoToSymbolItems([entry({ name: 'main' })], regions);
            assert.ok(items.find(it => it.label === 'main')?.entry, '심볼 항목에 entry 가 없으면 행으로 이동할 수 없다');
            assert.strictEqual(items.find(it => it.label === 'FLASH')?.entry, undefined, '영역 항목은 카드로 이동한다');
        });

        test('함수명이 있으면 그것이 label 이고 오브젝트명은 설명으로 간다', () => {
            // Listing 파일은 이름 칸이 오브젝트라 행마다 겹친다.
            const items = buildGoToSymbolItems([entry({ name: 'main.o', func: 'HAL_Init', section: '.text' })], []);
            const it = items.find(i => i.kind !== vscode.QuickPickItemKind.Separator)!;
            assert.strictEqual(it.label, 'HAL_Init');
            assert.ok(it.description?.includes('main.o'), `오브젝트명이 사라졌다: ${it.description}`);
            assert.ok(it.description?.includes('.text'), `섹션명이 사라졌다: ${it.description}`);
        });

        test('설명에 주소·크기·타입·영역이 모두 들어간다', () => {
            const items = buildGoToSymbolItems([entry({ name: 'main', addr: 0x08000000, size: 1024, type: 'CODE', region: 'FLASH' })], []);
            const desc = items.find(i => i.label === 'main')!.description ?? '';
            for (const token of ['0x08000000', '1.0 KB', 'CODE', 'FLASH']) {
                assert.ok(desc.includes(token), `${token} 이 설명에 없다: ${desc}`);
            }
            // 이름이 곧 label 일 때 같은 문자열을 설명에 한 번 더 적지 않는다.
            assert.ok(!desc.includes('main'), `label 과 같은 이름이 설명에 중복됐다: ${desc}`);
        });

        test('한쪽이 비면 그 구분선도 만들지 않는다', () => {
            assert.deepStrictEqual(buildGoToSymbolItems([], []), []);
            const onlyRegions = buildGoToSymbolItems([], regions);
            assert.strictEqual(onlyRegions.filter(i => i.kind === vscode.QuickPickItemKind.Separator).length, 1);
        });

        test('구분선은 목록에 실제로 든 것을 말한다 (심볼 / 섹션)', () => {
            // stripped 바이너리와 Listing 파일의 행은 심볼이 아니다.
            const withSymbols = buildGoToSymbolItems([entry()], [], true)[0].label;
            const withoutSymbols = buildGoToSymbolItems([entry()], [], false)[0].label;
            assert.notStrictEqual(withSymbols, withoutSymbols, '심볼 유무와 관계없이 같은 라벨을 쓰고 있다');
        });
    });

    suite('buildGoToSymbolTitle', () => {
        test('잘리지 않았으면 제목을 붙이지 않는다', () => {
            assert.strictEqual(buildGoToSymbolTitle(120, 120), undefined);
            assert.strictEqual(buildGoToSymbolTitle(5000, 4000), undefined, '전체보다 많이 보일 수는 없다');
        });

        test('잘렸으면 보이는 수와 전체 수를 함께 적는다', () => {
            // "5,000 / 12,400" 과 "5,000 / 940,000" 은 사용자에게 서로 다른 판단을
            // 부른다 — 보이는 수만 적으면 얼마나 가려졌는지 알 수 없다.
            const title = buildGoToSymbolTitle(5000, 128431) ?? '';
            assert.ok(/5[,.]000/.test(title), `보이는 수가 없다: ${title}`);
            assert.ok(/128[,.]431/.test(title), `전체 수가 없다: ${title}`);
            // 제목은 한 줄로 말줄임되므로 길면 뒤가 잘린다.
            assert.ok(title.length <= 48, `제목이 길어 잘린다 (${title.length}자): ${title}`);
            // 크기는 **무엇을 남길지**의 기준이고 목록 순서는 주소순이다.
            // 제목이 "크기순"이라고 하면 화면과 어긋난다.
            assert.ok(!/크기순|by size|sorted by/i.test(title), `표시 순서를 잘못 알린다: ${title}`);
        });
    });

    suite('호스트 → 웹뷰 메시지 계약', () => {
        // 이 메시지가 이 기능의 유일한 연결선이다. 키 이름이 한쪽만 바뀌면
        // 테스트는 전부 통과하는데 제품에서는 아무 일도 일어나지 않는다.
        test('웹뷰가 읽는 키를 호스트가 모두 보낸다', () => {
            const html = webviewHtml;
            const dispatch = html.match(/revealEntry\((msg\.[^)]*)\)/);
            assert.ok(dispatch, '웹뷰의 revealEntry 호출을 찾지 못했다');
            const readKeys = dispatch![1].split(',').map(s => s.trim().replace('msg.', ''));
            assert.ok(readKeys.length > 0, '웹뷰가 메시지에서 아무 키도 읽지 않는다');

            const message = buildRevealEntryMessage(entry({ name: 'main', addr: 0x08000000, regionIndex: 3 }));
            for (const key of readKeys) {
                assert.ok(key in message, `웹뷰는 msg.${key} 를 읽는데 호스트는 보내지 않는다`);
                assert.notStrictEqual((message as any)[key], undefined, `msg.${key} 가 undefined 로 나간다`);
            }
            assert.strictEqual(message.command, 'revealEntry', '웹뷰 디스패처가 보는 command 이름이 달라졌다');
            assert.ok(html.includes("msg.command === 'revealEntry'"), '웹뷰가 이 command 를 받지 않는다');
        });
    });

    /**
     * 웹뷰의 revealEntry 를 **실제로 실행한다.** 바깥 스코프 변수(curQ · curMatch ·
     * vtMap …)를 shim 으로 만들어 주고, 호출 결과로 어떤 대상이 revealTarget 에
     * 넘어갔는지를 본다. matchSeg 도 웹뷰에서 함께 꺼내 쓴다 — 테스트가 사본을
     * 들고 있으면 진짜 구현이 바뀌어도 통과한다.
     */
    suite('웹뷰 revealEntry', () => {
        let source: string;
        let matchSegSource: string;
        let announceSource: string;
        let fmtSource: string;

        suiteSetup(() => {
            source = extractFn('function revealEntry(regionIndex, regionName, name, addr) {');
            matchSegSource = extractFn('function matchSeg(e, q) {');
            announceSource = extractFn('function announceReveal(text) {');
            fmtSource = extractFn('function fmt(template, values) {');
        });

        /** 표의 한 행. 검색어 판정에 쓰이는 필드까지 채운다. */
        function seg(over: Partial<Record<string, any>> = {}) {
            return { n: 'main', s: '', f: '', a: 0x100, ah: '0x00000100', sz: 16, ss: '16 B', t: 'CODE', ...over };
        }

        interface RunOptions {
            /** 영역별 행 목록. 기본은 FLASH 하나. */
            regions?: { name: string; segments: any[]; virtual?: boolean }[];
            segments?: any[];
            /** 가상 스크롤 표로 다룰지 (false 면 DOM 행을 속성으로 찾는다) */
            virtual?: boolean;
            query?: string;
            matchList?: any[];
            curMatch?: number;
            /** DOM 행 순서 (정렬로 바뀔 수 있으므로 따로 준다) */
            rowOrder?: any[];
        }

        /** run() 이 fd/DOM 을 미리 만들 때 쓰는 판정 (웹뷰 matchSeg 와 같은 식). */
        function segMatches(e: any, q: string): boolean {
            return `${e.n} ${e.s} ${e.f} ${e.ah} ${e.ss} ${e.t}`.toLowerCase().includes(q);
        }

        function run(opts: RunOptions, regionIndex: number | undefined, region: string, name: string, addr: number) {
            const calls: any[] = [];
            const regions = opts.regions ?? [{ name: 'FLASH', segments: opts.segments ?? [], virtual: opts.virtual }];
            const q = (opts.query ?? '').toLowerCase();

            // DOM 은 지금 보이는 행만 담는다 — 검색이 걸러 낸 행은 표에 없다.
            // 이것이 "검색을 비워야 행을 찾을 수 있다"를 실제로 만든다.
            const visible = (segments: any[], query: string) =>
                (query ? segments.filter(s => segMatches(s, query)) : segments);
            const cards = regions.map((rg, i) => {
                const ordered = i === 0 && opts.rowOrder ? opts.rowOrder : rg.segments;
                return {
                    idx: i,
                    rows: [] as any[],
                    render(query: string) {
                        this.rows = visible(ordered, query).map(s => ({
                            attrs: { 'data-sort-addr': String(s.a), 'data-sort-name': s.n },
                            getAttribute(key: string) { return (this.attrs as any)[key] ?? null; },
                        }));
                    },
                    querySelectorAll: function (this: any) { return this.rows; },
                };
            });
            cards.forEach(c => c.render(q));

            // vtMap 은 **영역을 펼칠 때** 채워진다(renderDetail). 미리 채워 두면
            // "펼치기가 행 찾기보다 먼저여야 한다"는 순서를 검사할 수 없다.
            const vtMap = new Map<number, any>();
            const expand = (idx: number) => {
                const rg = regions[idx];
                if (rg && rg.virtual !== false) {
                    vtMap.set(idx, { idx, fd: visible(rg.segments, deps.curQNow) });
                }
            };

            const deps: any = {
                RD: regions.map(rg => ({ name: rg.name, segments: rg.segments })),
                vtMap,
                matchList: opts.matchList ?? [],
                curMatch: opts.curMatch ?? -1,
                curQ: q,
                curQNow: q,
                searchInput: { value: opts.query ?? '' },
                calls,
                expand,
                cards,
                S: { revealed: 'moved {name} {addr}', revealedAfterClear: 'cleared {name} {addr}' },
                document: {
                    querySelector: (sel: string) => {
                        const m = sel.match(/data-idx="(\d+)"/);
                        return m ? (cards[Number(m[1])] ?? null) : null;
                    },
                },
                regionIndex, region, name, addr,
            };

            const shim = `
                let curQ = deps.curQ, curMatch = deps.curMatch;
                const RD = deps.RD, vtMap = deps.vtMap, matchList = deps.matchList;
                const searchInput = deps.searchInput, document = deps.document, calls = deps.calls;
                const S = deps.S, regMatchInfo = { textContent: '' };
                ${matchSegSource}
                ${announceSource}
                ${fmtSource}
                function doSearch() {
                    curQ = searchInput.value.trim().toLowerCase();
                    deps.curQNow = curQ;
                    calls.push({ fn: 'doSearch', q: curQ });
                    vtMap.forEach(function(vt) {
                        vt.fd = curQ ? RD[vt.idx].segments.filter(function(e) { return matchSeg(e, curQ); }) : RD[vt.idx].segments;
                    });
                    deps.cards.forEach(function(c) { c.render(curQ); });
                }
                function ensureRegionExpanded(idx) { calls.push({ fn: 'ensureRegionExpanded', idx: idx }); deps.expand(idx); }
                function revealTarget(m, force, focusRow) { calls.push({ fn: 'revealTarget', m: m, force: force, focusRow: focusRow }); }
                function scrollToRegionCard(card) { calls.push({ fn: 'scrollToRegionCard', idx: card ? card.idx : null }); return Boolean(card); }
                function setRegionExpanded() {}
                ${source}
                revealEntry(deps.regionIndex, deps.region, deps.name, deps.addr);
                return { curQ: curQ, curMatch: curMatch, announced: regMatchInfo.textContent };
            `;
            const out = new Function('deps', shim)(deps) as { curQ: string; curMatch: number; announced: string };
            return {
                ...out,
                calls,
                cards,
                rows: cards[0].rows,
                revealed: calls.find(c => c.fn === 'revealTarget'),
                fellBack: calls.find(c => c.fn === 'scrollToRegionCard'),
                searched: calls.filter(c => c.fn === 'doSearch'),
            };
        }

        test('가상 스크롤 표에서 행 번호를 찾아 revealTarget 에 넘긴다', () => {
            const segments = [seg({ n: 'a', a: 0x100 }), seg({ n: 'main', a: 0x200 }), seg({ n: 'z', a: 0x300 })];
            const r = run({ segments, virtual: true }, 0, 'FLASH', 'main', 0x200);
            assert.deepStrictEqual(r.revealed?.m, { k: 'vt', vi: 0, r: 1 }, '가상 표는 행 번호로 이동해야 한다');
            assert.strictEqual(r.revealed?.force, true, '명령으로 이동할 때는 항상 화면 가운데로 온다');
            assert.strictEqual(r.revealed?.focusRow, true, '키보드 사용자가 이어 가려면 행이 포커스를 받아야 한다');
        });

        test('행을 찾기 전에 영역을 펼친다 — 가상 표는 펼쳐야 존재한다', () => {
            // vtMap 은 renderDetail 이 채우므로, 펼치기가 뒤로 가면 가상 영역의
            // 행을 영영 못 찾는다 (이 릴리스가 고친 세 가지 중 하나).
            const segments = [seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: true }, 0, 'FLASH', 'main', 0x200);
            const order = r.calls.map(c => c.fn);
            assert.ok(
                order.indexOf('ensureRegionExpanded') < order.indexOf('revealTarget'),
                `펼치기가 이동보다 뒤에 있다: ${order.join(' → ')}`
            );
            assert.ok(r.revealed, '펼치지 않아 행을 찾지 못했다');
        });

        test('일반 표에서는 순서가 아니라 속성으로 행을 찾는다 (정렬 내성)', () => {
            const segments = [seg({ n: 'a', a: 0x100 }), seg({ n: 'main', a: 0x200 })];
            // 사용자가 크기로 정렬해 DOM 순서가 뒤집힌 상태.
            const r = run({ segments, virtual: false, rowOrder: [segments[1], segments[0]] }, 0, 'FLASH', 'main', 0x200);
            assert.strictEqual(r.revealed?.m.k, 'el');
            assert.strictEqual(r.revealed?.m.el, r.rows[0], '정렬된 DOM 에서 엉뚱한 행을 집었다');
        });

        test('검색이 대상을 걸러 내고 있으면 검색을 비운 뒤 이동한다 (가상 표)', () => {
            const segments = [seg({ n: 'zzz', a: 0x100 }), seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: true, query: 'zzz' }, 0, 'FLASH', 'main', 0x200);
            assert.deepStrictEqual(r.searched.map(c => c.q), [''], '검색을 비우지 않으면 대상 행이 표에 없다');
            assert.strictEqual(r.curQ, '');
            assert.deepStrictEqual(r.revealed?.m, { k: 'vt', vi: 0, r: 1 });
        });

        test('검색이 대상을 걸러 내고 있으면 검색을 비운 뒤 이동한다 (일반 표)', () => {
            // 일반 표는 걸러진 행이 DOM 에 아예 없다 — 검색을 비워야 다시 생긴다.
            const segments = [seg({ n: 'zzz', a: 0x100 }), seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: false, query: 'zzz' }, 0, 'FLASH', 'main', 0x200);
            assert.deepStrictEqual(r.searched.map(c => c.q), ['']);
            assert.strictEqual(r.revealed?.m.k, 'el');
            assert.strictEqual(r.revealed?.m.el, r.rows[1], '검색을 비운 뒤의 DOM 에서 행을 찾아야 한다');
        });

        test('검색이 대상을 포함하면 검색을 유지한다', () => {
            const segments = [seg({ n: 'main_init', a: 0x100 }), seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: true, query: 'main' }, 0, 'FLASH', 'main', 0x200);
            assert.deepStrictEqual(r.searched, [], '사용자가 좁혀 둔 화면을 명령이 되돌리면 안 된다');
            assert.deepStrictEqual(r.revealed?.m, { k: 'vt', vi: 0, r: 1 });
        });

        test('검색 중이면 이동한 행을 현재 위치로 잡는다', () => {
            // 그러지 않으면 바로 이어 누른 ◀/▶ 가 직전 위치의 다음 결과로 튄다.
            const segments = [seg({ n: 'main_init', a: 0x100 }), seg({ n: 'main', a: 0x200 })];
            const matchList = [{ k: 'vt', vi: 0, r: 0 }, { k: 'vt', vi: 0, r: 1 }];
            const r = run({ segments, virtual: true, query: 'main', matchList, curMatch: 0 }, 0, 'FLASH', 'main', 0x200);
            assert.strictEqual(r.curMatch, 1, '검색 결과 목록에서의 현재 위치가 갱신되지 않았다');
        });

        test('매치 목록에 없는 행으로 가면 현재 위치를 건드리지 않는다', () => {
            const segments = [seg({ n: 'main_init', a: 0x100 }), seg({ n: 'main', a: 0x200 })];
            const matchList = [{ k: 'vt', vi: 9, r: 5 }];
            const r = run({ segments, virtual: true, query: 'main', matchList, curMatch: 0 }, 0, 'FLASH', 'main', 0x200);
            assert.strictEqual(r.curMatch, 0, '엉뚱한 위치를 현재로 잡으면 n / N 카운터가 거짓말을 한다');
        });

        test('이름이 겹치는 영역은 순번으로 갈린다', () => {
            // memoryMap.regions 는 사용자가 직접 쓰는 파일이라 이름 중복을 막지 않는다.
            const first = [seg({ n: 'main', a: 0x100 })];
            const second = [seg({ n: 'x', a: 0x300 }), seg({ n: 'main', a: 0x200 })];
            const r = run({
                regions: [{ name: 'RAM', segments: first, virtual: true }, { name: 'RAM', segments: second, virtual: true }],
            }, 1, 'RAM', 'main', 0x200);
            assert.deepStrictEqual(r.revealed?.m, { k: 'vt', vi: 1, r: 1 }, '이름으로만 찾으면 첫 RAM 카드로 가서 조용히 실패한다');
        });

        test('순번이 어긋나면 이름으로 되짚는다', () => {
            const segments = [seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: true }, 99, 'FLASH', 'main', 0x200);
            assert.deepStrictEqual(r.revealed?.m, { k: 'vt', vi: 0, r: 0 });
        });

        test('이동했다는 사실을 문장으로 알린다', () => {
            const segments = [seg({ n: 'main', a: 0x200, ah: '0x00000200' })];
            const moved = run({ segments, virtual: true }, 0, 'FLASH', 'main', 0x200);
            assert.ok(moved.announced.includes('main') && moved.announced.includes('0x00000200'),
                `이동 안내가 비어 있다: ${moved.announced}`);

            // 검색을 지운 경우는 그 사실까지 남아야 한다 — 사용자가 직접 친 검색어다.
            const cleared = run({ segments: [seg({ n: 'zzz', a: 0x100 }), segments[0]], virtual: true, query: 'zzz' }, 0, 'FLASH', 'main', 0x200);
            assert.notStrictEqual(cleared.announced, moved.announced, '검색을 지운 것과 그냥 이동한 것이 같은 문구다');
        });

        test('행을 못 찾으면 최소한 그 영역으로 데려간다', () => {
            // 조용한 무반응은 이 릴리스가 고친 바로 그 증상이다.
            const segments = [seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: true }, 0, 'FLASH', 'nope', 0x999);
            assert.strictEqual(r.revealed, undefined, '없는 행으로 이동하면 안 된다');
            assert.strictEqual(r.fellBack?.idx, 0, '아무 일도 하지 않고 끝났다');
        });

        test('없는 영역이면 아무 일도 하지 않는다', () => {
            const segments = [seg({ n: 'main', a: 0x200 })];
            const r = run({ segments, virtual: true }, undefined, 'NOPE', 'main', 0x200);
            assert.strictEqual(r.revealed, undefined);
            assert.strictEqual(r.fellBack, undefined, '영역조차 없는데 카드로 스크롤을 시도했다');
        });
    });

    /**
     * 정렬은 rd.segments 를 **제자리에서** 재배열한다. 가상 표의 강조 대상은 행
     * 번호로 기억되므로, 재배열 뒤 그 번호에는 다른 심볼이 앉아 있다 — 이동한
     * 적 없는 행이 "방금 이동한 행"으로 칠해지는 것이 이 검사가 막는 결함이다.
     */
    suite('웹뷰 정렬 후 강조 재동기화', () => {
        let source: string;

        suiteSetup(() => {
            source = extractFn('function resyncCurrentTargetAfterSort(idx) {');
        });

        /** target 이 함수면 공유 el 을 받아 만든다 (일반 표 대상 검사용). */
        function run(target: any, opts: { fd?: any[]; sameCard?: boolean } = {}) {
            const vtMap = new Map<number, any>();
            if (opts.fd) { vtMap.set(0, { idx: 0, fd: opts.fd }); }
            const el = { tag: 'tr' };
            if (typeof target === 'function') { target = target(el); }
            const card = { contains: (node: any) => opts.sameCard !== false && node === el };
            const deps: any = {
                vtMap,
                currentTarget: target,
                currentMatchEl: { classList: { removed: [] as string[], remove(c: string) { this.removed.push(c); } } },
                document: { querySelector: () => card },
                el,
            };
            const shim = `
                let currentTarget = deps.currentTarget, currentMatchEl = deps.currentMatchEl;
                const vtMap = deps.vtMap, document = deps.document;
                function clearCurrentTarget() {
                    if (currentMatchEl) { currentMatchEl.classList.remove('current-match'); }
                    currentMatchEl = null;
                    currentTarget = null;
                }
                ${source}
                resyncCurrentTargetAfterSort(0);
                return { currentTarget: currentTarget, currentMatchEl: currentMatchEl };
            `;
            const out = new Function('deps', shim)(deps) as any;
            // shim 이 지역 변수만 바꾸므로, 강조 해제 여부는 주입한 스텁에서 본다.
            return { ...deps, ...out, stub: deps.currentMatchEl };
        }

        test('정렬로 자리가 바뀐 행을 객체로 다시 찾아 번호를 고친다', () => {
            const a = { n: 'a' }, b = { n: 'main' }, c = { n: 'z' };
            // 이동 당시 main 은 1번, 정렬 뒤에는 2번이다.
            const r = run({ k: 'vt', vi: 0, r: 1, seg: b }, { fd: [c, a, b] });
            assert.strictEqual(r.currentTarget?.r, 2, '옛 번호를 그대로 두면 다른 심볼이 강조된다');
            assert.strictEqual(r.currentTarget.seg, b, '대상이 바뀌었다');
        });

        test('정렬 뒤 목록에서 사라졌으면 강조를 놓는다', () => {
            const gone = { n: 'gone' };
            const r = run({ k: 'vt', vi: 0, r: 0, seg: gone }, { fd: [{ n: 'other' }] });
            assert.strictEqual(r.currentTarget, null, '틀린 곳을 가리키느니 강조가 없는 편이 낫다');
            assert.strictEqual(r.currentMatchEl, null);
            assert.deepStrictEqual(r.stub.classList.removed, ['current-match']);
        });

        test('다른 영역을 정렬한 것이면 건드리지 않는다', () => {
            const seg = { n: 'main' };
            const r = run({ k: 'vt', vi: 3, r: 7, seg }, { fd: [seg] });
            assert.strictEqual(r.currentTarget?.r, 7, '남의 영역 정렬에 내 강조가 흔들렸다');
        });

        test('일반 표의 행 참조는 곧 끊어지므로 놓는다', () => {
            // 정렬은 tbody 를 통째로 다시 그린다 — 들고 있던 <tr> 은 문서에서
            // 떨어져 나가므로, 그 참조로 강조를 되살릴 방법이 없다.
            const r = run((el: any) => ({ k: 'el', el }));
            assert.strictEqual(r.currentTarget, null);
            assert.deepStrictEqual(r.stub.classList.removed, ['current-match'], '떨어져 나갈 행의 강조를 지우지 않았다');
        });

        test('다른 카드의 행이면 건드리지 않는다', () => {
            const r = run((el: any) => ({ k: 'el', el }), { sameCard: false });
            assert.notStrictEqual(r.currentTarget, null, '남의 카드 정렬에 내 강조가 지워졌다');
        });

        test('정렬 경로가 renderVT 보다 먼저 재동기화한다', () => {
            // 순서가 뒤집히면 이미 옛 번호로 칠한 뒤라 이 수정이 무의미해진다.
            const sortFn = extractFn('function sortRegionTable(th) {');
            const resyncAt = sortFn.indexOf('resyncCurrentTargetAfterSort(idx)');
            const renderAt = sortFn.indexOf('renderVT(vt)');
            assert.ok(resyncAt >= 0, '정렬이 강조 대상을 재동기화하지 않는다');
            assert.ok(renderAt >= 0, '정렬이 가상 표를 다시 그리지 않는다 — 검사 전제가 깨졌다');
            assert.ok(resyncAt < renderAt, '재동기화가 렌더보다 뒤에 있다 — 옛 번호로 칠한 뒤가 된다');
        });
    });

});
