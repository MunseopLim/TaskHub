// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

class MainViewProvider implements vscode.TreeDataProvider<Action | Folder | vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<Action | Folder | vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Action | Folder | vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Action | Folder | vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Action | Folder | vscode.TreeItem): Thenable<(Action | Folder | vscode.TreeItem)[]> {
    if (element) {
      if (element instanceof Folder) {
        return Promise.resolve(this.createActionItems(element.children));
      }
      return Promise.resolve([]);
    } else {
      const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'actions.json');
      let actionsJson = JSON.parse(fs.readFileSync(mediaJsonPath, 'utf-8'));

      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'actions.json');

      if (fs.existsSync(vscodeJsonPath)) {
        const vscodeActionsJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'));
        actionsJson = actionsJson.concat(vscodeActionsJson);
      }

      const packageJsonPath = path.join(this.context.extensionPath, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const extensionVersion = packageJson.version;

      const versionItem = new vscode.TreeItem(`Version: ${extensionVersion}`);
      versionItem.iconPath = new vscode.ThemeIcon('info'); // Use an info icon
      versionItem.tooltip = `Extension Version: ${extensionVersion}`;
      versionItem.contextValue = 'versionItem'; // Add contextValue for right-click menu
      versionItem.command = {
        command: 'firmware-toolkit.showExampleJsonQuickPick', // New command to show quick pick
        title: 'Show Example JSONs',
      };

      const items: (Action | Folder | vscode.TreeItem)[] = [];
      items.push(versionItem); // Add version item at the top

      items.push(...this.createActionItems(actionsJson));

      return Promise.resolve(items);
    }
  }

  private createActionItems(items: any[]): (Action | Folder | vscode.TreeItem)[] {
    const actionItems: (Action | Folder | vscode.TreeItem)[] = [];
    items.forEach((item: any) => {
      if (item.type === 'folder') {
        actionItems.push(new Folder(item.title, item.children, this.context, item.id));
      } else if (item.type === 'separator') {
          const separatorItem = new vscode.TreeItem(item.title);
          separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
          separatorItem.contextValue = 'separator'; // Custom context value for styling/menus if needed
          actionItems.push(separatorItem);
        } else if (item.id && item.id.startsWith('button.')) {
          if (item.action && item.action.type === 'executablePicker') {
            const executablePickerItem = new vscode.TreeItem(item.title);
            executablePickerItem.command = {
              command: 'firmware-toolkit.showExecutablePicker',
              title: 'Select and Run Executable',
              arguments: [item.action], // Pass the action object
            };
            executablePickerItem.contextValue = 'executablePicker';
            actionItems.push(executablePickerItem);
          } else {
            actionItems.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None, this.context, item.id));
          }
        } else {
          // Handle unknown types or IDs, e.g., log a warning or create a generic item
          console.warn(`Unknown item type or ID in actions.json: ${item.id || item.type}`);
          const unknownItem = new vscode.TreeItem(item.title || 'Unknown Item');
          unknownItem.tooltip = `Unknown item type or ID: ${item.id || item.type}`;
          actionItems.push(unknownItem);
        }
      });
    return actionItems;
  }
}

const actionStates = new Map<string, { state: 'running' | 'success' | 'failure' }>();
const activeTasks = new Map<string, vscode.TaskExecution>();
const outputChannel = vscode.window.createOutputChannel('Firmware Toolkit');

class Folder extends vscode.TreeItem {
  public children: any[];

  constructor(
    public readonly label: string,
    children: any[],
    private readonly context: vscode.ExtensionContext,
    public readonly id?: string
  ) {
    const isExpanded = context.workspaceState.get<boolean>(`folderState:${id}`);
    super(label, isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.children = children;
    this.id = id;
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

class Action extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    private readonly actionData: any,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly context: vscode.ExtensionContext,
    public readonly id?: string
  ) {
    super(label, collapsibleState);
    this.command = {
      command: 'firmware-toolkit.executeAction',
      title: 'Execute Action',
      arguments: [this],
    };

    const state = actionStates.get(this.id || '');
    if (state) {
      switch (state.state) {
        case 'running':
          this.iconPath = new vscode.ThemeIcon('sync~spin');
          this.contextValue = 'runningAction';
          break;
        case 'success':
          this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.blue'));
          this.contextValue = 'succeededAction';
          break;
        case 'failure':
          this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
          this.contextValue = 'failedAction';
          break;
      }
    } else {
      if (actionData && actionData.type) {
        switch (actionData.type) {
          case 'shell':
            this.iconPath = new vscode.ThemeIcon('terminal');
            break;
          case 'executablePicker':
            this.iconPath = new vscode.ThemeIcon('play');
            break;
          case 'pipeline':
            this.iconPath = new vscode.ThemeIcon('debug-alt');
            break;
          default:
            this.iconPath = new vscode.ThemeIcon('gear');
            break;
        }
      } else {
        this.iconPath = new vscode.ThemeIcon('gear');
      }
    }
  }

  public getActionData() {
    return this.actionData;
  }
}

class LinkViewProvider implements vscode.TreeDataProvider<Link> {
  private _onDidChangeTreeData: vscode.EventEmitter<Link | undefined | null | void> = new vscode.EventEmitter<Link | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Link | undefined | null | void> = this._onDidChangeTreeData.event;
  public view: vscode.TreeView<Link> | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
    this.updateTitle();
  }

  private updateTitle(): void {
    if (this.view) {
      const links = this.getLinks();
      this.view.title = `Link (${links.length})`;
    }
  }

  private getLinks(): { title: string; link: string }[] {
    const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'links.json');
    let linksJson = JSON.parse(fs.readFileSync(mediaJsonPath, 'utf-8'));

    const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'links.json');

    if (fs.existsSync(vscodeJsonPath)) {
      const vscodeLinksJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'));
      linksJson = linksJson.concat(vscodeLinksJson);
    }
    return linksJson;
  }

  getTreeItem(element: Link): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Link): Thenable<Link[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      const linksJson = this.getLinks();
      this.updateTitle();

      return Promise.resolve(
        linksJson.map(
          (item: { title: string; link: string }) =>
            new Link(item.title, item.link, vscode.TreeItemCollapsibleState.None)
        )
      );
    }
  }
}

class Link extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    private readonly link: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}-${this.link}`;
    this.description = '';
    this.command = {
      command: 'firmware-toolkit.openLink',
      title: 'Open Link',
      arguments: [this.link],
    };
    this.contextValue = 'linkItem';
    this.iconPath = new vscode.ThemeIcon('link');
  }

  getLink(): string {
    return this.link;
  }
}

class Favorite extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    private readonly filePath: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label} - ${this.filePath}`;
    this.command = {
      command: 'firmware-toolkit.openFavoriteFile',
      title: 'Open Favorite File',
      arguments: [this.filePath],
    };
    this.contextValue = 'favoriteItem';
    this.iconPath = new vscode.ThemeIcon('star'); // Using a star icon for favorite
  }

  getFilePath(): string {
    return this.filePath;
  }
}

class FavoriteViewProvider implements vscode.TreeDataProvider<Favorite> {
  private _onDidChangeTreeData: vscode.EventEmitter<Favorite | undefined | null | void> = new vscode.EventEmitter<Favorite | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Favorite | undefined | null | void> = this._onDidChangeTreeData.event;
  public view: vscode.TreeView<Favorite> | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
    this.updateTitle();
  }

  private updateTitle(): void {
    if (this.view) {
      const favorites = this.getFavorites();
      this.view.title = `Favorite Files (${favorites.length})`;
    }
  }

  private getFavorites(): { title: string; path: string }[] {
    const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'favorites.json');
    let favoritesJson: { title: string; path: string }[] = [];

    if (fs.existsSync(vscodeJsonPath)) {
      try {
        favoritesJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'));
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error parsing .vscode/favorites.json: ${error.message}`);
        console.error(`Error parsing .vscode/favorites.json: ${error.message}`);
      }
    }
    return favoritesJson;
  }

  getTreeItem(element: Favorite): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Favorite): Thenable<Favorite[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      const favoritesJson = this.getFavorites();
      this.updateTitle();

      return Promise.resolve(
        favoritesJson.map(
          (item: { title: string; path: string }) =>
            new Favorite(item.title, item.path, vscode.TreeItemCollapsibleState.None)
        )
      );
    }
  }
}

async function handleStringManipulationStep(step: any, allResults: any): Promise<{ output: string }> {
    const { function: func, input } = step;
    const interpolationContext = { ...allResults };
    const interpolatedInput = interpolatePipelineVariables(input, interpolationContext);

    let output: string;

    switch (func) {
        case 'stripExtension':
            output = interpolatedInput.replace(/\.(7z|zip)$/, '');
            break;
        default:
            throw new Error(`Unsupported string manipulation function: ${func}`);
    }

    return { output: output };
}

async function handlePipelineAction(action: any, context: vscode.ExtensionContext) {
    outputChannel.show(true);
    const { steps, successMessage, failMessage } = action;
    const stepResults: { [key: string]: any } = {};

    try {
        for (const step of steps) {
            let result: any;
            switch (step.type) {
                case 'fileDialog':
                    result = await handleFileDialogStep(step);
                    break;
                case 'unzip':
                    result = await handleUnzipStep(step, stepResults);
                    break;
                case 'command':
                    result = await handleCommandStep(step, stepResults, context);
                    break;
                case 'stringManipulation':
                    result = await handleStringManipulationStep(step, stepResults);
                    break;
                default:
                    throw new Error(`Unsupported pipeline step type: ${step.type}`);
            }
            stepResults[step.id] = result;
        }
        vscode.window.showInformationMessage(successMessage || 'Pipeline completed successfully!');
    } catch (error: any) {
        vscode.window.showErrorMessage(`${failMessage || 'Pipeline failed:'} ${error.message}`);
        throw error;
    }
}

async function handleFileDialogStep(step: any): Promise<{ path: string, dir: string, name: string }> {
    const options: vscode.OpenDialogOptions = step.options || {};
    const fileUri = await vscode.window.showOpenDialog(options);
    if (fileUri && fileUri[0]) {
        return { path: fileUri[0].fsPath, dir: path.dirname(fileUri[0].fsPath), name: path.basename(fileUri[0].fsPath) };
    } else {
        throw new Error('File selection was canceled.');
    }
}

async function handleUnzipStep(step: any, allResults: any): Promise<{ outputDir: string }> {
    const inputs = step.inputs || {};
    const fileSourceStep = allResults[inputs.file];
    if (!fileSourceStep || !fileSourceStep.path) {
        throw new Error(`No file input found for unzip step from step '${inputs.file}'`);
    }

    const platform = process.platform;
    const toolPaths = step.tool || {};
    let toolCommand: string | undefined;

    if (platform === 'win32' && toolPaths.windows) {
        toolCommand = toolPaths.windows;
    } else if (platform === 'darwin' && toolPaths.macos) {
        toolCommand = toolPaths.macos;
    } else if (platform === 'linux' && toolPaths.linux) {
        toolCommand = toolPaths.linux;
    }

    if (!toolCommand) {
        throw new Error(`No unzip tool path specified for the current platform (${platform}) in actions.json`);
    }

    const filePath = fileSourceStep.path;
    const outputDir = fileSourceStep.dir;
    
    const args = ['x', filePath, `-o${outputDir}`, '-aoa'];
    
    try {
        await executeCommand(toolCommand, args);
        return { outputDir: outputDir };
    } catch (error: any) {
        throw new Error(`Failed to unzip file: ${error.message}`);
    }
}

async function handleCommandStep(step: any, allResults: any, context: vscode.ExtensionContext): Promise<{ output: string }> {
    const { command, args, output, inputs, scriptPath } = step;
    const interpolationContext: { [key: string]: any } = { ...allResults, extensionPath: context.extensionPath };

    const finalArgs = [];

    if (scriptPath) {
        const interpolatedScriptPath = interpolatePipelineVariables(scriptPath, interpolationContext);
        finalArgs.push(interpolatedScriptPath);
    }

    if (args) {
        const interpolatedArgs = args.map((arg: string) => interpolatePipelineVariables(arg, interpolationContext));
        finalArgs.push(...interpolatedArgs);
    }

    const commandOutput = await executeCommand(command, finalArgs);
    if (output?.showInEditor) {
        const doc = await vscode.workspace.openTextDocument({ content: commandOutput, language: 'plaintext' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    return { output: commandOutput.trim() };
}

function executeCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`[INFO] Executing command: ${command} ${args.join(' ')}`);
        const process = spawn(command, args);
        let stdout = '';
        let stderr = '';

        if (process.stdout) {
            process.stdout.on('data', (data) => {
                const output = data.toString();
                if (stdout === '') {
                    outputChannel.appendLine('--- STDOUT ---');
                }
                outputChannel.append(output);
                stdout += output;
            });
        }

        if (process.stderr) {
            process.stderr.on('data', (data) => {
                const output = data.toString();
                if (stderr === '') {
                    outputChannel.appendLine('--- STDERR ---');
                }
                outputChannel.append(output);
                stderr += output;
            });
        }

        process.on('close', (code) => {
            outputChannel.appendLine(`[INFO] Command finished with exit code ${code}.`);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || `Command failed with exit code ${code}`));
            }
        });

        process.on('error', (err) => {
            outputChannel.appendLine(`[ERROR] Failed to start command: ${err.message}`);
            reject(err);
        });
    });
}

function interpolatePipelineVariables(template: string, context: any): string {
    let result = template.replace(/\${workspaceFolder}/g, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
    result = result.replace(/\${extensionPath}/g, context.extensionPath || '');

    const regex = /\${([^}]+)}/g;
    result = result.replace(regex, (match, expression) => {
        const parts = expression.split('.');
        const stepId = parts[0];
        const property = parts[1];

        if (context[stepId] && property && context[stepId][property] !== undefined) {
            return context[stepId][property];
        }
        if (context[stepId] && context[stepId].output !== undefined) {
            return context[stepId].output;
        }
        if (context[stepId] && context[stepId].outputDir !== undefined) {
            return context[stepId].outputDir;
        }
        if (context[stepId] && context[stepId].name !== undefined) {
            return context[stepId].name;
        }

        return match;
    });
    return result;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated

  const taskProcessIds = new Map<number, boolean>();
  const taskNameToProcessId = new Map<string, number>();
  const manuallyTerminatedTasks = new Set<string>();

  context.subscriptions.push(vscode.tasks.onDidStartTaskProcess(e => {
    if (e.execution.task.source === 'firmware-toolkit') {
      if (e.processId) {
        taskProcessIds.set(e.processId, true);
        taskNameToProcessId.set(e.execution.task.name, e.processId);
      }
    }
  }));

  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => {
    if (e.execution.task.source === 'firmware-toolkit') {
      const processId = taskNameToProcessId.get(e.execution.task.name);
      if (processId) {
        taskNameToProcessId.delete(e.execution.task.name);
      }
    }
  }));

  const mainViewProvider = new MainViewProvider(context);
  const linkViewProvider = new LinkViewProvider(context);
  const favoriteViewProvider = new FavoriteViewProvider(context);

  const mainView = vscode.window.createTreeView('mainView.main', { treeDataProvider: mainViewProvider });
  context.subscriptions.push(mainView);

  mainView.onDidExpandElement(async e => {
    if (e.element instanceof Folder && e.element.id) {
      await context.workspaceState.update(`folderState:${e.element.id}`, true);
    }
  });

  mainView.onDidCollapseElement(async e => {
    if (e.element instanceof Folder && e.element.id) {
      await context.workspaceState.update(`folderState:${e.element.id}`, false);
    }
  });

  linkViewProvider.view = vscode.window.createTreeView('mainView.link', { treeDataProvider: linkViewProvider });
  favoriteViewProvider.view = vscode.window.createTreeView('mainView.favorite', { treeDataProvider: favoriteViewProvider });

  context.subscriptions.push(linkViewProvider.view);
  context.subscriptions.push(favoriteViewProvider.view);

  // Register file watchers
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Watch media/actions.json
  const mediaActionsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.extensionPath, 'media/actions.json')
  );
  mediaActionsWatcher.onDidChange(() => mainViewProvider.refresh());
  mediaActionsWatcher.onDidCreate(() => mainViewProvider.refresh());
  mediaActionsWatcher.onDidDelete(() => mainViewProvider.refresh());
  context.subscriptions.push(mediaActionsWatcher);

  // Watch media/links.json
  const mediaLinksWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.extensionPath, 'media/links.json')
  );
  mediaLinksWatcher.onDidChange(() => linkViewProvider.refresh());
  mediaLinksWatcher.onDidCreate(() => linkViewProvider.refresh());
  mediaLinksWatcher.onDidDelete(() => linkViewProvider.refresh());
  context.subscriptions.push(mediaLinksWatcher);

  if (workspaceRoot) {
    // Watch .vscode/actions.json
    const vscodeActionsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.vscode/actions.json')
    );
    vscodeActionsWatcher.onDidChange(() => mainViewProvider.refresh());
    vscodeActionsWatcher.onDidCreate(() => mainViewProvider.refresh());
    vscodeActionsWatcher.onDidDelete(() => mainViewProvider.refresh());
    context.subscriptions.push(vscodeActionsWatcher);

    // Watch .vscode/links.json
    const vscodeLinksWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.vscode/links.json')
    );
    vscodeLinksWatcher.onDidChange(() => linkViewProvider.refresh());
    vscodeLinksWatcher.onDidCreate(() => linkViewProvider.refresh());
    vscodeLinksWatcher.onDidDelete(() => linkViewProvider.refresh());
    context.subscriptions.push(vscodeLinksWatcher);

    // Watch .vscode/favorites.json
    const vscodeFavoritesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.vscode/favorites.json')
    );
    vscodeFavoritesWatcher.onDidChange(() => favoriteViewProvider.refresh());
    vscodeFavoritesWatcher.onDidCreate(() => favoriteViewProvider.refresh());
    vscodeFavoritesWatcher.onDidDelete(() => favoriteViewProvider.refresh());
    context.subscriptions.push(vscodeFavoritesWatcher);
  }

  const openFavoriteFileCommand = vscode.commands.registerCommand('firmware-toolkit.openFavoriteFile', async (filePath: string) => {
    try {
      // Resolve ${workspaceFolder} if present
      const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
      const resolvedPath = filePath.replace('${workspaceFolder}', workspaceFolder);

      const uri = vscode.Uri.file(resolvedPath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
      console.error(`Error opening favorite file: ${error.message}`);
    }
  });
  context.subscriptions.push(openFavoriteFileCommand);

  const openLinkCommand = vscode.commands.registerCommand('firmware-toolkit.openLink', (url: string) => {
    vscode.env.openExternal(vscode.Uri.parse(url));
  });
  context.subscriptions.push(openLinkCommand);

  const copyLinkCommand = vscode.commands.registerCommand('firmware-toolkit.copyLink', (item: Link) => {
    vscode.env.clipboard.writeText(item.getLink());
    vscode.window.showInformationMessage('Link copied to clipboard.');
  });
  context.subscriptions.push(copyLinkCommand);

  const goToLinkCommand = vscode.commands.registerCommand('firmware-toolkit.goToLink', (item: Link) => {
    vscode.env.openExternal(vscode.Uri.parse(item.getLink()));
  });
  context.subscriptions.push(goToLinkCommand);

  const executeActionCommand = vscode.commands.registerCommand('firmware-toolkit.executeAction', async (actionItem: Action) => {
    const showTaskStatus = vscode.workspace.getConfiguration('firmware-toolkit').get('showTaskStatus', true);
    const action = actionItem.getActionData();
    const title = actionItem.label;
    const id = actionItem.id || title;

    if (showTaskStatus) {
      const currentState = actionStates.get(id);
      if (currentState?.state === 'running') {
        vscode.window.showInformationMessage(`Action '${title}' is already running.`);
        return;
      }
      actionStates.set(id, { state: 'running' });
      mainViewProvider.refresh();
    }

    if (action.type === 'shell') {
      let cwd = action.cwd;
      if (cwd) {
        const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
        cwd = cwd.replace('${workspaceFolder}', workspaceFolder);
      }

      let command = action.command;
      if (typeof command === 'object') {
        const platform = process.platform;
        if (platform === 'win32') {
          const terminal = vscode.workspace.getConfiguration('terminal.integrated.defaultProfile').get<string>('windows')?.toLowerCase();
          if (terminal && command.windows && typeof command.windows === 'object') {
            if (terminal.includes('powershell') && command.windows.powershell) {
              command = command.windows.powershell;
            } else if (terminal.includes('cmd') && command.windows.cmd) {
              command = command.windows.cmd;
            } else {
              command = command.windows.cmd || command.windows.powershell;
            }
          } else {
            command = command.windows;
          }
        } else if (platform === 'darwin') {
          command = command.macos;
        } else {
          command = command.linux;
        }
      }

      if (typeof command !== 'string') {
        vscode.window.showErrorMessage(`No command found for the current OS.`);
        if (showTaskStatus) {
          actionStates.set(id, { state: 'failure' });
          mainViewProvider.refresh();
        }
        return;
      }

      let revealKind: vscode.TaskRevealKind = vscode.TaskRevealKind.Silent; // Default to Silent
      if (action.revealTerminal === 'always') {
        revealKind = vscode.TaskRevealKind.Always;
      } else if (action.revealTerminal === 'never') {
        revealKind = vscode.TaskRevealKind.Never;
      }

      const task = new vscode.Task(
        { type: 'shell', task: title }, // Definition
        vscode.TaskScope.Workspace, // Scope
        title, // Name
        'firmware-toolkit', // Source
        new vscode.ShellExecution(command, { cwd: cwd }), // Execution
        [] // Problem Matchers
      );

      task.isBackground = false;
      task.presentationOptions = {
        reveal: revealKind, // Use the configured revealKind
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
      };

      try {
        const taskExecution = await vscode.tasks.executeTask(task);
        if (showTaskStatus) {
          activeTasks.set(id, taskExecution);
        }
      } catch (e) {
        if (showTaskStatus) {
          actionStates.set(id, { state: 'failure' });
          mainViewProvider.refresh();
        }
      }

      const disposable = vscode.tasks.onDidEndTaskProcess(e => {
        if (e.execution.task.name === title) {
          if (showTaskStatus) {
            if (manuallyTerminatedTasks.has(id)) {
              actionStates.delete(id);
              manuallyTerminatedTasks.delete(id);
            } else if (e.exitCode === 0) {
              actionStates.set(id, { state: 'success' });
              if (action.successMessage) {
                vscode.window.showInformationMessage(action.successMessage);
              }
            } else {
              actionStates.set(id, { state: 'failure' });
              if (action.failMessage) {
                vscode.window.showErrorMessage(action.failMessage);
              }
            }
            activeTasks.delete(id);
            mainViewProvider.refresh();
          } else {
            if (e.exitCode === 0) {
              if (action.successMessage) {
                vscode.window.showInformationMessage(action.successMessage);
              }
            } else {
              if (action.failMessage) {
                vscode.window.showErrorMessage(action.failMessage);
              }
            }
          }
          disposable.dispose();
        }
      });
    } else if (action.type === 'pipeline') {
      try {
        await handlePipelineAction(action, actionItem.context);
        if (showTaskStatus) {
          actionStates.set(id, { state: 'success' });
          mainViewProvider.refresh();
        }
      } catch (error) {
        if (showTaskStatus) {
          actionStates.set(id, { state: 'failure' });
          mainViewProvider.refresh();
        }
      }
    }
  });
  context.subscriptions.push(executeActionCommand);

  const stopActionCommand = vscode.commands.registerCommand('firmware-toolkit.stopAction', (actionItem: Action) => {
    const id = actionItem.id || actionItem.label;
    const task = activeTasks.get(id);
    if (task) {
      manuallyTerminatedTasks.add(id);
      task.terminate();
      actionStates.delete(id);
      mainViewProvider.refresh();
      vscode.window.showInformationMessage(`Action '${actionItem.label}' terminated.`);
    } else {
      vscode.window.showWarningMessage(`Could not find active task for '${actionItem.label}'.`);
    }
  });
  context.subscriptions.push(stopActionCommand);

  const showVersionCommand = vscode.commands.registerCommand('firmware-toolkit.showVersion', () => {
    const packageJsonPath = path.join(context.extensionPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const extensionVersion = packageJson.version;
    vscode.window.showInformationMessage(`Firmware Toolkit Version: ${extensionVersion}`);
  });
  context.subscriptions.push(showVersionCommand);

  const showExecutablePickerCommand = vscode.commands.registerCommand('firmware-toolkit.showExecutablePicker', async (action: any) => {
    const folderPath = action.folder?.replace('${workspaceFolder}', vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '');
    const runCommandTemplate = action.runCommand;

    const quickPickItems: (vscode.QuickPickItem & { isBrowse?: boolean })[] = [];

    if (folderPath && fs.existsSync(folderPath)) {
      try {
        const files = await fs.promises.readdir(folderPath);
        files.forEach(file => {
          quickPickItems.push({ label: file, description: path.join(folderPath, file) });
        });
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error reading folder: ${error.message}`);
      }
    }

    quickPickItems.push({ label: '$(file-directory) Browse for executable...', isBrowse: true });

    const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
      placeHolder: 'Select an executable or browse for one',
    });

    if (selectedItem) {
      if (selectedItem.isBrowse) {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Select Executable',
        });

        if (uris && uris.length > 0) {
          const fullPath = uris[0].fsPath;
          const commandToExecute = runCommandTemplate.replace('${file}', `"${fullPath}"`);
          const task = new vscode.Task(
            { type: 'shell', task: 'Run Executable' },
            vscode.TaskScope.Workspace,
            'Run Executable',
            'firmware-toolkit',
            new vscode.ShellExecution(commandToExecute),
            []
          );
          task.isBackground = false;
          task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
            clear: true,
            showReuseMessage: false
          };
          await vscode.tasks.executeTask(task);
        }
      } else {
        const fullPath = selectedItem.description;
        const commandToExecute = runCommandTemplate.replace('${file}', `"${fullPath}"`);
        const task = new vscode.Task(
          { type: 'shell', task: selectedItem.label },
          vscode.TaskScope.Workspace,
          selectedItem.label,
          'firmware-toolkit',
          new vscode.ShellExecution(commandToExecute, { cwd: folderPath }),
          []
        );
        task.isBackground = false;
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always,
          panel: vscode.TaskPanelKind.Dedicated,
          clear: true,
          showReuseMessage: false
        };
        await vscode.tasks.executeTask(task);
      }
    }
  });
  context.subscriptions.push(showExecutablePickerCommand);

  

  const editFavoritesCommand = vscode.commands.registerCommand('firmware-toolkit.editFavorites', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const favoritesPath = path.join(workspaceFolder, '.vscode', 'favorites.json');

    if (!fs.existsSync(favoritesPath)) {
      // Create the .vscode directory if it doesn't exist
      if (!fs.existsSync(path.dirname(favoritesPath))) {
        fs.mkdirSync(path.dirname(favoritesPath));
      }
      fs.writeFileSync(favoritesPath, JSON.stringify([], null, 2));
    }

    const uri = vscode.Uri.file(favoritesPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  });
  context.subscriptions.push(editFavoritesCommand);

  const editLinksCommand = vscode.commands.registerCommand('firmware-toolkit.editLinks', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const linksPath = path.join(workspaceFolder, '.vscode', 'links.json');

    if (!fs.existsSync(linksPath)) {
      // Create the .vscode directory if it doesn't exist
      if (!fs.existsSync(path.dirname(linksPath))) {
        fs.mkdirSync(path.dirname(linksPath));
      }
      fs.writeFileSync(linksPath, JSON.stringify([], null, 2));
    }

    const uri = vscode.Uri.file(linksPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  });
  context.subscriptions.push(editLinksCommand);

  const editActionsCommand = vscode.commands.registerCommand('firmware-toolkit.editActions', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const actionsPath = path.join(workspaceFolder, '.vscode', 'actions.json');

    if (!fs.existsSync(actionsPath)) {
      // Create the .vscode directory if it doesn't exist
      if (!fs.existsSync(path.dirname(actionsPath))) {
        fs.mkdirSync(path.dirname(actionsPath));
      }
      fs.writeFileSync(actionsPath, JSON.stringify([], null, 2));
    }

    const uri = vscode.Uri.file(actionsPath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
  });
  context.subscriptions.push(editActionsCommand);

  const addFavoriteFileCommand = vscode.commands.registerCommand('firmware-toolkit.addFavoriteFile', async () => {
    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Add to Favorites'
    });

    if (!fileUris || fileUris.length === 0) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const favoritesPath = path.join(workspaceFolder, '.vscode', 'favorites.json');
    let favorites: { title: string; path: string }[] = [];
    if (fs.existsSync(favoritesPath)) {
      try {
        favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8'));
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error parsing favorites.json: ${error.message}`);
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
  });
  context.subscriptions.push(addFavoriteFileCommand);

  const deleteFavoriteCommand = vscode.commands.registerCommand('firmware-toolkit.deleteFavorite', async (item: Favorite) => {
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.label}?`, { modal: true }, 'Yes');
    if (confirm !== 'Yes') {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const favoritesPath = path.join(workspaceFolder, '.vscode', 'favorites.json');
    if (!fs.existsSync(favoritesPath)) {
      return;
    }

    let favorites: { title: string; path: string }[] = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8'));
    favorites = favorites.filter(favorite => favorite.path !== item.getFilePath());
    fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
    favoriteViewProvider.refresh();
  });
  context.subscriptions.push(deleteFavoriteCommand);

  const deleteLinkCommand = vscode.commands.registerCommand('firmware-toolkit.deleteLink', async (item: Link) => {
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.label}?`, { modal: true }, 'Yes');
    if (confirm !== 'Yes') {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const vscodeLinksPath = path.join(workspaceFolder, '.vscode', 'links.json');
    const mediaLinksPath = path.join(context.extensionPath, 'media', 'links.json');

    let changed = false;

    if (fs.existsSync(vscodeLinksPath)) {
      let links: { title: string; link: string }[] = JSON.parse(fs.readFileSync(vscodeLinksPath, 'utf-8'));
      const initialLength = links.length;
      links = links.filter(link => link.link !== item.getLink());
      if (links.length !== initialLength) {
        fs.writeFileSync(vscodeLinksPath, JSON.stringify(links, null, 2));
        changed = true;
      }
    }

    if (!changed && fs.existsSync(mediaLinksPath)) {
      let links: { title: string; link: string }[] = JSON.parse(fs.readFileSync(mediaLinksPath, 'utf-8'));
      const initialLength = links.length;
      links = links.filter(link => link.link !== item.getLink());
      if (links.length !== initialLength) {
        fs.writeFileSync(mediaLinksPath, JSON.stringify(links, null, 2));
        changed = true;
      }
    }

    if (changed) {
      linkViewProvider.refresh();
    }
  });
  context.subscriptions.push(deleteLinkCommand);

  const showExampleJsonCommand = vscode.commands.registerCommand('firmware-toolkit.showExampleJson', async (jsonType: string) => {
    let exampleContent = '';
    let fileName = '';

    switch (jsonType) {
      case 'actions':
        fileName = 'actions.json';
        exampleContent = JSON.stringify([
          {
            "type": "folder",
            "title": "Build Tasks",
            "id": "folder.build",
            "children": [
          {
            "id": "button.build.os",
            "title": "Build Project (OS-Specific)",
            "action": {
              "type": "shell",
              "command": {
                "windows": "echo 'Building on Windows...'",
                "macos": "echo 'Building on macOS...'",
                "linux": "echo 'Building on Linux...'"
              },
              "cwd": "${workspaceFolder}",
              "revealTerminal": "always",
              "successMessage": "Build completed successfully!",
              "failMessage": "Build failed. Check terminal for details."
            }
          },
          {
            "id": "button.build",
            "title": "Build Project",
            "action": {
              "type": "shell",
              "command": "npm run build",
              "cwd": "${workspaceFolder}",
              "revealTerminal": "always",
              "successMessage": "Build completed successfully!",
              "failMessage": "Build failed. Check terminal for details."
            }
              }
            ]
          },
          {
            "id": "separator.1",
            "type": "separator",
            "title": "--------"
          },
          {
            "id": "button.openDocs",
            "title": "Open Documentation",
            "action": {
              "type": "shell",
              "command": "code ${workspaceFolder}/docs/index.md",
              "revealTerminal": "silent"
            }
          },
          {
            "id": "button.selectExecutable",
            "title": "Select and Run Executable",
            "action": {
              "type": "executablePicker",
              "folder": "${workspaceFolder}/bin",
              "runCommand": "bash ${file}"
            }
          }
        ], null, 2);
        break;
      case 'links':
        fileName = 'links.json';
        exampleContent = JSON.stringify([
          {
            "title": "VS Code API Docs",
            "link": "https://code.visualstudio.com/api"
          },
          {
            "title": "Firmware Blog",
            "link": "https://example.com/firmware-blog"
          }
        ], null, 2);
        break;
      case 'favorites':
        fileName = 'favorites.json';
        exampleContent = JSON.stringify([
          {
            "title": "My Main Source File",
            "path": "${workspaceFolder}/src/main.c"
          },
          {
            "title": "Project Readme",
            "path": "${workspaceFolder}/README.md"
          }
        ], null, 2);
        break;
      default:
        vscode.window.showErrorMessage(`Unknown JSON type: ${jsonType}`);
        return;
    }

    try {
      const document = await vscode.workspace.openTextDocument({
        content: exampleContent,
        language: 'json'
      });
      await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      vscode.window.showInformationMessage(`Example ${fileName} opened in a new tab.`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to open example ${fileName}: ${error.message}`);
    }
  });
  context.subscriptions.push(showExampleJsonCommand);

  const showExampleJsonQuickPickCommand = vscode.commands.registerCommand('firmware-toolkit.showExampleJsonQuickPick', async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'actions.json Example', description: 'Show example content for actions.json', type: 'actions' },
        { label: 'links.json Example', description: 'Show example content for links.json', type: 'links' },
        { label: 'favorites.json Example', description: 'Show example content for favorites.json', type: 'favorites' },
      ],
      {
        placeHolder: 'Select which example JSON to display',
      }
    );

    if (pick && pick.type) {
      vscode.commands.executeCommand('firmware-toolkit.showExampleJson', pick.type);
    }
  });
  context.subscriptions.push(showExampleJsonQuickPickCommand);

  const addOpenFileToFavoritesCommand = vscode.commands.registerCommand('firmware-toolkit.addOpenFileToFavorites', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor found.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const fileName = path.basename(filePath);

    const title = await vscode.window.showInputBox({
      prompt: `Enter a title for ${fileName}`,
      value: fileName
    });

    if (!title) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const favoritesPath = path.join(workspaceFolder, '.vscode', 'favorites.json');
    let favorites: { title: string; path: string }[] = [];
    if (fs.existsSync(favoritesPath)) {
      try {
        favorites = JSON.parse(fs.readFileSync(favoritesPath, 'utf-8'));
      } catch (error: any) {
        vscode.window.showErrorMessage(`Error parsing favorites.json: ${error.message}`);
        return;
      }
    }

    favorites.push({ title, path: filePath });

    fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));

    favoriteViewProvider.refresh();
    vscode.window.showInformationMessage(`Added ${fileName} to favorites.`);
  });
  context.subscriptions.push(addOpenFileToFavoritesCommand);

  const terminateAllTasksCommand = vscode.commands.registerCommand('firmware-toolkit.terminateAllTasks', async () => {
    const terminalsToClosePromises = vscode.window.terminals.map(async t => {
      const processId = await t.processId;
      return processId && taskProcessIds.has(processId) ? t : null;
    });
    const terminalsToClose = (await Promise.all(terminalsToClosePromises)).filter(t => t !== null) as vscode.Terminal[];

    const tasksToTerminate = vscode.tasks.taskExecutions.filter(t => t.task.source === 'firmware-toolkit');

    if (tasksToTerminate.length > 0 || terminalsToClose.length > 0) {
      const executionToIdMap = new Map<vscode.TaskExecution, string>();
      activeTasks.forEach((exec, id) => {
        executionToIdMap.set(exec, id);
      });

      tasksToTerminate.forEach(t => {
        const id = executionToIdMap.get(t);
        if (id) {
          manuallyTerminatedTasks.add(id);
        }
        t.terminate();
      });
    
    terminalsToClose.forEach(t => t.dispose());
    vscode.window.showInformationMessage(`Terminated ${tasksToTerminate.length} task(s) and closed ${terminalsToClose.length} terminal(s).`);
    } else {
      vscode.window.showInformationMessage('No tasks or terminals from this extension are currently active.');
    }

    // Clear all states after termination
    actionStates.clear();
    activeTasks.clear();
    taskProcessIds.clear();
    taskNameToProcessId.clear();
    mainViewProvider.refresh();
  });
  context.subscriptions.push(terminateAllTasksCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}