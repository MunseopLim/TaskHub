import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	interpolatePipelineVariables,
	sanitizeInterpolatedValue,
	resolveWithinWorkspace,
	parseTagInput,
	serializeFavorites,
	serializeLinks,
	quotePowerShellArgument,
	quoteWindowsCommandLineArgument,
	quotePosixArgument,
	tokenizeCommandLine,
	formatActionPath,
	mergeCommandAndArgs,
	handleStringManipulation,
	findActionById,
	findActionPathById,
	insertActionIntoDestination,
	buildDestinationPickItems,
	deriveActionIdFromTitle,
	buildActionCommandId,
	validateActionIdInput,
	deriveLinkTitleFromUrl,
	createGroupedTaskPresentationOptions,
	addLinkEntry,
	removeLinkByIdentity,
	addFavoriteEntry,
	confirmDeleteHistoryItem,
	confirmApplyPresetBackup,
	confirmSavePresetOverwrite,
	getCommandString,
	getToolCommand,
	buildPowerShellInvocation,
	buildNativeCommandInvocation,
	windowsCommandIsDirectlyLaunchable,
	resolveWindowsRawShell,
	rawCommandUsesChainOperators,
	windowsSpawnStrategy,
	buildRawOneShotWindowsScript,
	assertWindowsRawShellSupports,
	buildPosixCommandLine,
	encodePowerShellScript,
	wrapCommandForOneShot,
	createShellExecution,
	filterConflictingItems,
	findConflictingIds,
	mergeActions,
	toWorkspaceRelativePath,
	executeShellCommand,
	__testHook_hasManuallyTerminated,
	debounce,
	parsePathInfo,
	handleConfirm,
	serializeExportData,
	parseImportData,
	mergeImportedActions,
	countActionItems,
	getActionsValidator,
	invalidateActionsCache,
	shouldRecordTaskInput,
	formatExecutedCommandsDocument,
} from '../extension';
import { normalizeTags, normalizeLineNumber } from '../providers/normalization';
import { LinkViewProvider, readLinksFromDisk } from '../providers/linkViewProvider';
import { FavoriteViewProvider, readFavoritesFromDisk } from '../providers/favoriteViewProvider';
import {
	HistoryProvider,
	HistoryEntry,
	createToolHistoryEntry,
	isToolHistoryEntry,
	formatDuration,
	formatHistoryTimestamp,
	formatLastRunBadge,
	buildHistoryItemAriaLabel,
	startHistoryAutoRefresh,
	computeDisambiguatedHistoryLabels,
} from '../providers/historyProvider';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ActionItem } from '../schema';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	suite('interpolatePipelineVariables', () => {
		test('should replace simple variable', () => {
			const template = 'Hello ${name}';
			const context = { name: 'World' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Hello World');
		});

		test('should replace task output variable', () => {
			const template = 'File: ${task1.output}';
			const context = { task1: { output: 'result.txt' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'File: result.txt');
		});

		test('should replace nested property', () => {
			const template = 'Path: ${task1.path}';
			const context = { task1: { path: '/path/to/file' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Path: /path/to/file');
		});

		test('should replace multiple variables', () => {
			const template = '${task1.name} and ${task2.name}';
			const context = { task1: { name: 'Alice' }, task2: { name: 'Bob' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Alice and Bob');
		});

		test('should leave unmatched variables unchanged', () => {
			const template = 'Hello ${unknown}';
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Hello ${unknown}');
		});

		test('should handle non-string template', () => {
			const template = 123 as any;
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 123);
		});

		test('should handle empty template', () => {
			const template = '';
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, '');
		});

		test('should replace outputDir variable', () => {
			const template = 'Output: ${task1.outputDir}';
			const context = { task1: { outputDir: '/output/dir' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Output: /output/dir');
		});

		test('should prefer nested property over output', () => {
			const template = 'Path: ${task1.path}';
			const context = { task1: { path: '/custom/path', output: '/default/path' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Path: /custom/path');
		});

		test('should use output when nested property is undefined', () => {
			const template = 'Output: ${task1.result}';
			const context = { task1: { output: 'fallback' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Output: fallback');
		});

		test('should use outputDir when output is undefined', () => {
			const template = 'Dir: ${task1.result}';
			const context = { task1: { outputDir: '/dir' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Dir: /dir');
		});

		test('should handle deeply nested properties', () => {
			const template = 'Value: ${task1.data}';
			const context = { task1: { data: { info: { value: 'deep' } } } };
			const result = interpolatePipelineVariables(template, context);
			// Note: interpolatePipelineVariables only handles one level of nesting
			// For deeply nested properties, the object is converted to string
			assert.ok(result.includes('Value:'));
		});

		test('should handle variables with special characters', () => {
			const template = 'Value: ${task_1.name}';
			const context = { task_1: { name: 'special' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: special');
		});

		test('should handle empty variable name', () => {
			const template = 'Value: ${}';
			const context = {};
			const result = interpolatePipelineVariables(template, context);
			// Empty variable name should be left unchanged
			assert.strictEqual(result, 'Value: ${}');
		});

		test('should handle variables with numbers', () => {
			const template = 'Task ${task1.id}: ${task1.name}';
			const context = { task1: { id: 123, name: 'test' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Task 123: test');
		});

		test('should handle boolean values', () => {
			const template = 'Status: ${task1.success}';
			const context = { task1: { success: true } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Status: true');
		});

		test('should leave the placeholder when the resolved value is null', () => {
			// sanitizeInterpolatedValue now refuses null to avoid injecting "null"
			// strings into shell commands; the placeholder remains untouched instead.
			const template = 'Value: ${task1.data}';
			const context = { task1: { data: null } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: ${task1.data}');
		});

		test('should handle undefined values in context', () => {
			const template = 'Value: ${task1.missing}';
			const context = { task1: {} };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: ${task1.missing}');
		});

		test('should handle multiple variables in same string', () => {
			const template = '${a} and ${b} and ${c}';
			const context = { a: 'first', b: 'second', c: 'third' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'first and second and third');
		});

		test('should handle adjacent variables', () => {
			const template = '${a}${b}';
			const context = { a: 'hello', b: 'world' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'helloworld');
		});

		test('should handle variable at start of string', () => {
			const template = '${name} is here';
			const context = { name: 'John' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'John is here');
		});

		test('should handle variable at end of string', () => {
			const template = 'Hello ${name}';
			const context = { name: 'World' };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Hello World');
		});

		test('should reject interpolated values containing a null byte', () => {
			const template = 'echo ${payload}';
			const context = { payload: 'safe\x00danger' };
			assert.throws(() => interpolatePipelineVariables(template, context), /null byte/);
		});

		test('should reject interpolated values exceeding the maximum length', () => {
			const huge = 'a'.repeat(40 * 1024);
			const template = 'echo ${payload}';
			const context = { payload: huge };
			assert.throws(() => interpolatePipelineVariables(template, context), /maximum length/);
		});

		test('should coerce numbers and booleans but skip objects', () => {
			const template = '${count} ${flag} ${obj}';
			const context = { count: 42, flag: true, obj: { a: 1 } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, '42 true ${obj}');
		});
	});

	suite('sanitizeInterpolatedValue', () => {
		test('accepts plain strings', () => {
			assert.strictEqual(sanitizeInterpolatedValue('hello'), 'hello');
		});
		test('returns undefined for null/undefined/objects', () => {
			assert.strictEqual(sanitizeInterpolatedValue(undefined), undefined);
			assert.strictEqual(sanitizeInterpolatedValue(null), undefined);
			assert.strictEqual(sanitizeInterpolatedValue({ a: 1 }), undefined);
			assert.strictEqual(sanitizeInterpolatedValue([1, 2]), undefined);
		});
		test('rejects strings with null byte', () => {
			assert.throws(() => sanitizeInterpolatedValue('x\x00y'), /null byte/);
		});
	});

	suite('resolveWithinWorkspace', () => {
		const root = path.resolve(os.tmpdir(), 'taskhub-test-root');
		test('accepts paths inside workspace', () => {
			const inside = path.join(root, 'nested', 'file.txt');
			const resolved = resolveWithinWorkspace(inside, [root]);
			assert.strictEqual(resolved, inside);
		});
		test('accepts the root itself', () => {
			const resolved = resolveWithinWorkspace(root, [root]);
			assert.strictEqual(resolved, root);
		});
		test('rejects parent-directory traversal', () => {
			const escape = path.join(root, '..', 'other', 'secret.txt');
			assert.throws(() => resolveWithinWorkspace(escape, [root]), /outside/);
		});
		test('rejects paths with null bytes', () => {
			assert.throws(() => resolveWithinWorkspace('/tmp/foo\x00bar', [root]), /null byte/);
		});
		test('rejects when no workspace is provided', () => {
			assert.throws(() => resolveWithinWorkspace('/tmp/foo', []), /No workspace/);
		});
		test('accepts path under any of multiple roots', () => {
			const other = path.resolve(os.tmpdir(), 'taskhub-test-other');
			const inside = path.join(other, 'a.txt');
			const resolved = resolveWithinWorkspace(inside, [root, other]);
			assert.strictEqual(resolved, inside);
		});
		test('resolves relative paths against the baseDir (action workspace)', () => {
			// Regression: previously used process.cwd() as the base, which made
			// "report.txt" land in an unpredictable directory.
			const resolved = resolveWithinWorkspace('report.txt', [root], root);
			assert.strictEqual(resolved, path.join(root, 'report.txt'));
		});
		test('resolves relative subpaths against the baseDir', () => {
			const resolved = resolveWithinWorkspace('build/out/report.txt', [root], root);
			assert.strictEqual(resolved, path.join(root, 'build', 'out', 'report.txt'));
		});
		test('rejects relative paths that escape the root via ..', () => {
			assert.throws(
				() => resolveWithinWorkspace('../secret.txt', [root], root),
				/outside/
			);
		});
		test('falls back to the first workspace root when no baseDir is provided', () => {
			const resolved = resolveWithinWorkspace('report.txt', [root]);
			assert.strictEqual(resolved, path.join(root, 'report.txt'));
		});
	});

	suite('normalizeTags', () => {
		test('should return undefined for non-array input', () => {
			assert.strictEqual(normalizeTags(null), undefined);
			assert.strictEqual(normalizeTags(undefined), undefined);
			assert.strictEqual(normalizeTags('string'), undefined);
			assert.strictEqual(normalizeTags({}), undefined);
		});

		test('should return undefined for empty array', () => {
			assert.strictEqual(normalizeTags([]), undefined);
		});

		test('should normalize string array', () => {
			const result = normalizeTags(['tag1', 'tag2', 'tag3']);
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should trim tags', () => {
			const result = normalizeTags(['  tag1  ', '  tag2  ', 'tag3']);
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should filter out empty tags', () => {
			const result = normalizeTags(['tag1', '', 'tag2', '   ', 'tag3']);
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should filter out non-string items', () => {
			const result = normalizeTags(['tag1', 123, null, 'tag2', undefined]);
			assert.deepStrictEqual(result, ['tag1', 'tag2']);
		});

		test('should return undefined if all tags are filtered out', () => {
			const result = normalizeTags(['', '   ', 123, null]);
			assert.strictEqual(result, undefined);
		});
	});

	suite('parseTagInput', () => {
		test('should return undefined for undefined input', () => {
			assert.strictEqual(parseTagInput(undefined), undefined);
		});

		test('should return undefined for empty string', () => {
			assert.strictEqual(parseTagInput(''), undefined);
		});

		test('should parse comma-separated tags', () => {
			const result = parseTagInput('tag1,tag2,tag3');
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should trim tags', () => {
			const result = parseTagInput('  tag1  ,  tag2  , tag3');
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should filter out empty tags', () => {
			const result = parseTagInput('tag1,,tag2,  ,tag3');
			assert.deepStrictEqual(result, ['tag1', 'tag2', 'tag3']);
		});

		test('should return undefined if all tags are empty', () => {
			const result = parseTagInput(',  ,  ');
			assert.strictEqual(result, undefined);
		});
	});

	suite('serializeFavorites', () => {
		test('should serialize basic favorite entry', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' }
			]);
		});

		test('should serialize favorite with group', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1' }
			]);
		});

		test('should serialize favorite with tags', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', tags: ['tag1', 'tag2'] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', tags: ['tag1', 'tag2'] }
			]);
		});

		test('should serialize favorite with line', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', line: 15 }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', line: 15 }
			]);
		});

		test('should serialize favorite with group and tags', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1', tags: ['tag1'] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1', group: 'Group1', tags: ['tag1'] }
			]);
		});

		test('should not include empty tags array', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1', tags: [] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' }
			]);
		});

		test('should handle multiple entries', () => {
			const entries = [
				{ title: 'File1', path: '/path/to/file1' },
				{ title: 'File2', path: '/path/to/file2', group: 'Group1' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' },
				{ title: 'File2', path: '/path/to/file2', group: 'Group1' }
			]);
		});

		test('should omit metadata fields', () => {
			const entries = [
				{
					title: 'File1',
					path: '/path/to/file1',
					sourceFile: '/workspace/.vscode/favorites.json',
					workspaceFolder: '/workspace'
				}
			];
			const result = serializeFavorites(entries as any);
			assert.deepStrictEqual(result, [
				{ title: 'File1', path: '/path/to/file1' }
			]);
		});
	});

	suite('serializeLinks', () => {
		test('should serialize basic link entry', () => {
			const entries = [
				{ title: 'Link1', link: 'https://example.com' }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: 'Link1', link: 'https://example.com' }
			]);
		});

		test('should serialize link with group and tags', () => {
			const entries = [
				{ title: 'Link1', link: 'https://example.com', group: 'Group1', tags: ['tag1'] }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: 'Link1', link: 'https://example.com', group: 'Group1', tags: ['tag1'] }
			]);
		});

		test('should omit metadata fields', () => {
			const entries = [
				{
					title: 'Link1',
					link: 'https://example.com',
					group: 'Group1',
					tags: ['tag1'],
					sourceFile: '/workspace/.vscode/links.json'
				}
			];
			const result = serializeLinks(entries as any);
			assert.deepStrictEqual(result, [
				{ title: 'Link1', link: 'https://example.com', group: 'Group1', tags: ['tag1'] }
			]);
		});
	});

	suite('quotePowerShellArgument', () => {
		test('should quote empty string', () => {
			const result = quotePowerShellArgument('');
			assert.strictEqual(result, "''");
		});

		test('should quote simple string', () => {
			const result = quotePowerShellArgument('hello');
			assert.strictEqual(result, "'hello'");
		});

		test('should escape single quotes', () => {
			const result = quotePowerShellArgument("don't");
			assert.strictEqual(result, "'don''t'");
		});

		test('should handle string with spaces', () => {
			const result = quotePowerShellArgument('hello world');
			assert.strictEqual(result, "'hello world'");
		});
	});

	suite('Windows native command helpers', () => {
		test('quoteWindowsCommandLineArgument preserves embedded quotes', () => {
			assert.strictEqual(
				quoteWindowsCommandLineArgument('process.stdout.write("ok")'),
				'"process.stdout.write(\\"ok\\")"'
			);
		});

		test('buildNativeCommandInvocation keeps argv boundaries', () => {
			const result = buildNativeCommandInvocation('node', ['-e', 'process.stdout.write("ok")']);
			assert.strictEqual(result.executable, 'node');
			assert.deepStrictEqual(result.args, ['-e', 'process.stdout.write("ok")']);
		});

		test('windowsCommandIsDirectlyLaunchable: explicit .exe/.com is launchable, scripts/shims/builtins are not', () => {
			const lookup = {
				env: { PATH: 'C:\\bin;C:\\tools' },
				isFile: (p: string) => p === 'C:\\bin\\node.exe' || p === 'C:\\tools\\git.exe',
			};
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('node', ['-e', 'x'], lookup), true);   // resolves to node.exe
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('git status', [], lookup), true);       // resolves to git.exe
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('npm test', [], lookup), false);        // only npm.cmd would exist
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('node.exe', ['-e', 'x'], lookup), true); // explicit ext, no lookup
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('C:\\tools\\7z.exe', ['a'], lookup), true);
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('build.cmd', [], lookup), false);       // script shim
			assert.strictEqual(windowsCommandIsDirectlyLaunchable('echo hi', [], lookup), false);         // shell builtin/alias
		});
	});

	/**
	 * Windows 의 raw `shell` 계약 (0.6.49).
	 *
	 * **실행 자체는 macOS 에서 검증할 수 없다.** 그래서 계약을 순수 함수로
	 * 뽑아 여기서 고정한다 — 셸 선택, 연산자 지원 여부, 세 실행 모드가
	 * 공유하는 분기 순서, one-shot 스크립트 조립까지.
	 */
	suite('Windows raw shell 계약', () => {
		const withPwsh = {
			env: { PATH: 'C:\\ps' },
			isFile: (p: string) => p === 'C:\\ps\\pwsh.exe',
		};
		const withoutPwsh = {
			env: { PATH: 'C:\\bin' },
			isFile: (p: string) => p === 'C:\\bin\\node.exe',
		};

		test('pwsh.exe 가 PATH 에 있으면 그것을 쓴다 (&& 지원)', () => {
			assert.deepStrictEqual(resolveWindowsRawShell(withPwsh), {
				executable: 'pwsh.exe', supportsChainOperators: true,
			});
		});

		test('없으면 powershell.exe 로 떨어지고 && 를 지원하지 않는다고 표시한다', () => {
			assert.deepStrictEqual(resolveWindowsRawShell(withoutPwsh), {
				executable: 'powershell.exe', supportsChainOperators: false,
			});
		});

		test('rawCommandUsesChainOperators 는 && / || 만 본다', () => {
			assert.strictEqual(rawCommandUsesChainOperators('a && b'), true);
			assert.strictEqual(rawCommandUsesChainOperators('a || b'), true);
			// 5.1 도 파이프와 리다이렉션·세미콜론은 파싱한다 — 이것까지 막으면
			// 동작하는 명령을 우리가 거부하게 된다.
			assert.strictEqual(rawCommandUsesChainOperators('a | b'), false);
			assert.strictEqual(rawCommandUsesChainOperators('a > out.txt'), false);
			assert.strictEqual(rawCommandUsesChainOperators('a; b'), false);
		});

		test('5.1 에 && 를 넘기려 하면 원인과 해결책을 담아 실패한다', () => {
			assert.throws(
				() => assertWindowsRawShellSupports('make && make flash', withoutPwsh),
				/PowerShell 7|pwsh/,
				'파스 오류로 넘기지 말고 이유를 설명해야 한다'
			);
			// pwsh 가 있으면 그대로 통과한다.
			assert.strictEqual(
				assertWindowsRawShellSupports('make && make flash', withPwsh).executable, 'pwsh.exe');
			// 연산자가 없으면 5.1 에서도 통과한다.
			assert.strictEqual(
				assertWindowsRawShellSupports('make flash', withoutPwsh).executable, 'powershell.exe');
		});

		test('raw 는 직접 실행 가능한 명령이어도 native argv 경로를 타지 않는다', () => {
			// 이것이 캡처 모드가 깨졌던 지점이다 — native 로 가면 `&&` 가
			// 리터럴 인자가 된다. raw 판정이 native 판정보다 앞서야 한다.
			assert.strictEqual(windowsSpawnStrategy(true, true), 'raw-shell');
			assert.strictEqual(windowsSpawnStrategy(true, false), 'raw-shell');
			assert.strictEqual(windowsSpawnStrategy(false, true), 'native');
			assert.strictEqual(windowsSpawnStrategy(false, false), 'powershell');
		});

		test('one-shot 은 인터프리터를 Start-Process 로 떼어 내고 명령은 인코딩해 넘긴다', () => {
			const script = buildRawOneShotWindowsScript('pwsh.exe', 'QQBCAEMA', 'C:\\proj dir');
			assert.match(script, /^Start-Process -FilePath 'pwsh\.exe'/);
			assert.match(script, /-EncodedCommand', 'QQBCAEMA'/);
			// 공백이 든 경로가 인용된다.
			assert.ok(script.includes("-WorkingDirectory 'C:\\proj dir'"), script);
			assert.match(script, /-WindowStyle Hidden/);
			// cwd 가 없으면 그 인자를 아예 넣지 않는다.
			assert.ok(!buildRawOneShotWindowsScript('pwsh.exe', 'QQ', undefined).includes('-WorkingDirectory'));
		});
	});

	suite('quotePosixArgument', () => {
		test('should quote empty string', () => {
			const result = quotePosixArgument('');
			assert.strictEqual(result, "''");
		});

		test('should quote simple string', () => {
			const result = quotePosixArgument('hello');
			assert.strictEqual(result, "'hello'");
		});

		test('should escape single quotes', () => {
			const result = quotePosixArgument("don't");
			assert.strictEqual(result, "'don'\\''t'");
		});

		test('should handle string with spaces', () => {
			const result = quotePosixArgument('hello world');
			assert.strictEqual(result, "'hello world'");
		});
	});

	suite('tokenizeCommandLine', () => {
		test('should tokenize simple command', () => {
			const result = tokenizeCommandLine('echo hello');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should tokenize command with multiple args', () => {
			const result = tokenizeCommandLine('ls -la /path/to/dir');
			assert.deepStrictEqual(result, ['ls', '-la', '/path/to/dir']);
		});

		test('should handle quoted arguments', () => {
			const result = tokenizeCommandLine('echo "hello world"');
			assert.deepStrictEqual(result, ['echo', 'hello world']);
		});

		test('should handle single-quoted arguments', () => {
			const result = tokenizeCommandLine("echo 'hello world'");
			assert.deepStrictEqual(result, ['echo', 'hello world']);
		});

		test('should handle escaped quotes', () => {
			const result = tokenizeCommandLine('echo "hello\\"world"');
			assert.deepStrictEqual(result, ['echo', 'hello"world']);
		});

		test('should handle path with spaces', () => {
			const result = tokenizeCommandLine('cat "/path/to/file name.txt"');
			assert.deepStrictEqual(result, ['cat', '/path/to/file name.txt']);
		});

		test('should handle empty command', () => {
			const result = tokenizeCommandLine('');
			assert.deepStrictEqual(result, []);
		});

		test('should handle multiple spaces', () => {
			const result = tokenizeCommandLine('echo    hello    world');
			assert.deepStrictEqual(result, ['echo', 'hello', 'world']);
		});

		test('should handle leading spaces', () => {
			const result = tokenizeCommandLine('   echo hello');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should handle trailing spaces', () => {
			const result = tokenizeCommandLine('echo hello   ');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should handle mixed quotes', () => {
			const result = tokenizeCommandLine('echo "hello" \'world\'');
			assert.deepStrictEqual(result, ['echo', 'hello', 'world']);
		});

		test('should handle escaped backslash in double quotes', () => {
			const result = tokenizeCommandLine('echo "C:\\\\path"');
			assert.deepStrictEqual(result, ['echo', 'C:\\path']);
		});

		test('should handle escaped quote in double quotes', () => {
			const result = tokenizeCommandLine('echo "hello\\"world"');
			assert.deepStrictEqual(result, ['echo', 'hello"world']);
		});

		test('should handle single character arguments', () => {
			const result = tokenizeCommandLine('ls -a -l');
			assert.deepStrictEqual(result, ['ls', '-a', '-l']);
		});

		test('should handle command with only quotes', () => {
			const result = tokenizeCommandLine('""');
			// Empty quoted string: when quotes are closed, current is empty
			// so no token is added to the array, resulting in empty array
			assert.deepStrictEqual(result, []);
		});

		test('should handle unclosed quote', () => {
			const result = tokenizeCommandLine('echo "hello');
			assert.deepStrictEqual(result, ['echo', 'hello']);
		});

		test('should handle nested quotes', () => {
			const result = tokenizeCommandLine('echo "outer \'inner\' outer"');
			assert.deepStrictEqual(result, ['echo', "outer 'inner' outer"]);
		});

		test('should handle command with tabs and newlines', () => {
			const result = tokenizeCommandLine('echo\thello\nworld');
			assert.deepStrictEqual(result, ['echo', 'hello', 'world']);
		});
	});

	suite('formatActionPath', () => {
		test('should format path with parts', () => {
			const result = formatActionPath(['Folder1', 'Folder2', 'Action']);
			assert.strictEqual(result, 'Folder1 > Folder2 > Action');
		});

		test('should return "(root)" for empty array', () => {
			const result = formatActionPath([]);
			assert.strictEqual(result, '(root)');
		});

		test('should format single part', () => {
			const result = formatActionPath(['Action']);
			assert.strictEqual(result, 'Action');
		});

		test('should handle multiple parts', () => {
			const result = formatActionPath(['A', 'B', 'C', 'D']);
			assert.strictEqual(result, 'A > B > C > D');
		});
	});

	suite('mergeCommandAndArgs', () => {
		test('should merge command with extra args', () => {
			const result = mergeCommandAndArgs('echo hello', ['world']);
			assert.strictEqual(result.executable, 'echo');
			assert.deepStrictEqual(result.args, ['hello', 'world']);
		});

		test('should handle command without args', () => {
			const result = mergeCommandAndArgs('echo', ['hello', 'world']);
			assert.strictEqual(result.executable, 'echo');
			assert.deepStrictEqual(result.args, ['hello', 'world']);
		});

		test('should handle command with existing args', () => {
			const result = mergeCommandAndArgs('ls -la', ['-h']);
			assert.strictEqual(result.executable, 'ls');
			assert.deepStrictEqual(result.args, ['-la', '-h']);
		});

		test('should handle quoted command with spaces', () => {
			const result = mergeCommandAndArgs('"/path/to/app"', ['arg1']);
			assert.strictEqual(result.executable, '/path/to/app');
			assert.deepStrictEqual(result.args, ['arg1']);
		});

		test('should throw error for empty command', () => {
			assert.throws(() => {
				mergeCommandAndArgs('', []);
			}, /Cannot execute an empty command/);
		});

		test('should handle command with multiple existing args', () => {
			const result = mergeCommandAndArgs('git commit -m "message"', ['--no-verify']);
			assert.strictEqual(result.executable, 'git');
			assert.deepStrictEqual(result.args.length, 4);
			assert.strictEqual(result.args[0], 'commit');
			assert.strictEqual(result.args[1], '-m');
			assert.strictEqual(result.args[2], 'message');
			assert.strictEqual(result.args[3], '--no-verify');
		});
	});

	suite('handleStringManipulation', () => {
		test('should strip extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'stripExtension',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, '/path/to/file');
		});

		test('should return basename', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, 'file.txt');
		});

		test('should return basename without extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basenameWithoutExtension',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, 'file');
		});

		test('should return dirname', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'dirname',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, '/path/to');
		});

		test('should return extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'extension',
				input: '/path/to/file.txt'
			});
			assert.strictEqual(result.output, 'txt');
		});

		test('should convert to lowercase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toLowerCase',
				input: 'Hello World'
			});
			assert.strictEqual(result.output, 'hello world');
		});

		test('should convert to uppercase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toUpperCase',
				input: 'Hello World'
			});
			assert.strictEqual(result.output, 'HELLO WORLD');
		});

		test('should trim string', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'trim',
				input: '  hello world  '
			});
			assert.strictEqual(result.output, 'hello world');
		});

		test('should handle file without extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'stripExtension',
				input: '/path/to/file'
			});
			assert.strictEqual(result.output, '/path/to/file');
		});

		test('should handle empty extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'extension',
				input: '/path/to/file.'
			});
			assert.strictEqual(result.output, '');
		});

		test('should throw error for non-string input', async () => {
			await assert.rejects(async () => {
				await handleStringManipulation({
					id: 'test',
					function: 'basename',
					input: 123 as any
				});
			}, /requires the 'input' property to be a string/);
		});

		test('should throw error for unsupported function', async () => {
			await assert.rejects(async () => {
				await handleStringManipulation({
					id: 'test',
					function: 'unknownFunction',
					input: 'test'
				});
			}, /Unsupported string manipulation function/);
		});

		test('should handle Windows path', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: 'C:\\path\\to\\file.txt'
			});
			// path.basename handles Windows paths correctly, but preserves backslashes on non-Windows systems
			// So we just check that it returns something reasonable
			assert.ok(result.output.includes('file.txt'));
		});

		test('should handle path with multiple dots', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basenameWithoutExtension',
				input: '/path/to/file.min.js'
			});
			assert.strictEqual(result.output, 'file.min');
		});

		test('should handle root path for dirname', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'dirname',
				input: '/file.txt'
			});
			assert.strictEqual(result.output, '/');
		});

		test('should handle relative path', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: './file.txt'
			});
			assert.strictEqual(result.output, 'file.txt');
		});

		test('should handle path with no extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'extension',
				input: '/path/to/file'
			});
			assert.strictEqual(result.output, '');
		});

		test('should handle file with only extension', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basenameWithoutExtension',
				input: '/path/to/.gitignore'
			});
			assert.strictEqual(result.output, '.gitignore');
		});

		test('should handle empty string input', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: ''
			});
			assert.strictEqual(result.output, '');
		});

		test('should handle string with only whitespace for trim', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'trim',
				input: '   '
			});
			assert.strictEqual(result.output, '');
		});

		test('should handle string with newlines for trim', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'trim',
				input: '\n\thello\n\t'
			});
			assert.strictEqual(result.output, 'hello');
		});

		test('should handle mixed case for toLowerCase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toLowerCase',
				input: 'Hello WORLD 123'
			});
			assert.strictEqual(result.output, 'hello world 123');
		});

		test('should handle mixed case for toUpperCase', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'toUpperCase',
				input: 'hello world 123'
			});
			assert.strictEqual(result.output, 'HELLO WORLD 123');
		});

		test('should handle path with trailing slash', async () => {
			const result = await handleStringManipulation({
				id: 'test',
				function: 'basename',
				input: '/path/to/dir/'
			});
			// path.basename handles trailing slashes
			assert.ok(result.output.length > 0);
		});

			test('should handle path with multiple slashes', async () => {
				const result = await handleStringManipulation({
					id: 'test',
					function: 'dirname',
					input: '/path//to///file.txt'
				});
				// path.normalize handles this
				assert.ok(result.output.includes('/'));
			});
		});

	suite('findActionById', () => {
		const sampleActions: ActionItem[] = [
			{
				id: 'root-action',
				title: 'Root Action',
				action: { description: 'Root description', tasks: [] }
			},
			{
				id: 'folder',
				title: 'Folder',
				children: [
					{
						id: 'nested-action',
						title: 'Nested Action',
						action: { description: 'Nested description', tasks: [] }
					}
				]
			}
		];

		test('should return top-level action when id matches', () => {
			const result = findActionById(sampleActions, 'root-action');
			assert.ok(result);
			assert.strictEqual(result?.title, 'Root Action');
		});

		test('should return nested action when id matches child', () => {
			const result = findActionById(sampleActions, 'nested-action');
			assert.ok(result);
			assert.strictEqual(result?.title, 'Nested Action');
		});

		test('should return undefined when id is not found', () => {
			const result = findActionById(sampleActions, 'missing');
			assert.strictEqual(result, undefined);
		});
	});

	suite('findActionPathById', () => {
		// Pins history label disambiguation: HistoryEntry.actionPath is built from
		// this helper at execute-time so HistoryItem labels can swap in the
		// folder breadcrumb when same-title actions collide. Path includes
		// the action's own title at the end.
		const tree: ActionItem[] = [
			{
				id: 'root-build',
				title: 'Build',
				action: { description: '', tasks: [] }
			},
			{
				id: 'fw',
				title: 'Firmware',
				children: [
					{
						id: 'fw-build',
						title: 'Build',
						action: { description: '', tasks: [] }
					},
					{
						id: 'fw-sub',
						title: 'Sub',
						children: [
							{
								id: 'fw-sub-build',
								title: 'Build',
								action: { description: '', tasks: [] }
							}
						]
					}
				]
			}
		];

		test('returns single-element path for root-level action', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'root-build'), ['Build']);
		});

		test('returns folder + title path for nested action', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'fw-build'), ['Firmware', 'Build']);
		});

		test('returns full chain for deeply nested action', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'fw-sub-build'), ['Firmware', 'Sub', 'Build']);
		});

		test('returns undefined for missing id', () => {
			assert.strictEqual(findActionPathById(tree, 'nope'), undefined);
		});

		test('returns folder path when id matches a folder itself', () => {
			assert.deepStrictEqual(findActionPathById(tree, 'fw'), ['Firmware']);
		});
	});

	suite('computeDisambiguatedHistoryLabels', () => {
		// Pins history label disambiguation: label swap only fires when two
		// distinct actionIds share the same actionTitle. Same actionId
		// repeated (re-runs) is NOT a collision — that's the common case
		// and must stay terse.
		function entry(partial: Partial<HistoryEntry> & Pick<HistoryEntry, 'actionId' | 'actionTitle'>): HistoryEntry {
			return {
				timestamp: 0,
				status: 'success',
				...partial
			};
		}

		test('no collision → all labels undefined (HistoryItem falls back to title)', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'b', actionTitle: 'Flash', actionPath: ['Firmware', 'Flash'] })
			]);
			assert.deepStrictEqual(labels, [undefined, undefined]);
		});

		test('repeated runs of same action do not count as collision', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 3 }),
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 2 }),
				entry({ actionId: 'a', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 1 })
			]);
			assert.deepStrictEqual(labels, [undefined, undefined, undefined]);
		});

		test('collision → both colliding entries get full breadcrumb', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, ['Firmware > Build', 'Bootloader > Build']);
		});

		test('collision affects only entries that share the title', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] }),
				entry({ actionId: 'flash', actionTitle: 'Flash', actionPath: ['Firmware', 'Flash'] })
			]);
			assert.deepStrictEqual(labels, ['Firmware > Build', 'Bootloader > Build', undefined]);
		});

		test('legacy entry (no actionPath) on collision falls back to `Title (actionId)`', () => {
			// Without recorded path data the breadcrumb can't help, but the
			// distinct-id invariant still holds: append actionId so the
			// legacy row is visually distinct from the colliding one.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw', actionTitle: 'Build' }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, ['Build (fw)', 'Bootloader > Build']);
		});

		test('root-level action (actionPath of length 1) on collision falls back to `Title (actionId)`', () => {
			// A root action's path is just [title] — joining yields the
			// title back, providing zero disambiguation. Use the id suffix
			// instead so the row is distinct from the nested colliding entry.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'root', actionTitle: 'Build', actionPath: ['Build'] }),
				entry({ actionId: 'fw', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] })
			]);
			assert.deepStrictEqual(labels, ['Build (root)', 'Firmware > Build']);
		});

		test('empty input → empty output', () => {
			assert.deepStrictEqual(computeDisambiguatedHistoryLabels([]), []);
		});

		test('two distinct actionIds with the same actionPath → both get (id) suffix', () => {
			// Possible when the action tree contains a duplicated folder
			// structure (two `Firmware` folders both holding `Build`), or
			// when a legacy entry's stored path matches a renamed action's
			// current path. Step 1 alone would leave both rows as
			// "Firmware > Build" with no way to tell them apart — step 2
			// must append the actionId to both.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw1.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'fw2.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] })
			]);
			assert.deepStrictEqual(labels, [
				'Firmware > Build (fw1.build)',
				'Firmware > Build (fw2.build)'
			]);
		});

		test('same actionId repeated with same path is NOT a path collision', () => {
			// Even though two entries share the same path, they share the
			// same actionId — that's just re-runs of one action. Step 2
			// requires distinct actionIds, so no suffix is added.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 2 }),
				entry({ actionId: 'fw.build', actionTitle: 'Build', actionPath: ['Firmware', 'Build'], timestamp: 1 }),
				entry({ actionId: 'bl.build', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, [
				'Firmware > Build',
				'Firmware > Build',
				'Bootloader > Build'
			]);
		});

		test('mixed: two share path, one has unique path → only the shared pair gets suffix', () => {
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'fw1', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'fw2', actionTitle: 'Build', actionPath: ['Firmware', 'Build'] }),
				entry({ actionId: 'bl', actionTitle: 'Build', actionPath: ['Bootloader', 'Build'] })
			]);
			assert.deepStrictEqual(labels, [
				'Firmware > Build (fw1)',
				'Firmware > Build (fw2)',
				'Bootloader > Build'
			]);
		});

		test('two root-level actions with same title → both get `Title (actionId)`', () => {
			// Pure root-level collision — neither has a usable breadcrumb,
			// so the id suffix is the only disambiguation available. The
			// distinct-id invariant must still hold.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'root.build.a', actionTitle: 'Build', actionPath: ['Build'] }),
				entry({ actionId: 'root.build.b', actionTitle: 'Build', actionPath: ['Build'] })
			]);
			assert.deepStrictEqual(labels, ['Build (root.build.a)', 'Build (root.build.b)']);
		});

		test('root-level repeated runs of same actionId stay bare even when title appears elsewhere', () => {
			// titleToActionIds size for 'Build' = 1 only because root.a
			// appears twice (same id). No collision detected → label
			// undefined → bare title. The unique 'Flash' row is unaffected.
			const labels = computeDisambiguatedHistoryLabels([
				entry({ actionId: 'root.a', actionTitle: 'Build', actionPath: ['Build'], timestamp: 2 }),
				entry({ actionId: 'root.a', actionTitle: 'Build', actionPath: ['Build'], timestamp: 1 }),
				entry({ actionId: 'flash', actionTitle: 'Flash', actionPath: ['Flash'] })
			]);
			assert.deepStrictEqual(labels, [undefined, undefined, undefined]);
		});
	});

	suite('insertActionIntoDestination', () => {
		test('should push new action to root when destination has no folderRef', () => {
			const workspaceActions: ActionItem[] = [];
			const destination = {
				label: 'Root',
				description: 'Add at root'
			} as any;
			const newAction: ActionItem = {
				id: 'new',
				title: 'New Action',
				action: { description: 'desc', tasks: [] }
			};

			insertActionIntoDestination(workspaceActions, destination, newAction);
			assert.strictEqual(workspaceActions.length, 1);
			assert.strictEqual(workspaceActions[0], newAction);
		});

		test('should create children array when inserting into folder', () => {
			const folder: ActionItem = {
				id: 'folder',
				title: 'Folder'
			};
			const workspaceActions: ActionItem[] = [folder];
			const destination = {
				label: 'Folder',
				description: 'Insert into folder',
				folderRef: folder
			} as any;
			const newAction: ActionItem = {
				id: 'nested',
				title: 'Nested',
				action: { description: 'nested desc', tasks: [] }
			};

			insertActionIntoDestination(workspaceActions, destination, newAction);
			assert.ok(folder.children);
			assert.strictEqual(folder.children?.length, 1);
			assert.strictEqual(folder.children?.[0], newAction);
		});
	});

	suite('buildDestinationPickItems (Create Action wizard)', () => {
		test('returns Root only when actions.json has no folders so the wizard can skip the prompt', () => {
			const items = buildDestinationPickItems([]);
			assert.strictEqual(items.length, 1, 'flat actions.json should yield a single Root item');
			assert.strictEqual(items[0].folderRef, undefined);
		});

		test('Root description matches the actual append-to-end behavior, not "top of file"', () => {
			// Regression guard for the v0.4.31 fix: previously the description
			// claimed "top of actions.json" but `insertActionIntoDestination`
			// pushes to the end. Description now describes the *level*.
			const items = buildDestinationPickItems([]);
			const root = items[0];
			assert.ok(root.description, 'Root item must have a description');
			assert.ok(
				!/최상단|top of/i.test(root.description!),
				`Root description should not claim "top of file" position; got: ${root.description}`
			);
		});

		test('lists each folder under Root with its full path label', () => {
			const folder: ActionItem = {
				id: 'tools',
				title: 'Tools',
				type: 'folder',
				children: [
					{ id: 'tools.nested', title: 'Nested', type: 'folder', children: [] }
				]
			};
			const items = buildDestinationPickItems([folder]);
			assert.strictEqual(items.length, 3, 'Root + Tools + Tools/Nested');
			assert.strictEqual(items[1].folderRef?.id, 'tools');
			assert.strictEqual(items[2].folderRef?.id, 'tools.nested');
			assert.ok(items[2].label.includes('Tools'), 'nested folder label should carry the parent path');
		});
	});

	suite('deriveLinkTitleFromUrl', () => {
		test('returns the host without leading "www."', () => {
			assert.strictEqual(deriveLinkTitleFromUrl('https://www.github.com/user/repo'), 'github.com');
			assert.strictEqual(deriveLinkTitleFromUrl('https://example.org/path?q=1'), 'example.org');
		});

		test('keeps non-www subdomains intact', () => {
			assert.strictEqual(deriveLinkTitleFromUrl('https://api.example.com/v1'), 'api.example.com');
		});

		test('falls back to the trimmed input when URL parsing fails', () => {
			// The save-time validateLinkUrlForSave (scheme allowlist +
			// WHATWG `new URL()` parse) blocks unparseable URLs from
			// being persisted — `validateLinkScheme` alone would let bare
			// `https://` through, which is exactly the v0.4.32 fix. The
			// title prompt still needs *some* non-empty default while the
			// user is mid-typing, so this fallback exists.
			assert.strictEqual(deriveLinkTitleFromUrl('not a url'), 'not a url');
			assert.strictEqual(deriveLinkTitleFromUrl('  https://valid.com  '), 'valid.com');
		});

		test('returns empty string for empty input so the prompt stays empty', () => {
			assert.strictEqual(deriveLinkTitleFromUrl(''), '');
			assert.strictEqual(deriveLinkTitleFromUrl('   '), '');
		});

		test('handles mailto and other allowed schemes', () => {
			// `new URL('mailto:foo@bar')` has empty host; we fall back to the
			// raw string so the user sees something meaningful.
			assert.strictEqual(deriveLinkTitleFromUrl('mailto:foo@bar.com'), 'mailto:foo@bar.com');
		});
	});

	suite('readLinksFromDisk / readFavoritesFromDisk (P1 data-loss guard)', () => {
		// These loaders distinguish "file missing or empty" from "parse
		// failure" so the add/delete/edit commands can refuse to overwrite
		// a corrupt JSON file with a synthetic 1-entry array. Without this
		// guard, the v0.4.31 actions.json fix would not extend to the
		// links/favorites side.
		let tempDir: string;

		setup(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-loader-'));
		});

		teardown(() => {
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		});

		test('readLinksFromDisk returns ok with empty entries when the file does not exist', () => {
			const result = readLinksFromDisk(path.join(tempDir, 'never-created.json'));
			assert.strictEqual(result.ok, true);
			if (result.ok) { assert.deepStrictEqual(result.entries, []); }
		});

		test('readLinksFromDisk returns ok:false on JSON syntax error so write commands can refuse to save', () => {
			const filePath = path.join(tempDir, 'broken.json');
			fs.writeFileSync(filePath, '{ not really json');
			const result = readLinksFromDisk(filePath);
			assert.strictEqual(result.ok, false);
			if (!result.ok) { assert.ok(result.error.length > 0, 'error message should not be empty'); }
		});

		test('readLinksFromDisk returns ok:false when the top-level value is not an array', () => {
			const filePath = path.join(tempDir, 'not-array.json');
			fs.writeFileSync(filePath, '{"title": "x", "link": "https://x"}');
			const result = readLinksFromDisk(filePath);
			assert.strictEqual(result.ok, false);
			if (!result.ok) { assert.match(result.error, /array/i); }
		});

		test('readLinksFromDisk returns parsed entries when the file is valid', () => {
			const filePath = path.join(tempDir, 'valid.json');
			fs.writeFileSync(filePath, JSON.stringify([
				{ title: 'GitHub', link: 'https://github.com', group: 'Dev', tags: ['vcs'] },
				{ title: 'Bad', link: 42 }   // schema-mismatch entries are silently skipped
			]));
			const result = readLinksFromDisk(filePath);
			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.entries.length, 1);
				assert.strictEqual(result.entries[0].title, 'GitHub');
				assert.strictEqual(result.entries[0].group, 'Dev');
			}
		});

		test('readFavoritesFromDisk returns ok:false on parse failure (mirrors links loader contract)', () => {
			const filePath = path.join(tempDir, 'broken-favs.json');
			fs.writeFileSync(filePath, '[ { "title": "ok", ');   // truncated
			const result = readFavoritesFromDisk(filePath);
			assert.strictEqual(result.ok, false);
		});

		test('readFavoritesFromDisk parses valid entries and applies workspaceFolder when supplied', () => {
			const filePath = path.join(tempDir, 'valid-favs.json');
			fs.writeFileSync(filePath, JSON.stringify([
				{ title: 'README', path: 'README.md', line: 5 }
			]));
			const result = readFavoritesFromDisk(filePath, '/some/workspace');
			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.entries.length, 1);
				assert.strictEqual(result.entries[0].path, 'README.md');
				assert.strictEqual(result.entries[0].line, 5);
				assert.strictEqual(result.entries[0].workspaceFolder, '/some/workspace');
				assert.strictEqual(result.entries[0].sourceFile, filePath);
			}
		});
	});

	suite('deriveActionIdFromTitle', () => {
		test('produces a kebab slug that matches the actions.json id pattern', () => {
			const idPattern = /^[A-Za-z0-9._-]+$/;
			const id = deriveActionIdFromTitle('Build Project', new Set());
			assert.strictEqual(id, 'build-project');
			assert.ok(idPattern.test(id));
		});

		test('falls back to "action" when the title has no alphanumerics', () => {
			assert.strictEqual(deriveActionIdFromTitle('   ', new Set()), 'action');
			assert.strictEqual(deriveActionIdFromTitle('!!!', new Set()), 'action');
		});

		test('appends -2, -3, ... when the slug already exists', () => {
			const existing = new Set(['build-project']);
			assert.strictEqual(deriveActionIdFromTitle('Build Project', existing), 'build-project-2');

			existing.add('build-project-2');
			assert.strictEqual(deriveActionIdFromTitle('Build Project', existing), 'build-project-3');
		});

		test('strips leading/trailing punctuation and collapses runs', () => {
			assert.strictEqual(deriveActionIdFromTitle('  -- Hello, World!! --  ', new Set()), 'hello-world');
		});

		test('0.6.25: 유니코드 문자를 보존한다', () => {
			// 이전에는 [^a-z0-9]로 잘라내 한글 제목이 전부 'action', 'action-2'가
			// 됐다. actions.json / Doctor 메시지 / dependsOn 어디서도 어떤
			// 액션인지 알 수 없는 id다.
			assert.strictEqual(deriveActionIdFromTitle('한글 빌드', new Set()), '한글-빌드');
			assert.strictEqual(deriveActionIdFromTitle('Café ☕', new Set()), 'café');
			assert.strictEqual(deriveActionIdFromTitle('펌웨어 v2 빌드', new Set()), '펌웨어-v2-빌드');
		});

		test('0.6.25: 유니코드 id도 유효한 커맨드 id로 인코딩된다', () => {
			// 스키마는 id에 패턴 제약이 없고 런타임 검증은 중복만 본다. 유일한
			// 하위 제약은 keybindings.json에 들어가는 커맨드 id인데,
			// buildActionCommandId가 non-ASCII 바이트를 percent-encoding 한다.
			const id = deriveActionIdFromTitle('한글 빌드', new Set());
			const commandId = buildActionCommandId(id);
			assert.ok(/^taskhub\.runAction\.[A-Za-z0-9._%-]+$/.test(commandId), commandId);
			assert.notStrictEqual(commandId, buildActionCommandId(deriveActionIdFromTitle('다른 빌드', new Set())),
				'서로 다른 id는 서로 다른 커맨드 id로 매핑돼야 한다');
		});

		test('문자·숫자가 전혀 없는 제목은 여전히 기본값으로 폴백한다', () => {
			assert.strictEqual(deriveActionIdFromTitle('!!!', new Set()), 'action');
			assert.strictEqual(deriveActionIdFromTitle('☕☕', new Set()), 'action');
		});
	});

	suite('validateActionIdInput (저장 전 확인의 ID 편집)', () => {
		test('빈 값과 공백만 있는 값은 거부한다', () => {
			assert.ok(validateActionIdInput('', new Set()));
			assert.ok(validateActionIdInput('   ', new Set()));
		});

		test('공백이 포함된 id는 거부한다', () => {
			// dependsOn 목록이나 로그 한 줄에 들어갔을 때 읽을 수 없다.
			assert.ok(validateActionIdInput('fw build', new Set()));
		});

		test('이미 쓰이는 id는 거부한다', () => {
			const message = validateActionIdInput('fw.build', new Set(['fw.build']));
			assert.ok(message && message.includes('fw.build'), message);
		});

		test('유니코드 id는 허용한다 (스키마에 패턴 제약이 없다)', () => {
			assert.strictEqual(validateActionIdInput('펌웨어-빌드', new Set()), undefined);
			assert.strictEqual(validateActionIdInput('fw.build-2', new Set(['fw.build'])), undefined);
		});

		test('앞뒤 공백은 잘라낸 뒤 판정한다', () => {
			assert.ok(validateActionIdInput('  fw.build  ', new Set(['fw.build'])), '트림 후 중복이면 거부');
			assert.strictEqual(validateActionIdInput('  fw.new  ', new Set(['fw.build'])), undefined);
		});
	});

	suite('createGroupedTaskPresentationOptions', () => {
		test('should default to reveal always and assign group', () => {
			const options = createGroupedTaskPresentationOptions('action-1');
			assert.strictEqual(options.group, 'action-1');
			assert.strictEqual(options.reveal, vscode.TaskRevealKind.Always);
			assert.strictEqual(options.panel, vscode.TaskPanelKind.Shared);
			assert.strictEqual(options.showReuseMessage, true);
		});

		test('should map silent reveal option', () => {
			const options = createGroupedTaskPresentationOptions('action-1', 'silent');
			assert.strictEqual(options.reveal, vscode.TaskRevealKind.Silent);
		});

		test('keeps action-wide group when isParallel is false (backward compat)', () => {
			const options = createGroupedTaskPresentationOptions(
				'action-1',
				'always',
				{ taskId: 'build', isParallel: false }
			);
			assert.strictEqual(options.group, 'action-1');
		});

		test('keeps action-wide group when taskId is missing even if isParallel', () => {
			const options = createGroupedTaskPresentationOptions(
				'action-1',
				'always',
				{ isParallel: true }
			);
			assert.strictEqual(options.group, 'action-1');
		});

		test('splits group to actionId:taskId when isParallel and taskId are both present', () => {
			const options = createGroupedTaskPresentationOptions(
				'action-1',
				'always',
				{ taskId: 'buildA', isParallel: true }
			);
			assert.strictEqual(options.group, 'action-1:buildA');
		});
	});

	suite('serializeFavorites - edge cases', () => {
		test('should handle entry with empty title', () => {
			const entries = [
				{ title: '', path: '/path/to/file' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: '', path: '/path/to/file' }
			]);
		});

		test('should handle entry with empty path', () => {
			const entries = [
				{ title: 'File', path: '' }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '' }
			]);
		});

		test('should handle entry with empty group', () => {
			const entries = [
				{ title: 'File', path: '/path', group: '' }
			];
			const result = serializeFavorites(entries);
			// Empty group should not be included
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '/path' }
			]);
		});

		test('should handle entry with empty tags array', () => {
			const entries = [
				{ title: 'File', path: '/path', tags: [] }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '/path' }
			]);
		});

		test('should ignore non-positive line numbers', () => {
			const entries = [
				{ title: 'File', path: '/path', line: 0 }
			];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, [
				{ title: 'File', path: '/path' }
			]);
		});

		test('should handle empty entries array', () => {
			const entries: any[] = [];
			const result = serializeFavorites(entries);
			assert.deepStrictEqual(result, []);
		});
	});

	suite('serializeLinks - edge cases', () => {
		test('should handle entry with empty title', () => {
			const entries = [
				{ title: '', link: 'https://example.com' }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: '', link: 'https://example.com' }
			]);
		});

		test('should handle entry with empty link', () => {
			const entries = [
				{ title: 'Link', link: '' }
			];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, [
				{ title: 'Link', link: '' }
			]);
		});

		test('should handle entry with empty group', () => {
			const entries = [
				{ title: 'Link', link: 'https://example.com', group: '' }
			];
			const result = serializeLinks(entries);
			// Empty group should not be included
			assert.deepStrictEqual(result, [
				{ title: 'Link', link: 'https://example.com' }
			]);
		});

		test('should handle empty entries array', () => {
			const entries: any[] = [];
			const result = serializeLinks(entries);
			assert.deepStrictEqual(result, []);
		});
	});

	suite('addLinkEntry', () => {
		test('should add a new unique link', () => {
			const existing = [
				{ title: 'Existing', link: 'https://existing.com' }
			];
			const { entries, added } = addLinkEntry(existing as any, { title: 'New', link: 'https://new.com' } as any);
			assert.strictEqual(added, true);
			assert.notStrictEqual(entries, existing);
			assert.strictEqual(entries.length, 2);
			assert.deepStrictEqual(entries[1], { title: 'New', link: 'https://new.com' });
		});

		test('should prevent duplicates by title and link', () => {
			const existing = [
				{ title: 'Link', link: 'https://example.com' }
			];
			const { entries, added } = addLinkEntry(existing as any, { title: 'Link', link: 'https://example.com', group: 'Docs' } as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries, existing);
			assert.strictEqual(entries.length, 1);
		});

		test('should trim title and link before adding', () => {
			const { entries, added } = addLinkEntry([], { title: '  Trim  ', link: '  https://trim.com  ', tags: ['tag'] } as any);
			assert.strictEqual(added, true);
			assert.deepStrictEqual(entries[0], { title: 'Trim', link: 'https://trim.com', tags: ['tag'] });
		});

		test('should remove only one matching link identity', () => {
			const entries = [
				{ title: 'Link', link: 'https://example.com' },
				{ title: 'Link', link: 'https://example.com' },
				{ title: 'Link', link: 'https://example.com', group: 'Docs' }
			];
			const result = removeLinkByIdentity(entries as any, entries[0] as any);
			assert.strictEqual(result.length, 2);
			assert.deepStrictEqual(result, [
				{ title: 'Link', link: 'https://example.com' },
				{ title: 'Link', link: 'https://example.com', group: 'Docs' }
			]);
		});
	});

	suite('addFavoriteEntry', () => {
		// Mirrors `removeFavoriteByIdentity` (path + line + title + group)
		// so a fresh Add followed by Delete on the same row stays
		// symmetric. Without this guard, multi-file Add would create N
		// copies and Delete would sweep all of them in one click.
		test('should add a new unique favorite', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'B',
				path: '${workspaceFolder}/b.ts'
			} as any);
			assert.strictEqual(added, true);
			assert.notStrictEqual(entries, existing);
			assert.strictEqual(entries.length, 2);
		});

		test('should detect duplicate when path + title match (no line)', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts'
			} as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries, existing);
			assert.strictEqual(entries.length, 1);
		});

		test('should detect duplicate when line numbers match', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts', line: 10 }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				line: 10
			} as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries.length, 1);
		});

		test('should treat different lines as different entries', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts', line: 10 }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				line: 20
			} as any);
			assert.strictEqual(added, true);
			assert.strictEqual(entries.length, 2);
		});

		test('should treat different groups as different entries', () => {
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts', group: 'Docs' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				group: 'Build'
			} as any);
			assert.strictEqual(added, true);
			assert.strictEqual(entries.length, 2);
		});

		test('should treat undefined and explicit-undefined group as the same', () => {
			// Identity matches `removeFavoriteByIdentity` which also folds
			// `group: undefined` and missing `group` together — keeps the
			// reverse pair (Add → Delete) symmetric.
			const existing = [
				{ title: 'A', path: '${workspaceFolder}/a.ts' }
			];
			const { entries, added } = addFavoriteEntry(existing as any, {
				title: 'A',
				path: '${workspaceFolder}/a.ts',
				group: undefined
			} as any);
			assert.strictEqual(added, false);
			assert.strictEqual(entries.length, 1);
		});
	});

	suite('confirmDeleteHistoryItem', () => {
		// Pin the *only-explicit-Yes-deletes* contract. Mirrors
		// `handleConfirm` style — monkey-patch `showWarningMessage` so the
		// helper can be exercised without an interactive runner.
		test('returns false when user cancels (modal dismissed)', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				assert.strictEqual(await confirmDeleteHistoryItem('Build'), false);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns true only when user clicks Yes', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'Yes';
			try {
				assert.strictEqual(await confirmDeleteHistoryItem('Build'), true);
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('shows modal warning with action title in the message', async () => {
			// If a future refactor drops the modal flag, the row would be
			// deleted on a non-modal toast click — guard the modal contract.
			const original = vscode.window.showWarningMessage;
			let captured: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				await confirmDeleteHistoryItem('My Action');
				const message = captured[0];
				const options = captured[1];
				assert.ok(typeof message === 'string' && message.includes('My Action'),
					'message should embed the action title');
				assert.strictEqual(options?.modal, true, 'must use modal warning');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});
	});

	suite('confirmApplyPresetBackup', () => {
		test('returns "cancel" when user dismisses', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				const result = await confirmApplyPresetBackup('/tmp/actions.json', 'parse error');
				assert.strictEqual(result, 'cancel');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "cancel" when user picks the cancel label', async () => {
			// The cancel button is the localized label, not undefined —
			// users who explicitly bail out should match the dismiss path.
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ..._labels: any[]) => {
				return _labels.find((l: string) => l.includes('취소') || l.includes('Cancel'));
			};
			try {
				const result = await confirmApplyPresetBackup('/tmp/actions.json', 'invalid');
				assert.strictEqual(result, 'cancel');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "backup" when user clicks the backup label', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ..._labels: any[]) => {
				return _labels.find((l: string) => l.includes('백업') || l.includes('Back up'));
			};
			try {
				const result = await confirmApplyPresetBackup('/tmp/actions.json', 'invalid');
				assert.strictEqual(result, 'backup');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('embeds .bak filename and reason in the prompt', async () => {
			// Pin that the modal tells the user (a) WHY the file is rejected
			// and (b) WHERE the backup will land — without these, the
			// confirm becomes a generic "are you sure?" the user can't
			// reason about.
			const original = vscode.window.showWarningMessage;
			let captured: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				await confirmApplyPresetBackup('/work/.vscode/actions.json', 'unexpected token');
				const message = captured[0];
				const options = captured[1];
				assert.ok(message.includes('actions.json.bak'), 'message should name the backup file');
				assert.ok(message.includes('unexpected token'), 'message should embed the reason');
				assert.strictEqual(options?.modal, true, 'must use modal warning');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});
	});

	suite('confirmSavePresetOverwrite', () => {
		test('returns "cancel" when user dismisses', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				const result = await confirmSavePresetOverwrite('/tmp/preset-foo.json');
				assert.strictEqual(result, 'cancel');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "overwrite" when user picks Overwrite', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ...labels: any[]) => {
				return labels.find((l: string) => l.includes('덮어쓰기') || l === 'Overwrite');
			};
			try {
				const result = await confirmSavePresetOverwrite('/tmp/preset-foo.json');
				assert.strictEqual(result, 'overwrite');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('returns "open-existing" when user picks Open existing file', async () => {
			const original = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async (_msg: any, _opts: any, ...labels: any[]) => {
				return labels.find((l: string) => l.includes('기존 파일 열기') || l === 'Open existing file');
			};
			try {
				const result = await confirmSavePresetOverwrite('/tmp/preset-foo.json');
				assert.strictEqual(result, 'open-existing');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});

		test('embeds the basename of targetPath in the prompt', async () => {
			// Pin that the user sees WHICH preset id collides — important
			// when they triggered the command from a different folder than
			// they expected.
			const original = vscode.window.showWarningMessage;
			let captured: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				captured = args;
				return undefined;
			};
			try {
				await confirmSavePresetOverwrite('/work/.vscode/presets/preset-integration.json');
				const message = captured[0];
				const options = captured[1];
				assert.ok(message.includes('preset-integration.json'),
					'message should embed basename of target path');
				assert.strictEqual(options?.modal, true, 'must use modal warning');
			} finally {
				(vscode.window as any).showWarningMessage = original;
			}
		});
	});

	suite('formatDuration', () => {
		// Pure formatter — pin the unit boundaries used by the action-card
		// badge. If a future refactor changes the breakpoints (e.g. switches
		// to "ms / s / min / hour" thresholds) these tests will tell us.
		test('sub-second values round to whole milliseconds', () => {
			assert.strictEqual(formatDuration(0), '0ms');
			assert.strictEqual(formatDuration(1), '1ms');
			assert.strictEqual(formatDuration(999), '999ms');
			assert.strictEqual(formatDuration(123.4), '123ms');
			assert.strictEqual(formatDuration(123.6), '124ms');
		});

		test('values from 1s up to 60s use "N.Ns" (truncated, never rounds up to 60.0s)', () => {
			assert.strictEqual(formatDuration(1000), '1.0s');
			assert.strictEqual(formatDuration(1234), '1.2s');
			// Truncation (not rounding) — 59999ms must not display as
			// "60.0s" because the next branch (≥60_000ms) renders that as "1m".
			assert.strictEqual(formatDuration(59999), '59.9s');
		});

		test('values from 1min up to 60min use "Nm" or "Nm Ms"', () => {
			assert.strictEqual(formatDuration(60_000), '1m');
			assert.strictEqual(formatDuration(75_000), '1m 15s');
			assert.strictEqual(formatDuration(3_599_000), '59m 59s');
		});

		test('values from 1h use "Hh" or "Hh Mm"', () => {
			assert.strictEqual(formatDuration(3_600_000), '1h');
			assert.strictEqual(formatDuration(3_900_000), '1h 5m');
			assert.strictEqual(formatDuration(7_200_000), '2h');
		});

		test('non-finite or negative inputs collapse to "0ms"', () => {
			assert.strictEqual(formatDuration(-5), '0ms');
			assert.strictEqual(formatDuration(NaN), '0ms');
			assert.strictEqual(formatDuration(Infinity), '0ms');
		});
	});

	suite('formatHistoryTimestamp', () => {
		// `now` is injected into the formatter so these tests are
		// deterministic regardless of when CI runs.
		const now = new Date(2026, 3, 30, 14, 30, 0).getTime(); // 2026-04-30 14:30

		test('same calendar day shows HH:mm only', () => {
			const ts = new Date(2026, 3, 30, 9, 5, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'ko'), '09:05');
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'en'), '09:05');
		});

		test('previous day uses locale-specific "yesterday" prefix', () => {
			const ts = new Date(2026, 3, 29, 18, 0, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'ko'), '어제 18:00');
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'en'), 'Yest 18:00');
		});

		test('older dates show MM/DD', () => {
			const ts = new Date(2026, 2, 15, 23, 59, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(ts, now, 'ko'), '03/15');
		});

		test('month/year boundary still resolves "yesterday" correctly', () => {
			const newYearNow = new Date(2026, 0, 1, 10, 0, 0).getTime();
			const newYearEve = new Date(2025, 11, 31, 23, 30, 0).getTime();
			assert.strictEqual(formatHistoryTimestamp(newYearEve, newYearNow, 'ko'), '어제 23:30');
		});
	});

	suite('formatLastRunBadge', () => {
		const now = new Date(2026, 3, 30, 14, 30, 0).getTime();

		function entry(partial: Partial<HistoryEntry>): HistoryEntry {
			return {
				actionId: 'a',
				actionTitle: 'A',
				timestamp: new Date(2026, 3, 30, 12, 0, 0).getTime(),
				status: 'success',
				...partial
			};
		}

		test('returns undefined when no entry is provided', () => {
			assert.strictEqual(formatLastRunBadge(undefined, now, 'ko'), undefined);
		});

		test('returns undefined for entries still running (icon shows spinner instead)', () => {
			assert.strictEqual(formatLastRunBadge(entry({ status: 'running' }), now, 'ko'), undefined);
		});

		test('success entry with duration → "HH:mm · duration" (status conveyed by icon)', () => {
			const e = entry({ status: 'success', durationMs: 1234 });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00 · 1.2s');
		});

		test('failure entry with duration → "HH:mm · duration" (status conveyed by icon)', () => {
			const e = entry({ status: 'failure', durationMs: 45 });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00 · 45ms');
		});

		test('entry without durationMs (legacy or partial) omits the duration suffix', () => {
			const e = entry({ status: 'success' });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00');
		});

		test('negative durationMs (clock-skew leak) renders as "0ms" rather than being dropped', () => {
			// `executeAction` clamps durationMs with Math.max(0, ...) at
			// write time, but the badge formatter is the safety net. If a
			// negative value reaches it (legacy entry, hypothetical buggy
			// writer), we'd rather show "ran instantly" than silently hide
			// the duration as the previous `>= 0` guard did.
			const e = entry({ status: 'success', durationMs: -5 });
			assert.strictEqual(formatLastRunBadge(e, now, 'ko'), '12:00 · 0ms');
		});

		test('entry from yesterday composes timestamp and duration', () => {
			const e = entry({
				status: 'failure',
				timestamp: new Date(2026, 3, 29, 9, 0, 0).getTime(),
				durationMs: 2500
			});
			assert.strictEqual(formatLastRunBadge(e, now, 'en'), 'Yest 09:00 · 2.5s');
		});

		test('badge never embeds the status glyph (covered by icon + aria label)', () => {
			// Regression guard for 0.5.1: the visible badge intentionally
			// omits ✓/✗ so the row doesn't carry the same signal twice
			// (icon already encodes status). Screen reader parity is
			// restored via `buildHistoryItemAriaLabel`; see that suite.
			for (const status of ['success', 'failure'] as const) {
				for (const durationMs of [undefined, 1234] as const) {
					const badge = formatLastRunBadge(
						entry({ status, durationMs }),
						now,
						'ko'
					);
					assert.ok(badge && !badge.includes('✓') && !badge.includes('✗'),
						`badge "${badge}" must not embed a status glyph`);
				}
			}
		});
	});

	suite('buildHistoryItemAriaLabel', () => {
		// Pins the screen-reader story for 0.5.1: the visible HistoryItem
		// row conveys status via `iconPath` color only (no ✓/✗ in
		// description), so the aria label has to fold the status word
		// back in as text. These tests keep that contract from regressing
		// silently if someone later tweaks the badge formatter.
		const now = new Date(2026, 3, 30, 14, 30, 0).getTime();

		function entry(partial: Partial<HistoryEntry>): HistoryEntry {
			return {
				actionId: 'a',
				actionTitle: 'Build',
				timestamp: new Date(2026, 3, 30, 12, 0, 0).getTime(),
				status: 'success',
				...partial
			};
		}

		test('success → "{label}, 성공, HH:mm · duration"', () => {
			const e = entry({ status: 'success', durationMs: 1234 });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Build', now, 'ko'),
				'Build, 성공, 12:00 · 1.2s'
			);
		});

		test('failure → "{label}, 실패, HH:mm · duration"', () => {
			const e = entry({ status: 'failure', durationMs: 45 });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Build', now, 'ko'),
				'Build, 실패, 12:00 · 45ms'
			);
		});

		test('running entry still gets a label (icon spinner alone is silent for screen readers)', () => {
			const e = entry({ status: 'running' });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Build', now, 'ko'),
				'Build, 실행 중, 12:00'
			);
		});

		test('English locale uses succeeded/failed/running words', () => {
			assert.strictEqual(
				buildHistoryItemAriaLabel(entry({ status: 'success', durationMs: 2500 }), 'Build', now, 'en'),
				'Build, succeeded, 12:00 · 2.5s'
			);
			assert.strictEqual(
				buildHistoryItemAriaLabel(entry({ status: 'failure' }), 'Build', now, 'en'),
				'Build, failed, 12:00'
			);
			assert.strictEqual(
				buildHistoryItemAriaLabel(entry({ status: 'running' }), 'Build', now, 'en'),
				'Build, running, 12:00'
			);
		});

		test('tool entries say "opened" rather than "succeeded"', () => {
			// Tool entries always carry status='success' because they
			// record an "opened" event, not a pass/fail run. A screen
			// reader announcing "succeeded" would be misleading there.
			const toolEntry = createToolHistoryEntry({
				kind: 'memoryMap',
				filePath: '/tmp/foo.elf',
				timestamp: new Date(2026, 3, 30, 12, 0, 0).getTime(),
			});
			assert.strictEqual(
				buildHistoryItemAriaLabel(toolEntry, 'Memory Map: foo.elf', now, 'ko'),
				'Memory Map: foo.elf, 열림 12:00'
			);
			assert.strictEqual(
				buildHistoryItemAriaLabel(toolEntry, 'Memory Map: foo.elf', now, 'en'),
				'Memory Map: foo.elf, opened 12:00'
			);
		});

		test('uses the supplied displayLabel (disambiguated breadcrumb), not entry.actionTitle', () => {
			// HistoryProvider passes the disambiguated label (e.g.
			// "Firmware > Build") into HistoryItem; aria label must
			// mirror that so the announced row matches the visible row.
			const e = entry({ status: 'success', actionTitle: 'Build', durationMs: 100 });
			assert.strictEqual(
				buildHistoryItemAriaLabel(e, 'Firmware > Build', now, 'ko'),
				'Firmware > Build, 성공, 12:00 · 100ms'
			);
		});
	});

	suite('startHistoryAutoRefresh', () => {
		// Pins the periodic-refresh wiring that keeps the History panel
		// badge fresh across midnight (TreeItem.description doesn't
		// auto-refresh, so without this hook a session left open would
		// keep showing yesterday's "23:30" forever).

		test('fires refresh() on every interval and stops cleanly on dispose', async () => {
			let count = 0;
			const fakeProvider = { refresh: () => { count++; } };
			const disposable = startHistoryAutoRefresh(fakeProvider, 30); // 30ms
			// Wait long enough for ~3 ticks to fire.
			await new Promise(r => setTimeout(r, 110));
			disposable.dispose();
			const afterDispose = count;
			// Anything ≥ 2 proves the timer fires repeatedly.
			assert.ok(afterDispose >= 2, `expected at least 2 refresh calls, got ${afterDispose}`);
			// Now wait again — count must NOT keep growing after dispose.
			await new Promise(r => setTimeout(r, 80));
			assert.strictEqual(count, afterDispose, 'dispose() must clear the interval');
		});
	});

	suite('shouldRecordTaskInput', () => {
		// Pins which task types contribute to history `inputs` for replay
		// (and which are deliberately excluded — `password: true` opts out).
		test('returns true for interactive task types', () => {
			const types = ['inputBox', 'quickPick', 'envPick', 'fileDialog', 'folderDialog', 'confirm'] as const;
			for (const type of types) {
				assert.strictEqual(
					shouldRecordTaskInput({ id: 't', type } as any),
					true,
					`expected ${type} to be recorded`
				);
			}
		});

		test('returns false for non-interactive task types', () => {
			const types = ['shell', 'command', 'unzip', 'zip', 'stringManipulation', 'writeFile', 'appendFile'] as const;
			for (const type of types) {
				assert.strictEqual(
					shouldRecordTaskInput({ id: 't', type } as any),
					false,
					`expected ${type} NOT to be recorded`
				);
			}
		});

		test('inputBox with password: true is excluded from recording', () => {
			assert.strictEqual(
				shouldRecordTaskInput({ id: 't', type: 'inputBox', password: true } as any),
				false
			);
			assert.strictEqual(
				shouldRecordTaskInput({ id: 't', type: 'inputBox', password: false } as any),
				true
			);
			assert.strictEqual(
				shouldRecordTaskInput({ id: 't', type: 'inputBox' } as any),
				true
			);
		});
	});

	suite('HistoryProvider', () => {
		// Mock ExtensionContext for testing
		class MockMemento implements vscode.Memento {
			private storage = new Map<string, any>();

			keys(): readonly string[] {
				return Array.from(this.storage.keys());
			}

			get<T>(key: string): T | undefined;
			get<T>(key: string, defaultValue: T): T;
			get<T>(key: string, defaultValue?: T): T | undefined {
				const value = this.storage.get(key);
				return value !== undefined ? value : defaultValue;
			}

			update(key: string, value: any): Thenable<void> {
				this.storage.set(key, value);
				return Promise.resolve();
			}

			setKeysForSync(keys: readonly string[]): void {
				// Not needed for testing
			}
		}

		class MockExtensionContext implements Partial<vscode.ExtensionContext> {
			workspaceState = new MockMemento();
			globalState = new MockMemento();
			subscriptions: { dispose(): any }[] = [];
			extensionPath = '/mock/extension/path';
			extensionUri = vscode.Uri.file('/mock/extension/path');
			globalStorageUri = vscode.Uri.file('/mock/global/storage');
			logUri = vscode.Uri.file('/mock/log');
			storageUri = vscode.Uri.file('/mock/storage');
		}

		function createMockContext(): vscode.ExtensionContext {
			return new MockExtensionContext() as unknown as vscode.ExtensionContext;
		}

		// These tests exercise the real HistoryProvider class (from
		// ../providers/historyProvider) with a MockMemento-backed
		// ExtensionContext, so addHistoryEntry / updateHistoryStatus /
		// deleteHistoryItem / clearAllHistory / trimHistoryToMax regressions
		// are actually caught here. An earlier revision of this file
		// simulated the lifecycle with local Maps/arrays, which meant those
		// tests only exercised JavaScript collection semantics.

		function makeEntry(
			actionId: string,
			status: HistoryEntry['status'] = 'success',
			timestamp: number = Date.now(),
			output?: string
		): HistoryEntry {
			const entry: HistoryEntry = {
				actionId,
				actionTitle: `Title for ${actionId}`,
				timestamp,
				status,
			};
			if (output !== undefined) {
				entry.output = output;
			}
			return entry;
		}

		function createHistoryProvider(maxItems?: number, context: vscode.ExtensionContext = createMockContext()): HistoryProvider {
			return new HistoryProvider(
				context,
				maxItems === undefined ? undefined : { getMaxItems: () => maxItems }
			);
		}

		test('addHistoryEntry unshifts entries so newest comes first', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('first', 'success', 1000));
			provider.addHistoryEntry(makeEntry('second', 'success', 2000));
			provider.addHistoryEntry(makeEntry('third', 'success', 3000));
			const history = provider.getHistory();
			assert.deepStrictEqual(
				history.map(e => e.actionId),
				['third', 'second', 'first']
			);
		});

		test('addHistoryEntry persists through workspaceState so getHistory round-trips', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			p1.addHistoryEntry(makeEntry('persist', 'success', 42));
			// A second provider bound to the same context should see the entry.
			const p2 = new HistoryProvider(ctx);
			const history = p2.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].actionId, 'persist');
			assert.strictEqual(history[0].timestamp, 42);
		});

		test('addHistoryEntry trims the oldest entries once maxItems is exceeded', async () => {
			const provider = createHistoryProvider(3);
			for (let i = 0; i < 5; i++) {
				provider.addHistoryEntry(makeEntry(`a${i}`, 'success', 1000 + i));
			}
			const history = provider.getHistory();
			// After the 5th add, newest-first ordering keeps only a4/a3/a2.
			assert.deepStrictEqual(
				history.map(e => e.actionId),
				['a4', 'a3', 'a2']
			);
		});

		test('updateHistoryStatus mutates an entry matched by (actionId, timestamp)', () => {
			const provider = new HistoryProvider(createMockContext());
			const timestamp = 123;
			provider.addHistoryEntry(makeEntry('target', 'running', timestamp));
			provider.addHistoryEntry(makeEntry('target', 'running', timestamp + 10));

			provider.updateHistoryStatus('target', timestamp, 'failure', 'boom');

			const history = provider.getHistory();
			const updated = history.find(e => e.timestamp === timestamp);
			const untouched = history.find(e => e.timestamp === timestamp + 10);
			assert.ok(updated);
			assert.ok(untouched);
			assert.strictEqual(updated!.status, 'failure');
			assert.strictEqual(updated!.output, 'boom');
			assert.strictEqual(untouched!.status, 'running');
			assert.strictEqual(untouched!.output, undefined);
		});

		test('updateHistoryStatus on an unknown (actionId, timestamp) is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('only', 'success', 1));
			provider.updateHistoryStatus('missing', 999, 'failure', 'should-not-write');
			const history = provider.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].actionId, 'only');
			assert.strictEqual(history[0].status, 'success');
			assert.strictEqual(history[0].output, undefined);
		});

		test('updateHistoryStatus persists durationMs on terminal transition and round-trips', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			const ts = 100;
			p1.addHistoryEntry(makeEntry('timed', 'running', ts));
			p1.updateHistoryStatus('timed', ts, 'success', undefined, 1234);
			// In-memory check.
			assert.strictEqual(p1.getHistory()[0].durationMs, 1234);
			// And it survives a fresh provider on the same workspaceState.
			const p2 = new HistoryProvider(ctx);
			assert.strictEqual(p2.getHistory()[0].durationMs, 1234);
		});

		test('updateHistoryStatus without durationMs leaves an existing duration alone', () => {
			const provider = new HistoryProvider(createMockContext());
			const ts = 200;
			provider.addHistoryEntry(makeEntry('preserve', 'running', ts));
			provider.updateHistoryStatus('preserve', ts, 'success', undefined, 500);
			// Subsequent update without durationMs (e.g., a status fixup) must
			// not erase the previously recorded duration.
			provider.updateHistoryStatus('preserve', ts, 'failure', 'late error');
			const entry = provider.getHistory()[0];
			assert.strictEqual(entry.durationMs, 500);
			assert.strictEqual(entry.status, 'failure');
			assert.strictEqual(entry.output, 'late error');
		});

		test('updateHistoryStatus preserves existing output when called without an output arg', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'running', 1, 'preexisting-output'));
			provider.updateHistoryStatus('a', 1, 'success');
			const entry = provider.getHistory()[0];
			assert.strictEqual(entry.status, 'success');
			assert.strictEqual(entry.output, 'preexisting-output');
		});

		test('manual-stop flow: running → failure with "Action stopped by user" message', () => {
			// The stop-action command in extension.ts routes through
			// updateHistoryStatus(actionId, timestamp, 'failure', 'Action stopped by user').
			// This test pins that contract against the real class.
			const provider = new HistoryProvider(createMockContext());
			const ts = 555;
			provider.addHistoryEntry(makeEntry('build', 'running', ts));
			provider.updateHistoryStatus('build', ts, 'failure', 'Action stopped by user');
			const entry = provider.getHistory()[0];
			assert.strictEqual(entry.status, 'failure');
			assert.strictEqual(entry.output, 'Action stopped by user');
		});

		test('setHistoryInputs attaches an inputs map to a matched (actionId, timestamp) entry', () => {
			const provider = new HistoryProvider(createMockContext());
			const ts = 7777;
			provider.addHistoryEntry(makeEntry('with-inputs', 'success', ts));
			provider.setHistoryInputs('with-inputs', ts, {
				pickEnv: { value: 'prod' },
				askName: { value: 'release' }
			});
			const entry = provider.getHistory()[0];
			assert.deepStrictEqual(entry.inputs, {
				pickEnv: { value: 'prod' },
				askName: { value: 'release' }
			});
			// Other fields untouched.
			assert.strictEqual(entry.actionId, 'with-inputs');
			assert.strictEqual(entry.status, 'success');
		});

		test('setHistoryInputs with an empty object clears the field rather than persisting noise', () => {
			const provider = new HistoryProvider(createMockContext());
			const ts = 10;
			provider.addHistoryEntry(makeEntry('empty', 'success', ts));
			// First seed inputs so we can prove the second call clears them.
			provider.setHistoryInputs('empty', ts, { pick: { value: 'a' } });
			assert.ok(provider.getHistory()[0].inputs);
			provider.setHistoryInputs('empty', ts, {});
			assert.strictEqual(provider.getHistory()[0].inputs, undefined);
		});

		test('setHistoryInputs on an unknown (actionId, timestamp) is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('only', 'success', 1));
			provider.setHistoryInputs('missing', 999, { pick: { value: 'x' } });
			const history = provider.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].inputs, undefined);
		});

		test('inputs field round-trips through workspaceState across HistoryProvider instances', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			const ts = 42;
			p1.addHistoryEntry(makeEntry('persist-inputs', 'success', ts));
			p1.setHistoryInputs('persist-inputs', ts, {
				file: { path: '/abs/x.bin', name: 'x.bin' },
				flag: { value: '--release' }
			});
			const p2 = new HistoryProvider(ctx);
			const entry = p2.getHistory()[0];
			assert.deepStrictEqual(entry.inputs, {
				file: { path: '/abs/x.bin', name: 'x.bin' },
				flag: { value: '--release' }
			});
		});

		test('HistoryItem contextValue distinguishes inputs / output / both / neither', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('plain', 'success', 1));
			provider.addHistoryEntry(makeEntry('out-only', 'failure', 2, 'boom'));
			provider.addHistoryEntry(makeEntry('in-only', 'success', 3));
			provider.setHistoryInputs('in-only', 3, { pick: { value: 'p' } });
			provider.addHistoryEntry(makeEntry('both', 'failure', 4, 'broke'));
			provider.setHistoryInputs('both', 4, { pick: { value: 'p' } });

			const items = await provider.getChildren();
			// Newest-first ordering: both / in-only / out-only / plain.
			const byActionId = new Map(items.map(i => [i.getEntry().actionId, i]));
			assert.strictEqual(byActionId.get('plain')?.contextValue, 'historyItem');
			assert.strictEqual(byActionId.get('out-only')?.contextValue, 'historyItem.output');
			assert.strictEqual(byActionId.get('in-only')?.contextValue, 'historyItem.inputs');
			assert.strictEqual(byActionId.get('both')?.contextValue, 'historyItem.inputs.output');
		});

		test('setHistoryCommands adds the .commands flag to contextValue and clears it when empty', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('cmd', 'success', 1));
			provider.setHistoryCommands('cmd', 1, { build: 'gcc -o app main.c' });

			let items = await provider.getChildren();
			assert.strictEqual(items[0].contextValue, 'historyItem.commands');
			assert.deepStrictEqual(items[0].getEntry().commands, { build: 'gcc -o app main.c' });

			// Empty map clears the field so the affordance disappears.
			provider.setHistoryCommands('cmd', 1, {});
			items = await provider.getChildren();
			assert.strictEqual(items[0].contextValue, 'historyItem');
			assert.strictEqual(items[0].getEntry().commands, undefined);
		});

		test('inputs + output + commands compose into a single dotted contextValue', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('all', 'success', 1, 'log output'));
			provider.setHistoryInputs('all', 1, { pick: { value: 'p' } });
			provider.setHistoryCommands('all', 1, { run: 'echo hi' });

			const items = await provider.getChildren();
			assert.strictEqual(items[0].contextValue, 'historyItem.inputs.output.commands');
		});

		test('contextValue: inputs+commands (no output) and output+commands (no inputs) compose correctly', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('in-cmd', 'success', 1));
			provider.setHistoryInputs('in-cmd', 1, { pick: { value: 'p' } });
			provider.setHistoryCommands('in-cmd', 1, { run: 'echo a' });

			provider.addHistoryEntry(makeEntry('out-cmd', 'failure', 2, 'boom'));
			provider.setHistoryCommands('out-cmd', 2, { run: 'echo b' });

			const byId = new Map((await provider.getChildren()).map(i => [i.getEntry().actionId, i]));
			assert.strictEqual(byId.get('in-cmd')?.contextValue, 'historyItem.inputs.commands');
			assert.strictEqual(byId.get('out-cmd')?.contextValue, 'historyItem.output.commands');
		});

		test('setHistoryCommands on an unknown (actionId, timestamp) is a silent no-op', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('present', 'success', 1));
			// Neither a wrong id nor a wrong timestamp should mutate anything.
			provider.setHistoryCommands('absent', 1, { run: 'echo x' });
			provider.setHistoryCommands('present', 999, { run: 'echo x' });
			const history = provider.getHistory();
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].commands, undefined);
		});

		test('setHistoryCommands targets the entry matched by (actionId, timestamp), not just actionId', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('rerun', 'success', 100));
			provider.addHistoryEntry(makeEntry('rerun', 'success', 200));
			provider.setHistoryCommands('rerun', 100, { run: 'old' });

			const history = provider.getHistory();
			const older = history.find(e => e.timestamp === 100);
			const newer = history.find(e => e.timestamp === 200);
			assert.deepStrictEqual(older?.commands, { run: 'old' });
			assert.strictEqual(newer?.commands, undefined);
		});

		test('setHistoryCommands overwrites previously recorded commands', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('over', 'success', 1));
			provider.setHistoryCommands('over', 1, { a: 'first' });
			provider.setHistoryCommands('over', 1, { b: 'second' });
			assert.deepStrictEqual(provider.getHistory()[0].commands, { b: 'second' });
		});

		test('commands field round-trips through workspaceState across HistoryProvider instances', () => {
			const ctx = createMockContext();
			const p1 = new HistoryProvider(ctx);
			const ts = 77;
			p1.addHistoryEntry(makeEntry('persist-commands', 'success', ts));
			p1.setHistoryCommands('persist-commands', ts, {
				build: 'gcc -O2 -o app main.c',
				run: 'app --verbose'
			});
			const p2 = new HistoryProvider(ctx);
			assert.deepStrictEqual(p2.getHistory()[0].commands, {
				build: 'gcc -O2 -o app main.c',
				run: 'app --verbose'
			});
		});

		suite('formatExecutedCommandsDocument', () => {
			function entryWithCommands(commands?: Record<string, string>): HistoryEntry {
				const e = makeEntry('fmt', 'success', 1700000000000);
				if (commands) { e.commands = commands; }
				return e;
			}

			test('returns null when the entry has no commands field', () => {
				assert.strictEqual(formatExecutedCommandsDocument(entryWithCommands()), null);
			});

			test('returns null when commands is an empty object', () => {
				assert.strictEqual(formatExecutedCommandsDocument(entryWithCommands({})), null);
			});

			test('single command: header carries the action title and the [taskId] section holds the command', () => {
				const content = formatExecutedCommandsDocument(entryWithCommands({ build: 'gcc -o app main.c' }))!;
				assert.ok(content !== null);
				// Header is locale-dependent (t(ko, en)); the action title is in
				// both variants, so assert on that rather than the keyword.
				assert.ok(content.includes('Title for fmt'), `header should contain the action title, got:\n${content}`);
				assert.ok(content.includes('[build]\ngcc -o app main.c'), `body should hold the [taskId] section, got:\n${content}`);
			});

			test('multiple commands: one section per task, in insertion order, blank-line separated', () => {
				const content = formatExecutedCommandsDocument(entryWithCommands({
					build: 'gcc -o app main.c',
					deploy: 'scp app server:/opt'
				}))!;
				assert.ok(content.includes('[build]\ngcc -o app main.c'));
				assert.ok(content.includes('[deploy]\nscp app server:/opt'));
				assert.ok(
					content.indexOf('[build]') < content.indexOf('[deploy]'),
					'sections must preserve insertion order'
				);
				assert.ok(
					content.includes('main.c\n\n[deploy]'),
					'sections must be separated by a blank line'
				);
			});
		});

		test('rerun flow: re-adding with a new timestamp yields two distinct entries', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('rerun', 'success', 100));
			provider.addHistoryEntry(makeEntry('rerun', 'success', 200));
			const history = provider.getHistory();
			assert.strictEqual(history.length, 2);
			assert.strictEqual(history[0].timestamp, 200);
			assert.strictEqual(history[1].timestamp, 100);
		});

		test('deleteHistoryItem removes only the matching (actionId, timestamp) entry', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'success', 1));
			provider.addHistoryEntry(makeEntry('a', 'success', 2));
			provider.addHistoryEntry(makeEntry('b', 'success', 3));
			provider.deleteHistoryItem(makeEntry('a', 'success', 1));
			const history = provider.getHistory();
			assert.deepStrictEqual(
				history.map(e => `${e.actionId}:${e.timestamp}`).sort(),
				['a:2', 'b:3']
			);
		});

		test('deleteHistoryItem with no matching entry leaves history untouched', () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('a', 'success', 1));
			provider.deleteHistoryItem(makeEntry('a', 'success', 999));
			assert.strictEqual(provider.getHistory().length, 1);
		});

		test('clearAllHistory empties the persisted store', () => {
			const ctx = createMockContext();
			const provider = new HistoryProvider(ctx);
			provider.addHistoryEntry(makeEntry('a'));
			provider.addHistoryEntry(makeEntry('b'));
			provider.clearAllHistory();
			assert.deepStrictEqual(provider.getHistory(), []);
			// A second provider on the same context must see the cleared state too.
			assert.deepStrictEqual(new HistoryProvider(ctx).getHistory(), []);
		});

		test('trimHistoryToMax shrinks over-length history to the current maxItems setting', async () => {
			const ctx = createMockContext();
			const seedProvider = createHistoryProvider(50, ctx);
			for (let i = 0; i < 8; i++) {
				seedProvider.addHistoryEntry(makeEntry(`x${i}`, 'success', 1000 + i));
			}
			// Lower maxItems, then trim. We expect only the first 4 newest
			// entries to remain (history is ordered newest-first).
			const trimProvider = createHistoryProvider(4, ctx);
			trimProvider.trimHistoryToMax();
			const history = trimProvider.getHistory();
			assert.strictEqual(history.length, 4);
			assert.deepStrictEqual(
				history.map(e => e.actionId),
				['x7', 'x6', 'x5', 'x4']
			);
		});

		test('trimHistoryToMax is a no-op when history.length <= maxItems', async () => {
			const ctx = createMockContext();
			const provider = createHistoryProvider(10, ctx);
			provider.addHistoryEntry(makeEntry('a', 'success', 1));
			provider.addHistoryEntry(makeEntry('b', 'success', 2));
			provider.trimHistoryToMax();
			assert.strictEqual(provider.getHistory().length, 2);
		});

		test('createToolHistoryEntry stores Memory Map metadata in the shared history shape', () => {
			const entry = createToolHistoryEntry({
				kind: 'memoryMap',
				filePath: '/workspace/build/app.axf',
				timestamp: 1234,
				memoryMapInputType: 'elf',
				memoryMapConfig: {
					regions: [{ name: 'FLASH', origin: 0x08000000, size: 1024 }]
				}
			});
			assert.strictEqual(entry.entryType, 'tool');
			assert.strictEqual(entry.actionTitle, 'Memory Map: app.axf');
			assert.strictEqual(entry.status, 'success');
			assert.ok(isToolHistoryEntry(entry));
			assert.strictEqual(entry.tool.filePath, '/workspace/build/app.axf');
			assert.strictEqual(entry.tool.memoryMapInputType, 'elf');
			assert.deepStrictEqual(entry.tool.memoryMapConfig?.regions, [
				{ name: 'FLASH', origin: 0x08000000, size: 1024 }
			]);
		});

		test('tool history rows open the tool instead of rerunning an action', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(createToolHistoryEntry({
				kind: 'hexEditor',
				filePath: '/workspace/image.hex',
				timestamp: 55
			}));

			const items = await provider.getChildren();
			assert.strictEqual(items.length, 1);
			const item = items[0];
			assert.strictEqual(item.label, 'Hex Editor: image.hex');
			assert.strictEqual(item.contextValue, 'historyItem');
			assert.strictEqual(item.command?.command, 'taskhub.openToolFromHistory');
			assert.ok(isToolHistoryEntry(item.getEntry()));
		});

		test('createToolHistoryEntry builds a JSON Editor tool entry that opens via openToolFromHistory', async () => {
			const provider = new HistoryProvider(createMockContext());
			const entry = createToolHistoryEntry({
				kind: 'jsonEditor',
				filePath: '/workspace/config/settings.json',
				timestamp: 99
			});
			assert.strictEqual(entry.entryType, 'tool');
			assert.strictEqual(entry.actionTitle, 'JSON Editor: settings.json');
			assert.strictEqual(entry.status, 'success');
			assert.ok(isToolHistoryEntry(entry));
			assert.strictEqual(entry.tool.kind, 'jsonEditor');
			assert.strictEqual(entry.tool.filePath, '/workspace/config/settings.json');
			assert.strictEqual(entry.tool.memoryMapInputType, undefined);

			provider.addHistoryEntry(entry);
			const items = await provider.getChildren();
			assert.strictEqual(items.length, 1);
			assert.strictEqual(items[0].label, 'JSON Editor: settings.json');
			assert.strictEqual(items[0].command?.command, 'taskhub.openToolFromHistory');
		});

		test('getChildren returns one HistoryItem per entry, carrying the rerun command', async () => {
			const provider = new HistoryProvider(createMockContext());
			provider.addHistoryEntry(makeEntry('run-me', 'success', 1));
			const items = await provider.getChildren();
			assert.strictEqual(items.length, 1);
			const item = items[0];
			// TreeItem label comes from actionTitle in the entry.
			assert.strictEqual(item.label, 'Title for run-me');
			assert.strictEqual(item.command?.command, 'taskhub.rerunFromHistory');
			assert.strictEqual(item.getEntry().actionId, 'run-me');
		});
	});

	suite('InputBox Task', () => {
		test('should apply prefix to user input', () => {
			const userInput = 'Test 1234 123';
			const prefix = '-g ';
			const expected = '-g Test 1234 123';
			const result = prefix + userInput;
			assert.strictEqual(result, expected);
		});

		test('should apply suffix to user input', () => {
			const userInput = 'Test 1234 123';
			const suffix = ' --verbose';
			const expected = 'Test 1234 123 --verbose';
			const result = userInput + suffix;
			assert.strictEqual(result, expected);
		});

		test('should apply both prefix and suffix', () => {
			const userInput = 'Test 1234 123';
			const prefix = '-g ';
			const suffix = ' --verbose';
			const expected = '-g Test 1234 123 --verbose';
			const result = prefix + userInput + suffix;
			assert.strictEqual(result, expected);
		});

		test('should return user input when no prefix/suffix', () => {
			const userInput = 'Test 1234 123';
			const result = userInput;
			assert.strictEqual(result, userInput);
		});

		test('should handle empty user input with prefix/suffix', () => {
			const userInput = '';
			const prefix = '-g ';
			const suffix = ' --verbose';
			const expected = '-g  --verbose';
			const result = prefix + userInput + suffix;
			assert.strictEqual(result, expected);
		});

		test('should interpolate prefix in template', () => {
			const prefix = '-g ';
			const userInput = 'Test';
			const template = '${input.value}';
			const context = { input: { value: prefix + userInput } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, '-g Test');
		});
	});

	suite('QuickPick Task', () => {
		test('should handle single selection', () => {
			const items = ['dev', 'staging', 'production'];
			const selected = 'staging';
			assert.ok(items.includes(selected));
		});

		test('should handle multiple selection', () => {
			const items = ['feature1', 'feature2', 'feature3'];
			const selected = ['feature1', 'feature3'];
			selected.forEach(item => {
				assert.ok(items.includes(item));
			});
		});

		test('should handle quick pick item with description', () => {
			const item = {
				label: 'production',
				description: 'Production environment',
				detail: 'Use this for production deployment'
			};
			assert.strictEqual(item.label, 'production');
			assert.strictEqual(item.description, 'Production environment');
		});

		test('should interpolate selected value in template', () => {
			const template = 'Running in ${env.value} environment';
			const context = { env: { value: 'production' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Running in production environment');
		});

		test('should handle multiple selections in template', () => {
			const template = 'Selected: ${features.values}';
			const context = { features: { values: 'feature1,feature2' } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Selected: feature1,feature2');
		});
	});

	suite('getCommandString', () => {
		test('should return string command as-is', () => {
			const command = 'echo Hello';
			const result = getCommandString(command);
			assert.strictEqual(result, 'echo Hello');
		});

		test('should select windows command on win32 platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });
				const command = {
					windows: 'dir',
					macos: 'ls',
					linux: 'ls'
				};
				const result = getCommandString(command);
				assert.strictEqual(result, 'dir');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should select macos command on darwin platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const command = {
					windows: 'dir',
					macos: 'ls -la',
					linux: 'ls'
				};
				const result = getCommandString(command);
				assert.strictEqual(result, 'ls -la');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should select linux command on linux platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'linux' });
				const command = {
					windows: 'dir',
					macos: 'ls',
					linux: 'ls -al'
				};
				const result = getCommandString(command);
				assert.strictEqual(result, 'ls -al');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should throw error for unsupported platform', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const command = {
					windows: 'dir',
					linux: 'ls'
				};
				assert.throws(() => getCommandString(command), /Invalid or unsupported 'command'/);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should throw error for invalid command type', () => {
			assert.throws(() => getCommandString(null), /Invalid or unsupported 'command'/);
			assert.throws(() => getCommandString(123), /Invalid or unsupported 'command'/);
		});
	});

	suite('getToolCommand', () => {
		test('should return string tool path as-is', () => {
			const tool = '/usr/bin/7z';
			const result = getToolCommand(tool);
			assert.strictEqual(result, '/usr/bin/7z');
		});

		test('should quote tool path with spaces', () => {
			const tool = 'C:\\Program Files\\7-Zip\\7z.exe';
			const result = getToolCommand(tool);
			assert.strictEqual(result, '"C:\\Program Files\\7-Zip\\7z.exe"');
		});

		test('should not double-quote already quoted path', () => {
			const tool = '"C:\\Program Files\\7-Zip\\7z.exe"';
			const result = getToolCommand(tool);
			assert.strictEqual(result, '"C:\\Program Files\\7-Zip\\7z.exe"');
		});

		test('should select platform-specific tool path', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const tool = {
					windows: 'C:\\Program Files\\7-Zip\\7z.exe',
					macos: '/opt/homebrew/bin/7z',
					linux: '/usr/bin/7z'
				};
				const result = getToolCommand(tool);
				assert.strictEqual(result, '/opt/homebrew/bin/7z');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should throw error when platform-specific tool not found', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				const tool = {
					windows: 'C:\\Program Files\\7-Zip\\7z.exe',
					linux: '/usr/bin/7z'
				};
				assert.throws(() => getToolCommand(tool), /No tool path specified for the current platform/);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});

	suite('buildPowerShellInvocation', () => {
		test('should build basic PowerShell invocation', () => {
			const result = buildPowerShellInvocation('echo', ['Hello'], false);
			assert.strictEqual(result.display, "& 'echo' 'Hello'");
			assert.ok(result.script.includes("& 'echo' 'Hello'"));
		});

		test('should escape single quotes in arguments', () => {
			const result = buildPowerShellInvocation('echo', ["It's working"], false);
			assert.strictEqual(result.display, "& 'echo' 'It''s working'");
		});

		test('should handle UTF-8 console enforcement', () => {
			const result = buildPowerShellInvocation('python', ['script.py'], true);
			assert.ok(result.script.includes('[Console]::OutputEncoding'));
			assert.ok(result.script.includes('UTF8'));
		});

		test('should handle command with existing args', () => {
			const result = buildPowerShellInvocation('git status', ['-v'], false);
			assert.strictEqual(result.display, "& 'git' 'status' '-v'");
		});

		test('should handle empty args array', () => {
			const result = buildPowerShellInvocation('pwd', [], false);
			assert.strictEqual(result.display, "& 'pwd'");
		});
	});

	suite('buildPosixCommandLine', () => {
		test('should build basic POSIX command line', () => {
			const result = buildPosixCommandLine('echo', ['Hello']);
			assert.strictEqual(result, "echo 'Hello'");
		});

		test('should escape single quotes in arguments', () => {
			const result = buildPosixCommandLine('echo', ["It's working"]);
			assert.strictEqual(result, "echo 'It'\\''s working'");
		});

		test('should quote executable with special characters', () => {
			const result = buildPosixCommandLine('my@cmd', ['arg']);
			assert.strictEqual(result, "'my@cmd' 'arg'");
		});

		test('should not quote simple executable paths', () => {
			const result = buildPosixCommandLine('/usr/bin/echo', ['test']);
			assert.strictEqual(result, "/usr/bin/echo 'test'");
		});

		test('should handle command with existing args', () => {
			const result = buildPosixCommandLine('git status', ['-v']);
			assert.strictEqual(result, "git 'status' '-v'");
		});

		test('should handle multiple arguments', () => {
			const result = buildPosixCommandLine('node', ['script.js', '--port', '3000']);
			assert.strictEqual(result, "node 'script.js' '--port' '3000'");
		});
	});

	suite('encodePowerShellScript', () => {
		test('should encode PowerShell script to base64', () => {
			const script = 'Write-Host "Hello"';
			const result = encodePowerShellScript(script);
			assert.ok(typeof result === 'string');
			assert.ok(result.length > 0);
			// Decode and verify
			const decoded = Buffer.from(result, 'base64').toString('utf16le');
			assert.strictEqual(decoded, script);
		});

		test('should handle empty script', () => {
			const script = '';
			const result = encodePowerShellScript(script);
			assert.ok(typeof result === 'string');
		});

		test('should handle script with special characters', () => {
			const script = "Write-Host 'It''s working' -ForegroundColor Green";
			const result = encodePowerShellScript(script);
			const decoded = Buffer.from(result, 'base64').toString('utf16le');
			assert.strictEqual(decoded, script);
		});
	});

	suite('normalizeLineNumber', () => {
		test('should accept valid positive number', () => {
			assert.strictEqual(normalizeLineNumber(10), 10);
			assert.strictEqual(normalizeLineNumber(1), 1);
			assert.strictEqual(normalizeLineNumber(999), 999);
		});

		test('should floor decimal numbers', () => {
			assert.strictEqual(normalizeLineNumber(10.7), 10);
			assert.strictEqual(normalizeLineNumber(1.2), 1);
		});

		test('should reject zero and negative numbers', () => {
			assert.strictEqual(normalizeLineNumber(0), undefined);
			assert.strictEqual(normalizeLineNumber(-1), undefined);
			assert.strictEqual(normalizeLineNumber(-10), undefined);
		});

		test('should parse valid string numbers', () => {
			assert.strictEqual(normalizeLineNumber('10'), 10);
			assert.strictEqual(normalizeLineNumber('1'), 1);
			assert.strictEqual(normalizeLineNumber('999'), 999);
		});

		test('should reject invalid string inputs', () => {
			assert.strictEqual(normalizeLineNumber('abc'), undefined);
			assert.strictEqual(normalizeLineNumber('0'), undefined);
			assert.strictEqual(normalizeLineNumber('-5'), undefined);
			assert.strictEqual(normalizeLineNumber(''), undefined);
		});

		test('should reject non-finite numbers', () => {
			assert.strictEqual(normalizeLineNumber(Infinity), undefined);
			assert.strictEqual(normalizeLineNumber(-Infinity), undefined);
			assert.strictEqual(normalizeLineNumber(NaN), undefined);
		});

		test('should reject null and undefined', () => {
			assert.strictEqual(normalizeLineNumber(null), undefined);
			assert.strictEqual(normalizeLineNumber(undefined), undefined);
		});

		test('should reject other types', () => {
			assert.strictEqual(normalizeLineNumber({}), undefined);
			assert.strictEqual(normalizeLineNumber([]), undefined);
			assert.strictEqual(normalizeLineNumber(true), undefined);
		});
	});

	suite('wrapCommandForOneShot', () => {
		test('should wrap a directly-launchable Windows command with ProcessStartInfo and UTF-8', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('notepad.exe', ['file.txt'], undefined, true);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(result.commandLine.includes('System.Diagnostics.ProcessStartInfo'));
				assert.ok(result.commandLine.includes("$psi.FileName = 'notepad.exe'"));
				assert.ok(result.commandLine.includes("$psi.Arguments = 'file.txt'"));
				assert.ok(result.commandLine.includes('[Console]::OutputEncoding'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should wrap a directly-launchable Windows command without UTF-8 and with cwd', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('notepad.exe', [], 'C:\\cwd', false);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(!result.commandLine.includes('[Console]::OutputEncoding'));
				assert.ok(result.commandLine.includes("$psi.WorkingDirectory = 'C:\\cwd'"));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should preserve embedded double quotes for directly-launchable Windows one-shot args', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('node.exe', ['-e', 'process.stdout.write("ok")'], undefined, false);

				assert.ok(result.commandLine.includes('$psi.Arguments ='));
				assert.ok(result.commandLine.includes('process.stdout.write(\\"ok\\")'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should use Start-Process for a Windows shim/script one-shot command (PATHEXT/association resolution)', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('deploy.cmd', ['--prod'], 'C:\\cwd', false);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(!result.commandLine.includes('ProcessStartInfo'));
				assert.ok(result.commandLine.includes("Start-Process -FilePath 'deploy.cmd'"));
				assert.ok(result.commandLine.includes("-ArgumentList @('--prod')"));
				assert.ok(result.commandLine.includes("-WorkingDirectory 'C:\\cwd'"));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should wrap command for POSIX with nohup', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'linux' });

				const result = wrapCommandForOneShot('python', ['script.py'], undefined, false);

				assert.strictEqual(result.isPowerShellScript, false);
				assert.ok(result.commandLine.startsWith('nohup python'));
				assert.ok(result.commandLine.includes("'script.py'"));
				assert.ok(result.commandLine.endsWith('>/dev/null 2>&1 &'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});

	suite('createShellExecution', () => {
		test('should create native ProcessExecution for a directly-launchable Windows command', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const options: vscode.ShellExecutionOptions = { cwd: 'C:\\' };
				const result = createShellExecution('node.exe', ['-e', 'process.stdout.write("hello")'], options, true);

				assert.ok(result.shellExecution);
				assert.strictEqual(result.usesNativeExecution, true);
				assert.ok(result.displayCommand.includes('process.stdout.write(\\"hello\\")'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should keep Windows shell builtins on PowerShell execution', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const options: vscode.ShellExecutionOptions = { cwd: 'C:\\' };
				const result = createShellExecution('echo', ['hello'], options, true);

				assert.ok(result.shellExecution);
				assert.strictEqual(result.usesNativeExecution, undefined);
				assert.ok(result.displayCommand.includes('echo'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should create ShellExecution for POSIX', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'darwin' });

				const options: vscode.ShellExecutionOptions = { cwd: '/tmp' };
				const result = createShellExecution('ls', ['-la'], options, false);

				assert.ok(result.shellExecution);
				assert.strictEqual(result.displayCommand, "ls '-la'");
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});

	suite('filterConflictingItems', () => {
		test('should filter out items with conflicting IDs', () => {
			const existingIds = new Set(['action1', 'action2']);
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Conflicting Action' },
				{ id: 'action3', title: 'Non-conflicting Action' }
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, 'action3');
		});

		test('should return all items when no conflicts', () => {
			const existingIds = new Set(['other1', 'other2']);
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 2);
		});

		test('should return empty array when all items conflict', () => {
			const existingIds = new Set(['action1', 'action2']);
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 0);
		});

		test('should recursively filter nested children with conflicting IDs', () => {
			const existingIds = new Set(['nested-conflict']);
			const items: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [
						{ id: 'nested-conflict', title: 'Conflicting Nested' },
						{ id: 'nested-ok', title: 'OK Nested' }
					]
				}
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, 'folder1');
			assert.strictEqual(result[0].children?.length, 1);
			assert.strictEqual(result[0].children?.[0].id, 'nested-ok');
		});

		test('should filter parent folder if its ID conflicts', () => {
			const existingIds = new Set(['folder1']);
			const items: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Conflicting Folder',
					type: 'folder',
					children: [
						{ id: 'child1', title: 'Child 1' }
					]
				}
			];

			const result = filterConflictingItems(items, existingIds);

			assert.strictEqual(result.length, 0);
		});

		test('should not mutate original items', () => {
			const existingIds = new Set(['nested-conflict']);
			const originalChildren = [
				{ id: 'nested-conflict', title: 'Conflicting' },
				{ id: 'nested-ok', title: 'OK' }
			];
			const items: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [...originalChildren]
				}
			];

			filterConflictingItems(items, existingIds);

			// Original should be unchanged
			assert.strictEqual(items[0].children?.length, 2);
		});

		test('should handle empty items array', () => {
			const existingIds = new Set(['action1']);
			const result = filterConflictingItems([], existingIds);
			assert.strictEqual(result.length, 0);
		});

		test('should handle empty existingIds set', () => {
			const items: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];

			const result = filterConflictingItems(items, new Set());

			assert.strictEqual(result.length, 2);
		});
	});

	suite('findConflictingIds', () => {
		test('should find conflicting IDs between two action arrays', () => {
			const actions1: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' },
				{ id: 'action2', title: 'Action 2' }
			];
			const actions2: ActionItem[] = [
				{ id: 'action2', title: 'Duplicate Action 2' },
				{ id: 'action3', title: 'Action 3' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 1);
			assert.strictEqual(conflicts[0], 'action2');
		});

		test('should return empty array when no conflicts', () => {
			const actions1: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' }
			];
			const actions2: ActionItem[] = [
				{ id: 'action2', title: 'Action 2' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 0);
		});

		test('should find nested conflicting IDs', () => {
			const actions1: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [
						{ id: 'nested-action', title: 'Nested Action' }
					]
				}
			];
			const actions2: ActionItem[] = [
				{ id: 'nested-action', title: 'Conflicting Nested' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 1);
			assert.strictEqual(conflicts[0], 'nested-action');
		});

		test('should find conflicts in nested children of second array', () => {
			const actions1: ActionItem[] = [
				{ id: 'action1', title: 'Action 1' }
			];
			const actions2: ActionItem[] = [
				{
					id: 'folder1',
					title: 'Folder',
					type: 'folder',
					children: [
						{ id: 'action1', title: 'Conflicting in child' }
					]
				}
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 1);
			assert.strictEqual(conflicts[0], 'action1');
		});

		test('should handle multiple conflicts', () => {
			const actions1: ActionItem[] = [
				{ id: 'a', title: 'A' },
				{ id: 'b', title: 'B' },
				{ id: 'c', title: 'C' }
			];
			const actions2: ActionItem[] = [
				{ id: 'a', title: 'Conflict A' },
				{ id: 'b', title: 'Conflict B' },
				{ id: 'd', title: 'D' }
			];

			const conflicts = findConflictingIds(actions1, actions2);

			assert.strictEqual(conflicts.length, 2);
			assert.ok(conflicts.includes('a'));
			assert.ok(conflicts.includes('b'));
		});

		test('should handle empty arrays', () => {
			assert.strictEqual(findConflictingIds([], []).length, 0);
			assert.strictEqual(findConflictingIds([{ id: 'a', title: 'A' }], []).length, 0);
			assert.strictEqual(findConflictingIds([], [{ id: 'a', title: 'A' }]).length, 0);
		});
	});

	suite('debounce', () => {
		test('should call the function after the delay', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 30);
			debouncedFn.run();
			setTimeout(() => {
				assert.strictEqual(callCount, 1);
				done();
			}, 80);
		});

		test('should batch rapid successive calls into one', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 30);
			debouncedFn.run();
			debouncedFn.run();
			debouncedFn.run();
			setTimeout(() => {
				assert.strictEqual(callCount, 1);
				done();
			}, 80);
		});

		test('should fire again after the delay has elapsed', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 30);
			debouncedFn.run();
			setTimeout(() => {
				debouncedFn.run();
			}, 80);
			setTimeout(() => {
				assert.strictEqual(callCount, 2);
				done();
			}, 160);
		});

		test('cancel should prevent the pending timer from firing', (done) => {
			let callCount = 0;
			const debouncedFn = debounce(() => { callCount++; }, 60);
			debouncedFn.run();
			debouncedFn.cancel();
			setTimeout(() => {
				assert.strictEqual(callCount, 0, 'cancel should prevent the fn from being called');
				done();
			}, 120);
		});
	});

	suite('parsePathInfo', () => {
		test('should parse file path with extension', () => {
			const result = parsePathInfo('/projects/my-app/config.json');
			assert.strictEqual(result.path, '/projects/my-app/config.json');
			assert.strictEqual(result.dir, '/projects/my-app');
			assert.strictEqual(result.name, 'config.json');
			assert.strictEqual(result.fileNameOnly, 'config');
			assert.strictEqual(result.fileExt, 'json');
		});

		test('should parse folder path without extension', () => {
			const result = parsePathInfo('/projects/my-app');
			assert.strictEqual(result.path, '/projects/my-app');
			assert.strictEqual(result.dir, '/projects');
			assert.strictEqual(result.name, 'my-app');
			assert.strictEqual(result.fileNameOnly, 'my-app');
			assert.strictEqual(result.fileExt, '');
		});

		test('should parse folder path with dot in name', () => {
			const result = parsePathInfo('/projects/my.app');
			assert.strictEqual(result.name, 'my.app');
			assert.strictEqual(result.fileNameOnly, 'my');
			assert.strictEqual(result.fileExt, 'app');
		});

		test('should parse path with multiple dots', () => {
			const result = parsePathInfo('/projects/archive.tar.gz');
			assert.strictEqual(result.name, 'archive.tar.gz');
			assert.strictEqual(result.fileNameOnly, 'archive.tar');
			assert.strictEqual(result.fileExt, 'gz');
		});

		test('should handle dotfile (hidden file/folder)', () => {
			const result = parsePathInfo('/projects/.config');
			assert.strictEqual(result.name, '.config');
			assert.strictEqual(result.fileNameOnly, '.config');
			assert.strictEqual(result.fileExt, '');
		});
	});

	suite('handleConfirm', () => {
		test('should throw when user cancels (selects nothing)', async () => {
			// showWarningMessage returns undefined when dismissed
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => undefined;
			try {
				await assert.rejects(
					() => handleConfirm({ message: 'Continue?', confirmLabel: 'Yes', cancelLabel: 'No' }),
					{ message: 'Action was canceled by user.' }
				);
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should throw when user selects cancel label', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'No';
			try {
				await assert.rejects(
					() => handleConfirm({ message: 'Continue?', confirmLabel: 'Yes', cancelLabel: 'No' }),
					{ message: 'Action was canceled by user.' }
				);
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should return confirmed true when user confirms', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'Yes';
			try {
				const result = await handleConfirm({ message: 'Continue?', confirmLabel: 'Yes', cancelLabel: 'No' });
				assert.strictEqual(result.confirmed, 'true');
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should use default labels when not specified', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			(vscode.window as any).showWarningMessage = async () => 'Yes';
			try {
				const result = await handleConfirm({});
				assert.strictEqual(result.confirmed, 'true');
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});

		test('should use custom confirm label', async () => {
			const originalShowWarningMessage = vscode.window.showWarningMessage;
			let capturedArgs: any[] = [];
			(vscode.window as any).showWarningMessage = async (...args: any[]) => {
				capturedArgs = args;
				return 'Proceed';
			};
			try {
				const result = await handleConfirm({ message: 'Deploy?', confirmLabel: 'Proceed', cancelLabel: 'Abort' });
				assert.strictEqual(result.confirmed, 'true');
				assert.strictEqual(capturedArgs[0], 'Deploy?');
				assert.strictEqual(capturedArgs[2], 'Proceed');
				assert.strictEqual(capturedArgs[3], 'Abort');
			} finally {
				(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			}
		});
	});

	suite('serializeExportData', () => {
		test('should create valid export format', () => {
			const actions: ActionItem[] = [
				{ id: 'test.action', title: 'Test', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell', command: 'echo hi' }] } }
			];
			const result = JSON.parse(serializeExportData(actions));
			assert.strictEqual(result.version, 1);
			assert.ok(result.exportedAt);
			assert.strictEqual(result.actions.length, 1);
			assert.strictEqual(result.actions[0].id, 'test.action');
		});

		test('should handle empty actions array', () => {
			const result = JSON.parse(serializeExportData([]));
			assert.strictEqual(result.version, 1);
			assert.strictEqual(result.actions.length, 0);
		});
	});

	suite('parseImportData', () => {
		test('should parse TaskHub export format', () => {
			const data = JSON.stringify({
				version: 1,
				exportedAt: '2026-01-01T00:00:00.000Z',
				actions: [{ id: 'test.action', title: 'Test', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell' }] } }]
			});
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(actions.length, 1);
			assert.strictEqual(actions[0].id, 'test.action');
		});

		test('should parse raw actions.json array', () => {
			const data = JSON.stringify([
				{ id: 'raw.action', title: 'Raw', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(actions.length, 1);
		});

		test('should return error for invalid JSON', () => {
			const { actions, errors } = parseImportData('not json');
			assert.strictEqual(actions.length, 0);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('Invalid JSON'));
		});

		test('should return error for unsupported version', () => {
			const data = JSON.stringify({ version: 99, actions: [] });
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors[0].includes('Unsupported export version'));
		});

		test('should return error for invalid structure', () => {
			const data = JSON.stringify({ foo: 'bar' });
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.strictEqual(errors.length, 1);
		});

		test('should return schema validation error for malformed actions', () => {
			const data = JSON.stringify([{ notAnAction: true }]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors.length > 0);
			assert.ok(errors[0].includes('Schema validation failed'));
		});

		test('should return error for duplicate action IDs within imported file', () => {
			const data = JSON.stringify([
				{ id: 'dup.action', title: 'First', action: { description: 'desc', tasks: [{ id: 't1', type: 'shell' }] } },
				{ id: 'dup.action', title: 'Second', action: { description: 'desc', tasks: [{ id: 't2', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('Duplicate action id'));
			assert.ok(errors[0].includes('dup.action'));
		});

		test('should return error for duplicate IDs in nested children of imported file', () => {
			const data = JSON.stringify([
				{
					id: 'folder1', title: 'Folder', children: [
						{ id: 'nested.dup', title: 'Child1', action: { description: 'd', tasks: [{ id: 't1', type: 'shell' }] } }
					]
				},
				{ id: 'nested.dup', title: 'TopLevel', action: { description: 'd', tasks: [{ id: 't2', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors[0].includes('nested.dup'));
		});

		test('should reject imported file with duplicate task IDs inside a single action', () => {
			// Regression: previously import only checked duplicate action IDs, so an
			// action with duplicate task IDs could pass import validation and then
			// break normal action loading on the next read from disk.
			const data = JSON.stringify([
				{
					id: 'action.dup-task',
					title: 'Dup Task',
					action: {
						description: 'd',
						tasks: [
							{ id: 'step', type: 'shell', command: 'echo 1' },
							{ id: 'step', type: 'shell', command: 'echo 2' }
						]
					}
				}
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(actions.length, 0);
			assert.ok(errors.length > 0);
			assert.ok(errors[0].includes('duplicate task id'), `expected duplicate task id message, got: ${errors[0]}`);
		});

		test('should accept imported file with unique IDs', () => {
			const data = JSON.stringify([
				{ id: 'action.a', title: 'A', action: { description: 'd', tasks: [{ id: 't1', type: 'shell' }] } },
				{ id: 'action.b', title: 'B', action: { description: 'd', tasks: [{ id: 't2', type: 'shell' }] } }
			]);
			const { actions, errors } = parseImportData(data);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(actions.length, 2);
		});
	});

	suite('countActionItems', () => {
		test('should return 1 for a single action without children', () => {
			const item: ActionItem = { id: 'single', title: 'Single Action' };
			assert.strictEqual(countActionItems(item), 1);
		});

		test('should count children in a folder', () => {
			const item: ActionItem = {
				id: 'folder', title: 'Folder', type: 'folder',
				children: [
					{ id: 'child1', title: 'Child 1' },
					{ id: 'child2', title: 'Child 2' },
					{ id: 'child3', title: 'Child 3' }
				]
			};
			assert.strictEqual(countActionItems(item), 3);
		});

		test('should count nested children recursively', () => {
			const item: ActionItem = {
				id: 'root', title: 'Root', type: 'folder',
				children: [
					{ id: 'child1', title: 'Child 1' },
					{
						id: 'subfolder', title: 'Sub', type: 'folder',
						children: [
							{ id: 'nested1', title: 'Nested 1' },
							{ id: 'nested2', title: 'Nested 2' }
						]
					}
				]
			};
			assert.strictEqual(countActionItems(item), 3);
		});

		test('should return 0 for folder with empty children', () => {
			const item: ActionItem = { id: 'empty', title: 'Empty Folder', type: 'folder', children: [] };
			assert.strictEqual(countActionItems(item), 0);
		});
	});

	suite('mergeImportedActions', () => {
		test('should merge non-conflicting actions', () => {
			const existing: ActionItem[] = [{ id: 'existing.1', title: 'Existing' }];
			const imported: ActionItem[] = [{ id: 'imported.1', title: 'Imported' }];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(skipped.length, 0);
		});

		test('should skip duplicate ids', () => {
			const existing: ActionItem[] = [{ id: 'action.1', title: 'Existing' }];
			const imported: ActionItem[] = [
				{ id: 'action.1', title: 'Duplicate' },
				{ id: 'action.2', title: 'New' }
			];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(skipped.length, 1);
			assert.strictEqual(skipped[0], 'action.1');
			assert.strictEqual(merged[1].id, 'action.2');
		});

		test('should detect duplicates in nested children', () => {
			const existing: ActionItem[] = [{
				id: 'folder.1', title: 'Folder', type: 'folder',
				children: [{ id: 'nested.1', title: 'Nested' }]
			}];
			const imported: ActionItem[] = [{ id: 'nested.1', title: 'Duplicate Nested' }];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(skipped.length, 1);
			assert.strictEqual(skipped[0], 'nested.1');
		});

		test('should skip imported folder whose nested child collides with existing', () => {
			const existing: ActionItem[] = [{ id: 'nested.1', title: 'Existing' }];
			const imported: ActionItem[] = [{
				id: 'folder.1', title: 'Imported Folder', type: 'folder',
				children: [{ id: 'nested.1', title: 'Duplicate' }]
			}];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(merged.length, 1, 'imported folder must not be merged when its nested child collides');
			assert.ok(skipped.includes('nested.1'), 'nested conflicting id should be reported as skipped');
			assert.strictEqual(merged[0].id, 'nested.1');
		});

		test('should merge imported folder with unique nested children', () => {
			const existing: ActionItem[] = [{ id: 'a', title: 'A' }];
			const imported: ActionItem[] = [{
				id: 'folder.1', title: 'Imported Folder', type: 'folder',
				children: [{ id: 'b', title: 'B' }, { id: 'c', title: 'C' }]
			}];
			const { merged, skipped } = mergeImportedActions(existing, imported);
			assert.strictEqual(skipped.length, 0);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(merged[1].id, 'folder.1');
		});

		test('should handle empty existing actions', () => {
			const imported: ActionItem[] = [{ id: 'new.1', title: 'New' }];
			const { merged, skipped } = mergeImportedActions([], imported);
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(skipped.length, 0);
		});

		test('should handle empty imported actions', () => {
			const existing: ActionItem[] = [{ id: 'existing.1', title: 'Existing' }];
			const { merged, skipped } = mergeImportedActions(existing, []);
			assert.strictEqual(merged.length, 1);
			assert.strictEqual(skipped.length, 0);
		});
	});

	suite('mergeActions (preset merge strategies)', () => {
		const existing: ActionItem[] = [
			{ id: 'shared', title: 'Existing Shared' },
			{ id: 'only-existing', title: 'Only Existing' }
		];
		const preset: ActionItem[] = [
			{ id: 'shared', title: 'Preset Shared' },
			{ id: 'only-preset', title: 'Only Preset' }
		];

		test('keep-existing: preset wins for unique IDs only, existing kept on conflict', () => {
			const merged = mergeActions(existing, preset, 'keep-existing');
			const byId = new Map(merged.map(a => [a.id, a]));
			assert.strictEqual(byId.get('shared')?.title, 'Existing Shared');
			assert.ok(byId.has('only-preset'));
			assert.ok(byId.has('only-existing'));
		});

		test('use-preset: conflicting preset action actually wins (regression)', () => {
			// Regression for the bug where the "Use preset" QuickPick option
			// silently behaved like "Keep existing" because mergeActions always
			// filtered preset items by existing IDs.
			const merged = mergeActions(existing, preset, 'use-preset');
			const byId = new Map(merged.map(a => [a.id, a]));
			assert.strictEqual(
				byId.get('shared')?.title,
				'Preset Shared',
				'preset entry must win when strategy is use-preset'
			);
			assert.ok(byId.has('only-preset'));
			assert.ok(byId.has('only-existing'));
		});

		test('keep-both: existing and preset coexist, with preset conflicts dropped', () => {
			const merged = mergeActions(existing, preset, 'keep-both');
			const byId = new Map(merged.map(a => [a.id, a]));
			assert.strictEqual(byId.get('shared')?.title, 'Existing Shared');
			assert.ok(byId.has('only-preset'));
			assert.ok(byId.has('only-existing'));
		});
	});

	suite('toWorkspaceRelativePath', () => {
		test('converts a file inside the workspace to ${workspaceFolder} form', () => {
			const root = path.resolve('/tmp/taskhub-ws');
			const file = path.join(root, 'src', 'index.ts');
			assert.strictEqual(
				toWorkspaceRelativePath(file, root),
				'${workspaceFolder}/src/index.ts'
			);
		});

		test('leaves paths outside the workspace as absolute', () => {
			const root = path.resolve('/tmp/taskhub-ws');
			const outside = path.resolve('/tmp/elsewhere/file.ts');
			assert.strictEqual(toWorkspaceRelativePath(outside, root), outside);
		});

		test('returns raw path when workspaceFolder is missing', () => {
			const file = path.resolve('/tmp/anything/file.ts');
			assert.strictEqual(toWorkspaceRelativePath(file, undefined), file);
		});
	});

	suite('executeShellCommand: capture overflow is a normal failure', () => {
		// POSIX-only — the underlying `sh -c 'yes | head -c ...'` is cross-shell
		// awkward on Windows and the overflow logic itself is identical.
		(process.platform === 'win32' ? test.skip : test)(
			'rejects with the overflow message AND does not mark the action as manually terminated',
			async function () {
				this.timeout(15_000);
				const cfg = vscode.workspace.getConfiguration('taskhub');
				const prevLimit = cfg.get('pipeline.outputCaptureLimitMb');
				await cfg.update('pipeline.outputCaptureLimitMb', 1, vscode.ConfigurationTarget.Global);
				try {
					const actionKey = `test.capture-overflow.${Date.now()}`;
					// `yes | head -c 3000000` reliably emits 3 MB then exits;
					// well above the 1 MB cap set above.
					let caught: Error | undefined;
					try {
						await executeShellCommand(
							'sh',
							['-c', 'yes | head -c 3000000'],
							undefined,
							undefined,
							undefined,
							actionKey
						);
					} catch (e) {
						caught = e as Error;
					}
					assert.ok(caught, 'executeShellCommand should reject when the capture cap is exceeded');
					assert.ok(
						/Captured output exceeded|캡처된 출력이/.test(caught!.message),
						`expected overflow-specific error message, got: ${caught!.message}`
					);
					// Regression: previously the overflow path added to
					// manuallyTerminatedActions, which caused executeAction()
					// to record the failure as "Action stopped by user"
					// instead of the real error. Verify we don't do that
					// anymore.
					assert.strictEqual(
						__testHook_hasManuallyTerminated(actionKey),
						false,
						'capture overflow must not be classified as a user-initiated manual termination'
					);
				} finally {
					await cfg.update('pipeline.outputCaptureLimitMb', prevLimit, vscode.ConfigurationTarget.Global);
				}
			}
		);
	});

	suite('getActionsValidator (module-level cache)', () => {
		test('returns the same compiled validator on repeated calls', () => {
			const first = getActionsValidator();
			const second = getActionsValidator();
			assert.strictEqual(first, second, 'Ajv validator should be cached and reused');
		});

		test('returned validator correctly validates a well-formed action array', () => {
			const validate = getActionsValidator();
			const sample: ActionItem[] = [
				{
					id: 'root.hello',
					title: 'Hello',
					action: {
						description: 'say hi',
						tasks: [{ id: 'say', type: 'shell', command: 'echo hi' }]
					}
				}
			];
			const ok = validate(sample);
			assert.strictEqual(ok, true, `Expected valid actions to pass; errors: ${JSON.stringify(validate.errors)}`);
		});

		test('returned validator rejects malformed input', () => {
			const validate = getActionsValidator();
			// Missing `title` is required by the schema.
			const bad: any = [{ id: 'broken', action: { tasks: [] } }];
			const ok = validate(bad);
			assert.strictEqual(ok, false, 'Expected malformed actions to be rejected');
		});
	});

	suite('invalidateActionsCache', () => {
		test('is a callable function returning undefined', () => {
			assert.strictEqual(typeof invalidateActionsCache, 'function');
			assert.strictEqual(invalidateActionsCache(), undefined);
		});

		test('can be called multiple times without throwing', () => {
			assert.doesNotThrow(() => {
				invalidateActionsCache();
				invalidateActionsCache();
				invalidateActionsCache();
			});
		});
	});

	suite('Provider constructors (deferred load)', () => {
		// Build a minimal stub ExtensionContext for constructor tests.
		const makeStubContext = (): vscode.ExtensionContext => {
			const nowhere = path.join(os.tmpdir(), `taskhub-nonexistent-${Date.now()}`);
			return {
				extensionPath: nowhere,
				subscriptions: [],
				workspaceState: {
					get: () => undefined,
					update: () => Promise.resolve(),
					keys: () => []
				},
				globalState: {
					get: () => undefined,
					update: () => Promise.resolve(),
					keys: () => [],
					setKeysForSync: () => {}
				},
				extensionMode: 1,
				extension: { packageJSON: { version: '0.0.0-test' } }
			} as unknown as vscode.ExtensionContext;
		};

		// These tests assert the providers' observable `loaded` flag directly.
		// Node's `fs` module on this runtime exposes its members as
		// non-configurable getters, which blocks a traditional monkey-patch spy.
		// The `loaded` flag was introduced specifically so regressions that
		// reintroduce eager JSON reads in the constructor (e.g. `this.cachedX =
		// this.loadX()`) are detected: the flag stays `false` until a load path
		// actually runs.

		test('LinkViewProvider leaves loaded=false and cachedEntries=[] after construction', () => {
			const provider = new LinkViewProvider() as any;
			assert.strictEqual(provider.loaded, false, 'loaded flag must be false — constructor must not perform a load');
			assert.deepStrictEqual(provider.cachedEntries, [], 'cachedEntries must be the initial empty array');
		});

		test('FavoriteViewProvider leaves loaded=false and cachedFavorites=[] after construction', () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			assert.deepStrictEqual(provider.cachedFavorites, []);
		});

		test('LinkViewProvider.refresh() transitions loaded to true and triggers the load path', () => {
			const provider = new LinkViewProvider() as any;
			assert.strictEqual(provider.loaded, false);
			provider.refresh();
			assert.strictEqual(provider.loaded, true, 'refresh() must set loaded=true so subsequent ensureCache() calls are cheap');
		});

		test('FavoriteViewProvider.refresh() transitions loaded to true and triggers the load path', () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			provider.refresh();
			assert.strictEqual(provider.loaded, true);
		});

		test('LinkViewProvider.getChildren() lazily loads on first call, becomes no-op on repeat', async () => {
			const provider = new LinkViewProvider() as any;
			assert.strictEqual(provider.loaded, false);
			const first = await provider.getChildren();
			assert.strictEqual(provider.loaded, true, 'first getChildren() call must trigger the lazy load');
			assert.strictEqual(first.length, 0);
			const second = await provider.getChildren();
			assert.strictEqual(provider.loaded, true, 'second getChildren() call must keep loaded=true');
			assert.strictEqual(second.length, 0);
		});

		test('FavoriteViewProvider.getChildren() lazily loads on first call, becomes no-op on repeat', async () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			const first = await provider.getChildren();
			assert.strictEqual(provider.loaded, true);
			assert.strictEqual(first.length, 0);
			const second = await provider.getChildren();
			assert.strictEqual(provider.loaded, true);
			assert.strictEqual(second.length, 0);
		});
	});
});
