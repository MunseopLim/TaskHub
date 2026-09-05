import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import Ajv from 'ajv';
import { handleQuickPick } from '../extension';
import { expandArgTemplate, interpolatePipelineVariables } from '../pipelineUtils';
import type { ActionItem, Task } from '../schema';

suite('완성 JavaScript 실행 예제', () => {
    const root = path.resolve(__dirname, '..', '..');
    const actions = JSON.parse(fs.readFileSync(path.join(root, 'media/actions_example.json'), 'utf8')) as ActionItem[];
    const example = actions.find(item => item.id === 'action.run.script.with.params')!;
    const tasks = example.action!.tasks;
    const task = (id: string): Task => tasks.find(candidate => candidate.id === id)!;

    test('번들 예제는 스키마를 통과하고 Node로 실행할 JavaScript 파일만 안내한다', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(root, 'schema/actions.schema.json'), 'utf8'));
        const validate = new Ajv({ allErrors: true }).compile(schema);
        assert.ok(validate(actions), JSON.stringify(validate.errors));
        assert.strictEqual(task('run_script').command, 'node');
        assert.deepStrictEqual(Object.values(task('select_script').options!.filters!).flat(), ['js']);
    });

    for (const [label, expectedFlags] of [
        ['No extra options', []],
        ['Verbose', ['--verbose']],
        ['Verbose with flag', ['--verbose', '--flag']],
    ] as Array<[string, string[]]>) {
        test(`${label}: 경로 공백과 옵션별 argv를 실제 Node 실행에서도 유지한다`, async function () {
            this.timeout(10000);
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-example-'));
            const script = path.join(tempDir, 'sample script.js');
            fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
            const original = vscode.window.showQuickPick;
            (vscode.window as any).showQuickPick = async (items: any[]) => items.find(item => item.label === label);
            try {
                const options = await handleQuickPick(task('select_extra_options'), undefined, undefined, false);
                const values = {
                    select_script: { path: script },
                    select_environment: { value: 'development' },
                    input_port: { value: '3000' },
                    select_extra_options: options,
                };
                const run = task('run_script');
                const args = run.args!.flatMap(argument => expandArgTemplate(argument, values));
                const command = interpolatePipelineVariables(run.command as string, values);
                const received = JSON.parse(execFileSync(command, args, { encoding: 'utf8' }));
                assert.deepStrictEqual(received, ['--env', 'development', '--port', '3000', ...expectedFlags]);
            } finally {
                (vscode.window as any).showQuickPick = original;
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    }
});
