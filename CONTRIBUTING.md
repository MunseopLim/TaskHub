# Contributing to TaskHub

## Development Guidelines

### Pre-requisites
- Node.js and npm installed
- Visual Studio Code

### Setup
```bash
npm install
```

### Development Workflow

#### Before Committing Changes
Every time you finish working on a task, make sure to complete the following checklist:

- [ ] **Run Unit Tests**
  ```bash
  npm test
  ```
  Ensure all tests pass before committing.

- [ ] **Run Linter**
  ```bash
  npm run lint
  ```
  Fix any linting errors or warnings.

- [ ] **Type Check**
  ```bash
  npm run check-types
  ```
  Ensure there are no TypeScript errors.

- [ ] **Build the Extension**
  ```bash
  npm run package
  ```
  Verify the extension builds successfully.

### Running All Checks at Once
You can run all checks with the vscode:prepublish script:
```bash
npm run vscode:prepublish
```

This will:
1. Check types
2. Run linter
3. Build the extension in production mode

### Testing Locally
To test your changes:
1. Press F5 in VS Code to open a new Extension Development Host window
2. Test your changes in the new window

### Building VSIX Package
To create a VSIX package for distribution:
```bash
vsce package
```

This will run all checks automatically and create a `.vsix` file.

## Code Style
- Follow the existing code style
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions small and focused

## Pull Requests
When submitting a pull request:
1. Ensure all tests pass
2. Ensure no linting errors
3. Update documentation if needed
4. Include a clear description of the changes

## Adding Experimental Features

Experimental features are a way to test new functionality before making it a stable part of TaskHub. These features can be changed or removed in future versions.

### Guidelines for Experimental Features

**When to use experimental features:**
- The feature is still in active development
- The API or behavior may change
- User feedback is needed before stabilizing
- The feature may be removed if not useful

**When NOT to use experimental features:**
- For bug fixes (these should go directly to stable)
- For minor improvements to existing features
- For critical functionality

### Step-by-Step Guide

#### 1. Add Configuration Setting

In `package.json`, add your feature's configuration under `taskhub.experimental`:

```json
"configuration": {
  "properties": {
    "taskhub.experimental.yourFeature.enabled": {
      "type": "boolean",
      "default": false,
      "description": "Enable your experimental feature. Description of what it does."
    }
  }
}
```

#### 2. Add View (if needed)

If your feature requires a TreeView panel, add it to the `views` section in `package.json`:

```json
"views": {
  "mainView": [
    {
      "id": "mainView.yourFeature",
      "name": "Your Feature (Experimental)",
      "icon": "media/icon.svg",
      "when": "config.taskhub.experimental.yourFeature.enabled"
    }
  ]
}
```

**Important:** Use the `when` clause to only show the view when the feature is enabled.

#### 3. Implement Provider

In `extension.ts`, create your TreeDataProvider or feature implementation:

```typescript
// Add after other providers
class YourFeatureProvider implements vscode.TreeDataProvider<YourFeatureItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<YourFeatureItem | undefined | null | void> =
        new vscode.EventEmitter<YourFeatureItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<YourFeatureItem | undefined | null | void> =
        this._onDidChangeTreeData.event;
    public view: vscode.TreeView<YourFeatureItem> | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: YourFeatureItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: YourFeatureItem): Thenable<YourFeatureItem[]> {
        // Implement your logic here
        return Promise.resolve([]);
    }
}
```

#### 4. Register in activate()

In the `activate()` function, register your provider:

```typescript
export function activate(context: vscode.ExtensionContext) {
    // ... existing providers ...

    // Check if experimental feature is enabled
    const isYourFeatureEnabled = vscode.workspace.getConfiguration('taskhub.experimental')
        .get<boolean>('yourFeature.enabled', false);

    if (isYourFeatureEnabled) {
        const yourFeatureProvider = new YourFeatureProvider(context);
        yourFeatureProvider.view = vscode.window.createTreeView('mainView.yourFeature', {
            treeDataProvider: yourFeatureProvider
        });
        yourFeatureProvider.refresh();
        context.subscriptions.push(yourFeatureProvider.view);
    }
}
```

**Note:** The `when` clause in `package.json` automatically handles showing/hiding the view, but you may still want to check the config in code for additional logic.

#### 5. Update Documentation

**In README.md:**

Update the "Experimental Features" section to describe your feature:

```markdown
#### 16.X. Your Feature Name

Brief description of what your feature does.

**주요 기능:**
- Feature highlight 1
- Feature highlight 2

**현재 상태:**
- 🚧 개발 중 / ✅ 사용 가능

**활성화 방법:**
Set `taskhub.experimental.yourFeature.enabled` to `true` in settings.
```

**In CONTRIBUTING.md:**

Add any developer-specific notes about your feature in a subsection.

#### 6. Testing

Before submitting:

- [ ] Test with feature enabled
- [ ] Test with feature disabled
- [ ] Test toggling the feature on/off
- [ ] Verify view appears/disappears correctly
- [ ] Add unit tests if applicable

### Example: Minimal Experimental Feature

Here's a complete minimal example:

**package.json:**
```json
{
  "configuration": {
    "properties": {
      "taskhub.experimental.helloWorld.enabled": {
        "type": "boolean",
        "default": false,
        "description": "Enable Hello World experimental feature"
      }
    }
  },
  "views": {
    "mainView": [
      {
        "id": "mainView.helloWorld",
        "name": "Hello World (Experimental)",
        "when": "config.taskhub.experimental.helloWorld.enabled"
      }
    ]
  }
}
```

**extension.ts:**
```typescript
class HelloWorldItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}

class HelloWorldProvider implements vscode.TreeDataProvider<HelloWorldItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HelloWorldItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<HelloWorldItem> | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HelloWorldItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<HelloWorldItem[]> {
        return Promise.resolve([
            new HelloWorldItem('Hello'),
            new HelloWorldItem('World')
        ]);
    }
}

export function activate(context: vscode.ExtensionContext) {
    // ... other code ...

    const helloWorldProvider = new HelloWorldProvider(context);
    helloWorldProvider.view = vscode.window.createTreeView('mainView.helloWorld', {
        treeDataProvider: helloWorldProvider
    });
    helloWorldProvider.refresh();
    context.subscriptions.push(helloWorldProvider.view);
}
```

### Real-World Example: Bit Operation Hover

The **Bit Operation Hover** feature is a real implementation of an experimental feature in TaskHub. It demonstrates a hover provider pattern (instead of a TreeView pattern).

**Key implementation points:**

1. **Configuration** (`package.json`):
   ```json
   "taskhub.experimental.bitOperationHover.enabled": {
     "type": "boolean",
     "default": false,
     "description": "Show bit operation results in hover tooltips..."
   }
   ```

2. **No View Required**: This feature extends an existing hover provider instead of creating a new TreeView.

3. **Integration**: Added to `NumberBaseHoverProvider.provideHover()`:
   ```typescript
   // Check if experimental features are enabled (master switch)
   const experimentalConfig = vscode.workspace.getConfiguration('taskhub.experimental');
   const experimentalEnabled = experimentalConfig.get('enabled', false);
   const bitOpEnabled = experimentalConfig.get('bitOperationHover.enabled', false);

   // Both master switch and feature-specific switch must be enabled
   if (!experimentalEnabled || !bitOpEnabled) { return null; }

   // Detect and process bit operations
   const operation = detectBitOperation(lineText, charPosition);
   ```

4. **Testing**: 20 unit tests covering detection, calculation, and formatting.

5. **Documentation**: Added to README.md section 16.1 with usage examples.

This example shows that experimental features don't always need a TreeView - they can also extend existing functionality like hover providers, code actions, or commands.

### Graduation to Stable

When an experimental feature is ready to become stable:

1. Remove the "Experimental" tag from the feature name
2. Remove `taskhub.experimental.` prefix from settings
3. Remove the `when` clause (make it always available)
4. Update all documentation
5. Consider adding a migration path for users with old settings

### Questions?

If you have questions about adding experimental features, please open an issue or discussion on GitHub.
