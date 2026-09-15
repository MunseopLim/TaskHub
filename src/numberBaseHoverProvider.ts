import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    extractBitFieldInfo,
    extractHierarchy,
    formatHierarchy,
    calculateValidRange,
    calculateBitMask,
    getAccessTypeDescription,
    CompleteBitFieldInfo
} from './sfrBitFieldParser';
import { MacroExpander, MacroDefinition } from './macroExpander';
import { RegisterDecoder, RegisterDefinition, RegisterDecodingResult } from './registerDecoder';
import { StructSizeCalculator, StructSizeResult, TypeConfigFile } from './structSizeCalculator';
import { t } from './i18n';

/** Cache entry for type config loaded from taskhub_types.json */
interface TypeConfigCacheEntry {
    mtime: number;
    config: TypeConfigFile | undefined;
}

/** Maximum number of taskhub_types.json files cached across workspaces. */
const TYPE_CONFIG_CACHE_MAX = 16;

/** One budget shared by every LSP request and document read in a hover. */
const LSP_TIMEOUT_MS = 3000;
export const MAX_HOVER_DEFINITION_CANDIDATES = 16;

interface DefinitionCandidates {
    locations: vscode.Location[];
    incomplete: boolean;
    candidateLimitReached: boolean;
}

type CandidateDocumentListener = (location: vscode.Location, document: Promise<vscode.TextDocument | undefined>) => void;

interface DefinitionLookup {
    result: Promise<DefinitionCandidates>;
    documents: Map<string, { location: vscode.Location; document: Promise<vscode.TextDocument | undefined> }>;
    listeners: Set<CandidateDocumentListener>;
}

interface HoverCandidate<T> {
    location: vscode.Location;
    value: T | null;
    /** The location timed out or failed; it is listed but does not take part in agreement. */
    unchecked?: boolean;
}

interface CandidateResolution<T> {
    candidates: HoverCandidate<T>[];
    incomplete: boolean;
    /** Some lookups failed; agreeing checked values are shown with a warning instead of withheld. */
    unverified?: boolean;
    /** Recognized values can conflict within a single LSP hover location. */
    hasValueEvidence?: boolean;
}

interface HoverRequest {
    token?: vscode.CancellationToken;
    deadline: number;
    allowLsp: boolean;
    definitions: Map<string, DefinitionLookup>;
    identifiers: Map<string, Promise<CandidateResolution<number>>>;
    documents: Map<string, Promise<vscode.TextDocument | undefined>>;
    versions: Map<vscode.TextDocument, number>;
    visited: Set<string>;
    maxCandidates: number;
}

const COPY_HOVER_VALUE_COMMAND = 'taskhub.copyHoverValue';
const MAX_HOVER_LINE_LENGTH = 10_000;
// Hex expands to at most four binary digits per source character, plus sign/prefix.
export const MAX_HOVER_COPY_LENGTH = Math.max(64 * 1024, MAX_HOVER_LINE_LENGTH * 4 + 3);

function isCopyableHoverValue(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_HOVER_COPY_LENGTH
        && value.trim() === value && /^-?(?:0x[0-9a-f]+|0b[01]+|[0-9]+)$/i.test(value);
}

/** Copy the displayed text without converting exact 64-bit values back to numbers. */
export function registerHoverCopyCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(COPY_HOVER_VALUE_COMMAND, async (value: unknown) => {
        if (!isCopyableHoverValue(value)) {
            return;
        }
        try {
            await vscode.env.clipboard.writeText(value);
        } catch {
            vscode.window.showErrorMessage(t('값을 클립보드에 복사하지 못했습니다.', 'Failed to copy the value to the clipboard.'));
        }
    });
}

function createCopyableHoverMarkdown(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: [COPY_HOVER_VALUE_COMMAND] };
    md.supportThemeIcons = true;
    return md;
}

/** `extern const int X;`-style line: names the identifier with no initializer, body, or call. */
function isValuelessDeclaration(line: string, word: string): boolean {
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^[^=(){}#]*\\b${escapedWord}\\b\\s*(?:\\[[^\\]]*\\]\\s*)*;\\s*$`).test(code);
}

/** Treat source fragments as text, including inside table cells and headings. */
function escapeHoverText(value: string): string {
    return new vscode.MarkdownString('', true)
        .appendText(value.replace(/[\r\n]+/g, ' '))
        .value.replace(/\|/g, '\\|');
}

/** Only numeric literals may become command arguments or link titles. */
export function formatCopyableHoverValue(value: string): string {
    if (!isCopyableHoverValue(value)) {
        return escapeHoverText(value);
    }
    const args = encodeURIComponent(JSON.stringify([value]));
    const title = t(`${value} 복사`, `Copy ${value}`);
    return `\`${value}\` [$(copy)](command:${COPY_HOVER_VALUE_COMMAND}?${args} "${title}")`;
}

function isExactHoverInteger(value: number | bigint): boolean {
    return typeof value === 'bigint' || Number.isSafeInteger(value);
}

function safeIntegerOrNull(value: number): number | null {
    return Number.isSafeInteger(value) ? value : null;
}

function formatHoverInteger(value: number | bigint, radix: 2 | 10 | 16, minDigits = 0): string {
    const integer = BigInt(value);
    const magnitude = integer < 0n ? -integer : integer;
    const prefix = radix === 16 ? '0x' : radix === 2 ? '0b' : '';
    return `${integer < 0n ? '-' : ''}${prefix}${magnitude.toString(radix).toUpperCase().padStart(minDigits, '0')}`;
}

function appendNumberConversions(md: vscode.MarkdownString, value: number | bigint): boolean {
    if (!isExactHoverInteger(value)) {
        md.appendText(t('정확한 정수 값을 확인할 수 없어 진법 변환과 복사를 제공하지 않습니다.',
            'Base conversion and copying are unavailable because the exact integer value cannot be determined.'));
        md.appendMarkdown('\n\n');
        return false;
    }
    md.appendMarkdown(`**Hex:** ${formatCopyableHoverValue(formatHoverInteger(value, 16))}\n\n`);
    md.appendMarkdown(`**Dec:** ${formatCopyableHoverValue(formatHoverInteger(value, 10))}\n\n`);
    md.appendMarkdown(`**Bin:** ${formatCopyableHoverValue(formatHoverInteger(value, 2))}\n\n`);
    return true;
}

/**
 * Race a promise against a timer and the hover cancellation token.
 * Returns undefined when the LSP call does not complete in time or the user moves the cursor.
 */
function withLspTimeout<T>(
    call: () => Thenable<T>,
    token?: vscode.CancellationToken,
    timeoutMs: number = LSP_TIMEOUT_MS
): Promise<T | undefined> {
    if (token?.isCancellationRequested || timeoutMs <= 0) { return Promise.resolve(undefined); }
    return new Promise<T | undefined>(resolve => {
        let settled = false;
        let onCancel: vscode.Disposable | undefined;
        const finish = (value: T | undefined) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            onCancel?.dispose();
            resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        onCancel = token?.onCancellationRequested(() => finish(undefined));
        if (token?.isCancellationRequested) { finish(undefined); return; }
        try {
            Promise.resolve(call()).then(finish, () => finish(undefined));
        } catch { finish(undefined); }
    });
}

/**
 * Hover provider that shows number base conversions for C/C++ numeric literals
 * and SFR bit field information
 */
export class NumberBaseHoverProvider implements vscode.HoverProvider {
    /** Guard against pathological lines (minified/generated) that make regex matching slow. */
    public static readonly MAX_LINE_LENGTH = MAX_HOVER_LINE_LENGTH;

    /**
     * Pure predicate equivalent to the in-line check
     * `lineText.length > MAX_LINE_LENGTH` used in provideHoverImpl(). Extracted
     * so unit tests can pin the off-by-one boundary without mocking the whole
     * vscode.TextDocument surface that the full hover pipeline touches.
     */
    public static isLineTooLongForHover(lineText: string): boolean {
        return lineText.length > NumberBaseHoverProvider.MAX_LINE_LENGTH;
    }

    /**
     * Active LSP hover invocations keyed by `${uri}:${line}:${char}`.
     * Prevents re-entry when our own hover provider triggers `executeHoverProvider`
     * at the same position and avoids races when the cursor moves quickly.
     */
    private readonly activeHoverCalls = new Set<string>();
    /** Separate from provider lifetime: a local result may return before its fallback settles. */
    private readonly activeLspHovers = new Map<string, number>();

    constructor(
        private readonly workspaceFolderForUri: (uri: vscode.Uri) => vscode.WorkspaceFolder | undefined
            = uri => vscode.workspace.getWorkspaceFolder(uri),
        private readonly limits = { timeoutMs: LSP_TIMEOUT_MS, maxCandidates: MAX_HOVER_DEFINITION_CANDIDATES }
    ) {}

    // M12 성능 캐시 — 같은 문서 버전이면 호버마다 전체 텍스트를 다시
    // 파싱/복사하지 않는다 (수만 줄 SFR 헤더에서 호버 지연의 주범).
    private macroTableCache: { uri: string; version: number; macros: Map<string, MacroDefinition> } | undefined;
    private documentLinesCache: { uri: string; version: number; lines: string[] } | undefined;
    private registerCodeCache: { uri: string; version: number; text: string } | undefined;

    /**
     * 문서 전체 라인 배열 (document.version 키 캐시). 반환 배열은 캐시와
     * 공유되므로 호출자는 읽기 전용으로만 사용해야 한다.
     */
    private getDocumentLines(document: vscode.TextDocument): string[] {
        const uri = document.uri.toString();
        const cached = this.documentLinesCache;
        if (cached && cached.uri === uri && cached.version === document.version) {
            return cached.lines;
        }
        const lines = document.getText().split(/\r?\n/);
        // Struct packing metadata can safely share this immutable version snapshot.
        Object.freeze(lines);
        this.documentLinesCache = { uri, version: document.version, lines };
        return lines;
    }

    /** 문서의 #define 매크로 테이블 (document.version 키 캐시). */
    private getMacroTable(document: vscode.TextDocument): Map<string, MacroDefinition> {
        const uri = document.uri.toString();
        const cached = this.macroTableCache;
        if (cached && cached.uri === uri && cached.version === document.version) {
            return cached.macros;
        }
        const macros = MacroExpander.parseMacroDefinitions(document.getText());
        this.macroTableCache = { uri, version: document.version, macros };
        return macros;
    }
    private readonly typeConfigCache = new Map<string, TypeConfigCacheEntry>();

    private hoverKey(uri: vscode.Uri, position: vscode.Position): string {
        return `${uri.toString()}:${position.line}:${position.character}`;
    }

    private createRequest(token?: vscode.CancellationToken, allowLsp = true): HoverRequest {
        return {
            token, deadline: Date.now() + this.limits.timeoutMs, allowLsp,
            definitions: new Map(), identifiers: new Map(), documents: new Map(), versions: new Map(), visited: new Set(),
            maxCandidates: this.limits.maxCandidates,
        };
    }

    private requestActive(request: HoverRequest): boolean {
        return this.requestSnapshotValid(request) && Date.now() < request.deadline;
    }

    private requestSnapshotValid(request: HoverRequest): boolean {
        return !request.token?.isCancellationRequested
            && [...request.versions].every(([document, version]) => document.version === version);
    }

    private waitForRequest<T>(request: HoverRequest, call: () => Thenable<T>): Promise<T | undefined> {
        if (!this.requestActive(request)) { return Promise.resolve(undefined); }
        return withLspTimeout(call, request.token, request.deadline - Date.now());
    }

    private async requestLspHovers(uri: vscode.Uri, position: vscode.Position, request: HoverRequest): Promise<vscode.Hover[] | undefined> {
        if (!request.allowLsp || !this.requestActive(request)) { return undefined; }
        const key = this.hoverKey(uri, position);
        this.activeLspHovers.set(key, (this.activeLspHovers.get(key) ?? 0) + 1);
        try {
            return await this.waitForRequest(request, () => vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider', uri, position));
        } finally {
            // Release on the bounded wait, not the raw LSP promise: a stalled
            // language server must not permanently suppress future user hovers.
            const remaining = (this.activeLspHovers.get(key) ?? 1) - 1;
            if (remaining === 0) { this.activeLspHovers.delete(key); }
            else { this.activeLspHovers.set(key, remaining); }
        }
    }

    /** Definitions and declarations are alternatives, never evidence that the first is active. */
    private definitionCandidates(document: vscode.TextDocument, position: vscode.Position, request: HoverRequest,
        onDocument?: CandidateDocumentListener): Promise<DefinitionCandidates> {
        if (!request.allowLsp) { return Promise.resolve({ locations: [], incomplete: false, candidateLimitReached: false }); }
        const key = this.hoverKey(document.uri, position);
        const cached = request.definitions.get(key);
        if (cached) {
            if (onDocument) {
                cached.listeners.add(onDocument);
                for (const candidate of cached.documents.values()) { onDocument(candidate.location, candidate.document); }
            }
            return cached.result;
        }
        const documents: DefinitionLookup['documents'] = new Map();
        const listeners = new Set<CandidateDocumentListener>(onDocument ? [onDocument] : []);
        const pending = (async (): Promise<DefinitionCandidates> => {
            const byLocation = new Map<string, vscode.Location>();
            const documentReads: Promise<vscode.TextDocument | undefined>[] = [];
            let incomplete = false;
            let candidateLimitReached = false;
            await Promise.all(['vscode.executeDefinitionProvider', 'vscode.executeDeclarationProvider'].map(async command => {
                const resultsForCommand = await this.waitForRequest(request, () =>
                    vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(command, document.uri, position));
                if (!resultsForCommand) { incomplete = true; return; }
                if (resultsForCommand.length > request.maxCandidates) { candidateLimitReached = true; }
                for (const candidate of resultsForCommand.slice(0, request.maxCandidates)) {
                    const uri = 'targetUri' in candidate ? candidate.targetUri : candidate.uri;
                    const range = 'targetUri' in candidate ? candidate.targetSelectionRange ?? candidate.targetRange : candidate.range;
                    if (!uri || !range) { incomplete = true; continue; }
                    const locationKey = this.hoverKey(uri, range.start);
                    if (byLocation.has(locationKey)) { continue; }
                    if (byLocation.size >= request.maxCandidates) { candidateLimitReached = true; continue; }
                    const location = new vscode.Location(uri, range);
                    byLocation.set(locationKey, location);
                    // Start bounded reads as each provider responds. A slow declaration
                    // provider or document must not consume the budget before other values are read.
                    const candidateDocument = this.openCandidate(location, request);
                    documents.set(locationKey, { location, document: candidateDocument });
                    documentReads.push(candidateDocument);
                    for (const listener of listeners) { listener(location, candidateDocument); }
                }
            }));
            await Promise.all(documentReads);
            const locations = [...byLocation.values()].sort((a, b) =>
                this.hoverKey(a.uri, a.range.start).localeCompare(this.hoverKey(b.uri, b.range.start)));
            return { locations, incomplete: incomplete || candidateLimitReached, candidateLimitReached };
        })();
        request.definitions.set(key, { result: pending, documents, listeners });
        return pending;
    }

    private async openCandidate(location: vscode.Location, request: HoverRequest): Promise<vscode.TextDocument | undefined> {
        if (!this.requestSnapshotValid(request)) { return undefined; }
        const locationKey = this.hoverKey(location.uri, location.range.start);
        if (!request.visited.has(locationKey)) {
            if (request.visited.size >= request.maxCandidates) { return undefined; }
            request.visited.add(locationKey);
        }
        const key = location.uri.toString();
        let pending = request.documents.get(key);
        if (!pending) {
            if (!this.requestActive(request)) { return undefined; }
            pending = this.waitForRequest(request, () => vscode.workspace.openTextDocument(location.uri));
            request.documents.set(key, pending);
        }
        const document = await pending;
        if (document && !request.versions.has(document)) { request.versions.set(document, document.version); }
        return this.requestSnapshotValid(request) && document && location.range.start.line < document.lineCount
            ? document : undefined;
    }

    private resolvedCandidateValue<T>(resolution: CandidateResolution<T>): T | null {
        const checked = resolution.candidates.filter(candidate => !candidate.unchecked);
        if (resolution.incomplete || checked.length === 0) { return null; }
        const first = checked[0].value;
        if (first === null) { return null; }
        const signature = JSON.stringify(first);
        return checked.every(candidate => candidate.value !== null && JSON.stringify(candidate.value) === signature)
            ? first : null;
    }

    private hasValueCandidates<T>(resolution: CandidateResolution<T>): boolean {
        return resolution.hasValueEvidence === true || resolution.candidates.some(candidate => candidate.value !== null);
    }

    private candidatePath(location: vscode.Location): string {
        const folder = this.workspaceFolderForUri(location.uri);
        return `${folder ? `${folder.name}/${path.relative(folder.uri.fsPath, location.uri.fsPath).replace(/\\/g, '/')}` : location.uri.fsPath}:${location.range.start.line + 1}`;
    }

    private appendCandidates<T>(md: vscode.MarkdownString, resolution: CandidateResolution<T>, describe: (value: T) => string): void {
        md.appendMarkdown(`\n\n**${t('정의 후보', 'Definition candidates')}:**\n\n`);
        for (const candidate of resolution.candidates) {
            const label = escapeHoverText(this.candidatePath(candidate.location));
            const target = candidate.location.uri.with({ fragment: String(candidate.location.range.start.line + 1) }).toString()
                .replace(/\(/g, '%28').replace(/\)/g, '%29');
            const link = candidate.location.uri.scheme.toLowerCase() === 'command' ? label : `[${label}](${target})`;
            const detail = candidate.unchecked ? t('확인하지 못함', 'Not checked')
                : candidate.value === null ? t('해석하지 못함', 'Unresolved') : describe(candidate.value);
            md.appendMarkdown(`- ${link} — ${escapeHoverText(detail)}\n`);
        }
        if (resolution.incomplete || resolution.unverified) {
            md.appendText(t('시간·후보 수 제한 또는 조회 실패로 확인하지 못한 후보가 있습니다.',
                'Some candidates could not be checked because a time/candidate limit was reached or a lookup failed.'));
        }
    }

    private unresolvedCandidates<T>(resolution: CandidateResolution<T>, describe: (value: T) => string): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendText(t('정의 후보가 다르거나 모두 확인되지 않아 값을 확정할 수 없습니다. F12/Peek에서 사용할 정의를 확인하세요.',
            'The value cannot be determined because definitions differ or could not all be checked. Inspect the intended definition with F12/Peek.'));
        this.appendCandidates(md, resolution, describe);
        return md;
    }

    /**
     * Regex patterns for detecting different number formats
     */
    private readonly patterns = {
        // Hexadecimal: 0xABC, 0XABC (with optional digit separators)
        hex0x: /\b0[xX][0-9a-fA-F']+\b/,
        // Hexadecimal with 'h' suffix: ABCh, ABCh (with optional digit separators)
        hexH: /\b[0-9a-fA-F']+[hH]\b/,
        // Binary: 0b1010, 0B1010 (with optional digit separators)
        binary: /\b0[bB][01']+\b/,
        // Decimal: 123, 1'000'000 (with optional digit separators)
        decimal: /\b\d[\d']*\b/,
    };

    /**
     * Provide hover information for numbers in the document
     */
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        // Prevent re-entry at the same document position (hover provider recursion guard).
        const key = this.hoverKey(document.uri, position);
        if (this.activeHoverCalls.has(key)) {
            return undefined;
        }
        this.activeHoverCalls.add(key);
        try {
            const version = document.version;
            // LSP callbacks at a guarded target may still show local information,
            // but cannot recursively start another language-server lookup.
            const request = this.createRequest(token, !this.activeLspHovers.has(key));
            const hover = await this.provideHoverImpl(document, position, request);
            return !this.requestSnapshotValid(request) || document.version !== version ? undefined : hover;
        } finally {
            this.activeHoverCalls.delete(key);
        }
    }

    private async provideHoverImpl(
        document: vscode.TextDocument,
        position: vscode.Position,
        request: HoverRequest
    ): Promise<vscode.Hover | undefined> {

        if (request.token?.isCancellationRequested) { return undefined; }

        // Check if the feature is enabled
        const config = vscode.workspace.getConfiguration('taskhub.hover');
        const enabled = config.get('numberBase.enabled', true);
        if (!enabled) {
            return undefined;
        }

        // Get the current line
        const line = document.lineAt(position.line);
        const lineText = line.text;
        const charPosition = position.character;

        // Guard against extremely long lines (minified sources, generated code).
        // Regex matching on 50k+ char lines causes visible hover stalls.
        if (NumberBaseHoverProvider.isLineTooLongForHover(lineText)) {
            return undefined;
        }

        // M12: 숫자 리터럴 검사(정규식 한 줄, 비용 ~0)를 최우선으로. 숫자
        // 위에서는 식별자 기반 경로(비트필드 LSP 왕복 최대 3초, 매크로 테이블
        // 전체 파싱, struct 크기)가 매치될 수 없으므로 전부 건너뛴다.
        const result = this.findNumberAtPosition(lineText, charPosition);
        if (result) {
            // 레지스터 할당(REG = 0x123;)의 디코딩 호버가 일반 진법 변환보다 우선
            const registerHover = await this.tryRegisterValueDecoding(document, position, request);
            if (registerHover) {
                return registerHover;
            }

            // Try bit operation hover (experimental feature)
            const numberBitOperationHover = await this.tryBitOperationHover(document, position, request);
            if (numberBitOperationHover) {
                return numberBitOperationHover;
            }

            // Try to parse the number (exact: 2^53 초과 64-bit 리터럴은 BigInt)
            const parsedNumber = this.parseNumberExact(result.text);
            if (parsedNumber !== null) {
                // Create range for the hover
                const range = new vscode.Range(
                    position.line,
                    result.start,
                    position.line,
                    result.end
                );

                // Generate hover content
                const hoverContent = this.generateHoverContent(parsedNumber, result.text);
                return new vscode.Hover(hoverContent, range);
            }
            // 숫자처럼 보이지만 파싱 불가 — 식별자 경로로 폴백
        }

        // A current declaration needs no LSP. Other numeric candidates start as
        // their documents arrive, sharing the SFR lookup and the same deadline.
        const localBitField = this.localBitFieldHover(document, position);
        if (localBitField) { return localBitField; }
        const macroHover = this.tryMacroExpansion(document, position);
        const identifierResult = macroHover ? Promise.resolve<CandidateResolution<number>>({ candidates: [], incomplete: false })
            : this.resolveIdentifierValue(document, position, request);

        // First, try to detect SFR bit field
        const bitFieldHover = await this.tryBitFieldHover(document, position, request);
        if (bitFieldHover) {
            return bitFieldHover;
        }

        // Try macro expansion
        if (macroHover) {
            return macroHover;
        }

        // Try struct size information (async: may read taskhub_types.json from disk)
        const structSizeHover = await this.waitForRequest(request, () => this.tryStructSizeInfo(document, position, request));
        if (structSizeHover) {
            return structSizeHover;
        }

        // Try bit operation hover (experimental feature)
        const bitOperationHover = await this.tryBitOperationHover(document, position, request);
        if (bitOperationHover) {
            return bitOperationHover;
        }

        // If not a number literal, try to find identifier value
        const identifier = await identifierResult;
        const identifierValue = this.resolvedCandidateValue(identifier);
        if (identifierValue !== null) {
            const wordRange = document.getWordRangeAtPosition(position);
            if (wordRange) {
                const word = document.getText(wordRange);
                const hoverContent = this.generateHoverContent(identifierValue, word);
                if (identifier.candidates.length > 1 || identifier.unverified) {
                    this.appendCandidates(hoverContent, identifier, value => String(value));
                }
                return new vscode.Hover(hoverContent, wordRange);
            }
        }

        if (this.hasValueCandidates(identifier)) {
            return new vscode.Hover(this.unresolvedCandidates(identifier, value => String(value)), document.getWordRangeAtPosition(position));
        }

        return undefined;
    }

    /**
     * Get the numeric value of an identifier (const, enum, etc.) using LSP
     * Returns the numeric value if found, null otherwise
     */
    private async getIdentifierValue(document: vscode.TextDocument, position: vscode.Position, request = this.createRequest()): Promise<number | null> {
        return this.resolvedCandidateValue(await this.resolveIdentifierValue(document, position, request));
    }

    private resolveIdentifierValue(document: vscode.TextDocument, position: vscode.Position, request: HoverRequest): Promise<CandidateResolution<number>> {
        const key = this.hoverKey(document.uri, position);
        const cached = request.identifiers.get(key);
        if (cached) { return cached; }
        const pending = this.collectIdentifierValues(document, position, request)
            .catch((): CandidateResolution<number> => ({ candidates: [], incomplete: false }));
        request.identifiers.set(key, pending);
        return pending;
    }

    private async collectIdentifierValues(document: vscode.TextDocument, position: vscode.Position, request: HoverRequest): Promise<CandidateResolution<number>> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) { return { candidates: [], incomplete: false }; }
        const word = document.getText(wordRange);
        const candidateValues: Promise<HoverCandidate<number> | undefined>[] = [];
        let hasValueEvidence = false;
        const readValue = async (location: vscode.Location, candidateDocument: Promise<vscode.TextDocument | undefined>): Promise<HoverCandidate<number> | undefined> => {
            let value: number | null = null;
            let conflictingHoverValues = false;
            const defDocument = await candidateDocument;
            // A location that could not be read is not evidence of "no value".
            if (!defDocument) { return { location, value: null, unchecked: true }; }
            // Parse the actual source first. A hover can include unrelated numbers
            // from several providers; it must not override a known source value.
            try {
                value = await this.extractValueFromDefinitionContext(defDocument, location.range.start.line, word);
            } catch { /* Fall back to the language server hover below. */ }
            if (value === null) {
                const hovers = await this.requestLspHovers(location.uri, location.range.start, request);
                if (!hovers) {
                    // `extern const int X;` has no value in source, so a missing hover loses nothing.
                    return isValuelessDeclaration(defDocument.lineAt(location.range.start.line).text, word)
                        ? undefined : { location, value: null, unchecked: true };
                }
                const values = new Set<number>();
                for (const hover of hovers) {
                    for (const content of hover.contents) {
                        const text = typeof content === 'string' ? content : content.value;
                        const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        for (const match of text.matchAll(new RegExp(`\\b${escapedWord}\\s*=\\s*(-?(?:0x[0-9a-fA-F]+|0b[01]+|\\d+))\\b`, 'g'))) {
                            const parsed = this.parseNumber(match[1]);
                            if (parsed !== null) { values.add(parsed); }
                        }
                    }
                }
                hasValueEvidence ||= values.size > 0;
                conflictingHoverValues = values.size > 1;
                if (values.size === 1) { value = [...values][0]; }
            }
            // A checked location without a number supplies no competing value.
            // Keep a null only when that location supplied multiple conflicting numbers.
            return value !== null || conflictingHoverValues ? { location, value } : undefined;
        };
        const definitions = await this.definitionCandidates(document, position, request, (location, candidateDocument) => {
            // Every needed fallback starts independently; one empty declaration
            // must not block another location's immediately available hover value.
            candidateValues.push(readValue(location, candidateDocument)
                .catch((): HoverCandidate<number> => ({ location, value: null, unchecked: true })));
        });
        const candidates = (await Promise.all(candidateValues)).filter((candidate): candidate is HoverCandidate<number> => candidate !== undefined)
            .sort((a, b) => this.hoverKey(a.location.uri, a.location.range.start).localeCompare(this.hoverKey(b.location.uri, b.location.range.start)));
        if (!this.requestSnapshotValid(request)) { return { candidates: [], incomplete: false }; }
        const unverified = definitions.incomplete || candidates.some(candidate => candidate.unchecked);
        return { candidates, incomplete: definitions.candidateLimitReached, unverified, hasValueEvidence };
    }

    /**
     * Extract value from definition considering surrounding context (for enums)
     */
    private async extractValueFromDefinitionContext(
        document: vscode.TextDocument,
        startLine: number,
        symbolName: string
    ): Promise<number | null> {
        const defLine = document.lineAt(startLine);
        const defText = defLine.text;

        // Try to extract from the definition line itself
        const directValue = this.extractValueFromLine(defText, symbolName);
        if (directValue !== null) {
            return directValue;
        }

        // Check if this is an enum declaration or enum member
        // If it's an enum member, search upward for the enum declaration
        let enumDeclLine = startLine;

        // Search upward for enum declaration, bounded by scope boundaries
        if (!defText.includes('enum')) {
            for (let i = startLine; i >= 0; i--) {
                const line = document.lineAt(i);
                const text = line.text;
                if (text.includes('enum')) {
                    enumDeclLine = i;
                    break;
                }
                // Stop if we hit a closing brace (end of previous scope)
                if (text.trim() === '};' || text.trim() === '}') {
                    break;
                }
            }
        }

        // Try to extract enum value
        if (enumDeclLine !== startLine || defText.includes('enum')) {
            return await this.extractEnumValue(document, enumDeclLine, symbolName);
        }

        return null;
    }

    /**
     * Extract enum value with support for implicit values and identifier references
     * Handles: enum { A, B, C = 5, D, E = C, F = C - 1 }  → A=0, B=1, C=5, D=6, E=5, F=4
     */
    private async extractEnumValue(
        document: vscode.TextDocument,
        startLine: number,
        symbolName: string
    ): Promise<number | null> {
        let currentValue: number | null = 0;
        let inEnumBody = false;
        const resolvedValues = new Map<string, number>();

        for (let i = startLine; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const rawText = line.text;
            const text = this.stripInlineComments(rawText).trim();

            // Start of enum body
            if (!inEnumBody && text.includes('{')) {
                inEnumBody = true;
                continue;
            }

            // End of enum body (support both `};` and bare `}`)
            if (inEnumBody && text.includes('}')) {
                break;
            }

            if (!inEnumBody) {
                continue;
            }

            // Parse enum entries (can be multiple per line or comma-separated)
            const entries = text.split(',').map(e => e.trim()).filter(e => e.length > 0);

            for (const entry of entries) {
                const eqIdx = entry.indexOf('=');
                if (eqIdx > 0) {
                    // Explicit assignment: NAME = EXPR
                    const namePart = entry.substring(0, eqIdx).trim();
                    const exprPart = entry.substring(eqIdx + 1).trim();
                    const nameMatch = namePart.match(/^(\w+)$/);
                    if (nameMatch) {
                        const name = nameMatch[1];
                        const value = this.evaluateEnumExpression(exprPart, resolvedValues);
                        if (value !== null) {
                            resolvedValues.set(name, value);
                        }
                        currentValue = value === null ? null : safeIntegerOrNull(value + 1);
                        if (name === symbolName) {
                            return value;
                        }
                        continue;
                    }
                }

                // Implicit value: NAME
                const nameMatch = entry.match(/^(\w+)/);
                if (nameMatch) {
                    const name = nameMatch[1];
                    if (currentValue !== null) {
                        resolvedValues.set(name, currentValue);
                    }
                    if (name === symbolName) {
                        return currentValue;
                    }
                    currentValue = currentValue === null ? null : safeIntegerOrNull(currentValue + 1);
                }
            }
        }

        return null;
    }

    /**
     * Evaluate the RHS of an enum assignment.
     * Supports numeric literals, identifier references to earlier enum members,
     * and simple binary expressions (A op B) over + - * / | & ^ << >>.
     */
    private evaluateEnumExpression(
        expr: string,
        resolvedValues: Map<string, number>
    ): number | null {
        const trimmed = expr.trim();
        if (trimmed.length === 0) {
            return null;
        }

        // Strip a single enclosing pair of parentheses
        if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
            return this.evaluateEnumExpression(trimmed.slice(1, -1), resolvedValues);
        }

        // Numeric literal (must be the entire token, not a prefix of a larger expression)
        if (/^(0[xX][0-9a-fA-F']+|0[bB][01']+|[0-9a-fA-F][0-9a-fA-F']*[hH]|\d[\d']*)$/.test(trimmed)) {
            const numValue = this.parseNumber(trimmed);
            if (numValue !== null) {
                return numValue;
            }
        }

        // Bare identifier lookup
        if (/^[A-Za-z_]\w*$/.test(trimmed)) {
            const resolved = resolvedValues.get(trimmed);
            return resolved !== undefined ? safeIntegerOrNull(resolved) : null;
        }

        // Simple binary arithmetic: A op B
        const binaryMatch = trimmed.match(/^([\w']+)\s*(<<|>>|[+\-*\/|&^])\s*([\w']+)$/);
        if (binaryMatch) {
            const left = this.evaluateEnumExpression(binaryMatch[1], resolvedValues);
            const right = this.evaluateEnumExpression(binaryMatch[3], resolvedValues);
            if (left !== null && right !== null) {
                switch (binaryMatch[2]) {
                    case '+': return safeIntegerOrNull(left + right);
                    case '-': return safeIntegerOrNull(left - right);
                    case '*': return safeIntegerOrNull(left * right);
                    case '/': return right !== 0 ? Math.trunc(left / right) : null;
                    case '|': return left | right;
                    case '&': return left & right;
                    case '^': return left ^ right;
                    case '<<': return safeIntegerOrNull(shiftLeftNumber(left, right));
                    case '>>': return safeIntegerOrNull(shiftRightNumber(left, right));
                }
            }
        }

        return null;
    }

    /**
     * Strip inline line comments and single-line block comments from a line.
     * Does not handle multi-line block comments.
     */
    private stripInlineComments(text: string): string {
        return text
            .replace(/\/\*.*?\*\//g, '')
            .replace(/\/\/.*$/, '');
    }

    /**
     * Extract numeric value from a single line
     * Supports: const int X = 0xFF; X = 0xFF; #define X 0xFF
     */
    private extractValueFromLine(text: string, symbolName?: string): number | null {
        // If symbolName is provided, match it specifically to avoid returning wrong values
        if (symbolName) {
            // Pattern for const/variable/enum with specific symbol: symbolName = VALUE; or VALUE,
            const escapedName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const specificAssignPattern = new RegExp(`\\b${escapedName}\\s*=\\s*([0-9a-fA-FxXbB']+)\\s*[;,]`);
            const specificMatch = text.match(specificAssignPattern);
            if (specificMatch) {
                return this.parseNumber(specificMatch[1]);
            }

            // Pattern for #define with specific symbol: #define symbolName VALUE
            const specificDefinePattern = new RegExp(`#define\\s+${escapedName}\\s+([0-9a-fA-FxXbB']+)`);
            const specificDefineMatch = text.match(specificDefinePattern);
            if (specificDefineMatch) {
                return this.parseNumber(specificDefineMatch[1]);
            }

            return null;
        }

        // Fallback: Pattern for const/variable/enum: NAME = VALUE; or NAME = VALUE,
        const assignPattern = /=\s*([0-9a-fA-FxXbB']+)\s*[;,]/;
        const assignMatch = text.match(assignPattern);
        if (assignMatch) {
            return this.parseNumber(assignMatch[1]);
        }

        // Pattern for #define: #define NAME VALUE
        const definePattern = /#define\s+\w+\s+([0-9a-fA-FxXbB']+)/;
        const defineMatch = text.match(definePattern);
        if (defineMatch) {
            return this.parseNumber(defineMatch[1]);
        }

        return null;
    }

    /**
     * Find a number literal at the given position in the text
     * Returns the text and its start/end positions, or null if not found
     */
    private findNumberAtPosition(text: string, position: number): { text: string; start: number; end: number } | null {
        // Define all number patterns with global flag to find all matches.
        // \b/(?!\w) 경계가 없으면 식별자 일부(`Foo123h`의 `123h`)나 잘못된
        // 리터럴의 앞부분(`0x12g3`의 `0x12`)에 부분 매치된다(M8).
        const numberPatterns = [
            // Hexadecimal with 0x prefix (must come before decimal)
            { regex: /\b0[xX][0-9a-fA-F']+(?!\w)/g, priority: 1 },
            // Binary with 0b prefix (must come before decimal)
            { regex: /\b0[bB][01']+(?!\w)/g, priority: 1 },
            // Hexadecimal with h suffix
            { regex: /\b[0-9a-fA-F][0-9a-fA-F']*[hH]\b/g, priority: 2 },
            // Decimal numbers (lowest priority to avoid matching parts of hex)
            { regex: /\b\d[\d']*/g, priority: 3 },
        ];

        // Find all matches and check if position is within any of them
        const matches: Array<{ text: string; start: number; end: number; priority: number }> = [];

        for (const { regex, priority } of numberPatterns) {
            let match;
            while ((match = regex.exec(text)) !== null) {
                const start = match.index;
                const end = start + match[0].length;

                // Check if the position is within this match
                if (position >= start && position < end) {
                    matches.push({
                        text: match[0],
                        start,
                        end,
                        priority
                    });
                }
            }
        }

        // Return the match with highest priority (lowest priority number)
        if (matches.length > 0) {
            matches.sort((a, b) => a.priority - b.priority);
            return matches[0];
        }

        return null;
    }

    /**
     * Parse a number from various formats and return its decimal value
     * Returns null if the input is not a valid number
     */
    private parseNumber(text: string): number | null {
        // Remove digit separators (')
        const cleanText = text.replace(/'/g, '');

        // Check for hexadecimal (0x prefix)
        if (this.patterns.hex0x.test(text)) {
            const value = parseInt(cleanText, 16);
            return safeIntegerOrNull(value);
        }

        // Check for hexadecimal (h suffix)
        if (this.patterns.hexH.test(text)) {
            const hexPart = cleanText.slice(0, -1); // Remove 'h' or 'H'
            const value = parseInt(hexPart, 16);
            return safeIntegerOrNull(value);
        }

        // Check for binary (0b prefix)
        if (this.patterns.binary.test(text)) {
            const binaryPart = cleanText.replace(/^0[bB]/, ''); // Remove 0b or 0B prefix
            const value = parseInt(binaryPart, 2);
            return safeIntegerOrNull(value);
        }

        // Check for decimal
        if (this.patterns.decimal.test(text)) {
            const value = parseInt(cleanText, 10);
            return safeIntegerOrNull(value);
        }

        return null;
    }

    /**
     * Parse a number literal preserving exactness (M6). `parseNumber`는
     * parseInt 기반이라 2^53 초과 64-bit 리터럴(`0xFFFFFFFFFFFFFFFF` 등)의
     * 진법 변환값이 틀리게 표시됐다. MAX_SAFE_INTEGER 이하는 기존과 동일하게
     * number를, 초과는 BigInt를 반환한다.
     */
    private parseNumberExact(text: string): number | bigint | null {
        const cleanText = text.replace(/'/g, ''); // C++14 digit separators
        let big: bigint;
        try {
            if (this.patterns.hex0x.test(text) || this.patterns.binary.test(text)) {
                big = BigInt(cleanText); // BigInt()는 0x/0X/0b/0B 접두사를 그대로 지원
            } else if (this.patterns.hexH.test(text)) {
                big = BigInt('0x' + cleanText.slice(0, -1)); // h/H 접미사 제거
            } else if (this.patterns.decimal.test(text)) {
                big = BigInt(cleanText);
            } else {
                return null;
            }
        } catch {
            return null;
        }
        return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    }

    /**
     * Generate Markdown formatted hover content showing the number in different bases
     */
    private generateHoverContent(value: number | bigint, original: string): vscode.MarkdownString {
        const md = createCopyableHoverMarkdown();

        // Show conversions — toString(radix)는 number/bigint 모두에서 정확 (M6)
        appendNumberConversions(md, value);

        // Add bit position display for valid positive integers.
        // number는 MAX_SAFE_INTEGER(2^53-1)까지, bigint는 64-bit까지 표시.
        const inBitRange = typeof value === 'bigint'
            ? value >= 0n && value <= 0xFFFFFFFFFFFFFFFFn
            : Number.isSafeInteger(value) && value >= 0;
        if (inBitRange) {
            md.appendMarkdown(this.generateBitPositionDisplay(value));
        }

        return md;
    }

    /**
     * Generate a bit position display showing which bits are set
     * - 32-bit values: displayed as one row
     * - 64-bit values: displayed as two 32-bit rows
     */
    private generateBitPositionDisplay(value: number | bigint): string {
        // Determine if this is a 64-bit value (BigInt/number 혼합 비교는 안전)
        const is64Bit = value > 0xFFFFFFFF;
        const bitWidth = is64Bit ? 64 : 32;
        const binary = value.toString(2).padStart(bitWidth, '0');
        const setBits: number[] = [];

        // Find all set bits
        for (let i = 0; i < bitWidth; i++) {
            if (binary[bitWidth - 1 - i] === '1') {
                setBits.push(i);
            }
        }

        let result = `---\n\n**Bit Information (${bitWidth}-bit)**\n\n`;

        if (is64Bit) {
            // 64-bit: Display as two 32-bit rows using tables
            for (let row = 0; row < 2; row++) {
                const startBit = (1 - row) * 32 + 31;  // First row: bits 63-32, Second row: bits 31-0
                const endBit = (1 - row) * 32;
                const rowBits = binary.substring(row * 32, (row + 1) * 32);

                // Create bit position labels (every 4th bit - showing LSB of each group)
                const labels = [];
                const bitGroups = [];
                for (let i = 0; i < 8; i++) {  // 8 groups of 4 bits
                    const bitPos = startBit - (i * 4) - 3;  // LSB of each 4-bit group
                    labels.push(bitPos.toString());
                    bitGroups.push(rowBits.substring(i * 4, i * 4 + 4));
                }

                result += `|${labels.join('|')}|\n`;
                result += `|${labels.map(() => '---:').join('|')}|\n`;
                result += `|${bitGroups.join('|')}|\n`;
                if (row < 1) {
                    result += '\n';
                }
            }
        } else {
            // 32-bit: Display as one row using table
            const labels = [];
            const bitGroups = [];
            for (let i = 0; i < 8; i++) {  // 8 groups of 4 bits
                const bitPos = 31 - (i * 4) - 3;  // LSB of each 4-bit group (28, 24, 20, 16, 12, 8, 4, 0)
                labels.push(bitPos.toString());
                bitGroups.push(binary.substring(i * 4, i * 4 + 4));
            }

            result += `|${labels.join('|')}|\n`;
            result += `|${labels.map(() => '---:').join('|')}|\n`;
            result += `|${bitGroups.join('|')}|\n`;
        }

        result += '\n';

        // List set bits
        if (setBits.length > 0) {
            result += `**Set bits:** ${setBits.join(', ')}\n`;
        } else {
            result += `**Set bits:** none (value is 0)\n`;
        }

        return result;
    }

    /**
     * Try to expand and show macro information
     * Returns hover if current position is on a macro definition
     */
    private tryMacroExpansion(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        // Get word at position
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);

        // Check if word looks like a macro (uppercase or starts with uppercase)
        if (!/^[A-Z_][A-Z0-9_]*$/.test(word)) {
            return null; // Not a typical macro name pattern
        }

        // Parse all macros from document (M12: document.version 키 캐시)
        const macros = this.getMacroTable(document);

        // Check if this word is a defined macro
        if (!macros.has(word)) {
            return null; // Not a macro
        }

        // Expand the macro
        const expander = new MacroExpander();
        const result = expander.expandMacro(word, macros);

        if (!result.success) {
            return null; // Expansion failed
        }

        // Try to evaluate to a number
        const numericValue = MacroExpander.evaluateToSafeInteger(result.expandedValue);

        // Only show hover if:
        // 1. It expands to other macros (more than 1 step), OR
        // 2. It evaluates to a numeric value
        const hasExpansion = result.expansionSteps.length > 1;
        const hasNumericValue = numericValue !== null || MacroExpander.evaluateToNumber(result.expandedValue) !== null;

        if (!hasExpansion && !hasNumericValue) {
            return null; // Not useful to show
        }

        // Numeric macro - show expansion and conversions
        return new vscode.Hover(
            this.generateMacroExpansionContent(word, result, numericValue),
            wordRange
        );
    }

    /**
     * Generate hover content for macro expansion
     */
    private generateMacroExpansionContent(
        macroName: string,
        expansionResult: any,
        numericValue: number | null
    ): vscode.MarkdownString {
        const md = createCopyableHoverMarkdown();

        md.appendMarkdown(`### Macro: ${escapeHoverText(macroName)}\n\n`);

        // Show conversions directly without expansion steps
        if (numericValue !== null) {
            appendNumberConversions(md, numericValue);

            // Add bit position display for reasonable values
            if (Number.isSafeInteger(numericValue) && numericValue >= 0) {
                md.appendMarkdown(this.generateBitPositionDisplay(numericValue));
            }
        } else if (MacroExpander.evaluateToNumber(expansionResult.expandedValue ?? '') !== null) {
            appendNumberConversions(md, NaN);
        }

        return md;
    }

    private localBitFieldHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) { return null; }
        const word = document.getText(wordRange);
        const localInfo = extractBitFieldInfo(document.lineAt(position.line).text,
            position.line > 0 ? document.lineAt(position.line - 1).text : undefined);
        if (localInfo?.commentInfo && localInfo.fieldName === word) {
            const location = new vscode.Location(document.uri, wordRange);
            return new vscode.Hover(this.generateBitFieldHoverContent(localInfo,
                extractHierarchy(this.getDocumentLines(document), position.line),
                this.candidatePath(location).replace(/:\d+$/, ''), position.line + 1), wordRange);
        }
        return null;
    }

    /**
     * Try to provide hover information for SFR bit field
     * Returns hover if current position is on a bit field declaration or usage
     */
    private async tryBitFieldHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        request = this.createRequest()
    ): Promise<vscode.Hover | null> {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) { return null; }
        const word = document.getText(wordRange);
        if (!/^[A-Za-z_]\w*$/.test(word)) { return null; }
        const local = this.localBitFieldHover(document, position);
        if (local) { return local; }

        const definitions = await this.definitionCandidates(document, position, request);
        const candidates: HoverCandidate<CompleteBitFieldInfo>[] = [];
        const documents = new Map<string, vscode.TextDocument>();
        for (const location of definitions.locations) {
            const target = await this.openCandidate(location, request);
            const line = location.range.start.line;
            const info = target ? extractBitFieldInfo(target.lineAt(line).text,
                line > 0 ? target.lineAt(line - 1).text : undefined) : null;
            const value = info?.commentInfo && info.fieldName === word ? info : null;
            if (target) { documents.set(location.uri.toString(), target); }
            candidates.push({ location, value });
        }
        // An ordinary symbol must still reach the macro/enum hover paths.
        if (!candidates.some(candidate => candidate.value !== null)) { return null; }
        const resolution = { candidates, incomplete: definitions.incomplete || !this.requestActive(request) };
        const describe = (info: CompleteBitFieldInfo): string =>
            `${info.fieldName} [${info.commentInfo!.bitPosition}] [${info.commentInfo!.accessType}] ${info.commentInfo!.resetValue} — ${info.commentInfo!.description}`;
        const info = this.resolvedCandidateValue(resolution);
        if (!info) { return new vscode.Hover(this.unresolvedCandidates(resolution, describe), wordRange); }
        const location = candidates[0].location;
        const target = documents.get(location.uri.toString())!;
        const content = this.generateBitFieldHoverContent(info,
            extractHierarchy(this.getDocumentLines(target), location.range.start.line),
            this.candidatePath(location).replace(/:\d+$/, ''), location.range.start.line + 1);
        if (candidates.length > 1) { this.appendCandidates(content, resolution, describe); }
        return new vscode.Hover(content, wordRange);
    }

    /** Only aggregate headers with a body are local definitions, not type uses. */
    private *registerDefinitionHeaders(document: vscode.TextDocument, typeName: string): Generator<{ line: number; character: number; kind: string }> {
        const uri = document.uri.toString();
        if (this.registerCodeCache?.uri !== uri || this.registerCodeCache.version !== document.version) {
            // Preserve source offsets and line numbers while ignoring comments and literals.
            // A quote inside a numeric token (1'000, 0xAB'CD) is a digit separator.
            const text = document.getText().replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|(?<!\w)(?:u8|[uUL])?'(?:\\[^\r\n]|[^'\\\r\n])*'/g,
                fragment => fragment.replace(/[^\n]/g, ' '));
            this.registerCodeCache = { uri, version: document.version, text };
        }
        const text = this.registerCodeCache.text;
        const escapedType = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const modifiers = '(?:(?:final\\b|\\[\\[[^;{}]*?\\]\\]|__attribute__\\s*\\(\\([^;{}]*?\\)\\)|__declspec\\s*\\([^;{}]*?\\))\\s*)*';
        const pattern = new RegExp(`\\b(struct|union|class)\\s+${escapedType}\\b\\s*${modifiers}(?::[^;{}()=]*)?\\{`, 'g');
        let line = 0;
        let lineStart = 0;
        for (const match of text.matchAll(pattern)) {
            let newline = text.indexOf('\n', lineStart);
            while (newline !== -1 && newline < match.index!) {
                line++;
                lineStart = newline + 1;
                newline = text.indexOf('\n', lineStart);
            }
            yield { line, character: match.index! - lineStart, kind: match[1] };
        }
    }

    private parseRegisterCandidate(document: vscode.TextDocument, location: vscode.Location, typeName: string): RegisterDefinition | null {
        const lines = this.getDocumentLines(document);
        const line = location.range.start.line;
        let kind: string | undefined;
        for (const header of this.registerDefinitionHeaders(document, typeName)) {
            if (header.line === line) { kind = header.kind; break; }
            if (header.line > line) { break; }
        }
        if (!kind) { return null; }
        const definition = kind === 'struct'
            ? RegisterDecoder.parseRegisterFromStruct(lines, line, typeName)
            : RegisterDecoder.parseRegisterFromUnion(lines, line, typeName);
        if (!definition?.fields.length) { return null; }
        definition.fields.sort((a, b) => a.bitStart - b.bitStart || a.name.localeCompare(b.name));
        return definition;
    }

    private localRegisterCandidates(document: vscode.TextDocument, typeName: string, request: HoverRequest): CandidateResolution<RegisterDefinition> {
        const candidates: HoverCandidate<RegisterDefinition>[] = [];
        let incomplete = false;
        for (const header of this.registerDefinitionHeaders(document, typeName)) {
            if (candidates.length >= request.maxCandidates) { incomplete = true; break; }
            const location = new vscode.Location(document.uri, new vscode.Position(header.line, header.character));
            candidates.push({ location, value: this.parseRegisterCandidate(document, location, typeName) });
        }
        return { candidates, incomplete };
    }

    private async registerTypeCandidates(document: vscode.TextDocument, position: vscode.Position, typeName: string, request: HoverRequest): Promise<CandidateResolution<RegisterDefinition>> {
        const definitions = await this.definitionCandidates(document, position, request);
        if (definitions.locations.length === 0 && !definitions.incomplete) {
            return this.localRegisterCandidates(document, typeName, request);
        }
        const candidates: HoverCandidate<RegisterDefinition>[] = [];
        for (const location of definitions.locations) {
            const target = await this.openCandidate(location, request);
            candidates.push({ location, value: target ? this.parseRegisterCandidate(target, location, typeName) : null });
        }
        return { candidates, incomplete: definitions.incomplete || !this.requestActive(request) };
    }

    private async tryRegisterValueDecoding(
        document: vscode.TextDocument,
        position: vscode.Position,
        request = this.createRequest()
    ): Promise<vscode.Hover | null> {
        const lineText = document.lineAt(position.line).text;
        const numberMatch = this.findNumberAtPosition(lineText, position.character);
        if (!numberMatch) { return null; }
        const value = this.parseNumber(numberMatch.text);
        if (value === null || !Number.isSafeInteger(value)) { return null; }
        const beforeValue = lineText.substring(0, numberMatch.start);
        const assignMatch = beforeValue.match(/([\w.]+)\s*=\s*$/);
        if (!assignMatch) { return null; }
        const fullExpression = assignMatch[1];
        const isScalarType = (name: string): boolean => /^(?:bool|char|short|int|long|signed|unsigned|float|double|u?int(?:8|16|32|64)_t)$/.test(name);
        const range = new vscode.Range(position.line, numberMatch.start, position.line, numberMatch.end);
        const describe = (definition: RegisterDefinition): string => `${definition.name}: ${definition.fields.map(field =>
            `${field.name}[${field.bitEnd}:${field.bitStart}]${field.accessType ? ` ${field.accessType}` : ''}`).join(', ')}`;
        const show = (resolution: CandidateResolution<RegisterDefinition>): vscode.Hover | null => {
            // Unknown types include ordinary typedef scalars. A lookup failure alone
            // does not establish that the assignment has a register layout to decode.
            if (!this.hasValueCandidates(resolution)) { return null; }
            const definition = this.resolvedCandidateValue(resolution);
            if (!definition) {
                // Literal conversion remains useful even when the register layout is ambiguous.
                const content = this.generateHoverContent(value, numberMatch.text);
                content.appendMarkdown('\n\n');
                content.appendMarkdown(this.unresolvedCandidates(resolution, describe).value);
                return new vscode.Hover(content, range);
            }
            const decoded = new RegisterDecoder().decodeValue(value, definition);
            if (!decoded.success) { return null; }
            const content = this.generateRegisterDecodingContent(decoded);
            if (resolution.candidates.length > 1) { this.appendCandidates(content, resolution, describe); }
            return new vscode.Hover(content, range);
        };

        const explicitType = lineText.match(/(\w+)\s+([\w.]+)\s*=/);
        if (explicitType && explicitType[2] === fullExpression) {
            if (isScalarType(explicitType[1])) { return null; }
            const local = this.localRegisterCandidates(document, explicitType[1], request);
            if (local.candidates.length > 0) { return show(local); }
            return show(await this.registerTypeCandidates(document,
                new vscode.Position(position.line, explicitType.index!), explicitType[1], request));
        }

        const variablePosition = new vscode.Position(position.line, beforeValue.lastIndexOf(fullExpression));
        const variables = await this.definitionCandidates(document, variablePosition, request);
        const resolution: CandidateResolution<RegisterDefinition> = { candidates: [], incomplete: variables.incomplete };
        let allScalar = variables.locations.length > 0;
        for (const variable of variables.locations) {
            if (resolution.candidates.length >= request.maxCandidates) {
                resolution.incomplete = true;
                break;
            }
            const variableDocument = await this.openCandidate(variable, request);
            const text = variableDocument?.lineAt(variable.range.start.line).text;
            const type = text?.match(/\b(?:(?:const|volatile|static|extern|struct|union|class)\s+)*([A-Za-z_]\w*(?:<[^>]+>)?)\s+(?:[*&]\s*)*\w+/);
            if (!variableDocument || !type) {
                allScalar = false;
                resolution.candidates.push({ location: variable, value: null });
                continue;
            }
            const typeName = type[1].replace(/<.*>/, '');
            if (isScalarType(typeName)) {
                resolution.candidates.push({ location: variable, value: null });
                continue;
            }
            allScalar = false;
            const typePosition = new vscode.Position(variable.range.start.line, text!.indexOf(type[1], type.index));
            const types = await this.registerTypeCandidates(variableDocument, typePosition, typeName, request);
            resolution.incomplete ||= types.incomplete;
            if (types.candidates.length === 0) { resolution.candidates.push({ location: variable, value: null }); }
            for (const candidate of types.candidates) {
                if (resolution.candidates.length >= request.maxCandidates) { resolution.incomplete = true; break; }
                if (!resolution.candidates.some(existing => this.hoverKey(existing.location.uri, existing.location.range.start)
                    === this.hoverKey(candidate.location.uri, candidate.location.range.start))) {
                    resolution.candidates.push(candidate);
                }
            }
        }
        if (allScalar && !resolution.incomplete) { return null; }
        if (variables.locations.length === 0 && !variables.incomplete) {
            // Keep the existing member-expression fallback, but inspect every reported type.
            const hovers = await this.requestLspHovers(document.uri,
                new vscode.Position(position.line, variablePosition.character + fullExpression.length - 1), request);
            const typeNames = new Set<string>();
            for (const hover of hovers ?? []) {
                for (const content of hover.contents) {
                    const text = typeof content === 'string' ? content : content.value;
                    const type = text.match(/\b(?:struct|union|class)\s+(\w+)/)
                        ?? text.match(/(\w+)::\w+<[^>]+>::\w+/);
                    if (type) { typeNames.add(type[1]); }
                }
            }
            for (const typeName of typeNames) {
                if (resolution.candidates.length >= request.maxCandidates || !this.requestActive(request)) {
                    resolution.incomplete = true;
                    break;
                }
                const local = this.localRegisterCandidates(document, typeName, request);
                const remaining = request.maxCandidates - resolution.candidates.length;
                resolution.candidates.push(...local.candidates.slice(0, remaining));
                resolution.incomplete ||= local.incomplete || local.candidates.length > remaining;
            }
        }
        resolution.incomplete ||= !this.requestActive(request);
        return show(resolution);
    }

    /**
     * Generate hover content for register value decoding
     */
    private generateRegisterDecodingContent(result: RegisterDecodingResult): vscode.MarkdownString {
        const md = createCopyableHoverMarkdown();

        md.appendMarkdown(`### Register: ${escapeHoverText(result.registerName)}\n\n`);
        if (!appendNumberConversions(md, result.registerValue)) {
            return md;
        }

        // Decoded fields table
        md.appendMarkdown('---\n\n');
        md.appendMarkdown('**Decoded Bit Fields:**\n\n');
        md.appendMarkdown('| Bit | Field | Value | Hex | Bin | Description |\n');
        md.appendMarkdown('|-----|-------|-------|-----|-----|-------------|\n');

        for (const field of result.fields) {
            const desc = escapeHoverText(field.description || '-');
            const accessType = field.accessType ? escapeHoverText(`[${field.accessType}]`) : '';
            md.appendMarkdown(`| ${escapeHoverText(field.bitPosition)} | **${escapeHoverText(field.name)}** | ${formatCopyableHoverValue(field.decimal)} | ${formatCopyableHoverValue(field.hex)} | ${formatCopyableHoverValue(field.binary)} | ${desc} ${accessType} |\n`);
        }

        return md;
    }

    /**
     * Try to show struct size information when hovering over struct/class name.
     *
     * Async because `loadTypeConfig` now uses `fs.promises` to avoid blocking
     * the extension host on slow/remote storage.
     */
    private async tryStructSizeInfo(
        document: vscode.TextDocument,
        position: vscode.Position,
        request = this.createRequest()
    ): Promise<vscode.Hover | null> {
        const line = document.lineAt(position.line);
        const lineText = line.text;

        // Check if we're on a struct/class keyword or name
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);

        // Check if line contains struct/class declaration
        const structPattern = /\b(struct|class)\s+(?:alignas\s*\([^()]*\)\s*)?(\w+)/;
        const match = lineText.match(structPattern);

        let structName: string | null = null;

        if (match) {
            // Check if we're hovering over the keyword or the name
            if (word === 'struct' || word === 'class' || word === match[2]) {
                structName = match[2];
            }
        } else {
            // Check if we're hovering over a type name (could be struct name)
            // This is a guess - only show if it looks like a custom type (starts with uppercase)
            if (/^[A-Z]\w*$/.test(word)) {
                structName = word;
            } else {
                return null;
            }
        }

        if (!structName) {
            return null;
        }

        // Parse the document (read-only shared cache)
        const documentLines = this.getDocumentLines(document);

        // Find struct definition
        const structLine = StructSizeCalculator.findStructDefinition(documentLines, structName);
        if (structLine === -1) {
            return null;
        }

        const sourceVersion = document.version;

        // Calculate struct size
        // Load custom type configuration if available (async fs I/O under the hood)
        const typeConfig = await this.loadTypeConfig(document);
        if (document.version !== sourceVersion || !this.requestActive(request)) { return null; }
        const calculator = new StructSizeCalculator(typeConfig);

        // Register all struct/class definitions in the document
        this.registerAllCustomTypes(calculator, documentLines);

        const result = calculator.calculateStructSize(structName, documentLines, structLine);

        if (!result.success) {
            const explanation = new vscode.MarkdownString();
            explanation.appendText(t(
                `구조체 ${structName}의 크기를 계산할 수 없습니다. 상속·가상 멤버 등 지원되지 않는 선언 또는 해석되지 않은 타입이 있습니다. 대상 컴파일러의 sizeof로 확인하고, 사용자 타입은 .vscode/taskhub_types.json에 정의하세요.`,
                `Cannot calculate the size of ${structName}: unsupported declarations (such as inheritance or virtual members) or unresolved types. Check sizeof with the target compiler and define custom types in .vscode/taskhub_types.json.`
            ));
            return new vscode.Hover(explanation, wordRange);
        }

        return new vscode.Hover(
            this.generateStructSizeContent(result),
            wordRange
        );
    }

    /**
     * Generate hover content for struct size information
     */
    private generateStructSizeContent(result: StructSizeResult): vscode.MarkdownString {
        const md = new vscode.MarkdownString();

        md.appendMarkdown(`### Struct: ${result.structName}\n\n`);
        md.appendMarkdown(`**${t('추정 크기', 'Estimated Size')}:** ${result.totalSize} bytes\n\n`);
        md.appendMarkdown(`**Alignment:** ${result.alignment} bytes\n\n`);
        md.appendMarkdown(`**Padding:** ${result.padding} bytes\n\n`);

        // Members table
        md.appendMarkdown('---\n\n');
        md.appendMarkdown('**Members:**\n\n');
        md.appendMarkdown('| Offset | Name | Type | Size | Alignment |\n');
        md.appendMarkdown('|--------|------|------|------|-----------|');
        md.appendMarkdown('\n');

        for (const member of result.members) {
            const typeDisplay = member.isArray
                ? `${member.type}[${member.arraySize}]`
                : member.type;
            md.appendMarkdown(`| ${member.offset} | **${member.name}** | ${typeDisplay} | ${member.size} | ${member.alignment} |\n`);
        }

        md.appendMarkdown('\n');
        md.appendMarkdown(t(
            '*설정된 타입 크기와 packing 기준의 추정값입니다. #include와 조건부 전처리는 수행하지 않습니다. 실제 ABI·비트 필드 배치는 대상 컴파일러의 sizeof로 확인하세요. `.vscode/taskhub_types.json`에서 크기와 정렬을 설정할 수 있습니다.*\n',
            '*Estimate based on configured type sizes and packing. #include and conditional preprocessing are not performed. Verify the target ABI and bit-field layout with compiler sizeof. Customize sizes and alignment in `.vscode/taskhub_types.json`.*\n'
        ));

        return md;
    }

    /**
     * Register all struct/class definitions in the document as custom types
     * This enables correct size calculation for nested custom types
     */
    private registerAllCustomTypes(calculator: StructSizeCalculator, lines: string[]): void {
        // Find all struct/class definitions
        const structPattern = /\b(struct|class)\s+(?:alignas\s*\([^()]*\)\s*)?(\w+)/g;
        const definitions: Array<{ name: string; line: number }> = [];
        const seenNames = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const matches = lines[i].matchAll(structPattern);
            for (const match of matches) {
                const name = match[2];
                // Skip if already seen (avoid duplicates)
                if (seenNames.has(name)) {
                    continue;
                }
                // Skip forward declarations (no opening brace on same or next line)
                const hasBody = lines[i].includes('{') ||
                    (i + 1 < lines.length && lines[i + 1].includes('{'));
                if (hasBody) {
                    definitions.push({ name, line: i });
                    seenNames.add(name);
                }
            }
        }

        // Sort by line number to handle dependencies (earlier definitions first)
        definitions.sort((a, b) => a.line - b.line);

        // Register each custom type with multiple passes to resolve dependencies
        // This handles cases where type B uses type A, but A is defined after B
        const maxPasses = 3;
        const registered = new Set<string>();

        for (let pass = 0; pass < maxPasses; pass++) {
            let newRegistrations = 0;

            for (const def of definitions) {
                if (registered.has(def.name)) {
                    continue;
                }

                const result = calculator.calculateStructSize(def.name, lines, def.line);
                if (result.success) {
                    calculator.registerCustomType(result);
                    registered.add(def.name);
                    newRegistrations++;
                }
            }

            // If no new registrations in this pass, we're done
            if (newRegistrations === 0) {
                break;
            }
        }
    }

    /**
     * Load type configuration from .vscode/taskhub_types.json if it exists.
     *
     * Uses `fs.promises` to avoid blocking the extension host on slow or remote
     * filesystems (network drives, FUSE mounts). All calls are still bounded by
     * `withLspTimeout`/hover cancellation upstream.
     *
     * @param document The current document to determine workspace
     * @returns TypeConfigFile or undefined if not found
     */
    private async loadTypeConfig(document: vscode.TextDocument): Promise<TypeConfigFile | undefined> {
        const workspaceFolder = this.workspaceFolderForUri(document.uri);
        if (!workspaceFolder) {
            return undefined;
        }

        const rawPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'taskhub_types.json').fsPath;
        // Normalize path (resolve symlinks) to avoid caching duplicates for the same real file.
        let configFilePath: string;
        try {
            configFilePath = await fs.promises.realpath(rawPath);
        } catch {
            configFilePath = rawPath;
        }

        const existing = this.typeConfigCache.get(configFilePath);

        try {
            const stat = await fs.promises.stat(configFilePath);
            const mtime = stat.mtimeMs;
            if (existing && existing.mtime === mtime) {
                this.typeConfigCache.delete(configFilePath);
                this.typeConfigCache.set(configFilePath, existing);
                return existing.config;
            }

            const configContent = await fs.promises.readFile(configFilePath, 'utf8');
            const config = StructSizeCalculator.loadTypeConfig(JSON.parse(configContent));
            this.setCache(configFilePath, { mtime, config });
            return config;
        } catch {
            // Missing files are remembered for LRU bookkeeping, but the next hover
            // deliberately pays one async stat until the file exists. Otherwise
            // creating taskhub_types.json after the first hover would have no effect
            // until the extension host restarted; a watcher would cost more lifecycle
            // state than this user-driven lookup warrants.
            // Prefer the last-known-good config when parse fails transiently.
            if (existing && existing.config) {
                return existing.config;
            }
            this.setCache(configFilePath, { mtime: -1, config: undefined });
            return undefined;
        }
    }

    private setCache(key: string, entry: TypeConfigCacheEntry): void {
        if (this.typeConfigCache.has(key)) {
            this.typeConfigCache.delete(key);
        }
        this.typeConfigCache.set(key, entry);
        while (this.typeConfigCache.size > TYPE_CONFIG_CACHE_MAX) {
            const oldest = this.typeConfigCache.keys().next().value;
            if (oldest === undefined) { break; }
            this.typeConfigCache.delete(oldest);
        }
    }

    /**
     * Try to provide hover for bit operations (experimental feature)
     */
    private async tryBitOperationHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        request = this.createRequest()
    ): Promise<vscode.Hover | null> {
        // Check if bit operation hover feature is enabled
        const bitOpEnabled = vscode.workspace.getConfiguration('taskhub.experimental').get('bitOperationHover.enabled', false);
        if (!bitOpEnabled) {
            return null;
        }

        const line = document.lineAt(position.line);
        const lineText = line.text;
        const charPosition = position.character;

        // Detect bit operation at cursor position
        const operation = detectBitOperation(lineText, charPosition);
        if (!operation) {
            return null;
        }

        // Try to get the current value of the variable (skip for constant expressions)
        let beforeValue: number | undefined = undefined;
        let identifier: CandidateResolution<number> | undefined;

        // For constant expressions, we don't need to look up the variable value
        if (!operation.isConstant && operation.variable) {
            // Try to find the variable definition and get its value
            try {
                const wordRange = new vscode.Range(
                    position.line,
                    lineText.indexOf(operation.variable),
                    position.line,
                    lineText.indexOf(operation.variable) + operation.variable.length
                );

                const variablePosition = new vscode.Position(position.line, lineText.indexOf(operation.variable));
                identifier = await this.resolveIdentifierValue(document, variablePosition, request);
                const value = this.resolvedCandidateValue(identifier);
                if (value !== null) {
                    beforeValue = value;
                }
            } catch (error) {
                // If we can't get the value, continue without it
            }
        }

        // Calculate the bit operation result
        const result = calculateBitOperation(operation, beforeValue);

        // Format the result as markdown
        const markdown = formatBitOperationResult(result);
        if (identifier && this.hasValueCandidates(identifier)) {
            if (this.resolvedCandidateValue(identifier) === null) {
                markdown.appendMarkdown('\n\n' + this.unresolvedCandidates(identifier, value => String(value)).value);
            } else if (identifier.candidates.length > 1 || identifier.unverified) {
                this.appendCandidates(markdown, identifier, value => String(value));
            }
        }

        // Create range for the hover
        const range = new vscode.Range(
            position.line,
            operation.start,
            position.line,
            operation.end
        );

        return new vscode.Hover(markdown, range);
    }

    /**
     * Generate hover content for SFR bit field
     */
    private generateBitFieldHoverContent(
        bitFieldInfo: CompleteBitFieldInfo,
        scopes: any[],
        filePath: string,
        lineNumber: number
    ): vscode.MarkdownString {
        const md = createCopyableHoverMarkdown();

        const comment = bitFieldInfo.commentInfo!;
        const hierarchyName = formatHierarchy(scopes, bitFieldInfo.fieldName);

        // Title with hierarchy
        md.appendMarkdown(`### ${escapeHoverText(hierarchyName)}\n\n`);

        // Property table (left-aligned)
        md.appendMarkdown('| Property | Value |\n');
        md.appendMarkdown('|---|---|\n');
        md.appendMarkdown(`| **Bit Position** | ${escapeHoverText(comment.bitPosition)} |\n`);

        // Add bit width for multi-bit fields
        if (comment.bitWidth > 1) {
            md.appendMarkdown(`| **Bit Width** | ${comment.bitWidth} bits |\n`);
        }

        md.appendMarkdown(`| **Access Type** | ${escapeHoverText(getAccessTypeDescription(comment.accessType))} |\n`);

        // Reset value with conversions for multi-bit fields
        if (comment.bitWidth > 1 && comment.resetValueNumeric !== null) {
            const hex = '0x' + comment.resetValueNumeric.toString(16).toUpperCase();
            const dec = comment.resetValueNumeric.toString(10);
            const bin = '0b' + comment.resetValueNumeric.toString(2);
            md.appendMarkdown(`| **Reset Value** | ${escapeHoverText(comment.resetValue)} (Dec: ${dec}, Bin: ${bin}) |\n`);
        } else {
            md.appendMarkdown(`| **Reset Value** | ${escapeHoverText(comment.resetValue)} |\n`);
        }

        // Bit mask (32-bit) - shows the value when all bits in this field are set to 1
        const bitMask = calculateBitMask(comment.bitStart, comment.bitEnd);
        const bitMaskHex = '0x' + bitMask.toString(16).toUpperCase().padStart(8, '0');
        md.appendMarkdown(`| **Bit Mask** | ${formatCopyableHoverValue(bitMaskHex)} |\n`);

        // File location
        md.appendMarkdown(`| **File** | ${escapeHoverText(`${filePath}:${lineNumber}`)} |\n\n`);

        // Description
        md.appendMarkdown(`**Description:** ${escapeHoverText(comment.description)}\n`);

        return md;
    }
}

// ============================================================================
// Bit Operation Hover Support (Experimental)
// ============================================================================

/**
 * Bit operation types
 */
export enum BitOperationType {
    AND = '&',
    OR = '|',
    XOR = '^',
    NOT = '~',
    LEFT_SHIFT = '<<',
    RIGHT_SHIFT = '>>',
    AND_ASSIGN = '&=',
    OR_ASSIGN = '|=',
    XOR_ASSIGN = '^=',
    LEFT_SHIFT_ASSIGN = '<<=',
    RIGHT_SHIFT_ASSIGN = '>>=',
}

/**
 * Parsed bit operation information
 */
export interface BitOperation {
    /** The variable being operated on (undefined for constant expressions) */
    variable?: string;
    /** The operator */
    operator: BitOperationType;
    /** The operand value */
    operand: number;
    /** Whether this is an assignment operation */
    isAssignment: boolean;
    /** The full expression text */
    expression: string;
    /** Start position of the operation in the line */
    start: number;
    /** End position of the operation in the line */
    end: number;
    /** Whether this is a constant expression (e.g., 1U << 5) */
    isConstant?: boolean;
    /** Left operand for constant expressions */
    leftOperand?: number;
}

/**
 * Bit operation result
 */
export interface BitOperationResult {
    /** Original operation */
    operation: BitOperation;
    /** Value before operation (if known) */
    beforeValue?: number;
    /** Value after operation */
    afterValue: number;
    /** List of changed bit positions */
    changedBits: number[];
    /** Bits that were set (0 → 1) */
    setBits: number[];
    /** Bits that were cleared (1 → 0) */
    clearedBits: number[];
}

function normalizeShiftAmount(operand: number): number {
    return Math.min(63, Math.max(0, Math.trunc(operand) || 0));
}

function shiftLeftNumber(value: number, operand: number): number {
    return Math.floor(value * Math.pow(2, normalizeShiftAmount(operand)));
}

function shiftRightNumber(value: number, operand: number): number {
    return Math.floor(value / Math.pow(2, normalizeShiftAmount(operand)));
}

// Patterns for bit operation detection (module-level to avoid recompilation per hover call)
// Note: Use negative lookbehind to avoid matching part of hex/binary literals or numeric suffixes
const BIT_OPERATION_PATTERNS: Array<{
    regex: RegExp;
    isAssignment: boolean;
    isNot?: boolean;
    isConstant?: boolean;
}> = [
    // Assignment operations: var &= value, var |= value, etc.
    {
        regex: /(?<![0-9a-fA-FxXbBULul])([a-zA-Z_]\w*)\s*(&=|\|=|\^=|<<=|>>=)\s*(0x[0-9a-fA-F]+|0b[01]+|\d+)/g,
        isAssignment: true
    },
    // Non-assignment operations: var & value, var | value, etc.
    {
        regex: /(?<![0-9a-fA-FxXbBULul])([a-zA-Z_]\w*)\s*(&|\||\^|<<|>>)\s*(0x[0-9a-fA-F]+|0b[01]+|\d+)/g,
        isAssignment: false
    },
    // NOT operation: ~var (only match identifiers, not numbers or hex literals or suffixes)
    {
        regex: /~\s*(?<![0-9a-fA-FxXbBULul])([a-zA-Z_]\w*)/g,
        isAssignment: false,
        isNot: true
    },
    // Constant expressions: number & number, number | number, etc.
    // Matches: 1U << 5, 0xFF & 0x0F, (1U << 5), etc.
    {
        regex: /\(?\s*(0x[0-9a-fA-F]+|0b[01]+|\d+)[ULul]*\s*(&|\||\^|<<|>>)\s*(0x[0-9a-fA-F]+|0b[01]+|\d+)[ULul]*\s*\)?/g,
        isAssignment: false,
        isConstant: true
    }
];

/**
 * Detect bit operations in a line of code
 * Supports: &, |, ^, ~, <<, >>, &=, |=, ^=, <<=, >>=
 */
export function detectBitOperation(line: string, cursorPosition: number): BitOperation | undefined {
    for (const pattern of BIT_OPERATION_PATTERNS) {
        pattern.regex.lastIndex = 0; // Reset regex state
        let match: RegExpExecArray | null;

        while ((match = pattern.regex.exec(line)) !== null) {
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;

            // Check if cursor is within this match
            if (cursorPosition >= matchStart && cursorPosition <= matchEnd) {
                if (pattern.isNot) {
                    // NOT operation
                    return {
                        variable: match[1],
                        operator: BitOperationType.NOT,
                        operand: 0, // NOT doesn't have an operand
                        isAssignment: false,
                        expression: match[0],
                        start: matchStart,
                        end: matchEnd
                    };
                } else if (pattern.isConstant) {
                    // Constant expression: number op number
                    const leftStr = match[1].replace(/[ULul]+$/, ''); // Remove suffix
                    const operator = match[2] as BitOperationType;
                    const rightStr = match[3].replace(/[ULul]+$/, ''); // Remove suffix

                    const leftOperand = parseNumberLiteral(leftStr);
                    const operand = parseNumberLiteral(rightStr);

                    if (leftOperand === undefined || operand === undefined) {
                        continue;
                    }

                    return {
                        operator,
                        operand,
                        leftOperand,
                        isAssignment: false,
                        isConstant: true,
                        expression: match[0].trim(),
                        start: matchStart,
                        end: matchEnd
                    };
                } else {
                    // Regular binary operation
                    const variable = match[1];
                    const operator = match[2] as BitOperationType;
                    const operandStr = match[3];
                    const operand = parseNumberLiteral(operandStr);

                    if (operand === undefined) {
                        continue;
                    }

                    return {
                        variable,
                        operator,
                        operand,
                        isAssignment: pattern.isAssignment,
                        expression: match[0],
                        start: matchStart,
                        end: matchEnd
                    };
                }
            }
        }
    }

    return undefined;
}

/**
 * Parse a number literal (hex, binary, or decimal)
 */
function parseNumberLiteral(str: string): number | undefined {
    // Remove digit separators
    str = str.replace(/'/g, '');

    if (str.startsWith('0x') || str.startsWith('0X')) {
        // Hexadecimal
        return parseInt(str.slice(2), 16);
    } else if (str.startsWith('0b') || str.startsWith('0B')) {
        // Binary
        return parseInt(str.slice(2), 2);
    } else if (/^\d+$/.test(str)) {
        // Decimal
        return parseInt(str, 10);
    }

    return undefined;
}

/**
 * Calculate bit operation result
 */
export function calculateBitOperation(
    operation: BitOperation,
    beforeValue?: number
): BitOperationResult {
    let afterValue: number;
    let actualBeforeValue: number;

    // For constant expressions, use leftOperand; otherwise use beforeValue
    if (operation.isConstant && operation.leftOperand !== undefined) {
        actualBeforeValue = operation.leftOperand;
    } else {
        actualBeforeValue = beforeValue ?? 0;
    }

    // Perform the operation
    switch (operation.operator) {
        case BitOperationType.AND:
        case BitOperationType.AND_ASSIGN:
            afterValue = actualBeforeValue & operation.operand;
            break;
        case BitOperationType.OR:
        case BitOperationType.OR_ASSIGN:
            afterValue = actualBeforeValue | operation.operand;
            break;
        case BitOperationType.XOR:
        case BitOperationType.XOR_ASSIGN:
            afterValue = actualBeforeValue ^ operation.operand;
            break;
        case BitOperationType.LEFT_SHIFT:
        case BitOperationType.LEFT_SHIFT_ASSIGN:
            afterValue = shiftLeftNumber(actualBeforeValue, operation.operand);
            break;
        case BitOperationType.RIGHT_SHIFT:
        case BitOperationType.RIGHT_SHIFT_ASSIGN:
            afterValue = shiftRightNumber(actualBeforeValue, operation.operand);
            break;
        case BitOperationType.NOT:
            afterValue = ~actualBeforeValue;
            break;
        default:
            afterValue = actualBeforeValue;
    }

    // Calculate changed bits
    const changedBits: number[] = [];
    const setBits: number[] = [];
    const clearedBits: number[] = [];

    // Compare up to 32 bits
    for (let i = 0; i < 32; i++) {
        const beforeBit = (actualBeforeValue >> i) & 1;
        const afterBit = (afterValue >> i) & 1;

        if (beforeBit !== afterBit) {
            changedBits.push(i);
            if (afterBit === 1) {
                setBits.push(i);
            } else {
                clearedBits.push(i);
            }
        }
    }

    return {
        operation,
        beforeValue: operation.isConstant ? actualBeforeValue : beforeValue,
        afterValue,
        changedBits,
        setBits,
        clearedBits
    };
}

/**
 * Format bit operation result as markdown
 */
export function formatBitOperationResult(result: BitOperationResult): vscode.MarkdownString {
    const md = createCopyableHoverMarkdown();

    const { operation, beforeValue, afterValue } = result;
    const operandsAreExact = Number.isSafeInteger(operation.operand)
        && (beforeValue === undefined || Number.isSafeInteger(beforeValue))
        && (operation.leftOperand === undefined || Number.isSafeInteger(operation.leftOperand));

    // Title - different for constant expressions
    if (operation.isConstant) {
        md.appendMarkdown(`### Constant Expression Result\n\n`);
    } else {
        md.appendMarkdown(`### Bit Operation Result\n\n`);
    }

    // Operation
    md.appendMarkdown(`**Expression:** ${escapeHoverText(operation.expression)}\n\n`);

    // Values table
    md.appendMarkdown(`| | Hex | Dec | Bin |\n`);
    md.appendMarkdown(`|---|---|---|---|\n`);

    const appendValueRow = (label: string, value: number) => {
        if (!operandsAreExact || !Number.isSafeInteger(value)) {
            const unavailable = escapeHoverText(t('정확한 정수 값 없음', 'Exact integer unavailable'));
            md.appendMarkdown(`| **${label}** | — | ${unavailable} | — |\n`);
            return;
        }
        const hex = formatCopyableHoverValue(formatHoverInteger(value, 16, 8));
        const dec = formatCopyableHoverValue(formatHoverInteger(value, 10));
        const bin = formatCopyableHoverValue(formatHoverInteger(value, 2, 32));
        md.appendMarkdown(`| **${label}** | ${hex} | ${dec} | ${bin} |\n`);
    };

    if (beforeValue !== undefined) {
        appendValueRow(operation.isConstant ? 'Left' : 'Before', beforeValue);
    }
    appendValueRow(operation.isConstant ? 'Result' : 'After', afterValue);

    return md;
}
