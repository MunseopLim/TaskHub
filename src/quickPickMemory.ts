/** QuickPick의 마지막 선택을 workspace별·action/task별로 기억한다. */

export const QUICK_PICK_MEMORY_MAX_ENTRIES = 100;
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

interface QuickPickSelectionEntry {
    labels: string[];
    at: number;
}

type QuickPickSelectionMap = Record<string, QuickPickSelectionEntry>;

let memoryContext: QuickPickMemoryContext | undefined;

/** 활성화 시 저장소를 연결한다. 테스트가 복원할 수 있도록 이전 값을 돌려준다. */
export function initQuickPickMemory(
    context: QuickPickMemoryContext | undefined
): QuickPickMemoryContext | undefined {
    const previous = memoryContext;
    memoryContext = context;
    return previous;
}

/** 같은 task id를 쓰는 서로 다른 action끼리 선택 기억이 섞이지 않게 한다. */
export function quickPickSelectionScope(task: { id?: unknown; actionId?: unknown }): string {
    const actionId = typeof task.actionId === 'string' ? task.actionId : '';
    const taskId = typeof task.id === 'string' ? task.id : '';
    return `${actionId}/${taskId}`;
}

function readSelectionMap(memento: MementoLike): QuickPickSelectionMap {
    const raw = memento.get<unknown>(STATE_KEY);
    const result: QuickPickSelectionMap = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return result; }
    for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { continue; }
        const labels = (value as Partial<QuickPickSelectionEntry>).labels;
        const at = (value as Partial<QuickPickSelectionEntry>).at;
        if (!Array.isArray(labels)
            || labels.length === 0
            || labels.length > MAX_LABELS_PER_ENTRY
            || !labels.every(label => typeof label === 'string' && label.length <= MAX_LABEL_LENGTH)) {
            continue;
        }
        result[scope] = { labels: [...labels], at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
    }
    return result;
}

export function pruneQuickPickSelections(
    map: QuickPickSelectionMap,
    max: number = QUICK_PICK_MEMORY_MAX_ENTRIES
): QuickPickSelectionMap {
    if (max <= 0) { return Object.create(null); }
    const entries = Object.entries(map);
    if (entries.length <= max) { return map; }
    entries.sort((a, b) => (b[1].at - a[1].at) || a[0].localeCompare(b[0]));
    return Object.fromEntries(entries.slice(0, max));
}

export function recallQuickPickSelection(task: { id?: unknown; actionId?: unknown }): string[] | undefined {
    if (!memoryContext) { return undefined; }
    const entry = readSelectionMap(memoryContext.workspaceState)[quickPickSelectionScope(task)];
    return entry ? [...entry.labels] : undefined;
}

/** 저장 실패나 지나치게 큰 선택은 실제 action 실행을 실패시키지 않는다. */
export async function rememberQuickPickSelection(
    task: { id?: unknown; actionId?: unknown },
    labels: readonly string[]
): Promise<void> {
    if (!memoryContext
        || labels.length === 0
        || labels.length > MAX_LABELS_PER_ENTRY
        || labels.some(label => typeof label !== 'string' || label.length > MAX_LABEL_LENGTH)) {
        return;
    }
    const map = readSelectionMap(memoryContext.workspaceState);
    map[quickPickSelectionScope(task)] = { labels: [...labels], at: Date.now() };
    try {
        await Promise.resolve(memoryContext.workspaceState.update(
            STATE_KEY,
            pruneQuickPickSelections(map)
        ));
    } catch {
        // 편의 기능의 저장 실패가 action 자체를 실패시키면 안 된다.
    }
}
