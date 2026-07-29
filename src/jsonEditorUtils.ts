/**
 * webview JS(jsonEditor.ts의 getWebviewContent 내부 `buildSheetMap`/`getActiveRows`/
 * `parseValue`/`coerceEditedCellValue`/`buildDraftSnapshot`)의 테스트용 미러. 프로덕션
 * 코드는 webview 내부 JS 문자열을 사용하므로 이 파일을 import하지 못한다. 로직을
 * 변경할 때는 반드시 jsonEditor.ts의 동일 함수도 함께 수정해야 한다.
 * (동기화 대상: jsonEditor.ts의 buildSheetMap / getActiveRows / parseValue / commitCell /
 * sendDraftSnapshot)
 *
 * 이 파일은 host-side에서 import 가능한 순수 헬퍼도 같이 보관한다.
 * 예: dirty-close 복구 스냅샷의 유효성 판정({@link shouldOfferRecovery}).
 */

/**
 * Dirty 상태에서 패널이 닫힌 뒤 workspaceState에 저장되는 복구 스냅샷.
 * `data`/`isRootArray`는 webview가 다루는 wrapped 형태 그대로 보관한다.
 * `fileMtimeMs`는 스냅샷이 캡처되던 시점의 디스크 파일 mtime이며, 이후 파일이
 * 외부에서 변경되었는지 판별하는 데 쓰인다.
 *
 * `fileSize`는 같은 시점의 디스크 파일 크기를 함께 보관하는 보조 fingerprint다.
 * mtime 만으로는 외부 도구가 mtime 을 보존하거나 (예: `touch -r`, 일부 sync
 * 도구) 파일시스템 해상도 때문에 같은 mtime으로 보일 때 외부 변경을 놓친다.
 * 옛 엔트리에는 없을 수 있어 optional 로 둔다.
 */
export interface RecoveryEntry {
    data: unknown;
    isRootArray: boolean;
    fileMtimeMs: number;
    fileSize?: number;
    capturedAt: number;
}

/**
 * 저장된 복구 스냅샷을 사용자에게 제안할지 결정한다.
 *
 * 디스크 파일이 스냅샷 캡처 이후 외부에서 변경됐다면(파일 mtime이 더 큼) 스냅샷은
 * stale 이므로 제안하지 않는다. 동일 mtime일 때만 "내가 닫기 전 미저장 변경사항"이
 * 안전하게 식별된다. 파일이 약간 더 이전(시계 보정 등) 으로 보이는 경우는 캡처 시점
 * 이후 변경이 없었다는 의미이므로 제안한다.
 *
 * 1ms 미만의 차이는 파일시스템 시간 해상도(특히 macOS HFS+의 1초 단위, Windows
 * FAT 의 2초 단위)에서 발생하는 라운딩 차이로 무시한다.
 *
 * `currentFileSize` 가 주어지고 entry 에도 size 가 기록돼 있다면 보조 fingerprint
 * 로 함께 본다 — mtime 일치 + size 불일치는 mtime 을 보존한 외부 변경의 강한
 * 신호다. 한쪽이라도 없으면 mtime-only 검사로 폴백한다 (옛 엔트리 호환).
 */
export function shouldOfferRecovery(
    entry: RecoveryEntry,
    currentFileMtimeMs: number,
    currentFileSize?: number
): boolean {
    if (!entry || typeof entry.fileMtimeMs !== 'number') { return false; }
    if (currentFileMtimeMs - entry.fileMtimeMs > 1) { return false; }
    if (typeof entry.fileSize === 'number' && typeof currentFileSize === 'number') {
        if (entry.fileSize !== currentFileSize) { return false; }
    }
    return true;
}

/**
 * 단위테스트가 vscode.ExtensionContext.workspaceState 없이도 RecoveryStore 로직을
 * 검증할 수 있도록 정의된 최소 인터페이스. 실제 구현(workspaceState)은 이미 호환된다.
 */
export interface MinimalWorkspaceState {
    get<T>(key: string, defaultValue: T): T;
    // VS Code Memento.update returns Thenable<void>; PromiseLike<void> 는 그것과
    // 일반 Promise<void>(테스트 더블) 모두를 받을 수 있다.
    update(key: string, value: unknown): PromiseLike<void>;
}

export interface RecoveryStore {
    get(filePath: string): RecoveryEntry | undefined;
    set(filePath: string, entry: RecoveryEntry | null): Promise<void>;
}

/**
 * Recovery 엔트리를 직렬화된 read-modify-write 체인으로 갱신하는 store 를 만든다.
 *
 * 두 가지 race 를 동시에 닫는다.
 *
 * 1) **save vs in-flight snapshot interleave**: 디바운스 timer 가 fire 된 직후
 *    save 가 들어오는 경우처럼, 두 update 호출이 `await ...update(...)` 사이에
 *    interleave 되면 둘 다 같은 baseline map 을 읽어 last-write-wins 로 의도와
 *    반대 결과(save 가 비운 entry 를 stale snapshot 이 부활) 가 발생할 수 있다.
 *    모든 update 를 단일 promise chain 으로 직렬화해 막는다.
 *
 * 2) **close → 즉시 reopen 의 sync get vs async flush**: dispose 핸들러가 비동기
 *    flush 를 fire-and-forget 으로 트리거한 직후 사용자가 같은 파일을 열면,
 *    naive 한 `state.get()` 은 아직 persist 되지 않은 in-flight write 를 보지
 *    못해 recovery 가 빠진다. 이 store 는 `set()` 호출 시점에 즉시 갱신되는
 *    **synchronous shadow map** 을 유지해, persist 가 비동기로 끝나기 전이라도
 *    `get()` 이 최신 값을 본다.
 *
 * 또한 `update()` 에는 shadow 의 *clone* 을 넘긴다 — 일부 Memento 구현이
 * `get()` 에서 내부 reference 를 그대로 돌려주므로, `map[k] = v` 같은 직접 mutation
 * 으로 update 실패 전에도 in-memory 상태가 새는 것을 막기 위함이다.
 *
 * 한 번 일어난 실패는 다음 호출이 진행되도록 catch 로 swallow 하지만, 호출자에게는
 * 원래 promise 를 반환해 await 시 reject 가 그대로 전달된다.
 */
/**
 * 보관할 복구 스냅샷 최대 개수.
 *
 * 항목 하나가 **파일 전체의 파싱 결과**라 다이얼로그 위치(경로 문자열 하나)와는
 * 무게가 다르다. 큰 JSON 을 여러 개 dirty 상태로 닫으면 workspaceState 와
 * in-memory shadow 가 같이 선형으로 자라는데, 예전에는 개수도 수명도 제한이
 * 없었다.
 */
export const RECOVERY_MAX_ENTRIES = 20;

/**
 * 보관할 스냅샷 총량 상한 (직렬화 기준 바이트).
 *
 * 개수 상한만으로는 부족하다 — 20MB 짜리 JSON 20개면 개수는 지켜도 400MB 다.
 * 실제 무게는 바이트이므로 총량으로도 자른다. 개수와 총량 중 **먼저 걸리는
 * 쪽**이 적용된다.
 */
export const RECOVERY_MAX_BYTES = 32 * 1024 * 1024;

/** 스냅샷 하나의 대략적 크기. 정확한 힙 사용량이 아니라 상대 비교용이다. */
function approximateEntryBytes(entry: RecoveryEntry): number {
    try {
        return JSON.stringify(entry.data)?.length ?? 0;
    } catch {
        // 순환 참조 등 — 직렬화할 수 없으면 어차피 persist 도 못 하므로
        // 크게 쳐서 먼저 버려지게 한다.
        return Number.MAX_SAFE_INTEGER;
    }
}

/**
 * 최신 `max` 개만 남기고 오래된 스냅샷부터 버린다.
 *
 * **수명(TTL) 기준 삭제는 일부러 넣지 않았다.** 여기 담긴 것은 사용자의
 * *미저장 작업*이므로, "2주 지났으니 지운다" 같은 시계 기반 정책은 메모리
 * 상한의 부수 효과로 결정할 일이 아니다. 개수 제한만으로 무한 증가는 막히고,
 * 무엇을 언제 버리는지가 사용자 행동(더 많은 파일을 dirty 로 닫음)에만
 * 좌우되어 예측 가능하다.
 *
 * 순수 함수라 축출 순서를 시계 없이 검증할 수 있다.
 */
export function pruneRecoveryEntries(
    entries: Record<string, RecoveryEntry>,
    max: number = RECOVERY_MAX_ENTRIES,
    maxBytes: number = RECOVERY_MAX_BYTES
): Record<string, RecoveryEntry> {
    const all = Object.entries(entries);
    // 개수가 상한 이하라도 총량은 넘을 수 있으므로 항상 확인한다.
    const sizes = new Map(all.map(([k, e]) => [k, approximateEntryBytes(e)]));
    let total = 0;
    for (const size of sizes.values()) { total += size; }
    if (all.length <= max && total <= maxBytes) { return entries; }

    // `capturedAt` 이 같으면 경로로 갈라 결과가 결정적이게 한다.
    all.sort((a, b) => {
        const at = (e: RecoveryEntry) => (typeof e?.capturedAt === 'number' ? e.capturedAt : 0);
        return (at(b[1]) - at(a[1])) || a[0].localeCompare(b[0]);
    });

    const kept: [string, RecoveryEntry][] = [];
    let keptBytes = 0;
    for (const pair of all) {
        if (kept.length >= max) { break; }
        const size = sizes.get(pair[0]) ?? 0;
        // 첫 항목은 총량을 넘더라도 남긴다 — 방금 닫은 파일의 복구본을
        // 크다는 이유로 통째로 버리면 기능 자체가 없는 것과 같다.
        if (kept.length > 0 && keptBytes + size > maxBytes) { continue; }
        kept.push(pair);
        keptBytes += size;
    }
    return Object.fromEntries(kept);
}

export function makeRecoveryStore(state: MinimalWorkspaceState, key: string): RecoveryStore {
    let chain: Promise<void> = Promise.resolve();
    // 초기 shadow 는 workspaceState 로부터 한 번 읽어 들인 top-level clone.
    // 이후 set 호출은 shadow 만 동기적으로 mutate하고 persist 는 chain 으로 비동기 처리.
    const initial = state.get<Record<string, RecoveryEntry>>(key, {});
    // **로드 시점에도** 상한을 적용한다. `set()` 에서만 자르면 이미 20개를
    // 넘겨 쌓아 둔 기존 사용자는 다음 저장이 일어나기 전까지 그대로 위험하고,
    // 그 사이 shadow 가 전량을 메모리에 붙잡는다.
    const shadow: Record<string, RecoveryEntry> = { ...pruneRecoveryEntries(initial) };
    // 줄었다면 persist 도 맞춘다 — 안 그러면 다음 실행마다 같은 정리를 반복한다.
    //
    // **`chain` 에 넣는다.** 예전에는 여기만 독립적인 fire-and-forget 이라
    // `set()` 의 직렬화 밖에 있었다. 초기 정리 쓰기가 늦게 끝나면 그 사이
    // 저장한 최신 복구본을 **오래된 스냅샷으로 덮어쓰거나**, 방금 지운 항목을
    // 되살릴 수 있다 — 항목 하나가 파일 전체의 미저장 작업이라 손실이 크다.
    if (Object.keys(shadow).length !== Object.keys(initial).length) {
        const prunedSnapshot = { ...shadow };
        chain = chain
            .then(() => Promise.resolve(state.update(key, prunedSnapshot)))
            .then(undefined, () => undefined);
    }

    return {
        get(filePath: string): RecoveryEntry | undefined {
            return shadow[filePath];
        },
        set(filePath: string, entry: RecoveryEntry | null): Promise<void> {
            // shadow 동기 갱신 — 직후의 get 호출이 in-flight 상태를 본다.
            if (entry) {
                shadow[filePath] = entry;
            } else {
                delete shadow[filePath];
            }
            // 쓸 때마다 상한을 지킨다. 항목 하나가 파일 전체의 파싱 결과라,
            // 개수 제한이 없으면 큰 JSON 을 여럿 dirty 로 닫는 것만으로
            // workspaceState 와 shadow 가 함께 선형으로 자란다.
            const kept = pruneRecoveryEntries(shadow);
            if (kept !== shadow) {
                for (const k of Object.keys(shadow)) {
                    if (!(k in kept)) { delete shadow[k]; }
                }
            }
            // update 에는 shadow 의 clone 을 넘긴다 (defensive write).
            const snapshot = { ...shadow };
            const next = chain.then(async () => {
                await state.update(key, snapshot);
            });
            chain = next.catch(() => undefined);
            return next;
        }
    };
}

export interface SheetEntry {
    label: string;
    path: string[];
}

export function buildSheetMap(data: Record<string, unknown>): SheetEntry[] {
    const sheetMap: SheetEntry[] = [];
    Object.keys(data).forEach(key => {
        const val = data[key];
        if (Array.isArray(val)) {
            sheetMap.push({ label: key, path: [key] });
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            const obj = val as Record<string, unknown>;
            Object.keys(obj).forEach(subKey => {
                if (Array.isArray(obj[subKey])) {
                    sheetMap.push({ label: key + ' > ' + subKey, path: [key, subKey] });
                }
            });
        }
    });
    return sheetMap;
}

export function getRowsByPath(data: Record<string, unknown>, path: string[]): unknown[] | null {
    let ref: unknown = data;
    for (const k of path) {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
            ref = (ref as Record<string, unknown>)[k];
        } else {
            return null;
        }
    }
    return Array.isArray(ref) ? ref : null;
}

/**
 * Mirror of the webview's `parseValue`. Coerces the raw input string for a
 * simple cell editor back into a primitive JS value. Exported so the coercion
 * rules can be exercised in unit tests alongside {@link coerceEditedCellValue}.
 */
export function parseValue(str: string): unknown {
    if (str === '') { return ''; }
    if (str === 'null') { return null; }
    if (str === 'true') { return true; }
    if (str === 'false') { return false; }
    const num = Number(str);
    if (Number.isFinite(num) && str.trim() !== '') { return num; }
    return str;
}

/**
 * Mirror of the webview `commitCell` branch that assigns a new value for a
 * plain (non-array) cell edit.
 *
 * The key invariant — and the reason this helper exists separately from
 * {@link parseValue} — is that when the original cell was a string the raw
 * input must be preserved as-is, so values like `"00123"`, `"true"`, `"null"`
 * do not get silently re-typed on save.
 */
export function coerceEditedCellValue(rawInput: string, oldValue: unknown): unknown {
    if (typeof oldValue === 'string') {
        return rawInput;
    }
    return parseValue(rawInput);
}

/**
 * `sendDraftSnapshot()` 결과의 분기.
 *
 * - `snapshot`: 미커밋 입력이 반영된 새로운 draft. host에 전송해 recovery 엔트리에 기록.
 * - `clean`: 입력이 saved baseline 과 동일해진 케이스. host에 modified=false 를 보내
 *   recovery 엔트리를 비우는 것이 올바르다 (그렇지 않으면 다음 reopen 에 의미 없는
 *   복구 프롬프트가 뜬다).
 * - `skip`: 인덱스/경로 불일치, invalid arrIdx, JSON-edit textarea 의 unparseable
 *   상태 등 — 이전 draft 를 갱신하지 않는다.
 */
export type DraftSnapshotResult =
    | { kind: 'snapshot'; data: unknown }
    | { kind: 'clean' }
    | { kind: 'skip' };

export interface DraftSnapshotInput {
    /** 현재 webview 의 root data (wrapped 형태 그대로). */
    data: unknown;
    /** 활성 시트의 path (예: ['sheet1'] 또는 ['config','items']). */
    sheetPath: string[];
    rowIdx: number;
    col: string;
    /** input.value (또는 textarea.value) — string 그대로. */
    rawInputValue: string;
    /**
     * 배열 셀의 개별 태그 input 일 때 그 인덱스. 없으면 plain 또는 json-edit
     * textarea 다.
     */
    arrIdx?: number;
    /** `<textarea class="json-edit">` 인 경우 true. */
    isJsonEdit?: boolean;
    /**
     * webview 의 `lastSavedSnapshot` (JSON.stringify(data) at save baseline).
     * 비교 결과 draft 가 baseline 과 일치하면 `clean` 결과를 돌려 recovery
     * 엔트리를 비울 수 있도록 한다. boot 직전에는 null.
     */
    lastSavedSnapshot: string | null;
}

/**
 * webview 의 `sendDraftSnapshot()` 핵심 로직 — 활성 셀의 미커밋 입력을 root data 의
 * deep clone 위에 적용한 draft 와, 그 draft 가 saved baseline 과 동일한지 여부를
 * 함께 돌려준다.
 *
 * 세 가지 invariant:
 *
 * 1. **타입 보존**: plain (non-array) 셀에서는 commitCell 과 동일하게 oldVal 의
 *    타입을 보고 raw 또는 `parseValue(raw)` 를 적용한다. 그렇지 않으면 숫자/불리언/
 *    null 셀의 미커밋 draft 가 `"2"`, `"true"`, `"null"` 처럼 string 으로 굳어
 *    복구 후 저장 시 디스크에 string 이 기록된다.
 * 2. **JSON-edit 셀의 valid 입력은 복구 대상**: `isJsonEdit` 분기에서 raw 가 valid
 *    JSON 일 때만 parsed 값을 적용. invalid 면 `skip` (이전 valid draft 가 남는다).
 * 3. **clean revert 인식**: stringify 비교 후 lastSavedSnapshot 과 같으면 `clean`
 *    을 돌려 host 가 recovery 엔트리를 비울 수 있게 한다.
 *
 * data 자체는 mutate 하지 않는다. 구조 또는 인덱스가 어긋나면 `skip` 으로 빠진다.
 */
export function buildDraftSnapshot(input: DraftSnapshotInput): DraftSnapshotResult {
    const { data, sheetPath, rowIdx, col, rawInputValue, arrIdx, isJsonEdit, lastSavedSnapshot } = input;
    if (!data || typeof data !== 'object') { return { kind: 'skip' }; }
    // col 은 string 타입만 검증 — JSON 은 빈 문자열 key ({"": "value"}) 도 허용
    // 하므로 falsy 검사 (`!col`) 는 이를 부당하게 skip 시킨다.
    if (!Array.isArray(sheetPath) || typeof col !== 'string') { return { kind: 'skip' }; }
    if (typeof rowIdx !== 'number' || Number.isNaN(rowIdx) || rowIdx < 0) { return { kind: 'skip' }; }

    let draft: unknown;
    try {
        draft = JSON.parse(JSON.stringify(data));
    } catch {
        return { kind: 'skip' };
    }

    let ref: unknown = draft;
    for (const k of sheetPath) {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { return { kind: 'skip' }; }
        ref = (ref as Record<string, unknown>)[k];
    }
    if (!Array.isArray(ref)) { return { kind: 'skip' }; }
    const row = ref[rowIdx];
    if (!row || typeof row !== 'object' || Array.isArray(row)) { return { kind: 'skip' }; }
    const rowObj = row as Record<string, unknown>;
    const oldVal = rowObj[col];

    if (typeof arrIdx === 'number' && !Number.isNaN(arrIdx)) {
        const arr = rowObj[col];
        if (!Array.isArray(arr) || arrIdx < 0 || arrIdx >= arr.length) { return { kind: 'skip' }; }
        // commitCell 의 array 분기는 모든 input.value 를 string 그대로 모아 새
        // 배열로 갈아끼우므로 (line 1487-1493 of jsonEditor.ts), 개별 항목 draft
        // 도 string 으로 넣는 것이 commit 결과와 일치한다.
        arr[arrIdx] = rawInputValue;
    } else if (isJsonEdit) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawInputValue);
        } catch {
            return { kind: 'skip' };
        }
        rowObj[col] = parsed;
    } else {
        rowObj[col] = coerceEditedCellValue(rawInputValue, oldVal);
    }

    if (lastSavedSnapshot !== null && lastSavedSnapshot !== undefined) {
        if (JSON.stringify(draft) === lastSavedSnapshot) {
            return { kind: 'clean' };
        }
    }
    return { kind: 'snapshot', data: draft };
}
