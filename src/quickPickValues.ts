import { interpolatePipelineVariables } from './pipelineUtils';
import type { QuickPickItem } from './schema';
import type { Translate } from './language';

/**
 * `itemsFromCommand`의 stdout 줄을 QuickPick 항목으로 바꾼다.
 *
 * 기본 `lines` 형식은 기존 동작을 그대로 유지한다. `jsonl`은 외부 명령이
 * 표시 문구와 실행값을 분리할 수 있게 하되, 파싱한 객체를 그대로 spread하지
 * 않는다. 명시한 필드만 새 객체로 옮겨 프로토타입·내부 메타데이터 주입을 막고,
 * 오류에는 원문을 싣지 않아 동적 목록에 민감값이 있어도 알림으로 새지 않는다.
 */
export function parsePickLines(
    lines: readonly string[],
    format: unknown,
    excluded: readonly unknown[],
    t: Translate
): Array<string | QuickPickItem> {
    if (format !== 'lines' && format !== 'jsonl') {
        throw new Error(t(
            `지원하지 않는 itemsFromCommandFormat '${String(format)}'입니다.`,
            `Unsupported itemsFromCommandFormat '${String(format)}'.`
        ));
    }
    const exclude = new Set(excluded.map(value => String(value).trim()));
    if (format === 'lines') {
        return lines.filter(line => !exclude.has(line));
    }

    const items: QuickPickItem[] = [];
    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index];
        if (exclude.has(raw)) { continue; }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(t(
                `itemsFromCommand JSONL ${index + 1}번째 줄이 올바른 JSON이 아닙니다.`,
                `itemsFromCommand JSONL line ${index + 1} is not valid JSON.`
            ));
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(t(
                `itemsFromCommand JSONL ${index + 1}번째 줄은 객체여야 합니다.`,
                `itemsFromCommand JSONL line ${index + 1} must be an object.`
            ));
        }
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.label !== 'string' || candidate.label.length === 0) {
            throw new Error(t(
                `itemsFromCommand JSONL ${index + 1}번째 줄에는 비어 있지 않은 문자열 label이 필요합니다.`,
                `itemsFromCommand JSONL line ${index + 1} requires a non-empty string label.`
            ));
        }
        if (candidate.id !== undefined
            && (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 128)) {
            throw new Error(t(
                `itemsFromCommand JSONL ${index + 1}번째 줄의 id는 1~128자 문자열이어야 합니다.`,
                `itemsFromCommand JSONL line ${index + 1} id must be a string of 1 to 128 characters.`
            ));
        }
        for (const field of ['description', 'detail'] as const) {
            if (candidate[field] !== undefined && typeof candidate[field] !== 'string') {
                throw new Error(t(
                    `itemsFromCommand JSONL ${index + 1}번째 줄의 ${field}은 문자열이어야 합니다.`,
                    `itemsFromCommand JSONL line ${index + 1} ${field} must be a string.`
                ));
            }
        }
        if (candidate.value !== undefined
            && typeof candidate.value !== 'string'
            && (!Array.isArray(candidate.value)
                || !candidate.value.every(value => typeof value === 'string'))) {
            throw new Error(t(
                `itemsFromCommand JSONL ${index + 1}번째 줄의 value는 문자열 또는 문자열 배열이어야 합니다.`,
                `itemsFromCommand JSONL line ${index + 1} value must be a string or an array of strings.`
            ));
        }
        if (candidate.args !== undefined
            && typeof candidate.args !== 'string'
            && (!Array.isArray(candidate.args)
                || !candidate.args.every(value => typeof value === 'string'))) {
            throw new Error(t(
                `itemsFromCommand JSONL ${index + 1}번째 줄의 args는 문자열 또는 문자열 배열이어야 합니다.`,
                `itemsFromCommand JSONL line ${index + 1} args must be a string or an array of strings.`
            ));
        }
        if (exclude.has(candidate.label)
            || (typeof candidate.id === 'string' && exclude.has(candidate.id))) {
            continue;
        }
        const item: QuickPickItem = { label: candidate.label };
        if (typeof candidate.id === 'string') { item.id = candidate.id; }
        if (typeof candidate.description === 'string') { item.description = candidate.description; }
        if (typeof candidate.detail === 'string') { item.detail = candidate.detail; }
        if (typeof candidate.value === 'string' || Array.isArray(candidate.value)) {
            item.value = candidate.value as string | string[];
        }
        if (typeof candidate.args === 'string' || Array.isArray(candidate.args)) {
            item.args = typeof candidate.args === 'string'
                ? [candidate.args]
                : candidate.args as string[];
        }
        items.push(item);
    }
    return items;
}

/**
 * `quickPick` 결과.
 *
 * `label` 은 **보이는 문구**, `value` 는 **명령에 들어가는 값**이다. 항목에
 * `value` 를 적지 않으면 둘이 같으므로 예전 액션은 그대로 동작한다.
 */
export interface QuickPickResult {
    /**
     * 고른 항목의 `value`(적지 않았으면 label). 배열이면 `args` 원소나
     * `command` 토큰 자리에서 **인자 여러 개**로 펼쳐진다 — 빈 배열은 아무
     * 인자도 만들지 않으므로 "이 선택지에서는 옵션을 붙이지 않는다" 가 된다.
     */
    value: string | string[];
    /** 고른 항목의 표시 문구. `value` 매핑과 무관하게 **항상 문자열**이다. */
    label: string;
    /** 고른 표시 문구의 손실 없는 배열. label에 쉼표가 있어도 경계가 보존된다. */
    labelList: string[];
    /** 고른 값 전체를 평평하게 편 배열. 인자 확장용. */
    valueList: string[];
    /**
     * 태스크가 별도로 매핑한 command 인자. 정적 목록 중 하나라도 `args`를
     * 선언하거나 동적 목록 형식이 JSONL이면 항상 생긴다. 선택 항목에 매핑이
     * 없거나 직접 입력이면 빈 배열이다. `${taskId.args}`를 `command.args` 원소
     * 하나로 두면 배열의 각 값이 argv 한 칸씩 된다.
     */
    args?: string[];
    /** 단일 선택이 목록 밖 직접 입력이었는지. History 재실행 식별에도 쓴다. */
    custom: boolean;
    /** `canPickMany` 일 때만: 고른 값 전체를 쉼표로 이은 문자열. */
    values?: string;
    /** `canPickMany` 일 때만: 고른 표시 문구 전체를 쉼표로 이은 문자열. */
    labels?: string;
    /** History/기억 복원용 내부 식별자. actions 변수 API로 사용하지 않는다. */
    _itemId?: string;
    /** id가 없는 자리는 null로 보존하는 내부 식별자 배열. */
    _itemIds?: Array<string | null>;
}

/** `showQuickPick` 이 돌려주는 항목 객체에 매핑된 값을 얹어 둔다. */
export interface QuickPickEntry {
    label: string;
    description?: string;
    detail?: string;
    taskHubValue: string | string[];
    /** actions.json 항목의 별도 command 인자 매핑. */
    taskHubArgs?: string[];
    /** `allowCustom`가 입력 중에 만든 임시 항목. */
    taskHubCustom?: boolean;
    /** 기억 복원에서 같은 label 항목을 구분하는 원래 목록 위치. */
    taskHubSourceIndex?: number;
    /** actions.json 항목에 명시한 안정 id. */
    taskHubItemId?: string;
}

/**
 * 항목이 명령에 넘길 값. 문자열 항목과 `value` 없는 객체 항목은 label 그대로다.
 * 배열은 문자열 원소만 남긴다 — 숫자·객체가 섞이면 무엇을 인자로 넘길지
 * 정의되지 않고, 조용히 `[object Object]` 를 명령에 넣는 것보다 빼는 편이 낫다.
 */
function quickPickItemValue(item: any, label: string): string | string[] {
    if (item && typeof item === 'object') {
        if (typeof item.value === 'string') { return item.value; }
        if (Array.isArray(item.value)) {
            return item.value.filter((entry: any) => typeof entry === 'string');
        }
    }
    return label;
}

/** 항목의 `value`(문자열 또는 문자열 배열)를 원래 모양 그대로 보간한다. */
function interpolateQuickPickItemValue(value: unknown, context: any): unknown {
    if (typeof value === 'string') { return interpolatePipelineVariables(value, context); }
    if (Array.isArray(value)) {
        return value.map(entry =>
            typeof entry === 'string' ? interpolatePipelineVariables(entry, context) : entry);
    }
    return value;
}

export function interpolateQuickPickItems(items: readonly any[], context: any): any[] {
    return items.map(item => {
        if (typeof item === 'string') {
            return interpolatePipelineVariables(item, context);
        }
        return {
            ...item,
            label: item.label ? interpolatePipelineVariables(item.label, context) : item.label,
            description: item.description
                ? interpolatePipelineVariables(item.description, context)
                : item.description,
            detail: item.detail ? interpolatePipelineVariables(item.detail, context) : item.detail,
            value: interpolateQuickPickItemValue(item.value, context),
            args: Array.isArray(item.args)
                ? item.args.map((entry: unknown) => typeof entry === 'string'
                    ? interpolatePipelineVariables(entry, context)
                    : entry)
                : item.args,
        };
    });
}

export function quickPickEntries(items: readonly any[], t: Translate): QuickPickEntry[] {
    const seenIds = new Set<string>();
    return items.map((item: any, index: number) => {
        if (typeof item === 'string') {
            return { label: item, taskHubValue: item, taskHubSourceIndex: index };
        }
        if (item.id !== undefined) {
            if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 128) {
                throw new Error(t('QuickPick 항목 id는 비어 있지 않은 128자 이하의 문자열이어야 합니다.', 'QuickPick item id must be a non-empty string of at most 128 characters.'));
            }
            if (seenIds.has(item.id)) {
                // 동적 JSONL의 id는 환경변수·password 파생 출력일 수도 있다.
                // Doctor는 정적 actions.json의 id를 구체적으로 알려 주지만,
                // 런타임 오류에는 값을 싣지 않아 알림 표면으로 새지 않게 한다.
                throw new Error(t('QuickPick 항목 id가 중복되었습니다.', 'QuickPick item id is duplicated.'));
            }
            seenIds.add(item.id);
        }
        return {
            label: item.label,
            description: item.description,
            detail: item.detail,
            taskHubValue: quickPickItemValue(item, item.label),
            taskHubArgs: Array.isArray(item.args)
                ? item.args.filter((entry: unknown): entry is string => typeof entry === 'string')
                : undefined,
            taskHubSourceIndex: index,
            taskHubItemId: item.id,
        };
    });
}

export function buildQuickPickResult(
    selected: readonly QuickPickEntry[],
    canPickMany: boolean,
    producesArgs: boolean
): QuickPickResult {
    // VS Code 는 넘긴 항목 객체를 그대로 돌려주므로 실행 경로에서는 `taskHubValue`
    // 가 늘 붙어 있다. 그래도 label 로 떨어지는 길을 남기는 것은, 이 값이 없을 때
    // `${pick.value}` 가 `undefined` 가 되어 **`when` 분기가 조용히 어긋나기**
    // 때문이다 — 값이 사라지는 실패는 그 자리에서 드러나지 않는다.
    const entryValue = (entry: QuickPickEntry): string | string[] =>
        entry.taskHubValue !== undefined ? entry.taskHubValue : entry.label;
    const first = selected[0];
    const valueList = selected.flatMap(entry => {
        const value = entryValue(entry);
        return Array.isArray(value) ? value : [value];
    });
    const result: QuickPickResult = {
        value: entryValue(first),
        label: first.label,
        labelList: selected.map(entry => entry.label),
        valueList,
        custom: selected.length === 1 && selected[0].taskHubCustom === true,
    };
    if (producesArgs) {
        result.args = selected.flatMap(entry => entry.taskHubArgs ?? []);
    }
    if (canPickMany) {
        // `values` 는 예전부터 쉼표로 이은 문자열이었다. 매핑을 쓰지 않으면
        // 값이 곧 label 이라 예전과 **같은 문자열**이 나온다.
        result.values = valueList.join(',');
        result.labels = selected.map(entry => entry.label).join(',');
    }
    if (first.taskHubItemId) { result._itemId = first.taskHubItemId; }
    if (selected.some(entry => !!entry.taskHubItemId)) {
        result._itemIds = selected.map(entry => entry.taskHubItemId ?? null);
    }
    return result;
}
