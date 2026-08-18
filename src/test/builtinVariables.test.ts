import * as assert from 'assert';
import * as path from 'path';
import {
    buildBuiltinVariableContext,
    lookupEnvironmentVariable,
    PIPELINE_STRICT_BUILTINS,
    redactSensitiveBuiltinVariables,
} from '../builtinVariables';

suite('builtinVariables', () => {
    test('활성 파일에서 VS Code 스타일 경로·커서 변수를 한 번에 만든다', () => {
        const workspace = path.resolve('/workspace');
        const file = path.join(workspace, 'src', 'hello.test.ts');
        const context = buildBuiltinVariableContext({
            workspaceFolder: workspace,
            extensionPath: '/extension',
            editor: {
                file,
                fileWorkspaceFolder: workspace,
                selectedText: 'picked',
                lineNumber: 12,
                columnNumber: 4,
            },
            clipboard: 'copied',
            environment: { TASKHUB_TEST_ENV: 'env-value' },
            strict: true,
        });

        assert.strictEqual(context.file, file);
        assert.strictEqual(context.relativeFile, path.join('src', 'hello.test.ts'));
        assert.strictEqual(context.relativeFileDirname, 'src');
        assert.strictEqual(context.fileBasename, 'hello.test.ts');
        assert.strictEqual(context.fileBasenameNoExtension, 'hello.test');
        assert.strictEqual(context.fileExtname, '.ts');
        assert.strictEqual(context.fileDirname, path.join(workspace, 'src'));
        assert.strictEqual(context.fileWorkspaceFolder, workspace);
        assert.strictEqual(context.selectedText, 'picked');
        assert.strictEqual(context.lineNumber, 12);
        assert.strictEqual(context.columnNumber, 4);
        assert.strictEqual(context.clipboard, 'copied');
        assert.strictEqual(lookupEnvironmentVariable(context, 'TASKHUB_TEST_ENV'), 'env-value');
        assert.strictEqual(context[PIPELINE_STRICT_BUILTINS], true);
    });

    test('활성 파일이 없어도 예약 키를 own property로 유지한다', () => {
        const context = buildBuiltinVariableContext({
            workspaceFolder: '/workspace',
            extensionPath: '/extension',
            environment: {},
        });
        assert.ok(Object.prototype.hasOwnProperty.call(context, 'file'));
        assert.strictEqual(context.file, undefined);
        assert.ok(Object.prototype.hasOwnProperty.call(context, 'selectedText'));
    });

    test('워크스페이스 밖 활성 파일에는 가짜 workspace-relative 값을 만들지 않는다', () => {
        const context = buildBuiltinVariableContext({
            workspaceFolder: '/workspace',
            extensionPath: '/extension',
            editor: { file: '/outside/active.txt' },
            environment: {},
            strict: true,
        });
        assert.strictEqual(context.file, path.resolve('/outside/active.txt'));
        assert.strictEqual(context.fileWorkspaceFolder, undefined);
        assert.strictEqual(context.relativeFile, undefined);
        assert.strictEqual(context.relativeFileDirname, undefined);
        assert.strictEqual(context.fileBasename, 'active.txt');
    });

    test('기록용 사본은 파일 경로는 보존하고 환경·선택·클립보드는 가린다', () => {
        const context = buildBuiltinVariableContext({
            workspaceFolder: '/workspace',
            extensionPath: '/extension',
            editor: { file: '/workspace/a.txt', selectedText: 'secret selection' },
            clipboard: 'secret clipboard',
            environment: { TOKEN: 'secret token', PATH: '/bin' },
        });
        const redacted = redactSensitiveBuiltinVariables(context, '***');

        assert.notStrictEqual(redacted, context);
        assert.strictEqual(redacted.file, path.resolve('/workspace/a.txt'));
        assert.strictEqual(redacted.selectedText, '***');
        assert.strictEqual(redacted.clipboard, '***');
        assert.strictEqual(lookupEnvironmentVariable(redacted, 'TOKEN'), '***');
        assert.strictEqual(lookupEnvironmentVariable(redacted, 'PATH'), '***');
        // 실행 문맥 원본은 건드리지 않는다.
        assert.strictEqual(lookupEnvironmentVariable(context, 'TOKEN'), 'secret token');
    });

    test('기록용 마스킹이 동명 task 결과를 덮지 않는다', () => {
        const builtin = buildBuiltinVariableContext({
            workspaceFolder: '/workspace',
            extensionPath: '/extension',
            editor: { selectedText: 'secret selection' },
            clipboard: 'secret clipboard',
            environment: {},
        });
        const context = Object.assign(Object.create(null), builtin, {
            selectedText: { value: 'task selection' },
            clipboard: { value: 'task clipboard' },
        });

        const redacted = redactSensitiveBuiltinVariables(context, '***');
        assert.deepStrictEqual(redacted.selectedText, { value: 'task selection' });
        assert.deepStrictEqual(redacted.clipboard, { value: 'task clipboard' });
    });
});
