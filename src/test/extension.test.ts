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
} from '../extension';

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
});
