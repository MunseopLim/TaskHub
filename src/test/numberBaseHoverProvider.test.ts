import * as assert from 'assert';
import {
    NumberBaseHoverProvider,
    BitOperation,
    BitOperationType,
    detectBitOperation,
    calculateBitOperation,
    formatBitOperationResult,
    formatCopyableHoverValue,
    registerHoverCopyCommand,
    MAX_HOVER_COPY_LENGTH
} from '../numberBaseHoverProvider';
import * as vscode from 'vscode';
import { CompleteBitFieldInfo, extractBitFieldInfo } from '../sfrBitFieldParser';
import { RegisterDecoder } from '../registerDecoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function visibleMarkdownText(markdown: vscode.MarkdownString): string {
    return markdown.value.replace(/&nbsp;/g, ' ').replace(/\\([\\`*_{}\[\]()#+\-.!|$>])/g, '$1');
}

suite('NumberBaseHoverProvider Test Suite', () => {
    let provider: NumberBaseHoverProvider;

    setup(() => {
        provider = new NumberBaseHoverProvider();
    });

    test('처음에는 없던 taskhub_types.json을 세션 중 생성하면 다음 조회에서 읽는다', async () => {
        const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-hover-config-'));
        try {
            const workspaceFolder: vscode.WorkspaceFolder = {
                uri: vscode.Uri.file(workspacePath),
                name: 'hover-config',
                index: 0,
            };
            const testProvider = new NumberBaseHoverProvider(() => workspaceFolder);
            const document = { uri: vscode.Uri.file(path.join(workspacePath, 'main.c')) } as vscode.TextDocument;

            assert.strictEqual(await (testProvider as any).loadTypeConfig(document), undefined);

            fs.mkdirSync(path.join(workspacePath, '.vscode'), { recursive: true });
            fs.writeFileSync(path.join(workspacePath, '.vscode', 'taskhub_types.json'), JSON.stringify({
                types: { HANDLE: { size: 8, alignment: 8 } },
            }));

            const loaded = await (testProvider as any).loadTypeConfig(document);
            assert.strictEqual(loaded.types.HANDLE.size, 8);
        } finally {
            fs.rmSync(workspacePath, { recursive: true, force: true });
        }
    });

    suite('Struct size hover accuracy and guidance', () => {
        test('supported declarations show a configured estimate rather than a compiler result', async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'cpp', content: 'struct Sample { int x{}; char y; };'
            });
            const hover = await (new NumberBaseHoverProvider(() => undefined) as any).tryStructSizeInfo(document, new vscode.Position(0, 8));
            assert.ok(hover);
            const markdown = (hover.contents[0] as vscode.MarkdownString).value;
            assert.match(markdown, /Estimated Size|추정 크기/);
            assert.match(markdown, /8 bytes/);
            assert.match(markdown, /sizeof/);
            assert.match(markdown, /#include/);
        });

        for (const content of [
            'struct Sample { alignas(16) int x; char y; };',
            'struct alignas(16) Sample { int x; char y; };',
            'struct UnknownInner { UnknownType value; };\nstruct Sample { UnknownInner value; char y; };',
        ]) {
            test(`unsupported definitions show guidance without a successful size: ${content}`, async () => {
                const document = await vscode.workspace.openTextDocument({ language: 'cpp', content });
                const lines = content.split('\n');
                const lineIndex = lines.length - 1;
                const position = new vscode.Position(lineIndex, lines[lineIndex].indexOf('Sample') + 1);
                const hover = await (new NumberBaseHoverProvider(() => undefined) as any).tryStructSizeInfo(document, position);
                assert.ok(hover);
                const markdown = (hover.contents[0] as vscode.MarkdownString).value.replace(/&nbsp;/g, ' ');
                assert.match(markdown, /Cannot calculate|계산할 수 없습니다/);
                assert.match(markdown, /sizeof/);
                assert.doesNotMatch(markdown, /Estimated Size|Total Size|추정 크기/);
            });
        }
    });

    suite('Struct source snapshot freshness', () => {
        test('cached lines are immutable within a version and replaced after editing', () => {
            let content = '#pragma pack(1)\nstruct Sample { char first; int last; };';
            const document = {
                uri: vscode.Uri.parse('untitled:struct-cache'),
                version: 1,
                getText: () => content,
            };
            const first = (provider as any).getDocumentLines(document) as string[];
            assert.ok(Object.isFrozen(first));
            assert.strictEqual((provider as any).getDocumentLines(document), first);
            content = '#pragma pack()\nstruct Sample { char first; int last; };';
            document.version++;
            const next = (provider as any).getDocumentLines(document) as string[];
            assert.notStrictEqual(next, first);
            assert.ok(Object.isFrozen(next));
            assert.strictEqual(next[0], '#pragma pack()');
            assert.strictEqual(first[0], '#pragma pack(1)');
        });

        test('an edit while type configuration loads cannot return a stale struct hover', async () => {
            const document = {
                uri: vscode.Uri.parse('untitled:struct-pending'),
                version: 1,
                lineAt: () => ({ text: 'struct Sample { int value; };' }),
                getWordRangeAtPosition: () => new vscode.Range(0, 7, 0, 13),
                getText: (range?: vscode.Range) => range ? 'Sample' : 'struct Sample { int value; };',
            };
            (provider as any).loadTypeConfig = async () => {
                document.version++;
                return undefined;
            };
            const hover = await (provider as any).tryStructSizeInfo(document, new vscode.Position(0, 8));
            assert.strictEqual(hover, null);
        });
    });

    suite('Number Parsing Tests', () => {
        test('Parse hexadecimal with 0x prefix', () => {
            const result = (provider as any).parseNumber('0xFF');
            assert.strictEqual(result, 255);
        });

        test('Parse hexadecimal with 0X prefix (uppercase)', () => {
            const result = (provider as any).parseNumber('0XFF');
            assert.strictEqual(result, 255);
        });

        test('Parse hexadecimal with h suffix', () => {
            const result = (provider as any).parseNumber('FFh');
            assert.strictEqual(result, 255);
        });

        test('Parse hexadecimal with H suffix (uppercase)', () => {
            const result = (provider as any).parseNumber('FFH');
            assert.strictEqual(result, 255);
        });

        test('Parse binary with 0b prefix', () => {
            const result = (provider as any).parseNumber('0b11111111');
            assert.strictEqual(result, 255);
        });

        test('Parse binary with 0B prefix (uppercase)', () => {
            const result = (provider as any).parseNumber('0B11111111');
            assert.strictEqual(result, 255);
        });

        test('Parse decimal number', () => {
            const result = (provider as any).parseNumber('255');
            assert.strictEqual(result, 255);
        });

        test('Parse decimal number with digit separators', () => {
            const result = (provider as any).parseNumber('1\'000\'000');
            assert.strictEqual(result, 1000000);
        });

        test('Parse hexadecimal with digit separators', () => {
            const result = (provider as any).parseNumber('0xFF\'FF\'FF');
            assert.strictEqual(result, 0xFFFFFF);
        });

        test('Parse binary with digit separators', () => {
            const result = (provider as any).parseNumber('0b1111\'0000\'1111\'0000');
            assert.strictEqual(result, 0xF0F0);
        });

        test('Parse large 32-bit value', () => {
            const result = (provider as any).parseNumber('0xDEADBEEF');
            assert.strictEqual(result, 0xDEADBEEF);
        });

        test('Parse 64-bit value', () => {
            const result = (provider as any).parseNumber('0xFE0000000');
            assert.strictEqual(result, 0xFE0000000);
        });

        test('Return null for invalid input', () => {
            const result = (provider as any).parseNumber('invalid');
            assert.strictEqual(result, null);
        });

        test('Return null for empty string', () => {
            const result = (provider as any).parseNumber('');
            assert.strictEqual(result, null);
        });
    });

    suite('Exact 64-bit Parsing & Display (M6 회귀 가드)', () => {
        // parseNumber는 parseInt 기반이라 2^53 초과 64-bit 리터럴의 진법
        // 변환값이 틀리게 표시됐다 (0xFFFFFFFFFFFFFFFF → 0x10000000000000000).

        test('parseNumberExact keeps plain number within 2^53', () => {
            assert.strictEqual((provider as any).parseNumberExact('0xFF'), 255);
            assert.strictEqual((provider as any).parseNumberExact('FFh'), 255);
            assert.strictEqual((provider as any).parseNumberExact('0b1111'), 15);
            assert.strictEqual((provider as any).parseNumberExact('255'), 255);
        });

        test('parseNumberExact returns exact BigInt above 2^53', () => {
            assert.strictEqual((provider as any).parseNumberExact('0xFFFFFFFFFFFFFFFF'), 0xFFFFFFFFFFFFFFFFn);
            assert.strictEqual((provider as any).parseNumberExact('0xFFFF\'FFFF\'FFFF\'FFFF'), 0xFFFFFFFFFFFFFFFFn);
            assert.strictEqual((provider as any).parseNumberExact('18446744073709551615'), 18446744073709551615n);
        });

        test('parseNumberExact returns null for invalid input', () => {
            assert.strictEqual((provider as any).parseNumberExact('invalid'), null);
            assert.strictEqual((provider as any).parseNumberExact(''), null);
        });

        test('hover content shows exact conversions for 0xFFFFFFFFFFFFFFFF', () => {
            const md = (provider as any).generateHoverContent(0xFFFFFFFFFFFFFFFFn, '0xFFFFFFFFFFFFFFFF');
            const text: string = md.value;
            assert.ok(text.includes('0xFFFFFFFFFFFFFFFF'), `hex must be exact: ${text}`);
            assert.ok(text.includes('18446744073709551615'), `dec must be exact: ${text}`);
            assert.ok(!text.includes('0x10000000000000000'), 'parseInt 기반 2^64 오표시 금지');
            assert.ok(text.includes('Bit Information (64-bit)'), '64-bit 비트 테이블 표시');
        });
    });

    suite('호버 값 개별 복사', () => {
        function copyValues(markdown: vscode.MarkdownString): string[] {
            // Escaped source text can contain the command name without becoming a link.
            return [...markdown.value.matchAll(/(?<!\\)\[\$\(copy\)\]\(command:taskhub\.copyHoverValue\?([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => {
                const args: unknown = JSON.parse(decodeURIComponent(match[1]));
                assert.ok(Array.isArray(args));
                assert.strictEqual(args.length, 1, '복사는 값 한 개만 전달해야 한다');
                assert.strictEqual(typeof args[0], 'string');
                return args[0];
            });
        }

        function assertCopyTrust(markdown: vscode.MarkdownString): void {
            assert.deepStrictEqual(markdown.isTrusted, { enabledCommands: ['taskhub.copyHoverValue'] });
            assert.strictEqual(markdown.supportThemeIcons, true);
        }

        const forgedCopyLink = `[$(copy)](command:taskhub.copyHoverValue?${encodeURIComponent(JSON.stringify(['0xBAD']))} "Copy 0xFF")`;
        const hostileText = `${forgedCopyLink} | injected cell " $(copy) \`\n| injected | row |`;

        function assertOnlyGeneratedCopyIcons(markdown: vscode.MarkdownString, expected: string[]): void {
            assert.deepStrictEqual(copyValues(markdown), expected);
            assert.strictEqual([...markdown.value.matchAll(/(?<!\\)\$\(copy\)/g)].length, expected.length,
                '소스 텍스트에서 온 theme icon은 렌더링되지 않아야 한다');
            assert.doesNotMatch(markdown.value, /^\| injected \| row \|/m, '소스 개행으로 표 행을 만들 수 없다');
        }

        test('확장 활성화가 실제 복사 명령을 등록한다', async () => {
            const extension = vscode.extensions.getExtension('Munseop.taskhub');
            assert.ok(extension);
            await extension.activate();
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('taskhub.copyHoverValue'));
        });

        test('숫자는 접두사를 포함한 각 진법의 값만 복사하고 64비트 정밀도를 유지한다', () => {
            for (const [value, expected] of [
                [0, ['0x0', '0', '0b0']],
                [255, ['0xFF', '255', '0b11111111']],
                [-5, ['-0x5', '-5', '-0b101']],
                [-0xFFFFFFFFFFFFFFFFn, ['-0xFFFFFFFFFFFFFFFF', '-18446744073709551615', '-0b' + '1'.repeat(64)]],
                [0xFFFFFFFFFFFFFFFFn, ['0xFFFFFFFFFFFFFFFF', '18446744073709551615', '0b' + '1'.repeat(64)]],
            ] as const) {
                const markdown = (provider as any).generateHoverContent(value, String(value)) as vscode.MarkdownString;
                assert.deepStrictEqual(copyValues(markdown), [...expected]);
                assertCopyTrust(markdown);
            }
        });

        test('숫자 매크로의 변환값은 복사할 수 있고 비수치 매크로에는 복사 링크가 없다', () => {
            const numeric = (provider as any).generateMacroExpansionContent('FLAGS', {}, 255) as vscode.MarkdownString;
            assert.deepStrictEqual(copyValues(numeric), ['0xFF', '255', '0b11111111']);
            assertCopyTrust(numeric);

            const nonnumeric = (provider as any).generateMacroExpansionContent('TEXT', {}, null) as vscode.MarkdownString;
            assert.deepStrictEqual(copyValues(nonnumeric), []);
        });

        test('레지스터 전체 값과 디코드 필드는 각 진법을 독립적으로 복사한다', () => {
            const decoded = new RegisterDecoder().decodeValue(0x1234, {
                name: 'CONTROL',
                totalBits: 32,
                fields: [{ name: 'MODE', bitStart: 0, bitEnd: 3, bitWidth: 4 }],
            });
            const markdown = (provider as any).generateRegisterDecodingContent(decoded) as vscode.MarkdownString;
            const values = copyValues(markdown);
            assert.deepStrictEqual(values.slice(0, 3), ['0x1234', '4660', '0b1001000110100']);
            assert.deepStrictEqual(values.slice(3), ['4', '0x4', '0b0100']);
            assertCopyTrust(markdown);
        });

        test('매크로 음수는 부호가 접두사 앞에 오는 진법 값으로 복사한다', async () => {
            const document = await vscode.workspace.openTextDocument({ language: 'cpp', content: '#define NEGATIVE -5' });
            const hover = (provider as any).tryMacroExpansion(document, new vscode.Position(0, 9)) as vscode.Hover;
            assert.ok(hover);
            assert.deepStrictEqual(copyValues(hover.contents[0] as vscode.MarkdownString), ['-0x5', '-5', '-0b101']);
        });

        test('안전한 정수가 아닌 변환값은 숫자·매크로·레지스터 복사 링크를 만들지 않는다', () => {
            for (const value of [Number.MAX_SAFE_INTEGER + 1, 4.722366482869645e+21, Infinity, -Infinity, NaN, 1.5]) {
                const numeric = (provider as any).generateHoverContent(value, String(value)) as vscode.MarkdownString;
                const macro = (provider as any).generateMacroExpansionContent('UNSAFE', {}, value) as vscode.MarkdownString;
                const decoded = new RegisterDecoder().decodeValue(value, {
                    name: 'CONTROL', totalBits: 32,
                    fields: [{ name: 'MODE', bitStart: 0, bitEnd: 3, bitWidth: 4 }],
                });
                const register = (provider as any).generateRegisterDecodingContent(decoded) as vscode.MarkdownString;
                assert.deepStrictEqual(copyValues(numeric), [], `일반 숫자: ${value}`);
                assert.deepStrictEqual(copyValues(macro), [], `매크로: ${value}`);
                assert.deepStrictEqual(copyValues(register), [], `레지스터 필드도 부정확한 값을 노출하면 안 된다: ${value}`);
            }
        });

        test('0으로 나누는 실제 매크로에는 Infinity 복사 링크가 없다', async () => {
            const document = await vscode.workspace.openTextDocument({ language: 'cpp', content: '#define DIV_ZERO (1/0)' });
            const hover = (provider as any).tryMacroExpansion(document, new vscode.Position(0, 9)) as vscode.Hover | null;
            if (hover) {
                assert.deepStrictEqual(copyValues(hover.contents[0] as vscode.MarkdownString), []);
            }
        });

        test('실제 매크로는 피연산자와 중간 계산의 정밀도가 유지될 때만 복사를 제공한다', async () => {
            for (const [expression, expected] of [
                ['(9007199254740993 - 9007199254740992)', []],
                ['(9007199254740991 + 2) - 9007199254740991', []],
                ['(1 << 5) | 3', ['0x23', '35', '0b100011']],
            ] as const) {
                const document = await vscode.workspace.openTextDocument({
                    language: 'cpp', content: `#define PRECISION ${expression}`,
                });
                const hover = (provider as any).tryMacroExpansion(document, new vscode.Position(0, 9)) as vscode.Hover | null;
                const values = hover ? copyValues(hover.contents[0] as vscode.MarkdownString) : [];
                assert.deepStrictEqual(values, [...expected], expression);
            }
        });

        test('큰 레지스터 리터럴은 일반 호버로 돌아가 정확한 BigInt 변환을 복사한다', async () => {
            const content = [
                'struct CONTROL {',
                '    unsigned mode : 4; // [3:0] [RW][0x0] Mode',
                '};',
                'CONTROL reg = 0xFFFFFFFFFFFFFFFF;',
            ].join('\n');
            const document = await vscode.workspace.openTextDocument({ language: 'cpp', content });
            const originalExecuteCommand = vscode.commands.executeCommand;
            const cancellation = new vscode.CancellationTokenSource();
            try {
                (vscode.commands as any).executeCommand = async () => [];
                const hover = await provider.provideHover(document, new vscode.Position(3, 17), cancellation.token);
                assert.ok(hover);
                const markdown = hover.contents[0] as vscode.MarkdownString;
                assert.deepStrictEqual(copyValues(markdown), [
                    '0xFFFFFFFFFFFFFFFF', '18446744073709551615', '0b' + '1'.repeat(64),
                ]);
                assert.doesNotMatch(markdown.value, /Decoded Bit Fields/);
            } finally {
                vscode.commands.executeCommand = originalExecuteCommand;
                cancellation.dispose();
            }
        });

        test('신뢰된 레지스터의 이름·필드·설명·접근 유형은 명령이나 표 셀을 주입할 수 없다', () => {
            const decoded = new RegisterDecoder().decodeValue(0x1234, {
                name: hostileText,
                totalBits: 32,
                fields: [{
                    name: hostileText, bitStart: 0, bitEnd: 3, bitWidth: 4,
                    description: hostileText, accessType: hostileText,
                }],
            });
            const markdown = (provider as any).generateRegisterDecodingContent(decoded) as vscode.MarkdownString;
            assertOnlyGeneratedCopyIcons(markdown, ['0x1234', '4660', '0b1001000110100', '4', '0x4', '0b0100']);
            const rows = markdown.value.split('\n').filter(line => line.startsWith('|'));
            assert.strictEqual(rows.length, 3);
            for (const row of rows) {
                assert.strictEqual([...row.matchAll(/(?<!\\)\|/g)].length, 7, '필드 설명이 표 열 수를 바꾸면 안 된다');
            }
        });

        test('매크로 이름은 복사 아이콘이나 링크를 만들지 않는다', () => {
            const markdown = (provider as any).generateMacroExpansionContent(hostileText, {}, 255) as vscode.MarkdownString;
            assertOnlyGeneratedCopyIcons(markdown, ['0xFF', '255', '0b11111111']);
        });

        test('SFR 파서가 허용한 주석과 계층·필드·파일 경로는 텍스트로 표시한다', () => {
            const parsed = extractBitFieldInfo(`Type mode : 3; // [12:10] [RW][0x0] ${forgedCopyLink} | " $(copy)`);
            assert.ok(parsed?.commentInfo);
            assert.ok(parsed.commentInfo.description.includes(forgedCopyLink), '실제 주석 파서가 공격 문자열을 통과시키는 경로를 검증한다');
            const cases = [
                { info: parsed, scopes: [], filePath: 'vendor/register.h' },
                { info: { ...parsed, fieldName: hostileText }, scopes: [], filePath: 'vendor/register.h' },
                { info: parsed, scopes: [{ type: 'struct', name: hostileText, lineNumber: 0 }], filePath: 'vendor/register.h' },
                { info: parsed, scopes: [], filePath: hostileText },
                ...(['bitPosition', 'accessType', 'resetValue', 'description'] as const).map(key => ({
                    info: { ...parsed, commentInfo: { ...parsed.commentInfo!, [key]: hostileText } },
                    scopes: [], filePath: 'vendor/register.h',
                })),
            ];
            for (const { info, scopes, filePath } of cases) {
                const markdown = (provider as any).generateBitFieldHoverContent(info, scopes, filePath, 1) as vscode.MarkdownString;
                assertOnlyGeneratedCopyIcons(markdown, ['0x00001C00']);
                const rows = markdown.value.split('\n').filter(line => line.startsWith('|'));
                assert.strictEqual(rows.length, 8);
                for (const row of rows) {
                    assert.strictEqual([...row.matchAll(/(?<!\\)\|/g)].length, 3, 'SFR 소스 텍스트가 표 열 수를 바꾸면 안 된다');
                }
            }
        });

        test('비트 연산 식에 포함된 소스 문법은 복사 링크를 만들지 않는다', () => {
            const operation: BitOperation = {
                variable: 'flags', operator: BitOperationType.OR_ASSIGN, operand: 0x80,
                isAssignment: true, expression: hostileText, start: 0, end: hostileText.length,
            };
            const markdown = formatBitOperationResult(calculateBitOperation(operation, 0x0F));
            assertOnlyGeneratedCopyIcons(markdown, [
                '0x0000000F', '15', '0b' + '0'.repeat(28) + '1111',
                '0x0000008F', '143', '0b' + '0'.repeat(24) + '10001111',
            ]);
        });

        test('값 포매터는 숫자 리터럴 외 텍스트와 길이 초과 입력에 링크를 만들지 않는다', () => {
            for (const invalid of [
                hostileText, '0x-5', '0b-101', 'Infinity', 'NaN', '1e+21', '1.5',
                ' 255', '255 ', '255\n', '0x1" title', '0x1|cell', '0b2', '',
                '0'.repeat(MAX_HOVER_COPY_LENGTH + 1),
            ]) {
                const markdown = new vscode.MarkdownString(formatCopyableHoverValue(invalid), true);
                assertOnlyGeneratedCopyIcons(markdown, []);
                assert.doesNotMatch(markdown.value, /(?<!\\)\|/, '잘못된 포매터 입력도 표 셀을 만들 수 없다');
            }
        });

        test('비트 연산은 이전 값과 결과 값의 표시 패딩을 그대로 복사한다', () => {
            for (const isConstant of [false, true]) {
                const operation: BitOperation = {
                    variable: isConstant ? undefined : 'flags',
                    operator: isConstant ? BitOperationType.OR : BitOperationType.OR_ASSIGN,
                    operand: 0x80,
                    isAssignment: !isConstant,
                    isConstant,
                    leftOperand: isConstant ? 0x0F : undefined,
                    expression: isConstant ? '0x0F | 0x80' : 'flags |= 0x80',
                    start: 0,
                    end: 13,
                };
                const markdown = formatBitOperationResult(calculateBitOperation(operation, 0x0F));
                assert.deepStrictEqual(copyValues(markdown), [
                    '0x0000000F', '15', '0b' + '0'.repeat(28) + '1111',
                    '0x0000008F', '143', '0b' + '0'.repeat(24) + '10001111',
                ]);
                assertCopyTrust(markdown);
            }
        });

        test('SFR 정의에서 조립한 최종 호버에서도 마스크 복사 명령만 활성화된다', async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'cpp',
                content: `Type mode : 3; // [12:10] [RW][0x0] Mode ${forgedCopyLink} | " $(copy)`,
            });
            const originalExecuteCommand = vscode.commands.executeCommand;
            try {
                (vscode.commands as any).executeCommand = async (command: string) => {
                    if (command === 'vscode.executeDefinitionProvider') {
                        return [new vscode.Location(document.uri, new vscode.Range(0, 5, 0, 9))];
                    }
                    return [];
                };
                const hover = await (provider as any).tryBitFieldHover(document, new vscode.Position(0, 6)) as vscode.Hover;
                assert.ok(hover);
                const markdown = hover.contents[0] as vscode.MarkdownString;
                assertOnlyGeneratedCopyIcons(markdown, ['0x00001C00']);
                assertCopyTrust(markdown);
            } finally {
                vscode.commands.executeCommand = originalExecuteCommand;
            }
        });

        test('SFR 추가 정의의 파일 라벨과 URI는 가짜 복사 링크를 만들지 않는다', async () => {
            const document = await vscode.workspace.openTextDocument({
                language: 'cpp', content: 'Type mode : 3; // [12:10] [RW][0x0] Mode',
            });
            const originalExecuteCommand = vscode.commands.executeCommand;
            const originalOpenTextDocument = vscode.workspace.openTextDocument;
            try {
                for (const uri of [
                    vscode.Uri.from({ scheme: 'file', path: `/virtual/vendor (SDK)/${forgedCopyLink}.h` }),
                    vscode.Uri.from({ scheme: 'command', path: 'taskhub.copyHoverValue', query: JSON.stringify(['0xBAD']) }),
                ]) {
                    const secondDocument = {
                        uri,
                        lineCount: document.lineCount,
                        lineAt: (line: number) => document.lineAt(line),
                        getText: (range?: vscode.Range) => document.getText(range),
                    } as vscode.TextDocument;
                    (vscode.workspace as any).openTextDocument = async (target: vscode.Uri) => {
                        if (target.toString() === uri.toString()) {
                            return secondDocument;
                        }
                        return originalOpenTextDocument(target);
                    };
                    (vscode.commands as any).executeCommand = async (command: string) => {
                        if (command === 'vscode.executeDefinitionProvider') {
                            return [
                                new vscode.Location(document.uri, new vscode.Range(0, 5, 0, 9)),
                                new vscode.Location(uri, new vscode.Range(0, 5, 0, 9)),
                            ];
                        }
                        return [];
                    };
                    const hover = await (provider as any).tryBitFieldHover(document, new vscode.Position(0, 6)) as vscode.Hover;
                    assert.ok(hover);
                    const markdown = hover.contents[0] as vscode.MarkdownString;
                    assertOnlyGeneratedCopyIcons(markdown, ['0x00001C00']);
                    const additional = markdown.value.split('**Additional definitions:**\n\n')[1];
                    assert.ok(additional, '두 번째 정의의 파일 링크 경로를 검증한다');
                    const rawFileLabel = uri.scheme === 'command'
                        ? additional.slice(2, additional.indexOf(' - '))
                        : additional.match(/^- \[((?:\\.|[^\\\]])*)\]\(/)?.[1];
                    assert.ok(rawFileLabel, '추가 정의에서 파일 라벨을 분리한다');
                    // appendText escapes icons before Markdown escaping; the icon renderer
                    // consumes the remaining backslash after Markdown has been decoded.
                    const visibleFileLabel = visibleMarkdownText(new vscode.MarkdownString(rawFileLabel))
                        .replace(/\\(\$\([A-Za-z0-9~-]+\))/g, '$1');
                    const expectedFileLabel = `${uri.fsPath}:1`;
                    assert.strictEqual(visibleFileLabel, expectedFileLabel, '이스케이프 후에도 파일 라벨의 텍스트를 보존한다');
                    const targets = [...additional.matchAll(/(?<!\\)\]\(([^()\s]+)\)/g)].map(match => match[1]);
                    if (uri.scheme === 'command') {
                        assert.deepStrictEqual(targets, [], 'command 스킴의 정의 위치는 클릭 링크가 될 수 없다');
                    } else {
                        assert.strictEqual(targets.length, 1, '추가 정의에는 실제 파일 링크 한 개만 존재한다');
                        assert.match(targets[0], /%28/);
                        assert.match(targets[0], /%29/);
                        assert.match(targets[0], /%20/);
                        assert.doesNotMatch(targets[0], /[()\s]/);
                        const targetUri = vscode.Uri.parse(targets[0]);
                        assert.strictEqual(targetUri.scheme, 'file');
                        assert.strictEqual(targetUri.path, uri.path);
                        assert.strictEqual(targetUri.fragment, '1');
                    }
                }
            } finally {
                vscode.commands.executeCommand = originalExecuteCommand;
                vscode.workspace.openTextDocument = originalOpenTextDocument;
            }
        });

        test('비트 NOT의 음수 결과는 부호와 패딩이 올바른 값으로 복사된다', () => {
            const operation = detectBitOperation('~flags', 1);
            assert.ok(operation);
            const result = calculateBitOperation(operation, 0xFF);
            assert.strictEqual(result.afterValue, -256);
            const markdown = formatBitOperationResult(result);
            assert.deepStrictEqual(copyValues(markdown), [
                '0x000000FF', '255', '0b' + '0'.repeat(24) + '11111111',
                '-0x00000100', '-256', '-0b' + '0'.repeat(23) + '100000000',
            ]);
            assert.doesNotMatch(markdown.value, /0x0+-|0b0+-/);
        });

        test('비트 연산이 부정확한 입력을 32비트로 잘라도 복사 가능한 값으로 취급하지 않는다', () => {
            const operation: BitOperation = {
                variable: 'flags', operator: BitOperationType.AND, operand: 0xFF,
                isAssignment: false, expression: 'flags & 0xFF', start: 0, end: 12,
            };
            for (const [input, beforeValue] of [
                [{ ...operation, operand: Number.MAX_SAFE_INTEGER + 1 }, 15],
                [operation, Infinity],
                [{ ...operation, isConstant: true, leftOperand: Number.MAX_SAFE_INTEGER + 1 }, undefined],
            ] as const) {
                const result = calculateBitOperation(input, beforeValue);
                assert.ok(Number.isSafeInteger(result.afterValue), '비트 연산의 절삭으로 결과만 정수가 되는 경로');
                assert.deepStrictEqual(copyValues(formatBitOperationResult(result)), []);
            }
        });

        test('허용된 최장 16진수 리터럴의 2진수 링크를 실제 복사 명령이 처리한다', async () => {
            const extension = vscode.extensions.getExtension('Munseop.taskhub');
            assert.ok(extension);
            await extension.activate();
            const literal = '0x' + 'F'.repeat(NumberBaseHoverProvider.MAX_LINE_LENGTH - 2);
            assert.strictEqual(NumberBaseHoverProvider.isLineTooLongForHover(literal), false);
            const document = await vscode.workspace.openTextDocument({ language: 'cpp', content: literal });
            const originalClipboard = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard');
            assert.ok(originalClipboard);
            const copied: string[] = [];
            const cancellation = new vscode.CancellationTokenSource();
            try {
                Object.defineProperty(vscode.env, 'clipboard', {
                    configurable: true,
                    value: { writeText: async (value: string) => { copied.push(value); } },
                });
                const hover = await provider.provideHover(document, new vscode.Position(0, 2), cancellation.token);
                assert.ok(hover);
                const values = copyValues(hover.contents[0] as vscode.MarkdownString);
                assert.strictEqual(values.length, 3);
                const binary = '0b' + '1'.repeat((literal.length - 2) * 4);
                assert.strictEqual(values[2], binary);
                assert.ok(binary.length <= MAX_HOVER_COPY_LENGTH);
                await vscode.commands.executeCommand('taskhub.copyHoverValue', values[2]);
                assert.deepStrictEqual(copied, [binary]);
            } finally {
                Object.defineProperty(vscode.env, 'clipboard', originalClipboard);
                cancellation.dispose();
            }
        });

        test('복사 명령은 문자열을 그대로 쓰고 잘못된 인자와 클립보드 실패를 처리한다', async () => {
            const originalRegisterCommand = vscode.commands.registerCommand;
            const originalClipboard = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard');
            const originalShowErrorMessage = vscode.window.showErrorMessage;
            assert.ok(originalClipboard);
            const copied: string[] = [];
            const errors: string[] = [];
            let clipboardFails = false;
            let handler: ((value: unknown) => Promise<void>) | undefined;
            let registration: vscode.Disposable | undefined;
            try {
                (vscode.commands as any).registerCommand = (id: string, callback: typeof handler) => {
                    assert.strictEqual(id, 'taskhub.copyHoverValue');
                    handler = callback;
                    return new vscode.Disposable(() => {});
                };
                Object.defineProperty(vscode.env, 'clipboard', {
                    configurable: true,
                    value: { writeText: async (value: string) => {
                        if (clipboardFails) { throw new Error('clipboard unavailable'); }
                        copied.push(value);
                    } },
                });
                (vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); };
                registration = registerHoverCopyCommand();
                assert.ok(handler);

                const values = ['0x000000FF', '18446744073709551615', '-0x5', '-5', '-0b101', '0'.repeat(MAX_HOVER_COPY_LENGTH)];
                for (const value of values) {
                    await handler(value);
                }
                assert.deepStrictEqual(copied, values, '값을 다시 파싱하거나 패딩을 없애지 않는다');

                for (const invalid of [
                    undefined, null, 255, 255n, {}, ['0xFF'], '', '0'.repeat(MAX_HOVER_COPY_LENGTH + 1),
                    'arbitrary shell command', hostileText, '0x-5', 'Infinity', 'NaN', '1e+21',
                    '1.5', ' 255', '255 ', '255\n', '0x1" title', '0x1|cell', '0b2',
                ]) {
                    await handler(invalid);
                }
                assert.deepStrictEqual(copied, values, '잘못된 인자는 클립보드를 변경하지 않는다');

                errors.length = 0;
                clipboardFails = true;
                await assert.doesNotReject(() => handler!('0xFF'));
                assert.strictEqual(errors.length, 1);
                assert.match(errors[0], /클립보드|clipboard/i);
                assert.deepStrictEqual(copied, values);
            } finally {
                registration?.dispose();
                vscode.commands.registerCommand = originalRegisterCommand;
                Object.defineProperty(vscode.env, 'clipboard', originalClipboard);
                vscode.window.showErrorMessage = originalShowErrorMessage;
            }
        });
    });

    suite('Number Detection Tests', () => {
        test('Find hex number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = 0xFF;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '0xFF');
            assert.strictEqual(result.start, 8);
            assert.strictEqual(result.end, 12);
        });

        test('Find decimal number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = 255;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '255');
            assert.strictEqual(result.start, 8);
            assert.strictEqual(result.end, 11);
        });

        test('Find binary number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = 0b11111111;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '0b11111111');
            assert.strictEqual(result.start, 8);
            assert.strictEqual(result.end, 18);
        });

        test('Return null when no number at position', () => {
            const result = (provider as any).findNumberAtPosition('int x = value;', 8);
            assert.strictEqual(result, null);
        });

        test('does not match h-suffix digits inside an identifier (M8 회귀 가드)', () => {
            // 이전 h-suffix 정규식은 \b가 없어 `Foo123h`의 `123h`에 매치됐다.
            const result = (provider as any).findNumberAtPosition('int Foo123h = 1;', 8);
            assert.strictEqual(result, null);
        });

        test('does not partially match invalid hex literal (M8 회귀 가드)', () => {
            // `0x12g3`에서 `0x12`까지 부분 매치되던 문제 — (?!\w) lookahead로 거부.
            const result = (provider as any).findNumberAtPosition('int x = 0x12g3;', 10);
            assert.strictEqual(result, null);
        });

        test('does not partially match invalid binary literal (M8 회귀 가드)', () => {
            // `0b12`에서 `0b1`까지 부분 매치되던 문제.
            const result = (provider as any).findNumberAtPosition('int b = 0b12;', 9);
            assert.strictEqual(result, null);
        });

        test('still matches a valid h-suffix literal at word boundaries', () => {
            const result = (provider as any).findNumberAtPosition('mov a, 0FFh;', 8);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.text, '0FFh');
        });
    });

    suite('Bit Position Tests', () => {
        test('Generate correct bit info for 0xFF', () => {
            const result = (provider as any).generateBitPositionDisplay(0xFF);
            assert.ok(result.includes('Set bits:'), 'Should contain "Set bits:"');
            // Check that all bits 0-7 are mentioned
            for (let i = 0; i <= 7; i++) {
                assert.ok(result.includes(i.toString()), `Should mention bit ${i}`);
            }
        });

        test('Generate correct bit info for 0x00', () => {
            const result = (provider as any).generateBitPositionDisplay(0x00);
            assert.ok(result.includes('Set bits:'), 'Should contain "Set bits:"');
            assert.ok(result.includes('none') || result.includes('value is 0'), 'Should indicate no bits are set');
        });

        test('Generate correct bit info for 0x80000000', () => {
            const result = (provider as any).generateBitPositionDisplay(0x80000000);
            assert.ok(result.includes('Set bits:'), 'Should contain "Set bits:"');
            assert.ok(result.includes('31'), 'Should mention bit 31');
        });

        test('Generate 32-bit display for values <= 0xFFFFFFFF', () => {
            const result = (provider as any).generateBitPositionDisplay(0xFFFFFFFF);
            assert.ok(result.includes('32-bit'));
        });

        test('Generate 64-bit display for values > 0xFFFFFFFF', () => {
            const result = (provider as any).generateBitPositionDisplay(0x100000000);
            assert.ok(result.includes('64-bit'));
        });
    });

    suite('Value Extraction Tests', () => {
        test('Extract value from const declaration', () => {
            const result = (provider as any).extractValueFromLine('const int MASK = 0xFF;');
            assert.strictEqual(result, 255);
        });

        test('Extract value from variable assignment', () => {
            const result = (provider as any).extractValueFromLine('int value = 0x100;');
            assert.strictEqual(result, 256);
        });

        test('Extract value from enum with comma', () => {
            const result = (provider as any).extractValueFromLine('    FLAG_A = 0x01,');
            assert.strictEqual(result, 1);
        });

        test('Extract value from #define', () => {
            const result = (provider as any).extractValueFromLine('#define MAX_SIZE 0x1000');
            assert.strictEqual(result, 4096);
        });

        test('Extract binary value from #define', () => {
            const result = (provider as any).extractValueFromLine('#define BIT_MASK 0b11110000');
            assert.strictEqual(result, 240);
        });

        test('Extract decimal value', () => {
            const result = (provider as any).extractValueFromLine('const int COUNT = 255;');
            assert.strictEqual(result, 255);
        });

        test('Return null for line without value', () => {
            const result = (provider as any).extractValueFromLine('int someVariable;');
            assert.strictEqual(result, null);
        });

        test('Return null for empty line', () => {
            const result = (provider as any).extractValueFromLine('');
            assert.strictEqual(result, null);
        });
    });

    suite('Enum Expression Evaluation Tests', () => {
        test('Numeric literal', () => {
            const map = new Map<string, number>();
            const result = (provider as any).evaluateEnumExpression('42', map);
            assert.strictEqual(result, 42);
        });

        test('Hex literal', () => {
            const map = new Map<string, number>();
            const result = (provider as any).evaluateEnumExpression('0xFF', map);
            assert.strictEqual(result, 255);
        });

        test('Identifier reference resolves from map', () => {
            const map = new Map<string, number>([['MAX', 290]]);
            const result = (provider as any).evaluateEnumExpression('MAX', map);
            assert.strictEqual(result, 290);
        });

        test('Identifier reference returns null when unresolved', () => {
            const map = new Map<string, number>();
            const result = (provider as any).evaluateEnumExpression('UNKNOWN', map);
            assert.strictEqual(result, null);
        });

        test('Binary subtraction with identifier', () => {
            const map = new Map<string, number>([['MAX', 290]]);
            const result = (provider as any).evaluateEnumExpression('MAX - 1', map);
            assert.strictEqual(result, 289);
        });

        test('Binary addition with identifier', () => {
            const map = new Map<string, number>([['BASE', 10]]);
            const result = (provider as any).evaluateEnumExpression('BASE + 5', map);
            assert.strictEqual(result, 15);
        });

        test('Bitwise shift left', () => {
            const map = new Map<string, number>();
            const result = (provider as any).evaluateEnumExpression('1 << 4', map);
            assert.strictEqual(result, 16);
        });

        test('Parenthesized expression', () => {
            const map = new Map<string, number>([['X', 5]]);
            const result = (provider as any).evaluateEnumExpression('(X + 3)', map);
            assert.strictEqual(result, 8);
        });
    });

    suite('Enum Value Extraction Tests', () => {
        function makeDoc(lines: string[]): vscode.TextDocument {
            return {
                lineCount: lines.length,
                lineAt: (i: number) => ({ text: lines[i] })
            } as any as vscode.TextDocument;
        }

        test('부정확한 enum 리터럴의 참조와 자동 증가를 전파하지 않고 명시 값에서 복구한다', async () => {
            const doc = makeDoc([
                'enum Precision', '{',
                '    A = 9007199254740993,',
                '    B = A & 1,',
                '    C,',
                '    D = 7,',
                '    E,',
                '};',
            ]);
            for (const [name, expected] of [['A', null], ['B', null], ['C', null], ['D', 7], ['E', 8]] as const) {
                assert.strictEqual(await (provider as any).extractEnumValue(doc, 0, name), expected, name);
            }
        });

        test('enum 자동 증가가 안전한 정수 범위를 넘으면 후속 참조도 복사할 값을 얻지 못한다', async () => {
            const doc = makeDoc([
                'enum Precision', '{',
                '    A = 9007199254740991,',
                '    B,',
                '    C = B & 1,',
                '    D,',
                '    E = 7,',
                '    F,',
                '};',
            ]);
            for (const [name, expected] of [
                ['A', Number.MAX_SAFE_INTEGER], ['B', null], ['C', null], ['D', null], ['E', 7], ['F', 8],
            ] as const) {
                assert.strictEqual(await (provider as any).extractEnumValue(doc, 0, name), expected, name);
            }
        });

        test('enum 중간 연산이 범위를 넘은 뒤 다시 작은 값이 되어도 정밀도 손실을 숨기지 않는다', async () => {
            const doc = makeDoc([
                'enum Precision', '{',
                '    A = 9007199254740991,',
                '    B = A + 2,',
                '    C = B - A,',
                '    D,',
                '    E = 7,',
                '    F,',
                '};',
            ]);
            for (const [name, expected] of [
                ['A', Number.MAX_SAFE_INTEGER], ['B', null], ['C', null], ['D', null], ['E', 7], ['F', 8],
            ] as const) {
                assert.strictEqual(await (provider as any).extractEnumValue(doc, 0, name), expected, name);
            }
        });

        test('Implicit values with first = 0', async () => {
            const doc = makeDoc([
                'enum Test',
                '{',
                '    A = 0,',
                '    B,',
                '    C,',
                '};'
            ]);
            const result = await (provider as any).extractEnumValue(doc, 0, 'C');
            assert.strictEqual(result, 2);
        });

        test('Handles 200+ implicit entries', async () => {
            const lines = ['enum Big', '{', 'E_0 = 0,'];
            for (let i = 1; i <= 250; i++) {
                lines.push(`E_${i},`);
            }
            lines.push('};');
            const doc = makeDoc(lines);
            const result = await (provider as any).extractEnumValue(doc, 0, 'E_200');
            assert.strictEqual(result, 200);
        });

        test('Identifier assignment: NAME = OTHER', async () => {
            const doc = makeDoc([
                'enum Test',
                '{',
                '    Test_0 = 0,',
                '    Test_Max,',
                '    Test_Invalid = Test_Max,',
                '};'
            ]);
            const result = await (provider as any).extractEnumValue(doc, 0, 'Test_Invalid');
            assert.strictEqual(result, 1);
        });

        test('Expression assignment: NAME = OTHER - 1', async () => {
            const doc = makeDoc([
                'enum Test',
                '{',
                '    Test_0 = 0,',
                '    Test_A,',
                '    Test_Max,',
                '    Test_Dummy = Test_Max - 1,',
                '};'
            ]);
            const result = await (provider as any).extractEnumValue(doc, 0, 'Test_Dummy');
            assert.strictEqual(result, 1);
        });

        test('Inline line comment is ignored', async () => {
            const doc = makeDoc([
                'enum Test',
                '{',
                '    Test_0 = 0, // start',
                '    Test_Max,   // 290th',
                '    Test_Invalid = Test_Max, // alias',
                '};'
            ]);
            const result = await (provider as any).extractEnumValue(doc, 0, 'Test_Invalid');
            assert.strictEqual(result, 1);
        });

        test('Implicit value after explicit identifier assignment increments properly', async () => {
            const doc = makeDoc([
                'enum Test',
                '{',
                '    A = 10,',
                '    B = A,',
                '    C,',
                '};'
            ]);
            const resultB = await (provider as any).extractEnumValue(doc, 0, 'B');
            const resultC = await (provider as any).extractEnumValue(doc, 0, 'C');
            assert.strictEqual(resultB, 10);
            assert.strictEqual(resultC, 11);
        });
    });

    suite('SFR Bit Field Hover Tests', () => {
        test('Generate hover content for single bit field', () => {
            const bitFieldInfo: CompleteBitFieldInfo = {
                fieldName: 'int0_set',
                declaredWidth: 1,
                commentInfo: {
                    bitPosition: '0',
                    bitStart: 0,
                    bitEnd: 0,
                    bitWidth: 1,
                    accessType: 'RW1C',
                    resetValue: '0x0',
                    resetValueNumeric: 0,
                    description: 'Test interrupt 1'
                }
            };

            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 5 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 9 }
            ];

            const result = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo,
                scopes,
                'h1/test.h',
                36
            );

            assert.ok(visibleMarkdownText(result).includes('RegTestInt::IntRegSts::int0_set'), 'Should include hierarchy name');
            assert.ok(visibleMarkdownText(result).includes('0'), 'Should include bit position');
            assert.ok(visibleMarkdownText(result).includes('RW1C'), 'Should include access type');
            assert.ok(visibleMarkdownText(result).includes('0x0'), 'Should include reset value');
            assert.ok(visibleMarkdownText(result).includes('Test interrupt 1'), 'Should include description');
            assert.ok(visibleMarkdownText(result).includes('h1/test.h:36'), 'Should include file location');
        });

        test('Generate hover content for multi-bit field with conversions', () => {
            const bitFieldInfo: CompleteBitFieldInfo = {
                fieldName: 'int_field_0',
                declaredWidth: 3,
                commentInfo: {
                    bitPosition: '12:10',
                    bitStart: 10,
                    bitEnd: 12,
                    bitWidth: 3,
                    accessType: 'RW1C',
                    resetValue: '0x7',
                    resetValueNumeric: 7,
                    description: 'Test field 0'
                }
            };

            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 5 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 9 }
            ];

            const result = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo,
                scopes,
                'h1/test.h',
                47
            );

            assert.ok(visibleMarkdownText(result).includes('12:10'), 'Should include bit position range');
            assert.ok(visibleMarkdownText(result).includes('3 bits'), 'Should include bit width');
            assert.ok(visibleMarkdownText(result).includes('Dec: 7'), 'Should include decimal conversion');
            assert.ok(visibleMarkdownText(result).includes('Bin: 0b111'), 'Should include binary conversion');
            assert.ok(visibleMarkdownText(result).includes('0x00001C00'), 'Should include bit mask');
        });

        test('Verify different bit positions produce different content', () => {
            // First definition: 3 bits at [12:10]
            const bitFieldInfo1: CompleteBitFieldInfo = {
                fieldName: 'int_field_0',
                declaredWidth: 3,
                commentInfo: {
                    bitPosition: '12:10',
                    bitStart: 10,
                    bitEnd: 12,
                    bitWidth: 3,
                    accessType: 'RW1C',
                    resetValue: '0x7',
                    resetValueNumeric: 7,
                    description: 'Test field 0'
                }
            };

            // Second definition: 2 bits at [11:10]
            const bitFieldInfo2: CompleteBitFieldInfo = {
                fieldName: 'int_field_0',
                declaredWidth: 2,
                commentInfo: {
                    bitPosition: '11:10',
                    bitStart: 10,
                    bitEnd: 11,
                    bitWidth: 2,
                    accessType: 'RW1C',
                    resetValue: '0x3',
                    resetValueNumeric: 3,
                    description: 'Test field 0'
                }
            };

            const scopes = [
                { type: 'class' as const, name: 'RegTestInt', lineNumber: 5 },
                { type: 'union' as const, name: 'IntRegSts', lineNumber: 9 }
            ];

            const result1 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo1,
                scopes,
                'h1/test.h',
                47
            );

            const result2 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo2,
                scopes,
                'h2/test.h',
                47
            );

            // Verify first definition has correct info
            assert.ok(visibleMarkdownText(result1).includes('12:10'), 'First definition should show [12:10]');
            assert.ok(visibleMarkdownText(result1).includes('3 bits'), 'First definition should show 3 bits');
            assert.ok(visibleMarkdownText(result1).includes('0x7'), 'First definition should show reset value 0x7');
            assert.ok(visibleMarkdownText(result1).includes('0x00001C00'), 'First definition should show bit mask 0x00001C00');

            // Verify second definition has DIFFERENT info
            assert.ok(visibleMarkdownText(result2).includes('11:10'), 'Second definition should show [11:10]');
            assert.ok(visibleMarkdownText(result2).includes('2 bits'), 'Second definition should show 2 bits');
            assert.ok(visibleMarkdownText(result2).includes('0x3'), 'Second definition should show reset value 0x3');
            assert.ok(visibleMarkdownText(result2).includes('0x00000C00'), 'Second definition should show bit mask 0x00000C00');

            // Verify they are actually different
            assert.notStrictEqual(result1.value, result2.value, 'Different bit field definitions should produce different hover content');
        });

        test('Bit mask calculation for different bit positions', () => {
            // Test bit mask for [0] - single bit
            const bitFieldInfo1: CompleteBitFieldInfo = {
                fieldName: 'bit0',
                declaredWidth: 1,
                commentInfo: {
                    bitPosition: '0',
                    bitStart: 0,
                    bitEnd: 0,
                    bitWidth: 1,
                    accessType: 'RW1C',
                    resetValue: '0x0',
                    resetValueNumeric: 0,
                    description: 'Bit 0'
                }
            };

            const result1 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo1,
                [],
                'test.h',
                1
            );
            assert.ok(visibleMarkdownText(result1).includes('0x00000001'), 'Bit [0] should have mask 0x00000001');

            // Test bit mask for [12:10] - 3 bits
            const bitFieldInfo2: CompleteBitFieldInfo = {
                fieldName: 'bits_12_10',
                declaredWidth: 3,
                commentInfo: {
                    bitPosition: '12:10',
                    bitStart: 10,
                    bitEnd: 12,
                    bitWidth: 3,
                    accessType: 'RW1C',
                    resetValue: '0x7',
                    resetValueNumeric: 7,
                    description: 'Bits 12:10'
                }
            };

            const result2 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo2,
                [],
                'test.h',
                1
            );
            assert.ok(visibleMarkdownText(result2).includes('0x00001C00'), 'Bits [12:10] should have mask 0x00001C00');

            // Test bit mask for [11:10] - 2 bits
            const bitFieldInfo3: CompleteBitFieldInfo = {
                fieldName: 'bits_11_10',
                declaredWidth: 2,
                commentInfo: {
                    bitPosition: '11:10',
                    bitStart: 10,
                    bitEnd: 11,
                    bitWidth: 2,
                    accessType: 'RW1C',
                    resetValue: '0x3',
                    resetValueNumeric: 3,
                    description: 'Bits 11:10'
                }
            };

            const result3 = (provider as any).generateBitFieldHoverContent(
                bitFieldInfo3,
                [],
                'test.h',
                1
            );
            assert.ok(visibleMarkdownText(result3).includes('0x00000C00'), 'Bits [11:10] should have mask 0x00000C00');
        });
    });

    // ========================================================================
    // Bit Operation Tests (Experimental Feature)
    // ========================================================================
    suite('Bit Operation Detection', () => {
        test('should detect AND operation', () => {
            const line = '    value &= 0xFF;';
            const operation = detectBitOperation(line, 10); // Cursor on '&='

            assert.ok(operation, 'Should detect operation');
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.AND_ASSIGN);
            assert.strictEqual(operation.operand, 0xFF);
            assert.strictEqual(operation.isAssignment, true);
        });

        test('should detect OR operation', () => {
            const line = '    reg |= 0x80;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'reg');
            assert.strictEqual(operation.operator, BitOperationType.OR_ASSIGN);
            assert.strictEqual(operation.operand, 0x80);
            assert.strictEqual(operation.isAssignment, true);
        });

        test('should detect XOR operation', () => {
            const line = '    mask ^= 0b10101010;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'mask');
            assert.strictEqual(operation.operator, BitOperationType.XOR_ASSIGN);
            assert.strictEqual(operation.operand, 0b10101010);
        });

        test('should detect left shift operation', () => {
            const line = '    value <<= 4;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.LEFT_SHIFT_ASSIGN);
            assert.strictEqual(operation.operand, 4);
        });

        test('should detect right shift operation', () => {
            const line = '    value >>= 2;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.RIGHT_SHIFT_ASSIGN);
            assert.strictEqual(operation.operand, 2);
        });

        test('should detect non-assignment AND', () => {
            const line = '    result = value & 0xFF;';
            const operation = detectBitOperation(line, 20); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.AND);
            assert.strictEqual(operation.operand, 0xFF);
            assert.strictEqual(operation.isAssignment, false);
        });

        test('should detect NOT operation', () => {
            const line = '    result = ~value;';
            const operation = detectBitOperation(line, 14); // Cursor on '~'

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.NOT);
        });

        test('should return undefined when no operation found', () => {
            const line = '    int value = 10;';
            const operation = detectBitOperation(line, 10);

            assert.strictEqual(operation, undefined);
        });

        test('should handle hex operands', () => {
            const line = '    value &= 0xABCD;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.operand, 0xABCD);
        });

        test('should handle binary operands', () => {
            const line = '    value |= 0b11110000;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.operand, 0b11110000);
        });

        test('should handle decimal operands', () => {
            const line = '    value <<= 8;';
            const operation = detectBitOperation(line, 10);

            assert.ok(operation);
            assert.strictEqual(operation.operand, 8);
        });

        test('should NOT detect NOT on constant like ~0x00FF0000', () => {
            const line = '    config &= ~0x00FF0000;';
            const operation = detectBitOperation(line, 15); // Cursor on '~'

            // '~0x00FF0000' is a constant expression, should not be detected by NOT pattern
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect variable XOR variable (a ^ b)', () => {
            const line = '    uint8_t result = a ^ b;';
            const operation = detectBitOperation(line, 24); // Cursor on '^'

            // 'a ^ b' pattern is NOT supported (variable & variable)
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect variable AND variable (data & mask)', () => {
            const line = '    uint8_t output = data & mask;';
            const operation = detectBitOperation(line, 27); // Cursor on '&'

            // 'data & mask' pattern is NOT supported (variable & variable)
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect variable OR variable (flags | status)', () => {
            const line = '    result = flags | status;';
            const operation = detectBitOperation(line, 19); // Cursor on '|'

            // 'flags | status' pattern is NOT supported (variable & variable)
            assert.strictEqual(operation, undefined);
        });

        test('should NOT detect left shift with variable operand (1 << shift)', () => {
            const line = '    uint8_t mask = 1 << shift;';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            // '1 << shift' pattern is NOT supported (right operand is variable)
            assert.strictEqual(operation, undefined);
        });

        test('should handle variable names starting with underscore', () => {
            const line = '    _value |= 0x80;';
            const operation = detectBitOperation(line, 11);

            assert.ok(operation);
            assert.strictEqual(operation.variable, '_value');
            assert.strictEqual(operation.operator, BitOperationType.OR_ASSIGN);
        });

        test('should handle variable names with digits (but not starting with digit)', () => {
            const line = '    value123 &= 0xFF;';
            const operation = detectBitOperation(line, 13);

            assert.ok(operation);
            assert.strictEqual(operation.variable, 'value123');
            assert.strictEqual(operation.operator, BitOperationType.AND_ASSIGN);
        });
    });

    suite('Constant Expression Detection', () => {
        test('should detect constant left shift: 1U << 5', () => {
            const line = '    #define MASK (1U << 5)';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            assert.ok(operation, 'Should detect constant expression');
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.LEFT_SHIFT);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 5);
            assert.strictEqual(operation.isAssignment, false);
        });

        test('should detect constant left shift without parentheses: 1U << 12', () => {
            const line = '    #define BIT12 1U << 12';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 12);
        });

        test('should detect constant AND: 0xFF & 0x0F', () => {
            const line = '    result = 0xFF & 0x0F;';
            const operation = detectBitOperation(line, 18); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.AND);
            assert.strictEqual(operation.leftOperand, 0xFF);
            assert.strictEqual(operation.operand, 0x0F);
        });

        test('should detect constant OR: 0x80 | 0x40', () => {
            const line = '    #define FLAGS (0x80 | 0x40)';
            const operation = detectBitOperation(line, 27); // Cursor on '|'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.OR);
            assert.strictEqual(operation.leftOperand, 0x80);
            assert.strictEqual(operation.operand, 0x40);
        });

        test('should detect constant XOR: 0xAA ^ 0x55', () => {
            const line = '    temp = 0xAA ^ 0x55;';
            const operation = detectBitOperation(line, 16); // Cursor on '^'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.XOR);
            assert.strictEqual(operation.leftOperand, 0xAA);
            assert.strictEqual(operation.operand, 0x55);
        });

        test('should detect constant right shift: 256 >> 4', () => {
            const line = '    value = 256 >> 4;';
            const operation = detectBitOperation(line, 16); // Cursor on '>>'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.operator, BitOperationType.RIGHT_SHIFT);
            assert.strictEqual(operation.leftOperand, 256);
            assert.strictEqual(operation.operand, 4);
        });

        test('should detect constant with binary literals: 0b1111 & 0b1010', () => {
            const line = '    mask = 0b1111 & 0b1010;';
            const operation = detectBitOperation(line, 19); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 0b1111);
            assert.strictEqual(operation.operand, 0b1010);
        });

        test('should handle constant with L suffix: 1L << 16', () => {
            const line = '    #define BIT (1L << 16)';
            const operation = detectBitOperation(line, 23); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 16);
        });

        test('should handle constant with UL suffix: 1UL << 20', () => {
            const line = '    value = 1UL << 20;';
            const operation = detectBitOperation(line, 16); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 1);
            assert.strictEqual(operation.operand, 20);
        });

        test('should detect constant expression with spaces: 0xFF  &  0x0F', () => {
            const line = '    result = 0xFF  &  0x0F;';
            const operation = detectBitOperation(line, 19); // Cursor on '&'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 0xFF);
            assert.strictEqual(operation.operand, 0x0F);
        });

        test('should detect multi-bit shift: 3U << 5', () => {
            const line = '    #define MASK 3U << 5';
            const operation = detectBitOperation(line, 20); // Cursor on '<<'

            assert.ok(operation);
            assert.strictEqual(operation.isConstant, true);
            assert.strictEqual(operation.leftOperand, 3);
            assert.strictEqual(operation.operand, 5);
        });

        test('should prioritize variable pattern over constant when variable is present', () => {
            const line = '    value &= 0xFF;';
            const operation = detectBitOperation(line, 10); // Cursor on '&='

            // Should detect as variable operation, NOT constant expression
            assert.ok(operation);
            assert.strictEqual(operation.isConstant, undefined); // Not a constant expression
            assert.strictEqual(operation.variable, 'value');
            assert.strictEqual(operation.operator, BitOperationType.AND_ASSIGN);
        });
    });

    suite('Bit Operation Calculation', () => {
        test('should calculate AND result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.AND_ASSIGN,
                operand: 0xFF,
                isAssignment: true,
                expression: 'value &= 0xFF',
                start: 0,
                end: 15
            };

            const result = calculateBitOperation(operation, 0x1234);

            assert.strictEqual(result.beforeValue, 0x1234);
            assert.strictEqual(result.afterValue, 0x34);
            assert.ok(result.changedBits.length > 0);
        });

        test('should calculate OR result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x80,
                isAssignment: true,
                expression: 'value |= 0x80',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x0F);

            assert.strictEqual(result.beforeValue, 0x0F);
            assert.strictEqual(result.afterValue, 0x8F);
            assert.ok(result.setBits.includes(7)); // Bit 7 should be set
        });

        test('should calculate XOR result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.XOR_ASSIGN,
                operand: 0xFF,
                isAssignment: true,
                expression: 'value ^= 0xFF',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x00);

            assert.strictEqual(result.beforeValue, 0x00);
            assert.strictEqual(result.afterValue, 0xFF);
            assert.strictEqual(result.setBits.length, 8); // 8 bits set
        });

        test('should calculate left shift result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.LEFT_SHIFT_ASSIGN,
                operand: 4,
                isAssignment: true,
                expression: 'value <<= 4',
                start: 0,
                end: 13
            };

            const result = calculateBitOperation(operation, 0x01);

            assert.strictEqual(result.beforeValue, 0x01);
            assert.strictEqual(result.afterValue, 0x10);
        });

        test('should calculate right shift result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.RIGHT_SHIFT_ASSIGN,
                operand: 4,
                isAssignment: true,
                expression: 'value >>= 4',
                start: 0,
                end: 13
            };

            const result = calculateBitOperation(operation, 0xF0);

            assert.strictEqual(result.beforeValue, 0xF0);
            assert.strictEqual(result.afterValue, 0x0F);
        });

        test('should calculate NOT result', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.NOT,
                operand: 0,
                isAssignment: false,
                expression: '~value',
                start: 0,
                end: 6
            };

            const result = calculateBitOperation(operation, 0xFF);

            assert.strictEqual(result.beforeValue, 0xFF);
            assert.strictEqual(result.afterValue, ~0xFF);
        });

        test('should identify set and cleared bits', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x81, // Bits 0 and 7
                isAssignment: true,
                expression: 'value |= 0x81',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x00);

            assert.strictEqual(result.setBits.length, 2);
            assert.ok(result.setBits.includes(0));
            assert.ok(result.setBits.includes(7));
            assert.strictEqual(result.clearedBits.length, 0);
        });
    });

    suite('Constant Expression Calculation', () => {
        test('should calculate constant left shift: 1 << 5', () => {
            const operation: BitOperation = {
                operator: BitOperationType.LEFT_SHIFT,
                operand: 5,
                leftOperand: 1,
                isAssignment: false,
                isConstant: true,
                expression: '1 << 5',
                start: 0,
                end: 6
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 1); // Left operand
            assert.strictEqual(result.afterValue, 32); // 1 << 5 = 32
        });

        test('should calculate constant left shift: 1U << 12', () => {
            const operation: BitOperation = {
                operator: BitOperationType.LEFT_SHIFT,
                operand: 12,
                leftOperand: 1,
                isAssignment: false,
                isConstant: true,
                expression: '1U << 12',
                start: 0,
                end: 8
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 1);
            assert.strictEqual(result.afterValue, 4096); // 1 << 12 = 0x1000
        });

        test('should calculate large shifts without JavaScript mod-32 wrapping', () => {
            const operation: BitOperation = {
                operator: BitOperationType.LEFT_SHIFT,
                operand: 40,
                leftOperand: 1,
                isAssignment: false,
                isConstant: true,
                expression: '1 << 40',
                start: 0,
                end: 7
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 1);
            assert.strictEqual(result.afterValue, Math.pow(2, 40));
        });

        test('should calculate constant AND: 0xFF & 0x0F', () => {
            const operation: BitOperation = {
                operator: BitOperationType.AND,
                operand: 0x0F,
                leftOperand: 0xFF,
                isAssignment: false,
                isConstant: true,
                expression: '0xFF & 0x0F',
                start: 0,
                end: 11
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 0xFF);
            assert.strictEqual(result.afterValue, 0x0F); // 0xFF & 0x0F = 0x0F
        });

        test('should calculate constant OR: 0x80 | 0x40', () => {
            const operation: BitOperation = {
                operator: BitOperationType.OR,
                operand: 0x40,
                leftOperand: 0x80,
                isAssignment: false,
                isConstant: true,
                expression: '0x80 | 0x40',
                start: 0,
                end: 11
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 0x80);
            assert.strictEqual(result.afterValue, 0xC0); // 0x80 | 0x40 = 0xC0
        });

        test('should calculate constant XOR: 0xAA ^ 0x55', () => {
            const operation: BitOperation = {
                operator: BitOperationType.XOR,
                operand: 0x55,
                leftOperand: 0xAA,
                isAssignment: false,
                isConstant: true,
                expression: '0xAA ^ 0x55',
                start: 0,
                end: 11
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 0xAA);
            assert.strictEqual(result.afterValue, 0xFF); // 0xAA ^ 0x55 = 0xFF
        });

        test('should calculate constant right shift: 256 >> 4', () => {
            const operation: BitOperation = {
                operator: BitOperationType.RIGHT_SHIFT,
                operand: 4,
                leftOperand: 256,
                isAssignment: false,
                isConstant: true,
                expression: '256 >> 4',
                start: 0,
                end: 8
            };

            const result = calculateBitOperation(operation);

            assert.strictEqual(result.beforeValue, 256);
            assert.strictEqual(result.afterValue, 16); // 256 >> 4 = 16
        });
    });

    suite('Bit Operation Formatting', () => {
        test('should format operation result with before value', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x80,
                isAssignment: true,
                expression: 'value |= 0x80',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation, 0x0F);
            const markdown = formatBitOperationResult(result);

            assert.ok(visibleMarkdownText(markdown).includes('Bit Operation Result'));
            assert.ok(visibleMarkdownText(markdown).includes('value |= 0x80'));
            assert.ok(visibleMarkdownText(markdown).includes('Before'));
            assert.ok(visibleMarkdownText(markdown).includes('After'));
            assert.ok(visibleMarkdownText(markdown).includes('0x0000008F')); // Hex values are 8-digit padded
        });

        test('should format operation result without before value', () => {
            const operation: BitOperation = {
                variable: 'value',
                operator: BitOperationType.OR_ASSIGN,
                operand: 0x80,
                isAssignment: true,
                expression: 'value |= 0x80',
                start: 0,
                end: 14
            };

            const result = calculateBitOperation(operation); // No before value
            const markdown = formatBitOperationResult(result);

            assert.ok(visibleMarkdownText(markdown).includes('Bit Operation Result'));
            assert.ok(visibleMarkdownText(markdown).includes('After'));
            assert.ok(visibleMarkdownText(markdown).includes('0x00000080'));
        });
    });

    suite('MAX_LINE_LENGTH guard — boundary (pure predicate)', () => {
        // provideHover() bails out with `lineText.length > MAX_LINE_LENGTH`.
        // The check is isolated in NumberBaseHoverProvider.isLineTooLongForHover()
        // so that the inclusive-ceiling boundary can be pinned without mocking
        // the full vscode.TextDocument surface (getWordRangeAtPosition, getText,
        // LSP commands) that the downstream hover pipeline touches.
        const MAX = NumberBaseHoverProvider.MAX_LINE_LENGTH;

        test('MAX_LINE_LENGTH is the documented 10_000-character cap', () => {
            assert.strictEqual(MAX, 10_000);
        });

        test('line length = MAX_LINE_LENGTH - 1 is allowed (below the limit)', () => {
            const line = 'a'.repeat(MAX - 1);
            assert.strictEqual(NumberBaseHoverProvider.isLineTooLongForHover(line), false);
        });

        test('line length exactly at MAX_LINE_LENGTH is allowed (inclusive ceiling)', () => {
            const line = 'a'.repeat(MAX);
            assert.strictEqual(NumberBaseHoverProvider.isLineTooLongForHover(line), false);
        });

        test('line length = MAX_LINE_LENGTH + 1 is rejected (one char over the limit)', () => {
            const line = 'a'.repeat(MAX + 1);
            assert.strictEqual(NumberBaseHoverProvider.isLineTooLongForHover(line), true);
        });

        test('empty line is allowed', () => {
            assert.strictEqual(NumberBaseHoverProvider.isLineTooLongForHover(''), false);
        });
    });
});
