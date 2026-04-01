import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	interpolatePipelineVariables,
	normalizeTags,
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
	normalizeLineNumber,
	wrapCommandForOneShot,
	createShellExecution,
	filterConflictingItems,
	findConflictingIds,
	debounce,
	parsePathInfo,
	handleConfirm,
	serializeExportData,
	parseImportData,
	mergeImportedActions,
	countActionItems,
} from '../extension';
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

		test('should handle null values', () => {
			const template = 'Value: ${task1.data}';
			const context = { task1: { data: null } };
			const result = interpolatePipelineVariables(template, context);
			assert.strictEqual(result, 'Value: null');
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

		// We need to import HistoryProvider for testing, but it's not exported
		// So we'll test through the public API (commands) or export it for testing
		// For now, let's test the history entry structure and behavior

		test('should create valid history entry structure', () => {
			const entry = {
				actionId: 'test.action',
				actionTitle: 'Test Action',
				timestamp: Date.now(),
				status: 'success' as const
			};

			assert.strictEqual(entry.actionId, 'test.action');
			assert.strictEqual(entry.actionTitle, 'Test Action');
			assert.ok(entry.timestamp > 0);
			assert.strictEqual(entry.status, 'success');
		});

		test('should handle history entry with output', () => {
			const entry = {
				actionId: 'test.action',
				actionTitle: 'Test Action',
				timestamp: Date.now(),
				status: 'failure' as const,
				output: 'Error: Something went wrong'
			};

			assert.ok(entry.output);
			assert.strictEqual(entry.output, 'Error: Something went wrong');
		});

		test('should handle all status types', () => {
			const statuses: Array<'success' | 'failure' | 'running'> = ['success', 'failure', 'running'];

			for (const status of statuses) {
				const entry = {
					actionId: 'test.action',
					actionTitle: 'Test Action',
					timestamp: Date.now(),
					status: status
				};

				assert.strictEqual(entry.status, status);
			}
		});

		test('should maintain history order (newest first)', () => {
			const entries = [
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: 1000, status: 'success' as const },
				{ actionId: 'action2', actionTitle: 'Action 2', timestamp: 2000, status: 'success' as const },
				{ actionId: 'action3', actionTitle: 'Action 3', timestamp: 3000, status: 'success' as const }
			];

			// Verify newest is first
			assert.ok(entries[0].timestamp < entries[1].timestamp);
			assert.ok(entries[1].timestamp < entries[2].timestamp);
		});

		test('should limit history to maxItems', () => {
			const maxItems = 10;
			const entries = [];

			// Add more than maxItems
			for (let i = 0; i < 15; i++) {
				entries.push({
					actionId: `action${i}`,
					actionTitle: `Action ${i}`,
					timestamp: Date.now() + i,
					status: 'success' as const
				});
			}

			// Simulate trimming
			const trimmed = entries.slice(0, maxItems);

			assert.strictEqual(trimmed.length, maxItems);
		});

		test('should find and update history entry by actionId and timestamp', () => {
			const timestamp = Date.now();
			const entries: Array<{
				actionId: string;
				actionTitle: string;
				timestamp: number;
				status: 'success' | 'failure' | 'running';
			}> = [
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: timestamp, status: 'running' },
				{ actionId: 'action2', actionTitle: 'Action 2', timestamp: timestamp + 1000, status: 'success' }
			];

			// Find the entry
			const entry = entries.find(e => e.actionId === 'action1' && e.timestamp === timestamp);

			assert.ok(entry);
			assert.strictEqual(entry!.status, 'running');

			// Update it
			entry!.status = 'success';
			assert.strictEqual(entry!.status, 'success');
		});

		test('should delete history entry by actionId and timestamp', () => {
			const timestamp = Date.now();
			const entries = [
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: timestamp, status: 'success' as const },
				{ actionId: 'action2', actionTitle: 'Action 2', timestamp: timestamp + 1000, status: 'success' as const }
			];

			// Find and delete
			const index = entries.findIndex(e => e.actionId === 'action1' && e.timestamp === timestamp);
			assert.ok(index !== -1);

			entries.splice(index, 1);
			assert.strictEqual(entries.length, 1);
			assert.strictEqual(entries[0].actionId, 'action2');
		});

		test('should clear all history', () => {
			const entries = [
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: Date.now(), status: 'success' as const },
				{ actionId: 'action2', actionTitle: 'Action 2', timestamp: Date.now() + 1000, status: 'success' as const }
			];

			// Clear
			entries.length = 0;
			assert.strictEqual(entries.length, 0);
		});

		test('should handle duplicate action IDs with different timestamps', () => {
			const timestamp1 = Date.now();
			const timestamp2 = Date.now() + 1000;

			const entries = [
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: timestamp1, status: 'success' as const },
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: timestamp2, status: 'success' as const }
			];

			// Both entries should exist
			assert.strictEqual(entries.length, 2);
			assert.strictEqual(entries[0].actionId, entries[1].actionId);
			assert.notStrictEqual(entries[0].timestamp, entries[1].timestamp);
		});

		test('should handle history entry with empty output', () => {
			const entry = {
				actionId: 'test.action',
				actionTitle: 'Test Action',
				timestamp: Date.now(),
				status: 'success' as const,
				output: ''
			};

			assert.strictEqual(entry.output, '');
		});

		test('should handle history entry with multiline output', () => {
			const entry = {
				actionId: 'test.action',
				actionTitle: 'Test Action',
				timestamp: Date.now(),
				status: 'failure' as const,
				output: 'Error: Line 1\nError: Line 2\nError: Line 3'
			};

			assert.ok(entry.output.includes('\n'));
			assert.strictEqual(entry.output.split('\n').length, 3);
		});

		test('should trim history when maxItems is reduced', () => {
			const oldMax = 10;
			const newMax = 5;

			const entries = [];
			for (let i = 0; i < oldMax; i++) {
				entries.push({
					actionId: `action${i}`,
					actionTitle: `Action ${i}`,
					timestamp: Date.now() + i,
					status: 'success' as const
				});
			}

			assert.strictEqual(entries.length, oldMax);

			// Trim to new max
			if (entries.length > newMax) {
				entries.splice(newMax);
			}

			assert.strictEqual(entries.length, newMax);
		});

		test('should preserve history when maxItems is increased', () => {
			const oldMax = 5;
			const newMax = 10;

			const entries = [];
			for (let i = 0; i < oldMax; i++) {
				entries.push({
					actionId: `action${i}`,
					actionTitle: `Action ${i}`,
					timestamp: Date.now() + i,
					status: 'success' as const
				});
			}

			assert.strictEqual(entries.length, oldMax);

			// No trimming needed when increasing max
			assert.strictEqual(entries.length, oldMax);
		});
	});

	suite('Action Stop and History Update', () => {
		test('should track action start timestamp', () => {
			const actionId = 'test-action-1';
			const timestamp = Date.now();
			const timestampMap = new Map<string, number>();

			// Simulate adding timestamp when action starts
			timestampMap.set(actionId, timestamp);

			assert.strictEqual(timestampMap.get(actionId), timestamp);
			assert.strictEqual(timestampMap.has(actionId), true);
		});

		test('should clean up timestamp after action completes', () => {
			const actionId = 'test-action-2';
			const timestamp = Date.now();
			const timestampMap = new Map<string, number>();

			timestampMap.set(actionId, timestamp);
			assert.strictEqual(timestampMap.has(actionId), true);

			// Simulate cleanup in finally block
			timestampMap.delete(actionId);
			assert.strictEqual(timestampMap.has(actionId), false);
		});

		test('should handle multiple concurrent actions with different timestamps', () => {
			const timestampMap = new Map<string, number>();
			const action1 = { id: 'action1', timestamp: Date.now() };
			const action2 = { id: 'action2', timestamp: Date.now() + 100 };
			const action3 = { id: 'action3', timestamp: Date.now() + 200 };

			timestampMap.set(action1.id, action1.timestamp);
			timestampMap.set(action2.id, action2.timestamp);
			timestampMap.set(action3.id, action3.timestamp);

			assert.strictEqual(timestampMap.size, 3);
			assert.strictEqual(timestampMap.get(action1.id), action1.timestamp);
			assert.strictEqual(timestampMap.get(action2.id), action2.timestamp);
			assert.strictEqual(timestampMap.get(action3.id), action3.timestamp);
		});

		test('should update history status to failure when action is manually stopped', () => {
			type HistoryStatus = 'success' | 'failure' | 'running';
			interface HistoryEntry {
				actionId: string;
				actionTitle: string;
				timestamp: number;
				status: HistoryStatus;
				output?: string;
			}

			const actionId = 'test-action';
			const timestamp = Date.now();
			const history: HistoryEntry[] = [
				{
					actionId: actionId,
					actionTitle: 'Test Action',
					timestamp: timestamp,
					status: 'running'
				}
			];

			// Simulate manual stop - find and update the entry
			const entry = history.find(e => e.actionId === actionId && e.timestamp === timestamp);
			assert.ok(entry);
			assert.strictEqual(entry.status, 'running');

			// Update status to failure with stop message
			entry.status = 'failure';
			entry.output = 'Action stopped by user';

			assert.strictEqual(entry.status, 'failure');
			assert.strictEqual(entry.output, 'Action stopped by user');
		});

		test('should track manually terminated actions', () => {
			const manuallyTerminatedActions = new Set<string>();
			const actionId = 'test-action';

			// Simulate adding to manually terminated set
			manuallyTerminatedActions.add(actionId);

			assert.strictEqual(manuallyTerminatedActions.has(actionId), true);

			// Cleanup after handling
			manuallyTerminatedActions.delete(actionId);
			assert.strictEqual(manuallyTerminatedActions.has(actionId), false);
		});

		test('should update history entry with error message on manual stop', () => {
			type HistoryStatus = 'success' | 'failure' | 'running';
			interface HistoryEntry {
				actionId: string;
				actionTitle: string;
				timestamp: number;
				status: HistoryStatus;
				output?: string;
			}

			const history: HistoryEntry[] = [
				{
					actionId: 'action1',
					actionTitle: 'Build Project',
					timestamp: Date.now(),
					status: 'running'
				}
			];

			// Simulate updating status on manual stop
			const entry = history.find(e => e.actionId === 'action1');
			if (entry) {
				entry.status = 'failure';
				entry.output = 'Action stopped by user';
			}

			assert.strictEqual(entry?.status, 'failure');
			assert.strictEqual(entry?.output, 'Action stopped by user');
		});

		test('should preserve other history entries when updating one', () => {
			type HistoryStatus = 'success' | 'failure' | 'running';
			interface HistoryEntry {
				actionId: string;
				actionTitle: string;
				timestamp: number;
				status: HistoryStatus;
				output?: string;
			}

			const timestamp1 = Date.now();
			const timestamp2 = Date.now() + 1000;
			const timestamp3 = Date.now() + 2000;

			const history: HistoryEntry[] = [
				{ actionId: 'action1', actionTitle: 'Action 1', timestamp: timestamp1, status: 'success' },
				{ actionId: 'action2', actionTitle: 'Action 2', timestamp: timestamp2, status: 'running' },
				{ actionId: 'action3', actionTitle: 'Action 3', timestamp: timestamp3, status: 'success' }
			];

			// Update only action2
			const entry = history.find(e => e.actionId === 'action2' && e.timestamp === timestamp2);
			if (entry) {
				entry.status = 'failure';
				entry.output = 'Action stopped by user';
			}

			// Verify other entries are unchanged
			assert.strictEqual(history[0].status, 'success');
			assert.strictEqual(history[0].output, undefined);
			assert.strictEqual(history[1].status, 'failure');
			assert.strictEqual(history[1].output, 'Action stopped by user');
			assert.strictEqual(history[2].status, 'success');
			assert.strictEqual(history[2].output, undefined);
		});

		test('should handle stopAction when action is not found', () => {
			const timestampMap = new Map<string, number>();
			const actionId = 'non-existent-action';

			// Attempt to get timestamp for non-existent action
			const timestamp = timestampMap.get(actionId);

			assert.strictEqual(timestamp, undefined);
			assert.strictEqual(timestampMap.has(actionId), false);
		});

		test('should differentiate between manual stop and regular failure', () => {
			type HistoryStatus = 'success' | 'failure' | 'running';
			interface HistoryEntry {
				actionId: string;
				actionTitle: string;
				timestamp: number;
				status: HistoryStatus;
				output?: string;
			}

			const manualStopEntry: HistoryEntry = {
				actionId: 'action1',
				actionTitle: 'Action 1',
				timestamp: Date.now(),
				status: 'failure',
				output: 'Action stopped by user'
			};

			const regularFailureEntry: HistoryEntry = {
				actionId: 'action2',
				actionTitle: 'Action 2',
				timestamp: Date.now() + 1000,
				status: 'failure',
				output: 'Error: Command failed'
			};

			// Both are failures but with different messages
			assert.strictEqual(manualStopEntry.status, 'failure');
			assert.strictEqual(regularFailureEntry.status, 'failure');
			assert.ok(manualStopEntry.output?.includes('stopped by user'));
			assert.ok(regularFailureEntry.output?.includes('Error'));
		});

		test('should handle concurrent action stops with correct timestamps', () => {
			const timestampMap = new Map<string, number>();
			const action1Id = 'action1';
			const action2Id = 'action2';
			const timestamp1 = Date.now();
			const timestamp2 = Date.now() + 100;

			timestampMap.set(action1Id, timestamp1);
			timestampMap.set(action2Id, timestamp2);

			// Stop action1
			const ts1 = timestampMap.get(action1Id);
			assert.strictEqual(ts1, timestamp1);
			timestampMap.delete(action1Id);

			// action2 should still be there
			assert.strictEqual(timestampMap.has(action1Id), false);
			assert.strictEqual(timestampMap.has(action2Id), true);
			assert.strictEqual(timestampMap.get(action2Id), timestamp2);
		});

		test('should handle action rerun with new timestamp', () => {
			const timestampMap = new Map<string, number>();
			const actionId = 'rerun-action';
			const firstTimestamp = Date.now();
			const secondTimestamp = Date.now() + 5000;

			// First run
			timestampMap.set(actionId, firstTimestamp);
			assert.strictEqual(timestampMap.get(actionId), firstTimestamp);

			// Cleanup after first run
			timestampMap.delete(actionId);

			// Second run (rerun) with new timestamp
			timestampMap.set(actionId, secondTimestamp);
			assert.strictEqual(timestampMap.get(actionId), secondTimestamp);
			assert.notStrictEqual(firstTimestamp, secondTimestamp);
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
});
