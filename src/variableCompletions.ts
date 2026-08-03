/**
 * `actions.json` 안의 `${…}` 참조 자동완성.
 *
 * 스키마는 **키**만 제안할 수 있다. `${pick.paths}` 는 값 문자열 **안**에 있고
 * 무엇이 유효한지는 같은 액션의 다른 태스크가 무슨 타입이냐에 달렸으므로,
 * JSON 스키마로는 표현할 자리가 없다 — 그래서 `canSelectMany` 는 제안되는데
 * 정작 그 결과인 `.paths` 는 아무 데서도 보이지 않았다.
 *
 * 편집 중인 파일은 대개 **유효한 JSON 이 아니다**(따옴표를 막 연 상태 등).
 * 그래서 `JSON.parse` 에 기대지 않고, 중괄호/문자열 상태만 따라가는 스캐너로
 * 커서를 둘러싼 액션과 태스크 조각을 찾는다.
 *
 * 결과 키는 {@link simulateTaskResult} 에서 그대로 얻는다 — Preview Run · Doctor
 * 와 같은 출처를 쓰므로, 태스크에 결과 키가 하나 늘면 자동완성도 같이 는다.
 * 이 모듈은 `vscode` 에 의존하지 않는다(순수 함수).
 */

import { simulateTaskResult } from './previewRun';

export interface VariableCompletion {
    /** 삽입할 참조 — `pick.paths`. `${}` 는 호출부가 붙인다. */
    name: string;
    /** 어디서 왔는지 — `fileDialog task 'pick'`. */
    detail: string;
}

/** 스캐너가 찾아낸 조각 하나. */
interface Slice {
    start: number;
    end: number;
    text: string;
}

/**
 * `text` 의 `from` 위치부터 시작하는 `{`…`}` 블록들을 깊이 1 단위로 끊는다.
 * 문자열·이스케이프 안의 괄호는 세지 않는다.
 */
function topLevelObjects(text: string, from = 0, to = text.length): Slice[] {
    const slices: Slice[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = from; i < to; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') {
            if (depth === 0) { start = i; }
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                slices.push({ start, end: i + 1, text: text.slice(start, i + 1) });
                start = -1;
            } else if (depth < 0) {
                // 앞이 잘린 문서. 더 볼 것이 없다.
                return slices;
            }
        }
    }
    // 아직 닫히지 않은 블록(편집 중)도 커서가 그 안에 있을 수 있으므로 넘긴다.
    if (depth > 0 && start >= 0) {
        slices.push({ start, end: to, text: text.slice(start, to) });
    }
    return slices;
}

/**
 * `open` 위치의 `[` 와 짝이 되는 `]` 다음 위치. 짝이 없으면(편집 중) 문서 끝.
 */
function matchingBracketEnd(text: string, open: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '[') { depth++; }
        else if (ch === ']') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return text.length;
}

/**
 * 커서를 품은 **가장 안쪽** `tasks` 배열의 범위.
 *
 * 액션은 `children` 으로 겹칠 수 있다(폴더). 바깥 객체를 액션으로 보고 첫
 * `"tasks"` 를 집으면, 폴더의 **두 번째 자식**을 편집할 때 첫 번째 자식의
 * 태스크가 제안된다 — 참조할 수 없는 id 를 권하는 셈이다. 겹친 것 중 가장
 * 늦게 시작한 것이 곧 가장 안쪽이다.
 */
function enclosingTasksArray(text: string, offset: number): { start: number; end: number } | undefined {
    let best: { start: number; end: number } | undefined;
    for (const m of text.matchAll(/"tasks"\s*:\s*\[/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        const end = matchingBracketEnd(text, open);
        if (offset > open && offset <= end && (!best || open > best.start)) {
            best = { start: open, end };
        }
    }
    return best;
}

function firstStringField(text: string, key: string): string | undefined {
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`).exec(text);
    return m ? m[1] : undefined;
}

/**
 * 커서가 `${…}` 안에 있는지 보고, `${` 와 커서 사이의 글자를 돌려준다.
 *
 * 여는 `${` 뒤에 `}` 나 줄바꿈·따옴표가 끼어 있으면 참조 자리가 아니다.
 */
export function referencePrefixAt(text: string, offset: number): { prefix: string; start: number } | undefined {
    const open = text.lastIndexOf('${', offset);
    if (open < 0) { return undefined; }
    const between = text.slice(open + 2, offset);
    if (/[}"\r\n]/.test(between)) { return undefined; }
    return { prefix: between, start: open + 2 };
}

/**
 * 커서 위치에서 제안할 참조 목록.
 *
 * `prefix` 에 `.` 이 있으면 그 앞을 태스크 id 로 보고 **그 태스크의 결과 키**를,
 * 없으면 같은 액션의 다른 태스크 **id** 와 전역 참조를 낸다.
 */
export function collectVariableCompletions(text: string, offset: number): VariableCompletion[] {
    const ref = referencePrefixAt(text, offset);
    if (!ref) { return []; }

    const scope = enclosingTasksArray(text, offset);
    if (!scope) { return []; }
    const tasks = topLevelObjects(text, scope.start + 1, scope.end);

    const cursorTask = tasks.find(s => offset >= s.start && offset <= s.end);
    const dot = ref.prefix.indexOf('.');

    if (dot < 0) {
        const items: VariableCompletion[] = [];
        for (const slice of tasks) {
            if (slice === cursorTask) { continue; }   // 자기 자신은 참조할 수 없다
            const id = firstStringField(slice.text, 'id');
            const type = firstStringField(slice.text, 'type');
            if (!id) { continue; }
            items.push({ name: id, detail: type ? `${type} task` : 'task' });
        }
        items.push({ name: 'workspaceFolder', detail: 'workspace folder path' });
        items.push({ name: 'extensionPath', detail: 'TaskHub install path' });
        return items;
    }

    const head = ref.prefix.slice(0, dot);
    const target = tasks.find(slice => firstStringField(slice.text, 'id') === head);
    if (!target || target === cursorTask) { return []; }
    const type = firstStringField(target.text, 'type');
    if (!type) { return []; }

    // 결과 키는 시뮬레이션에서 얻는다. `canSelectMany` 는 다중 선택 다이얼로그의
    // 결과 개수만 바꾸므로 키 목록에는 영향이 없지만, 같은 입력을 넘겨 두면
    // 나중에 옵션에 따라 키가 갈리더라도 따라간다.
    //
    // `passTheResultToNextTask` 는 반드시 함께 넘긴다 — shell/command 는 이
    // 플래그가 없으면 출력을 캡처하지 않아 `${id.output}` 이 해석되지 않는다.
    // 시뮬레이션이 그 규칙을 이미 알고 있으므로, 그대로 넘기면 **해석되지 않을
    // 참조를 제안하지 않는** 동작이 공짜로 따라온다(Doctor 의
    // `output.not-captured` 와 같은 기준).
    const many = /"canSelectMany"\s*:\s*true/.test(target.text);
    const captured = /"passTheResultToNextTask"\s*:\s*true/.test(target.text);
    let simulated: Record<string, unknown>;
    try {
        simulated = (simulateTaskResult({
            id: head,
            type,
            passTheResultToNextTask: captured,
            options: many ? { canSelectMany: true } : undefined,
        } as any) ?? {}) as Record<string, unknown>;
    } catch {
        return [];
    }
    const keys = Object.keys(simulated);

    // 캡처 이름은 **결과에 문자열 `output` 이 있을 때만** 낸다 — 런타임이
    // 캡처를 적용하는 조건 그대로다(`executeSingleTask`: "Capture only makes
    // sense when the result carries a string `output` property"). 실질적으로
    // `stringManipulation` 과 `passTheResultToNextTask: true` 인 shell/command 다.
    //
    // 타입 이름으로 가르지 않는 이유: `fileDialog` 에 `output.capture` 를 적어 둔
    // 액션에서 `${pick.version}` 이 제안되지만 런타임은 그 변수를 만들지 않는다.
    // 시뮬레이션을 기준으로 두면 그 규칙이 한 곳에만 있고, 나중에 문자열 출력을
    // 내는 타입이 늘어도 따라온다.
    const captures = typeof simulated.output === 'string' ? capturedNames(target.text) : [];
    return [...keys, ...captures].map(key => ({
        name: `${head}.${key}`,
        detail: captures.includes(key) ? `captured from '${head}'` : `${type} result`,
    }));
}

/**
 * `output.capture` 로 정의된 이름들. 캡처는 결과 키와 나란히 참조되므로
 * (`${build.version}`) 함께 제안한다.
 */
function capturedNames(taskText: string): string[] {
    const outputAt = taskText.indexOf('"output"');
    if (outputAt < 0) { return []; }
    const names: string[] = [];
    for (const m of taskText.slice(outputAt).matchAll(/"name"\s*:\s*"([^"\\]+)"/g)) {
        names.push(m[1]);
    }
    return names;
}
