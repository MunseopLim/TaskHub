import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    INTERPOLATED_VALUE_MAX_LENGTH,
    wouldExceedCaptureLimit,
    sanitizeInterpolatedValue,
    interpolatePipelineVariables,
    expandArgTemplate,
    parseReferenceAlternatives,
    resolvePipelineReference,
    resolveWithinWorkspace,
    isInsideWorkspaceRoots,
    resolveFavoriteFilePath,
    validateLinkScheme,
    validateLinkUrlForSave,
    ALLOWED_LINK_SCHEMES,
    tokenizeCommandLine,
    mergeCommandAndArgs,
    quotePosixArgument,
    quotePowerShellArgument,
    quoteWindowsCommandLineArgument,
    buildPosixCommandLine,
    buildPowerShellInvocation,
    buildNativeCommandInvocation,
    resolveWindowsDirectExecutable,
    windowsCommandIsDirectlyLaunchable,
    resolveWindowsTaskSpawn,
    buildWindowsNativeProcessScript,
    buildPowerShellUtf8Preamble,
    buildPowerShellFileRedirectionPreamble,
    encodePowerShellScript,
    getCommandString,
    getToolCommand,
    selectPlatformValue,
    applyOutputCapture,
    normalizeEol,
    encodeFileContent,
    withTaskTimeout,
    withInteractivePromptLock,
    PipelineBuiltinUnavailableError,
    FOR_EACH_MAX_ITEMS,
    resolveForEachItems,
    buildForEachValue,
    inferTaskDependencies,
    materializeSwitchBranchTask,
} from '../pipelineUtils';
import { attachPipelineTaskIds, buildBuiltinVariableContext } from '../builtinVariables';

/**
 * These tests import directly from ../pipelineUtils (not ../extension) to
 * guarantee the module has no hidden dependency on `vscode` or on other parts
 * of extension.ts. If someone accidentally adds such a dependency, this test
 * file will fail to load.
 */
suite('pipelineUtils — direct-import smoke suite', () => {
    test('switch case는 바깥 id와 공통 설정을 유지하고 case가 실행 필드를 덮는다', () => {
        const selected = materializeSwitchBranchTask({
            id: 'optional', type: 'switch', on: '${mode}', cases: {},
            cwd: '/outer', passTheResultToNextTask: true,
        } as any, {
            type: 'command', command: 'node', cwd: '/case', args: ['x'],
        } as any);
        assert.strictEqual(selected.id, 'optional');
        assert.strictEqual(selected.type, 'command');
        assert.strictEqual(selected.cwd, '/case');
        assert.strictEqual(selected.passTheResultToNextTask, true);
        assert.ok(!Object.prototype.hasOwnProperty.call(selected, 'cases'));
        assert.ok(!Object.prototype.hasOwnProperty.call(selected, 'on'));
    });

    test('switch case는 대화형 타입과 스케줄링 필드를 거부한다', () => {
        const outer = { id: 'optional', type: 'switch', on: '${mode}', cases: {} } as any;
        assert.throws(
            () => materializeSwitchBranchTask(outer, { type: 'fileDialog' } as any),
            /type must be one of/
        );
        assert.throws(
            () => materializeSwitchBranchTask(outer, { type: 'command', command: 'x', when: {} } as any),
            /cannot define 'when'/
        );
    });

    test('INTERPOLATED_VALUE_MAX_LENGTH matches documented 32 KB cap', () => {
        assert.strictEqual(INTERPOLATED_VALUE_MAX_LENGTH, 32 * 1024);
    });

    test('sanitizeInterpolatedValue round-trips plain strings', () => {
        assert.strictEqual(sanitizeInterpolatedValue('hello'), 'hello');
    });

    test('interpolatePipelineVariables replaces known keys', () => {
        const out = interpolatePipelineVariables('hi ${name}', { name: 'Alice' });
        assert.strictEqual(out, 'hi Alice');
    });

    test('현재 파일·환경변수 내장을 같은 보간 규칙으로 해석한다', () => {
        const workspace = path.resolve(os.tmpdir(), 'taskhub-builtin-workspace');
        const context = buildBuiltinVariableContext({
            workspaceFolder: workspace,
            extensionPath: '/extension',
            editor: { file: path.join(workspace, 'src', 'main.c'), fileWorkspaceFolder: workspace },
            environment: { SDK_ROOT: '/opt/sdk' },
            strict: true,
        });
        assert.strictEqual(
            interpolatePipelineVariables('${relativeFile} @ ${env:SDK_ROOT}', context),
            `${path.join('src', 'main.c')} @ /opt/sdk`
        );
    });

    test('없는 실행 문맥 내장은 리터럴 전달 대신 실패하고 ?? 대안은 허용한다', () => {
        const workspace = path.resolve(os.tmpdir(), 'taskhub-builtin-workspace');
        const context = buildBuiltinVariableContext({
            workspaceFolder: workspace,
            extensionPath: '/extension',
            environment: {},
            strict: true,
        });
        assert.throws(
            () => interpolatePipelineVariables('${file}', context),
            (error: unknown) => error instanceof PipelineBuiltinUnavailableError && /Open a file/.test(error.message)
        );
        assert.throws(
            () => interpolatePipelineVariables('${env:MISSING}', context),
            (error: unknown) => error instanceof PipelineBuiltinUnavailableError && /MISSING/.test(error.message)
        );
        assert.strictEqual(
            interpolatePipelineVariables('${file ?? workspaceFolder}', context),
            workspace
        );
    });

    test('동명 task의 기존 bare 대표값이 내장보다 우선하고 속성 참조도 유지된다', () => {
        const workspace = path.resolve(os.tmpdir(), 'taskhub-builtin-workspace');
        const builtin = buildBuiltinVariableContext({
            workspaceFolder: workspace,
            extensionPath: '/extension',
            editor: { file: path.join(workspace, 'active.c') },
            environment: {},
            strict: true,
        });
        const context = Object.assign(Object.create(null), builtin, {
            file: { output: '/picked/legacy.bin', path: '/picked/input.bin', fileNameOnly: 'input.bin' },
        });

        assert.strictEqual(interpolatePipelineVariables('${file}', context), '/picked/legacy.bin');
        assert.strictEqual(interpolatePipelineVariables('${file.path}', context), '/picked/input.bin');
        assert.strictEqual(interpolatePipelineVariables('${file.fileNameOnly}', context), 'input.bin');
    });

    test('동명 task 결과가 아직 없으면 bare 내장으로 떨어지지 않는다', () => {
        const builtin = attachPipelineTaskIds(buildBuiltinVariableContext({
            workspaceFolder: '/workspace',
            extensionPath: '/extension',
            editor: { selectedText: 'must-not-leak' },
            clipboard: 'must-not-leak-either',
            environment: {},
            strict: true,
        }), ['selectedText', 'clipboard']);
        assert.strictEqual(interpolatePipelineVariables('${selectedText}', builtin), '${selectedText}');
        assert.strictEqual(interpolatePipelineVariables('${clipboard}', builtin), '${clipboard}');
    });

    test('resolveWithinWorkspace works with only path + roots', () => {
        const root = path.resolve(os.tmpdir(), 'pipelineUtils-smoke');
        const p = path.join(root, 'a.txt');
        assert.strictEqual(resolveWithinWorkspace(p, [root]), p);
    });

    test('isInsideWorkspaceRoots mirrors every runtime rejection rule (P3 회귀 가드)', () => {
        // dry-run 술어가 런타임(resolveWithinWorkspace)의 거부 규칙을 하나라도
        // 빠뜨리면, 그 경로가 Preview/Doctor에서 안전해 보이다가 런타임에서
        // 거부되는 거짓 음성이 생긴다. null byte가 그 사례였다.
        const root = path.resolve(os.tmpdir(), 'pipelineUtils-smoke');
        const nullBytePath = path.join(root, 'a\u0000b.txt');

        assert.strictEqual(isInsideWorkspaceRoots(nullBytePath, [root]), false);
        assert.throws(() => resolveWithinWorkspace(nullBytePath, [root]), /null byte/);

        // 빈 경로·빈 루트도 런타임과 동일하게 거부
        assert.strictEqual(isInsideWorkspaceRoots('', [root]), false);
        assert.strictEqual(isInsideWorkspaceRoots(path.join(root, 'a.txt'), []), false);

        // 정상 경로는 계속 허용
        assert.strictEqual(isInsideWorkspaceRoots(path.join(root, 'a.txt'), [root]), true);
    });

    test('resolveWithinWorkspace rejects symlink escape (M10 회귀 가드)', function () {
        // 어휘적(path.relative) 비교만으로는 워크스페이스 내부의 외부 지향
        // 심링크로 격리가 우회됐다 — realpath 정규화 후 판정해야 한다.
        if (process.platform === 'win32') { this.skip(); }
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-m10-'));
        try {
            const root = path.join(base, 'ws');
            const outside = path.join(base, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside, { recursive: true });
            fs.symlinkSync(outside, path.join(root, 'escape'));

            assert.throws(
                () => resolveWithinWorkspace(path.join(root, 'escape', 'a.txt'), [root]),
                /outside the current workspace/
            );

            // 워크스페이스 내부를 가리키는 심링크는 계속 허용된다
            const insideDir = path.join(root, 'sub');
            fs.mkdirSync(insideDir);
            fs.symlinkSync(insideDir, path.join(root, 'inlink'));
            const ok = resolveWithinWorkspace(path.join(root, 'inlink', 'b.txt'), [root]);
            assert.ok(ok.endsWith('b.txt'));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    test('tokenizeCommandLine handles quoted segments', () => {
        assert.deepStrictEqual(
            tokenizeCommandLine('cmd "a b" c'),
            ['cmd', 'a b', 'c']
        );
    });

    test('mergeCommandAndArgs splits executable from combined args', () => {
        const { executable, args } = mergeCommandAndArgs('npm run build', ['--prod']);
        assert.strictEqual(executable, 'npm');
        assert.deepStrictEqual(args, ['run', 'build', '--prod']);
    });

    test('POSIX quoting escapes single quotes via the close-escape-reopen idiom', () => {
        assert.strictEqual(quotePosixArgument("it's"), "'it'\\''s'");
        assert.strictEqual(quotePosixArgument(''), "''");
    });

    test('PowerShell quoting doubles embedded single quotes', () => {
        assert.strictEqual(quotePowerShellArgument("it's"), "'it''s'");
    });

    test('Windows command-line quoting preserves embedded double quotes for native argv fallback paths', () => {
        assert.strictEqual(
            quoteWindowsCommandLineArgument('process.stdout.write("ok")'),
            '"process.stdout.write(\\"ok\\")"'
        );
        assert.strictEqual(quoteWindowsCommandLineArgument('plain'), 'plain');
        assert.strictEqual(quoteWindowsCommandLineArgument(''), '""');
    });

    test('buildPosixCommandLine quotes args but leaves safe executable names bare', () => {
        const line = buildPosixCommandLine('echo', ['hello', '; rm']);
        assert.ok(line.startsWith('echo '), `unexpected line: ${line}`);
        assert.ok(line.includes("'hello'"));
        assert.ok(line.includes("'; rm'"));
    });

    test('buildPowerShellInvocation wraps into `& exe args` form', () => {
        const { script, display } = buildPowerShellInvocation('echo', ['hi'], false);
        assert.ok(display.startsWith('& '));
        assert.strictEqual(script, display);
    });

    test('buildNativeCommandInvocation preserves native argument boundaries', () => {
        const invocation = buildNativeCommandInvocation(
            'node',
            ['-e', 'process.stdout.write("ok")'],
            'C:\\toolchain\\node.exe'
        );
        assert.strictEqual(invocation.executable, 'C:\\toolchain\\node.exe');
        assert.deepStrictEqual(invocation.args, ['-e', 'process.stdout.write("ok")']);
        assert.ok(invocation.display.startsWith('node '));
        assert.ok(invocation.display.includes('process.stdout.write(\\"ok\\")'));
    });

    test('Windows native ProcessStartInfo script preserves quoted argv and reports launch failure', () => {
        const script = buildWindowsNativeProcessScript(
            'node',
            ['-e', 'process.stdout.write("ok value")'],
            { executable: 'C:\\toolchain\\node.exe', cwd: 'C:\\work dir' }
        );
        assert.ok(script.includes('$psi.UseShellExecute = $false'));
        assert.ok(script.includes('process.stdout.write(\\"ok value\\")'));
        assert.ok(script.includes("$psi.WorkingDirectory = 'C:\\work dir'"));
        assert.ok(script.includes('try {'));
        assert.ok(script.includes('if ($null -eq $taskHubProcess) { exit 1 }'));
        assert.ok(script.includes('} catch {\n    exit 1\n}'));
        assert.ok(!script.includes('.WaitForExit()'));
        assert.ok(!script.includes('$taskHubProcess | Out-Null'));

        const detachedScript = buildWindowsNativeProcessScript(
            'node',
            ['--version'],
            { executable: 'C:\\toolchain\\node.exe' }
        );
        assert.ok(detachedScript.includes('try {'));
        assert.ok(detachedScript.includes('} catch {\n    exit 1\n}'));
        assert.ok(!detachedScript.includes('.WaitForExit()'));
        assert.ok(!detachedScript.includes('$taskHubProcess | Out-Null'));
    });

    test('PowerShell UTF-8 preamble also covers 5.1 file redirection', () => {
        const preamble = buildPowerShellUtf8Preamble(true);
        assert.ok(preamble.includes('[Console]::OutputEncoding'));
        assert.ok(preamble.includes("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'"));
        assert.strictEqual(buildPowerShellUtf8Preamble(false), '');
    });

    test('detached PowerShell file-redirection preamble does not access a console', () => {
        const preamble = buildPowerShellFileRedirectionPreamble(true);
        assert.strictEqual(
            preamble,
            "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8';\n"
        );
        assert.ok(!preamble.includes('[Console]::OutputEncoding'));
        assert.strictEqual(buildPowerShellFileRedirectionPreamble(false), '');
    });

    test('windowsCommandIsDirectlyLaunchable resolves PATH, rejects shims/scripts/builtins', () => {
        const lookup = {
            env: { PATH: 'C:\\Windows\\System32;C:\\node;C:\\git' },
            isFile: (p: string) =>
                p === 'C:\\node\\node.exe' ||
                p === 'C:\\git\\git.exe' ||
                p === 'C:\\Windows\\System32\\cmd.exe' ||
                p === 'C:\\tools\\7z.exe',
        };
        // extensionless names resolved against the (fake) PATH
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('node', ['-e', 'x'], lookup), true);
        assert.strictEqual(resolveWindowsDirectExecutable('node', ['-e', 'x'], lookup), 'C:\\node\\node.exe');
        assert.strictEqual(resolveWindowsDirectExecutable('npm', ['test'], lookup), undefined);
        assert.strictEqual(resolveWindowsTaskSpawn(true, 'node', ['-e', 'x'], lookup).strategy, 'native');
        assert.strictEqual(resolveWindowsTaskSpawn(true, 'node', [], lookup).strategy, 'raw-shell');
        assert.strictEqual(resolveWindowsTaskSpawn(true, 'node --version', [], lookup).strategy, 'raw-shell');
        assert.strictEqual(resolveWindowsTaskSpawn(true, 'node > out.txt', [], lookup).strategy, 'raw-shell');
        assert.strictEqual(resolveWindowsTaskSpawn(false, 'node', ['-e', 'x'], lookup).strategy, 'native');
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('cmd /c echo hi', [], lookup), true);
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('git status', [], lookup), true);
        // npm/npx/pnpm only exist as `.cmd` shims → stay on PowerShell
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('npm test', [], lookup), false);
        // Bare .exe/.com names are pinned through PATH; scripts/shims stay on PowerShell.
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('node.exe', ['-e', 'x'], lookup), true);
        assert.strictEqual(resolveWindowsDirectExecutable('node.exe', ['-e', 'x'], lookup), 'C:\\node\\node.exe');
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('C:\\tools\\7z.exe', ['a'], lookup), true);
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('build.cmd', [], lookup), false);
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('tool.bat', [], lookup), false);
        // shell builtins / aliases
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('echo hi', [], lookup), false);
        assert.strictEqual(windowsCommandIsDirectlyLaunchable('dir', [], lookup), false);
    });

    test('Windows native plan reuses one PATH result for invocation and ProcessStartInfo', () => {
        let lookupCount = 0;
        const lookup = {
            env: { PATH: 'C:\\toolchain' },
            cwd: 'C:\\work',
            isFile: (candidate: string) => {
                lookupCount++;
                return candidate === 'C:\\toolchain\\node.exe';
            },
        };
        const plan = resolveWindowsTaskSpawn(false, 'node', ['-e', 'process.exit(7)'], lookup);
        assert.deepStrictEqual(plan, { strategy: 'native', executable: 'C:\\toolchain\\node.exe' });
        assert.strictEqual(lookupCount, 1);
        assert.strictEqual(plan.strategy, 'native');
        const invocation = buildNativeCommandInvocation('node', ['-e', 'process.exit(7)'], plan.executable);
        const script = buildWindowsNativeProcessScript(
            'node',
            ['-e', 'process.exit(7)'],
            { executable: invocation.executable, cwd: 'C:\\work' }
        );
        assert.strictEqual(lookupCount, 1, 'building the launch command must not resolve PATH again');
        assert.ok(script.includes("$psi.FileName = 'C:\\toolchain\\node.exe'"), script);
        assert.ok(!script.includes("$psi.FileName = 'node'"), script);
    });

    test('Windows executable resolution anchors relative paths to the task cwd', () => {
        const files = new Set([
            'C:\\workspace\\tools\\node.exe',
            'C:\\workspace\\local.exe',
        ]);
        const lookup = {
            env: { PATH: 'tools' },
            cwd: 'C:\\workspace',
            isFile: (candidate: string) => files.has(candidate),
        };
        assert.strictEqual(
            resolveWindowsDirectExecutable('node.exe', [], lookup),
            'C:\\workspace\\tools\\node.exe'
        );
        assert.strictEqual(
            resolveWindowsDirectExecutable('.\\local.exe', [], lookup),
            'C:\\workspace\\local.exe'
        );
    });

    test('encodePowerShellScript returns UTF-16 LE base64', () => {
        const encoded = encodePowerShellScript('a');
        const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
        assert.strictEqual(decoded, 'a');
    });

    test('getCommandString accepts a plain string', () => {
        assert.strictEqual(getCommandString('npm test'), 'npm test');
    });

    test('getToolCommand quotes paths containing spaces', () => {
        const out = getToolCommand('C:/Program Files/Tool/bin.exe');
        assert.strictEqual(out, '"C:/Program Files/Tool/bin.exe"');
    });
});

suite('forEach 값 해석', () => {
    test('배열 참조는 공백이 든 항목의 경계를 그대로 보존한다', () => {
        assert.deepStrictEqual(
            resolveForEachItems('${files.paths}', { files: { paths: ['/a one.bin', '/b.bin'] } }),
            ['/a one.bin', '/b.bin']
        );
    });

    test('정적 배열은 항목별로 변수를 보간한다', () => {
        assert.deepStrictEqual(
            resolveForEachItems(['${root}/debug', '${root}/release'], { root: '/build' }),
            ['/build/debug', '/build/release']
        );
    });

    test('문자열·객체 결과와 상한 초과는 명확히 거부한다', () => {
        assert.throws(() => resolveForEachItems('${one.value}', { one: { value: 'x' } }), /must resolve to an array/);
        assert.throws(() => resolveForEachItems('${one.value}', { one: { value: [{}] } }), /item 1/);
        assert.throws(() => resolveForEachItems('${one.value}', { one: { value: [['a', 'b']] } }), /item 1/);
        assert.throws(
            () => resolveForEachItems('${one.value}', { one: { value: Array(FOR_EACH_MAX_ITEMS + 1).fill('x') } }),
            /limit is 1000/
        );
    });

    test('each 문맥은 bare 값과 위치 메타데이터를 함께 제공한다', () => {
        const each = buildForEachValue('firmware.bin', 1, 3);
        assert.strictEqual(interpolatePipelineVariables('${each}', { each }), 'firmware.bin');
        assert.strictEqual(
            interpolatePipelineVariables('${each.value}:${each.index}:${each.number}/${each.count}', { each }),
            'firmware.bin:1:2/3'
        );
    });

    test('forEach 본문의 each는 task 의존성이 아니지만 소스 배열은 의존성이다', () => {
        const deps = inferTaskDependencies({
            id: 'flash', type: 'command', forEach: '${files.paths}',
            command: 'tool', args: ['${each}', '${each.number}'],
        }, new Set(['files', 'each']));
        assert.deepStrictEqual([...deps], ['files']);
    });
});

/**
 * `parseReferenceAlternatives` 는 `${…}` 를 읽는 **유일한 규칙**이다. 진단·
 * 자동완성·의존성 추론이 각자 문자열을 쪼개면 반드시 어긋나므로, 여기서
 * `resolvePipelineReference` 와 같은 답을 내는지 계약으로 고정한다.
 */
suite('parseReferenceAlternatives', () => {
    test('평범한 참조는 원소 하나짜리 배열이다', () => {
        assert.deepStrictEqual(parseReferenceAlternatives('producer.output'),
            [{ text: 'producer.output', head: 'producer', key: 'output' }]);
    });

    test('점이 없으면 key 가 undefined (bare 참조)', () => {
        assert.deepStrictEqual(parseReferenceAlternatives('producer'),
            [{ text: 'producer', head: 'producer', key: undefined }]);
    });

    test("점 뒤가 비면 key 는 '' 이고 bare 가 아니다", () => {
        // 런타임도 `${producer.}` 를 bare 로 보지 않아 output 폴백을 태우지
        // 않는다. `''` 와 `undefined` 를 뭉개면 이 오타가 정상으로 통과한다.
        assert.deepStrictEqual(parseReferenceAlternatives('producer.'),
            [{ text: 'producer.', head: 'producer', key: '' }]);
    });

    test('키의 점은 첫 번째만 자른다', () => {
        assert.deepStrictEqual(parseReferenceAlternatives('a.b.c'),
            [{ text: 'a.b.c', head: 'a', key: 'b.c' }]);
    });

    test('평범한 참조의 공백은 다듬지 않는다', () => {
        // 런타임은 split 결과를 그대로 키로 쓴다 — `${ producer.output}` 은
        // 리터럴로 남는다. 여기서 다듬으면 그 오타가 정상 참조로 보인다.
        assert.deepStrictEqual(parseReferenceAlternatives(' producer. output'),
            [{ text: ' producer. output', head: ' producer', key: ' output' }]);
    });

    test('?? 는 대안마다 하나씩 쪼개고 공백을 다듬는다', () => {
        assert.deepStrictEqual(parseReferenceAlternatives('  a.x  ??  b.y  '), [
            { text: 'a.x', head: 'a', key: 'x' },
            { text: 'b.y', head: 'b', key: 'y' },
        ]);
    });

    test('?? 체인에 bare 대안이 섞여도 대안마다 판정한다', () => {
        assert.deepStrictEqual(parseReferenceAlternatives('a ?? b.y'), [
            { text: 'a', head: 'a', key: undefined },
            { text: 'b.y', head: 'b', key: 'y' },
        ]);
    });

    test('빈 대안은 버린다 (전부 비면 빈 배열)', () => {
        // 런타임의 `resolvePipelineReference('??')` 도 돌 대안이 없어 undefined
        // 를 내고 리터럴로 남는다 — 빈 배열이 그 상태와 같은 뜻이다.
        assert.deepStrictEqual(parseReferenceAlternatives('a.x ?? '),
            [{ text: 'a.x', head: 'a', key: 'x' }]);
        assert.deepStrictEqual(parseReferenceAlternatives('??'), []);
    });

    test('런타임 해석과 같은 것을 가리킨다', () => {
        // 파서가 읽은 head/key 로 값을 찾은 결과와 `resolvePipelineReference` 의
        // 답이 어긋나면 진단이 거짓말을 한다. bare 폴백(`output`/`outputDir`)과
        // own property 규칙까지 흉내 내어, 파서가 가리키는 자리가 런타임이 보는
        // 자리와 같은지 본다.
        // **평범한 객체**를 쓴다 — 그래야 own property 규칙이 실제로 시험된다.
        // 어느 한쪽이 상속된 키를 보면 `${constructor.name}` 에서 갈린다.
        const ctx: any = {
            a: { x: 'AX' },
            b: { y: 'BY' },
            withOut: { output: 'OUT' },
            withDir: { outputDir: 'DIR' },
            withValue: { value: 'VALUE' },
            neither: { archivePath: 'ZIP' },
        };
        const own = (o: any, k: string): unknown =>
            o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
        const lookup = (alt: { head: string; key: string | undefined }): unknown => {
            const step = own(ctx, alt.head);
            if (alt.key !== undefined) { return own(step, alt.key); }
            if (!step) { return undefined; }
            // bare 는 대표 결과 — 런타임과 같은 순서로 폴백한다.
            if (own(step, 'output') !== undefined) { return own(step, 'output'); }
            if (own(step, 'outputDir') !== undefined) { return own(step, 'outputDir'); }
            if (own(step, 'value') !== undefined) { return own(step, 'value'); }
            // 둘 다 없으면 런타임은 **결과 객체 자체**를 돌려준다. 문자열이
            // 아니라 sanitize 에서 걸려 리터럴로 남는 자리다 (`zip` 처럼
            // `archivePath` 만 내는 태스크).
            return step;
        };
        const cases = [
            'a.x', 'b.y', 'a.nope', 'a.', ' a.x', 'a. x',
            'withOut', 'withDir', 'withValue', 'neither', 'nosuch',
            'constructor.name', 'toString.name',
            'a.x ?? b.y', 'a.nope ?? b.y', 'a.nope ?? b.nope',
            'withOut ?? b.y', 'withValue ?? b.y', 'neither ?? b.y', 'a.nope ?? withDir',
        ];
        for (const expr of cases) {
            const first = parseReferenceAlternatives(expr)
                .map(lookup)
                .find(value => value !== undefined);
            assert.strictEqual(resolvePipelineReference(expr, ctx), first, expr);
        }
    });

    test('bare input result는 value를 대표값으로 쓰고 배열 argv도 보존한다', () => {
        const context = {
            pick: { value: '--release', label: 'Release' },
            optional: { value: [] as string[], label: 'No option' },
            many: { value: ['--target', 'board a'] },
        };
        assert.strictEqual(interpolatePipelineVariables('${pick}', context), '--release');
        assert.deepStrictEqual(expandArgTemplate('${optional}', context), []);
        assert.deepStrictEqual(expandArgTemplate('${many}', context), ['--target', 'board a']);
    });
});

/**
 * `selectPlatformValue` 는 Preview Run 이 "지금 이 기계에서 실행하면" 을 보여
 * 줄 때 쓰는 선택기다. `platform` 을 명시로 넘겨 **CI 가 도는 OS 와 무관하게**
 * 세 분기를 모두 고정한다 — 그러지 않으면 darwin 호스트에서 win32/linux 경로가
 * 한 번도 실행되지 않는다.
 */
suite('selectPlatformValue', () => {
    const tool = { windows: 'C:\\7z.exe', macos: '/usr/local/bin/7z', linux: '/usr/bin/7z' };

    test('플랫폼마다 그 branch 를 고른다', () => {
        assert.strictEqual(selectPlatformValue(tool, 'win32'), 'C:\\7z.exe');
        assert.strictEqual(selectPlatformValue(tool, 'darwin'), '/usr/local/bin/7z');
        assert.strictEqual(selectPlatformValue(tool, 'linux'), '/usr/bin/7z');
    });

    test('문자열은 플랫폼과 무관하게 그대로다', () => {
        assert.strictEqual(selectPlatformValue('/usr/bin/7z', 'win32'), '/usr/bin/7z');
    });

    test('현재 플랫폼 branch 가 없으면 undefined', () => {
        assert.strictEqual(selectPlatformValue({ windows: 'C:\\7z.exe' }, 'darwin'), undefined);
    });

    test('알 수 없는 플랫폼도 undefined (aix 등)', () => {
        assert.strictEqual(selectPlatformValue(tool, 'aix'), undefined);
    });

    test('빈 문자열 branch 는 없는 것으로 본다', () => {
        // `getToolCommand` 가 falsy 검사로 던지는 값이다. "있다" 고 답하면
        // 미리보기가 빈 명령을 정상처럼 보여 주고 실행만 실패한다.
        assert.strictEqual(selectPlatformValue({ macos: '' }, 'darwin'), undefined);
        assert.strictEqual(selectPlatformValue('', 'darwin'), undefined);
    });

    test('문자열이 아닌 branch / 값은 undefined', () => {
        assert.strictEqual(selectPlatformValue({ darwin: 1 } as any, 'darwin'), undefined);
        assert.strictEqual(selectPlatformValue({ macos: 7 } as any, 'darwin'), undefined);
        assert.strictEqual(selectPlatformValue(['/usr/bin/7z'], 'darwin'), undefined);
        assert.strictEqual(selectPlatformValue(undefined, 'darwin'), undefined);
        assert.strictEqual(selectPlatformValue(null, 'darwin'), undefined);
        assert.strictEqual(selectPlatformValue(42, 'darwin'), undefined);
    });
});

suite('sanitizeInterpolatedValue — length boundary', () => {
    // The guard is `stringValue.length > INTERPOLATED_VALUE_MAX_LENGTH`, so
    // values at exactly the limit must still be accepted. These tests pin
    // that off-by-one so a future edit to `>=` is caught immediately.
    test('accepts a value exactly at INTERPOLATED_VALUE_MAX_LENGTH - 1', () => {
        const s = 'a'.repeat(INTERPOLATED_VALUE_MAX_LENGTH - 1);
        assert.strictEqual(sanitizeInterpolatedValue(s)?.length, INTERPOLATED_VALUE_MAX_LENGTH - 1);
    });

    test('accepts a value exactly at INTERPOLATED_VALUE_MAX_LENGTH', () => {
        const s = 'a'.repeat(INTERPOLATED_VALUE_MAX_LENGTH);
        assert.strictEqual(sanitizeInterpolatedValue(s)?.length, INTERPOLATED_VALUE_MAX_LENGTH);
    });

    test('rejects a value exactly at INTERPOLATED_VALUE_MAX_LENGTH + 1', () => {
        const s = 'a'.repeat(INTERPOLATED_VALUE_MAX_LENGTH + 1);
        assert.throws(() => sanitizeInterpolatedValue(s), /maximum length/);
    });
});

suite('wouldExceedCaptureLimit — capture cap boundary', () => {
    // Guard in executeShellCommand(): `currentBytes + chunkBytes > limitBytes`.
    // Extracted as a pure predicate so we can pin the boundary without
    // spawning a real subprocess.
    test('returns false when total equals the limit (inclusive ceiling)', () => {
        assert.strictEqual(wouldExceedCaptureLimit(500, 500, 1000), false);
    });

    test('returns false when total is below the limit', () => {
        assert.strictEqual(wouldExceedCaptureLimit(500, 499, 1000), false);
    });

    test('returns true when total is exactly one byte over the limit', () => {
        assert.strictEqual(wouldExceedCaptureLimit(500, 501, 1000), true);
    });

    test('handles a zero-byte chunk at exactly the limit', () => {
        assert.strictEqual(wouldExceedCaptureLimit(1000, 0, 1000), false);
    });

    test('handles a single chunk that alone exceeds an empty buffer', () => {
        assert.strictEqual(wouldExceedCaptureLimit(0, 1001, 1000), true);
        assert.strictEqual(wouldExceedCaptureLimit(0, 1000, 1000), false);
    });
});

suite('applyOutputCapture', () => {
    test('returns empty object when capture is undefined', () => {
        assert.deepStrictEqual(applyOutputCapture('anything', undefined), {});
    });

    test('regex: extracts default capture group 1', () => {
        const out = applyOutputCapture('commit abc1234\n', { name: 'sha', regex: 'commit ([a-f0-9]+)' });
        assert.deepStrictEqual(out, { sha: 'abc1234' });
    });

    test('regex: strips global flag before matching', () => {
        const out = applyOutputCapture('commit abc1234\n', { name: 'sha', regex: 'commit ([a-f0-9]+)', flags: 'g' });
        assert.deepStrictEqual(out, { sha: 'abc1234' });
    });

    test('regex: explicit group 0 returns full match', () => {
        const out = applyOutputCapture('value=42', { name: 'whole', regex: 'value=(\\d+)', group: 0 });
        assert.deepStrictEqual(out, { whole: 'value=42' });
    });

    test('regex: miss produces no entry', () => {
        const out = applyOutputCapture('nothing interesting', { name: 'v', regex: '^v(\\d+)' });
        assert.deepStrictEqual(out, {});
    });

    test('regex: out-of-range group is skipped silently', () => {
        const out = applyOutputCapture('hello', { name: 'v', regex: 'hello', group: 5 });
        assert.deepStrictEqual(out, {});
    });

    // --- regex group boundary tests ---------------------------------------
    // Guard: `if (group < 0 || group >= m.length) { selected = undefined; }`.
    // With `/^(a)(b)(c)$/` matching "abc" the Match array is ['abc','a','b','c']
    // so m.length === 4 and the valid group range is [0, 3].
    test('regex: group = m.length - 1 (last valid index) selects the last group', () => {
        const out = applyOutputCapture('abc', { name: 'v', regex: '^(a)(b)(c)$', group: 3 });
        assert.deepStrictEqual(out, { v: 'c' });
    });

    test('regex: group = m.length (first invalid index) is skipped', () => {
        const out = applyOutputCapture('abc', { name: 'v', regex: '^(a)(b)(c)$', group: 4 });
        assert.deepStrictEqual(out, {});
    });

    test('regex: negative group (-1) is treated as out-of-range and skipped', () => {
        const out = applyOutputCapture('abc', { name: 'v', regex: '^(a)(b)(c)$', group: -1 });
        assert.deepStrictEqual(out, {});
    });

    test('regex: invalid pattern throws with task-friendly message', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: 'v', regex: '(' }),
            /Capture 'v' has invalid regex/
        );
    });

    test('regex: flags are honored', () => {
        const out = applyOutputCapture('line1\nMATCH\nline3', {
            name: 'pick', regex: 'match', flags: 'i'
        });
        assert.deepStrictEqual(out, { pick: 'MATCH' });
    });

    test('line: positive index selects by 0-based line', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'second', line: 1 });
        assert.deepStrictEqual(out, { second: 'b' });
    });

    test('line: negative index counts from end', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'last', line: -1 });
        assert.deepStrictEqual(out, { last: 'c' });
    });

    test('line: out-of-range index is skipped', () => {
        assert.deepStrictEqual(applyOutputCapture('a\nb', { name: 'v', line: 99 }), {});
        assert.deepStrictEqual(applyOutputCapture('a\nb', { name: 'v', line: -99 }), {});
    });

    // --- line index boundary tests ----------------------------------------
    // Resolution: idx = line < 0 ? lines.length + line : line; then selected
    // only if `0 <= idx < lines.length`. With "a\nb\nc" we get three lines so
    // lines.length === 3 and the valid idx range is [0, 2]. For negatives the
    // valid `rule.line` range is [-3, -1].
    test('line: lines.length - 1 (last positive valid index) selects the last line', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: 2 });
        assert.deepStrictEqual(out, { v: 'c' });
    });

    test('line: lines.length (first positive invalid index) is skipped', () => {
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: 3 });
        assert.deepStrictEqual(out, {});
    });

    test('line: -lines.length (most-negative valid index) selects the first line', () => {
        // line = -3 → idx = 3 + (-3) = 0 → 'a'
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: -3 });
        assert.deepStrictEqual(out, { v: 'a' });
    });

    test('line: -lines.length - 1 (first negative invalid index) is skipped', () => {
        // line = -4 → idx = 3 + (-4) = -1 → skipped
        const out = applyOutputCapture('a\nb\nc', { name: 'v', line: -4 });
        assert.deepStrictEqual(out, {});
    });

    test('no selector: uses full output', () => {
        assert.deepStrictEqual(
            applyOutputCapture('raw', { name: 'all' }),
            { all: 'raw' }
        );
    });

    test('trim: applies after selection', () => {
        const out = applyOutputCapture('  hi  \n', { name: 'v', trim: true });
        assert.deepStrictEqual(out, { v: 'hi' });
    });

    test('trim: works with regex selection', () => {
        const out = applyOutputCapture('ver: [ 1.2.3 ]', {
            name: 'v', regex: '\\[(.+)\\]', trim: true
        });
        assert.deepStrictEqual(out, { v: '1.2.3' });
    });

    test('array: applies multiple rules', () => {
        const out = applyOutputCapture('commit abc123\nAuthor: Jane\n', [
            { name: 'sha', regex: 'commit ([a-f0-9]+)' },
            { name: 'author', regex: 'Author: (.+)', trim: true }
        ]);
        assert.deepStrictEqual(out, { sha: 'abc123', author: 'Jane' });
    });

    test('missing name throws', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: '' } as any),
            /missing a non-empty 'name'/
        );
    });

    test('invalid name throws', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: '1bad' } as any),
            /Capture name '1bad' must match/
        );
    });

    test('reserved name throws', () => {
        assert.throws(
            () => applyOutputCapture('x', { name: 'output' }),
            /Capture name 'output' is reserved/
        );
    });

    test('duplicate name throws', () => {
        assert.throws(
            () => applyOutputCapture('hello', [
                { name: 'v', regex: 'hello' },
                { name: 'v', regex: '.' }
            ]),
            /Duplicate capture name 'v'/
        );
    });
});

suite('validateLinkScheme', () => {
    test('allowlist contains exactly http, https, mailto', () => {
        assert.deepStrictEqual(
            [...ALLOWED_LINK_SCHEMES].sort(),
            ['http', 'https', 'mailto']
        );
    });

    test('accepts https URLs', () => {
        const result = validateLinkScheme('https://example.com/path?q=1');
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.scheme, 'https');
            assert.strictEqual(result.url, 'https://example.com/path?q=1');
        }
    });

    test('accepts http URLs', () => {
        const result = validateLinkScheme('http://example.com');
        assert.strictEqual(result.ok, true);
    });

    test('accepts mailto URLs', () => {
        const result = validateLinkScheme('mailto:user@example.com');
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.scheme, 'mailto');
        }
    });

    test('scheme comparison is case-insensitive', () => {
        const result = validateLinkScheme('HTTPS://EXAMPLE.COM');
        assert.strictEqual(result.ok, true);
        if (result.ok) {
            assert.strictEqual(result.scheme, 'https');
        }
    });

    test('rejects command: URIs', () => {
        const result = validateLinkScheme('command:workbench.action.terminal.sendSequence');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'scheme');
            if (result.reason === 'scheme') {
                assert.strictEqual(result.scheme, 'command');
            }
        }
    });

    test('rejects file: URIs', () => {
        const result = validateLinkScheme('file:///etc/passwd');
        assert.strictEqual(result.ok, false);
        if (!result.ok && result.reason === 'scheme') {
            assert.strictEqual(result.scheme, 'file');
        }
    });

    test('rejects vscode: URIs', () => {
        const result = validateLinkScheme('vscode://some.extension/path');
        assert.strictEqual(result.ok, false);
        if (!result.ok && result.reason === 'scheme') {
            assert.strictEqual(result.scheme, 'vscode');
        }
    });

    test('rejects javascript: URIs', () => {
        const result = validateLinkScheme('javascript:alert(1)');
        assert.strictEqual(result.ok, false);
        if (!result.ok && result.reason === 'scheme') {
            assert.strictEqual(result.scheme, 'javascript');
        }
    });

    test('rejects empty string', () => {
        const result = validateLinkScheme('');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'empty');
        }
    });

    test('rejects whitespace-only string', () => {
        const result = validateLinkScheme('   ');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'empty');
        }
    });

    test('rejects non-string inputs', () => {
        for (const value of [undefined, null, 42, {}, []]) {
            const result = validateLinkScheme(value);
            assert.strictEqual(result.ok, false, `expected reject for ${JSON.stringify(value)}`);
            if (!result.ok) {
                assert.strictEqual(result.reason, 'empty');
            }
        }
    });

    test('rejects strings with no scheme delimiter', () => {
        const result = validateLinkScheme('example.com/path');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'invalid');
        }
    });

    test('rejects protocol-relative URLs', () => {
        const result = validateLinkScheme('//example.com');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'invalid');
        }
    });
});

suite('validateLinkUrlForSave', () => {
    test('accepts well-formed http/https URLs', () => {
        for (const url of ['http://example.com', 'https://example.com/path?q=1', 'https://api.example.com:8443/v2']) {
            const result = validateLinkUrlForSave(url);
            assert.strictEqual(result.ok, true, `expected ok for ${url}`);
        }
    });

    test('accepts mailto URLs', () => {
        const result = validateLinkUrlForSave('mailto:user@example.com');
        assert.strictEqual(result.ok, true);
    });

    test('rejects scheme-only inputs that the regex-only check missed (P2 fix)', () => {
        // These are inputs that pass `validateLinkScheme` (because the
        // `^scheme:` regex matches) but fail `new URL()` parsing. Without
        // the WHATWG-URL gate the v0.4.32 patch promised "format errors
        // are blocked at input time" but actually only blocked scheme
        // errors — `https://` slipped through to a click-time toast.
        // Note: WHATWG silently normalizes `new URL('https:///path')` to
        // `https://path/` (host = 'path', pathname = '/'), so we do *not*
        // catch that one — the user's intent gets quietly reinterpreted
        // rather than rejected, and the click-time `vscode.Uri.parse`
        // remains the final fail-safe. The common typos we DO catch here
        // are the bare `https://` / `http://` and an unterminated IPv6
        // literal.
        for (const malformed of ['https://', 'http://', 'https://[unclosed-ipv6']) {
            const result = validateLinkUrlForSave(malformed);
            assert.strictEqual(result.ok, false, `expected reject for ${malformed}`);
            if (!result.ok) {
                assert.strictEqual(result.reason, 'invalid', `wrong reason for ${malformed}`);
            }
        }
    });

    test('documents WHATWG normalization quirk: https:///path becomes https://path/', () => {
        // Regression guard for the doc claim above. If a future Node /
        // ECMA URL parser stops normalizing slashes here, this test
        // fails and we revisit both the comment in this suite and the
        // CHANGELOG / features.md note.
        const url = new URL('https:///path');
        assert.strictEqual(url.host, 'path');
        assert.strictEqual(url.pathname, '/');
        // And consequently `validateLinkUrlForSave` returns ok — the
        // gate intentionally accepts it.
        assert.strictEqual(validateLinkUrlForSave('https:///path').ok, true);
    });

    test('rejects disallowed schemes with the scheme name in the result', () => {
        for (const [url, expectedScheme] of [
            ['javascript:alert(1)', 'javascript'],
            ['file:///etc/passwd', 'file'],
            ['vscode://ext.id/path', 'vscode'],
            ['command:workbench.action.x', 'command'],
        ] as const) {
            const result = validateLinkUrlForSave(url);
            assert.strictEqual(result.ok, false, `expected reject for ${url}`);
            if (!result.ok && result.reason === 'scheme') {
                assert.strictEqual(result.scheme, expectedScheme);
            } else {
                assert.fail(`expected scheme reason for ${url}, got ${JSON.stringify(result)}`);
            }
        }
    });

    test('rejects empty / whitespace inputs with reason "empty"', () => {
        for (const value of ['', '   ', '\t']) {
            const result = validateLinkUrlForSave(value);
            assert.strictEqual(result.ok, false);
            if (!result.ok) {
                assert.strictEqual(result.reason, 'empty');
            }
        }
    });

    test('rejects strings with no scheme delimiter as "invalid"', () => {
        const result = validateLinkUrlForSave('example.com/path');
        assert.strictEqual(result.ok, false);
        if (!result.ok) {
            assert.strictEqual(result.reason, 'invalid');
        }
    });
});

suite('resolveFavoriteFilePath', () => {
    const root = path.resolve(os.tmpdir(), 'taskhub-favorite-test');

    test('resolves ${workspaceFolder} placeholder to absolute path inside workspace', () => {
        const resolved = resolveFavoriteFilePath('${workspaceFolder}/src/file.ts', root, [root]);
        assert.strictEqual(resolved, path.join(root, 'src/file.ts'));
    });

    test('resolves plain relative path against the workspace folder', () => {
        const resolved = resolveFavoriteFilePath('docs/README.md', root, [root]);
        assert.strictEqual(resolved, path.join(root, 'docs/README.md'));
    });

    test('rejects parent-directory traversal via ${workspaceFolder}', () => {
        assert.throws(
            () => resolveFavoriteFilePath('${workspaceFolder}/../secret.txt', root, [root]),
            /outside/
        );
    });

    test('rejects absolute path outside workspace roots', () => {
        const outside = path.resolve(os.tmpdir(), 'some-other-dir', 'file.txt');
        assert.throws(
            () => resolveFavoriteFilePath(outside, root, [root]),
            /outside/
        );
    });

    test('rejects plain relative path that escapes workspace', () => {
        assert.throws(
            () => resolveFavoriteFilePath('../../etc/passwd', root, [root]),
            /outside/
        );
    });

    test('rejects null-byte injection in favorite path', () => {
        assert.throws(
            () => resolveFavoriteFilePath('file\x00.txt', root, [root]),
            /null byte/
        );
    });
});

suite('normalizeEol', () => {
    test('keep: leaves mixed endings untouched', () => {
        const input = 'a\nb\r\nc\rd';
        assert.strictEqual(normalizeEol(input, 'keep'), input);
    });

    test('keep: undefined eol behaves as keep', () => {
        const input = 'a\r\nb';
        assert.strictEqual(normalizeEol(input, undefined), input);
    });

    test('lf: collapses CRLF but leaves lone CR alone', () => {
        assert.strictEqual(normalizeEol('a\r\nb\nc\rd', 'lf'), 'a\nb\nc\rd');
    });

    test('crlf: every LF becomes CRLF without doubling existing CRLF', () => {
        // 'a\r\nb\nc' has one CRLF and one LF. Expect both to end up CRLF,
        // not 'a\r\r\nb\r\nc' (which would happen with a naive /\n/ → \r\n).
        assert.strictEqual(normalizeEol('a\r\nb\nc', 'crlf'), 'a\r\nb\r\nc');
    });

    test('crlf: pure-LF input becomes pure CRLF', () => {
        assert.strictEqual(normalizeEol('a\nb\nc', 'crlf'), 'a\r\nb\r\nc');
    });

    test('lf: pure-CRLF input becomes pure LF', () => {
        assert.strictEqual(normalizeEol('a\r\nb\r\nc', 'lf'), 'a\nb\nc');
    });

    test('empty string is returned verbatim for every mode', () => {
        assert.strictEqual(normalizeEol('', 'lf'), '');
        assert.strictEqual(normalizeEol('', 'crlf'), '');
        assert.strictEqual(normalizeEol('', 'keep'), '');
    });
});

suite('encodeFileContent', () => {
    test('default utf8 encoding returns plain UTF-8 bytes without BOM', () => {
        const buf = encodeFileContent('héllo', undefined);
        assert.strictEqual(buf.toString('utf8'), 'héllo');
        // First bytes are NOT 0xEF 0xBB 0xBF.
        assert.notStrictEqual(buf[0], 0xef);
    });

    test('utf8 encoding leaves non-ASCII intact', () => {
        const buf = encodeFileContent('안녕', 'utf8');
        assert.strictEqual(buf.toString('utf8'), '안녕');
    });

    test('utf8bom prefixes BOM when includeBom is true (default)', () => {
        const buf = encodeFileContent('hi', 'utf8bom');
        assert.strictEqual(buf[0], 0xef);
        assert.strictEqual(buf[1], 0xbb);
        assert.strictEqual(buf[2], 0xbf);
        assert.strictEqual(buf.slice(3).toString('utf8'), 'hi');
    });

    test('utf8bom omits BOM when includeBom=false (append to existing file)', () => {
        const buf = encodeFileContent('hi', 'utf8bom', false);
        assert.strictEqual(buf.toString('utf8'), 'hi');
        assert.notStrictEqual(buf[0], 0xef);
    });

    test('ascii encoding drops non-ASCII chars to "?"', () => {
        const buf = encodeFileContent('a안b', 'ascii');
        // Node's 'ascii' encoding masks each byte to 7 bits, so non-ASCII
        // bytes get mapped into the ASCII range rather than being silently
        // preserved. The important contract for callers is "output is ASCII
        // safe and round-trips pure-ASCII inputs verbatim".
        assert.strictEqual(buf.toString('ascii').startsWith('a'), true);
        assert.strictEqual(buf.toString('ascii').endsWith('b'), true);
    });

    test('empty string produces zero bytes (no BOM) for utf8', () => {
        assert.strictEqual(encodeFileContent('', 'utf8').length, 0);
    });

    test('empty string + utf8bom still writes the 3-byte BOM', () => {
        const buf = encodeFileContent('', 'utf8bom');
        assert.strictEqual(buf.length, 3);
        assert.deepStrictEqual([...buf], [0xef, 0xbb, 0xbf]);
    });
});

suite('withTaskTimeout', () => {
    test('resolves when inner promise settles before timeout', async () => {
        const result = await withTaskTimeout(Promise.resolve('ok'), 5, 't1');
        assert.strictEqual(result, 'ok');
    });

    test('propagates inner rejection verbatim before timeout fires', async () => {
        const innerErr = new Error('inner-boom');
        await assert.rejects(
            () => withTaskTimeout(Promise.reject(innerErr), 5, 't1'),
            /inner-boom/
        );
    });

    test('undefined timeout is a no-op and returns the original promise', async () => {
        const result = await withTaskTimeout(Promise.resolve('ok'), undefined, 't1');
        assert.strictEqual(result, 'ok');
    });

    test('zero timeout disables timing out', async () => {
        const slow = new Promise<string>(r => setTimeout(() => r('slow'), 30));
        const result = await withTaskTimeout(slow, 0, 't1');
        assert.strictEqual(result, 'slow');
    });

    test('negative timeout disables timing out', async () => {
        const slow = new Promise<string>(r => setTimeout(() => r('slow'), 30));
        const result = await withTaskTimeout(slow, -5, 't1');
        assert.strictEqual(result, 'slow');
    });

    test('rejects with task id + seconds in message when inner never settles', async () => {
        const never = new Promise(() => { /* never settles */ });
        await assert.rejects(
            () => withTaskTimeout(never, 0.02, 'slow-task'),
            /Task 'slow-task' timed out after 0\.02s\./
        );
    });

    test('invokes onTimeout exactly once when the timer fires', async () => {
        let fired = 0;
        const never = new Promise(() => { /* never */ });
        try {
            await withTaskTimeout(never, 0.02, 't1', () => { fired += 1; });
        } catch { /* expected */ }
        // Give the original promise a moment to confirm we don't double-fire.
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(fired, 1);
    });

    test('does NOT invoke onTimeout when inner resolves in time', async () => {
        let fired = 0;
        await withTaskTimeout(Promise.resolve('ok'), 1, 't1', () => { fired += 1; });
        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(fired, 0);
    });

    test('does not leak unhandled rejection if inner settles after timeout', async () => {
        const err = new Error('late-failure');
        const late = new Promise((_r, reject) => setTimeout(() => reject(err), 30));
        await assert.rejects(
            () => withTaskTimeout(late, 0.01, 't1'),
            /timed out/
        );
        // Allow the original rejection to surface. If we leaked it, Node would
        // print an "UnhandledPromiseRejection" warning. We can't assert that
        // directly in unit tests, but awaiting past the rejection confirms
        // the process stays alive.
        await new Promise(r => setTimeout(r, 50));
    });

    test('swallows onTimeout callback errors so the outer rejection still fires', async () => {
        const never = new Promise(() => { /* never */ });
        await assert.rejects(
            () => withTaskTimeout(never, 0.01, 't1', () => { throw new Error('cleanup-failed'); }),
            /timed out after 0\.01s/
        );
    });
});

suite('withInteractivePromptLock — serializes concurrent dialog runs', () => {
    test('runs serially even when callers fire in parallel', async () => {
        const events: string[] = [];
        const makeTask = (label: string, ms: number) => async () => {
            events.push(`start:${label}`);
            await new Promise(r => setTimeout(r, ms));
            events.push(`end:${label}`);
            return label;
        };
        // Fire three "dialogs" simultaneously; the lock must serialize
        // them so we never see two starts back-to-back.
        const results = await Promise.all([
            withInteractivePromptLock(makeTask('A', 10)),
            withInteractivePromptLock(makeTask('B', 5)),
            withInteractivePromptLock(makeTask('C', 1)),
        ]);
        assert.deepStrictEqual(results, ['A', 'B', 'C']);
        assert.deepStrictEqual(events, [
            'start:A', 'end:A',
            'start:B', 'end:B',
            'start:C', 'end:C',
        ]);
    });

    test('a holder rejection does not poison the chain', async () => {
        const events: string[] = [];
        const first = withInteractivePromptLock(async () => {
            events.push('first');
            throw new Error('boom');
        });
        const second = withInteractivePromptLock(async () => {
            events.push('second');
            return 'ok';
        });
        await assert.rejects(() => first, /boom/);
        const r = await second;
        assert.strictEqual(r, 'ok');
        assert.deepStrictEqual(events, ['first', 'second']);
    });

    test('propagates fn rejection to its own caller only', async () => {
        const first = withInteractivePromptLock(async () => { throw new Error('first-failed'); });
        const second = withInteractivePromptLock(async () => 42);
        await assert.rejects(() => first, /first-failed/);
        assert.strictEqual(await second, 42);
    });

    test('lock stays held until fn settles even if caller abandons the returned Promise', async () => {
        // Simulates the executor's interactive timeout: the caller wraps
        // our return value in `Promise.race` against a timeout. The
        // outer race may reject while `fn`'s dialog is still showing —
        // the next interactive task must NOT be able to open its dialog
        // until the original `fn`'s promise actually settles.
        let releaseDialog!: (value: string) => void;
        const dialog = new Promise<string>(resolve => { releaseDialog = resolve; });
        let secondStarted = false;

        const first = withInteractivePromptLock(() => dialog);
        // Caller "abandons" the first promise via timeout-style race;
        // attach a no-op catch so the unhandled rejection guard doesn't
        // trip when we don't await first directly.
        first.catch(() => { /* swallowed by caller */ });
        const racedFirst = Promise.race([
            first,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('outer-timeout')), 5))
        ]);
        await assert.rejects(() => racedFirst, /outer-timeout/);

        // Second caller queues up; its `fn` must not run yet.
        const second = withInteractivePromptLock(async () => { secondStarted = true; return 'B'; });

        // Give microtasks several turns — second must still be blocked.
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 1));
        }
        assert.strictEqual(secondStarted, false,
            'second interactive task started while first dialog was still pending');

        // Now settle the underlying dialog; second should be released.
        releaseDialog('A');
        assert.strictEqual(await second, 'B');
        assert.strictEqual(secondStarted, true);
        assert.strictEqual(await first, 'A');
    });
});
