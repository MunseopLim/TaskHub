// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import Ajv from 'ajv';
import { ActionItem } from './schema';
import * as actionSchema from '../schema/actions.schema.json';

function loadAndValidateActions(filePath: string): ActionItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile<ActionItem[]>(actionSchema);
    let fileContent: string;
    try { fileContent = fs.readFileSync(filePath, 'utf-8'); } catch (e: any) { throw new Error(`Error reading file ${filePath}: ${e.message}`); }
    let parsedJson: any;
    try { parsedJson = JSON.parse(fileContent); } catch (e: any) { throw new Error(`Error parsing JSON in ${path.basename(filePath)}: ${e.message}`); }
    if (validate(parsedJson)) { return parsedJson; } else { const errors = validate.errors?.map(error => `  - path: '${error.instancePath}' - message: ${error.message}`).join('\n'); throw new Error(`Validation failed for ${path.basename(filePath)}:\n${errors}`); }
}

function interpolatePipelineVariables(template: string, context: any): string {
    if (typeof template !== 'string') { return template; }
    const regex = /\${([^}]+)}/g;
    return template.replace(regex, (match, expression) => {
        let foundValue: any;
        const parts = expression.split('.');
        const stepId = parts[0];
        const property = parts.slice(1).join('.');
        if (context[stepId] && property && context[stepId][property] !== undefined) { foundValue = context[stepId][property]; }
        else if (context[stepId] && context[stepId].output !== undefined) { foundValue = context[stepId].output; }
        else if (context[stepId] && context[stepId].outputDir !== undefined) { foundValue = context[stepId].outputDir; }
        else if (context[expression] !== undefined) { foundValue = context[expression]; }
        if (foundValue !== undefined) { return foundValue; }
        return match;
    });
}

function getCommandString(command: any): string {
    if (typeof command === 'string') { return command; }
    if (typeof command === 'object' && command !== null) {
        const platform = process.platform;
        if (platform === 'win32' && command.windows) { return command.windows; }
        else if (platform === 'darwin' && command.macos) { return command.macos; }
        else if (platform === 'linux' && command.linux) { return command.linux; }
        if (command.default) { return command.default; }
        if (command.command) { return command.command; }
    }
    throw new Error(`Invalid or unsupported 'command' property for the current platform (${process.platform})`);
}

class MainViewProvider implements vscode.TreeDataProvider<Action | Folder | vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Action | Folder | vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
  constructor(private context: vscode.ExtensionContext) {}
  refresh(): void { this._onDidChangeTreeData.fire(); }
  getTreeItem(element: Action | Folder | vscode.TreeItem): vscode.TreeItem { return element; }
  getChildren(element?: Action | Folder | vscode.TreeItem): Thenable<(Action | Folder | vscode.TreeItem)[]> {
    if (element) {
      if (element instanceof Folder) { return Promise.resolve(this.createActionItems(element.children)); }
      return Promise.resolve([]);
    } else {
        let actionsJson: ActionItem[] = [];
        try {
            const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'actions.json');
            actionsJson = actionsJson.concat(loadAndValidateActions(mediaJsonPath));
            const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'actions.json');
            actionsJson = actionsJson.concat(loadAndValidateActions(vscodeJsonPath));
        } catch (error: any) { vscode.window.showErrorMessage(error.message); }
      const packageJsonPath = path.join(this.context.extensionPath, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const versionItem = new vscode.TreeItem(`Version: ${packageJson.version}`);
      versionItem.iconPath = new vscode.ThemeIcon('info');
      versionItem.tooltip = `Extension Version: ${packageJson.version}`;
      versionItem.contextValue = 'versionItem';
      versionItem.command = { command: 'firmware-toolkit.showExampleJsonQuickPick', title: 'Show Example JSONs' };
      const items: (Action | Folder | vscode.TreeItem)[] = [versionItem, ...this.createActionItems(actionsJson)];
      return Promise.resolve(items);
    }
  }
  private createActionItems(items: ActionItem[]): (Action | Folder | vscode.TreeItem)[] {
    const actionItems: (Action | Folder | vscode.TreeItem)[] = [];
    items.forEach((item: ActionItem) => {
      if (item.type === 'folder') { actionItems.push(new Folder(item.title, item.children || [], this.context, item.id)); }
      else if (item.type === 'separator') { const separatorItem = new vscode.TreeItem(item.title); separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None; separatorItem.contextValue = 'separator'; actionItems.push(separatorItem); }
      else if (item.action) { actionItems.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None, this.context, item.id)); }
      else if (item.id) { console.warn(`Item '${item.title}' is not a valid folder, separator, or runnable action.`); const unknownItem = new vscode.TreeItem(item.title || 'Unknown Item'); unknownItem.tooltip = `Invalid item definition: ${item.id}`; actionItems.push(unknownItem); }
    });
    return actionItems;
  }
}
const actionStates = new Map<string, { state: 'running' | 'success' | 'failure' }>();
const activeTasks = new Map<string, vscode.TaskExecution>();
const outputChannel = vscode.window.createOutputChannel('Firmware Toolkit');
let toolkitTerminal: vscode.Terminal | undefined;
class Folder extends vscode.TreeItem {
  public children: any[];
  constructor(public readonly label: string, children: any[], private readonly context: vscode.ExtensionContext, public readonly id?: string) {
    const isExpanded = context.workspaceState.get<boolean>(`folderState:${id}`);
    super(label, isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.children = children; this.id = id; this.iconPath = new vscode.ThemeIcon('folder');
  }
}
class Action extends vscode.TreeItem {
  constructor(public readonly label: string, public readonly action: import('./schema').Action, public readonly collapsibleState: vscode.TreeItemCollapsibleState, public readonly context: vscode.ExtensionContext, public readonly id?: string) {
    super(label, collapsibleState);
    this.command = { command: 'firmware-toolkit.executeAction', title: 'Execute Action', arguments: [this] };
    const state = actionStates.get(this.id || '');
    if (state) {
      switch (state.state) {
        case 'running': this.iconPath = new vscode.ThemeIcon('sync~spin'); this.contextValue = 'runningAction'; break;
        case 'success': this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.blue')); this.contextValue = 'succeededAction'; break;
        case 'failure': this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')); this.contextValue = 'failedAction'; break;
      }
    } else {
        if (action && action.tasks) {
            if (action.tasks.length > 1) { this.iconPath = new vscode.ThemeIcon('debug-alt'); }
            else if (action.tasks.length === 1) {
                switch (action.tasks[0].type) {
                    case 'shell': case 'command': this.iconPath = new vscode.ThemeIcon('terminal'); break;
                    case 'fileDialog': case 'folderDialog': this.iconPath = new vscode.ThemeIcon('folder-opened'); break;
                    default: this.iconPath = new vscode.ThemeIcon('gear'); break;
                }
            } else { this.iconPath = new vscode.ThemeIcon('gear'); }
        } else { this.iconPath = new vscode.ThemeIcon('gear'); }
    }
  }
}
class LinkViewProvider implements vscode.TreeDataProvider<Link> {
  private _onDidChangeTreeData: vscode.EventEmitter<Link | undefined | null | void> = new vscode.EventEmitter<Link | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Link | undefined | null | void> = this._onDidChangeTreeData.event;
  public view: vscode.TreeView<Link> | undefined;
  constructor(private context: vscode.ExtensionContext) {}
  refresh(): void { this._onDidChangeTreeData.fire(); this.updateTitle(); }
  private updateTitle(): void { if (this.view) { this.view.title = `Link (${this.getLinks().length})`; } }
  private getLinks(): { title: string; link: string }[] {
    const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'links.json');
    let linksJson = [];
    if(fs.existsSync(mediaJsonPath)) { linksJson = JSON.parse(fs.readFileSync(mediaJsonPath, 'utf-8')); }
    const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'links.json');
    if (fs.existsSync(vscodeJsonPath)) { linksJson = linksJson.concat(JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'))); }
    return linksJson;
  }
  getTreeItem(element: Link): vscode.TreeItem { return element; }
  getChildren(element?: Link): Thenable<Link[]> {
    if (element) { return Promise.resolve([]); }
    else { const linksJson = this.getLinks(); this.updateTitle(); return Promise.resolve(linksJson.map((item: { title: string; link: string }) => new Link(item.title, item.link, vscode.TreeItemCollapsibleState.None))); }
  }
}
class Link extends vscode.TreeItem {
  constructor(public readonly label: string, private readonly link: string, public readonly collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}-${this.link}`; this.description = '';
    this.command = { command: 'firmware-toolkit.openLink', title: 'Open Link', arguments: [this.link] };
    this.contextValue = 'linkItem'; this.iconPath = new vscode.ThemeIcon('link');
  }
  getLink(): string { return this.link; }
}
class Favorite extends vscode.TreeItem {
  constructor(public readonly label: string, private readonly filePath: string, public readonly collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.tooltip = `${this.label} - ${this.filePath}`;
    this.command = { command: 'firmware-toolkit.openFavoriteFile', title: 'Open Favorite File', arguments: [this.filePath] };
    this.contextValue = 'favoriteItem'; this.iconPath = new vscode.ThemeIcon('star');
  }
  getFilePath(): string { return this.filePath; }
}
class FavoriteViewProvider implements vscode.TreeDataProvider<Favorite> {
  private _onDidChangeTreeData: vscode.EventEmitter<Favorite | undefined | null | void> = new vscode.EventEmitter<Favorite | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Favorite | undefined | null | void> = this._onDidChangeTreeData.event;
  public view: vscode.TreeView<Favorite> | undefined;
  constructor(private context: vscode.ExtensionContext) {}
  refresh(): void { this._onDidChangeTreeData.fire(); this.updateTitle(); }
  private updateTitle(): void { if (this.view) { this.view.title = `Favorite Files (${this.getFavorites().length})`; } }
  private getFavorites(): { title: string; path: string }[] {
    const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'favorites.json');
    let favoritesJson: { title: string; path: string }[] = [];
    if (fs.existsSync(vscodeJsonPath)) { try { favoritesJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8')); } catch (error: any) { vscode.window.showErrorMessage(`Error parsing .vscode/favorites.json: ${error.message}`); console.error(`Error parsing .vscode/favorites.json: ${error.message}`); } }
    return favoritesJson;
  }
  getTreeItem(element: Favorite): vscode.TreeItem { return element; }
  getChildren(element?: Favorite): Thenable<Favorite[]> {
    if (element) { return Promise.resolve([]); }
    else { const favoritesJson = this.getFavorites(); this.updateTitle(); return Promise.resolve(favoritesJson.map((item: { title: string; path: string }) => new Favorite(item.title, item.path, vscode.TreeItemCollapsibleState.None))); }
  }
}

async function executeAction(actionItem: ActionItem, context: vscode.ExtensionContext, mainViewProvider: MainViewProvider) {
    const showTaskStatus = vscode.workspace.getConfiguration('firmware-toolkit').get('showTaskStatus', true);
    const action = actionItem.action;
    const id = actionItem.id;
    if (!action || !action.tasks) { vscode.window.showErrorMessage(`Action '${actionItem.title}' has no tasks to run.`); return; }
    if (showTaskStatus) {
        const currentState = actionStates.get(id);
        if (currentState?.state === 'running') { vscode.window.showInformationMessage(`Action '${actionItem.title}' is already running.`); return; }
        actionStates.set(id, { state: 'running' });
        mainViewProvider.refresh();
    }
    const showVerboseLogs = vscode.workspace.getConfiguration('firmware-toolkit').get('pipeline.showVerboseLogs', false);
    if (showVerboseLogs) { outputChannel.show(true); }
    const stepResults: { [key: string]: any } = {};
    try {
        for (const task of action.tasks) {
            const result = await executeSingleTask(task, stepResults, context);
            stepResults[task.id] = result;
        }
        if (showTaskStatus) {
            actionStates.set(id, { state: 'success' });
            if (action.successMessage) { vscode.window.showInformationMessage(action.successMessage); }
        }
    } catch (error: any) {
        if (showTaskStatus) {
            actionStates.set(id, { state: 'failure' });
            if (action.failMessage) { vscode.window.showErrorMessage(`${action.failMessage}: ${error.message}`); } else { vscode.window.showErrorMessage(`Action '${actionItem.title}' failed: ${error.message}`); }
        }
        throw error;
    } finally {
        if (showTaskStatus) { mainViewProvider.refresh(); }
    }
}

async function executeSingleTask(task: import('./schema').Task, allResults: any, context: vscode.ExtensionContext): Promise<any> {
    const interpolationContext = { ...allResults, workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', extensionPath: context.extensionPath };
    let result: any;

    switch (task.type) {
        case 'fileDialog':
            result = await handleFileDialog(task);
            break;
        case 'folderDialog':
            result = await handleFolderDialog(task);
            break;
        case 'unzip':
            const interpolatedUnzipTask = { ...task, tool: JSON.parse(interpolatePipelineVariables(JSON.stringify(task.tool), interpolationContext)) };
            result = await handleUnzip(interpolatedUnzipTask, allResults);
            break;
        case 'stringManipulation':
            const interpolatedInput = interpolatePipelineVariables(task.input || '', interpolationContext);
            result = await handleStringManipulation({ ...task, input: interpolatedInput });
            break;
        case 'command':
        case 'shell':
            let command: string | undefined;
            if (typeof task.command === 'string') {
                command = interpolatePipelineVariables(task.command, interpolationContext);
            } else if (typeof task.command === 'object') {
                const interpolatedCmdObj = JSON.parse(JSON.stringify(task.command));
                for (const os in interpolatedCmdObj) {
                    if (Object.prototype.hasOwnProperty.call(interpolatedCmdObj, os)) {
                        interpolatedCmdObj[os] = interpolatePipelineVariables(interpolatedCmdObj[os], interpolationContext);
                    }
                }
                command = getCommandString(interpolatedCmdObj);
            }

            const args = task.args ? task.args.map(arg => interpolatePipelineVariables(arg, interpolationContext)) : [];
            const cwd = task.cwd ? interpolatePipelineVariables(task.cwd, interpolationContext) : undefined;

            if (!command) { throw new Error(`Task ${task.id} of type '${task.type}' requires a 'command' property.`); }
            
            const handlerTask = { ...task, command, args, cwd };

            if (task.passTheResultToNextTask) {
                result = await handleCommand(handlerTask, context);
            } else {
                await handleStreamedCommand(handlerTask);
                result = {};
            }
            break;
        default:
            throw new Error(`Unsupported task type: ${task.type}`);
    }

    if (task.passTheResultToNextTask && task.output) {
        const outputContent = task.output.content ? interpolatePipelineVariables(task.output.content, interpolationContext) : (typeof result?.output === 'string' ? result.output : JSON.stringify(result, null, 2));
        const interpolatedOutput = {
            ...task.output,
            filePath: task.output.filePath ? interpolatePipelineVariables(task.output.filePath, interpolationContext) : undefined,
            title: task.output.title ? interpolatePipelineVariables(task.output.title, interpolationContext) : undefined,
            content: outputContent
        };

        switch (interpolatedOutput.mode) {
            case 'editor':
                const doc = await vscode.workspace.openTextDocument({ content: interpolatedOutput.content, language: interpolatedOutput.language || 'plaintext' });
                await vscode.window.showTextDocument(doc, { preview: false });
                break;
            case 'file':
                if (!interpolatedOutput.filePath) { throw new Error(`Task '${task.id}' has output mode 'file' but 'filePath' is not defined.`); }
                const dir = path.dirname(interpolatedOutput.filePath);
                if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
                fs.writeFileSync(interpolatedOutput.filePath, interpolatedOutput.content);
                break;
            case 'terminal':
                 if (!toolkitTerminal || toolkitTerminal.exitStatus) { toolkitTerminal = vscode.window.createTerminal("Firmware Toolkit"); }
                toolkitTerminal.show();
                const header = `\n# ----- Output for task: ${task.id} ----- #\n`;
                toolkitTerminal.sendText(header);
                toolkitTerminal.sendText(interpolatedOutput.content, false);
                break;
        }
    }
    return result;
}

class TaskPty implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidClose: vscode.Event<number> = this.closeEmitter.event;

    private processEndEmitter = new vscode.EventEmitter<number>();
    public onDidProcessEnd: vscode.Event<number> = this.processEndEmitter.event;

    private process: import('child_process').ChildProcess | undefined;

    constructor(private command: string, private args: string[], private options: any) {}

    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        this.writeEmitter.fire(`> Executing: ${this.command} ${this.args.join(' ')}\r\n\r\n`);
        this.process = spawn(this.command, this.args, this.options);

        this.process.stdout?.on('data', (data) => {
            this.writeEmitter.fire(data.toString().replace(/\r?\n/g, '\r\n'));
        });
        this.process.stderr?.on('data', (data) => {
            this.writeEmitter.fire(data.toString().replace(/\r?\n/g, '\r\n'));
        });

        this.process.on('close', (code) => {
            const exitCode = code || 0;
            this.writeEmitter.fire(`\r\n> Task finished with exit code ${exitCode}\r\n`);
            this.processEndEmitter.fire(exitCode);
            this.closeEmitter.fire(exitCode);
        });

        this.process.on('error', (err) => {
            this.writeEmitter.fire(`\r\n> Task failed to start: ${err.message}\r\n`);
            this.processEndEmitter.fire(1);
            this.closeEmitter.fire(1);
        });
    }

    close(): void {
        if (this.process) {
            this.process.kill();
        }
        this.closeEmitter.fire(0);
    }
}

async function handleStreamedCommand(task: any): Promise<void> {
    const { args, cwd, id, isOneShot } = task;
    const command = getCommandString(task.command);
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const options = { cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', shell: true, env: env };
    const pty = new TaskPty(command, args || [], options);
    const terminal = vscode.window.createTerminal({ name: `Task - ${id}`, pty: pty });
    terminal.show();
    if (isOneShot) { return; }
    return new Promise<void>((resolve, reject) => {
        const disposable = pty.onDidProcessEnd(exitCode => {
            disposable.dispose();
            if (exitCode === 0) {
                resolve();
            } else {
                reject(new Error(`Task ${id} failed with exit code ${exitCode}.`));
            }
        });
    });
}

async function handleCommand(task: any, context: vscode.ExtensionContext): Promise<{ output: string }> {
    const { args, cwd } = task;
    const command = getCommandString(task.command);
    const commandOutput = await executeShellCommand(command, args || [], cwd);
    return { output: commandOutput.trim() };
}

async function handleFileDialog(task: any): Promise<{ path: string, dir: string, name: string, fileNameOnly: string, fileExt: string }> {
    const options: vscode.OpenDialogOptions = task.options || {};
    const fileUri = await vscode.window.showOpenDialog(options);
    if (fileUri && fileUri[0]) {
        const fullPath = fileUri[0].fsPath;
        const extension = path.extname(fullPath);
        return { path: fullPath, dir: path.dirname(fullPath), name: path.basename(fullPath), fileNameOnly: path.basename(fullPath, extension), fileExt: extension.startsWith('.') ? extension.substring(1) : extension };
    } else { throw new Error('File selection was canceled.'); }
}

async function handleFolderDialog(task: any): Promise<{ path: string, dir: string, name: string }> {
    const options: vscode.OpenDialogOptions = task.options || {};
    options.canSelectFiles = false; options.canSelectFolders = true;
    const folderUri = await vscode.window.showOpenDialog(options);
    if (folderUri && folderUri[0]) { return { path: folderUri[0].fsPath, dir: path.dirname(folderUri[0].fsPath), name: path.basename(folderUri[0].fsPath) }; }
    else { throw new Error('Folder selection was canceled.'); }
}

async function handleUnzip(task: any, allResults: any): Promise<{ outputDir: string }> {
    const inputs = task.inputs || {};
    const fileSourceStep = allResults[inputs.file];
    if (!fileSourceStep || !fileSourceStep.path) { throw new Error(`No file input found for unzip task from step '${inputs.file}'`); }
    let toolCommand: string | undefined;
    if (typeof task.tool === 'string') { toolCommand = task.tool; }
    else if (typeof task.tool === 'object') {
        const platform = process.platform;
        const toolPaths = task.tool || {};
        if (platform === 'win32' && toolPaths.windows) { toolCommand = toolPaths.windows; }
        else if (platform === 'darwin' && toolPaths.macos) { toolCommand = toolPaths.macos; }
        else if (platform === 'linux' && toolPaths.linux) { toolCommand = toolPaths.linux; }
    }
    if (!toolCommand) { throw new Error(`No unzip tool path specified for the current platform (${process.platform}) in actions.json`); }
    const filePath = fileSourceStep.path;
    const outputDir = fileSourceStep.dir;
    const args = ['x', filePath, `-o${outputDir}`, '-aoa'];
    try { await executeShellCommand(toolCommand, args); return { outputDir: outputDir }; }
    catch (error: any) { throw new Error(`Failed to unzip file: ${error.message}`); }
}

async function handleStringManipulation(task: any): Promise<{ output: string }> {
    const { function: func, input } = task;
    let output: string;
    switch (func) {
        case 'stripExtension': output = input.replace(/\.(7z|zip)$/, ''); break;
        default: throw new Error(`Unsupported string manipulation function: ${func}`);
    }
    return { output: output };
}

function executeShellCommand(command: string, args: string[], cwd?: string): Promise<string> {
    const showVerboseLogs = vscode.workspace.getConfiguration('firmware-toolkit').get('pipeline.showVerboseLogs', false);
    return new Promise((resolve, reject) => {
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        const options = { cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', shell: true, env: env };
        if (showVerboseLogs) { outputChannel.appendLine(`[INFO] Executing command: ${command} ${args.join(' ')} in ${options.cwd}`); }
        const childProcess = spawn(command, args, options);
        let stdout = ''; let stderr = '';
        childProcess.stdout?.setEncoding('utf8');
        childProcess.stderr?.setEncoding('utf8');
        childProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
        childProcess.stderr?.on('data', (data) => { stderr += data.toString(); });
        childProcess.on('close', (code) => {
            if (showVerboseLogs) { outputChannel.appendLine(`[INFO] STDOUT: ${stdout}`); outputChannel.appendLine(`[INFO] STDERR: ${stderr}`); outputChannel.appendLine(`[INFO] Command finished with exit code ${code}.`); }
            if (code === 0) { resolve(stdout); } else { reject(new Error(stderr || `Command failed with exit code ${code}`)); }
        });
        childProcess.on('error', (err) => { if (showVerboseLogs) { outputChannel.appendLine(`[ERROR] Failed to start command: ${err.message}`); } reject(err); });
    });
}

export function activate(context: vscode.ExtensionContext) {
	vscode.window.onDidCloseTerminal(terminal => { if (toolkitTerminal && terminal.name === toolkitTerminal.name) { toolkitTerminal = undefined; } });
    const taskProcessIds = new Map<number, boolean>();
    const taskNameToProcessId = new Map<string, number>();
    const manuallyTerminatedTasks = new Set<string>();
    context.subscriptions.push(vscode.tasks.onDidStartTaskProcess(e => { if (e.execution.task.source === 'firmware-toolkit') { if (e.processId) { taskProcessIds.set(e.processId, true); taskNameToProcessId.set(e.execution.task.name, e.processId); } } }));
    context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => { if (e.execution.task.source === 'firmware-toolkit') { const processId = taskNameToProcessId.get(e.execution.task.name); if (processId) { taskNameToProcessId.delete(e.execution.task.name); } } }));
    const mainViewProvider = new MainViewProvider(context);
    const linkViewProvider = new LinkViewProvider(context);
    const favoriteViewProvider = new FavoriteViewProvider(context);
    const mainView = vscode.window.createTreeView('mainView.main', { treeDataProvider: mainViewProvider });
    context.subscriptions.push(mainView);
    mainView.onDidExpandElement(async e => { if (e.element instanceof Folder && e.element.id) { await context.workspaceState.update(`folderState:${e.element.id}`, true); } });
    mainView.onDidCollapseElement(async e => { if (e.element instanceof Folder && e.element.id) { await context.workspaceState.update(`folderState:${e.element.id}`, false); } });
    linkViewProvider.view = vscode.window.createTreeView('mainView.link', { treeDataProvider: linkViewProvider });
    favoriteViewProvider.view = vscode.window.createTreeView('mainView.favorite', { treeDataProvider: favoriteViewProvider });
    context.subscriptions.push(linkViewProvider.view, favoriteViewProvider.view);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const mediaActionsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionPath, 'media/actions.json'));
    mediaActionsWatcher.onDidChange(() => mainViewProvider.refresh());
    mediaActionsWatcher.onDidCreate(() => mainViewProvider.refresh());
    mediaActionsWatcher.onDidDelete(() => mainViewProvider.refresh());
    context.subscriptions.push(mediaActionsWatcher);
    const mediaLinksWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionPath, 'media/links.json'));
    mediaLinksWatcher.onDidChange(() => linkViewProvider.refresh());
    mediaLinksWatcher.onDidCreate(() => linkViewProvider.refresh());
    mediaLinksWatcher.onDidDelete(() => linkViewProvider.refresh());
    context.subscriptions.push(mediaLinksWatcher);
    if (workspaceRoot) {
        const vscodeActionsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.vscode/actions.json'));
        vscodeActionsWatcher.onDidChange(() => mainViewProvider.refresh());
        vscodeActionsWatcher.onDidCreate(() => mainViewProvider.refresh());
        vscodeActionsWatcher.onDidDelete(() => mainViewProvider.refresh());
        context.subscriptions.push(vscodeActionsWatcher);
        const vscodeLinksWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.vscode/links.json'));
        vscodeLinksWatcher.onDidChange(() => linkViewProvider.refresh());
        vscodeLinksWatcher.onDidCreate(() => linkViewProvider.refresh());
        vscodeLinksWatcher.onDidDelete(() => linkViewProvider.refresh());
        context.subscriptions.push(vscodeLinksWatcher);
        const vscodeFavoritesWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.vscode/favorites.json'));
        vscodeFavoritesWatcher.onDidChange(() => favoriteViewProvider.refresh());
        vscodeFavoritesWatcher.onDidCreate(() => favoriteViewProvider.refresh());
        vscodeFavoritesWatcher.onDidDelete(() => favoriteViewProvider.refresh());
        context.subscriptions.push(vscodeFavoritesWatcher);
    }
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.openFavoriteFile', async (filePath: string) => { try { const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : ''; const resolvedPath = filePath.replace('${workspaceFolder}', workspaceFolder); const uri = vscode.Uri.file(resolvedPath); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri)); } catch (error: any) { vscode.window.showErrorMessage(`Could not open file: ${error.message}`); } }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.openLink', (url: string) => { vscode.env.openExternal(vscode.Uri.parse(url)); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.copyLink', (item: Link) => { vscode.env.clipboard.writeText(item.getLink()); vscode.window.showInformationMessage('Link copied to clipboard.'); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.goToLink', (item: Link) => { vscode.env.openExternal(vscode.Uri.parse(item.getLink())); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.executeAction', async (actionItem: Action) => { let allActions: ActionItem[] = []; try { const mediaJsonPath = path.join(context.extensionPath, 'media', 'actions.json'); allActions = allActions.concat(loadAndValidateActions(mediaJsonPath)); const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'actions.json'); allActions = allActions.concat(loadAndValidateActions(vscodeJsonPath)); } catch (error: any) { console.error(error.message); vscode.window.showErrorMessage(`Could not execute action: Failed to load or validate actions.json.`); return; } function findAction(actions: ActionItem[], id: string): ActionItem | undefined { for (const action of actions) { if (action.id === id) { return action; } if (action.children) { const found = findAction(action.children, id); if (found) { return found; } } } return undefined; } const actionId = actionItem.id; if (!actionId) { return; } const fullActionItem = findAction(allActions, actionId); if (fullActionItem) { try { await executeAction(fullActionItem, context, mainViewProvider); } catch (error) { console.error(`Execution failed for action '${actionId}':`, error); } } else { vscode.window.showErrorMessage(`Could not find action definition for ID '${actionId}'.`); } }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.executeActionById', async (args: { id: string }) => { if (!args || !args.id) { vscode.window.showErrorMessage('Action ID is required for this command.'); return; } let allActions: ActionItem[] = []; try { const mediaJsonPath = path.join(context.extensionPath, 'media', 'actions.json'); allActions = allActions.concat(loadAndValidateActions(mediaJsonPath)); const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'actions.json'); allActions = allActions.concat(loadAndValidateActions(vscodeJsonPath)); } catch (error: any) { console.error(error.message); vscode.window.showErrorMessage(`Could not execute action by ID: Failed to load or validate actions.json. Check the Output panel for details.`); return; } function findAction(actions: ActionItem[], id: string): ActionItem | undefined { for (const action of actions) { if (action.id === id) { return action; } if (action.children) { const found = findAction(action.children, id); if (found) { return found; } } } return undefined; } const actionItem = findAction(allActions, args.id); if (actionItem && actionItem.action) { await executeAction(actionItem, context, mainViewProvider); } else { vscode.window.showErrorMessage(`Action with ID '${args.id}' not found or it has no 'action' property.`); } }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.stopAction', (actionItem: Action) => { const id = actionItem.id || actionItem.label; const task = activeTasks.get(id); if (task) { manuallyTerminatedTasks.add(id); task.terminate(); actionStates.delete(id); mainViewProvider.refresh(); vscode.window.showInformationMessage(`Action '${actionItem.label}' terminated.`); } else { vscode.window.showWarningMessage(`Could not find active task for '${actionItem.label}'.`); } }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.showVersion', () => { const packageJson = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf-8')); vscode.window.showInformationMessage(`Firmware Toolkit Version: ${packageJson.version}`); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.showFilePicker', async (action: any) => { /* Obsolete */ }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.editFavorites', async () => { const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; const filePath = path.join(wsPath, '.vscode', 'favorites.json'); if (!fs.existsSync(path.dirname(filePath))) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, JSON.stringify([], null, 2)); } await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.editLinks', async () => { const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; const filePath = path.join(wsPath, '.vscode', 'links.json'); if (!fs.existsSync(path.dirname(filePath))) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, JSON.stringify([], null, 2)); } await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.editActions', async () => { const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; const filePath = path.join(wsPath, '.vscode', 'actions.json'); if (!fs.existsSync(path.dirname(filePath))) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } if (!fs.existsSync(filePath)) { fs.writeFileSync(filePath, JSON.stringify([], null, 2)); } await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.addFavoriteFile', async (uri?: vscode.Uri) => {
        let fileUris: vscode.Uri[] | undefined;
        if (uri) {
            fileUris = [uri];
        } else {
            fileUris = await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: 'Add to Favorites',
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
            });
        }

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const favoritesPath = path.join(wsPath, '.vscode', 'favorites.json');
        let favorites: { title: string; path: string }[] = [];
        if (fs.existsSync(favoritesPath)) {
            try {
                favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8'));
            } catch (e) {
                vscode.window.showErrorMessage('Error parsing favorites.json');
                return;
            }
        }

        for (const fileUri of fileUris) {
            const title = await vscode.window.showInputBox({ 
                prompt: `Enter a title for ${path.basename(fileUri.fsPath)}`,
                value: path.basename(fileUri.fsPath)
            });
            if (!title) {
                continue;
            }
            favorites.push({ title, path: fileUri.fsPath });
        }

        fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
        favoriteViewProvider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.deleteFavorite', async (item: Favorite) => { const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.label}?`, { modal: true }, 'Yes'); if (confirm !== 'Yes') { return; } const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; const favoritesPath = path.join(wsPath, '.vscode', 'favorites.json'); if (!fs.existsSync(favoritesPath)) { return; } let favorites: { title: string; path: string }[] = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8')); favorites = favorites.filter(f => f.path !== item.getFilePath()); fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2)); favoriteViewProvider.refresh(); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.deleteLink', async (item: Link) => { const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.label}?`, { modal: true }, 'Yes'); if (confirm !== 'Yes') { return; } const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; const vscodeLinksPath = path.join(wsPath, '.vscode', 'links.json'); if (fs.existsSync(vscodeLinksPath)) { let links: { title: string; link: string }[] = JSON.parse(fs.readFileSync(vscodeLinksPath, 'utf-8')); const initialLength = links.length; links = links.filter(l => l.link !== item.getLink()); if (links.length !== initialLength) { fs.writeFileSync(vscodeLinksPath, JSON.stringify(links, null, 2)); linkViewProvider.refresh(); return; } } }));
      const showExampleJsonCommand = vscode.commands.registerCommand('firmware-toolkit.showExampleJson', async (jsonType: string) => {
    let exampleContent = '';
    let fileName = '';

    try {
      switch (jsonType) {
        case 'actions':
          fileName = 'actions_example.json';
          const actionsExamplePath = path.join(context.extensionPath, 'media', 'actions_example.json');
          exampleContent = fs.readFileSync(actionsExamplePath, 'utf-8');
          break;
        case 'links':
          fileName = 'links_example.json';
          const linksExamplePath = path.join(context.extensionPath, 'media', 'links_example.json');
          exampleContent = fs.readFileSync(linksExamplePath, 'utf-8');
          break;
        case 'favorites':
          fileName = 'favorites_example.json';
          const favoritesExamplePath = path.join(context.extensionPath, 'media', 'favorites_example.json');
          exampleContent = fs.readFileSync(favoritesExamplePath, 'utf-8');
          break;
        default:
          vscode.window.showErrorMessage(`Unknown JSON type: ${jsonType}`);
          return;
      }

      const document = await vscode.workspace.openTextDocument({
        content: exampleContent,
        language: 'jsonc' // Use jsonc for comments in examples
      });
      await vscode.window.showTextDocument(document, { preview: true });
      vscode.window.showInformationMessage(`Example ${fileName} opened.`);

    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open example ${fileName}: ${error.message}`);
    }
  });
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.showExampleJsonQuickPick', async () => { const pick = await vscode.window.showQuickPick([ { label: 'actions.json Example', description: 'Show example content for actions.json', type: 'actions' }, { label: 'links.json Example', description: 'Show example content for links.json', type: 'links' }, { label: 'favorites.json Example', description: 'Show example content for favorites.json', type: 'favorites' }, ], { placeHolder: 'Select which example JSON to display' }); if (pick) { vscode.commands.executeCommand('firmware-toolkit.showExampleJson', pick.type); } }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.addOpenFileToFavorites', async () => { const editor = vscode.window.activeTextEditor; if (!editor) { vscode.window.showInformationMessage('No active editor found.'); return; } const filePath = editor.document.uri.fsPath; const title = await vscode.window.showInputBox({ prompt: `Enter a title for ${path.basename(filePath)}`, value: path.basename(filePath) }); if (!title) { return; } const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; const favoritesPath = path.join(wsPath, '.vscode', 'favorites.json'); let favorites: { title: string; path: string }[] = []; if (fs.existsSync(favoritesPath)) { try { favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8')); } catch (e) { vscode.window.showErrorMessage('Error parsing favorites.json'); return; } } favorites.push({ title, path: filePath }); fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2)); favoriteViewProvider.refresh(); }));
    context.subscriptions.push(vscode.commands.registerCommand('firmware-toolkit.terminateAllTasks', async () => { vscode.tasks.taskExecutions.filter(t => t.task.source === 'firmware-toolkit').forEach(t => t.terminate()); actionStates.clear(); activeTasks.clear(); mainViewProvider.refresh(); vscode.window.showInformationMessage('All active tasks from Firmware Toolkit have been terminated.'); }));
}

export function deactivate() {}