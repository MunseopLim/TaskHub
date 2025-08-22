"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
  {
    __defProp(target, name, { get: all[name], enumerable: true });
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
    {
      if (!__hasOwnProp.call(to, key) && key !== except)
      {
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        }
    }
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var MainViewProvider = class {
  constructor(context) {
    this.context = context;
  }
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (element) {
      return Promise.resolve([]);
    } else {
      const mediaJsonPath = path.join(this.context.extensionPath, "media", "actions.json");
      let actionsJson = JSON.parse(fs.readFileSync(mediaJsonPath, "utf-8"));
      console.log(`Using media/actions.json: ${JSON.stringify(actionsJson, null, 2)}`);
      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", ".vscode", "actions.json");
      if (fs.existsSync(vscodeJsonPath)) {
        const vscodeActionsJson = JSON.parse(fs.readFileSync(vscodeJsonPath, "utf-8"));
        actionsJson = actionsJson.concat(vscodeActionsJson);
        console.log(`Appended .vscode/actions.json: ${JSON.stringify(vscodeActionsJson, null, 2)}`);
      }
      const packageJsonPath = path.join(this.context.extensionPath, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const extensionVersion = packageJson.version;
      const versionItem = new vscode.TreeItem(`Version: ${extensionVersion}`);
      versionItem.iconPath = new vscode.ThemeIcon("info");
      versionItem.tooltip = `Extension Version: ${extensionVersion}`;
      const items = [];
      items.push(versionItem);
      actionsJson.forEach((item) => {
        if (item.type === "separator") {
          const separatorItem = new vscode.TreeItem(item.title);
          separatorItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
          separatorItem.contextValue = "separator";
          items.push(separatorItem);
        } else if (item.id && item.id.startsWith("button.")) {
          if (item.action && item.action.type === "executablePicker") {
            const executablePickerItem = new vscode.TreeItem(item.title);
            executablePickerItem.command = {
              command: "firmware-toolkit.showExecutablePicker",
              title: "Select and Run Executable",
              arguments: [item.action]
              // Pass the action object
            };
            items.push(executablePickerItem);
          } else {
            items.push(new Action(item.title, item.action, vscode.TreeItemCollapsibleState.None));
          }
        } else {
          console.warn(`Unknown item type or ID in actions.json: ${item.id || item.type}`);
          const unknownItem = new vscode.TreeItem(item.title || "Unknown Item");
          unknownItem.tooltip = `Unknown item type or ID: ${item.id || item.type}`;
          items.push(unknownItem);
        }
      });
      return Promise.resolve(items);
    }
  }
};
var Action = class extends vscode.TreeItem {
  constructor(label, actionData, collapsibleState) {
    super(label, collapsibleState);
    this.label = label;
    this.actionData = actionData;
    this.collapsibleState = collapsibleState;
    this.command = {
      command: "firmware-toolkit.executeAction",
      title: "Execute Action",
      arguments: [{ title: label, action: actionData }]
      // Pass an object containing both title and actionData
    };
    if (actionData && actionData.type) {
      switch (actionData.type) {
        case "shell":
          this.iconPath = new vscode.ThemeIcon("terminal");
          break;
        case "executablePicker":
          this.iconPath = new vscode.ThemeIcon("play");
          break;
        // Add more cases for other action types if needed
        default:
          this.iconPath = new vscode.ThemeIcon("gear");
          break;
      }
    } else {
      this.iconPath = new vscode.ThemeIcon("gear");
    }
  }
};
var LinkViewProvider = class {
  constructor(context) {
    this.context = context;
  }
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (element) {
      return Promise.resolve([]);
    } else {
      const mediaJsonPath = path.join(this.context.extensionPath, "media", "links.json");
      let linksJson = JSON.parse(fs.readFileSync(mediaJsonPath, "utf-8"));
      console.log(`Using media/links.json: ${JSON.stringify(linksJson, null, 2)}`);
      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", ".vscode", "links.json");
      if (fs.existsSync(vscodeJsonPath)) {
        const vscodeLinksJson = JSON.parse(fs.readFileSync(vscodeJsonPath, "utf-8"));
        linksJson = linksJson.concat(vscodeLinksJson);
        console.log(`Appended .vscode/links.json: ${JSON.stringify(vscodeLinksJson, null, 2)}`);
      }
      return Promise.resolve(
        linksJson.map(
          (item) => new Link(item.title, item.link, vscode.TreeItemCollapsibleState.None)
        )
      );
    }
  }
};
var Link = class extends vscode.TreeItem {
  constructor(label, link, collapsibleState) {
    super(label, collapsibleState);
    this.label = label;
    this.link = link;
    this.collapsibleState = collapsibleState;
    this.tooltip = `${this.label}-${this.link}`;
    this.description = "";
    this.command = {
      command: "firmware-toolkit.openLink",
      title: "Open Link",
      arguments: [this.link]
    };
    this.contextValue = "linkItem";
    this.iconPath = new vscode.ThemeIcon("link");
  }
  getLink() {
    return this.link;
  }
};
var Favorite = class extends vscode.TreeItem {
  constructor(label, filePath, collapsibleState) {
    super(label, collapsibleState);
    this.label = label;
    this.filePath = filePath;
    this.collapsibleState = collapsibleState;
    this.tooltip = `${this.label} - ${this.filePath}`;
    this.command = {
      command: "firmware-toolkit.openFavoriteFile",
      title: "Open Favorite File",
      arguments: [this.filePath]
    };
    this.contextValue = "favoriteItem";
    this.iconPath = new vscode.ThemeIcon("star");
  }
  getFilePath() {
    return this.filePath;
  }
};
var FavoriteViewProvider = class {
  constructor(context) {
    this.context = context;
  }
  _onDidChangeTreeData = new vscode.EventEmitter();
  onDidChangeTreeData = this._onDidChangeTreeData.event;
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
  getChildren(element) {
    if (element) {
      return Promise.resolve([]);
    } else {
      const vscodeJsonPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", ".vscode", "favorites.json");
      let favoritesJson = [];
      if (fs.existsSync(vscodeJsonPath)) {
        try {
          favoritesJson = JSON.parse(fs.readFileSync(vscodeJsonPath, "utf-8"));
          console.log(`Using .vscode/favorites.json: ${JSON.stringify(favoritesJson, null, 2)}`);
        } catch (error) {
          vscode.window.showErrorMessage(`Error parsing .vscode/favorites.json: ${error.message}`);
          console.error(`Error parsing .vscode/favorites.json: ${error.message}`);
        }
      } else {
        console.log("No .vscode/favorites.json found. Favorite view will be empty.");
      }
      return Promise.resolve(
        favoritesJson.map(
          (item) => new Favorite(item.title, item.path, vscode.TreeItemCollapsibleState.None)
        )
      );
    }
  }
};
function activate(context) {
  console.log('Congratulations, your extension "firmware-toolkit" is now active!');
  const disposable = vscode.commands.registerCommand("firmware-toolkit.helloWorld", () => {
    vscode.window.showInformationMessage("Hello World from firmware-toolkit!");
  });
  context.subscriptions.push(disposable);
  const mainViewProvider = new MainViewProvider(context);
  const linkViewProvider = new LinkViewProvider(context);
  const favoriteViewProvider = new FavoriteViewProvider(context);
  vscode.window.registerTreeDataProvider("mainView.main", mainViewProvider);
  vscode.window.registerTreeDataProvider("mainView.link", linkViewProvider);
  vscode.window.registerTreeDataProvider("mainView.favorite", favoriteViewProvider);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const mediaActionsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.extensionPath, "media/actions.json")
  );
  mediaActionsWatcher.onDidChange(() => mainViewProvider.refresh());
  mediaActionsWatcher.onDidCreate(() => mainViewProvider.refresh());
  mediaActionsWatcher.onDidDelete(() => mainViewProvider.refresh());
  context.subscriptions.push(mediaActionsWatcher);
  const mediaLinksWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.extensionPath, "media/links.json")
  );
  mediaLinksWatcher.onDidChange(() => linkViewProvider.refresh());
  mediaLinksWatcher.onDidCreate(() => linkViewProvider.refresh());
  mediaLinksWatcher.onDidDelete(() => linkViewProvider.refresh());
  context.subscriptions.push(mediaLinksWatcher);
  if (workspaceRoot) {
    const vscodeActionsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".vscode/actions.json")
    );
    vscodeActionsWatcher.onDidChange(() => mainViewProvider.refresh());
    vscodeActionsWatcher.onDidCreate(() => mainViewProvider.refresh());
    vscodeActionsWatcher.onDidDelete(() => mainViewProvider.refresh());
    context.subscriptions.push(vscodeActionsWatcher);
    const vscodeLinksWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".vscode/links.json")
    );
    vscodeLinksWatcher.onDidChange(() => linkViewProvider.refresh());
    vscodeLinksWatcher.onDidCreate(() => linkViewProvider.refresh());
    vscodeLinksWatcher.onDidDelete(() => linkViewProvider.refresh());
    context.subscriptions.push(vscodeLinksWatcher);
    const vscodeFavoritesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".vscode/favorites.json")
    );
    vscodeFavoritesWatcher.onDidChange(() => favoriteViewProvider.refresh());
    vscodeFavoritesWatcher.onDidCreate(() => favoriteViewProvider.refresh());
    vscodeFavoritesWatcher.onDidDelete(() => favoriteViewProvider.refresh());
    context.subscriptions.push(vscodeFavoritesWatcher);
  }
  const openFavoriteFileCommand = vscode.commands.registerCommand("firmware-toolkit.openFavoriteFile", async (filePath) => {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : "";
      const resolvedPath = filePath.replace("${workspaceFolder}", workspaceFolder);
      const uri = vscode.Uri.file(resolvedPath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open file: ${error.message}`);
      console.error(`Error opening favorite file: ${error.message}`);
    }
  });
  context.subscriptions.push(openFavoriteFileCommand);
  const openLinkCommand = vscode.commands.registerCommand("firmware-toolkit.openLink", (url) => {
    vscode.env.openExternal(vscode.Uri.parse(url));
  });
  context.subscriptions.push(openLinkCommand);
  const copyLinkCommand = vscode.commands.registerCommand("firmware-toolkit.copyLink", (item) => {
    vscode.env.clipboard.writeText(item.getLink());
    vscode.window.showInformationMessage("Link copied to clipboard.");
  });
  context.subscriptions.push(copyLinkCommand);
  const goToLinkCommand = vscode.commands.registerCommand("firmware-toolkit.goToLink", (item) => {
    vscode.env.openExternal(vscode.Uri.parse(item.getLink()));
  });
  context.subscriptions.push(goToLinkCommand);
  const executeActionCommand = vscode.commands.registerCommand("firmware-toolkit.executeAction", async (arg) => {
    const action = arg.action;
    const title = arg.title;
    console.log("Action received:", action);
    console.log("Action title:", title);
    if (action.type === "shell") {
      let cwd = action.cwd;
      if (cwd) {
        const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : "";
        cwd = cwd.replace("${workspaceFolder}", workspaceFolder);
      }
      let revealKind = vscode.TaskRevealKind.Silent;
      if (action.revealTerminal === "always") {
        revealKind = vscode.TaskRevealKind.Always;
      } else if (action.revealTerminal === "never") {
        revealKind = vscode.TaskRevealKind.Never;
      }
      const task = new vscode.Task(
        { type: "shell", task: title },
        // Definition
        vscode.TaskScope.Workspace,
        // Scope
        title,
        // Name
        "firmware-toolkit",
        // Source
        new vscode.ShellExecution(action.command, { cwd }),
        // Execution
        []
        // Problem Matchers
      );
      task.isBackground = false;
      task.presentationOptions = {
        reveal: revealKind,
        // Use the configured revealKind
        panel: vscode.TaskPanelKind.Dedicated,
        clear: true,
        showReuseMessage: false
      };
      const taskExecution = await vscode.tasks.executeTask(task);
      const disposable2 = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task.name === title) {
          if (e.exitCode === 0) {
            if (action.successMessage) {
              vscode.window.showInformationMessage(action.successMessage);
            }
          } else {
            if (action.failMessage) {
              vscode.window.showErrorMessage(action.failMessage);
            }
          }
          disposable2.dispose();
        }
      });
      context.subscriptions.push(disposable2);
    }
  });
  context.subscriptions.push(executeActionCommand);
  const showVersionCommand = vscode.commands.registerCommand("firmware-toolkit.showVersion", () => {
    const packageJsonPath = path.join(context.extensionPath, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const extensionVersion = packageJson.version;
    vscode.window.showInformationMessage(`Firmware Toolkit Version: ${extensionVersion}`);
  });
  context.subscriptions.push(showVersionCommand);
  const showExecutablePickerCommand = vscode.commands.registerCommand("firmware-toolkit.showExecutablePicker", async (action) => {
    const folderPath = action.folder.replace("${workspaceFolder}", vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : "");
    const runCommandTemplate = action.runCommand;
    if (!fs.existsSync(folderPath)) {
      vscode.window.showErrorMessage(`Folder not found: ${folderPath}`);
      return;
    }
    try {
      const files = await fs.promises.readdir(folderPath);
      const quickPickItems = files.map((file) => ({ label: file, description: path.join(folderPath, file) }));
      const selectedFile = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: `Select an executable from ${folderPath}`
      });
      if (selectedFile) {
        const fullPath = selectedFile.description;
        const commandToExecute = runCommandTemplate.replace("${file}", fullPath);
        const task = new vscode.Task(
          { type: "shell", task: selectedFile.label },
          vscode.TaskScope.Workspace,
          selectedFile.label,
          "firmware-toolkit",
          new vscode.ShellExecution(commandToExecute, { cwd: folderPath }),
          // CWD for the task is the folder where executables are
          []
        );
        task.isBackground = false;
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always,
          // Show terminal for executable
          panel: vscode.TaskPanelKind.Dedicated,
          clear: true,
          showReuseMessage: false
        };
        await vscode.tasks.executeTask(task);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error reading folder: ${error.message}`);
    }
  });
  context.subscriptions.push(showExecutablePickerCommand);
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
