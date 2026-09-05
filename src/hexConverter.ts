import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { t } from './i18n';
import { evaluateHexBitwiseExpression } from './hexBitwiseUtils';
import {
    buildHexConverterValueRows,
    decodeHexConverterBytes,
    encodeHexConverterText,
    formatHexConverterBytes,
    HEX_CONVERTER_MAX_BYTES,
    parseHexConverterInput,
} from './hexConverterUtils';

const HEX_CONVERTER_MAX_COPY_CHARACTERS = HEX_CONVERTER_MAX_BYTES * 3;
const HEX_CONVERTER_SAVED_VALUES_KEY = 'taskhub.hexConverter.savedValues.v1';
const HEX_CONVERTER_MAX_SAVED_VALUES = 24;
const HEX_CONVERTER_MAX_SAVED_BYTES = 16 * 1024;
const HEX_CONVERTER_LARGE_INPUT_CHARACTERS = 64 * 1024;
const HEX_CONVERTER_LARGE_INPUT_DELAY_MS = 120;
const HEX_BITWISE_ERROR_DELAY_MS = 350;
const HEX_CONVERTER_PREFERENCES_KEY = 'taskhub.hexConverter.preferences.v1';

export interface HexConverterPreferences {
    encoding: 'utf8' | 'ascii';
    hexGroup: 1 | 2 | 4;
    endian: 'little' | 'big';
}

const DEFAULT_HEX_CONVERTER_PREFERENCES: HexConverterPreferences = {
    encoding: 'utf8',
    hexGroup: 1,
    endian: 'little',
};

export interface HexConverterSavedValue {
    id: string;
    kind: 'text' | 'hex';
    value: string;
    encoding: 'utf8' | 'ascii';
    endian: 'little' | 'big';
    byteCount: number;
    savedAt: number;
}

let currentPanel: vscode.WebviewPanel | undefined;
let currentMessageDisposable: vscode.Disposable | undefined;

export function buildHexConverterStrings(): Record<string, string> {
    return {
        title: t('Hex/Text 변환기', 'Hex/Text Converter'),
        subtitle: t(
            '한쪽에 입력하면 반대쪽 값과 숫자 해석이 즉시 갱신됩니다.',
            'Type on either side to update the other value and numeric interpretations instantly.'
        ),
        encodingLabel: t('문자 인코딩', 'Text encoding'),
        utf8: 'UTF-8',
        ascii: 'ASCII',
        hexGroupLabel: t('Hex 표시 단위', 'Hex grouping'),
        group1: t('1 바이트', '1 Byte'),
        group2: t('2 바이트 (16비트)', '2 Bytes (16-bit)'),
        group4: t('4 바이트 (32비트)', '4 Bytes (32-bit)'),
        bytesPerRowLabel: t('한 줄 바이트 수', 'Bytes per row'),
        row8: t('8 바이트', '8 Bytes'),
        row16: t('16 바이트', '16 Bytes'),
        row32: t('32 바이트', '32 Bytes'),
        endianLabel: t('숫자 바이트 순서', 'Numeric byte order'),
        littleEndian: t('Little-Endian', 'Little-Endian'),
        bigEndian: t('Big-Endian', 'Big-Endian'),
        clear: t('입력 지우기', 'Clear input'),
        textLabel: t('Text', 'Text'),
        textHint: t('일반 문자열을 입력하세요.', 'Enter regular text.'),
        textPlaceholder: t('예: Hello', 'e.g. Hello'),
        copyText: t('Text 복사', 'Copy text'),
        saveText: t('Text 저장', 'Save text'),
        hexLabel: t('Hex bytes', 'Hex bytes'),
        hexHint: t(
            'Offset 0 · 연속·공백·0x 접두사 입력 지원',
            'Offset 0 · compact, spaced, and 0x-prefixed input'
        ),
        hexPlaceholder: '48 65 6C 6C 6F',
        copyHex: t('Hex 복사', 'Copy hex'),
        saveHex: t('Hex 저장', 'Save hex'),
        ready: t('Text 또는 Hex에 값을 입력하세요.', 'Enter a value in Text or Hex.'),
        fromText: t('Text → Hex · {bytes}바이트', 'Text → Hex · {bytes} bytes'),
        fromHex: t('Hex → Text · {bytes}바이트', 'Hex → Text · {bytes} bytes'),
        characters: t('{count}자', '{count} characters'),
        bytes: t('{count}바이트', '{count} bytes'),
        incompleteGroup: t(
            '마지막 그룹 {used}/{size}바이트 · {missing}바이트 부족',
            'Last group {used}/{size} bytes · missing {missing}'
        ),
        lastGroupPreview: t('미리보기', 'Preview'),
        inspectorTitle: t('값 해석', 'Value inspector'),
        inspectorHint: t('첫 8바이트를 선택한 바이트 순서로 해석합니다.', 'Interprets the first 8 bytes using the selected byte order.'),
        noBytes: t('변환된 바이트가 여기에 표시됩니다.', 'Converted byte values appear here.'),
        bitwiseTitle: t('비트 계산', 'Bitwise calculator'),
        bitwiseExpressionLabel: t('수식', 'Expression'),
        bitwisePlaceholder: '(0x1234 >> 8) & 0xFF',
        bitwiseWidthLabel: t('비트 폭', 'Bit width'),
        bitwiseWidth8: t('8비트', '8-bit'),
        bitwiseWidth16: t('16비트', '16-bit'),
        bitwiseWidth32: t('32비트', '32-bit'),
        bitwiseWidth64: t('64비트', '64-bit'),
        bitwiseHint: t(
            '0x: 16진수 · 0b: 2진수 · 접두사 없음: 10진수(선행 0도 동일: 010 = 10). 8진수는 지원하지 않습니다. 연산자: & | ^ ~ << >> ( ).',
            '0x: hex · 0b: binary · no prefix: decimal (including leading zeros: 010 = 10). Octal is not supported. Operators: & | ^ ~ << >> ( ).'
        ),
        bitwiseRules: t(
            '부호 없는 정수로 계산합니다. 각 연산 결과는 선택한 비트 폭으로 제한하며, >>는 0으로 채웁니다. 숫자 바이트 순서는 계산에 영향을 주지 않습니다.',
            'Uses unsigned integers. Each operation is limited to the selected width; >> shifts in zeros. Numeric byte order does not affect this calculation.'
        ),
        bitwiseReady: t('수식을 입력하면 결과가 즉시 표시됩니다.', 'Enter an expression to calculate instantly.'),
        bitwiseEditing: t('수식 입력 중…', 'Editing expression…'),
        bitwiseSuccess: t('{width}비트 계산 결과', '{width}-bit result'),
        bitwiseHexLabel: t('16진수', 'Hex'),
        bitwiseDecimalLabel: t('10진수', 'Decimal'),
        bitwiseBinaryLabel: t('2진수', 'Binary'),
        bitwiseEmptyResult: '—',
        bitwiseCopyHex: t('16진수 복사', 'Copy hex result'),
        bitwiseCopyDecimal: t('10진수 복사', 'Copy decimal result'),
        bitwiseCopyBinary: t('2진수 복사', 'Copy binary result'),
        bitwiseClear: t('수식 지우기', 'Clear expression'),
        bitwiseCopied: t('계산 결과를 복사했습니다.', 'Calculation result copied.'),
        bitwiseInvalidWidth: t('8·16·32·64비트 중에서 선택하세요.', 'Select 8, 16, 32, or 64 bits.'),
        bitwiseInvalidToken: t('지원하지 않는 숫자 또는 문자가 있습니다.', 'The expression contains an unsupported number or character.'),
        bitwiseInvalidExpression: t('숫자·연산자·괄호의 위치를 확인하세요.', 'Check the placement of numbers, operators, and parentheses.'),
        bitwiseOutOfRange: t('숫자가 선택한 {width}비트 범위를 넘었습니다.', 'A number exceeds the selected {width}-bit range.'),
        bitwiseInvalidShift: t('이동 횟수는 0~{max}의 정수여야 합니다.', 'The shift count must be an integer from 0 to {max}.'),
        bitwiseTooComplex: t('수식이 너무 길거나 복잡합니다. 나누어 계산하세요.', 'The expression is too long or complex. Split it into smaller calculations.'),
        bitwiseErrorPosition: t('{message} (위치 {position})', '{message} (position {position})'),
        copiedText: t('Text를 클립보드에 복사했습니다.', 'Text copied to the clipboard.'),
        copiedHex: t('Hex를 클립보드에 복사했습니다.', 'Hex copied to the clipboard.'),
        copyFailed: t('클립보드에 복사하지 못했습니다.', 'Could not copy to the clipboard.'),
        savedTitle: t('저장된 값', 'Saved values'),
        savedHint: t('자주 쓰는 값을 눌러 바로 불러옵니다.', 'Load frequently used values with one click.'),
        savedCount: t('{count}개 저장됨', '{count} saved'),
        savedEmpty: t('아직 저장된 값이 없습니다. Text 또는 Hex 카드에서 저장해 보세요.', 'No saved values yet. Save one from the Text or Hex card.'),
        whitespaceValue: t('(공백 문자)', '(whitespace)'),
        loadSaved: t('저장된 값 불러오기', 'Load saved value'),
        deleteSaved: t('저장된 값 삭제', 'Delete saved value'),
        saved: t('값을 저장했습니다.', 'Value saved.'),
        loaded: t('저장된 값을 불러왔습니다.', 'Saved value loaded.'),
        deleted: t('저장된 값을 삭제했습니다.', 'Saved value deleted.'),
        saveFailed: t('값을 저장하지 못했습니다.', 'Could not save the value.'),
        saveTooLarge: t('저장할 값은 16KB 이하여야 합니다.', 'Saved values must be 16 KB or smaller.'),
        conversionPending: t('큰 입력을 잠시 후 변환합니다…', 'Large input will update shortly…'),
        invalidCharacter: t('Hex에 사용할 수 없는 문자가 있습니다.', 'Hex contains an unsupported character.'),
        missingByte: t('0x 뒤에 Hex 바이트를 입력하세요.', 'Enter a hex byte after 0x.'),
        oddDigits: t('Hex 숫자는 두 자리씩 입력해야 합니다.', 'Hex digits must be entered in pairs.'),
        tooLarge: t('입력이 1MB 한도를 넘었습니다.', 'The input exceeds the 1 MB limit.'),
        nonAsciiCharacter: t('ASCII는 영문·숫자 등 0x00~0x7F 문자만 지원합니다.', 'ASCII supports only characters from 0x00 through 0x7F.'),
        nonAsciiByte: t('0x7F보다 큰 바이트는 ASCII Text로 변환할 수 없습니다.', 'Bytes above 0x7F cannot be decoded as ASCII text.'),
        invalidUtf8: t('올바른 UTF-8 바이트열이 아닙니다. 인코딩을 확인하세요.', 'This is not a valid UTF-8 byte sequence. Check the encoding.'),
        u8: t('부호 없는 8-bit', 'Unsigned 8-bit'),
        i8: t('부호 있는 8-bit', 'Signed 8-bit'),
        u16: t('부호 없는 16-bit', 'Unsigned 16-bit'),
        i16: t('부호 있는 16-bit', 'Signed 16-bit'),
        u32: t('부호 없는 32-bit', 'Unsigned 32-bit'),
        i32: t('부호 있는 32-bit', 'Signed 32-bit'),
        u64: t('부호 없는 64-bit', 'Unsigned 64-bit'),
        i64: t('부호 있는 64-bit', 'Signed 64-bit'),
        float32: 'Float32',
        float64: 'Float64',
    };
}

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeStaticHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!);
}

export function normalizeHexConverterSavedValues(stored: unknown): HexConverterSavedValue[] {
    if (!Array.isArray(stored)) { return []; }
    return stored.filter((entry): entry is HexConverterSavedValue => {
        if (!entry || typeof entry !== 'object') { return false; }
        const value = entry as Partial<HexConverterSavedValue>;
        const shapeIsValid = typeof value.id === 'string'
            && (value.kind === 'text' || value.kind === 'hex')
            && typeof value.value === 'string'
            && value.value.length <= HEX_CONVERTER_MAX_SAVED_BYTES * 6
            && (value.encoding === 'utf8' || value.encoding === 'ascii')
            && (value.endian === 'little' || value.endian === 'big')
            && typeof value.byteCount === 'number' && Number.isSafeInteger(value.byteCount) && value.byteCount >= 0
            && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt);
        if (!shapeIsValid) { return false; }
        const valid = value as HexConverterSavedValue;
        const converted = valid.kind === 'text'
            ? encodeHexConverterText(valid.value, valid.encoding, HEX_CONVERTER_MAX_SAVED_BYTES)
            : parseHexConverterInput(valid.value, HEX_CONVERTER_MAX_SAVED_BYTES);
        return converted.ok && converted.bytes.length === valid.byteCount;
    }).slice(0, HEX_CONVERTER_MAX_SAVED_VALUES);
}

export function normalizeHexConverterPreferences(stored: unknown): HexConverterPreferences {
    const value = stored && typeof stored === 'object' ? stored as Partial<HexConverterPreferences> : {};
    return {
        encoding: value.encoding === 'ascii' ? 'ascii' : 'utf8',
        hexGroup: value.hexGroup === 2 || value.hexGroup === 4 ? value.hexGroup : 1,
        endian: value.endian === 'big' ? 'big' : 'little',
    };
}

function readPreferences(context: vscode.ExtensionContext): HexConverterPreferences {
    return normalizeHexConverterPreferences(context.globalState.get<unknown>(HEX_CONVERTER_PREFERENCES_KEY));
}

function readSavedValues(context: vscode.ExtensionContext): HexConverterSavedValue[] {
    return normalizeHexConverterSavedValues(
        context.globalState.get<unknown>(HEX_CONVERTER_SAVED_VALUES_KEY, [])
    );
}

type SavedValueCreation =
    | { ok: true; entry: HexConverterSavedValue }
    | { ok: false; reason: 'invalid' | 'too-large' };

function createSavedValue(message: any): SavedValueCreation {
    if (
        (message?.kind !== 'text' && message?.kind !== 'hex')
        || typeof message.value !== 'string'
        || (message.encoding !== 'utf8' && message.encoding !== 'ascii')
        || (message.endian !== 'little' && message.endian !== 'big')
    ) {
        return { ok: false, reason: 'invalid' };
    }
    if (message.value.length > HEX_CONVERTER_MAX_SAVED_BYTES * 6) {
        return { ok: false, reason: 'too-large' };
    }

    const converted = message.kind === 'text'
        ? encodeHexConverterText(message.value, message.encoding, HEX_CONVERTER_MAX_SAVED_BYTES)
        : parseHexConverterInput(message.value, HEX_CONVERTER_MAX_SAVED_BYTES);
    if (!converted.ok) {
        return { ok: false, reason: converted.reason === 'too-large' ? 'too-large' : 'invalid' };
    }
    if (converted.bytes.length === 0) { return { ok: false, reason: 'invalid' }; }

    return { ok: true, entry: {
        id: crypto.randomUUID(),
        kind: message.kind,
        value: message.kind === 'hex' ? formatHexConverterBytes(converted.bytes) : message.value,
        encoding: message.encoding,
        endian: message.endian,
        byteCount: converted.bytes.length,
        savedAt: Date.now(),
    } };
}

export function buildHexConverterHtml(
    webview?: Pick<vscode.Webview, 'cspSource'>,
    savedValues: readonly HexConverterSavedValue[] = [],
    preferences: HexConverterPreferences = DEFAULT_HEX_CONVERTER_PREFERENCES
): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const cspSource = webview?.cspSource ?? 'https://test.invalid';
    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const stringBundle = buildHexConverterStrings();
    const strings = safeJson(stringBundle);
    const htmlStrings = Object.fromEntries(
        Object.entries(stringBundle).map(([key, value]) => [key, escapeStaticHtml(value)])
    ) as Record<string, string>;
    const initialSavedValues = safeJson(savedValues);
    const initialPreferences = safeJson(normalizeHexConverterPreferences(preferences));

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${htmlStrings.title}</title>
    <style>
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 24px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        button, select, textarea, input { font: inherit; }
        button, select {
            min-height: 32px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
        }
        button { cursor: pointer; }
        button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible, summary:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
        button:disabled { cursor: default; opacity: .55; }
        .shell { width: min(1180px, 100%); margin: 0 auto; }
        .hero {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 20px;
            margin-bottom: 18px;
        }
        h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.25; }
        .subtitle { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.5; }
        .controls {
            display: flex;
            flex-wrap: wrap;
            align-items: end;
            gap: 10px;
            padding: 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            background: var(--vscode-sideBar-background);
            margin-bottom: 14px;
        }
        .control { display: grid; gap: 5px; min-width: 155px; }
        .control label { color: var(--vscode-descriptionForeground); font-size: 12px; }
        select {
            padding: 4px 28px 4px 8px;
            color: var(--vscode-dropdown-foreground);
            background: var(--vscode-dropdown-background);
            border-color: var(--vscode-dropdown-border, var(--vscode-panel-border));
        }
        .clear-button {
            margin-left: auto;
            padding: 4px 12px;
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
        }
        .clear-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .content-layout { display: grid; grid-template-columns: minmax(0, 1fr) 272px; gap: 14px; align-items: start; }
        .workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
        .card {
            min-width: 0;
            overflow: hidden;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            background: var(--vscode-editor-background);
        }
        .card:focus-within { border-color: var(--vscode-focusBorder); }
        .card-header, .card-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 12px;
            background: var(--vscode-sideBar-background);
        }
        .card-header { border-bottom: 1px solid var(--vscode-panel-border); }
        .card-footer { border-top: 1px solid var(--vscode-panel-border); min-height: 44px; }
        .card-title { flex: 0 0 auto; font-size: 14px; font-weight: 600; white-space: nowrap; }
        .card-hint { min-width: 0; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: right; }
        textarea {
            display: block;
            width: 100%;
            min-height: 230px;
            resize: vertical;
            border: 0;
            border-radius: 0;
            padding: 14px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            line-height: 1.55;
        }
        textarea:focus { outline-offset: -2px; }
        .hex-editor {
            display: grid;
            grid-template-columns: max-content minmax(0, 1fr);
            height: 230px;
            min-height: 230px;
            overflow: hidden;
            resize: vertical;
            background: var(--vscode-input-background);
        }
        .hex-offsets {
            min-width: 94px;
            height: 100%;
            margin: 0;
            overflow: hidden;
            padding: 14px 10px;
            border-right: 1px solid var(--vscode-panel-border);
            color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
            background: var(--vscode-editorGutter-background, var(--vscode-input-background));
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: inherit;
            line-height: 1.55;
            text-align: right;
            user-select: none;
            white-space: pre;
        }
        #hexInput {
            height: 100%;
            min-height: 0;
            resize: none;
            font-family: var(--vscode-editor-font-family, monospace);
            letter-spacing: .025em;
            white-space: pre;
        }
        .count { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
        .count-summary { min-width: 0; display: grid; gap: 4px; }
        .group-warning {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 4px 8px;
            color: var(--vscode-inputValidation-warningForeground, var(--vscode-editorWarning-foreground, #cca700));
            font-size: 11px;
            line-height: 1.4;
        }
        .group-warning[hidden] { display: none; }
        .group-preview {
            display: inline-flex;
            gap: .35em;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family, monospace);
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
        }
        .group-missing {
            color: var(--vscode-inputValidation-warningForeground, var(--vscode-editorWarning-foreground, #cca700));
            font-weight: 700;
        }
        .card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
        .copy-button {
            padding: 4px 11px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        .copy-button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
        .status {
            min-height: 38px;
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 14px 0;
            padding: 8px 11px;
            border-left: 3px solid var(--vscode-focusBorder);
            border-radius: 3px;
            color: var(--vscode-foreground);
            background: var(--vscode-textBlockQuote-background, var(--vscode-sideBar-background));
            overflow-wrap: anywhere;
        }
        .status.is-error {
            border-left-color: var(--vscode-inputValidation-errorBorder, #be1100);
            color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
            background: var(--vscode-inputValidation-errorBackground, var(--vscode-textBlockQuote-background));
        }
        .status.is-success { border-left-color: var(--vscode-testing-iconPassed, #2ea043); }
        .status-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
        .inspector {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            overflow: hidden;
        }
        .inspector-header { padding: 11px 12px; background: var(--vscode-sideBar-background); }
        .inspector-header h2 { display: inline; margin: 0 8px 0 0; font-size: 14px; }
        .inspector-header span { color: var(--vscode-descriptionForeground); font-size: 12px; }
        .value-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); overflow: hidden; }
        .value-item { min-width: 0; padding: 11px 12px; border-top: 1px solid var(--vscode-panel-border); }
        .value-item + .value-item { border-left: 1px solid var(--vscode-panel-border); }
        .value-item:last-child { position: relative; }
        .value-item:last-child::after {
            content: '';
            width: 100vw;
            position: absolute;
            top: -1px;
            left: 100%;
            border-top: 1px solid var(--vscode-panel-border);
            pointer-events: none;
        }
        .value-name { display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
        .value-number { display: block; overflow: hidden; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; white-space: nowrap; }
        .empty { grid-column: 1 / -1; padding: 18px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
        .bitwise-panel { margin-top: 14px; }
        .bitwise-panel summary { padding: 11px 12px; background: var(--vscode-sideBar-background); cursor: pointer; font-size: 14px; font-weight: 600; }
        .bitwise-panel summary:focus-visible { outline-offset: -2px; }
        .bitwise-panel summary h2 { display: inline; margin: 0; font: inherit; }
        .bitwise-body { padding: 12px; border-top: 1px solid var(--vscode-panel-border); }
        .bitwise-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; }
        .bitwise-expression-control { flex: 1 1 300px; min-width: 0; }
        .bitwise-width-control { min-width: 100px; }
        #bitwiseExpression {
            width: 100%;
            min-width: 0;
            min-height: 34px;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        #bitwiseExpression[aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
        .bitwise-hint { margin: 10px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; }
        .bitwise-results { display: grid; gap: 8px; }
        .bitwise-result { display: grid; grid-template-columns: 60px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
        .bitwise-result label { color: var(--vscode-descriptionForeground); font-size: 12px; }
        .bitwise-result output { min-width: 0; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.6; }
        .saved-panel {
            min-width: 0;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            overflow: hidden;
            background: var(--vscode-editor-background);
        }
        .saved-header { padding: 11px 12px; background: var(--vscode-sideBar-background); }
        .saved-title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .saved-header h2 { margin: 0; font-size: 14px; }
        .saved-count { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
        .saved-hint { margin: 5px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
        .saved-list { display: grid; margin: 0; padding: 0; list-style: none; }
        .saved-item { min-width: 0; position: relative; border-top: 1px solid var(--vscode-panel-border); }
        .saved-load {
            width: 100%;
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 4px 8px;
            padding: 10px 38px 10px 11px;
            position: relative;
            border: 0;
            border-radius: 0;
            color: var(--vscode-foreground);
            background: transparent;
            text-align: left;
        }
        .saved-load:hover { background: var(--vscode-list-hoverBackground); }
        .saved-kind { font-size: 11px; font-weight: 600; color: var(--vscode-textLink-foreground); }
        .saved-preview {
            grid-column: 1 / -1;
            overflow: hidden;
            color: var(--vscode-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            line-height: 1.35;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .saved-meta { color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; }
        .saved-delete {
            width: 28px;
            min-width: 28px;
            min-height: 28px;
            position: absolute;
            top: 7px;
            right: 6px;
            z-index: 1;
            padding: 0;
            border-color: transparent;
            color: var(--vscode-descriptionForeground);
            background: transparent;
        }
        .saved-delete:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
        .saved-empty { padding: 22px 14px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; text-align: center; }
        @media (max-width: 1000px) {
            .content-layout { grid-template-columns: 1fr; }
            .saved-list { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
            .saved-item { border-right: 1px solid var(--vscode-panel-border); }
        }
        @media (max-width: 720px) {
            body { padding: 14px; }
            .hero { display: block; }
            .workspace { grid-template-columns: 1fr; }
            textarea { min-height: 170px; }
            .hex-editor { height: 170px; min-height: 170px; }
            .clear-button { margin-left: 0; }
        }
        @media (max-width: 420px) {
            .controls { align-items: stretch; }
            .control { width: 100%; }
            .clear-button { width: 100%; }
            .card-header { align-items: flex-start; flex-direction: column; }
            .card-hint { text-align: left; }
            .card-footer { align-items: flex-start; flex-direction: column; }
            .card-actions { width: 100%; }
            .card-actions button { flex: 1; }
            .bitwise-result { grid-template-columns: 1fr auto; }
            .bitwise-result output { grid-column: 1 / -1; grid-row: 2; }
            .bitwise-expression-control { flex-basis: 100%; }
        }
    </style>
</head>
<body>
<main class="shell">
    <header class="hero">
        <div>
            <h1>${htmlStrings.title}</h1>
            <p class="subtitle">${htmlStrings.subtitle}</p>
        </div>
    </header>

    <section class="controls" aria-label="${htmlStrings.title}">
        <div class="control">
            <label for="encoding">${htmlStrings.encodingLabel}</label>
            <select id="encoding">
                <option value="utf8">${htmlStrings.utf8}</option>
                <option value="ascii">${htmlStrings.ascii}</option>
            </select>
        </div>
        <div class="control">
            <label for="hexGroup">${htmlStrings.hexGroupLabel}</label>
            <select id="hexGroup">
                <option value="1">${htmlStrings.group1}</option>
                <option value="2">${htmlStrings.group2}</option>
                <option value="4">${htmlStrings.group4}</option>
            </select>
        </div>
        <div class="control">
            <label for="bytesPerRow">${htmlStrings.bytesPerRowLabel}</label>
            <select id="bytesPerRow">
                <option value="8">${htmlStrings.row8}</option>
                <option value="16" selected>${htmlStrings.row16}</option>
                <option value="32">${htmlStrings.row32}</option>
            </select>
        </div>
        <div class="control">
            <label for="endian">${htmlStrings.endianLabel}</label>
            <select id="endian">
                <option value="little">${htmlStrings.littleEndian}</option>
                <option value="big">${htmlStrings.bigEndian}</option>
            </select>
        </div>
        <button id="clearButton" class="clear-button" type="button">${htmlStrings.clear}</button>
    </section>

    <div class="content-layout">
    <div class="converter-column">
    <section class="workspace">
        <article class="card">
            <div class="card-header">
                <label class="card-title" for="textInput">${htmlStrings.textLabel}</label>
                <span class="card-hint" id="textHint">${htmlStrings.textHint}</span>
            </div>
            <textarea id="textInput" aria-describedby="textHint textCount" spellcheck="false" placeholder="${htmlStrings.textPlaceholder}"></textarea>
            <div class="card-footer">
                <span id="textCount" class="count"></span>
                <span class="card-actions">
                    <button id="saveText" class="clear-button" type="button" disabled>${htmlStrings.saveText}</button>
                    <button id="copyText" class="copy-button" type="button" disabled>${htmlStrings.copyText}</button>
                </span>
            </div>
        </article>

        <article class="card">
            <div class="card-header">
                <label class="card-title" for="hexInput">${htmlStrings.hexLabel}</label>
                <span class="card-hint" id="hexHint">${htmlStrings.hexHint}</span>
            </div>
            <div class="hex-editor">
                <pre id="hexOffsets" class="hex-offsets" aria-hidden="true">0x00000000</pre>
                <textarea id="hexInput" aria-describedby="hexHint hexCount" spellcheck="false" autocapitalize="off" wrap="off" placeholder="${htmlStrings.hexPlaceholder}"></textarea>
            </div>
            <div class="card-footer">
                <span class="count-summary">
                    <span id="hexCount" class="count"></span>
                    <span id="hexGroupWarning" class="group-warning" role="note" hidden>
                        <span id="hexGroupMessage"></span>
                        <span class="group-preview">
                            <span id="hexGroupPreviewLabel"></span>
                            <span id="hexGroupPresent"></span>
                            <span id="hexGroupMissing" class="group-missing"></span>
                        </span>
                    </span>
                </span>
                <span class="card-actions">
                    <button id="saveHex" class="clear-button" type="button" disabled>${htmlStrings.saveHex}</button>
                    <button id="copyHex" class="copy-button" type="button" disabled>${htmlStrings.copyHex}</button>
                </span>
            </div>
        </article>
    </section>

    <div id="status" class="status" role="status" aria-live="polite" aria-atomic="true">
        <span class="status-dot" aria-hidden="true"></span><span id="statusText">${htmlStrings.ready}</span>
    </div>

    <section class="inspector" aria-labelledby="inspectorTitle">
        <div class="inspector-header">
            <h2 id="inspectorTitle">${htmlStrings.inspectorTitle}</h2>
            <span>${htmlStrings.inspectorHint}</span>
        </div>
        <div id="valueGrid" class="value-grid"><div class="empty">${htmlStrings.noBytes}</div></div>
    </section>

    <details id="bitwisePanel" class="inspector bitwise-panel" open>
        <summary aria-labelledby="bitwiseTitle"><h2 id="bitwiseTitle">${htmlStrings.bitwiseTitle}</h2></summary>
        <div class="bitwise-body">
            <div class="bitwise-controls">
                <div class="control bitwise-expression-control">
                    <label for="bitwiseExpression">${htmlStrings.bitwiseExpressionLabel}</label>
                    <input id="bitwiseExpression" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="bitwiseHint bitwiseRules bitwiseStatus" placeholder="${htmlStrings.bitwisePlaceholder}">
                </div>
                <div class="control bitwise-width-control">
                    <label for="bitwiseWidth">${htmlStrings.bitwiseWidthLabel}</label>
                    <select id="bitwiseWidth">
                        <option value="8">${htmlStrings.bitwiseWidth8}</option>
                        <option value="16">${htmlStrings.bitwiseWidth16}</option>
                        <option value="32" selected>${htmlStrings.bitwiseWidth32}</option>
                        <option value="64">${htmlStrings.bitwiseWidth64}</option>
                    </select>
                </div>
                <button id="bitwiseClear" class="clear-button" type="button">${htmlStrings.bitwiseClear}</button>
            </div>
            <p id="bitwiseHint" class="bitwise-hint">${htmlStrings.bitwiseHint}</p>
            <p id="bitwiseRules" class="bitwise-hint">${htmlStrings.bitwiseRules}</p>
            <div id="bitwiseStatus" class="status" role="status" aria-live="polite" aria-atomic="true">${htmlStrings.bitwiseReady}</div>
            <div class="bitwise-results">
                <div class="bitwise-result">
                    <label id="bitwiseHexLabel" for="bitwiseHex">${htmlStrings.bitwiseHexLabel}</label>
                    <output id="bitwiseHex" for="bitwiseExpression bitwiseWidth" aria-labelledby="bitwiseHexLabel" aria-live="off">${htmlStrings.bitwiseEmptyResult}</output>
                    <button id="copyBitwiseHex" class="copy-button" type="button" disabled>${htmlStrings.bitwiseCopyHex}</button>
                </div>
                <div class="bitwise-result">
                    <label id="bitwiseDecimalLabel" for="bitwiseDecimal">${htmlStrings.bitwiseDecimalLabel}</label>
                    <output id="bitwiseDecimal" for="bitwiseExpression bitwiseWidth" aria-labelledby="bitwiseDecimalLabel" aria-live="off">${htmlStrings.bitwiseEmptyResult}</output>
                    <button id="copyBitwiseDecimal" class="copy-button" type="button" disabled>${htmlStrings.bitwiseCopyDecimal}</button>
                </div>
                <div class="bitwise-result">
                    <label id="bitwiseBinaryLabel" for="bitwiseBinary">${htmlStrings.bitwiseBinaryLabel}</label>
                    <output id="bitwiseBinary" for="bitwiseExpression bitwiseWidth" aria-labelledby="bitwiseBinaryLabel" aria-live="off">${htmlStrings.bitwiseEmptyResult}</output>
                    <button id="copyBitwiseBinary" class="copy-button" type="button" disabled>${htmlStrings.bitwiseCopyBinary}</button>
                </div>
            </div>
        </div>
    </details>
    </div>

    <aside class="saved-panel" aria-labelledby="savedTitle">
        <div class="saved-header">
            <div class="saved-title-row">
                <h2 id="savedTitle">${htmlStrings.savedTitle}</h2>
                <span id="savedCount" class="saved-count"></span>
            </div>
            <p class="saved-hint">${htmlStrings.savedHint}</p>
        </div>
        <ul id="savedList" class="saved-list"></ul>
    </aside>
    </div>
</main>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const S = ${strings};
    const INITIAL_SAVED_VALUES = ${initialSavedValues};
    const INITIAL_PREFERENCES = ${initialPreferences};
    const MAX_BYTES = ${HEX_CONVERTER_MAX_BYTES};
    const MAX_SAVED_BYTES = ${HEX_CONVERTER_MAX_SAVED_BYTES};
    const LARGE_INPUT_CHARACTERS = ${HEX_CONVERTER_LARGE_INPUT_CHARACTERS};
    const LARGE_INPUT_DELAY_MS = ${HEX_CONVERTER_LARGE_INPUT_DELAY_MS};
    const BITWISE_ERROR_DELAY_MS = ${HEX_BITWISE_ERROR_DELAY_MS};
    const HEX_PLACEHOLDER_BYTES = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    const parseHexConverterInput = ${parseHexConverterInput.toString()};
    const formatHexConverterBytes = ${formatHexConverterBytes.toString()};
    const encodeHexConverterText = ${encodeHexConverterText.toString()};
    const decodeHexConverterBytes = ${decodeHexConverterBytes.toString()};
    const buildHexConverterValueRows = ${buildHexConverterValueRows.toString()};
    const evaluateHexBitwiseExpression = ${evaluateHexBitwiseExpression.toString()};

    const textInput = document.getElementById('textInput');
    const hexInput = document.getElementById('hexInput');
    const encoding = document.getElementById('encoding');
    const hexGroup = document.getElementById('hexGroup');
    const bytesPerRow = document.getElementById('bytesPerRow');
    const endian = document.getElementById('endian');
    const textCount = document.getElementById('textCount');
    const hexCount = document.getElementById('hexCount');
    const hexGroupWarning = document.getElementById('hexGroupWarning');
    const copyText = document.getElementById('copyText');
    const copyHex = document.getElementById('copyHex');
    const saveText = document.getElementById('saveText');
    const saveHex = document.getElementById('saveHex');
    const clearButton = document.getElementById('clearButton');
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const valueGrid = document.getElementById('valueGrid');
    const hexOffsets = document.getElementById('hexOffsets');
    const hexGroupMessage = document.getElementById('hexGroupMessage');
    const hexGroupPreviewLabel = document.getElementById('hexGroupPreviewLabel');
    const hexGroupPresent = document.getElementById('hexGroupPresent');
    const hexGroupMissing = document.getElementById('hexGroupMissing');
    const savedList = document.getElementById('savedList');
    const savedCount = document.getElementById('savedCount');
    const bitwisePanel = document.getElementById('bitwisePanel');
    const bitwiseExpression = document.getElementById('bitwiseExpression');
    const bitwiseWidth = document.getElementById('bitwiseWidth');
    const bitwiseStatus = document.getElementById('bitwiseStatus');
    const bitwiseClear = document.getElementById('bitwiseClear');
    const bitwiseOutputs = {
        hex: document.getElementById('bitwiseHex'),
        decimal: document.getElementById('bitwiseDecimal'),
        binary: document.getElementById('bitwiseBinary'),
    };
    const bitwiseCopyButtons = {
        hex: document.getElementById('copyBitwiseHex'),
        decimal: document.getElementById('copyBitwiseDecimal'),
        binary: document.getElementById('copyBitwiseBinary'),
    };
    let bitwiseResult;
    let bitwiseCopyRequestId = 0;
    let bitwiseErrorTimer;
    let activeSource = 'text';
    let currentBytes = new Uint8Array();
    let savedValues = Array.isArray(INITIAL_SAVED_VALUES) ? INITIAL_SAVED_VALUES : [];
    let conversionTimer;

    function template(value, replacements) {
        return Object.entries(replacements).reduce((text, entry) => text.replace('{' + entry[0] + '}', String(entry[1])), value);
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    }

    function setStatus(message, kind) {
        status.classList.toggle('is-error', kind === 'error');
        status.classList.toggle('is-success', kind === 'success');
        statusText.textContent = message;
    }

    function selectedHexGroup() {
        const value = Number.parseInt(hexGroup.value, 10);
        return value === 2 || value === 4 ? value : 1;
    }

    function selectedBytesPerRow() {
        const value = Number.parseInt(bytesPerRow.value, 10);
        return value === 8 || value === 32 ? value : 16;
    }

    function incompleteGroupInfo(bytes) {
        const size = selectedHexGroup();
        if (size === 1 || bytes.length === 0) { return undefined; }
        const used = bytes.length % size;
        if (used === 0) { return undefined; }
        return { size, used, missing: size - used };
    }

    function incompleteGroupMessage(info) {
        return template(S.incompleteGroup, {
            used: info.used,
            size: info.size,
            missing: info.missing,
        });
    }

    function withIncompleteGroup(message, bytes) {
        const info = incompleteGroupInfo(bytes);
        return info ? message + ' · ' + incompleteGroupMessage(info) : message;
    }

    function renderIncompleteGroup(bytes) {
        const info = incompleteGroupInfo(bytes);
        hexGroupWarning.hidden = !info;
        if (!info) {
            hexGroupMessage.textContent = '';
            hexGroupPreviewLabel.textContent = '';
            hexGroupPresent.textContent = '';
            hexGroupMissing.textContent = '';
            return;
        }
        const presentTokens = [];
        const start = bytes.length - info.used;
        for (let index = start; index < bytes.length; index++) {
            presentTokens.push(bytes[index].toString(16).padStart(2, '0').toUpperCase());
        }
        hexGroupMessage.textContent = incompleteGroupMessage(info);
        hexGroupPreviewLabel.textContent = S.lastGroupPreview + ':';
        hexGroupPresent.textContent = presentTokens.join(' ');
        hexGroupMissing.textContent = Array(info.missing).fill('··').join(' ');
    }

    function formatBytes(bytes) {
        return formatHexConverterBytes(bytes, selectedHexGroup(), selectedBytesPerRow());
    }

    function updateHexPlaceholder() {
        hexInput.placeholder = formatBytes(HEX_PLACEHOLDER_BYTES);
    }

    function formatOffset(offset) {
        return '0x' + offset.toString(16).toUpperCase().padStart(8, '0');
    }

    function renderHexOffsets(pending = false) {
        let offset = 0;
        const lines = hexInput.value.split('\\n');
        const offsets = lines.map((line, index) => {
            const label = offset === undefined ? '—' : formatOffset(offset);
            if (!pending && offset !== undefined && index < lines.length - 1) {
                const parsed = parseHexConverterInput(line, MAX_BYTES);
                offset = parsed.ok ? offset + parsed.bytes.length : undefined;
            } else {
                offset = undefined;
            }
            return label;
        });
        hexOffsets.textContent = offsets.join('\\n');
        hexOffsets.scrollTop = hexInput.scrollTop;
    }

    function persistPreferences() {
        vscode.postMessage({
            command: 'updatePreferences',
            encoding: encoding.value,
            hexGroup: selectedHexGroup(),
            endian: endian.value,
        });
    }

    function setBytes(bytes) {
        currentBytes = bytes;
        renderHexOffsets();
        renderIncompleteGroup(bytes);
        textCount.textContent = template(S.characters, { count: Array.from(textInput.value).length });
        hexCount.textContent = template(S.bytes, { count: bytes.length });
        copyText.disabled = textInput.value.length === 0;
        copyHex.disabled = hexInput.value.length === 0;
        saveText.disabled = textInput.value.length === 0 || bytes.length === 0;
        saveHex.disabled = hexInput.value.length === 0 || bytes.length === 0;
        const rows = buildHexConverterValueRows(bytes, endian.value);
        if (rows.length === 0) {
            valueGrid.innerHTML = '<div class="empty">' + escapeHtml(S.noBytes) + '</div>';
            return;
        }
        valueGrid.innerHTML = rows.map(row =>
            '<div class="value-item"><span class="value-name">' + escapeHtml(S[row.key]) +
            '</span><span class="value-number" title="' + escapeHtml(row.value) + '">' + escapeHtml(row.value) + '</span></div>'
        ).join('');
    }

    function renderSavedValues() {
        savedCount.textContent = template(S.savedCount, { count: savedValues.length });
        if (savedValues.length === 0) {
            savedList.innerHTML = '<li class="saved-empty">' + escapeHtml(S.savedEmpty) + '</li>';
            return;
        }
        const formatter = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        savedList.innerHTML = savedValues.map(entry => {
            const kind = entry.kind === 'hex' ? S.hexLabel : S.textLabel;
            const serialized = entry.kind === 'text' ? JSON.stringify(entry.value).slice(1, -1) : entry.value;
            const preview = serialized.trim().length > 0 ? serialized : S.whitespaceValue;
            const meta = template(S.bytes, { count: entry.byteCount }) + ' · ' +
                (entry.encoding === 'ascii' ? S.ascii : S.utf8) + ' · ' + formatter.format(new Date(entry.savedAt));
            return '<li class="saved-item">' +
                '<button class="saved-load" type="button" data-action="load" data-id="' + escapeHtml(entry.id) +
                    '" aria-label="' + escapeHtml(S.loadSaved + ': ' + preview) + '">' +
                    '<span class="saved-kind">' + escapeHtml(kind) + '</span>' +
                    '<span class="saved-preview" title="' + escapeHtml(preview) + '">' + escapeHtml(preview) + '</span>' +
                    '<span class="saved-meta">' + escapeHtml(meta) + '</span>' +
                '</button>' +
                '<button class="saved-delete" type="button" data-action="delete" data-id="' + escapeHtml(entry.id) +
                    '" aria-label="' + escapeHtml(S.deleteSaved + ': ' + preview) + '">×</button>' +
            '</li>';
        }).join('');
    }

    function errorMessage(reason) {
        switch (reason) {
            case 'invalid-character': return S.invalidCharacter;
            case 'missing-byte': return S.missingByte;
            case 'odd-digits': return S.oddDigits;
            case 'too-large': return S.tooLarge;
            case 'non-ascii-character': return S.nonAsciiCharacter;
            case 'non-ascii-byte': return S.nonAsciiByte;
            case 'invalid-utf8': return S.invalidUtf8;
            default: return S.ready;
        }
    }

    function persist() {
        vscode.setState({
            source: activeSource,
            text: textInput.value,
            hex: hexInput.value,
            encoding: encoding.value,
            hexGroup: selectedHexGroup(),
            bytesPerRow: selectedBytesPerRow(),
            endian: endian.value,
            bitwise: {
                expression: bitwiseExpression.value,
                width: Number(bitwiseWidth.value),
                open: bitwisePanel.open,
            },
        });
    }

    function setBitwiseStatus(message, kind) {
        bitwiseStatus.textContent = message;
        bitwiseStatus.classList.toggle('is-error', kind === 'error');
        bitwiseStatus.classList.toggle('is-success', kind === 'success');
    }

    function updateBitwise(deferError = false) {
        if (bitwiseErrorTimer !== undefined) {
            clearTimeout(bitwiseErrorTimer);
            bitwiseErrorTimer = undefined;
        }
        bitwiseCopyRequestId++;
        const width = Number(bitwiseWidth.value);
        const result = evaluateHexBitwiseExpression(bitwiseExpression.value, width);
        bitwiseResult = result.ok ? result : undefined;
        const hasError = !result.ok && result.reason !== 'empty';
        bitwiseExpression.setAttribute('aria-invalid', String(hasError && !deferError));
        for (const format of ['hex', 'decimal', 'binary']) {
            bitwiseOutputs[format].textContent = result.ok ? result[format] : S.bitwiseEmptyResult;
            bitwiseCopyButtons[format].disabled = !result.ok;
        }
        if (result.ok) {
            setBitwiseStatus(template(S.bitwiseSuccess, { width }), 'success');
        } else if (!hasError) {
            setBitwiseStatus(S.bitwiseReady, 'idle');
        } else {
            const messages = {
                'invalid-width': S.bitwiseInvalidWidth,
                'invalid-token': S.bitwiseInvalidToken,
                'invalid-expression': S.bitwiseInvalidExpression,
                'out-of-range': template(S.bitwiseOutOfRange, { width }),
                'invalid-shift': template(S.bitwiseInvalidShift, { max: width - 1 }),
                'too-complex': S.bitwiseTooComplex,
            };
            const showError = () => {
                bitwiseErrorTimer = undefined;
                bitwiseExpression.setAttribute('aria-invalid', 'true');
                setBitwiseStatus(template(S.bitwiseErrorPosition, {
                    message: messages[result.reason], position: result.index + 1,
                }), 'error');
            };
            if (deferError) {
                setBitwiseStatus(S.bitwiseEditing, 'idle');
                bitwiseErrorTimer = setTimeout(showError, BITWISE_ERROR_DELAY_MS);
            } else {
                showError();
            }
        }
    }

    bitwiseExpression.addEventListener('input', () => { updateBitwise(true); persist(); });
    bitwiseExpression.addEventListener('blur', () => {
        if (bitwiseErrorTimer !== undefined) { updateBitwise(); }
    });
    bitwiseWidth.addEventListener('change', () => { updateBitwise(); persist(); });
    bitwisePanel.addEventListener('toggle', persist);
    bitwiseClear.addEventListener('click', () => {
        bitwiseExpression.value = '';
        updateBitwise();
        persist();
        bitwiseExpression.focus();
    });
    for (const format of ['hex', 'decimal', 'binary']) {
        bitwiseCopyButtons[format].addEventListener('click', () => {
            if (!bitwiseResult) { return; }
            vscode.postMessage({
                command: 'copyBitwiseResult',
                expression: bitwiseExpression.value,
                width: Number(bitwiseWidth.value),
                format,
                requestId: ++bitwiseCopyRequestId,
            });
        });
    }

    function cancelPendingConversion() {
        if (conversionTimer === undefined) { return; }
        clearTimeout(conversionTimer);
        conversionTimer = undefined;
    }

    function showPendingConversion(source) {
        activeSource = source;
        currentBytes = new Uint8Array();
        if (source === 'text') {
            hexInput.value = '';
            copyText.disabled = textInput.value.length === 0;
            copyHex.disabled = true;
        } else {
            textInput.value = '';
            copyText.disabled = true;
            copyHex.disabled = hexInput.value.length === 0;
        }
        textCount.textContent = '';
        hexCount.textContent = '';
        saveText.disabled = true;
        saveHex.disabled = true;
        valueGrid.innerHTML = '<div class="empty">' + escapeHtml(S.noBytes) + '</div>';
        renderHexOffsets(true);
        renderIncompleteGroup(currentBytes);
        setStatus(S.conversionPending, 'idle');
    }

    function scheduleConversion(source) {
        cancelPendingConversion();
        activeSource = source;
        const inputLength = source === 'hex' ? hexInput.value.length : textInput.value.length;
        if (inputLength <= LARGE_INPUT_CHARACTERS) {
            if (source === 'hex') { updateFromHex(); } else { updateFromText(); }
            return;
        }
        showPendingConversion(source);
        conversionTimer = setTimeout(() => {
            conversionTimer = undefined;
            if (activeSource !== source) { return; }
            if (source === 'hex') { updateFromHex(); } else { updateFromText(); }
        }, LARGE_INPUT_DELAY_MS);
    }

    function updateFromText() {
        activeSource = 'text';
        const result = encodeHexConverterText(textInput.value, encoding.value, MAX_BYTES);
        if (!result.ok) {
            hexInput.value = '';
            setBytes(new Uint8Array());
            setStatus(errorMessage(result.reason), 'error');
            persist();
            return;
        }
        hexInput.value = formatBytes(result.bytes);
        setBytes(result.bytes);
        const message = result.bytes.length === 0 ? S.ready : template(S.fromText, { bytes: result.bytes.length });
        setStatus(withIncompleteGroup(message, result.bytes), result.bytes.length === 0 ? 'idle' : 'success');
        persist();
    }

    function updateFromHex(normalize = false) {
        activeSource = 'hex';
        const parsed = parseHexConverterInput(hexInput.value, MAX_BYTES);
        if (!parsed.ok) {
            textInput.value = '';
            setBytes(new Uint8Array());
            const incomplete = parsed.reason === 'odd-digits' || parsed.reason === 'missing-byte';
            setStatus(errorMessage(parsed.reason), incomplete ? 'idle' : 'error');
            persist();
            return;
        }
        if (normalize) { hexInput.value = formatBytes(parsed.bytes); }
        const decoded = decodeHexConverterBytes(parsed.bytes, encoding.value);
        if (!decoded.ok) {
            textInput.value = '';
            setBytes(parsed.bytes);
            setStatus(errorMessage(decoded.reason), 'error');
            persist();
            return;
        }
        textInput.value = decoded.text;
        setBytes(parsed.bytes);
        const message = parsed.bytes.length === 0 ? S.ready : template(S.fromHex, { bytes: parsed.bytes.length });
        setStatus(withIncompleteGroup(message, parsed.bytes), parsed.bytes.length === 0 ? 'idle' : 'success');
        persist();
    }

    textInput.addEventListener('input', () => scheduleConversion('text'));
    hexInput.addEventListener('input', () => scheduleConversion('hex'));
    hexInput.addEventListener('blur', () => {
        if (conversionTimer !== undefined && activeSource === 'hex') {
            cancelPendingConversion();
            updateFromHex(true);
            return;
        }
        const parsed = parseHexConverterInput(hexInput.value, MAX_BYTES);
        if (parsed.ok) {
            hexInput.value = formatBytes(parsed.bytes);
            renderHexOffsets();
            persist();
        }
    });
    encoding.addEventListener('change', () => {
        scheduleConversion(activeSource);
        persistPreferences();
    });
    hexGroup.addEventListener('change', () => {
        updateHexPlaceholder();
        if (conversionTimer === undefined && currentBytes.length > 0) {
            // 표시 설정을 바꿔도 원래 변환 경로에서 입력의 유효성을 확인한다.
            if (activeSource === 'hex') { updateFromHex(true); } else { updateFromText(); }
        } else {
            renderIncompleteGroup(currentBytes);
        }
        persist();
        persistPreferences();
    });
    bytesPerRow.addEventListener('change', () => {
        updateHexPlaceholder();
        if (conversionTimer === undefined && currentBytes.length > 0) {
            hexInput.value = formatBytes(currentBytes);
        }
        renderHexOffsets(conversionTimer !== undefined);
        persist();
    });
    endian.addEventListener('change', () => {
        if (conversionTimer === undefined) { setBytes(currentBytes); }
        persist();
        persistPreferences();
    });
    hexInput.addEventListener('scroll', () => { hexOffsets.scrollTop = hexInput.scrollTop; });
    clearButton.addEventListener('click', () => {
        cancelPendingConversion();
        textInput.value = '';
        hexInput.value = '';
        activeSource = 'text';
        setBytes(new Uint8Array());
        setStatus(S.ready, 'idle');
        persist();
        textInput.focus();
    });
    copyText.addEventListener('click', () => {
        if (textInput.value.length > 0) { vscode.postMessage({ command: 'copy', kind: 'text', text: textInput.value }); }
    });
    copyHex.addEventListener('click', () => {
        if (hexInput.value.length > 0) { vscode.postMessage({ command: 'copy', kind: 'hex', text: hexInput.value }); }
    });
    function requestSave(kind) {
        if (currentBytes.length === 0) { return; }
        if (currentBytes.length > MAX_SAVED_BYTES) {
            setStatus(S.saveTooLarge, 'error');
            return;
        }
        vscode.postMessage({
            command: 'saveValue',
            kind,
            value: kind === 'hex' ? hexInput.value : textInput.value,
            encoding: encoding.value,
            endian: endian.value,
        });
    }
    saveText.addEventListener('click', () => requestSave('text'));
    saveHex.addEventListener('click', () => requestSave('hex'));
    savedList.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) { return; }
        const button = target.closest('button[data-action]');
        if (!button) { return; }
        const entry = savedValues.find(candidate => candidate.id === button.dataset.id);
        if (!entry) { return; }
        if (button.dataset.action === 'delete') {
            vscode.postMessage({ command: 'deleteSavedValue', id: entry.id });
            return;
        }
        encoding.value = entry.encoding;
        endian.value = entry.endian;
        persistPreferences();
        if (entry.kind === 'hex') {
            cancelPendingConversion();
            hexInput.value = entry.value;
            updateFromHex(true);
            hexInput.focus();
        } else {
            textInput.value = entry.value;
            scheduleConversion('text');
            textInput.focus();
        }
        setStatus(withIncompleteGroup(S.loaded, currentBytes), 'success');
    });
    window.addEventListener('message', event => {
        const message = event.data;
        if (!message) { return; }
        if (message.command === 'bitwiseCopyResult') {
            if (message.requestId === bitwiseCopyRequestId && bitwiseResult) {
                setBitwiseStatus(message.ok ? S.bitwiseCopied : S.copyFailed, message.ok ? 'success' : 'error');
            }
        } else if (message.command === 'copyResult') {
            setStatus(message.ok ? (message.kind === 'hex' ? S.copiedHex : S.copiedText) : S.copyFailed, message.ok ? 'success' : 'error');
        } else if (message.command === 'savedValues' && Array.isArray(message.values)) {
            savedValues = message.values;
            renderSavedValues();
            setStatus(message.action === 'deleted' ? S.deleted : S.saved, 'success');
        } else if (message.command === 'saveResult' && !message.ok) {
            setStatus(message.reason === 'too-large' ? S.saveTooLarge : S.saveFailed, 'error');
        }
    });

    renderSavedValues();
    encoding.value = INITIAL_PREFERENCES.encoding;
    hexGroup.value = String(INITIAL_PREFERENCES.hexGroup);
    endian.value = INITIAL_PREFERENCES.endian;
    bitwiseWidth.value = '32';
    bitwisePanel.open = true;
    const restored = vscode.getState();
    if (restored && restored.bitwise && typeof restored.bitwise === 'object') {
        if ([8, 16, 32, 64].includes(restored.bitwise.width)) {
            bitwiseWidth.value = String(restored.bitwise.width);
        }
        if (typeof restored.bitwise.expression === 'string') { bitwiseExpression.value = restored.bitwise.expression; }
        if (typeof restored.bitwise.open === 'boolean') { bitwisePanel.open = restored.bitwise.open; }
    }
    if (restored && (restored.encoding === 'utf8' || restored.encoding === 'ascii')) { encoding.value = restored.encoding; }
    if (restored && (restored.hexGroup === 1 || restored.hexGroup === 2 || restored.hexGroup === 4)) {
        hexGroup.value = String(restored.hexGroup);
    }
    if (restored && (restored.bytesPerRow === 8 || restored.bytesPerRow === 16 || restored.bytesPerRow === 32)) {
        bytesPerRow.value = String(restored.bytesPerRow);
    }
    if (restored && (restored.endian === 'little' || restored.endian === 'big')) { endian.value = restored.endian; }
    if (restored && typeof restored.text === 'string') { textInput.value = restored.text; }
    if (restored && typeof restored.hex === 'string') { hexInput.value = restored.hex; }
    updateHexPlaceholder();
    updateBitwise();
    if (restored && restored.source === 'hex') { scheduleConversion('hex'); } else { scheduleConversion('text'); }
</script>
</body>
</html>`;
}

function disposeCurrentMessage(): void {
    const disposable = currentMessageDisposable;
    currentMessageDisposable = undefined;
    disposable?.dispose();
}

export function showHexConverter(context: vscode.ExtensionContext): void {
    if (currentPanel) {
        try {
            currentPanel.reveal(vscode.ViewColumn.Active);
            return;
        } catch {
            disposeCurrentMessage();
            currentPanel = undefined;
        }
    }

    const panel = vscode.window.createWebviewPanel(
        'taskhub.hexConverter',
        t('Hex/Text 변환기', 'Hex/Text Converter'),
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    currentPanel = panel;
    panel.webview.html = buildHexConverterHtml(panel.webview, readSavedValues(context), readPreferences(context));

    let preferencesUpdate = Promise.resolve();
    currentMessageDisposable = panel.webview.onDidReceiveMessage(async message => {
        switch (message?.command) {
            case 'updatePreferences': {
                if (
                    (message.encoding !== 'utf8' && message.encoding !== 'ascii')
                    || (message.hexGroup !== 1 && message.hexGroup !== 2 && message.hexGroup !== 4)
                    || (message.endian !== 'little' && message.endian !== 'big')
                ) {
                    return;
                }
                const preferences: HexConverterPreferences = {
                    encoding: message.encoding,
                    hexGroup: message.hexGroup,
                    endian: message.endian,
                };
                preferencesUpdate = preferencesUpdate.then(
                    () => context.globalState.update(HEX_CONVERTER_PREFERENCES_KEY, preferences),
                    () => context.globalState.update(HEX_CONVERTER_PREFERENCES_KEY, preferences)
                );
                try { await preferencesUpdate; } catch { /* 최근 UI 설정 저장 실패는 현재 변환을 막지 않는다. */ }
                return;
            }
            case 'copy': {
                if (
                    (message.kind !== 'text' && message.kind !== 'hex')
                    || typeof message.text !== 'string'
                    || message.text.length > HEX_CONVERTER_MAX_COPY_CHARACTERS
                ) {
                    await panel.webview.postMessage({ command: 'copyResult', ok: false, kind: message?.kind });
                    return;
                }
                try {
                    await vscode.env.clipboard.writeText(message.text);
                    await panel.webview.postMessage({ command: 'copyResult', ok: true, kind: message.kind });
                } catch {
                    void panel.webview.postMessage({ command: 'copyResult', ok: false, kind: message.kind })
                        .then(undefined, () => undefined);
                }
                return;
            }
            case 'copyBitwiseResult': {
                if (!Number.isSafeInteger(message.requestId) || message.requestId < 0) { return; }
                const requestId: number = message.requestId;
                if (
                    typeof message.expression !== 'string'
                    || typeof message.width !== 'number'
                    || (message.format !== 'hex' && message.format !== 'decimal' && message.format !== 'binary')
                ) {
                    await panel.webview.postMessage({ command: 'bitwiseCopyResult', ok: false, requestId });
                    return;
                }
                const result = evaluateHexBitwiseExpression(message.expression, message.width);
                if (!result.ok) {
                    await panel.webview.postMessage({ command: 'bitwiseCopyResult', ok: false, requestId });
                    return;
                }
                const format: 'hex' | 'decimal' | 'binary' = message.format;
                try {
                    await vscode.env.clipboard.writeText(result[format]);
                    await panel.webview.postMessage({ command: 'bitwiseCopyResult', ok: true, requestId });
                } catch {
                    void panel.webview.postMessage({ command: 'bitwiseCopyResult', ok: false, requestId })
                        .then(undefined, () => undefined);
                }
                return;
            }
            case 'saveValue': {
                const created = createSavedValue(message);
                if (!created.ok) {
                    await panel.webview.postMessage({ command: 'saveResult', ok: false, reason: created.reason });
                    return;
                }
                const { entry } = created;
                const withoutDuplicate = readSavedValues(context).filter(existing =>
                    existing.kind !== entry.kind
                    || existing.value !== entry.value
                    || existing.encoding !== entry.encoding
                    || existing.endian !== entry.endian
                );
                const values = [entry, ...withoutDuplicate].slice(0, HEX_CONVERTER_MAX_SAVED_VALUES);
                try {
                    await context.globalState.update(HEX_CONVERTER_SAVED_VALUES_KEY, values);
                    await panel.webview.postMessage({ command: 'savedValues', values, action: 'saved' });
                } catch {
                    void panel.webview.postMessage({ command: 'saveResult', ok: false })
                        .then(undefined, () => undefined);
                }
                return;
            }
            case 'deleteSavedValue': {
                if (typeof message.id !== 'string') { return; }
                const current = readSavedValues(context);
                const values = current.filter(entry => entry.id !== message.id);
                if (values.length === current.length) { return; }
                try {
                    await context.globalState.update(HEX_CONVERTER_SAVED_VALUES_KEY, values);
                    await panel.webview.postMessage({ command: 'savedValues', values, action: 'deleted' });
                } catch {
                    void panel.webview.postMessage({ command: 'saveResult', ok: false })
                        .then(undefined, () => undefined);
                }
                return;
            }
        }
    });

    panel.onDidDispose(() => {
        if (currentPanel !== panel) { return; }
        disposeCurrentMessage();
        currentPanel = undefined;
    });
}

/** 테스트에서 singleton 패널 수명주기를 관찰·정리한다. */
export const hexConverterPanelRegistry = {
    hasPanel(): boolean { return currentPanel !== undefined; },
    getHtml(): string | undefined { return currentPanel?.webview.html; },
    clear(): void {
        const panel = currentPanel;
        disposeCurrentMessage();
        currentPanel = undefined;
        panel?.dispose();
    },
};
