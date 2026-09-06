# TaskHub

> A VS Code extension that automates repetitive development workflows and provides embedded C/C++ development tooling.

[한국어](README.md) · [English](README.en.md)

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Installation](#installation)
- [Usage](#usage)
- [Security](#security)
- [Configuration](#configuration)
- [Documentation](#documentation)

---

## Features

### Workflow Automation
- **Custom Actions** — Run shell commands, archive operations, string manipulation, and more, all defined in JSON
- **Pipelines** — Chain multiple tasks and pass results via `${task_id.property}` substitution
- **Action Creation Wizard** — Build new actions through an interactive UI, no manual JSON editing required
- **Presets** — Share per-environment action configurations with your team
- **Run History** — Track success/failure status with one-click re-run
- **Input Profiles** — Name reusable input sets from History and run them from an action's menu
- **Quick Action Palette** — Fuzzy-search and run any action through the single `TaskHub: Run Any Action…` command. Recently used items appear at the top (count is configurable)
- **Status Bar Feature Launcher** — Search common tools from the TaskHub status item and quickly reopen the three most recent choices
- **Problem Matcher** — Surface compiler errors / warnings from build output in the Problems panel (built-in `$gcc` / `$tsc` presets or custom regex)

### Sidebar Panels
- **Actions** — Action buttons in tree grouping, with search and filtering
- **Links** — Workspace link management driven by `.vscode/links.json`
- **Favorites** — Frequently-used files with line-number bookmarks
- **History** — Execution log with status indicators

### C/C++ Hover (Embedded-focused)
- **Number Base Hover** — Instant Hex / Dec / Bin conversion with 32-bit bit map
- **SFR Bit Field Hover** — Special Function Register bit field info (position, access type, reset value, mask)
- **Register Decoder Hover** — Decode register literals into per-field values
- **Macro Expansion Hover** — Final expansion result of `#define` macros
- **Struct Size Hover** — Struct/class size, member offsets, and padding
- **Bit Operation Hover** *(experimental)* — Preview bit operation results

### Viewers
- **Memory Map Visualization** — Analyze ELF/AXF and ARM Linker Listings, show memory regions, and connect symbol/section bytes and DWARF source locations
- **Hex Viewer** — Address / hex / ASCII columns with Unit, Endian, Go-to, and Find
- **Hex/Text Converter** — Convert text and Hex bytes in real time, save reusable values, and run 8/16/32/64-bit bitwise calculations
- **JSON Editor** — Spreadsheet-style JSON editing

> See [docs/features.md (Korean)](docs/features.md) for detailed explanations and JSON examples.

---

## Screenshots

### Workflow — Build → Verify → ZIP

Generate a sensor data binary, verify it, and archive it in one action, with output and run history in view. [Runnable example](examples/sensor_pipeline/README.md)

![TaskHub Build → Verify → ZIP action with output and History](docs/images/workflow-overview.jpg)

### Memory Map — Usage and region details

Inspect Flash and RAM usage from an ARM Linker Listing, then expand a region to see its sections and functions.

![Flash and RAM usage with an expanded memory region](docs/images/memory-map-detail.jpg)

### Register Decoder — Read register values

Hover over `UartCtrlReg uart_ctrl = 0x30B` to read fields such as `tx_en`, `rx_en`, and `baud_sel`.

![Hover decoding 0x30B into UartCtrlReg bit fields](docs/images/hover-register-decoder.jpg)

### Hex/Text — Conversion, saved values, and bitwise calculations

Convert `TaskHub` to Hex and save reusable values. Calculate a 64-bit mask such as `0x123456789ABCDEF0 & 0xFFFF` in the same view.

![Hex/Text Converter showing TaskHub text as Hex bytes and saved values](docs/images/hex-text-converter.jpg)

![64-bit mask expression with Hex, Decimal, and Binary results](docs/images/hex-bitwise-calculator.jpg)

### Struct Size — Size and padding

Check the estimated size, member offsets, and padding of `PacketHeader` directly in the editor.

![Hover showing estimated PacketHeader size, member offsets, and padding](docs/images/hover-struct-size.jpg)

### JSON Editor — Edit device settings

View and edit device names, addresses, enabled states, and tags from `devices.json` in a table.

![JSON Editor showing device names, addresses, enabled states, and tags](docs/images/json-editor-devices.jpg)

<details>
<summary>More feature examples</summary>

**Quick Action Palette** — Search recent runs and all available actions.

![Quick Action Palette showing recent runs and action search](docs/images/quick-action-palette.png)

**Problem Matcher** — View build diagnostics in the Problems panel.

![Build diagnostics in the Problems panel](docs/images/problem-matcher.png)

**Number Base Hover** — Inspect number base conversions and bit information.

![Hover showing number base conversions and bit information](docs/images/hover-number-base.png)

**SFR Bit Field Hover** — Inspect bit positions, access types, and reset values.

![Hover showing register bit field information](docs/images/hover-sfr-bit-field.png)

**Macro Expansion Hover** — Read the final expansion of a `#define` macro.

![Hover showing the final macro expansion](docs/images/hover-macro-expansion.png)

**Hex Viewer** — Inspect binary addresses, Hex bytes, and ASCII together.

![Hex Viewer displaying sample_binary.bin](docs/images/hex-viewer.png)

</details>

---

## Installation

### Manual install (VSIX)

1. Download the latest `.vsix` from [Releases](https://github.com/MunseopLim/TaskHub/releases)
2. In VS Code, press `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) → **Extensions: Install from VSIX...**
3. Select the downloaded `.vsix` file

To build from source or contribute, see [CONTRIBUTING.md (Korean)](CONTRIBUTING.md).

---

## Usage

1. Open your project folder in VS Code, then click the **'H' icon** in the Activity Bar.
2. Choose **Create Action** or **+** in the Actions panel, then select **Direct Command**.
3. Enter a title and command. Try `echo Hello TaskHub` to check your first action.
4. Review the action, choose **Save**, then **Run now**, or run the saved action from the Actions panel.

Find other tools through the **TaskHub** status bar launcher. For action fields, results, and composition
examples, see the [`actions.json` authoring guide (Korean)](docs/actions.md).

When writing configuration, start with these guides (in Korean):

- [Command configuration and the resulting arguments](docs/actions.md#4-명령-실행): `command`/`shell`, spaces, quotes, Windows paths, and shell selection
- [Run an argument inspection example](examples/command_shell/README.md): compare strings, arrays, and environment variables with Node.js
- [Combine input and execution tasks](docs/actions.md#10-자주-쓰는-조합): pass file selections and QuickPick options to a command

Before choosing a tool, check its supported inputs:

- [C/C++ Hover (Korean)](docs/features.md#15-cc-hover-기능): resolving symbols uses a C/C++ language extension. Struct layout is an estimate based on configured type sizes and alignment.
- [Memory Map (Korean)](docs/features.md#19-memory-map-시각화) supports ELF32 and ARM Linker Listings; [Hex Viewer (Korean)](docs/features.md#20-hex-viewer) accepts files up to 50 MB.
- [JSON Editor (Korean)](docs/features.md#json-editor-커맨드) requires an object or array at the JSON root.
- [Browser actions (Korean)](docs/actions.md#browser) cannot open remote host file paths directly; use an HTTP URL in Remote SSH, Dev Containers, and Codespaces.

---

## Security

TaskHub actions are **executable configuration** that can run commands with your workspace permissions. Do not
run actions from an untrusted repository or `.taskhub` file. TaskHub is disabled in VS Code Restricted Mode.
Every import shows its actions, commands, and file operations before changing `actions.json`, regardless of Doctor
findings, and reviewing the complete source is the default action. No additional finding does not mean that a
fixed malicious command is safe; see [TaskHub Doctor (Korean)](docs/features.md#23-taskhub-doctor-action-lint) for the
full set of checks.

---

## Configuration

Open `File > Preferences > Settings` in VS Code and search for **"TaskHub"** to browse every setting in a categorized UI. The two dials users tweak most often are `taskhub.runAnyAction.recentLimit` (number of items in the *Recently used* section of Quick Action Palette) and `taskhub.history.maxItems` (how many runs the History panel keeps).

The canonical setting definitions live in `contributes.configuration` in [package.json](package.json). The user-facing list of keys, defaults, ranges, related features, and the update checklist is maintained in [docs/features.md §21 Settings Reference](docs/features.md#21-설정-레퍼런스) (Korean).

---

## Documentation

The detailed guides below are currently available in Korean.

| Doc | Description |
|------|------|
| [docs/actions.md](docs/actions.md) | `actions.json` authoring, task types, fields, results, and composition examples |
| [docs/features.md](docs/features.md) | Feature reference for panels, hover, JSON Editor, Hex/Memory Map, and more |
| [docs/architecture.md](docs/architecture.md) | Project structure, key components, data structures, security |
| [docs/roadmap.md](docs/roadmap.md) | Priorities for unshipped features and technical debt |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, build, test, and contribution guide |
| [CLAUDE.md](CLAUDE.md) | AI-agent rules (coding conventions, i18n, commit format) |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [examples/README.md](examples/README.md) | Demo files for each feature |

---

## License

[MIT](LICENSE)
