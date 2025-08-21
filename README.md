# Firmware Toolkit VS Code Extension

This VS Code extension provides a set of utility features for firmware development, accessible through a custom Activity Bar view.

## Features

### 1. Custom Main View

The extension introduces a custom view container in the VS Code Activity Bar, identified by an 'H' icon. This main view (`mainView`) hosts two sub-views:

*   **Main Panel (`mainView.main`)**: Contains various action buttons and information.
*   **Links Panel (`mainView.link`)**: Displays a list of configurable links.

### 2. Custom Icon

The main view in the Activity Bar uses a custom 'H' shaped SVG icon (`media/h_icon.svg`).

### 3. Links Panel (`mainView.link`)

This panel displays a list of links defined in `media/links.json`.

*   **Configurable Links**: Links are loaded from `media/links.json`. Each entry has a `title` and a `link` URL.
    ```json
    [
      {
        "title": "Google",
        "link": "https://www.google.com"
      },
      {
        "title": "VS Code Docs",
        "link": "https://code.visualstudio.com/docs"
      }
    ]
    ```
*   **Link Icon**: Each link item is prefixed with a standard link icon.
*   **Click to Open**: Clicking a link item will open the corresponding URL in your default web browser.
*   **Context Menu**: Right-clicking a link item provides two options:
    *   `Copy Link`: Copies the URL to the clipboard.
    *   `Go to Link`: Opens the URL in the default web browser (same as clicking).

### 4. Main Panel (`mainView.main`)

This panel provides various configurable actions, defined in `media/actions.json`.

*   **Configurable Buttons**: Any item in `media/actions.json` with an `id` starting with `button.` will be rendered as a clickable button.
    ```json
    [
      {
        "id": "button.build",
        "title": "Build",
        "action": {
          "type": "shell",
          "command": "echo 'Building...'",
          "cwd": "${workspaceFolder}",
          "revealTerminal": "always",
          "successMessage": "Build completed successfully!",
          "failMessage": "Build failed. Check terminal for details."
        }
      },
      {
        "id": "button.openExplorer",
        "title": "Open Project Directory",
        "action": {
          "type": "shell",
          "command": "open .",
          "cwd": "${workspaceFolder}",
          "revealTerminal": "silent",
          "successMessage": "Project directory opened."
        }
      }
    ]
    ```
*   **Separators**: Items with `type: "separator"` will be rendered as visual separators.
    ```json
    {
      "id": "separator.1",
      "type": "separator",
      "title": "------------"
    }
    ```
*   **Configurable Terminal Behavior (`revealTerminal`)**: For `shell` type actions, you can control the terminal's visibility:
    *   `"always"`: Terminal will always be brought to the foreground.
    *   `"silent"`: Terminal will run in the background without showing.
    *   `"never"`: Terminal will run in the background and the panel will not be revealed.
    If not specified, defaults to `silent`.
*   **Success/Failure Notifications (`successMessage`, `failMessage`)**: For `shell` type actions, you can define messages to be displayed as VS Code notifications upon task completion:
    *   `"successMessage"`: Displayed if the task completes with exit code 0.
    *   `"failMessage"`: Displayed if the task completes with a non-zero exit code.
    These properties are optional. If omitted, no notification will be shown for that outcome.
*   **Executable Picker**: A special action type (`executablePicker`) that allows selecting and running executables from a specified folder.
    ```json
    {
      "id": "button.selectExecutable",
      "title": "Select Executable",
      "action": {
        "type": "executablePicker",
        "folder": "${workspaceFolder}/bin",
        "runCommand": "bash ${file}"
      }
    }
    ```
    *   `folder`: The directory to scan for executable files. Supports `${workspaceFolder}`.
    *   `runCommand`: The command template to execute the selected file. `${file}` will be replaced by the full path of the selected executable.
    *   **Note on `runCommand` for Windows**: For Windows, `bash ${file}` might need to be adjusted based on your shell (e.g., `cmd.exe /c ""${file}""` for batch files, `powershell.exe -File ""${file}""` for PowerShell scripts, or simply `""${file}""` for `.exe` files).

### 5. Extension Version Display

The `mainView.main` panel displays the current version of the extension as a non-clickable label at the top.

### 6. Show Extension Version Command

A command `firmware-toolkit.showVersion` is available in the Command Palette (Ctrl+Shift+P or Cmd+Shift+P) that displays the extension's version in an information message.

## Installation

1.  Clone this repository.
2.  Open the project in VS Code.
3.  Run `npm install` in the terminal.
4.  Press `F5` to run the extension in a new Extension Development Host window.

## Usage

1.  Click the 'H' icon in the Activity Bar to open the Firmware Toolkit view.
2.  Explore the 'Main Panel' for various actions and the 'Links Panel' for quick access to resources.
3.  Modify `media/actions.json` and `media/links.json` to customize the buttons and links.

## Development

*   `npm run compile`: Compiles the TypeScript source code.
*   `npm run watch`: Compiles the code in watch mode.
*   `npm run test`: Runs the extension tests.

---

**Note**: This README is generated based on the features implemented up to this point. For the most up-to-date information, please refer to the source code.