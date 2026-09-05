/**
 * JSON Editor 의 순수 로직. `vscode` 를 import 하지 않으며, 앞으로도 하면 안 된다 —
 * 이 파일은 webview 번들에도 들어가므로 확장 호스트 API 가 없는 곳에서 실행된다.
 *
 * **이 파일을 쓰는 곳은 셋이다.**
 *
 *   1. host (`jsonEditor.ts`) — 직접 import.
 *   2. webview — `src/webview/jsonEditorLogic.ts` 를 통해 `dist/jsonEditorWebview.js`
 *      로 묶여 전역 `TaskHubJsonEditorLogic` 으로 올라간다. 여기까지 옮긴 것은
 *      {@link parseValue} · {@link coerceEditedCellValue} · {@link coerceEditedArrayItems} ·
 *      {@link buildSheetMap} · {@link getRowsByPath} · {@link effectiveBaseline} ·
 *      {@link decideSaveResult} · {@link buildDraftSnapshot} ·
 *      {@link resolveActiveDraftState} — 즉 **전부**다.
 *   3. 테스트.
 *
 * **미러는 이제 없다.** 예전에는 이 함수들의 사본이 `jsonEditor.ts` 의 템플릿 리터럴
 * 안에 한 벌 더 있었고, 실제로 도는 것은 그 사본이었다. 두 벌은 반드시 어긋나므로
 * (0.6.68~0.6.70 이 전부 그 얘기다) `NOTE: … 와 동일해야 한다` 주석으로 버티고
 * 있었는데, 이제 webview 가 이 파일을 번들로 직접 부른다.
 *
 * webview 에 남은 `commitCell` · `sendDraftSnapshot` · `syncEditingArrayCellToData` ·
 * `readActiveCellEdit` · `activeDraftState` 은 **DOM 어댑터**다 — DOM 을 읽어 위
 * 함수들에 넘기고 결과를 화면·host 에 반영할 뿐, 중복된 로직을 들고 있지 않다.
 *
 * 배경은 docs/architecture.md 의 "webview 스크립트의 두 층" 참조.
 *
 * 이 파일은 host-side 전용 순수 헬퍼도 같이 보관한다.
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
 * Whether a watcher event is the JSON Editor's own most recent write.
 *
 * mtime alone is insufficient: sync tools can preserve it and coarse
 * filesystems can assign the same timestamp to different contents. When the
 * previous size is known, both fingerprints must match. Missing size keeps
 * compatibility with state recorded before size tracking was introduced.
 */
export function shouldSuppressJsonEditorSelfWrite(
    lastWriteMtimeMs: number | undefined,
    lastWriteSize: number | undefined,
    changedMtimeMs: number,
    changedSize: number
): boolean {
    return lastWriteMtimeMs !== undefined &&
        Math.abs(changedMtimeMs - lastWriteMtimeMs) < 1 &&
        (lastWriteSize === undefined || changedSize === lastWriteSize);
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

/** 표의 객체 행에 새 필드를 추가한다. 객체 행이 없으면 첫 객체 행을 만든다. */
export function addJsonEditorField(rows: unknown[], fieldName: string): 'added' | 'empty-name' | 'duplicate-name' {
    const name = fieldName.trim();
    if (!name) { return 'empty-name'; }
    const objects = rows.filter((row): row is Record<string, unknown> =>
        row !== null && typeof row === 'object' && !Array.isArray(row));
    if (objects.some(row => Object.hasOwn(row, name))) { return 'duplicate-name'; }
    if (objects.length === 0) {
        const first: Record<string, unknown> = {};
        objects.push(first);
        rows.push(first);
    }
    for (const row of objects) {
        // __proto__ 같은 유효한 JSON 키도 객체의 prototype을 바꾸지 않고 저장한다.
        Object.defineProperty(row, name, { value: '', enumerable: true, configurable: true, writable: true });
    }
    return 'added';
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
 * 단순 셀 편집기의 raw 입력 문자열을 원시 JS 값으로 되돌린다.
 *
 * **미러가 아니라 webview 가 실제로 부르는 그 함수다** — `jsonEditor.ts` 의
 * 템플릿 리터럴에는 사본이 없고, 번들(`dist/jsonEditorWebview.js`)을 통해 이것이
 * 그대로 실행된다. {@link coerceEditedCellValue} 와 함께 단위테스트로 검사한다.
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
 * Mirror of the webview `commitCell` / `syncEditingArrayCellToData` branch that
 * rebuilds a primitive array cell from its per-item `<input>` values.
 *
 * The array editor renders one text input per item, so every value comes back
 * as a string. Collecting them verbatim turned `[1, true, null]` into
 * `["1", "true", "null"]` **on the mere act of opening and leaving the cell** —
 * no edit required. The scalar branch already avoids this via
 * {@link coerceEditedCellValue}; arrays apply the same rule per item.
 *
 * **빈 슬롯에는 보존할 타입이 없다.** 옛 항목이 `''` 이거나 아예 없으면
 * {@link parseValue} 로 해석한다. webview 의 "+" 버튼이 새 항목을 `''` 로 데이터에
 * 밀어 넣고 다시 그리므로, 그것을 "문자열 항목" 으로 보면 숫자 배열에 항목 하나를
 * 더한 것만으로 `[1, 2, "3"]` 같은 **혼합 배열**이 디스크에 기록된다.
 *
 * scalar 셀(`''` → 입력하면 문자열 유지)과 규칙이 갈리는 것은 의도적이다. scalar 의
 * `''` 는 사용자가 파일에 적어 둔 값이지만, 배열의 빈 항목은 거의 언제나 방금 만든
 * 자리 표시자이고, 배열은 항목끼리 같은 타입인 것이 정상이다.
 */
export function coerceEditedArrayItems(
    rawInputs: readonly string[],
    oldArray: readonly unknown[]
): unknown[] {
    return rawInputs.map((raw, i) => {
        const oldValue = oldArray[i];
        if (oldValue === '' || oldValue === undefined) { return parseValue(raw); }
        return coerceEditedCellValue(raw, oldValue);
    });
}

/**
 * `saveResult` 메시지 하나에 대한 webview 의 결정.
 *
 * - `ignore`: 이 webview 세션의 응답이 아니다. pending 항목도 건드리지 않는다.
 * - `keep`: baseline 을 옮기지 않는다. `dirty` 만 host 에 다시 알린다.
 * - `apply`: baseline 을 `lastSavedSnapshot` 으로 옮기고 `dirty` 를 반영한다.
 */
export type SaveResultDecision =
    | { kind: 'ignore' }
    | { kind: 'keep'; dirty: boolean }
    | { kind: 'apply'; lastSavedSnapshot: string; dirty: boolean };

export interface SaveResultInput {
    /** 이 webview 인스턴스의 세션 번호. */
    sessionId: number;
    /** host 가 보낸 `saveResult` 메시지. */
    message: { success?: unknown; seq?: unknown; session?: unknown };
    /** seq → 그 저장 요청이 host 로 보낸 스냅샷. */
    pendingSnapshots: ReadonlyMap<unknown, string>;
    /** 지금 화면의 `JSON.stringify(data)`. */
    currentSnapshot: string;
    /** 현재 saved baseline. boot 직전에는 null. */
    lastSavedSnapshot: string | null;
}

/**
 * Mirror of the webview's `effectiveBaseline()` — dirty 판정의 기준이 되는
 * "디스크에 있을 내용".
 *
 * 저장 응답을 기다리는 동안 디스크에 들어가는 것은 **가장 최근 저장 요청이 보낸
 * 스냅샷**이지 `lastSavedSnapshot` 이 아니다. 그것과 비교하면, 저장 직후 옛
 * 내용으로 undo 했을 때 "변경 없음" 이라는 잘못된 판정이 나온다 — 그러면 dirty 도
 * 안 켜지고 **recovery 스냅샷도 보내지 않는다.** host 는 저장과 함께 recovery 를
 * 이미 지웠으므로, 그 상태에서 패널을 닫으면 undo 결과를 되살릴 방법이 없다.
 *
 * Map 은 삽입 순서를 지키므로 마지막 값이 가장 최근 요청이다.
 */
export function effectiveBaseline(
    pendingSnapshots: ReadonlyMap<unknown, string>,
    lastSavedSnapshot: string | null
): string | null {
    let latest: string | undefined;
    for (const snap of pendingSnapshots.values()) { latest = snap; }
    return latest !== undefined ? latest : lastSavedSnapshot;
}

/**
 * Mirror of the webview's `saveResult` 처리. 두 가지를 고정한다.
 *
 * 1. **세션 귀속**: host 는 파일을 바꿔 열 때 패널을 재사용하므로, 이전 파일의
 *    in-flight 저장 응답이 새 webview 로 배달될 수 있다. 세션이 다르면 이
 *    파일에 대해 아무것도 말해 주지 않는 메시지이므로 무시한다. 그러지 않으면
 *    남의 저장 결과로 이 파일의 미저장 편집이 clean 처리되어 사라진다.
 *
 * 2. **모르면 절대 clean 이 아니다**: baseline 은 그 저장 요청이 **보낸**
 *    스냅샷이다. seq 를 못 찾으면(상한에 밀려 버려진 요청) 디스크에 어떤
 *    스냅샷이 들어갔는지 알 수 없으므로 무조건 dirty 로 둔다. 기존 baseline 과
 *    비교하는 것으로는 부족하다 — 사용자가 옛 baseline 으로 undo 해 두었다면
 *    "화면 == 옛 baseline" 이 성립하지만 디스크에는 그 사이의 다른 스냅샷이
 *    들어가 있어, 실제로는 디스크와 화면이 다른데 clean 으로 판정된다.
 *    잘못 clean 처리하는 것만이 되돌릴 수 없는 실수이고, 반대 방향(불필요한
 *    dirty)은 한 번 더 저장하면 끝난다.
 */
export function decideSaveResult(input: SaveResultInput): SaveResultDecision {
    if (input.message.session !== input.sessionId) { return { kind: 'ignore' }; }
    // **아직 남아 있는 다른 저장이 디스크의 최종 내용을 정한다.** 응답한 항목을
    // 뺀 나머지가 기준이 되며, 이 계산은 성공·실패 **양쪽 모두**에 필요하다.
    const remaining = new Map(
        [...input.pendingSnapshots].filter(([seq]) => seq !== input.message.seq)
    );
    if (!input.message.success) {
        // 실패해도 host 와 상태는 맞춰 둔다. 저장 시도 중에 host 가 pending
        // snapshot 을 이미 버렸으므로, dirty 면 recovery 를 다시 채워야 한다.
        //
        // **이 저장은 디스크에 닿지 않았지만 남은 저장은 곧 닿는다.** 그래서
        // 기준은 `lastSavedSnapshot` 이 아니라 나머지 pending 이다. 겹친 저장
        // (seq1=B, seq2=C)에서 seq1 이 실패했을 때 옛 baseline A 와만 비교하면,
        // 화면을 A 로 undo 해 둔 사용자는 clean 판정을 받는다 — host 는
        // `saveAck` 의 dirty 를 무조건 적용하므로 **복구 항목까지 지운다.**
        // 그 직후 seq2 가 C 를 디스크에 남기므로 화면과 디스크가 실제로는
        // 다르다. 성공 분기와 같은 기준을 쓰면 그 창이 아예 없다.
        return {
            kind: 'keep',
            dirty: input.currentSnapshot !== effectiveBaseline(remaining, input.lastSavedSnapshot),
        };
    }
    const saved = input.pendingSnapshots.get(input.message.seq);
    if (saved === undefined) { return { kind: 'keep', dirty: true }; }
    // 저장이 겹쳤을 때(seq1=B, seq2=C) seq1 의 응답만 보고 B 와 비교하면, 화면이
    // B 인 상태에서 clean 으로 판정된다 — 그러나 곧 C 가 디스크에 남는다.
    const baselineForDirty = effectiveBaseline(remaining, saved);
    return {
        kind: 'apply',
        lastSavedSnapshot: saved,
        dirty: input.currentSnapshot !== baselineForDirty,
    };
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
     * 배열 셀이면 **그 셀의 모든 태그 input 값**. 없으면 plain 또는 json-edit
     * textarea 다.
     *
     * 이벤트가 난 항목 하나만 넘기면 같은 셀의 다른 미커밋 입력이 draft 에서
     * 사라진다 — 그리고 그 항목을 원래 값으로 되돌리면 draft 가 baseline 과
     * 같아져 `clean` 판정까지 나서 dirty 와 recovery 가 함께 풀린다.
     */
    arrValues?: readonly string[];
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
 * 네 가지 invariant:
 *
 * 1. **타입 보존**: plain (non-array) 셀에서는 commitCell 과 동일하게 oldVal 의
 *    타입을 보고 raw 또는 `parseValue(raw)` 를 적용한다. 그렇지 않으면 숫자/불리언/
 *    null 셀의 미커밋 draft 가 `"2"`, `"true"`, `"null"` 처럼 string 으로 굳어
 *    복구 후 저장 시 디스크에 string 이 기록된다. 배열 셀의 개별 항목도
 *    {@link coerceEditedArrayItems} 와 같은 규칙을 **항목 단위**로 적용한다.
 * 1-1. **empty 가드도 commitCell 과 동일**: 옛 값과 새 값이 모두 비어 있으면
 *    (`undefined` / `null` / `''`) 쓰지 않는다. 그러지 않으면 null 셀을 열어
 *    두기만 해도 draft 가 `""` 로 달라져 dirty 가 풀리지 않고, 복구 스냅샷이
 *    `null` 을 `""` 로 바꾼다.
 * 2. **JSON-edit 셀의 valid 입력은 복구 대상**: `isJsonEdit` 분기에서 raw 가 valid
 *    JSON 일 때만 parsed 값을 적용. invalid 면 `skip` (이전 valid draft 가 남는다).
 * 3. **clean revert 인식**: stringify 비교 후 lastSavedSnapshot 과 같으면 `clean`
 *    을 돌려 host 가 recovery 엔트리를 비울 수 있게 한다.
 *
 * data 자체는 mutate 하지 않는다. 구조 또는 인덱스가 어긋나면 `skip` 으로 빠진다.
 */
export function buildDraftSnapshot(input: DraftSnapshotInput): DraftSnapshotResult {
    const { data, sheetPath, rowIdx, col, rawInputValue, arrValues, isJsonEdit, lastSavedSnapshot } = input;
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

    if (arrValues) {
        const arr = rowObj[col];
        if (!Array.isArray(arr) || arrValues.length === 0) { return { kind: 'skip' }; }
        // 셀의 **모든** input 값을 commitCell 과 같은 규칙으로 한 번에 반영한다
        // (coerceEditedArrayItems). 하나만 반영하면 같은 셀의 다른 미커밋 입력이
        // 사라지고, draft 만 string 으로 굳히면 복구 후 저장에서 숫자/불리언/null
        // 배열이 문자열 배열로 디스크에 기록된다.
        rowObj[col] = coerceEditedArrayItems(arrValues, arr);
    } else if (isJsonEdit) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawInputValue);
        } catch {
            return { kind: 'skip' };
        }
        rowObj[col] = parsed;
    } else {
        const newVal = coerceEditedCellValue(rawInputValue, oldVal);
        // **commitCell 의 empty 가드와 같은 규칙.** null / undefined / 빈 값 셀은
        // input 에 `""` 로 그려지므로, 아무것도 타이핑하지 않고 셀을 열어 두기만
        // 해도 draft 가 `""` 로 달라진다 — 저장 뒤에도 dirty 가 풀리지 않고
        // (blur 의 commitCell 은 이 가드 때문에 changed 로 보지 않는다),
        // recovery 스냅샷에 `null → ""` 이 굳으며 그 키가 없던 행에는
        // `col: ""` 가 새로 생긴다.
        const oldEmpty = oldVal === undefined || oldVal === null || oldVal === '';
        const newEmpty = newVal === undefined || newVal === null || newVal === '';
        if (!(oldEmpty && newEmpty)) {
            rowObj[col] = newVal;
        }
    }

    if (lastSavedSnapshot !== null && lastSavedSnapshot !== undefined) {
        if (JSON.stringify(draft) === lastSavedSnapshot) {
            return { kind: 'clean' };
        }
    }
    return { kind: 'snapshot', data: draft };
}

/** 활성 편집 셀의 DOM 입력을 읽어 낸 값. webview 의 `readActiveCellEdit` 결과. */
export type ActiveCellEdit = Omit<DraftSnapshotInput, 'data' | 'lastSavedSnapshot'>;

/**
 * "지금 화면의 상태" — **커밋되지 않은 활성 셀 입력까지 반영한** 스냅샷과 데이터.
 *
 * `valid: false` 는 활성 셀에 입력이 있는데 draft 로 표현할 수 없다는 뜻이다
 * (json-edit textarea 의 mid-edit invalid JSON 등). 이때 돌려주는 스냅샷/데이터는
 * **커밋된 것**이므로 비교로 dirty 를 판정하면 안 되고, 호출부가 무조건 dirty 로
 * 취급해야 한다.
 */
export interface ActiveDraftState {
    /** dirty 비교에 쓸 `JSON.stringify` 결과. */
    snapshot: string;
    /** 판정에 쓴 상태. `valid: false` 면 커밋된 data 그대로다. */
    data: unknown;
    valid: boolean;
    /**
     * host 의 recovery 엔트리에 **실제로 보낼** 데이터.
     *
     * `data` 와 다른 필드인 이유: `valid: false` 일 때 `data`(=커밋된 것)를 보내면
     * 직전 keystroke 가 남긴 valid draft 를 옛 내용으로 덮어써, 고치려던 유실이
     * invalid 입력 경로에서 되살아난다. 그래서 이때는 **마지막으로 표현 가능했던
     * draft** 를 담고, 그런 것이 없으면 `undefined` 로 둔다 — 호출부는 아무것도
     * 보내지 말고 host 의 기존 recovery 를 그대로 둬야 한다.
     */
    recoveryData?: unknown;
}

/**
 * 저장 응답 / baseline 교체 시점의 dirty 판정과 recovery 스냅샷을 **한 가지
 * 기준**으로 만든다.
 *
 * 편집 중인 셀의 입력은 아직 `data` 에 들어가 있지 않다. 그래서 커밋된 `data` 로
 * 판정하면 두 가지가 동시에 깨진다.
 *
 * 1. **판정**: DOM 에는 값이 남아 있는데 `data` 가 baseline 과 같으면 clean 이
 *    되어, host 가 recovery 엔트리를 비운다 (미커밋 입력의 마지막 사본이 사라짐).
 *    "활성 셀이 있으면 무조건 dirty" 로 때우면 반대로, 값을 바꾸지 않고 셀을
 *    클릭만 해도 저장 뒤 영원히 dirty 로 남는다 — 그 뒤 blur 는 값이 그대로면
 *    `commitCell` 의 `changed` 분기를 타지 않아 dirty 를 다시 계산하지 않는다.
 * 2. **recovery 내용**: dirty 로 남기더라도 `data` 를 보내면 keystroke 마다 보낸
 *    draft 를 **옛 커밋 데이터로 덮어쓴다**. 그 상태에서 패널이 닫히면 입력이
 *    복구되지 않는다.
 *
 * 그래서 DOM 의 draft 를 만들어 판정과 저장 양쪽에 같이 쓴다.
 */
export function resolveActiveDraftState(
    data: unknown,
    active: ActiveCellEdit | null | undefined,
    /**
     * 이 셀에서 마지막으로 표현 가능했던 draft (webview 의 `lastRecoverableDraft`).
     * draft 를 만들 수 없을 때 recovery 로 보낼 최선값이다.
     */
    lastRecoverableDraft?: unknown
): ActiveDraftState {
    const committed = JSON.stringify(data);
    if (!active) { return { snapshot: committed, data, valid: true, recoveryData: data }; }
    const result = buildDraftSnapshot({
        data,
        sheetPath: active.sheetPath,
        rowIdx: active.rowIdx,
        col: active.col,
        rawInputValue: active.rawInputValue,
        arrValues: active.arrValues,
        isJsonEdit: active.isJsonEdit,
        // clean 판정은 호출부가 각자의 baseline(저장 응답 / 새 디스크 baseline)
        // 으로 한다. 여기서는 draft 를 만들기만 한다.
        lastSavedSnapshot: null
    });
    if (result.kind === 'snapshot') {
        return { snapshot: JSON.stringify(result.data), data: result.data, valid: true, recoveryData: result.data };
    }
    return { snapshot: committed, data, valid: false, recoveryData: lastRecoverableDraft };
}
