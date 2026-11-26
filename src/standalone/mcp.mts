import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import type { Workspace } from './core.js';
import { parseInputs } from './inputs.js';
import { TaskHubError } from './errors.js';
import { t } from './language.js';

const id = { type: 'string', minLength: 1 };
const input = { type: 'object', additionalProperties: { anyOf: [
    { type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } },
] } };
function tool(name: string, description: string, properties: Record<string, object> = {}, required: string[] = []): Tool {
    return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const tools = [
    tool('list_actions', t('워크스페이스 액션을 나열합니다.', 'List workspace actions.')),
    tool('validate_action', t('액션의 설정과 실행 가능 여부를 확인합니다.', 'Validate an action and its standalone execution requirements.'), { actionId: id }, ['actionId']),
    tool('preview_action', t('액션을 미리 봅니다.', 'Preview an action without executing it.'), { actionId: id }, ['actionId']),
    tool('run_action', t('시작 시 신뢰한 워크스페이스에서 액션을 실행합니다.', 'Run a named action in the workspace trusted at launch.'), { actionId: id, inputs: input }, ['actionId']),
    tool('list_run_history', t('저장된 실행 이력을 봅니다.', 'List retained workspace runs.')),
    tool('get_run_log', t('실행 ID로 로그를 조회합니다.', 'Read the log for a run ID.'), { runId: id }, ['runId']),
];
const ajv = new Ajv();
const validators = new Map(tools.map(spec => [spec.name, ajv.compile(spec.inputSchema)]));

export async function serve(workspace: Workspace, signal: AbortSignal, version: string): Promise<void> {
    const server = new Server({ name: 'taskhub', version }, { capabilities: { tools: {} } });
    let initialized = false;
    server.oninitialized = () => { initialized = !!server.getClientVersion(); };
    const ready = () => {
        if (!initialized) { throw new McpError(ErrorCode.InvalidRequest, 'MCP initialization required.'); }
    };
    server.setRequestHandler(ListToolsRequestSchema, () => { ready(); return { tools }; });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        ready();
        const { name, arguments: args = {} } = request.params;
        const validate = validators.get(name);
        if (!validate) { throw new McpError(ErrorCode.InvalidParams, 'Unknown tool.'); }
        if (!validate(args)) { throw new McpError(ErrorCode.InvalidParams, 'Invalid tool arguments. See tools/list.'); }
        let data;
        let isError = false;
        try {
            const actionId = args.actionId as string;
            switch (name) {
                case 'list_actions': data = { actions: workspace.list() }; break;
                case 'validate_action': data = workspace.validate(actionId); isError = !data.valid; break;
                case 'preview_action': data = workspace.preview(actionId); break;
                case 'run_action':
                    data = await workspace.run(actionId, parseInputs(args.inputs ?? {}), extra.signal);
                    isError = data.exitCode !== 0;
                    break;
                case 'list_run_history': data = { runs: await workspace.history() }; break;
                case 'get_run_log': data = await workspace.log(args.runId as string); break;
            }
        } catch (error) {
            isError = true;
            data = { exitCode: error instanceof TaskHubError ? error.exitCode : 1,
                error: error instanceof TaskHubError ? error.message : t('요청 처리 실패', 'Request failed') };
        }
        return { content: [{ type: 'text', text: JSON.stringify(data) }], isError };
    });
    const transport = new StdioServerTransport();
    const closed = new Promise<void>(resolve => { server.onclose = resolve; });
    const close = () => { void server.close(); };
    await server.connect(transport);
    process.stdin.once('end', close);
    process.stdout.once('error', close);
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted || process.stdin.readableEnded) { close(); }
    try { await closed; }
    finally {
        process.stdin.off('end', close);
        process.stdout.off('error', close);
        signal.removeEventListener('abort', close);
    }
}
