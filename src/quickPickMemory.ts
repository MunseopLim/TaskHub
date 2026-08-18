/** QuickPick의 마지막 선택을 workspace별·action/task별로 기억한다. */

export const QUICK_PICK_MEMORY_MAX_ENTRIES = 100;
export const QUICK_PICK_MEMORY_MAX_TOTAL_CHARS = 64 * 1024;
/** @deprecated 이름 호환용. 실제 상한은 scope key와 label을 합친 문자 수다. */
export const QUICK_PICK_MEMORY_MAX_TOTAL_LABEL_CHARS = QUICK_PICK_MEMORY_MAX_TOTAL_CHARS;
const STATE_KEY = 'taskhub.quickPickSelections';
const MAX_LABELS_PER_ENTRY = 100;
const MAX_LABEL_LENGTH = 4096;

interface MementoLike {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

interface QuickPickMemoryContext {
    workspaceState: MementoLike;
}

export interface RememberedQuickPickSelection {
    label: string;
    /** 명시한 QuickPick item id. label 변경·중복과 무관한 정체성이다. */
    itemId?: string;
    /** 목록 밖에서 직접 입력한 값인지. 삭제된 정적 항목과 구분한다. */
    custom: boolean;
    /** 같은 label이 여러 개일 때 원래 항목을 다시 찾기 위한 목록 위치. */
    index?: number;
}

export interface QuickPickSelectionEntry {
    selections: RememberedQuickPickSelection[];
    at: number;
}

export type QuickPickSelectionMap = Record<string, QuickPickSelectionEntry>;

let memoryContext: QuickPickMemoryContext | undefined;
let memoryMigration: Promise<void> | undefined;

/** 활성화 시 저장소를 연결한다. 테스트가 복원할 수 있도록 이전 값을 돌려준다. */
export function initQuickPickMemory(
    context: QuickPickMemoryContext | undefined
): QuickPickMemoryContext | undefined {
    const previous = memoryContext;
    memoryContext = context;
    memoryMigration = context ? migrateStoredQuickPickSelections(context.workspaceState) : undefined;
    return previous;
}

/** 같은 task id를 쓰는 서로 다른 action끼리 선택 기억이 섞이지 않게 한다. */
export function quickPickSelectionScope(task: { id?: unknown; actionId?: unknown }): string {
    const actionId = typeof task.actionId === 'string' ? task.actionId : '';
    const taskId = typeof task.id === 'string' ? task.id : '';
    // 구분자를 이어 붙이면 (a/b,c)와 (a,b/c)가 충돌한다.
    return JSON.stringify([actionId, taskId]);
}

function isCurrentSelectionScope(scope: string): boolean {
    try {
        const parsed = JSON.parse(scope);
        return Array.isArray(parsed)
            && parsed.length === 2
            && parsed.every(value => typeof value === 'string')
            && JSON.stringify(parsed) === scope;
    } catch {
        return false;
    }
}

function readSelectionMap(memento: MementoLike): QuickPickSelectionMap {
    const raw = memento.get<unknown>(STATE_KEY);
    const result: QuickPickSelectionMap = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return result; }
    for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
        // 0.7.33의 첫 개발 빌드는 `actionId/taskId`를 key로 썼다. 구분자가
        // 충돌할 뿐 아니라 민감 label을 저장하던 형식이므로 읽거나 보존하지
        // 않는다. 현재 JSON pair 형식만 통과시킨다.
        if (!isCurrentSelectionScope(scope)) { continue; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { continue; }
        const current = (value as Partial<QuickPickSelectionEntry>).selections;
        // 0.7.33 개발 빌드의 label-only 형식은 정적 선택으로만 읽는다. custom
        // 여부를 추측하지 않아 삭제된 항목이 직접 입력값으로 되살아나지 않는다.
        const legacyLabels = (value as { labels?: unknown }).labels;
        const selections: unknown = Array.isArray(current)
            ? current
            : (Array.isArray(legacyLabels)
                ? legacyLabels.map(label => ({ label, custom: false }))
                : undefined);
        const at = (value as Partial<QuickPickSelectionEntry>).at;
        if (!Array.isArray(selections)
            || selections.length === 0
            || selections.length > MAX_LABELS_PER_ENTRY
            || !selections.every(selection => {
                if (!selection || typeof selection !== 'object' || Array.isArray(selection)) { return false; }
                const item = selection as Partial<RememberedQuickPickSelection>;
                return typeof item.label === 'string'
                    && item.label.length <= MAX_LABEL_LENGTH
                    && (item.itemId === undefined
                        || (typeof item.itemId === 'string'
                            && item.itemId.length > 0
                            && item.itemId.length <= MAX_LABEL_LENGTH))
                    && typeof item.custom === 'boolean'
                    && (item.index === undefined
                        || (Number.isInteger(item.index) && (item.index as number) >= 0));
            })) {
            continue;
        }
        result[scope] = {
            selections: (selections as RememberedQuickPickSelection[]).map(selection => ({ ...selection })),
            at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
        };
    }
    return pruneQuickPickSelections(result);
}

async function migrateStoredQuickPickSelections(memento: MementoLike): Promise<void> {
    const raw = memento.get<unknown>(STATE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return; }
    const migrated = readSelectionMap(memento);
    if (JSON.stringify(raw) === JSON.stringify(migrated)) { return; }
    try {
        await Promise.resolve(memento.update(STATE_KEY, migrated));
    } catch {
        // 편의 상태의 마이그레이션 실패가 확장 활성화를 막으면 안 된다.
    }
}

export function pruneQuickPickSelections(
    map: QuickPickSelectionMap,
    max: number = QUICK_PICK_MEMORY_MAX_ENTRIES
): QuickPickSelectionMap {
    if (max <= 0) { return Object.create(null); }
    const entries = Object.entries(map)
        .sort((a, b) => (b[1].at - a[1].at) || a[0].localeCompare(b[0]));
    const kept: typeof entries = [];
    let totalChars = 0;
    for (const entry of entries) {
        if (kept.length >= max) { break; }
        const next = entry[0].length
            + entry[1].selections.reduce(
                (sum, selection) => sum + selection.label.length + (selection.itemId?.length ?? 0),
                0
            );
        if (totalChars + next > QUICK_PICK_MEMORY_MAX_TOTAL_CHARS) { continue; }
        kept.push(entry);
        totalChars += next;
    }
    return Object.fromEntries(kept);
}

export function recallQuickPickSelection(
    task: { id?: unknown; actionId?: unknown }
): RememberedQuickPickSelection[] | undefined {
    if (!memoryContext) { return undefined; }
    const entry = readSelectionMap(memoryContext.workspaceState)[quickPickSelectionScope(task)];
    return entry ? entry.selections.map(selection => ({ ...selection })) : undefined;
}

/** 저장 실패나 지나치게 큰 선택은 실제 action 실행을 실패시키지 않는다. */
export async function rememberQuickPickSelection(
    task: { id?: unknown; actionId?: unknown },
    selections: readonly RememberedQuickPickSelection[]
): Promise<void> {
    if (!memoryContext
        || selections.length === 0
        || selections.length > MAX_LABELS_PER_ENTRY
        || selections.some(selection => typeof selection?.label !== 'string'
            || selection.label.length > MAX_LABEL_LENGTH
            || (selection.itemId !== undefined
                && (typeof selection.itemId !== 'string'
                    || selection.itemId.length === 0
                    || selection.itemId.length > MAX_LABEL_LENGTH))
            || typeof selection.custom !== 'boolean'
            || (selection.index !== undefined
                && (!Number.isInteger(selection.index) || selection.index < 0)))
        || selections.reduce(
            (sum, selection) => sum + selection.label.length + (selection.itemId?.length ?? 0),
            0
        )
            > QUICK_PICK_MEMORY_MAX_TOTAL_CHARS) {
        return;
    }
    const context = memoryContext;
    await memoryMigration;
    if (!context || memoryContext !== context) { return; }
    const map = readSelectionMap(context.workspaceState);
    map[quickPickSelectionScope(task)] = {
        selections: selections.map(selection => ({ ...selection })),
        at: Date.now(),
    };
    try {
        await Promise.resolve(context.workspaceState.update(
            STATE_KEY,
            pruneQuickPickSelections(map)
        ));
    } catch {
        // 편의 기능의 저장 실패가 action 자체를 실패시키면 안 된다.
    }
}

/** 민감값을 쓰게 된 task의 과거 기억도 남겨 두지 않는다. */
export async function forgetQuickPickSelection(
    task: { id?: unknown; actionId?: unknown }
): Promise<void> {
    if (!memoryContext) { return; }
    const context = memoryContext;
    await memoryMigration;
    if (!context || memoryContext !== context) { return; }
    const map = readSelectionMap(context.workspaceState);
    const scope = quickPickSelectionScope(task);
    delete map[scope];
    try {
        // 현재 scope가 없더라도 update한다. readSelectionMap이 제거한 구형
        // `action/task` key와 oversized entry까지 민감 실행 시 확실히 지운다.
        await Promise.resolve(context.workspaceState.update(
            STATE_KEY,
            pruneQuickPickSelections(map)
        ));
    } catch {
        // 편의 상태 정리 실패가 action 실행을 실패시키지는 않는다.
    }
}

/** 현재 워크스페이스에 저장된 QuickPick 선택을 모두 지우고 scope 수를 돌려준다. */
export async function clearQuickPickSelections(): Promise<number> {
    if (!memoryContext) { return 0; }
    const context = memoryContext;
    await memoryMigration;
    if (!context || memoryContext !== context) { return 0; }
    const count = Object.keys(readSelectionMap(context.workspaceState)).length;
    await Promise.resolve(context.workspaceState.update(STATE_KEY, undefined));
    return count;
}
