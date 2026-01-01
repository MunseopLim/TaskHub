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
