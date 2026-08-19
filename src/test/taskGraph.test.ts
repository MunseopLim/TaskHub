import * as assert from 'assert';
import {
    extractVariableHeads,
    inferTaskDependencies,
    buildTaskGraph,
    detectGraphCycle,
    validateTaskGraph,
    formatGraphIssue,
    formatCyclePath,
    actionUsesParallelTasks,
    TaskScheduler,
    extractVariableReferences,
    evaluateTaskCondition,
    shouldSkipForSkippedDependencies,
} from '../pipelineUtils';
import type { Task } from '../schema';

/**
 * Direct imports from ../pipelineUtils — the graph utilities must
 * stay free of `vscode` so the runtime scheduler decisions are
 * unit-testable independent of the executor.
 */

// Helper: minimal Task literal that satisfies the type checker without
// pulling in every optional field. The graph utilities only read `id`,
// `dependsOn`, `parallel`, and string leaves anywhere in the object.
function mkTask(partial: Partial<Task> & { id: string }): Task {
    return { type: 'shell', ...partial } as Task;
}

suite('extractVariableHeads', () => {
    test('returns empty for non-strings and empty strings', () => {
        assert.deepStrictEqual(extractVariableHeads(''), []);
        assert.deepStrictEqual(extractVariableHeads(undefined as any), []);
        assert.deepStrictEqual(extractVariableHeads(null as any), []);
        assert.deepStrictEqual(extractVariableHeads(42 as any), []);
    });

    test('extracts head before the first dot', () => {
        assert.deepStrictEqual(extractVariableHeads('${buildA.output}'), ['buildA']);
    });

    test('returns dotless expression unchanged', () => {
        assert.deepStrictEqual(extractVariableHeads('${name}'), ['name']);
    });

    /**
     * `??` 체인은 **모든 대안**을 의존성으로 내야 한다.
     *
     * 하나만 잡으면 소비자가 살아남은 쪽이 값을 내기 전에 실행된다 — 조건으로
     * 갈린 분기에서 정확히 그 일이 난다: 꺼진 쪽은 즉시 settle 하므로, 그쪽만
     * 의존성으로 잡히면 실행 중인 쪽을 기다리지 않는다.
     */
    test('?? 체인의 대안을 모두 head 로 낸다', () => {
        assert.deepStrictEqual(extractVariableHeads('${pickFile.path ?? pickFolder.path}'), ['pickFile', 'pickFolder']);
        assert.deepStrictEqual(extractVariableHeads('${a.x ?? b.y ?? c.z}'), ['a', 'b', 'c']);
        assert.deepStrictEqual(extractVariableHeads('${a.x??b.y}'), ['a', 'b'], '공백 없이 써도 같아야 한다');
    });

    test('?? 가 없는 참조는 한 글자도 다듬지 않는다', () => {
        // 스키마는 태스크 id 에 공백을 금지하지 않는다. 다듬으면 의존성은
        // `producer` 로 잡히는데 런타임은 `" producer"` 를 못 찾아 리터럴로
        // 남는다 — 순서만 잡히고 값은 안 오는 상태가 된다.
        assert.deepStrictEqual(extractVariableHeads('${ producer.output}'), [' producer']);
    });

    test('extracts multiple heads in declaration order', () => {
        assert.deepStrictEqual(
            extractVariableHeads('${A.output} -- ${B.outputDir}/${C}'),
            ['A', 'B', 'C']
        );
    });

    test('preserves colon-prefixed built-in heads literally', () => {
        assert.deepStrictEqual(
            extractVariableHeads('${input:port} ${env:HOME}'),
            ['input:port', 'env:HOME']
        );
    });

    test('ignores non-${...} braces', () => {
        assert.deepStrictEqual(extractVariableHeads('plain {x} text'), []);
    });
});

suite('inferTaskDependencies — auto-inference from ${taskId.x}', () => {
    const validIds = new Set(['A', 'B', 'C']);

    test('infers from `args` array', () => {
        const task = mkTask({ id: 'D', args: ['--input=${A.output}'] });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], ['A']);
    });

    test('infers from `command` string', () => {
        const task = mkTask({ id: 'D', command: 'gcc ${A.output} -o out' });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], ['A']);
    });

    test('platform-branched `command` object: only the active branch is scanned', () => {
        // Pre-fix this test asserted the union of all three branches' deps,
        // which produced false-positive cycles for cross-platform actions
        // where each platform separately resolves to a valid DAG. The
        // runtime only executes one branch (`getCommandString`), so
        // inference now mirrors that.
        const task = mkTask({
            id: 'D',
            command: { windows: 'gcc ${A.output}', macos: 'cc ${B.output}', linux: 'cc ${C.output}' },
        });
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'win32' })],
            ['A']
        );
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'darwin' })],
            ['B']
        );
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'linux' })],
            ['C']
        );
    });

    test('platform-branched `tool` object: only the active branch is scanned', () => {
        const task = mkTask({
            id: 'D',
            type: 'unzip',
            tool: { windows: '${A.output}', macos: '${B.output}', linux: '${C.output}' },
        } as any);
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'win32' })],
            ['A']
        );
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'linux' })],
            ['C']
        );
    });

    test('platform-branched `itemsFromCommand` object: only the active branch is scanned', () => {
        const task = mkTask({
            id: 'D',
            type: 'quickPick',
            itemsFromCommand: { windows: '${A.output}', macos: '${B.output}', linux: '${C.output}' },
        } as any);
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'win32' })],
            ['A']
        );
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'darwin' })],
            ['B']
        );
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'linux' })],
            ['C']
        );
    });

    test('quickPick with itemsFromCommand ignores static `items` in inference', () => {
        // Runtime overwrites the pick list with command output, so a stale
        // ${A.output} left in `items` must not become a dep. The ref inside
        // itemsFromCommand (${B.output}) still counts.
        const task = mkTask({
            id: 'D',
            type: 'quickPick',
            items: ['${A.output}'],
            itemsFromCommand: 'list ${B.output}',
        } as any);
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds)],
            ['B']
        );
    });

    test('itemsFromCommand는 축약형의 죽은 label·value·args 참조도 제외한다', () => {
        const task = mkTask({
            id: 'D', type: 'quickPick',
            items: {
                '${A.output}': { value: '${C.output}', args: '${A.output}' },
            },
            itemsFromCommand: 'list ${B.output}',
        } as any);
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], ['B']);
    });

    test('빈 itemsFromCommand는 정적 items의 의존성을 유지한다', () => {
        const task = mkTask({
            id: 'D', type: 'quickPick', itemsFromCommand: '', items: ['${A.output}'],
        } as any);
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], ['A']);
    });

    test('quickPick drops `items` even when itemsFromCommand lacks a branch for the platform', () => {
        // itemsFromCommand present (object) → static items never executes: on
        // win32 the command runs (items ignored); on linux the dispatcher's
        // getCommandString throws (no linux branch, no fallback to items).
        // Either way `items` is dead, so its ${A.output} must never be a dep.
        const task = mkTask({
            id: 'D',
            type: 'quickPick',
            items: ['${A.output}'],
            itemsFromCommand: { windows: 'list ${B.output}' },
        } as any);
        // linux: items dropped, windows branch not active → no deps at all.
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'linux' })],
            []
        );
        // win32: items dropped, windows branch active → only ${B.output}.
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'win32' })],
            ['B']
        );
    });

    test('platform branch missing for current platform is dropped from inference', () => {
        // Only `windows` defined → on linux, no inference contribution
        // (the runtime would also throw at execution time, but the graph
        // builder must not invent a dep for an unrunnable branch).
        const task = mkTask({
            id: 'D',
            command: { windows: 'gcc ${A.output}' },
        });
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'linux' })],
            []
        );
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, validIds, { platform: 'win32' })],
            ['A']
        );
    });

    test('reserved variable head도 동명 task가 있으면 기존 bare 의존성이다', () => {
        const idsIncludingReserved = new Set(['workspaceFolder', 'extensionPath', 'A']);
        const task = mkTask({
            id: 'A',
            args: ['${workspaceFolder}/build', '${extensionPath}/util'],
        });
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, idsIncludingReserved)],
            ['workspaceFolder', 'extensionPath']
        );
    });

    test('forEach 소스의 each는 producer 의존성이고 본문의 each는 지역값이다', () => {
        const ids = new Set(['each', 'run']);
        assert.deepStrictEqual(
            [...inferTaskDependencies(mkTask({
                id: 'run',
                forEach: '${each.valueList}',
                command: 'tool',
                args: ['${each.value}'],
            }), ids)],
            ['each']
        );
    });

    test('reserved 이름도 속성 참조라면 동명 task 의존성으로 추론한다', () => {
        const ids = new Set(['file', 'workspaceFolder', 'A']);
        assert.deepStrictEqual(
            [...inferTaskDependencies(mkTask({
                id: 'A',
                args: ['${file.path}', '${workspaceFolder.value}', '${file}'],
            }), ids)].sort(),
            ['file', 'workspaceFolder']
        );
    });

    test('env:/input: prefixed heads are treated as built-ins (not deps)', () => {
        // Even if a task literally named `env:HOME` exists in the same
        // action (the schema does not forbid colons in task ids),
        // `${env:HOME}` is still the VS Code-style built-in and not a
        // task reference — that's how users author actions.json today.
        const idsIncludingColons = new Set(['env:HOME', 'input:port']);
        const task = mkTask({ id: 'D', args: ['${env:HOME}', '${input:port}'] });
        assert.deepStrictEqual(
            [...inferTaskDependencies(task, idsIncludingColons)],
            []
        );
    });

    test('colon-containing task ids without a reserved prefix ARE inferred as deps', () => {
        // Pre-fix the inference loop did `head.includes(':')` and dropped
        // every colon-bearing reference. The schema does not forbid
        // colons in ids, so a user with `id: 'build:fw'` and a sibling
        // referencing `${build:fw.output}` was silently denied the
        // auto-inferred dep — letting a `parallel: true` consumer race
        // its producer.
        const ids = new Set(['build:fw', 'pkg:linux-arm', 'A']);
        const task = mkTask({ id: 'A', args: ['use ${build:fw.output} and ${pkg:linux-arm.outputDir}'] });
        const deps = [...inferTaskDependencies(task, ids)].sort();
        assert.deepStrictEqual(deps, ['build:fw', 'pkg:linux-arm']);
    });

    test('reserved prefix narrowed to env:/input: only — other prefixes are not built-ins', () => {
        // Defensive coverage for the prefix-list specificity: `myns:` is
        // not in `RESERVED_HEAD_PREFIXES`, so a task literally named
        // `myns:thing` is still a valid dep target.
        const ids = new Set(['myns:thing', 'A']);
        const task = mkTask({ id: 'A', args: ['${myns:thing.output}'] });
        assert.deepStrictEqual([...inferTaskDependencies(task, ids)], ['myns:thing']);
    });

    test('infers from `env` map values', () => {
        const task = mkTask({ id: 'D', env: { OUT_FILE: '${B.output}' } });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], ['B']);
    });

    test('infers from `output.filePath` and `output.content`', () => {
        // `passTheResultToNextTask` 가 있어야 런타임이 `output` 을 읽는다 —
        // 없으면 그 subtree 는 죽은 필드다(아래 테스트).
        const task = mkTask({
            id: 'D',
            passTheResultToNextTask: true,
            output: { mode: 'file', filePath: '${A.outputDir}/report.txt', content: 'value: ${B.output}' },
        } as any);
        const deps = [...inferTaskDependencies(task, validIds)].sort();
        assert.deepStrictEqual(deps, ['A', 'B']);
    });

    test('`output` subtree is dead without `passTheResultToNextTask`', () => {
        // 런타임은 `passTheResultToNextTask && task.output` 일 때만 이 subtree 를
        // 보간한다(`extension.ts`). 이 바깥에서 쓰이는 것은 `capture` ·
        // `diagnostics` 뿐이고 둘 다 정규식이라 애초에 제외돼 있다.
        for (const output of [
            { mode: 'file', filePath: '${A.output}', content: '${B.output}' },
            { mode: 'editor', content: '${B.output}' },
            { content: '${B.output}' },
        ]) {
            const task = mkTask({ id: 'D', output } as any);
            assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], [],
                `passTheResultToNextTask 없이 ${JSON.stringify(output)} 에서 의존성을 만들었다`);
        }
    });

    test('`output.language` is never interpolated', () => {
        // 런타임은 `...task.output` 로 받은 값을 그대로 쓴다
        // (`language: interpolatedOutput.language || 'plaintext'`). 보간되지 않는
        // 자리를 읽으면 반대 방향의 진짜 참조와 만나 가짜 순환을 만든다.
        const task = mkTask({
            id: 'D',
            passTheResultToNextTask: true,
            output: { mode: 'editor', language: '${A.value}' },
        } as any);
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);

        const graph = buildTaskGraph([
            mkTask({ id: 'B', passTheResultToNextTask: true, output: { mode: 'editor', language: '${A.value}' } } as any),
            mkTask({ id: 'A', command: 'echo ${B.output}' }),
        ], { platform: 'linux' });
        assert.strictEqual(detectGraphCycle(graph), null, '`language` 가 가짜 순환을 만들었다');
    });

    test('`output.filePath` / `overwrite` are dead unless `mode: "file"`', () => {
        // 런타임은 `mode === 'file'` 일 때만 이 둘을 읽는다(`writesFile`). 다른
        // 모드에 남은 오래된 참조가 의존성을 만들면 대가가 크다 — 반대 방향의
        // 진짜 참조와 만나면 **가짜 순환으로 액션 전체가 거부**되고, 조건으로 꺼진
        // 태스크 때문에 뒤 태스크까지 조용히 skip 된다.
        for (const mode of ['editor', 'terminal', undefined]) {
            const task = mkTask({
                id: 'D',
                passTheResultToNextTask: true,
                output: { ...(mode ? { mode } : {}), filePath: '${A.output}', overwrite: '${B.output}' },
            } as any);
            assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], [],
                `mode=${mode} 인데 죽은 필드에서 의존성을 만들었다`);
        }

        // `content` 는 모드와 무관하게 쓰인다 — 계속 의존성이다.
        const withContent = mkTask({
            id: 'D',
            passTheResultToNextTask: true,
            output: { mode: 'editor', filePath: '${A.output}', content: '${B.output}' },
        } as any);
        assert.deepStrictEqual([...inferTaskDependencies(withContent, validIds)], ['B']);
    });

    test('stale `output.filePath` no longer fabricates a cycle', () => {
        // 실제 실행상 DAG(B 먼저, A 가 B 를 참조)인데 B 의 죽은 `filePath` 에 남은
        // `${A.value}` 가 `B → A` 를 만들어 액션 전체가 거부됐다.
        for (const dead of [
            { passTheResultToNextTask: true, output: { mode: 'editor', filePath: '${A.value}' } },
            { output: { mode: 'file', filePath: '${A.value}' } },       // 플래그가 없어 subtree 전체가 죽었다
        ]) {
            const graph = buildTaskGraph([
                mkTask({ id: 'B', ...dead } as any),
                mkTask({ id: 'A', command: 'echo ${B.output}' }),
            ], { platform: 'linux' });
            assert.deepStrictEqual([...graph.nodes.get('B')!.allDeps], [],
                `죽은 필드에서 의존성을 만들었다: ${JSON.stringify(dead)}`);
            assert.strictEqual(detectGraphCycle(graph), null, '죽은 필드가 가짜 순환을 만들었다');
        }

        // 둘 다 살아 있으면 그 참조는 진짜이므로 순환이 맞다.
        const live = buildTaskGraph([
            mkTask({ id: 'B', passTheResultToNextTask: true, output: { mode: 'file', filePath: '${A.value}' } } as any),
            mkTask({ id: 'A', command: 'echo ${B.output}' }),
        ], { platform: 'linux' });
        assert.ok(detectGraphCycle(live), '살아 있는 참조의 순환을 놓쳤다');
    });

    test('infers from quickPick items (string and object form)', () => {
        const task = mkTask({
            id: 'D',
            type: 'quickPick',
            items: ['${A.output}', { label: '${B.output}', description: '${C.output}' } as any],
        });
        const deps = [...inferTaskDependencies(task, validIds)].sort();
        assert.deepStrictEqual(deps, ['A', 'B', 'C']);
    });

    test('infers from interactive prompt fields (inputBox)', () => {
        const task = mkTask({
            id: 'D',
            type: 'inputBox',
            prompt: 'value for ${A.output}?',
            placeHolder: '${B.output}',
        });
        const deps = [...inferTaskDependencies(task, validIds)].sort();
        assert.deepStrictEqual(deps, ['A', 'B']);
    });

    test('excludes self-reference (B → ${B.output})', () => {
        const task = mkTask({ id: 'B', args: ['--in=${B.output}'] });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);
    });

    test('drops references to unknown ids (built-ins like ${workspaceFolder})', () => {
        const task = mkTask({ id: 'D', args: ['${workspaceFolder}/build', '${env:HOME}', '${input:port}'] });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);
    });

    test('ignores ${...} inside output.capture[].regex (skip subtree)', () => {
        const task = mkTask({
            id: 'D',
            output: {
                capture: [{ name: 'foo', regex: 'SIZE=([0-9]+) for \\${A.output}', group: 1 } as any],
            },
        });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);
    });

    test('ignores ${...} inside output.diagnostics (skip subtree)', () => {
        const task = mkTask({
            id: 'D',
            output: {
                diagnostics: [{ regex: 'use ${A.output}', file: 1 } as any],
            },
        });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);
    });

    test('returns deduped set across multiple references', () => {
        const task = mkTask({
            id: 'D',
            command: '${A.output} ${A.outputDir} ${A}',
            args: ['${A.foo}'],
        });
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], ['A']);
    });

    test('unzip.inputs bare task-id refs are inferred as deps', () => {
        // `handleUnzip` reads `task.inputs.archive` / `inputs.file` /
        // `inputs.destination` as raw task ids (no `${...}` wrapping)
        // and looks them up in allResults. Without inferring these, a
        // `parallel: true` unzip following a zip can be scheduled
        // before the zip has populated allResults and fails with
        // "requires an archive path".
        const task = mkTask({
            id: 'unz',
            type: 'unzip',
            inputs: { archive: 'A', destination: 'B' },
        } as any);
        const deps = [...inferTaskDependencies(task, validIds)].sort();
        assert.deepStrictEqual(deps, ['A', 'B']);
    });

    test('inputs values that do not match valid task ids are not deps', () => {
        // Unrelated strings (literal paths, format names) sometimes
        // sit in `inputs` — only match valid task ids so they don't
        // become bogus deps.
        const task = mkTask({
            id: 'unz',
            type: 'unzip',
            inputs: { archive: '/abs/path/to/file.zip', tool: '7z' },
        } as any);
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);
    });

    test('inputs values pointing to self are filtered out', () => {
        const task = mkTask({
            id: 'A',
            type: 'unzip',
            inputs: { archive: 'A' },
        } as any);
        assert.deepStrictEqual([...inferTaskDependencies(task, validIds)], []);
    });
});

suite('buildTaskGraph — Option 2 sync barrier semantics', () => {
    test('empty array produces empty graph', () => {
        const g = buildTaskGraph([]);
        assert.strictEqual(g.nodes.size, 0);
        assert.deepStrictEqual([...g.order], []);
    });

    test('single task has no deps', () => {
        const g = buildTaskGraph([mkTask({ id: 'A' })]);
        const a = g.nodes.get('A')!;
        assert.deepStrictEqual([...a.allDeps], []);
        assert.strictEqual(a.parallel, false);
    });

    test('[A, B] sequential: B barriers on A', () => {
        const g = buildTaskGraph([mkTask({ id: 'A' }), mkTask({ id: 'B' })]);
        assert.deepStrictEqual([...g.nodes.get('A')!.allDeps], []);
        assert.deepStrictEqual([...g.nodes.get('B')!.barrierDeps], ['A']);
        assert.deepStrictEqual([...g.nodes.get('B')!.allDeps], ['A']);
    });

    test('[A, B(parallel)] — B skips barrier on A', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', parallel: true }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('B')!.barrierDeps], []);
        assert.deepStrictEqual([...g.nodes.get('B')!.allDeps], []);
    });

    test('[A, B(parallel), C(parallel), D] — D barriers on all three', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', parallel: true }),
            mkTask({ id: 'C', parallel: true }),
            mkTask({ id: 'D' }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('A')!.allDeps], []);
        assert.deepStrictEqual([...g.nodes.get('B')!.allDeps], []);
        assert.deepStrictEqual([...g.nodes.get('C')!.allDeps], []);
        const dDeps = [...g.nodes.get('D')!.allDeps].sort();
        assert.deepStrictEqual(dDeps, ['A', 'B', 'C']);
    });

    test('parallel: true with explicit dependsOn keeps the dep', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', parallel: true, dependsOn: ['A'] }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('B')!.explicitDeps], ['A']);
        assert.deepStrictEqual([...g.nodes.get('B')!.allDeps], ['A']);
    });

    test('parallel: true picks up auto-inferred deps from ${A.output}', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', parallel: true, args: ['--in=${A.output}'] }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('B')!.inferredDeps], ['A']);
        assert.deepStrictEqual([...g.nodes.get('B')!.allDeps], ['A']);
    });

    test('parallel: true unzip with inputs.archive bare ref still serializes after zip', () => {
        // Regression: pre-0.4.44 inferTaskDependencies missed bare-id
        // refs inside `task.inputs`, so an unzip with `parallel: true`
        // could start before the upstream zip populated allResults.
        // The graph must now show the inferred dep.
        const g = buildTaskGraph([
            mkTask({ id: 'zip', type: 'zip', archive: 'out.zip', source: ['a.txt'] } as any),
            mkTask({ id: 'unz', type: 'unzip', parallel: true, inputs: { archive: 'zip' } } as any),
        ]);
        assert.deepStrictEqual([...g.nodes.get('unz')!.inferredDeps], ['zip']);
        assert.deepStrictEqual([...g.nodes.get('unz')!.allDeps], ['zip']);
    });

    test('self-dependsOn is dropped', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', dependsOn: ['A'] }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('A')!.explicitDeps], []);
        assert.deepStrictEqual([...g.nodes.get('A')!.allDeps], []);
    });

    test('missing dependsOn is preserved by default (executor surfaces it)', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', dependsOn: ['nonexistent'] }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('A')!.explicitDeps], ['nonexistent']);
    });

    test('dropMissingDeps strips missing explicit deps', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', dependsOn: ['nonexistent'] }),
        ], { dropMissingDeps: true });
        assert.deepStrictEqual([...g.nodes.get('A')!.explicitDeps], []);
    });

    test('explicit + inferred + barrier collapse to single allDeps set', () => {
        // B is sequential (barrier on A), also auto-infers A, and explicitly
        // depends on A. All three should collapse to just {A}.
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', dependsOn: ['A'], args: ['${A.output}'] }),
        ]);
        const b = g.nodes.get('B')!;
        assert.deepStrictEqual([...b.explicitDeps], ['A']);
        assert.deepStrictEqual([...b.inferredDeps], ['A']);
        assert.deepStrictEqual([...b.barrierDeps], ['A']);
        assert.deepStrictEqual([...b.allDeps], ['A']);
    });

    test('order preserves original declaration order', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'first' }),
            mkTask({ id: 'second' }),
            mkTask({ id: 'third' }),
        ]);
        assert.deepStrictEqual([...g.order], ['first', 'second', 'third']);
    });

    test('first task is never blocked even if parallel: false', () => {
        const g = buildTaskGraph([mkTask({ id: 'only' })]);
        assert.deepStrictEqual([...g.nodes.get('only')!.allDeps], []);
    });
});

suite('detectGraphCycle', () => {
    test('returns null for a DAG', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', dependsOn: ['A'] }),
            mkTask({ id: 'C', dependsOn: ['B'] }),
        ]);
        assert.strictEqual(detectGraphCycle(g), null);
    });

    test('detects 2-cycle through dependsOn', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', dependsOn: ['B'] }),
            mkTask({ id: 'B', dependsOn: ['A'] }),
        ]);
        const cycle = detectGraphCycle(g);
        assert.ok(cycle, 'expected a cycle to be reported');
        // Cycle closes on the same node — first and last entries match.
        assert.strictEqual(cycle![0], cycle![cycle!.length - 1]);
        // 경로 자체가 사용자에게 보인다(`formatGraphIssue` · `dependsOn.cycle`) —
        // 순회 순서를 바꾸면 여기서 잡힌다.
        assert.deepStrictEqual(cycle, ['A', 'B', 'A']);
    });

    test('detects 3-cycle through dependsOn', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', dependsOn: ['C'] }),
            mkTask({ id: 'B', dependsOn: ['A'] }),
            mkTask({ id: 'C', dependsOn: ['B'] }),
        ]);
        const cycle = detectGraphCycle(g);
        assert.ok(cycle);
        assert.strictEqual(cycle![0], cycle![cycle!.length - 1]);
        assert.deepStrictEqual(cycle, ['A', 'C', 'B', 'A']);
    });

    test('survives a cycle whose path spans the whole pipeline', () => {
        // `barrierDeps` 가 "직전 순차 태스크"로 축약되면서 순차 파이프라인은
        // 조밀 그래프가 아니라 **사슬**이 됐고, DFS 깊이가 태스크 수만큼 자란다.
        // 재귀 DFS 는 여기서 `RangeError: Maximum call stack size exceeded` 로
        // 죽었다 — 조밀 그래프에서는 마지막 태스크가 `T0` 에 직접 붙어 순환이
        // 짧게 발견돼 드러나지 않던 자리다.
        const N = 12000;
        const tasks = [mkTask({ id: 'T0', command: `use \${T${N - 1}.output}` })];
        for (let i = 1; i < N; i++) { tasks.push(mkTask({ id: `T${i}` })); }

        const g = buildTaskGraph(tasks, { platform: 'linux' });
        assert.strictEqual(g.nodes.size, N);
        const cycle = detectGraphCycle(g);
        assert.ok(cycle, '긴 경로의 순환을 찾지 못했다');
        assert.strictEqual(cycle![0], cycle![cycle!.length - 1]);
    });

    test('returns null for a deep acyclic chain', () => {
        // 순환이 없을 때도 끝까지 내려간다.
        //
        // 의존성을 **앞으로** 걸어야 실제로 깊어진다. 뒤로 거는 사슬
        // (`T_i → T_{i-1}`, 순차 배리어가 만드는 모양)은 루트를 선언 순서로 도는
        // 탓에 `T0` 가 먼저 BLACK 이 되어 최대 깊이가 2 다 — 재귀 구현으로도
        // 통과하므로 회귀 테스트가 되지 못한다. `parallel: true` 로 두어 배리어가
        // 반대 방향 간선을 덧붙이지 않게 한다.
        const N = 12000;
        const tasks: Task[] = [];
        for (let i = 0; i < N; i++) {
            tasks.push(mkTask({ id: `T${i}`, parallel: true, dependsOn: i + 1 < N ? [`T${i + 1}`] : [] }));
        }
        assert.strictEqual(detectGraphCycle(buildTaskGraph(tasks, { platform: 'linux' })), null);
    });

    test('formatGraphIssue folds a pipeline-length cycle path', () => {
        // 실행 오류 메시지와 Preview 보고서도 같은 경로를 싣는다. Doctor 만
        // 접으면 여기서 12,000개가 그대로 쏟아진다(측정: 108,910자) —
        // 반복 DFS 로 스택 오버플로가 사라지면서 **새로 도달 가능해진** 자리다.
        const N = 12000;
        const tasks = [mkTask({ id: 'T0', command: `use \${T${N - 1}.output}` })];
        for (let i = 1; i < N; i++) { tasks.push(mkTask({ id: `T${i}` })); }

        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks, { platform: 'linux' }));
        const cycle = issues.find(i => i.kind === 'cycle');
        assert.ok(cycle, '순환을 찾지 못했다');

        const rendered = formatGraphIssue(cycle!);
        assert.ok(rendered.length < 300, `실행용 메시지가 여전히 길다 (${rendered.length}자)`);
        assert.ok(rendered.includes('more)'), `경로를 접지 않았다: ${rendered.slice(0, 200)}`);
        // 양 끝은 남는다 — 순환이 닫히는 지점이 보여야 고칠 수 있다.
        assert.ok(rendered.includes('T0 ->') && rendered.endsWith('-> T0'),
            `순환이 닫히는 지점을 잘라 냈다: ${rendered.slice(0, 200)}`);
    });

    test('formatCyclePath leaves short paths alone and honors the separator', () => {
        assert.strictEqual(formatCyclePath(['A', 'B', 'A']), 'A -> B -> A');
        // Preview Run 은 유니코드 화살표를 쓴다 — 같은 함수를 공유하되 표기만 다르다.
        assert.strictEqual(formatCyclePath(['A', 'B', 'A'], ' → '), 'A → B → A');
        // 경계: 13개(=6*2+1)까지는 그대로, 14개부터 접는다.
        const ids = (n: number) => Array.from({ length: n }, (_, i) => `T${i}`);
        assert.ok(!formatCyclePath(ids(13)).includes('more)'));
        assert.ok(formatCyclePath(ids(14)).includes('(2 more)'));
    });

    test('detects cycle through auto-inferred dependency', () => {
        // A and B both reference each other's output → mutual auto-inference.
        const g = buildTaskGraph([
            mkTask({ id: 'A', parallel: true, args: ['${B.output}'] }),
            mkTask({ id: 'B', parallel: true, args: ['${A.output}'] }),
        ]);
        const cycle = detectGraphCycle(g);
        assert.ok(cycle, 'auto-inference must participate in cycle detection');
    });

    test('cross-platform branches that conflict only in the union do NOT raise a cycle', () => {
        // X and Y are both parallel. On Windows, X needs Y. On Linux,
        // Y needs X. Each platform on its own resolves to a valid DAG;
        // pre-fix `inferTaskDependencies` walked all branches and
        // produced the union {X→Y, Y→X} which `detectGraphCycle`
        // (correctly) flagged — falsely rejecting a legal action.
        const tasks = [
            mkTask({
                id: 'X',
                parallel: true,
                command: { windows: 'use ${Y.output}', linux: 'build' },
            } as any),
            mkTask({
                id: 'Y',
                parallel: true,
                command: { windows: 'build', linux: 'use ${X.output}' },
            } as any),
        ];
        const winGraph = buildTaskGraph(tasks, { platform: 'win32' });
        assert.deepStrictEqual([...winGraph.nodes.get('X')!.inferredDeps], ['Y']);
        assert.deepStrictEqual([...winGraph.nodes.get('Y')!.inferredDeps], []);
        assert.strictEqual(detectGraphCycle(winGraph), null,
            'no cycle should be reported on Windows when only the windows branch is scanned');

        const linuxGraph = buildTaskGraph(tasks, { platform: 'linux' });
        assert.deepStrictEqual([...linuxGraph.nodes.get('X')!.inferredDeps], []);
        assert.deepStrictEqual([...linuxGraph.nodes.get('Y')!.inferredDeps], ['X']);
        assert.strictEqual(detectGraphCycle(linuxGraph), null,
            'no cycle should be reported on Linux when only the linux branch is scanned');
    });

    test('task id가 `workspaceFolder`와 같으면 bare 참조도 실제 cycle을 만든다', () => {
        // 내장 이름과 같은 기존 task는 호환성을 위해 우선한다. 따라서 X의 bare
        // 참조도 그 task 의존성이고, 반대 참조와 만나면 숨기지 말아야 할 cycle이다.
        const g = buildTaskGraph([
            mkTask({ id: 'X', parallel: true, args: ['${workspaceFolder}/build'] }),
            mkTask({ id: 'workspaceFolder', parallel: true, args: ['${X.output}'] }),
        ]);
        assert.deepStrictEqual([...g.nodes.get('X')!.inferredDeps], ['workspaceFolder']);
        assert.deepStrictEqual(
            [...g.nodes.get('workspaceFolder')!.inferredDeps],
            ['X']
        );
        assert.deepStrictEqual(detectGraphCycle(g), ['X', 'workspaceFolder', 'X']);
    });
});

suite('actionUsesParallelTasks', () => {
    test('returns false for an empty action', () => {
        assert.strictEqual(actionUsesParallelTasks({ tasks: [] }), false);
    });

    test('returns false when no task has parallel: true', () => {
        const tasks = [mkTask({ id: 'A' }), mkTask({ id: 'B' })];
        assert.strictEqual(actionUsesParallelTasks({ tasks }), false);
    });

    test('returns true if any task is parallel: true', () => {
        const tasks = [mkTask({ id: 'A' }), mkTask({ id: 'B', parallel: true }), mkTask({ id: 'C' })];
        assert.strictEqual(actionUsesParallelTasks({ tasks }), true);
    });

    test('treats parallel: false explicitly as not-parallel', () => {
        const tasks = [mkTask({ id: 'A', parallel: false } as any)];
        assert.strictEqual(actionUsesParallelTasks({ tasks }), false);
    });
});

suite('validateTaskGraph', () => {
    test('returns empty array for a clean DAG', () => {
        const tasks = [mkTask({ id: 'A' }), mkTask({ id: 'B', dependsOn: ['A'] })];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        assert.deepStrictEqual(issues, []);
    });

    test('reports self-dependency even though buildTaskGraph drops it', () => {
        const tasks = [mkTask({ id: 'A', dependsOn: ['A'] })];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        assert.deepStrictEqual(issues, [{ kind: 'self-dependency', taskId: 'A' }]);
    });

    test('reports missing dependency that buildTaskGraph preserves', () => {
        const tasks = [mkTask({ id: 'A', dependsOn: ['ghost'] })];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        assert.deepStrictEqual(issues, [
            { kind: 'missing-dependency', taskId: 'A', missingId: 'ghost' },
        ]);
    });

    test('reports missing deps in task declaration order', () => {
        const tasks = [
            mkTask({ id: 'B', dependsOn: ['ghost2'] }),
            mkTask({ id: 'A', dependsOn: ['ghost1'] }),
        ];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        assert.deepStrictEqual(issues, [
            { kind: 'missing-dependency', taskId: 'B', missingId: 'ghost2' },
            { kind: 'missing-dependency', taskId: 'A', missingId: 'ghost1' },
        ]);
    });

    test('reports cycle through dependsOn', () => {
        const tasks = [
            mkTask({ id: 'A', dependsOn: ['B'] }),
            mkTask({ id: 'B', dependsOn: ['A'] }),
        ];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        const cycleIssue = issues.find(i => i.kind === 'cycle');
        assert.ok(cycleIssue, 'expected a cycle issue');
        assert.ok(Array.isArray((cycleIssue as any).cycle));
    });

    test('reports cycle through auto-inferred dependency', () => {
        const tasks = [
            mkTask({ id: 'A', parallel: true, args: ['${B.output}'] }),
            mkTask({ id: 'B', parallel: true, args: ['${A.output}'] }),
        ];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        assert.ok(issues.some(i => i.kind === 'cycle'));
    });

    test('reports multiple kinds of issues together', () => {
        const tasks = [
            mkTask({ id: 'A', dependsOn: ['A'] }),
            mkTask({ id: 'B', dependsOn: ['ghost'] }),
            mkTask({ id: 'C', dependsOn: ['D'] }),
            mkTask({ id: 'D', dependsOn: ['C'] }),
        ];
        const issues = validateTaskGraph(tasks, buildTaskGraph(tasks));
        // Order: self/missing in declaration order, then a single cycle.
        assert.deepStrictEqual(issues[0], { kind: 'self-dependency', taskId: 'A' });
        assert.deepStrictEqual(issues[1], { kind: 'missing-dependency', taskId: 'B', missingId: 'ghost' });
        assert.ok(issues.some(i => i.kind === 'cycle'));
    });
});

suite('TaskScheduler', () => {
    test('throws when maxConcurrency < 1', () => {
        const g = buildTaskGraph([mkTask({ id: 'A' })]);
        assert.throws(() => new TaskScheduler(g, { maxConcurrency: 0 }));
        assert.throws(() => new TaskScheduler(g, { maxConcurrency: -1 }));
        assert.throws(() => new TaskScheduler(g, { maxConcurrency: NaN }));
    });

    test('empty graph is finished immediately', () => {
        const s = new TaskScheduler(buildTaskGraph([]), { maxConcurrency: 4 });
        assert.strictEqual(s.isFinished(), true);
        assert.deepStrictEqual(s.nextReady(), []);
    });

    test('single task lifecycle', () => {
        const g = buildTaskGraph([mkTask({ id: 'A' })]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        assert.deepStrictEqual(s.nextReady(), ['A']);
        s.markStarted('A');
        assert.strictEqual(s.runningCount(), 1);
        assert.deepStrictEqual(s.nextReady(), []);
        s.markCompleted('A');
        assert.strictEqual(s.runningCount(), 0);
        assert.strictEqual(s.isFinished(), true);
    });

    test('three independent parallel tasks all ready at once with maxConcurrency=4', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', parallel: true }),
            mkTask({ id: 'B', parallel: true }),
            mkTask({ id: 'C', parallel: true }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        assert.deepStrictEqual(s.nextReady(), ['A', 'B', 'C']);
    });

    test('maxConcurrency=1 degrades to sequential', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', parallel: true }),
            mkTask({ id: 'B', parallel: true }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 1 });
        assert.deepStrictEqual(s.nextReady(), ['A']);
        s.markStarted('A');
        assert.deepStrictEqual(s.nextReady(), []);
        s.markCompleted('A');
        assert.deepStrictEqual(s.nextReady(), ['B']);
    });

    test('linear chain unblocks one at a time', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B' }),
            mkTask({ id: 'C' }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        assert.deepStrictEqual(s.nextReady(), ['A']);
        s.markStarted('A'); s.markCompleted('A');
        assert.deepStrictEqual(s.nextReady(), ['B']);
        s.markStarted('B'); s.markCompleted('B');
        assert.deepStrictEqual(s.nextReady(), ['C']);
    });

    test('diamond: A blocks B and C; after A both ready', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', parallel: true, dependsOn: ['A'] }),
            mkTask({ id: 'C', parallel: true, dependsOn: ['A'] }),
            mkTask({ id: 'D', dependsOn: ['B', 'C'] }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        assert.deepStrictEqual(s.nextReady(), ['A']);
        s.markStarted('A'); s.markCompleted('A');
        assert.deepStrictEqual(s.nextReady().sort(), ['B', 'C']);
        s.markStarted('B'); s.markStarted('C');
        assert.deepStrictEqual(s.nextReady(), []);
        s.markCompleted('B');
        // D still waits on C
        assert.deepStrictEqual(s.nextReady(), []);
        s.markCompleted('C');
        assert.deepStrictEqual(s.nextReady(), ['D']);
    });

    test('markCompleted unblocks dependents and decrements running', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A' }),
            mkTask({ id: 'B', dependsOn: ['A'] }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        s.markStarted('A');
        assert.strictEqual(s.runningCount(), 1);
        s.markCompleted('A');
        assert.strictEqual(s.runningCount(), 0);
        assert.deepStrictEqual(s.nextReady(), ['B']);
    });

    test('markFailed stops new scheduling but keeps in-flight count accurate', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', parallel: true }),
            mkTask({ id: 'B', parallel: true }),
            mkTask({ id: 'C', parallel: true }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        // Start A and B simultaneously; fail A while B is still running.
        s.markStarted('A');
        s.markStarted('B');
        s.markFailed('A');
        assert.strictEqual(s.isAborted(), true);
        assert.strictEqual(s.runningCount(), 1);
        assert.deepStrictEqual(s.nextReady(), [], 'no new scheduling after failure');
        assert.strictEqual(s.isFinished(), false, 'B still running');
        s.markCompleted('B');
        assert.strictEqual(s.isFinished(), true, 'finishes once in-flight drains');
    });

    test('markStarted from non-pending throws', () => {
        const g = buildTaskGraph([mkTask({ id: 'A' })]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        s.markStarted('A');
        assert.throws(() => s.markStarted('A'));
    });

    test('markCompleted from non-running throws', () => {
        const g = buildTaskGraph([mkTask({ id: 'A' })]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        assert.throws(() => s.markCompleted('A'));
    });

    test('nextReady returns ids in declaration order (determinism)', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'zeta', parallel: true }),
            mkTask({ id: 'alpha', parallel: true }),
            mkTask({ id: 'mu', parallel: true }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 4 });
        // Original order preserved despite alphabetic mismatch
        assert.deepStrictEqual(s.nextReady(), ['zeta', 'alpha', 'mu']);
    });

    test('respects maxConcurrency cap mid-flight', () => {
        const g = buildTaskGraph([
            mkTask({ id: 'A', parallel: true }),
            mkTask({ id: 'B', parallel: true }),
            mkTask({ id: 'C', parallel: true }),
            mkTask({ id: 'D', parallel: true }),
        ]);
        const s = new TaskScheduler(g, { maxConcurrency: 2 });
        assert.deepStrictEqual(s.nextReady(), ['A', 'B']);
        s.markStarted('A'); s.markStarted('B');
        assert.deepStrictEqual(s.nextReady(), []);
        s.markCompleted('A');
        assert.deepStrictEqual(s.nextReady(), ['C']);
    });
});

suite('조건부 태스크 (when)', () => {

    suite('extractVariableReferences', () => {
        test('참조 단위로 묶는다 — ?? 체인은 배열 하나', () => {
            assert.deepStrictEqual(
                extractVariableReferences('${a.x} ${b.y ?? c.z}'),
                [['a'], ['b', 'c']]
            );
        });

        test('참조가 없으면 빈 배열', () => {
            assert.deepStrictEqual(extractVariableReferences('no refs here'), []);
            assert.deepStrictEqual(extractVariableReferences(''), []);
        });
    });

    suite('evaluateTaskCondition', () => {
        test('조건이 없으면 언제나 실행한다', () => {
            assert.strictEqual(evaluateTaskCondition(undefined, 'anything'), true);
        });

        test('equals / notEquals', () => {
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', equals: '파일' }, '파일'), true);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', equals: '파일' }, '폴더'), false);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', notEquals: '파일' }, '폴더'), true);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', notEquals: '파일' }, '파일'), false);
        });

        test('equals 는 완전 일치다 (부분 일치가 아니다)', () => {
            // 부분 일치면 접두사 관계인 선택지에서 엉뚱한 분기가 켜진다 —
            // dev / develop, prod / production 처럼 흔한 조합이다.
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', equals: 'dev' }, 'develop'), false);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', equals: 'prod' }, 'production'), false);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', notEquals: 'dev' }, 'develop'), true);
            // in 도 같은 규칙.
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', in: ['dev'] }, 'develop'), false);
        });

        test('matches 는 부분 일치', () => {
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', matches: '^rel' }, 'release/1.0'), true);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', matches: '^rel' }, 'feature/x'), false);
        });

        test('잘못된 정규식은 던지지 않고 거짓으로 본다', () => {
            // 던지면 액션 전체가 실패한다. 패턴 오타는 Doctor 가 따로 잡는다.
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', matches: '[' }, 'anything'), false);
        });

        test('in 은 목록 중 하나', () => {
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', in: ['a', 'b'] }, 'b'), true);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', in: ['a', 'b'] }, 'c'), false);
            assert.strictEqual(evaluateTaskCondition({ var: '${x}', in: [] }, 'a'), false);
        });

        test('풀리지 않은 참조는 리터럴이라 equals 가 거짓이 된다', () => {
            // 앞선 태스크가 꺼졌을 때 그 뒤 분기까지 함께 꺼지는 이유다.
            assert.strictEqual(
                evaluateTaskCondition({ var: '${gone.value}', equals: '파일' }, '${gone.value}'),
                false
            );
        });

        test('연산자가 하나도 없으면 실행한다', () => {
            // 오타로 태스크가 조용히 사라지는 것보다 도는 편이 눈에 띈다.
            assert.strictEqual(evaluateTaskCondition({ var: '${x}' } as any, 'anything'), true);
        });
    });

    suite('shouldSkipForSkippedDependencies', () => {
        const task = (extra: Partial<Task>): Task => ({ id: 'run', type: 'command', ...extra } as Task);

        test('꺼진 태스크를 평범하게 참조하면 함께 꺼진다', () => {
            // 그러지 않으면 미해결 리터럴 "${pickFile.path}" 가 경로 인자로 간다.
            assert.strictEqual(
                shouldSkipForSkippedDependencies(task({ args: ['${pickFile.path}'] }), new Set(['pickFile'])),
                true
            );
        });

        test('?? 체인은 살아남은 대안이 있으면 꺼지지 않는다', () => {
            assert.strictEqual(
                shouldSkipForSkippedDependencies(
                    task({ args: ['${pickFile.path ?? pickFolder.path}'] }),
                    new Set(['pickFile'])
                ),
                false,
                '이 문법의 뜻이 "이 중 하나면 된다" 인데 꺼지면 소비자를 쓸 수 없다'
            );
        });

        test('?? 체인도 대안이 전부 꺼지면 꺼진다', () => {
            assert.strictEqual(
                shouldSkipForSkippedDependencies(
                    task({ args: ['${pickFile.path ?? pickFolder.path}'] }),
                    new Set(['pickFile', 'pickFolder'])
                ),
                true
            );
        });

        test('꺼진 것이 없으면 언제나 실행한다', () => {
            assert.strictEqual(
                shouldSkipForSkippedDependencies(task({ args: ['${pickFile.path}'] }), new Set()),
                false
            );
        });

        test('조건 안의 참조도 센다', () => {
            // when 이 꺼진 태스크를 보면 그 조건은 영영 맞지 않는다.
            assert.strictEqual(
                shouldSkipForSkippedDependencies(
                    task({ when: { var: '${gone.value}', equals: 'x' } }),
                    new Set(['gone'])
                ),
                true
            );
        });

        test('동명 task가 꺼졌으면 bare 내장 이름이어도 함께 건너뛴다', () => {
            assert.strictEqual(
                shouldSkipForSkippedDependencies(task({ args: ['${file}'] }), new Set(['file'])),
                true
            );
            assert.strictEqual(
                shouldSkipForSkippedDependencies(task({ args: ['${file.path}'] }), new Set(['file'])),
                true
            );
        });

        test('forEach 본문의 each는 지역값이지만 소스의 each producer는 전파한다', () => {
            assert.strictEqual(
                shouldSkipForSkippedDependencies(
                    task({ forEach: '${each.valueList}', args: ['${each.value}'] }),
                    new Set(['each'])
                ),
                true
            );
            assert.strictEqual(
                shouldSkipForSkippedDependencies(
                    task({ forEach: ['a'], args: ['${each.value}'] }),
                    new Set(['each'])
                ),
                false
            );
        });
    });
});
