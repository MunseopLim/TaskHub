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
import { BUILTIN_VARIABLE_NAMES, type BuiltinVariableName } from './builtinVariables';

/**
 * 제안 항목이 **무엇인지**. 화면에 보일 문구가 아니라 종류다.
 *
 * 이 모듈은 `vscode` 에 의존하지 않으므로(`previewRun` · `doctor` 와 같다)
 * `i18n.t` 를 쓸 수 없다 — `t` 는 `vscode.env.language` 를 본다. 그래서 문구를
 * 여기서 만들면 한국어 사용자에게 영어가 그대로 보인다. 종류만 돌려주고
 * `CompletionItem` 을 만드는 자리(extension.ts)에서 `t(ko, en)` 로 옮긴다.
 */
export type VariableCompletionDetail =
    /** 같은 액션의 다른 태스크 id. `taskType` 은 `"type"` 을 못 읽었으면 없다. */
    | { kind: 'task'; taskType?: string }
    /** `${workspaceFolder}` / `${file}` 같은 전역 참조. */
    | { kind: 'builtin'; ref: BuiltinVariableName }
    /** `${env:NAME}` 네임스페이스 또는 실제 환경변수. */
    | { kind: 'environment'; variable?: string }
    /** forEach 본문의 현재 항목 또는 반복 위치. */
    | { kind: 'iteration'; key: 'value' | 'index' | 'number' | 'count' }
    /** 그 태스크 타입이 내는 결과 키. */
    | { kind: 'result'; taskType: string }
    /** `output.capture` 로 정의한 이름. */
    | { kind: 'capture'; taskId: string };

export interface VariableCompletion {
    /** 삽입할 참조 — `pick.paths`. `${}` 는 호출부가 붙인다. */
    name: string;
    /** 어디서 왔는지. 문구가 아니라 종류다 — {@link VariableCompletionDetail} 참조. */
    detail: VariableCompletionDetail;
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

/** 커서가 들어 있는 JSON 문자열이 `"key": "…"` 값이면 그 key를 돌려준다. */
function currentStringProperty(text: string, from: number, offset: number): string | undefined {
    let inString = false;
    let escaped = false;
    let stringStart = -1;
    for (let i = from; i < offset; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === '"') { inString = false; }
        } else if (ch === '"') {
            inString = true;
            stringStart = i;
        }
    }
    if (!inString || stringStart < 0) { return undefined; }
    const match = /"([^"\\]+)"\s*:\s*$/.exec(text.slice(from, stringStart));
    return match?.[1];
}

export interface ReferencePrefix {
    /** 지금 입력 중인 대안에서 커서 앞부분. */
    prefix: string;
    /** 그 대안의 시작 오프셋. */
    start: number;
    /** 그 대안의 끝 오프셋 (커서 이후 부분을 포함). */
    end: number;
}

/**
 * 커서가 `${…}` 안에 있는지 보고, **지금 입력 중인 참조**와 그 시작 오프셋을
 * 돌려준다. `start` 는 자동완성이 대체할 범위의 시작점이기도 하다.
 *
 * 여는 `${` 뒤에 `}` 나 줄바꿈·따옴표가 끼어 있으면 참조 자리가 아니다.
 *
 * **`??` 체인은 대안 하나하나가 참조다** — 마지막 `??` 뒤부터가 지금 입력 중인
 * 것이다. 체인 전체를 돌려주면 두 가지가 한꺼번에 어긋난다.
 *
 * - `${pickFile.path ?? pickFolder.` 의 head 가 `pickFile` 로 읽혀 **엉뚱한
 *   태스크의 키**를 제안한다. 정작 사용자가 치고 있는 `pickFolder` 의 키는
 *   목록에 없다.
 * - 그렇게 뜬 항목을 고르면 `start`(= `${` 바로 뒤)부터 대체되므로 표현식이
 *   통째로 `${pickFile.dir}` 이 된다 — **사용자가 친 뒤쪽 대안이 조용히
 *   사라진다.** 오류도 나지 않아 되돌릴 실마리도 없다.
 *
 * 대안 앞의 공백은 범위에서 뺀다. 런타임(`splitCoalesceAlternatives`)이 대안을
 * 다듬으므로 공백은 사용자가 쓴 서식이고, 대체 범위에 넣으면 항목을 고를 때마다
 * `a.x ??b.y` 로 눌러붙는다.
 *
 * 쪼개는 규칙은 **런타임과 같은 `split('??')`** 이다. `lastIndexOf('??')` 로
 * 뒤에서 찾으면 `?` 가 셋인 오타에서 갈린다 — `a ??? b.x` 를 런타임은
 * `["a", "? b.x"]` 로 읽어 뒤 대안이 영영 안 풀리는데, 뒤에서 찾으면 `b.x` 가
 * 멀쩡한 참조로 보여 **해석되지 않을 것을 제안하게 된다.**
 *
 * `end` 는 **커서 뒤로 이어지는 같은 대안의 끝**이다 (`start <= offset <= end`).
 * 낱말 중간에서 자동완성을 받을 때 쓰는 대체 범위의 상한이다 — `${ask.va|lue}`
 * 에서 이것이 없으면 꼬리가 남아 `${ask.valuelue}` 가 된다. 상한인 이유는
 * 호출부가 후보마다 더 좁힐 수 있기 때문이다 ({@link collectVariableCompletions}
 * 를 쓰는 provider 참고).
 */
export function referencePrefixAt(text: string, offset: number): ReferencePrefix | undefined {
    const open = text.lastIndexOf('${', offset);
    if (open < 0) { return undefined; }
    // 커서가 아직 `${` 를 지나지 않았으면 참조 자리가 아니다. `lastIndexOf` 는
    // 커서 위치에서 시작하는 `${` 도 찾으므로, 막지 않으면 시작점이 커서보다
    // 뒤가 되어 두 범위의 시작이 어긋나고 VS Code 가 항목을 버린다.
    if (open + 2 > offset) { return undefined; }
    // **커서가 `??` 연산자 안이면 제안하지 않는다.** 이 자리에서는 앞쪽
    // `split('??')` 도 뒤쪽 경계 검사도 연산자를 보지 못한다 — `${a.b ?|? c.d}`
    // 의 prefix 는 `a.b ?` 로 읽히고 끝은 커서 다음 칸이라, 무엇을 고르든 대체
    // 범위가 `??` 를 삼켜 **체인이 통째로 리터럴이 된다**(`${a.b c.d}`).
    // 범위만 손봐서는 `${a.output? c.d}` 라는 어중간한 결과가 남을 뿐이므로,
    // 애매한 자리에서는 아무것도 제안하지 않는 편이 낫다.
    if (text[offset - 1] === '?' && text[offset] === '?') { return undefined; }
    const between = text.slice(open + 2, offset);
    if (/[}"\r\n]/.test(between)) { return undefined; }
    const end = alternativeEndAt(text, offset);
    const parts = between.split('??');
    const rest = parts[parts.length - 1];
    if (parts.length === 1) { return { prefix: between, start: open + 2, end }; }
    const lead = rest.length - rest.trimStart().length;
    return { prefix: rest.slice(lead), start: open + 2 + (between.length - rest.length) + lead, end };
}

const WHITESPACE_RE = /\s/;

/**
 * 커서 뒤로 이어지는 **같은 대안**이 어디서 끝나는가. 결과는 커서보다 앞설 수
 * 없다 — VS Code 는 대체 범위가 삽입 범위를 품고 커서를 포함하기를 요구한다.
 *
 * **참조의 끝을 확신할 수 있을 때만 커서 뒤를 덮는다.** 편집 중인 참조는 닫혀
 * 있지 않은 것이 보통이라(JSON 문자열 안에서는 `${` 가 자동으로 닫히지 않는다),
 * 커서 뒤 글자가 참조의 미완성 속성인지 **누락된 `}` 뒤의 사용자 인자**인지
 * 판별할 정보가 없는 자리가 생긴다. `"cp ${gen.|report.html dist/"` 가 그것이다 —
 * `report.html` 을 덮으면 항목을 고르는 순간 사용자의 인자가 사라진다.
 *
 * 그래서 종결자를 두 부류로 나눈다.
 *
 * - **확신 있는 종결자**: `}` · `"` · 줄바꿈 · `??`. 여기까지 덮는다. JSON 문자열
 *   안에 날 줄바꿈이 있다는 것은 문자열이 닫히지 않았다는 뜻이므로 줄바꿈도
 *   확신에 넣는다.
 * - **그 밖의 공백**: 뒤에 `??` 가 오면 대안이 거기서 끝나는 것이 확실하므로
 *   인정하고, 아니면 **커서로 죈다**. 확신 있는 종결자를 못 만난 채 문서 끝에
 *   닿을 때도 마찬가지다.
 *
 * 죄면 꼬리가 붙어 남지만(`${gen.outputDirreport.html dist/`) **아무것도 잃지
 * 않는다.** 눈에 띄고 무엇을 지울지 명확한 지저분함이, 알아채기 어려운 손실보다
 * 싸다는 판단이다. 반대 정책(공백에서 무조건 멈추기)은 `??` 체인 편집을 통째로
 * 후퇴시키기까지 한다 — `${a.b|c ?? d.e}` 는 `}` 가 `??` 뒤에 있어 스캔이 공백에서
 * 먼저 멈추기 때문이다.
 *
 * 공백 판정은 정규식으로 한다 — `??` 앞에 IME 가 넣은 U+00A0 같은 것까지 잡아야
 * 항목을 고를 때 `a.value?? d.e` 로 눌러붙지 않는다.
 */
function alternativeEndAt(text: string, offset: number): number {
    for (let i = offset; i < text.length; i++) {
        const ch = text[i];
        // 줄바꿈은 WHITESPACE_RE 에도 걸리므로 **공백 분기보다 먼저** 본다.
        if (ch === '}' || ch === '"' || ch === '\n' || ch === '\r') { return i; }
        if (ch === '?' && text[i + 1] === '?') { return i; }
        if (WHITESPACE_RE.test(ch)) {
            let j = i;
            while (j < text.length && WHITESPACE_RE.test(text[j])) { j++; }
            return (text[j] === '?' && text[j + 1] === '?') ? i : offset;
        }
    }
    return offset;
}

/**
 * 커서 위치에서 제안할 참조 목록.
 *
 * `prefix` 에 `.` 이 있으면 그 앞을 태스크 id 로 보고 **그 태스크의 결과 키**를,
 * 없으면 같은 액션의 다른 태스크 **id** 와 전역 참조를 낸다. `??` 체인이면
 * `referencePrefixAt` 이 이미 지금 입력 중인 대안만 잘라 주므로, 여기서는
 * 평범한 참조와 똑같이 다룬다.
 */
export function collectVariableCompletions(
    text: string,
    offset: number,
    environment: NodeJS.ProcessEnv = process.env
): VariableCompletion[] {
    const ref = referencePrefixAt(text, offset);
    if (!ref) { return []; }

    const scope = enclosingTasksArray(text, offset);
    if (!scope) { return []; }
    const tasks = topLevelObjects(text, scope.start + 1, scope.end);

    const cursorTask = tasks.find(s => offset >= s.start && offset <= s.end);
    const currentProperty = cursorTask ? currentStringProperty(text, cursorTask.start, offset) : undefined;
    // 소스 배열과 task-level when은 반복이 시작되기 전에 해석되므로 each가 없다.
    const inForEachTask = !!cursorTask
        && /"forEach"\s*:/.test(cursorTask.text)
        && currentProperty !== 'forEach'
        && currentProperty !== 'var';
    const dot = ref.prefix.indexOf('.');

    if (ref.prefix.startsWith('env:')) {
        return Object.keys(environment)
            .filter(name => typeof environment[name] === 'string')
            .sort((a, b) => a.localeCompare(b))
            .map(name => ({
                name: `env:${name}`,
                detail: { kind: 'environment' as const, variable: name },
            }));
    }

    if (dot < 0) {
        const items: VariableCompletion[] = [];
        // 현재 task도 내장 이름의 소유권 판정에는 포함한다. 자기 자신은 결과
        // 참조로 제안하지 않지만, runtime/Preview/Doctor가 동명 task 때문에
        // bare 내장 폴백을 막는 것과 자동완성이 같은 계약을 써야 한다.
        const declaredTaskIds = new Set<string>();
        for (const slice of tasks) {
            const id = firstStringField(slice.text, 'id');
            const type = firstStringField(slice.text, 'type');
            if (!id) { continue; }
            declaredTaskIds.add(id);
            if (slice === cursorTask) { continue; }   // 자기 자신은 참조할 수 없다
            items.push({ name: id, detail: { kind: 'task', taskType: type } });
        }
        for (const name of BUILTIN_VARIABLE_NAMES) {
            if (declaredTaskIds.has(name)) { continue; }
            items.push({ name, detail: { kind: 'builtin', ref: name } });
        }
        if (inForEachTask) {
            items.push({ name: 'each', detail: { kind: 'iteration', key: 'value' } });
        }
        items.push({ name: 'env:', detail: { kind: 'environment' } });
        return items;
    }

    const head = ref.prefix.slice(0, dot);
    if (head === 'each' && inForEachTask) {
        return (['value', 'index', 'number', 'count'] as const).map(key => ({
            name: `each.${key}`,
            detail: { kind: 'iteration' as const, key },
        }));
    }
    const target = tasks.find(slice => firstStringField(slice.text, 'id') === head);
    if (!target || target === cursorTask) { return []; }
    const type = firstStringField(target.text, 'type');
    if (!type) { return []; }

    // 결과 키는 시뮬레이션에서 얻는다. **키 집합을 가르는 옵션은 빠짐없이
    // 넘겨야 한다** — 빠뜨리면 실재하는 참조를 제안하지 못한다.
    //
    // - `canPickMany` (quickPick, **task 최상위 필드**): 이것만이 `${id.values}`
    //   를 만든다. 다중 선택 액션에서 그 참조가 제안되지 않던 원인이다.
    // - `canSelectMany` (file/folderDialog, **`options` 안**): 결과 개수만 바꾸고
    //   키 목록에는 영향이 없지만, 나중에 옵션에 따라 키가 갈리더라도 따라가도록
    //   같은 입력을 넘겨 둔다.
    //
    // 두 옵션이 사는 자리가 다른 것은 런타임을 그대로 따른 것이다
    // (`handleQuickPick` 은 `task.canPickMany`, 다이얼로그는 `task.options`).
    //
    // `passTheResultToNextTask` 는 반드시 함께 넘긴다 — shell/command 는 이
    // 플래그가 없으면 출력을 캡처하지 않아 `${id.output}` 이 해석되지 않는다.
    // 시뮬레이션이 그 규칙을 이미 알고 있으므로, 그대로 넘기면 **해석되지 않을
    // 참조를 제안하지 않는** 동작이 공짜로 따라온다(Doctor 의
    // `output.not-captured` 와 같은 기준).
    const many = /"canSelectMany"\s*:\s*true/.test(target.text);
    const pickMany = /"canPickMany"\s*:\s*true/.test(target.text);
    const captured = /"passTheResultToNextTask"\s*:\s*true/.test(target.text);
    const repeated = /"forEach"\s*:/.test(target.text);
    let simulated: Record<string, unknown>;
    try {
        simulated = (simulateTaskResult({
            id: head,
            type,
            canPickMany: pickMany,
            forEach: repeated ? ['<item>'] : undefined,
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
        detail: captures.includes(key)
            ? { kind: 'capture' as const, taskId: head }
            : { kind: 'result' as const, taskType: type },
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
