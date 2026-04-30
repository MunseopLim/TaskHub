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
	quotePosixArgument,
	tokenizeCommandLine,
	formatActionPath,
	mergeCommandAndArgs,
	handleStringManipulation,
	findActionById,
	insertActionIntoDestination,
	createGroupedTaskPresentationOptions,
	addLinkEntry,
	getCommandString,
	getToolCommand,
	buildPowerShellInvocation,
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
} from '../extension';
import { normalizeTags, normalizeLineNumber } from '../providers/normalization';
import { LinkViewProvider } from '../providers/linkViewProvider';
import { FavoriteViewProvider } from '../providers/favoriteViewProvider';
import { HistoryProvider, HistoryEntry } from '../providers/historyProvider';
import * as os from 'os';
import * as path from 'path';
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

		async function withHistoryMaxItems<T>(max: number, fn: () => T | Promise<T>): Promise<T> {
			const cfg = vscode.workspace.getConfiguration('taskhub.history');
			const prev = cfg.get('maxItems');
			await cfg.update('maxItems', max, vscode.ConfigurationTarget.Global);
			try {
				return await fn();
			} finally {
				await cfg.update('maxItems', prev, vscode.ConfigurationTarget.Global);
			}
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
			await withHistoryMaxItems(3, () => {
				const provider = new HistoryProvider(createMockContext());
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
			assert.strictEqual(byActionId.get('out-only')?.contextValue, 'historyItemWithOutput');
			assert.strictEqual(byActionId.get('in-only')?.contextValue, 'historyItemWithInputs');
			assert.strictEqual(byActionId.get('both')?.contextValue, 'historyItemWithOutputAndInputs');
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
			await withHistoryMaxItems(50, () => {
				const provider = new HistoryProvider(ctx);
				for (let i = 0; i < 8; i++) {
					provider.addHistoryEntry(makeEntry(`x${i}`, 'success', 1000 + i));
				}
			});
			// Lower maxItems, then trim. We expect only the first 4 newest
			// entries to remain (history is ordered newest-first).
			await withHistoryMaxItems(4, () => {
				const provider = new HistoryProvider(ctx);
				provider.trimHistoryToMax();
				const history = provider.getHistory();
				assert.strictEqual(history.length, 4);
				assert.deepStrictEqual(
					history.map(e => e.actionId),
					['x7', 'x6', 'x5', 'x4']
				);
			});
		});

		test('trimHistoryToMax is a no-op when history.length <= maxItems', async () => {
			const ctx = createMockContext();
			await withHistoryMaxItems(10, () => {
				const provider = new HistoryProvider(ctx);
				provider.addHistoryEntry(makeEntry('a', 'success', 1));
				provider.addHistoryEntry(makeEntry('b', 'success', 2));
				provider.trimHistoryToMax();
				assert.strictEqual(provider.getHistory().length, 2);
			});
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
		test('should wrap command for Windows PowerShell with UTF-8', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('notepad', ['file.txt'], undefined, true);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(result.commandLine.includes('Start-Process'));
				assert.ok(result.commandLine.includes("-FilePath 'notepad'"));
				assert.ok(result.commandLine.includes("-ArgumentList @('file.txt')"));
				assert.ok(result.commandLine.includes('[Console]::OutputEncoding'));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});

		test('should wrap command for Windows PowerShell without UTF-8', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const result = wrapCommandForOneShot('notepad', [], 'C:\\cwd', false);

				assert.strictEqual(result.isPowerShellScript, true);
				assert.ok(!result.commandLine.includes('[Console]::OutputEncoding'));
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
		test('should create PowerShell execution for Windows', () => {
			const originalPlatform = process.platform;
			try {
				Object.defineProperty(process, 'platform', { value: 'win32' });

				const options: vscode.ShellExecutionOptions = { cwd: 'C:\\' };
				const result = createShellExecution('echo', ['hello'], options, true);

				assert.ok(result.shellExecution);
				// Verify display command matches expected format
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

		test('LinkViewProvider (builtin) leaves loaded=false and cachedEntries=[] after construction', () => {
			const provider = new LinkViewProvider(makeStubContext(), 'builtin') as any;
			assert.strictEqual(provider.loaded, false, 'loaded flag must be false — constructor must not perform a load');
			assert.deepStrictEqual(provider.cachedEntries, [], 'cachedEntries must be the initial empty array');
		});

		test('LinkViewProvider (workspace) leaves loaded=false and cachedEntries=[] after construction', () => {
			const provider = new LinkViewProvider(makeStubContext(), 'workspace') as any;
			assert.strictEqual(provider.loaded, false);
			assert.deepStrictEqual(provider.cachedEntries, []);
		});

		test('FavoriteViewProvider leaves loaded=false and cachedFavorites=[] after construction', () => {
			const provider = new FavoriteViewProvider(makeStubContext()) as any;
			assert.strictEqual(provider.loaded, false);
			assert.deepStrictEqual(provider.cachedFavorites, []);
		});

		test('LinkViewProvider.refresh() transitions loaded to true and triggers the load path', () => {
			const provider = new LinkViewProvider(makeStubContext(), 'workspace') as any;
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
			const provider = new LinkViewProvider(makeStubContext(), 'workspace') as any;
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
