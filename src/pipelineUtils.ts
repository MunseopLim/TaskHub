/**
 * Pure utilities extracted from `extension.ts` for pipeline execution:
 *   - variable interpolation (with sanitation)
 *   - workspace-relative path resolution
 *   - command-line tokenization / shell-argument quoting
 *   - PowerShell / POSIX invocation builders
 *
 * This module has no dependency on the `vscode` API, which makes the helpers
 * easy to unit-test and re-use. Keep anything that needs `vscode.workspace`,
 * `vscode.window`, etc. in `extension.ts`.
 *
 * `extension.ts` re-exports everything here so that existing
 * `import { ... } from './extension'` call sites (including tests) continue to
 * work unchanged.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { OutputCapture, Task, TaskCondition } from './schema';

/** Maximum allowed length of a single interpolated value. */
export const INTERPOLATED_VALUE_MAX_LENGTH = 32 * 1024;

/**
 * Predicate used by `executeShellCommand` to decide whether a newly arrived
 * chunk would push the total captured output past the user-configured limit.
 *
 * Pulled out as a standalone helper so that the off-by-one boundary
 * (`currentBytes + chunkBytes > limitBytes`) can be exercised by unit tests
 * without spawning a real subprocess. Keeping it pure also guards against an
 * accidental `>=` → `>` / `>` → `>=` swap during future edits.
 */
export function wouldExceedCaptureLimit(currentBytes: number, chunkBytes: number, limitBytes: number): boolean {
    return currentBytes + chunkBytes > limitBytes;
}

/**
 * Reserved capture names that would shadow built-in task result properties.
 * Exported so Doctor (`src/doctor.ts`) can validate `output.capture.name`
 * against the *same* list the runtime uses — keeping the two in sync
 * automatically instead of through a mirror copy.
 */
export const RESERVED_CAPTURE_NAMES: ReadonlySet<string> = new Set([
    // `stderr` 는 `shell`/`command` 가 캡처 모드에서 실제로 돌려주는 키다.
    // 캡처 결과는 `result = { ...result, ...captured }` 로 병합되므로, 이 이름을
    // 허용하면 **stdout 에서 뽑은 값이 진짜 stderr 를 조용히 덮는다** — 그
    // stderr 는 Problems 패널로 가는 진단의 입력이기도 하다.
    'output', 'stderr', 'outputDir', 'path', 'dir', 'name', 'fileNameOnly', 'fileExt',
    'value', 'values', 'archivePath', 'confirmed',
    // 프로토타입 오염 이름들. 평범한 객체에 `results['__proto__'] = v` 를 하면
    // **own property 가 만들어지지 않아** 캡처가 조용히 사라진다(결과가 `{}`).
    // 결과 객체를 null-prototype 으로 만들어도 downstream 의 spread / 직렬화가
    // 이 이름을 계속 특수 취급하므로, 이름 자체를 막는 편이 예측 가능하다.
    '__proto__', 'constructor', 'prototype'
]);

/**
 * Task types whose execution shows VS Code modal / quick-pick UI
 * (`inputBox`, `quickPick`, `envPick`, `confirm`, `fileDialog`,
 * `folderDialog`). The runtime serializes these via a prompt mutex
 * when running in a parallel pipeline so two dialogs never race;
 * Doctor warns when one is set to `parallel: true`. Centralized here
 * so the executor and the linter agree on the boundary.
 */
export const INTERACTIVE_TASK_TYPES: ReadonlySet<string> = new Set([
    'inputBox',
    'quickPick',
    'envPick',
    'fileDialog',
    'folderDialog',
    'confirm',
]);

/**
 * Apply one or more capture rules to a task's string output and return a map
 * of `{ name: value }` pairs to be merged into the task's result object.
 *
 * This is a pure function — no I/O, no `vscode` dependency — so it can be
 * unit-tested directly. Silently skips rules whose selector does not match
 * and throws only on configuration errors (e.g. missing `name`, invalid
 * regex, reserved name, duplicate name).
 */
export function applyOutputCapture(
    output: string,
    capture: OutputCapture | OutputCapture[] | undefined
): Record<string, string> {
    if (!capture) { return {}; }
    const rules = Array.isArray(capture) ? capture : [capture];
    const results: Record<string, string> = {};

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') {
            throw new Error('Each capture rule must be an object.');
        }
        const name = rule.name;
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error("Capture rule is missing a non-empty 'name'.");
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new Error(`Capture name '${name}' must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
        }
        if (RESERVED_CAPTURE_NAMES.has(name)) {
            throw new Error(`Capture name '${name}' is reserved and cannot be used.`);
        }
        if (Object.prototype.hasOwnProperty.call(results, name)) {
            throw new Error(`Duplicate capture name '${name}'.`);
        }

        let selected: string | undefined;

        if (typeof rule.regex === 'string' && rule.regex.length > 0) {
            let re: RegExp;
            try {
                const flags = (rule.flags ?? '').replace(/g/g, '');
                re = new RegExp(rule.regex, flags);
            } catch (e: any) {
                throw new Error(`Capture '${name}' has invalid regex: ${e.message}`);
            }
            const m = output.match(re);
            if (m) {
                // Default group: 1 if the pattern has capture groups, otherwise 0
                // (full match). Explicit out-of-range group is silently skipped.
                const defaultGroup = m.length > 1 ? 1 : 0;
                const group = rule.group ?? defaultGroup;
                if (group < 0 || group >= m.length) {
                    selected = undefined;
                } else {
                    selected = m[group];
                }
            }
        } else if (typeof rule.line === 'number' && Number.isInteger(rule.line)) {
            const lines = output.split(/\r?\n/);
            const idx = rule.line < 0 ? lines.length + rule.line : rule.line;
            if (idx >= 0 && idx < lines.length) {
                selected = lines[idx];
            }
        } else {
            selected = output;
        }

        if (selected === undefined) { continue; }
        if (rule.trim) { selected = selected.trim(); }
        results[name] = selected;
    }

    return results;
}

/**
 * Windows 예약 디바이스 이름. 경로 세그먼트로 등장하면 (확장자가 붙어도)
 * 파일이 아니라 디바이스로 해석된다 — `CON`, `NUL.txt` 등.
 */
const WINDOWS_RESERVED_NAME_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)/i;

/**
 * Canonicalize `p` for containment checks: resolve symlinks on the deepest
 * EXISTING ancestor, then re-append the not-yet-existing remainder. The
 * target itself may not exist (about to be written), so a plain realpath
 * would throw — walk up instead.
 */
function canonicalizeForContainment(p: string): string {
    let existing = p;
    const tail: string[] = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) { break; } // filesystem root
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    let canonical: string;
    try {
        canonical = fs.realpathSync.native(existing);
    } catch {
        canonical = existing; // 권한 등으로 실패 시 어휘적 경로 유지
    }
    return tail.length > 0 ? path.join(canonical, ...tail) : canonical;
}

/**
 * Resolve `targetPath` and ensure it lands inside one of the provided workspace roots.
 *
 * Security contract:
 *   - null-byte in the path is rejected.
 *   - Relative paths are resolved against `baseDir` (typically the action's
 *     workspace folder) — NOT `process.cwd()`. This keeps behaviour stable
 *     regardless of how VS Code was launched.
 *   - The final resolved path must be inside at least one `workspaceRoots`
 *     entry, otherwise throws. Containment is judged on symlink-resolved
 *     (realpath) canonical paths, so a symlink/junction inside the workspace
 *     that points outside cannot bypass the check (M10).
 *   - On Windows, reserved device names (`CON`, `NUL`, `COM1`…) in any path
 *     segment are rejected.
 *
 * Known limits: the realpath check is check-time (TOCTOU) — a symlink swapped
 * in after validation but before the write is not detected. 8.3 short names
 * are normalized by `realpathSync.native` only for existing path components.
 *
 * @returns The lexically resolved path (not the canonical one) — callers
 *          write through the path the user configured.
 */
export function resolveWithinWorkspace(
    targetPath: string,
    workspaceRoots: string[],
    baseDir?: string
): string {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('A file path is required.');
    }
    if (/\x00/.test(targetPath)) {
        throw new Error('File path contains a null byte, which is not allowed.');
    }
    const normalizedRoots = workspaceRoots
        .filter(root => typeof root === 'string' && root.length > 0)
        .map(root => path.resolve(root));
    if (normalizedRoots.length === 0) {
        throw new Error('No workspace folder is available to validate the path.');
    }
    // Relative paths must resolve against the action's workspace, NOT process.cwd().
    // Configs with "filePath": "report.txt" would otherwise land in an arbitrary
    // directory determined by how VS Code was launched.
    let resolved: string;
    if (path.isAbsolute(targetPath)) {
        resolved = path.resolve(targetPath);
    } else {
        const base = baseDir && baseDir.length > 0 ? path.resolve(baseDir) : normalizedRoots[0];
        resolved = path.resolve(base, targetPath);
    }
    if (process.platform === 'win32') {
        for (const segment of resolved.split(path.sep)) {
            if (WINDOWS_RESERVED_NAME_RE.test(segment)) {
                throw new Error(
                    `Refusing to access '${resolved}' because it contains the reserved device name '${segment}'.`
                );
            }
        }
    }
    if (!isInsideWorkspaceRoots(resolved, normalizedRoots)) {
        throw new Error(
            `Refusing to access '${resolved}' because it is outside the current workspace folder(s).`
        );
    }
    return resolved;
}

/**
 * 액션이 지정한 경로를 절대 경로로 만든다. **워크스페이스 격리는 하지 않는다.**
 *
 * `zip` / `unzip` 전용이다. 그쪽 경로는 다이얼로그로 고른
 * 위치를 그대로 쓰는 것이 설계이므로(`media/actions_example.json` 의 zip 예제가
 * `folderDialog` 로 고른 폴더를 그 자리에서 압축한다) 워크스페이스 밖을 막을 수
 * 없다. 막아야 하는 것은 격리가 아니라 **상대 경로의 기준점**이었다.
 *
 * 내장 엔진(`createZipArchive` / `extractZipArchive`)은 `path.resolve` 를 그대로 쓰는데,
 * 그 기준은 **extension host 의 `process.cwd()`** 다 — 워크스페이스도 태스크의
 * `cwd` 도 아니고, VS Code 를 어떻게 띄웠는지에 따라 달라지는 값이다. 실측:
 * `"archive": "build.zip"` 이 워크스페이스가 아니라 VS Code 를 실행한 디렉터리에
 * 생겼다. 외부 tool 경로는 자식 프로세스의 cwd 가 기준이라 이 문제가 없었으므로,
 * **같은 태스크가 `tool` 하나로 다른 위치에 파일을 만들고 있었다.**
 *
 * 기준점은 외부 tool 경로와 똑같이 `task.cwd` → 워크스페이스 순이다
 * (스키마의 `cwd` 설명: *"Defaults to ${workspaceFolder}"*). 두 엔진이 같은
 * 규칙을 쓰게 되어 `tool` 유무로 결과가 갈리지 않는다.
 *
 * 외부 tool 경로에서도 **반환값**에는 이것을 적용한다. 그쪽은 자식 프로세스가
 * 알아서 자기 cwd 로 풀지만, 우리가 `${zip.archivePath}` 로 넘겨주는 값이
 * 상대 경로로 남으면 그것을 받은 **다음 태스크**가 자기 기준으로 다시 풀어
 * 서로 다른 파일을 가리킨다 (실측: `tool` 을 쓴 zip 뒤의 unzip 이
 * `Archive not found` 로 실패했고, `tool` 만 지우면 성공했다).
 *
 * `baseDir` 이 비어 있으면(워크스페이스 없이 열린 창) 기준으로 삼을 것이
 * 없으므로 기존 동작인 `path.resolve` 를 유지한다.
 */
export function resolveArchiveTaskPath(targetPath: string, baseDir: string | undefined): string {
    if (typeof targetPath !== 'string' || targetPath.length === 0) { return targetPath; }
    if (path.isAbsolute(targetPath)) { return path.resolve(targetPath); }
    if (baseDir && baseDir.length > 0) { return path.resolve(baseDir, targetPath); }
    return path.resolve(targetPath);
}

/**
 * `resolveWithinWorkspace`의 수용 여부 판정만 떼어낸 dry-run 술어. Preview와
 * Doctor가 런타임과 동일한 규칙(null byte·빈 경로 거부, realpath 정규화,
 * Windows 예약 디바이스명)으로 검사하도록 공유한다 — 규칙이 하나라도 빠지면
 * 그 경로가 Preview에서 안전해 보이다가 런타임에서 거부되는 거짓 음성이 생긴다.
 */
export function isInsideWorkspaceRoots(resolvedPath: string, workspaceRoots: string[]): boolean {
    // 런타임(resolveWithinWorkspace 상단 가드)이 무조건 거부하는 입력
    if (!resolvedPath || typeof resolvedPath !== 'string' || /\x00/.test(resolvedPath)) {
        return false;
    }
    const normalizedRoots = workspaceRoots
        .filter(root => typeof root === 'string' && root.length > 0)
        .map(root => path.resolve(root));
    if (normalizedRoots.length === 0) {
        return false;
    }
    const resolved = path.resolve(resolvedPath);
    if (process.platform === 'win32') {
        for (const segment of resolved.split(path.sep)) {
            if (WINDOWS_RESERVED_NAME_RE.test(segment)) {
                return false;
            }
        }
    }
    const canonicalResolved = canonicalizeForContainment(resolved);
    return normalizedRoots.some(root => {
        const canonicalRoot = canonicalizeForContainment(root);
        const rel = path.relative(canonicalRoot, canonicalResolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

/**
 * Validate and coerce a value about to be substituted into a shell template.
 * Returns `undefined` for null/undefined/objects/arrays (caller should keep
 * the literal `${...}` placeholder). Throws on null byte or length overflow.
 */
export function sanitizeInterpolatedValue(value: unknown): string | undefined {
    if (value === undefined || value === null) { return undefined; }
    let stringValue: string;
    if (typeof value === 'string') {
        stringValue = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        stringValue = String(value);
    } else if (Array.isArray(value)) {
        // 배열은 공백으로 이어 붙인다.
        //
        // 예전에는 `undefined` 를 돌려줬고, 그러면 호출부가 참조를 **리터럴
        // 그대로** 남긴다 — `echo ${pick.paths}` 가 문자 그대로 실행됐다는
        // 뜻이다. 문서는 `${pick.paths}` 를 fileDialog 의 결과 참조로 안내하면서
        // 그것이 `args` 안에서만 동작한다는 말은 하지 않았고, 리터럴이 남아
        // 좋은 자리는 어디에도 없다.
        //
        // 항목을 인용하지는 않는다. 단일 값(`${pick.path}`)도 그대로 넣는 것과
        // 같은 규칙이고, 셸이 아닌 자리(writeFile 내용 · 안내 문구)에 따옴표를
        // 끼워 넣으면 그쪽이 망가진다. 공백이 든 경로를 명령에 넘길 때는
        // `args` 의 배열 확장({@link expandArgTemplate})을 쓴다 — 그쪽은 원소가
        // 각각 argv 한 칸이 되므로 셸이 개입하지 않는다.
        const parts: string[] = [];
        for (const entry of value) {
            const part = sanitizeInterpolatedValue(entry);
            if (part !== undefined) { parts.push(part); }
        }
        stringValue = parts.join(' ');
    } else {
        return undefined;
    }
    if (stringValue.length > INTERPOLATED_VALUE_MAX_LENGTH) {
        throw new Error(
            `Interpolated value exceeds maximum length (${INTERPOLATED_VALUE_MAX_LENGTH} chars).`
        );
    }
    if (/\x00/.test(stringValue)) {
        throw new Error('Interpolated value contains a null byte, which is not allowed.');
    }
    return stringValue;
}

/**
 * Replace `${stepId.property}` / `${stepId}` / `${name}` occurrences in `template`
 * using values from `context`, running each value through `sanitizeInterpolatedValue`.
 * Unknown references are left untouched.
 */
export function interpolatePipelineVariables(template: string, context: any): string {
    if (typeof template !== 'string') { return template; }
    const regex = /\${([^}]+)}/g;
    return template.replace(regex, (match, expression) => {
        const sanitized = sanitizeInterpolatedValue(resolvePipelineReference(expression, context));
        if (sanitized !== undefined) { return sanitized; }
        return match;
    });
}

/**
 * `tool` 값(문자열 또는 OS별 객체)에서 **현재 플랫폼이 실행할 문자열 하나**를
 * 골라 보간한다.
 *
 * **고르는 것이 먼저다.** 예전에는 모든 branch 를 보간한 뒤 실행 직전에 하나를
 * 골랐는데, 보간은 `sanitizeInterpolatedValue` 를 거치며 **NUL 바이트나 길이
 * 초과에서 throw** 한다. 그래서 이 기계에서 절대 실행되지 않을 branch 의 값
 * 하나 때문에 태스크 전체가 실패했다 — 예: macOS 에서 도는 액션의 windows
 * branch 에 `${pick.value}` 가 있고 사용자가 32KB 를 붙여 넣은 경우. 고른 뒤
 * 보간하면 실행될 값만 검사 대상이 된다.
 *
 * **`JSON.stringify → interpolate → JSON.parse` 는 쓰면 안 된다.** 보간된 값이
 * JSON 문자열 안으로 들어가는 순간 그 안의 역슬래시가 escape 로 재해석된다 —
 * `C:\Users\me` 는 파싱 자체가 깨지고, `C:\temp` 는 `\t` 가 탭이 되어 **조용히**
 * 다른 경로가 된다. Windows 경로가 흔한 자리라 반드시 문자열 단위로 보간한다.
 *
 * 현재 플랫폼 branch 가 없으면 {@link getToolCommand} 와 **같은 문구로** throw
 * 한다 — 실패 지점만 앞당겨질 뿐 사용자가 보는 메시지는 그대로다.
 */
export function interpolateToolValue(
    tool: unknown,
    context: any,
    platform: NodeJS.Platform = process.platform
): string {
    const selected = selectPlatformValue(tool, platform);
    if (selected === undefined) {
        throw new Error(`No tool path specified for the current platform (${platform}) in actions.json`);
    }
    return interpolatePipelineVariables(selected, context);
}

/** 상속된 키(`constructor`, `toString` …)를 결과로 오인하지 않도록 own property 만 본다. */
function ownValue(context: any, key: string): unknown {
    if (!context || typeof context !== 'object') { return undefined; }
    return Object.prototype.hasOwnProperty.call(context, key) ? context[key] : undefined;
}

/**
 * `${...}` 안의 표현식 하나를 컨텍스트에서 찾아 **원래 값 그대로** 돌려준다
 * (문자열화·sanitize 전). `interpolatePipelineVariables` 와 **같은 탐색 규칙**을
 * 쓰므로, 보간과 배열 확장이 서로 다른 것을 가리키는 일이 없다.
 *
 * **`output` / `outputDir` 폴백은 bare `${stepId}` 에만 적용한다.**
 * 예전에는 속성이 붙은 참조(`${producer.safe}`)도 그 속성이 없으면 폴백을 탔다.
 * 그래서 capture 규칙이 매칭되지 않아 `safe` 가 만들어지지 않았을 때
 * `${producer.safe}` 가 **검증되지 않은 stdout 전체**로 치환되어 downstream
 * 명령에 들어갔다 — 사용자는 정규식으로 좁힌 값을 받는다고 믿는 자리다.
 * [docs/features.md](../docs/features.md) 의 capture 실패 정책도 "미해결
 * placeholder 로 남음" 이라 적혀 있어 구현만 반대였다.
 *
 * 속성이 붙었는데 그 속성이 없으면 이제 `undefined` 를 돌려주고, 호출부가
 * `${...}` 리터럴을 그대로 남긴다. 오타(`${build.typoKey}`)도 조용히 다른 값이
 * 되는 대신 리터럴로 드러난다. bare 참조의 폴백은 유지된다 — `${producer}` 가
 * 그 태스크의 대표 결과를 뜻하는 것은 문서화된 계약이다.
 */
/**
 * `${a.x ?? b.y}` 의 대안 목록. `??` 가 없으면 null (= 평범한 참조).
 *
 * **`??` 가 있을 때만 다듬는다.** 평범한 참조는 지금까지처럼 한 글자도 건드리지
 * 않는다 — 스키마는 태스크 id 에 공백을 금지하지 않아서, `${ producer.output}`
 * 을 다듬으면 의존성은 `producer` 로 잡히는데 런타임은 `" producer"` 를 찾지
 * 못해 리터럴로 남는다(순서만 잡히고 값은 안 오는 상태). 반대로 `??` 는 사람이
 * 손으로 쓰는 연산자라 `a.x ?? b.y` 처럼 띄어 쓰는 것이 자연스럽다. 두 규칙을
 * 여기 한 곳에 모아 두어야 보간과 의존성 추론이 **같은 것**을 본다.
 */
export function splitCoalesceAlternatives(expression: string): string[] | null {
    if (!expression.includes('??')) { return null; }
    return expression.split('??').map(part => part.trim()).filter(part => part.length > 0);
}

export function resolvePipelineReference(expression: string, context: any): unknown {
    // `??` 는 **먼저 푼 것이 이긴다.** 조건(`when`)으로 꺼진 분기는 결과가 없어
    // undefined 이므로, 살아남은 쪽 값이 자연스럽게 선택된다.
    const alternatives = splitCoalesceAlternatives(expression);
    if (alternatives) {
        for (const alt of alternatives) {
            const value = resolvePipelineReference(alt, context);
            if (value !== undefined) { return value; }
        }
        return undefined;
    }
    const parts = expression.split('.');
    const stepId = parts[0];
    const property = parts.slice(1).join('.');
    // **점이 아예 없을 때만** bare 다. `!property` 로 판정하면 `${producer.}` 처럼
    // 점 뒤가 빈 형태까지 bare 로 새어 들어가 폴백을 타고, "속성을 쓴 참조는
    // 폴백하지 않는다" 는 계약이 오타 하나로 뚫린다.
    const isBare = parts.length === 1;
    // **own property 만 본다.** 컨텍스트가 평범한 객체면 `${constructor.name}` 이
    // `Object`, `${toString.name}` 이 `toString` 으로 "해석"되어 태스크 결과처럼
    // 셸 명령에 들어간다.
    const step = ownValue(context, stepId);
    if (step && property && ownValue(step, property) !== undefined) { return ownValue(step, property); }
    if (isBare && step) {
        if (ownValue(step, 'output') !== undefined) { return ownValue(step, 'output'); }
        if (ownValue(step, 'outputDir') !== undefined) { return ownValue(step, 'outputDir'); }
    }
    const direct = ownValue(context, expression);
    if (direct !== undefined) { return direct; }
    return undefined;
}

/**
 * `args` 원소 하나를 **0개 이상의 인자**로 펼친다.
 *
 * 원소가 **정확히 하나의 참조**이고(`"${pick.paths}"` — 앞뒤에 다른 글자가 없다)
 * 그 값이 배열이면, 항목마다 인자 하나가 된다. 그 외에는 평소처럼 문자열 보간
 * 결과 하나를 돌려준다.
 *
 * 이 형태가 필요한 이유: 여러 파일을 고른 뒤
 * `py -3 report.py a.bin b.bin c.bin --output x.html` 처럼 **개수가 정해지지 않은
 * 인자들**을 넘기는 것이 흔한데, 배열을 문자열로 이어 붙이면 그 결과가 다시
 * 인자 하나가 되거나(경계 보존 때문에) 공백으로 쪼개져 **경로에 공백이 있는
 * 순간 깨진다.** 항목을 각각 별도 argv 원소로 만들면 두 문제가 함께 사라진다 —
 * 각 원소는 그대로 인용되므로 셸도 개입하지 않는다.
 *
 * 앞뒤에 글자가 붙은 형태(`"--file=${pick.paths}"`)는 펼치지 않는다. 무엇을
 * 의도한 것인지 알 수 없고(각 항목에 접두사를 붙이라는 것인지, 이어 붙이라는
 * 것인지), 조용히 하나를 고르는 것보다 평소 규칙대로 두는 편이 낫다.
 */
export function expandArgTemplate(template: string, context: any): string[] {
    if (typeof template !== 'string') { return [template]; }
    const exact = /^\$\{([^}]+)\}$/.exec(template.trim());
    if (exact) {
        const value = resolvePipelineReference(exact[1], context);
        if (Array.isArray(value)) {
            return value
                .map(entry => sanitizeInterpolatedValue(entry))
                .filter((entry): entry is string => entry !== undefined);
        }
    }
    return [interpolatePipelineVariables(template, context)];
}

// ============================================================================
// Task graph utilities (roadmap §4 — Parallel Execution / Task DAG)
//
// These helpers are pure (no `vscode`, no I/O) so the scheduler decisions
// can be tested independently of the executor. The runtime scheduler in
// `extension.ts` consumes `buildTaskGraph` + `TaskScheduler`; TaskHub
// Doctor can later reuse `inferTaskDependencies` for an info-level
// "implicit dep" warning.
// ============================================================================

/**
 * Extract the head identifier from every `${...}` reference in `text`.
 * For `${buildA.output}` returns `"buildA"`. The pattern mirrors
 * `interpolatePipelineVariables`, so what the runtime substitutes and
 * what the graph treats as a dependency stay in sync automatically.
 */
export function extractVariableHeads(text: string): string[] {
    if (typeof text !== 'string' || text.length === 0) { return []; }
    const heads: string[] = [];
    const re = /\${([^}]+)}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const expr = m[1];
        if (!expr) { continue; }
        // **trim 하지 않는다** — `resolvePipelineReference` 는 split 결과를 그대로
        // 키로 쓴다. 여기서 다듬으면 `${ producer.output}` 이 `producer` 에 대한
        // 의존성으로 추론되어 실행 순서가 잡히지만, 런타임은 `" producer"` 를
        // 찾지 못해 리터럴로 남긴다 — 순서만 잡고 값은 안 오는 상태가 된다.
        // 반대로 id 자체가 `" producer"` 인 경우(스키마상 유효)에는 다듬지 않아야
        // 매칭되어 의존성이 잡힌다. 양쪽 다 런타임과 같아진다.
        // `??` 체인은 **모든 대안**을 의존성으로 낸다. 하나만 잡으면 소비자가
        // 살아남은 쪽이 값을 내기 전에 실행될 수 있다.
        const alternatives = splitCoalesceAlternatives(expr) ?? [expr];
        for (const alt of alternatives) {
            const head = alt.split('.')[0];
            if (head.length > 0) { heads.push(head); }
        }
    }
    return heads;
}

/**
 * `${…}` 참조를 **참조 단위로** 묶어 낸다. {@link extractVariableHeads} 가
 * 평평하게 펴는 것과 달리, `??` 체인 하나가 배열 하나가 된다.
 *
 * 건너뜀 전파에 필요하다: 평범한 참조는 그 태스크가 꺼지면 함께 꺼지지만,
 * `??` 체인은 **대안이 전부** 꺼져야 꺼진다. 평평한 목록으로는 그 둘을
 * 구별할 수 없다.
 */
export function extractVariableReferences(text: string): string[][] {
    if (typeof text !== 'string' || text.length === 0) { return []; }
    const refs: string[][] = [];
    const re = /\${([^}]+)}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const expr = m[1];
        if (!expr) { continue; }
        const alternatives = splitCoalesceAlternatives(expr) ?? [expr];
        const heads = alternatives.map(alt => alt.split('.')[0]).filter(head => head.length > 0);
        if (heads.length > 0) { refs.push(heads); }
    }
    return refs;
}

/**
 * `Task.when` 판정. `resolved` 는 **보간을 마친** `var` 값이다.
 *
 * 조건이 없으면 항상 실행한다. 연산자가 하나도 없으면 **실행한다** — 사용자가
 * 오타를 냈을 때 태스크가 조용히 사라지는 것보다, 도는 편이 눈에 띄고 Doctor 가
 * 따로 잡아 준다.
 */
export function evaluateTaskCondition(when: TaskCondition | undefined, resolved: string): boolean {
    if (!when || typeof when !== 'object') { return true; }
    if (typeof when.equals === 'string') { return resolved === when.equals; }
    if (typeof when.notEquals === 'string') { return resolved !== when.notEquals; }
    if (typeof when.matches === 'string') {
        try {
            return new RegExp(when.matches).test(resolved);
        } catch {
            // 잘못된 패턴은 Doctor 가 잡는다. 런타임에서 던지면 액션 전체가
            // 실패하므로, 여기서는 "맞지 않음" 으로 본다.
            return false;
        }
    }
    if (Array.isArray(when.in)) { return when.in.some(candidate => candidate === resolved); }
    return true;
}

/**
 * 조건으로 꺼진 태스크를 참조한다는 이유로 이 태스크도 건너뛸지.
 *
 * 평범한 참조 하나라도 꺼진 태스크를 가리키면 건너뛴다 — 그러지 않으면
 * 미해결 리터럴 `"${pickFile.path}"` 가 경로나 인자로 그대로 넘어간다.
 * `??` 체인은 **대안이 전부** 꺼졌을 때만 센다: 그 문법의 뜻이 "이 중 하나면
 * 된다" 이므로, 살아남은 대안이 있으면 이 태스크는 돌아야 한다.
 */
export function shouldSkipForSkippedDependencies(
    task: Task,
    skippedTaskIds: ReadonlySet<string>,
    options: InferTaskDependenciesOptions = {}
): boolean {
    if (!task || typeof task !== 'object' || skippedTaskIds.size === 0) { return false; }
    const platform = options.platform ?? process.platform;
    const projected = projectActivePlatformBranches(task, platform);
    for (const str of walkStrings(projected, TASK_INFER_SKIP_KEYS)) {
        for (const heads of extractVariableReferences(str)) {
            if (heads.every(head => skippedTaskIds.has(head))) { return true; }
        }
    }
    return false;
}

// `output.capture` and `output.diagnostics` contain regex patterns
// rather than interpolated text — skip those subtrees during the
// string walk so a `${...}` literal inside a regex is not mistaken
// for a task reference.
const TASK_INFER_SKIP_KEYS: ReadonlySet<string> = new Set(['capture', 'diagnostics']);

/**
 * Variable heads that are reserved by the runtime's interpolation
 * context and therefore must NOT be auto-inferred as task dependencies,
 * even if a task happens to be named the same. Without this filter, a
 * task named `workspaceFolder` would steal every `${workspaceFolder}`
 * reference and could create false-positive cycles (sequential task
 * after such a task auto-inferring it as a dep while the task itself
 * was barriered against the rest of the action).
 *
 * Colon-prefixed namespaces (`env:VAR`, `input:foo`) are handled
 * separately in `inferTaskDependencies` because `extractVariableHeads`
 * preserves the colon in the head.
 */
const RESERVED_VARIABLE_HEADS: ReadonlySet<string> = new Set([
    'workspaceFolder',
    'extensionPath',
]);

/**
 * Variable head prefixes reserved by VS Code-style namespaced
 * built-ins. References whose head starts with one of these are
 * skipped during dependency inference, even if a same-named task
 * happens to exist. Intentionally specific (NOT a blanket
 * `head.includes(':')`) — the schema does not forbid colons in task
 * ids, so a user-defined `id: 'build:fw'` referenced via
 * `${build:fw.output}` must still be auto-inferred as a dep.
 * Otherwise a `parallel: true` consumer would race its producer.
 */
const RESERVED_HEAD_PREFIXES: ReadonlyArray<string> = ['env:', 'input:'];

/** Task object keys whose value can be a per-platform `{windows,macos,linux}` object. */
const PLATFORM_BRANCH_KEYS: ReadonlySet<string> = new Set(['command', 'tool', 'itemsFromCommand']);

function pickPlatformBranch(
    obj: Record<string, unknown>,
    platform: NodeJS.Platform
): unknown {
    if (platform === 'win32') { return obj.windows; }
    if (platform === 'darwin') { return obj.macos; }
    if (platform === 'linux') { return obj.linux; }
    return undefined;
}

/**
 * `tool` / `command` 처럼 문자열이거나 OS별 객체인 값에서 **현재 플랫폼이 실제로
 * 고를 문자열 하나**를 돌려준다. 그 branch 가 없으면 `undefined` — 런타임의
 * {@link getToolCommand} / {@link getCommandString} 가 던지는 자리와 같다.
 *
 * "지금 이 기계에서 실행하면" 을 보여 주는 자리(Preview Run)에서 쓴다. 모든
 * branch 를 훑으면 이 기계에서 절대 실행되지 않을 branch 의 미해결 참조가
 * 보고되고, 반대로 현재 플랫폼 branch 가 없는 객체는 런타임에서 실패하는데도
 * 조용히 통과한다.
 *
 * **빈 문자열은 없는 것으로 본다.** `getToolCommand` / `getCommandString` 가
 * falsy 검사로 던지므로, `{ macos: '' }` 를 "있다" 고 답하면 미리보기가 빈
 * 명령을 정상처럼 보여 주고 실행만 실패한다.
 */
export function selectPlatformValue(
    value: unknown,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    if (typeof value === 'string') { return value || undefined; }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const branch = pickPlatformBranch(value as Record<string, unknown>, platform);
        if (typeof branch === 'string' && branch.length > 0) { return branch; }
    }
    return undefined;
}

/**
 * Return a shallow projection of `task` where each platform-branched
 * field (currently `command` / `tool` / `itemsFromCommand`) is replaced by the value of the
 * active platform's branch — mirroring what `getCommandString` /
 * `getToolCommand` actually execute. Non-active branches are dropped,
 * so a `${A.output}` reference that only appears in (say) the linux
 * branch is no longer scanned on Windows. Without this projection, a
 * cross-platform action with each platform referring to a different
 * sibling could trip `validateTaskGraph` on a cycle that doesn't exist
 * for the current platform.
 *
 * The projection is shallow on purpose: only top-level `command` /
 * `tool` / `itemsFromCommand` are platform-branched in the schema, so we
 * don't recurse into sub-objects (e.g. `output.*` fields are not
 * platform-keyed).
 */
function projectActivePlatformBranches(task: unknown, platform: NodeJS.Platform): unknown {
    if (!task || typeof task !== 'object' || Array.isArray(task)) { return task; }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(task as Record<string, unknown>)) {
        if (PLATFORM_BRANCH_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
            const branch = pickPlatformBranch(v as Record<string, unknown>, platform);
            // `undefined` (no entry for this platform) drops the field
            // from the inference view — there is no command/tool to run
            // on this platform, so no string refs to scan.
            if (branch !== undefined) { result[k] = branch; }
        } else {
            result[k] = v;
        }
    }
    // When `itemsFromCommand` is present, static `items` never executes at
    // runtime: either the command populates the pick list (items ignored), or
    // — for a per-platform object with no branch for the active platform — the
    // dispatcher's `getCommandString` throws, same as `command` (there is NO
    // fallback to static `items`). Either way `items` is dead, so drop it from
    // the inference view so stale `${...}` refs in `items` can't fabricate
    // deps/cycles. Checked against the *original* task, not the projected one,
    // because the object form may have just been projected away above.
    const ifc = (task as Record<string, unknown>).itemsFromCommand;
    const hasItemsFromCommand = typeof ifc === 'string' ? ifc.length > 0 : (!!ifc && typeof ifc === 'object');
    if (hasItemsFromCommand) {
        delete result.items;
    }
    return result;
}

function* walkStrings(value: unknown, skipKeys: ReadonlySet<string>): Generator<string> {
    if (typeof value === 'string') { yield value; return; }
    if (value === null || typeof value !== 'object') { return; }
    if (Array.isArray(value)) {
        for (const item of value) { yield* walkStrings(item, skipKeys); }
        return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (skipKeys.has(k)) { continue; }
        yield* walkStrings(v, skipKeys);
    }
}

export interface InferTaskDependenciesOptions {
    /**
     * Platform used to resolve `command` / `tool` per-platform branches.
     * Defaults to `process.platform`. Tests can override to assert
     * deterministic per-platform inference.
     */
    platform?: NodeJS.Platform;
}

/**
 * Infer dependencies for a task from `${taskId.x}` references in its
 * interpolatable string fields. Returns the set of task ids (subset of
 * `validTaskIds`) that this task references. Self-references are
 * excluded.
 *
 * Filtered out *before* the `validTaskIds` lookup:
 *  - `RESERVED_VARIABLE_HEADS` (`workspaceFolder`, `extensionPath`) —
 *    these are runtime built-ins; if a task happens to share the name,
 *    we must not redirect the built-in reference into a fake dep.
 *  - Heads starting with `RESERVED_HEAD_PREFIXES` (`env:`, `input:`) —
 *    VS Code-style namespaced built-ins. The check is on the prefix,
 *    NOT on whether the head merely contains a colon: the schema does
 *    not forbid colons in task ids, so a user-defined id like
 *    `build:fw` referenced via `${build:fw.output}` must still be
 *    auto-inferred as a dep. A blanket `head.includes(':')` filter
 *    would silently drop that dep and let parallel consumers race
 *    their producer.
 *
 * Platform-aware scan: `command` and `tool` may be `{windows, macos,
 * linux}` objects, but the runtime only executes the active branch.
 * The inference walk uses the active branch only, so a `${A.output}`
 * sitting in a non-current platform branch is not mistaken for a real
 * dependency. This avoids cross-platform false-positive cycles where
 * each platform separately resolves to a valid DAG but the union does
 * not.
 *
 * The scan walks all string-valued leaves of the projected task except
 * subtrees keyed by `capture` / `diagnostics`.
 *
 * Bare-id refs in `task.inputs`: `handleUnzip` reads `task.inputs.archive`
 * / `inputs.file` / `inputs.destination` as raw task ids (no `${...}`
 * wrapping) and looks them up in `allResults`. Without inferring those,
 * a `parallel: true` unzip following a zip can be scheduled before the
 * zip populates `allResults`, causing "requires an archive path" at
 * runtime. We inspect every `inputs` value across task types — matching
 * by `validTaskIds` keeps unrelated strings (paths, format names, …)
 * from being misread as deps. `inputs` is not platform-branched, so
 * the projection does not affect this path.
 */
export function inferTaskDependencies(
    task: Task,
    validTaskIds: ReadonlySet<string>,
    options: InferTaskDependenciesOptions = {}
): Set<string> {
    const deps = new Set<string>();
    if (!task || typeof task !== 'object') { return deps; }
    const platform = options.platform ?? process.platform;
    const projected = projectActivePlatformBranches(task, platform);
    for (const str of walkStrings(projected, TASK_INFER_SKIP_KEYS)) {
        for (const head of extractVariableHeads(str)) {
            if (head === task.id) { continue; }
            if (RESERVED_VARIABLE_HEADS.has(head)) { continue; }
            if (RESERVED_HEAD_PREFIXES.some(p => head.startsWith(p))) { continue; }
            if (validTaskIds.has(head)) { deps.add(head); }
        }
    }
    const inputs = (task as unknown as { inputs?: unknown }).inputs;
    if (inputs && typeof inputs === 'object') {
        for (const value of Object.values(inputs as Record<string, unknown>)) {
            if (typeof value !== 'string') { continue; }
            if (value === task.id) { continue; }
            if (validTaskIds.has(value)) { deps.add(value); }
        }
    }
    return deps;
}

/**
 * A node in the runtime task graph. `allDeps` is the union of
 * explicit `dependsOn`, dependencies inferred from variable
 * references, and the implicit "all previous tasks" barrier applied
 * when `parallel` is false/omitted (Option 2 semantics — `parallel`
 * is opt-in concurrency, not opt-out ordering).
 */
export interface TaskGraphNode {
    id: string;
    index: number;
    parallel: boolean;
    explicitDeps: ReadonlySet<string>;
    inferredDeps: ReadonlySet<string>;
    barrierDeps: ReadonlySet<string>;
    allDeps: ReadonlySet<string>;
}

export interface TaskGraph {
    nodes: ReadonlyMap<string, TaskGraphNode>;
    order: readonly string[];
}

export interface TaskGraphBuildOptions {
    /**
     * If true, `dependsOn` entries that reference a missing task id
     * are silently dropped from the node's `explicitDeps` set
     * instead of being preserved. Used by Preview Run / linter
     * paths where the graph is built tolerantly; the executor
     * leaves this false so a runtime mismatch surfaces clearly.
     */
    dropMissingDeps?: boolean;
    /**
     * Platform forwarded to `inferTaskDependencies` so that
     * platform-branched fields (`command` / `tool`) only contribute
     * dependencies from the active branch. Defaults to
     * `process.platform`. Tests set this explicitly to assert
     * deterministic per-platform behavior.
     */
    platform?: NodeJS.Platform;
}

export function buildTaskGraph(
    tasks: ReadonlyArray<Task>,
    options: TaskGraphBuildOptions = {}
): TaskGraph {
    const validIds = new Set<string>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') { validIds.add(t.id); }
    }

    const nodes = new Map<string, TaskGraphNode>();
    const order: string[] = [];
    const previousIds: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (!task || typeof task.id !== 'string') { continue; }
        const id = task.id;
        const parallel = task.parallel === true;

        const explicit = new Set<string>();
        for (const dep of task.dependsOn ?? []) {
            if (typeof dep !== 'string' || dep === id) { continue; }
            if (options.dropMissingDeps && !validIds.has(dep)) { continue; }
            explicit.add(dep);
        }

        const inferred = inferTaskDependencies(task, validIds, { platform: options.platform });

        const barrier = new Set<string>();
        if (!parallel) {
            for (const prev of previousIds) { barrier.add(prev); }
        }

        const all = new Set<string>([...explicit, ...inferred, ...barrier]);
        all.delete(id);

        nodes.set(id, {
            id,
            index: i,
            parallel,
            explicitDeps: explicit,
            inferredDeps: inferred,
            barrierDeps: barrier,
            allDeps: all,
        });
        order.push(id);
        previousIds.push(id);
    }

    return { nodes, order };
}

/**
 * Promise-chain mutex that serializes entry into interactive task
 * handlers (modal dialogs, quick-picks) so two `parallel: true`
 * interactive tasks cannot show modal UI concurrently. Each caller's
 * `fn` runs only after the previous holder's promise settles — a
 * failing holder doesn't poison the chain because we swallow the
 * rejection on the wait side; rejections of `fn` itself still
 * propagate out to the caller. Sequential pipelines never contend.
 *
 * Scope: the chain is module-global, so two *different* actions
 * running concurrently with `parallel: true` interactive tasks also
 * serialize their prompts across actions. This is intentional —
 * VS Code only renders one modal dialog at a time, so cross-action
 * serialization matches the platform's actual constraint.
 *
 * Invariant: the lock is held until `fn()`'s returned promise
 * settles, *regardless* of what the caller does with the Promise
 * this function returns. Callers that wrap our return value in a
 * separate timeout race (e.g. `withTaskTimeout`) do not release the
 * lock when the outer race rejects — only the underlying `fn`
 * settling does. This matters because VS Code modal dialogs can't
 * be programmatically dismissed: releasing on outer timeout would
 * let the next interactive task open a second dialog on top of the
 * still-visible first one.
 */
let interactivePromptChain: Promise<void> = Promise.resolve();
export function withInteractivePromptLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = interactivePromptChain;
    let release!: () => void;
    interactivePromptChain = new Promise<void>(resolve => { release = resolve; });
    return previous
        .catch(() => { /* previous holder's failure must not poison the chain */ })
        .then(fn)
        .finally(() => { release(); });
}

/**
 * True when an action contains at least one task marked
 * `parallel: true`. The executor uses this to decide whether to
 * isolate streamed-task terminal groups and `output.mode: 'terminal'`
 * terminal keys per-task; sequential actions keep the historical
 * shared-terminal behavior.
 */
export function actionUsesParallelTasks(action: { tasks: ReadonlyArray<Task> }): boolean {
    if (!action || !Array.isArray(action.tasks)) { return false; }
    for (const t of action.tasks) {
        if (t && t.parallel === true) { return true; }
    }
    return false;
}

/**
 * Issues that make a `TaskGraph` unsafe to execute. Surfaced by
 * `validateTaskGraph`; the runtime turns them into a clear pipeline
 * failure instead of waiting on a dependency that will never
 * complete.
 *
 * - `self-dependency`: a task lists itself in `dependsOn`.
 *   `buildTaskGraph` already drops the entry so the in-memory graph
 *   stays sound, but the original config is still wrong and the
 *   user should hear about it.
 * - `missing-dependency`: a `dependsOn` entry references a task id
 *   that doesn't exist in the same action. `buildTaskGraph` preserves
 *   the entry in `explicitDeps` so the executor can deadlock-detect
 *   here instead of stalling silently.
 * - `cycle`: a directed cycle in the union of explicit / inferred /
 *   barrier dependencies. Includes auto-inferred deps so two tasks
 *   that reference each other's output are caught.
 */
export type TaskGraphIssue =
    | { kind: 'self-dependency'; taskId: string }
    | { kind: 'missing-dependency'; taskId: string; missingId: string }
    | { kind: 'cycle'; cycle: string[] };

/**
 * Returns every reason the graph is unsafe to execute, in a fixed
 * order: self-deps and missing-deps in declaration order, then a
 * single cycle if one exists. Empty array means the graph is a DAG
 * with no dangling references. Pure — callers pass it the same
 * `tasks` array used to build the graph.
 */
export function validateTaskGraph(tasks: ReadonlyArray<Task>, graph: TaskGraph): TaskGraphIssue[] {
    const issues: TaskGraphIssue[] = [];
    const validIds = new Set<string>();
    for (const t of tasks) {
        if (t && typeof t.id === 'string') { validIds.add(t.id); }
    }

    for (const task of tasks) {
        if (!task || typeof task.id !== 'string') { continue; }
        if (!Array.isArray(task.dependsOn)) { continue; }
        for (const dep of task.dependsOn) {
            if (typeof dep !== 'string') { continue; }
            if (dep === task.id) {
                issues.push({ kind: 'self-dependency', taskId: task.id });
                continue;
            }
            if (!validIds.has(dep)) {
                issues.push({ kind: 'missing-dependency', taskId: task.id, missingId: dep });
            }
        }
    }

    const cycle = detectGraphCycle(graph);
    if (cycle) { issues.push({ kind: 'cycle', cycle }); }
    return issues;
}

/**
 * Single-source human-readable formatter for `TaskGraphIssue` so the
 * runtime executor (`extension.ts`) and Preview Run share one
 * phrasing. Doctor uses its own per-issue formatting (because it needs
 * to prefix with the action id), but the underlying classification
 * comes from the same `validateTaskGraph` call.
 */
export function formatGraphIssue(issue: TaskGraphIssue): string {
    switch (issue.kind) {
        case 'self-dependency':
            return `task '${issue.taskId}' depends on itself`;
        case 'missing-dependency':
            return `task '${issue.taskId}' depends on unknown task '${issue.missingId}'`;
        case 'cycle':
            return `dependency cycle: ${issue.cycle.join(' -> ')}`;
    }
}

/**
 * Detect cycles in the graph. Returns null if the graph is a DAG,
 * or a sample cycle (sequence of node ids that loops back on itself)
 * if a cycle exists. Uses three-color DFS for parity with
 * `src/doctor.ts` `dependsOn.cycle` so the runtime and the linter
 * agree on cycle structure.
 */
export function detectGraphCycle(graph: TaskGraph): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of graph.nodes.keys()) { color.set(id, WHITE); }
    const stack: string[] = [];
    let found: string[] | null = null;

    const visit = (id: string): void => {
        if (found) { return; }
        const state = color.get(id) ?? WHITE;
        if (state === BLACK) { return; }
        if (state === GRAY) {
            const idx = stack.indexOf(id);
            // `idx < 0` should be unreachable: GRAY means we entered the
            // node and pushed it onto `stack` higher up in the DFS, so
            // the id MUST be present. The `[id, id]` fallback is a
            // defensive escape — if it ever fires, the resulting "A -> A"
            // message is unmistakable enough to flag the broken invariant.
            found = idx >= 0 ? [...stack.slice(idx), id] : [id, id];
            return;
        }
        color.set(id, GRAY);
        stack.push(id);
        for (const next of graph.nodes.get(id)?.allDeps ?? []) { visit(next); }
        stack.pop();
        color.set(id, BLACK);
    };
    for (const id of graph.nodes.keys()) {
        if (found) { break; }
        if ((color.get(id) ?? WHITE) === WHITE) { visit(id); }
    }
    return found;
}

export interface TaskSchedulerOptions {
    maxConcurrency: number;
}

/**
 * Stateful scheduler for executing a `TaskGraph` with bounded
 * concurrency. Pure (no I/O / `vscode` deps) so the scheduling
 * decisions can be unit-tested independently of the executor.
 *
 * Lifecycle:
 *   1. `nextReady()` returns the next batch of task ids that may
 *      start immediately, capped at `maxConcurrency - running`.
 *      Returned in original declaration order for determinism.
 *   2. Caller `markStarted(id)` before spawning, then on completion
 *      either `markCompleted(id)` (success OR continueOnError skip
 *      — both unblock dependents per existing pipeline behavior)
 *      or `markFailed(id)` (stops new scheduling; in-flight tasks
 *      must still be awaited by the caller).
 *   3. Loop while `isFinished()` is false.
 */
export class TaskScheduler {
    private readonly graph: TaskGraph;
    private readonly maxConcurrency: number;
    private readonly remainingDeps = new Map<string, Set<string>>();
    private readonly status = new Map<string, 'pending' | 'running' | 'done' | 'failed'>();
    private running = 0;
    private aborted = false;

    constructor(graph: TaskGraph, options: TaskSchedulerOptions) {
        if (!Number.isFinite(options.maxConcurrency) || options.maxConcurrency < 1) {
            throw new Error(`maxConcurrency must be >= 1, got ${options.maxConcurrency}`);
        }
        this.graph = graph;
        this.maxConcurrency = Math.floor(options.maxConcurrency);
        for (const [id, node] of graph.nodes) {
            this.remainingDeps.set(id, new Set(node.allDeps));
            this.status.set(id, 'pending');
        }
    }

    nextReady(): string[] {
        if (this.aborted) { return []; }
        const slots = this.maxConcurrency - this.running;
        if (slots <= 0) { return []; }
        const ready: string[] = [];
        for (const id of this.graph.order) {
            if (ready.length >= slots) { break; }
            if (this.status.get(id) !== 'pending') { continue; }
            const remaining = this.remainingDeps.get(id);
            if (remaining && remaining.size === 0) { ready.push(id); }
        }
        return ready;
    }

    markStarted(id: string): void {
        const current = this.status.get(id);
        if (current !== 'pending') {
            throw new Error(`Cannot start task '${id}' from status '${current ?? 'unknown'}'.`);
        }
        this.status.set(id, 'running');
        this.running++;
    }

    markCompleted(id: string): void {
        const current = this.status.get(id);
        if (current !== 'running') {
            throw new Error(`Cannot complete task '${id}' from status '${current ?? 'unknown'}'.`);
        }
        this.status.set(id, 'done');
        this.running--;
        for (const deps of this.remainingDeps.values()) { deps.delete(id); }
    }

    markFailed(id: string): void {
        const current = this.status.get(id);
        if (current !== 'running') {
            throw new Error(`Cannot fail task '${id}' from status '${current ?? 'unknown'}'.`);
        }
        this.status.set(id, 'failed');
        this.running--;
        this.aborted = true;
    }

    runningCount(): number { return this.running; }
    isAborted(): boolean { return this.aborted; }

    isFinished(): boolean {
        if (this.aborted) { return this.running === 0; }
        for (const s of this.status.values()) {
            if (s === 'pending' || s === 'running') { return false; }
        }
        return true;
    }
}

/**
 * Resolve a `command` value which may be a raw string or a per-platform object
 * (`{ windows, macos, linux }`) to a single string for the current platform.
 */
export function getCommandString(command: any): string {
    if (typeof command === 'string') { return command; }
    if (typeof command === 'object' && command !== null) {
        const platform = process.platform;
        if (platform === 'win32' && command.windows) { return command.windows; }
        else if (platform === 'darwin' && command.macos) { return command.macos; }
        else if (platform === 'linux' && command.linux) { return command.linux; }
    }
    throw new Error(`Invalid or unsupported 'command' property for the current platform (${process.platform}). Provide a string or an object with platform-specific entries.`);
}

/**
 * Resolve a `tool` value (string or per-platform object) to a shell-safe command
 * fragment. Adds surrounding double quotes only if the path contains spaces.
 */
export function getToolCommand(tool: any): string {
    let toolCommand: string | undefined;
    if (typeof tool === 'string') {
        toolCommand = tool;
    } else if (typeof tool === 'object' && tool !== null) {
        const platform = process.platform;
        if (platform === 'win32' && tool.windows) { toolCommand = tool.windows; }
        else if (platform === 'darwin' && tool.macos) { toolCommand = tool.macos; }
        else if (platform === 'linux' && tool.linux) { toolCommand = tool.linux; }
    }

    if (!toolCommand) {
        throw new Error(`No tool path specified for the current platform (${process.platform}) in actions.json`);
    }

    // Quote the command if it contains spaces to handle paths like "C:\Program Files\..."
    if (toolCommand.includes(' ') && !toolCommand.startsWith('"')) {
        toolCommand = `"${toolCommand}"`;
    }
    return toolCommand;
}

/**
 * Split a shell-like command string into tokens, respecting single/double
 * quotes. Double-quoted strings support `\"` and `\\` escapes. Note that this
 * is intentionally minimal — it does NOT understand backticks, variable
 * expansion, or operators like `&&`, `|`. It is only used to separate
 * `executable` from `args`; final shell metacharacter handling is deferred to
 * the per-platform quoting helpers below.
 */
export function tokenizeCommandLine(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quoteChar: string | null = null;
    // 이 토큰에 **명시적 인용이 있었는가**. 빈 인용(`""`)은 "빈 인자" 라는
    // 뜻이므로 토큰으로 남겨야 한다. 예전에는 `current.length > 0` 만 보고
    // 버렸는데, 그러면 보간값이 빈 문자열일 때 그 인자가 **사라지고 뒤 인자가
    // 앞으로 당겨진다** — `tool --output ${empty} target` 이
    // `tool --output target` 이 되어 `target` 이 `--output` 의 값으로 먹힌다.
    let quoted = false;

    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quoteChar) {
            if (char === quoteChar) {
                quoteChar = null;
            } else if (char === '\\' && quoteChar === '"' && i + 1 < command.length) {
                const next = command[i + 1];
                if (next === '"' || next === '\\') {
                    current += next;
                    i++;
                } else {
                    current += char;
                }
            } else {
                current += char;
            }
        } else if (char === '"' || char === '\'') {
            quoteChar = char;
            quoted = true;
        } else if (/\s/.test(char)) {
            if (current.length > 0 || quoted) {
                tokens.push(current);
                current = '';
                quoted = false;
            }
        } else {
            current += char;
        }
    }

    if (current.length > 0 || quoted) {
        tokens.push(current);
    }
    return tokens;
}

/**
 * `tokenizeCommandLine` 의 역함수. 어떤 문자열이든 **정확히 한 토큰**으로
 * 되돌아오게 인용한다 (큰따옴표로 감싸고 `\` 와 `"` 만 escape — 토크나이저가
 * 큰따옴표 안에서 인식하는 두 escape 와 정확히 대응한다).
 */
export function quoteForCommandTokenizer(token: string): string {
    return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * argv 실행용 명령 문자열을 만들되, **보간값이 argv 경계를 만들지 못하게** 한다.
 *
 * 예전에는 문자열 전체를 먼저 보간하고 그 결과를 공백으로 토큰화했다. 그러면
 * 보간값 안의 공백이 **새 인자를 만든다**:
 *
 *   - `git tag ${input.value}` 에 `--delete main` → `git tag --delete main`
 *     (태그 생성이 아니라 **삭제**가 된다 — 옵션 주입)
 *   - `${selectFile.path}` 가 `/My Docs/a.txt` → 인자 두 개로 쪼개진다
 *
 * `command` 타입으로 바꾼 것은 **셸** 주입만 닫았고 이 경계 문제는 그대로였다.
 * 이제 **템플릿을 먼저 토큰화하고 토큰마다 보간**한다 — 보간값에 무엇이 있어도
 * 그 토큰 하나로 남는다. `--env=${x}` 처럼 리터럴에 붙은 형태도 그대로 유지된다.
 *
 * `shell` 타입에는 쓰지 않는다. 그쪽은 문자열을 셸에 그대로 넘기는 것이 계약이라
 * argv 경계라는 개념 자체가 없다 — 거기서는 값을 `args` 로 넘기는 것이 답이고,
 * Doctor 의 `shell.interpolated-command` 룰이 그 형태를 찾아 준다.
 */
export function interpolateCommandPreservingTokens(
    template: string,
    interpolate: (value: string) => string
): string {
    return tokenizeCommandLine(template)
        .map(token => quoteForCommandTokenizer(interpolate(token)))
        .join(' ');
}

/**
 * Take a raw command string and extra args, and return the executable as a
 * separate token from the (combined) arg list.
 */
export function mergeCommandAndArgs(command: string, extraArgs: string[]): { executable: string; args: string[] } {
    const baseTokens = tokenizeCommandLine(command.trim());
    if (baseTokens.length === 0) {
        throw new Error('Cannot execute an empty command.');
    }
    const executable = baseTokens[0];
    const initialArgs = baseTokens.slice(1);
    const combinedArgs = [...initialArgs, ...(extraArgs || [])];
    return { executable, args: combinedArgs };
}

/**
 * Single-quote an argument for PowerShell. Inside PowerShell single quotes,
 * everything is literal except another single quote, which is escaped as `''`.
 */
export function quotePowerShellArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote one Windows process argument using the CommandLineToArgvW-compatible
 * backslash / double-quote rules. This is for APIs that accept one command-line
 * string (for example ProcessStartInfo.Arguments), not for PowerShell parsing.
 */
export function quoteWindowsCommandLineArgument(value: string): string {
    if (value.length > 0 && !/[\s"]/u.test(value)) {
        return value;
    }
    let result = '"';
    let backslashes = 0;
    for (const char of value) {
        if (char === '\\') {
            backslashes++;
            continue;
        }
        if (char === '"') {
            result += '\\'.repeat(backslashes * 2 + 1);
            result += '"';
            backslashes = 0;
            continue;
        }
        if (backslashes > 0) {
            result += '\\'.repeat(backslashes);
            backslashes = 0;
        }
        result += char;
    }
    if (backslashes > 0) {
        result += '\\'.repeat(backslashes * 2);
    }
    result += '"';
    return result;
}

function displayCommandPart(value: string): string {
    return /^[A-Za-z0-9_./\\:-]+$/.test(value)
        ? value
        : quoteWindowsCommandLineArgument(value);
}

// cmd.exe builtins / common PowerShell aliases that have no backing `.exe` —
// these must stay on the PowerShell path (`& 'echo' ...` resolves the alias).
const WINDOWS_SHELL_COMMANDS = new Set([
    'cat', 'cd', 'chdir', 'cls', 'copy', 'cp', 'del', 'dir', 'echo', 'erase',
    'ls', 'md', 'mkdir', 'move', 'mv', 'popd', 'pushd', 'pwd', 'rd', 'ren',
    'rename', 'rm', 'rmdir', 'set', 'sleep', 'start', 'type'
]);

// Extensions the OS process loader can start directly (`spawn(file)` without a
// shell). `.cmd` / `.bat` / `.ps1` / `.js` / `.py` / … are scripts or shims
// that need a shell or interpreter, so those stay on the PowerShell path.
const WINDOWS_DIRECT_LAUNCH_EXTENSIONS = ['.exe', '.com'];

/**
 * Injectable filesystem/environment view used by {@link windowsCommandIsDirectlyLaunchable}
 * so PATH resolution can be unit-tested deterministically.
 */
export interface WindowsExecutableLookup {
    env: NodeJS.ProcessEnv;
    isFile: (filePath: string) => boolean;
}

const defaultWindowsExecutableLookup: WindowsExecutableLookup = {
    env: process.env,
    isFile: (filePath: string): boolean => {
        try {
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    },
};

/**
 * Whether a Windows command can be launched as a native process
 * (`spawn(file, argvArray)` / `vscode.ProcessExecution`) instead of going
 * through PowerShell. Native launch is preferred because the argv array is
 * passed straight to the child, side-stepping Windows PowerShell 5.1's legacy
 * quote-mangling for arguments containing `"`.
 *
 *   - explicit `.exe` / `.com` extension                → yes (no lookup)
 *   - explicit other extension (`.cmd`, `.bat`, `.ps1`,
 *     `.js`, …)                                          → no  (scripts/shims)
 *   - shell builtin / alias (`echo`, `dir`, `cd`, …)     → no
 *   - extensionless name: search PATH for `name.exe` /
 *     `name.com` (also checks `name` when it carries a
 *     path separator)                                    → yes iff found
 *
 * A name that exists only as a `.cmd` shim (`npm` → `npm.cmd`, also `npx` /
 * `pnpm` / `yarn`) therefore stays on the PowerShell path, where `&` performs
 * the PATHEXT resolution. The lookup is only invoked on Windows (the POSIX path
 * uses `sh -c`), so its cost is Windows-only and runs once per task launch.
 *
 * `lookup` may override `env` and/or `isFile`; whatever isn't supplied falls
 * back to `process.env` / a real `fs.statSync`. Callers MUST pass the **task's
 * effective env** (`{ ...process.env, ...envOverrides }` — i.e. the same env the
 * child will run with) so a `PATH` extended via `task.env.PATH` is honoured here
 * too; otherwise a toolchain `.exe` could be misjudged and routed through
 * PowerShell (re-triggering the very quote bug this avoids).
 */
export function windowsCommandIsDirectlyLaunchable(
    command: string,
    args: string[] = [],
    lookup: Partial<WindowsExecutableLookup> = {}
): boolean {
    const env = lookup.env ?? defaultWindowsExecutableLookup.env;
    const isFile = lookup.isFile ?? defaultWindowsExecutableLookup.isFile;
    const { executable } = mergeCommandAndArgs(command, args);
    const base = (executable.split(/[\\/]/).pop() || executable).toLowerCase();
    const dotIndex = base.lastIndexOf('.');
    if (dotIndex > 0) {
        return WINDOWS_DIRECT_LAUNCH_EXTENSIONS.includes(base.slice(dotIndex));
    }
    if (WINDOWS_SHELL_COMMANDS.has(base)) {
        return false;
    }
    const hasSeparator = /[\\/]/.test(executable);
    const searchDirs = hasSeparator ? [''] : (env.PATH ?? env.Path ?? '').split(';');
    for (const dir of searchDirs) {
        for (const ext of WINDOWS_DIRECT_LAUNCH_EXTENSIONS) {
            const candidate = hasSeparator
                ? executable + ext
                : (dir ? path.win32.join(dir, executable + ext) : executable + ext);
            if (isFile(candidate)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 명령 문자열이 PowerShell 7 이상을 요구하는 연산자를 쓰는가.
 *
 * **인용 구간은 세지 않는다.** `cmd /c "build && test"` 의 `&&` 는 문자열
 * 리터럴 안이라 Windows PowerShell 5.1 도 문제없이 파싱한다 — 오히려 이것이
 * 5.1 에서 chain 을 쓰는 **정석 우회법**이고, 우리 문서도 `cmd /c …` 형태를
 * 가르친다. 인용을 무시하고 스캔하면 그 우회법을 우리가 차단하면서 "PowerShell
 * 7 을 설치하라" 는 엉뚱한 안내를 하게 된다.
 *
 * `args` 는 아예 넘기지 않는다 — 우리가 항상 인용해서 붙이므로 그 안의 `&&` 는
 * 연산자가 될 수 없다.
 */
export function rawCommandUsesChainOperators(command: string): boolean {
    const withoutQuoted = command.replace(/'[^']*'|"[^"]*"/g, '');
    return /&&|\|\|/.test(withoutQuoted);
}

/**
 * `pwsh.exe`(PowerShell 7+)를 찾을 수 있는가.
 *
 * PATH 를 먼저 보고, 없으면 기본 설치 경로도 확인한다 — PATH 등록 없이 설치한
 * 경우가 흔하고, 이 판정이 실패하면 (chain 연산자를 쓰는 명령에서) **태스크가
 * 아예 실패**하므로 false negative 의 대가가 크다.
 */
export function resolvePwshPath(lookup: Partial<WindowsExecutableLookup> = {}): string | undefined {
    // PATH 에 있으면 이름만으로 띄울 수 있다.
    if (windowsCommandIsDirectlyLaunchable('pwsh', [], lookup)) { return 'pwsh.exe'; }
    const env = lookup.env ?? defaultWindowsExecutableLookup.env;
    const isFile = lookup.isFile ?? defaultWindowsExecutableLookup.isFile;
    // PATH 에 없다면 **전체 경로를 돌려줘야 한다.** 처음 구현은 여기서 찾고도
    // 이름(`pwsh.exe`)만 반환해서, PATH 에 없는 그 설치본을 spawn 이 찾지
    // 못하고 세 실행 모드 모두 실패했다 — false negative 를 줄이려던 보완이
    // 오히려 확실한 실패를 만들었다.
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
        if (!root) { continue; }
        const candidate = path.win32.join(root, 'PowerShell', '7', 'pwsh.exe');
        if (isFile(candidate)) { return candidate; }
    }
    return undefined;
}

/**
 * raw `shell` 을 실행할 Windows 인터프리터. 못 고르면 `undefined`.
 *
 * `powershell.exe` 는 **Windows PowerShell 5.1** 이고 `&&` / `||` 를 지원하지
 * 않는다 (PowerShell 7 부터 도입, 실행 파일 이름은 `pwsh.exe`). 0.6.47 은
 * Windows 를 `powershell.exe` 로 고정했고, 그래서 문서가 동작한다고 적은 `&&` 가
 * 파스 오류로 끝났다.
 *
 * **chain 연산자를 쓸 때만 `pwsh` 로 간다.** 무조건 `pwsh` 를 선호하면 이미
 * 동작하던 액션의 의미가 조용히 바뀐다 — PS 7 은 `curl`/`wget` 별칭을 없앴고
 * `>` 의 기본 인코딩도 다르다. 게다가 같은 `actions.json` 이 pwsh 설치 여부에
 * 따라 기계마다 다르게 동작하게 된다. 필요할 때만 바꾸면 그 두 문제가 사라진다.
 *
 * `cmd.exe` 로 가는 선택지도 있었지만 택하지 않았다 — 명령 문자열을 인용 없이
 * 넘길 안전한 통로가 `-EncodedCommand`(base64) 뿐이고, 그것이 PowerShell 계열
 * 에만 있다. cmd 로 가면 인용 문제를 우리가 다시 떠안는다.
 *
 * 참고: PowerShell **6** 의 실행 파일도 `pwsh.exe` 이고 거기에는 `&&` 가 없다
 * (7.0 에서 도입). PS 6 은 EOL 이라 그 구분까지는 하지 않는다.
 */
export function selectWindowsRawShell(needsChainOperators: boolean, pwshPath: string | undefined): string | undefined {
    if (!needsChainOperators) { return 'powershell.exe'; }
    return pwshPath;
}

/**
 * Windows 에서 명령을 어떤 방식으로 띄울지 고른다.
 *
 * **raw 는 native 보다 먼저 판단해야 한다.** native 는 첫 토큰을 실행 파일로
 * 보고 나머지를 argv 로 넘기므로 `&&`·`|`·`>` 가 리터럴 인자가 된다. 0.6.47 은
 * 스트림 모드에서만 이 순서를 지켰고 캡처 모드는 `raw` 를 보지 않아, 같은
 * 태스크가 `passTheResultToNextTask` 하나로 다르게 실행됐다. 순서를 함수로
 * 고정해 두 경로가 같은 규칙을 공유하게 한다.
 */
export function windowsSpawnStrategy(raw: boolean, directlyLaunchable: boolean): 'raw-shell' | 'native' | 'powershell' {
    if (raw) { return 'raw-shell'; }
    return directlyLaunchable ? 'native' : 'powershell';
}

/**
 * Windows 에서 raw `shell` one-shot 을 띄우는 PowerShell 스크립트.
 *
 * one-shot 은 파이프라인 수명을 벗어나 살아 있어야 하므로 인터프리터 자체를
 * `Start-Process` 로 떼어 낸다. 명령 문자열은 `-EncodedCommand`(base64)로
 * 넘겨 인용을 통째로 우회한다 — 이 경로가 Windows 에서 실행 검증이 어려운
 * 만큼, 조립 규칙만이라도 순수 함수로 고정해 둔다.
 */
export function buildRawOneShotWindowsScript(
    shellExecutable: string,
    encodedCommand: string,
    cwd: string | undefined
): string {
    const workingDirectoryPart = cwd ? ` -WorkingDirectory ${quotePowerShellArgument(cwd)}` : '';
    return `Start-Process -FilePath ${quotePowerShellArgument(shellExecutable)}`
        + ` -ArgumentList @('-NoProfile', '-EncodedCommand', ${quotePowerShellArgument(encodedCommand)})`
        + `${workingDirectoryPart} -WindowStyle Hidden`;
}

export interface NativeCommandInvocation {
    executable: string;
    args: string[];
    display: string;
}

export function buildNativeCommandInvocation(command: string, args: string[]): NativeCommandInvocation {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    return {
        executable,
        args: combinedArgs,
        display: [executable, ...combinedArgs].map(displayCommandPart).join(' '),
    };
}

/**
 * Build a PowerShell invocation script (`& 'exe' 'arg1' 'arg2'`) plus a
 * display string for logs. When `enforceUtf8Console` is true, the script
 * prepends a `[Console]::OutputEncoding = UTF8` directive.
 */
export function buildPowerShellInvocation(command: string, args: string[], enforceUtf8Console: boolean): { script: string; display: string } {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const quotedExe = quotePowerShellArgument(executable);
    const quotedArgs = combinedArgs.map(arg => quotePowerShellArgument(arg));
    const invocation = `& ${quotedExe}${quotedArgs.length ? ' ' + quotedArgs.join(' ') : ''}`;
    const prefix = enforceUtf8Console ? "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n" : '';
    const script = `${prefix}${invocation}`;
    return { script, display: invocation };
}

/**
 * PowerShell 스크립트 끝에 **실제 종료 코드를 전달하는 후행부**를 붙인다.
 *
 * `powershell.exe -Command`/`-EncodedCommand` 는 외부 프로그램의 종료 코드를
 * 그대로 물려주지 않는다 — 실패를 1 로 뭉갠다. 그래서 종료 코드 7 로 끝나는
 * 컴파일러·플래셔가 1 로 보이고, `output.diagnostics` 나 사용자 스크립트가
 * 코드로 분기할 수 없었다. Microsoft 도 구체적 코드를 보존하려면 명시적으로
 * `exit $LASTEXITCODE` 를 넣으라고 안내한다.
 *
 * **`$?` 를 먼저 본다.** `$LASTEXITCODE` 는 세션에 **남아 있는** 값이다 —
 * 마지막 *네이티브* 프로그램의 코드일 뿐이고, 그 뒤에 cmdlet 이 실패해도
 * 갱신되지 않는다. 그래서 `$LASTEXITCODE` 를 먼저 적용하면 두 방향으로 틀린다:
 *
 *   - `cmd /c exit 0; Write-Error boom` → cmdlet 이 실패했는데 코드는 0 →
 *     **실패가 성공으로 보고된다.** 이쪽이 훨씬 위험하다.
 *   - `cmd /c exit 5; Write-Output ok` → 마지막 명령은 성공했는데 코드 5 →
 *     성공이 실패로 보고된다.
 *
 * 그래서 성공 여부는 `$?` 가 판정하고, `$LASTEXITCODE` 는 **실패일 때 구체적인
 * 코드를 되살리는 데만** 쓴다. 네이티브 프로그램이 0 이 아닌 코드로 끝나면
 * `$?` 도 false 이므로 코드 7 은 그대로 7 로 나간다.
 *
 * 이 후행부는 민감 one-shot 이 쓰던 것을 공용화한 것인데, **그 원본이 이미 이
 * 순서 문제를 갖고 있었다** — 공용화가 그것을 세 경로로 퍼뜨렸다.
 */
export function withPowerShellExitCode(script: string): string {
    return script +
        '\n$taskHubSucceeded = $?\n$taskHubExitCode = $LASTEXITCODE\n' +
        'if ($taskHubSucceeded) { exit 0 }\n' +
        'if ($null -ne $taskHubExitCode -and [int]$taskHubExitCode -ne 0) { exit [int]$taskHubExitCode }\n' +
        'exit 1';
}

/** Encode a PowerShell script as UTF-16 LE Base64, suitable for `-EncodedCommand`. */
export function encodePowerShellScript(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Single-quote an argument for POSIX shells (sh/bash/zsh). Inside single
 * quotes, everything is literal except another single quote, which is escaped
 * via the `'\''` idiom.
 */
export function quotePosixArgument(value: string): string {
    return value.length === 0 ? "''" : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a POSIX-shell command line (`exe 'arg1' 'arg2'`). The executable is
 * only quoted if it contains a character outside the safe set — keeping
 * pathless names like `npm` readable in logs.
 */
/**
 * `shell` 타입의 실행 문자열 (0.6.47).
 *
 * `command` 문자열을 **셸에 그대로** 넘긴다 — `&&`, `|`, `>`, `$VAR` 가 모두
 * 셸 문법으로 동작한다. `buildPosixCommandLine` 은 반대로 토큰마다 인용해
 * argv 로 만든다(그쪽이 `command` 타입의 계약이다).
 *
 * `args` 는 뒤에 **인용해서** 붙인다. 공백이 든 경로를 안전하게 넘기는 통로가
 * 그대로 필요하기 때문이다 — raw 문자열 안에 그런 값을 보간하면 셸이 쪼갠다.
 */
export function buildRawShellCommandLine(command: string, args: string[]): string {
    const trimmed = command.trim();
    if (!args || args.length === 0) { return trimmed; }
    return `${trimmed} ${args.map(arg => quotePosixArgument(arg)).join(' ')}`;
}

/** {@link buildRawShellCommandLine} 의 PowerShell 판. */
export function buildRawPowerShellCommandLine(command: string, args: string[]): string {
    const trimmed = command.trim();
    if (!args || args.length === 0) { return trimmed; }
    return `${trimmed} ${args.map(arg => quotePowerShellArgument(arg)).join(' ')}`;
}

export function buildPosixCommandLine(command: string, args: string[]): string {
    const { executable, args: combinedArgs } = mergeCommandAndArgs(command, args);
    const commandPart = /^[A-Za-z0-9_./-]+$/.test(executable) ? executable : quotePosixArgument(executable);
    const parts = [commandPart, ...combinedArgs.map(arg => quotePosixArgument(arg))];
    return parts.join(' ');
}

/**
 * Scheme allowlist for external link opening. `command:` / `file:` / `vscode:`
 * and arbitrary custom schemes are rejected so a malicious links.json cannot
 * invoke VS Code commands or launch OS-registered handlers.
 */
export const ALLOWED_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

export type LinkSchemeValidation =
    | { ok: true; scheme: string; url: string }
    | { ok: false; reason: 'empty' | 'invalid' }
    | { ok: false; reason: 'scheme'; scheme: string };

/**
 * Validate a raw URL string against {@link ALLOWED_LINK_SCHEMES}. Kept free of
 * any `vscode` dependency so it can be unit-tested directly.
 */
export function validateLinkScheme(rawUrl: unknown): LinkSchemeValidation {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
        return { ok: false, reason: 'empty' };
    }
    // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    const match = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(rawUrl);
    if (!match) {
        return { ok: false, reason: 'invalid' };
    }
    const scheme = match[1].toLowerCase();
    if (!ALLOWED_LINK_SCHEMES.has(scheme)) {
        return { ok: false, reason: 'scheme', scheme };
    }
    return { ok: true, scheme, url: rawUrl };
}

export type LinkUrlSaveValidation =
    | { ok: true }
    | { ok: false; reason: 'empty' | 'invalid' }
    | { ok: false; reason: 'scheme'; scheme: string };

/**
 * Save-time URL gate used by both `taskhub.addLink` and the workspace link
 * edit flow. Combines two checks:
 *
 *   1. {@link validateLinkScheme} — only http/https/mailto are allowed.
 *   2. WHATWG `new URL()` parsing — catches inputs that the regex-only
 *      scheme check would let through, notably bare scheme-only strings
 *      like `https://` / `http://` and an unterminated IPv6 literal like
 *      `https://[invalidIPv6`. Without (2) the prior v0.4.32 patch claimed
 *      to block "format errors" but in practice those strings still
 *      slipped past the InputBox validator and the user got an "Invalid
 *      URL format" toast at click time instead.
 *
 * Known WHATWG limitations the gate does *not* catch (so callers still
 * have a click-time fail-safe via `vscode.Uri.parse(..., true)`):
 *
 *   - `https:///path` — WHATWG normalizes consecutive slashes after the
 *     scheme, so this becomes `https://path/` (host = 'path', pathname =
 *     '/'). The user's intent ("hostless URL with /path") is silently
 *     reinterpreted into a request to the host literally named `path`.
 *     The gate accepts the input because `new URL()` does not throw.
 *   - `mailto:` (empty), `mailto:not-an-email` — `new URL` does not
 *     validate the local-part / domain. Accepted; the mail client will
 *     reject on send.
 *
 * Returns a tagged result so the caller can localize messages itself —
 * keeping this function vscode-free preserves the unit-test seam.
 */
export function validateLinkUrlForSave(rawUrl: unknown): LinkUrlSaveValidation {
    const scheme = validateLinkScheme(rawUrl);
    if (!scheme.ok) {
        if (scheme.reason === 'scheme') {
            return { ok: false, reason: 'scheme', scheme: scheme.scheme };
        }
        return { ok: false, reason: scheme.reason };
    }
    try {
        new URL(scheme.url);
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    return { ok: true };
}

/**
 * Resolve a favorite entry's path to an absolute path that is guaranteed to
 * live inside one of the current workspace roots. Throws (via
 * {@link resolveWithinWorkspace}) when the path escapes the workspace — even
 * if the user hand-crafted `.vscode/favorites.json` with `../` traversal or
 * an absolute path to elsewhere on disk.
 */
export function resolveFavoriteFilePath(
    rawPath: string,
    workspaceFolderPath: string,
    workspaceRoots: string[]
): string {
    const interpolated = rawPath.replace('${workspaceFolder}', workspaceFolderPath || '');
    return resolveWithinWorkspace(interpolated, workspaceRoots, workspaceFolderPath || undefined);
}

/**
 * Convert an absolute file path to a `${workspaceFolder}`-relative form when
 * the file lives inside the given workspace root. Returns the original path
 * otherwise. Used so that favorites / links stored in `.vscode/*.json` stay
 * portable across machines (the schema already documents this as the
 * preferred form; see favorites_example.json).
 *
 * Output always uses POSIX-style separators (`/`) to keep the serialized
 * JSON stable across Windows/macOS/Linux collaborators.
 */
export function toWorkspaceRelativePath(absolutePath: string, workspaceFolderPath: string | undefined): string {
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
        return absolutePath;
    }
    if (!workspaceFolderPath) {
        return absolutePath;
    }
    const normalizedRoot = path.resolve(workspaceFolderPath);
    const normalizedTarget = path.resolve(absolutePath);
    const rel = path.relative(normalizedRoot, normalizedTarget);
    if (rel === '' ) {
        return '${workspaceFolder}';
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return absolutePath;
    }
    return '${workspaceFolder}/' + rel.split(path.sep).join('/');
}

/**
 * Normalize line endings of `content` according to `eol`.
 *   - `lf`   : every CRLF becomes LF (lone CRs are left alone).
 *   - `crlf` : every LF becomes CRLF. Existing CRLF sequences are preserved
 *              (we collapse to LF first so we never emit CRCRLF).
 *   - `keep` : content is returned unchanged.
 * Anything else is treated as `keep`.
 */
export function normalizeEol(content: string, eol: 'lf' | 'crlf' | 'keep' | undefined): string {
    if (eol === 'lf') { return content.replace(/\r\n/g, '\n'); }
    if (eol === 'crlf') { return content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'); }
    return content;
}

/**
 * Encode `content` into a Buffer for `writeFile` / `appendFile`.
 *   - `utf8`    : plain UTF-8 bytes, no BOM.
 *   - `utf8bom` : UTF-8 bytes prefixed with the 3-byte BOM (EF BB BF). When
 *                 `includeBom` is false (e.g. append to an existing file) the
 *                 BOM is omitted so we do not plant a BOM mid-file.
 *   - `ascii`   : Node's `ascii` encoding; non-ASCII characters get replaced
 *                 by `?` — callers should validate inputs if that matters.
 */
export function encodeFileContent(
    content: string,
    encoding: 'utf8' | 'utf8bom' | 'ascii' | undefined,
    includeBom: boolean = true
): Buffer {
    if (encoding === 'ascii') {
        return Buffer.from(content, 'ascii');
    }
    if (encoding === 'utf8bom') {
        const utf8 = Buffer.from(content, 'utf8');
        return includeBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]) : utf8;
    }
    return Buffer.from(content, 'utf8');
}

/**
 * Race `promise` against a timer of `timeoutSeconds`. On timeout, rejects with
 * an Error whose message includes `taskId`. When the timer fires, `onTimeout`
 * is invoked so the caller can kick off side-effect cleanup (e.g. terminate a
 * running child process); the original `promise` still runs to completion but
 * its eventual result is discarded. A non-positive or undefined
 * `timeoutSeconds` disables the timeout entirely and returns `promise` as-is.
 *
 * This helper is intentionally free of `vscode` dependencies so it can be
 * unit-tested in isolation. It does NOT silence unhandled rejections from the
 * original promise — callers should attach a catch handler if the task is
 * expected to reject after the timeout.
 */
export function withTaskTimeout<T>(
    promise: Promise<T>,
    timeoutSeconds: number | undefined,
    taskId: string,
    onTimeout?: () => void
): Promise<T> {
    if (!timeoutSeconds || timeoutSeconds <= 0 || !Number.isFinite(timeoutSeconds)) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) { return; }
            settled = true;
            try { onTimeout?.(); } catch { /* swallow — best effort */ }
            const timeoutError = new Error(`Task '${taskId}' timed out after ${timeoutSeconds}s.`);
            // 호출부가 실패 원인을 **분류**해야 한다(비밀을 쓰는 태스크는 상세
            // 출력을 가리는 대신 단계만 보여 준다). 메시지 문자열 매칭은 문구가
            // 바뀌면 조용히 깨지므로 이름을 남긴다.
            timeoutError.name = 'TaskTimeoutError';
            reject(timeoutError);
        }, timeoutSeconds * 1000);
        promise.then(
            value => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            err => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        );
        // Swallow unhandled rejection if the task settles *after* a timeout.
        // We already surfaced the timeout error above; the original error is
        // just noise at that point.
        promise.catch(() => { /* already reported via timeout */ });
    });
}
