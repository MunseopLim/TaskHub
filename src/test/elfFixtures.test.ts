import * as assert from 'assert';
import { buildElf32WithSymbols, buildMinimalElf32 } from './fixtures/elfFixtures';
import { computeSymbolUsage, parseElf32 } from '../elfParser';

/**
 * 픽스처 자체의 검증 (0.6.31).
 *
 * Memory Map 웹뷰는 **입력에 따라 다른 분기를 렌더한다.** 심볼이 없는 최소
 * ELF는 region 상세 표도 Object Summary도 그리지 않으므로, 그 마크업의 결함은
 * 어떤 검사로도 보이지 않는다 — 0.6.26 탐지기가 `Function ▶`을 놓친 이유의
 * 절반이 이것이었다(나머지 절반은 로케일 의존, 0.6.27에서 수정).
 *
 * 그래서 픽스처는 "테스트 도우미"가 아니라 **커버리지 경계를 정하는 물건**이다.
 * 조용히 망가지면(심볼 테이블 오프셋이 어긋나 파서가 심볼을 0개로 읽는 등)
 * 그걸 쓰는 테스트들이 아무 신호 없이 빈 분기를 검사하며 통과한다. 이 파일이
 * 그 전제를 직접 못박는다.
 */
suite('ELF 픽스처', () => {

    test('최소 ELF는 파싱되지만 심볼이 없다 (이 픽스처의 한계를 명시)', () => {
        const result = parseElf32(buildMinimalElf32());

        assert.strictEqual(result.symbols.length, 0);
        assert.ok(result.sections.some(s => s.name === '.text'));
    });

    test('심볼 ELF는 FUNC/OBJECT 심볼을 모두 읽는다', () => {
        const result = parseElf32(buildElf32WithSymbols());

        const names = result.symbols.map(s => s.name).sort();
        assert.deepStrictEqual(
            names,
            ['HAL_GPIO_Init', 'SystemInit', 'g_buffer', 'g_config', 'main'],
            '심볼이 하나라도 누락되면 region 상세 표가 그만큼 빈다'
        );

        const main = result.symbols.find(s => s.name === 'main');
        assert.strictEqual(main?.type, 'FUNC');
        assert.strictEqual(main?.addr, 0x08000000);
        assert.strictEqual(main?.size, 0x120);

        const config = result.symbols.find(s => s.name === 'g_config');
        assert.strictEqual(config?.type, 'OBJECT', 'OBJECT 심볼이 없으면 RAM 영역 표가 비어 분기가 닫힌다');
    });

    test('네 섹션이 모두 읽히고 속성이 구분된다', () => {
        const { sections } = parseElf32(buildElf32WithSymbols());
        const byName = new Map(sections.map(s => [s.name, s]));

        assert.ok(byName.get('.text')?.isExec, '.text가 CODE로 분류되어야 타입 열이 의미를 갖는다');
        assert.ok(byName.get('.data')?.isWrite);
        assert.ok(byName.get('.bss')?.isNoBits, '.bss가 NOBITS가 아니면 RAM 사용량 계산이 틀어진다');
        assert.ok(byName.get('.rodata')?.isAlloc);
    });

    test('심볼이 두 영역에 걸쳐 있어 region 카드가 2개 이상 생긴다', () => {
        const { symbols, sections } = parseElf32(buildElf32WithSymbols());
        const usage = computeSymbolUsage(symbols, sections, [
            { name: 'FLASH', origin: 0x08000000, size: 0x80000 },
            { name: 'RAM', origin: 0x20000000, size: 0x20000 },
        ]);

        assert.strictEqual(usage.length, 2);
        const flash = usage.find(u => u.region === 'FLASH');
        const ram = usage.find(u => u.region === 'RAM');
        assert.ok((flash?.sections.length ?? 0) >= 3, 'FLASH 상세 표가 비면 정렬 헤더 검사가 의미를 잃는다');
        assert.ok((ram?.sections.length ?? 0) >= 2, 'RAM 상세 표도 마찬가지');
    });

    test('심볼에 부모 섹션이 붙어 Object Summary가 묶일 수 있다', () => {
        const { symbols, sections } = parseElf32(buildElf32WithSymbols());
        const usage = computeSymbolUsage(symbols, sections, [
            { name: 'FLASH', origin: 0x08000000, size: 0x80000 },
        ]);

        const objects = new Set(
            (usage[0]?.sections ?? []).map(e => e.object).filter((o): o is string => !!o)
        );
        assert.ok(
            objects.size > 0,
            'object가 비면 Object Summary 표가 렌더되지 않아 그 분기가 다시 닫힌다'
        );
    });

    test('ELF 경로는 func(함수명)을 채우지 않는다 — listing 픽스처가 필요한 이유', () => {
        // 이 단언이 언젠가 깨진다면 그건 좋은 소식이다: ELF에서도 func을
        // 얻게 됐다는 뜻이므로, `Function ▶` 분기를 listing 없이 검사할 수
        // 있게 된다. 그때 webviewStringCoverage의 listing 테스트를 재검토할 것.
        const { symbols, sections } = parseElf32(buildElf32WithSymbols());
        const usage = computeSymbolUsage(symbols, sections, [
            { name: 'FLASH', origin: 0x08000000, size: 0x80000 },
        ]);

        assert.ok(
            !usage.some(u => u.sections.some(s => s.func)),
            'ELF에서 func이 나오기 시작했다면 픽스처 전략을 갱신할 것 (elfFixtures.ts 상단 표)'
        );
    });
});
