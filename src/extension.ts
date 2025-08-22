// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

class MainViewProvider implements vscode.TreeDataProvider<Action | vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<Action | vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<Action | vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Action | vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Action | vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Action | vscode.TreeItem): Thenable<(Action | vscode.TreeItem)[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'actions.json');
      let actionsJson = JSON.parse(fs.readFileSync(mediaJsonPath, 'utf-8'));
      console.log(`Using media/actions.json: ${JSON.stringify(actionsJson, null, 2)}`);

      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'actions.json');

      if (fs.existsSync(vscodeJsonPath)) {
        const vscodeActionsJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'));
        actionsJson = actionsJson.concat(vscodeActionsJson);
        console.log(`Appended .vscode/actions.json: ${JSON.stringify(vscodeActionsJson, null, 2)}`);
      }

      const packageJsonPath = path.join(this.context.extensionPath, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const extensionVersion = packageJson.version;

      const versionItem = new vscode.TreeItem(`Version: ${extensionVersion}`);
      versionItem.iconPath = new vscode.ThemeIcon('info'); // Use an info icon
      versionItem.tooltip = `Extension Version: ${extensionVersion}`;

      const items: (Action | vscode.TreeItem)[] = [];
      items.push(versionItem); // Add version item at the top

      actionsJson.forEach((item: any) => {
        if (item.type === 'separator') {
          const separatorItem = new vscode.TreeItem(item.title);
          separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
          separatorItem.contextValue = 'separator'; // Custom context value for styling/menus if needed
          items.push(separatorItem);
        } else if (item.id && item.id.startsWith('button.')) {
          if (item.action && item.action.type === 'executablePicker') {
            const executablePickerItem = new vscode.TreeItem(item.title);
            executablePickerItem.command = {
              command: 'firmware-toolkit.showExecutablePicker',
              title: 'Select and Run Executable',
              arguments: [item.action], // Pass the action object
            };
            items.push(executablePickerItem);
          } else {
            items.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None));
          }
        } else {
          // Handle unknown types or IDs, e.g., log a warning or create a generic item
          console.warn(`Unknown item type or ID in actions.json: ${item.id || item.type}`);
          const unknownItem = new vscode.TreeItem(item.title || 'Unknown Item');
          unknownItem.tooltip = `Unknown item type or ID: ${item.id || item.type}`;
          items.push(unknownItem);
        }
      });

      return Promise.resolve(items);
    }
  }
}

class Action extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    private readonly actionData: any, // Renamed from 'action' to 'actionData' for clarity
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.command = {
      command: 'firmware-toolkit.executeAction',
      title: 'Execute Action',
      arguments: [{ title: label, action: actionData }], // Pass an object containing both title and actionData
    };
  }
}

class LinkViewProvider implements vscode.TreeDataProvider<Link> {
  private _onDidChangeTreeData: vscode.EventEmitter<Link | undefined | null | void> = new vscode.EventEmitter<Link | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Link | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Link): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Link): Thenable<Link[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      const mediaJsonPath = path.join(this.context.extensionPath, 'media', 'links.json');
      let linksJson = JSON.parse(fs.readFileSync(mediaJsonPath, 'utf-8'));
      console.log(`Using media/links.json: ${JSON.stringify(linksJson, null, 2)}`);

      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'links.json');

      if (fs.existsSync(vscodeJsonPath)) {
        const vscodeLinksJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'));
        linksJson = linksJson.concat(vscodeLinksJson);
        console.log(`Appended .vscode/links.json: ${JSON.stringify(vscodeLinksJson, null, 2)}`);
      }
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
    this.iconPath = new vscode.ThemeIcon('file'); // Using a generic file icon
  }

  getFilePath(): string {
    return this.filePath;
  }
}

class FavoriteViewProvider implements vscode.TreeDataProvider<Favorite> {
  private _onDidChangeTreeData: vscode.EventEmitter<Favorite | undefined | null | void> = new vscode.EventEmitter<Favorite | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Favorite | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: Favorite): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Favorite): Thenable<Favorite[]> {
    if (element) {
      return Promise.resolve([]);
    } else {
      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.vscode', 'favorites.json');
      let favoritesJson: { title: string; path: string }[] = [];

      if (fs.existsSync(vscodeJsonPath)) {
        try {
          favoritesJson = JSON.parse(fs.readFileSync(vscodeJsonPath, 'utf-8'));
          console.log(`Using .vscode/favorites.json: ${JSON.stringify(favoritesJson, null, 2)}`);
        } catch (error: any) {
          vscode.window.showErrorMessage(`Error parsing .vscode/favorites.json: ${error.message}`);
          console.error(`Error parsing .vscode/favorites.json: ${error.message}`);
        }
      } else {
        console.log('No .vscode/favorites.json found. Favorite view will be empty.');
      }

      return Promise.resolve(
        favoritesJson.map(
          (item: { title: string; path: string }) =>
            new Favorite(item.title, item.path, vscode.TreeItemCollapsibleState.None)
        )
      );
    }
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "firmware-toolkit" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('firmware-toolkit.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from firmware-toolkit!');
	});

	context.subscriptions.push(disposable);

  const mainViewProvider = new MainViewProvider(context);
  const linkViewProvider = new LinkViewProvider(context);
  const favoriteViewProvider = new FavoriteViewProvider(context);

  vscode.window.registerTreeDataProvider('mainView.main', mainViewProvider);
	vscode.window.registerTreeDataProvider('mainView.link', linkViewProvider);
  vscode.window.registerTreeDataProvider('mainView.favorite', favoriteViewProvider);

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

  const executeActionCommand = vscode.commands.registerCommand('firmware-toolkit.executeAction', async (arg: { title: string, action: any }) => {
    const action = arg.action; // Get the action data
    const title = arg.title;   // Get the title

    console.log('Action received:', action);
    console.log('Action title:', title);

    if (action.type === 'shell') {
      let cwd = action.cwd;
      if (cwd) {
        const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
        cwd = cwd.replace('${workspaceFolder}', workspaceFolder);
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
        new vscode.ShellExecution(action.command, { cwd: cwd }), // Execution
        [] // Problem Matchers
      );

      task.isBackground = false;
      task.presentationOptions = {
        reveal: revealKind, // Use the configured revealKind
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
      };

      // Execute the task
      const taskExecution = await vscode.tasks.executeTask(task);

      // Listen for task end
      const disposable = vscode.tasks.onDidEndTaskProcess(e => {
        if (e.execution.task.name === title) { // Check if it's the task we executed
          if (e.exitCode === 0) { // Success
            if (action.successMessage) {
              vscode.window.showInformationMessage(action.successMessage);
            }
          } else { // Failure
            if (action.failMessage) {
              vscode.window.showErrorMessage(action.failMessage);
            }
          }
          disposable.dispose(); // Dispose the listener after the task we care about ends
        }
      });
      context.subscriptions.push(disposable); // Ensure the disposable is managed by the context
    }
  });
  context.subscriptions.push(executeActionCommand);

  const showVersionCommand = vscode.commands.registerCommand('firmware-toolkit.showVersion', () => {
    const packageJsonPath = path.join(context.extensionPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const extensionVersion = packageJson.version;
    vscode.window.showInformationMessage(`Firmware Toolkit Version: ${extensionVersion}`);
  });
  context.subscriptions.push(showVersionCommand);

  const showExecutablePickerCommand = vscode.commands.registerCommand('firmware-toolkit.showExecutablePicker', async (action: any) => {
    const folderPath = action.folder.replace('${workspaceFolder}', vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '');
    const runCommandTemplate = action.runCommand;

    if (!fs.existsSync(folderPath)) {
      vscode.window.showErrorMessage(`Folder not found: ${folderPath}`);
      return;
    }

    try {
      const files = await fs.promises.readdir(folderPath);
      const quickPickItems = files.map(file => ({ label: file, description: path.join(folderPath, file) }));

      const selectedFile = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: `Select an executable from ${folderPath}`,
      });

      if (selectedFile) {
        const fullPath = selectedFile.description; // full path is stored in description
        const commandToExecute = runCommandTemplate.replace('${file}', fullPath);

        // Execute the command using the task system
        const task = new vscode.Task(
          { type: 'shell', task: selectedFile.label },
          vscode.TaskScope.Workspace,
          selectedFile.label,
          'firmware-toolkit',
          new vscode.ShellExecution(commandToExecute, { cwd: folderPath }), // CWD for the task is the folder where executables are
          []
        );

        task.isBackground = false;
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always, // Show terminal for executable
          panel: vscode.TaskPanelKind.Dedicated,
          clear: true,
          showReuseMessage: false
        };

        await vscode.tasks.executeTask(task);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Error reading folder: ${error.message}`);
    }
  });
  context.subscriptions.push(showExecutablePickerCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}