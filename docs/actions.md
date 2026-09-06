# `actions.json` 작성 가이드

이 문서는 코드를 보지 않고 `.vscode/actions.json`을 작성하기 위한 사용 레퍼런스입니다.
정확한 JSON 형식은 [`schema/actions.schema.json`](../schema/actions.schema.json)이 정의하며, 기능의 화면 동작과
설정은 [`features.md`](features.md)를 참고합니다.

## 목차

1. [가장 작은 액션](#1-가장-작은-액션)
2. [태스크 선택표](#2-태스크-선택표)
3. [공통 작성 규칙](#3-공통-작성-규칙)
4. [명령 실행](#4-명령-실행)
5. [사용자 입력](#5-사용자-입력)
6. [파일·브라우저·아카이브·값 변환](#6-파일브라우저아카이브값-변환)
7. [조건·분기·반복](#7-조건분기반복)
8. [출력 캡처와 표시](#8-출력-캡처와-표시)
9. [변수 참조](#9-변수-참조)
10. [자주 쓰는 조합](#10-자주-쓰는-조합)
11. [실행 전 확인](#11-실행-전-확인)

## 1. 가장 작은 액션

`actions.json`의 최상위 값은 배열입니다. 실행 가능한 항목은 `id`, `title`, `action`을 가지며,
`description`, `tasks`, `successMessage`, `failMessage`는 모두 **`action` 안에** 작성합니다.

파일 위치·생성/편집 방법·저장 후 자동 반영은 [JSON 설정 파일](features.md#3-json-설정-파일)과
[설정 파일 편집](features.md#13-쉬운-설정-관리)을 참고하세요.

아래는 파일 전체로 사용할 수 있는 액션 배열입니다. 실행하려면 액션 워크스페이스에 `package.json`과
`scripts.build`가 있어야 하며, 필요한 의존성도 설치되어 있어야 합니다. npm 프로젝트가 없으면
[명령 실행 예제](#4-명령-실행)부터 사용하세요.

```json
[
  {
    "id": "project.build",
    "title": "Build project",
    "action": {
      "description": "프로젝트를 빌드합니다.",
      "successMessage": "빌드가 끝났습니다.",
      "failMessage": "빌드에 실패했습니다.",
      "tasks": [
        {
          "id": "build",
          "type": "command",
          "command": "npm",
          "args": ["run", "build"]
        }
      ]
    }
  }
]
```

- `id`: 다른 액션과 겹치지 않는 고정 식별자
- `title`: Actions 뷰에 표시되는 이름
- `action.description`: 액션 설명
- `action.tasks`: 실행할 태스크 배열. 기본적으로 위에서 아래로 실행
- `action.successMessage`, `action.failMessage`: 선택적인 완료·실패 메시지

이후 예제에서 **태스크 객체 하나 또는 쉼표로 연결한 여러 태스크**는 기존 액션의 `action.tasks` 배열에
넣는 부분 예제입니다. `"output": { ... }` 같은 필드 조각은 해당 태스크 안에 합칩니다. 부분 예제를
파일 전체로 저장하지 마세요. `tool`, `builder`, `parser.py`, `inspect.py` 등은 사용 환경의 프로그램으로
바꿔야 하는 이름이며 TaskHub가 설치하거나 생성하지 않습니다.

액션을 폴더로 묶거나 구분선을 넣을 수도 있습니다.

```json
[
  {
    "id": "tools",
    "title": "Tools",
    "type": "folder",
    "children": []
  },
  {
    "id": "separator.build",
    "title": "Build",
    "type": "separator"
  }
]
```

## 2. 태스크 선택표

모든 태스크에는 액션 안에서 고유한 `id`와 `type`이 필요합니다.

| 원하는 동작 | `type` | 주요 필드 | 주요 결과 |
| --- | --- | --- | --- |
| argv로 프로그램 실행 | `command` | `command`, `args` | 캡처 시 `output`, `stderr` |
| 셸 문법이 있는 문자열 실행 | `shell` | `command`, `args` | 캡처 시 `output`, `stderr` |
| 파일 선택 | `fileDialog` | `options` | `path`, `paths`, `name`, `dir` |
| 폴더 선택 | `folderDialog` | `options` | `path`, `paths`, `name`, `dir` |
| 파일·폴더 종류를 실행 시 결정 | `pathDialog` | `mode`, `options` | `path`, `paths`, `name`, `dir` |
| 문자열 입력 | `inputBox` | `prompt`, `value` | `value` |
| 목록에서 선택 | `quickPick` | `items` 또는 `itemsFromCommand` | `value`, `args`, `label`, `valueList` |
| 환경변수 이름 선택 | `envPick` | `placeHolder` | `value` |
| 계속 진행할지 확인 | `confirm` | `message` | 확인 시 `confirmed` |
| 문자열·경로 변환 | `stringManipulation` | `function`, `input` | `output` |
| 파일 작성·추가 | `writeFile`, `appendFile` | `path`, `content` | `path` |
| URL·로컬 파일을 브라우저로 열기 | `browser` | `url`, `target`, `cwd` | `url`, 로컬 파일이면 `path` |
| ZIP 압축·해제 | `zip`, `unzip` | `source`/`archive`/`destination` | `archivePath`/`outputDir` |
| 선택값에 따라 작업 변경 | `switch` | `on`, `cases` | `matched`, `selected`, 선택 case 결과 |

## 3. 공통 작성 규칙

### 실행 순서와 실패

태스크는 기본적으로 배열 순서대로 실행되고 첫 실패에서 액션이 중단됩니다.

| 필드 | 동작 |
| --- | --- |
| `timeoutSeconds` | 태스크 전체의 제한 시간(초). `0` 또는 생략은 이 제한만 비활성화 |
| `continueOnError` | 기본 `false`. `true`이면 실패·timeout·입력 취소 시 결과를 `{}`로 두고 다음 태스크 실행 |
| `when` | 조건이 참일 때만 실행 |
| `dependsOn` | 먼저 끝나야 할 태스크 ID 배열 |
| `parallel` | `true`이면 앞선 모든 태스크를 기다리는 기본 장벽에서 제외 |
| `forEach` | 배열의 각 값을 대상으로 비대화형 태스크를 반복 |

`${taskId.key}` 참조가 있으면 해당 태스크에 대한 의존성은 자동으로 잡힙니다. 병렬 실행의 자세한 규칙은
[`features.md`의 병렬 실행 / Task DAG](features.md#24-병렬-실행--task-dag)를 참고합니다.

대화상자에서 입력을 기다리는 시간도 `timeoutSeconds`에 포함됩니다. [동적 QuickPick](#quickpick)의
목록 생성 명령은 별도 제한이 있으므로 `timeoutSeconds: 0`으로 그 제한까지 해제되지는 않습니다.
사용자가 **액션 중지**를 누르면 `continueOnError`와 관계없이 액션을 중단합니다.

### 동적 값은 `args`에 넣기

파일 경로나 사용자 입력은 `command`의 `args`에 별도 원소로 넣는 것이 안전합니다.

```json
{
  "id": "run",
  "type": "command",
  "command": "python",
  "args": ["script.py", "${target.path}"]
}
```

`shell` 문자열에 `${target.path}`를 직접 넣으면 그 값도 셸 문법으로 다시 해석됩니다. 값이 `-`로 시작할
수 있다면 대상 프로그램이 옵션으로 읽을 수 있으므로, 프로그램이 지원하는 경우 `--` 뒤에 둡니다.

### 입력 취소

`inputBox`, `quickPick`, `envPick`, `confirm`, 파일·폴더 대화상자를 취소하면 액션도 취소됩니다.
`continueOnError: true`인 태스크만 빈 결과 `{}`로 두고 다음 태스크를 계속 실행합니다.

## 4. 명령 실행

[JSON → 실제 인자](#json에서-실제-인자로) · [공백·따옴표](#명령-칸에-어디까지-써도-되는가) ·
[Windows 경로](#windows-실행-파일-경로와-json-역슬래시) · [shell의 인자 추가](#shellargs는-본문-맨-뒤에-붙는다) ·
[실행 셸](#실행되는-셸) · [작업 폴더·환경변수](#작업-폴더와-환경변수) · [출력 확인](#종료-시점과-출력-확인)

### 먼저 `type` 고르기

두 타입 모두 `command`라는 **필드**를 사용합니다. `type`이 그 필드를 해석하는 방법을 결정합니다.
아래 예시는 실행 파일과 전달 인자를 구분하고, 전달 인자는 **인자 1**부터 표시합니다.

| 작성하려는 명령 | 선택 | 이유 |
| --- | --- | --- |
| `npm run build`, `python flash.py --board stm32` | `command` | 실행 파일과 인자를 구분해 전달 |
| 파일 선택 결과, 공백 있는 경로, QuickPick 옵션 전달 | `command` + `args` | 각 인자의 경계를 유지 |
| `npm run build && npm test`, `git log > history.txt` | `shell` | 셸이 연산자·리다이렉션을 해석해야 함 |
| 빌드 성공 후 테스트 실행 | `command` 태스크 두 개도 가능 | 기본 순차 실행이므로 첫 실패에서 중단 |

TaskHub가 Python·Node.js·컴파일러를 설치하지는 않습니다. 사용할 프로그램은 해당 실행 환경의 PATH에서
찾을 수 있거나, `command`에 실행 파일 경로가 있어야 합니다. 예시의 `flash.py`, `parser.py` 등은
사용자 프로젝트의 스크립트 이름입니다. 설치된 Node.js만으로 인자 전달을 확인하려면
[실행 가능한 command/shell 예제](../examples/command_shell/README.md)를 사용하세요.

### `command`

`command`의 첫 토큰은 실행 파일, 나머지 토큰은 앞쪽 인자가 됩니다. 그 뒤에 `args`의 원소를 순서대로
붙입니다. `args`는 문자열 배열이므로 숫자 옵션도 `"8080"`처럼 씁니다. 공백이 든 값은 한 원소로 쓰면 됩니다.

#### JSON에서 실제 인자로

워크스페이스가 `/work/sensor`, 앞서 고른 `${board}`가 `STM32 F4`, `${firmware.path}`가
`/work/sensor/release files/app.bin`이라고 가정합니다.

```json
{
  "id": "flash",
  "type": "command",
  "command": "python3",
  "args": ["flash.py", "--board", "${board}", "${firmware.path}"],
  "cwd": "${workspaceFolder}",
  "env": { "MODE": "release" },
  "revealTerminal": "always"
}
```

실행할 프로그램과 인자는 다음과 같습니다. `cwd`와 `env`는 인자에 추가되지 않고 실행 환경으로 전달됩니다.

```text
실행 파일: python3
인자 1: flash.py
인자 2: --board
인자 3: STM32 F4
인자 4: /work/sensor/release files/app.bin
cwd:     /work/sensor
추가 환경변수: MODE=release
```

macOS/Linux에서 TaskHub가 조립하는 명령줄은 다음과 같습니다. 작은따옴표는 셸에 인자 경계를
알리는 문법이며 Python이 받는 값에는 포함되지 않습니다.

```sh
python3 'flash.py' '--board' 'STM32 F4' '/work/sensor/release files/app.bin'
```

#### 명령 칸에 어디까지 써도 되는가

다음 세 작성법은 모두 실행 파일 `npm`, argv `['run', 'build']`로 해석됩니다.

```jsonc
{ "id": "build", "type": "command", "command": "npm", "args": ["run", "build"] }
{ "id": "build", "type": "command", "command": "npm run", "args": ["build"] }
{ "id": "build", "type": "command", "command": "npm run build" }
```

위 세 줄은 **서로 대체하는 태스크 예시**입니다. 하나만 골라 `action.tasks`에 넣습니다.
마법사의 **단일 명령 실행 (Direct Command)** 입력 칸에는 마지막 형태처럼 `npm run build`를 입력할 수 있습니다.
고정된 옵션이 길거나 동적 입력을 사용한다면 첫 번째 형태가 인자 개수를 확인하기 쉽습니다.

| `args` 작성값 | 프로그램이 받는 인자 |
| --- | --- |
| `["--board", "STM32 F4"]` | `--board`, `STM32 F4` 두 개 |
| `["--board STM32 F4"]` | `--board STM32 F4` 한 개 |
| `["\"STM32 F4\""]` | 큰따옴표까지 포함한 `"STM32 F4"` 한 개 |
| `[""]` | 길이 0인 인자 한 개 |
| `[]` 또는 생략 | 추가 인자 없음 |
| `["*.bin", "$HOME", "&&", ">"]` | 네 문자열 그대로. 파일 목록 확장·환경변수 확장·명령 연결·리다이렉션 없음 |

예를 들어 `"command": "node probe.cjs && node --version"`를 **`type: "command"`**로 쓰면,
실행 파일은 `node`, 인자는 `['probe.cjs', '&&', 'node', '--version']`입니다.
`probe.cjs`가 `&&`, `node`, `--version`을 데이터로 받고, 두 번째 Node.js는 실행되지 않습니다.
또한 `command` 안의 따옴표는 토큰을 묶는 데 쓰지만, `args` 안에 직접 넣은 따옴표는 데이터입니다.
`command`의 토큰은 변수 치환 **전에** 구분되므로 치환된 `STM32 F4`도 한 인자로 유지됩니다.

Windows의 `.cmd`·`.bat`(예: `npm.cmd`)는 배치 처리기에서 인자를 다시 해석할 수 있습니다.
위 인자 보존 예시는 `node.exe`·`python.exe`처럼 직접 실행되는 프로그램을 기준으로 합니다.
따옴표나 `&`, `|`가 포함된 동적 값을 배치 파일에 전달한다면 해당 도구에서도 실제 인자를 확인하세요.
이 차이는 [PowerShell의 외부 프로그램 인자 전달 규칙](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing#passing-arguments-that-contain-quote-characters)에도 설명되어 있습니다.

#### Windows 실행 파일 경로와 JSON 역슬래시

공백 있는 **실행 파일 경로**는 `command` 안에서도 따옴표로 묶습니다. JSON의 `\"`는 실제 큰따옴표,
`\\`는 실제 역슬래시 한 글자가 됩니다. 반면 `args`의 경로는 원소 하나이므로 추가 인용을 하지 않습니다.

```json
{
  "id": "flashWindows",
  "type": "command",
  "command": "\"C:\\Program Files\\Python312\\python.exe\"",
  "args": ["C:\\work\\flash.py", "C:\\work\\release files\\app.bin"],
  "cwd": "C:\\work"
}
```

```text
실행 파일: C:\Program Files\Python312\python.exe
인자 1: C:\work\flash.py
인자 2: C:\work\release files\app.bin
```

경로는 실제 설치 위치로 바꾸세요. `command`에 `C:\\Program Files\\...`를 인용 없이 쓰면
`C:\Program`이 첫 토큰이 됩니다. 프로그램별로 다른 Windows 인용 규칙을 피하려면 `.py`·`.js` 파일을
직접 실행하기보다 위처럼 `python.exe`나 `node.exe`에 스크립트 경로를 인자로 전달하세요.

#### 여러 OS에서 같은 액션 쓰기

`command`는 OS별 객체도 받습니다. 실행 중인 OS의 키만 선택하며, 해당 키가 없을 때 다른 OS 값으로
대체하지 않습니다. `args`, `cwd`, `env`는 공통으로 사용합니다.

```json
{
  "id": "checkPython",
  "type": "command",
  "command": { "windows": "python", "macos": "python3", "linux": "python3" },
  "args": ["--version"]
}
```

`cmd.exe` 문법이나 Bash 전용 문법을 꼭 써야 한다면 실행할 인터프리터를 명시할 수 있습니다.
다음은 각각 Windows와 Bash가 설치된 환경에서만 사용하는 태스크입니다.

```jsonc
{ "id": "cmdVersion", "type": "command", "command": "cmd.exe", "args": ["/d", "/c", "ver"] }
{ "id": "bashVersion", "type": "command", "command": "bash", "args": ["-c", "printf '%s\\n' \"$BASH_VERSION\""] }
```

이 경우 마지막 인자는 TaskHub에서 한 문자열로 전달된 뒤, **명시적으로 실행한 인터프리터**가 다시
해석합니다. `command` 타입을 사용했더라도 그 스크립트 문자열에 사용자 입력을 이어 붙이지 마세요.

### `shell`

`command` 문자열을 먼저 변수 치환한 뒤 셸 본문으로 사용합니다. `&&`, `|`, `>`, 셸 변수 등이
본문에 있으면 셸 문법으로 동작합니다. 예를 들어 다음은 `npm run build`가 성공한 경우에만 `npm test`를 실행합니다.

```json
{
  "id": "buildAndTest",
  "type": "shell",
  "command": "npm run build && npm test"
}
```

```sh
npm run build && npm test
```

#### `shell.args`는 본문 맨 뒤에 붙는다

`shell`에서도 `args`의 각 원소는 인용한 데이터로 붙습니다. **본문 안의 특정 위치를 대신 채우거나
모든 명령에 나누어 전달하지 않습니다.**

```json
{
  "id": "afterVersion",
  "type": "shell",
  "command": "node --version && node",
  "args": ["probe.cjs", "two words", "*.bin"],
  "cwd": "examples/command_shell"
}
```

macOS/Linux에 전달되는 본문:

```sh
node --version && node 'probe.cjs' 'two words' '*.bin'
```

두 번째 `node`만 `['probe.cjs', 'two words', '*.bin']`을 받습니다. `*.bin`도 파일 목록으로 펼쳐지지 않습니다.
`command`가 `producer | consumer`이면 추가 인자는 `consumer` 뒤에 붙습니다.
`args`에 `">"`, `"result.txt"`를 넣어도 파일 리다이렉션은 생기지 않습니다. 반대로 본문이 `> result.txt`로
끝날 때 `args`를 추가하면 셸이 완성된 문자열 전체를 해석하므로, 의도한 프로그램의 인자가 되는지 확인해야 합니다.

#### 환경변수 확장과 리터럴 비교

[인자 출력 예제](../examples/command_shell/README.md)의 `probe.cjs`를 사용하면 차이를 직접 볼 수 있습니다.
저장소 루트를 워크스페이스로 연 상태에서 다음 태스크를 실행합니다.

```json
{
  "id": "inspect",
  "type": "shell",
  "command": {
    "windows": "node probe.cjs --expanded \"$env:TASKHUB_DEMO\"",
    "macos": "node probe.cjs --expanded \"$TASKHUB_DEMO\"",
    "linux": "node probe.cjs --expanded \"$TASKHUB_DEMO\""
  },
  "args": ["--literal", "$TASKHUB_DEMO"],
  "cwd": "examples/command_shell",
  "env": { "TASKHUB_DEMO": "demo value" },
  "passTheResultToNextTask": true,
  "output": { "mode": "editor", "language": "json" }
}
```

macOS/Linux에서 셸에 전달되는 본문:

```sh
node probe.cjs --expanded "$TASKHUB_DEMO" '--literal' '$TASKHUB_DEMO'
```

Windows에서 PowerShell에 전달되는 본문(인코딩·종료 상태 전달용 래퍼 제외):

```powershell
node probe.cjs --expanded "$env:TASKHUB_DEMO" '--literal' '$TASKHUB_DEMO'
```

예제 출력의 `argv`는 `process.argv.slice(2)`로, Node.js 실행 파일과 `probe.cjs` 경로를 제외합니다.
두 경우 이 목록은 같습니다. 본문의 큰따옴표 안 변수는 값으로 확장되고,
TaskHub가 작은따옴표로 감싼 `args` 값은 원문으로 전달됩니다.

```json
["--expanded", "demo value", "--literal", "$TASKHUB_DEMO"]
```

#### 실행되는 셸

| 환경 / 모드 | 셸 선택 |
| --- | --- |
| macOS/Linux, 일반 터미널 실행 | VS Code의 작업용 셸 설정을 사용 |
| macOS/Linux, 출력 캡처 | `/bin/sh` 사용. 사용자의 로그인 셸이 zsh여도 동일 |
| macOS/Linux, `isOneShot: true` | 셸 본문을 `sh -c`로 감싸 백그라운드 실행 |
| Windows, 셸 본문 실행 | 기본 `powershell.exe`(Windows PowerShell 5.1), `-NoProfile` 사용 |
| Windows, 본문에 인용되지 않은 `&&` 또는 `||` 사용 | PowerShell 7의 `pwsh.exe`를 PATH와 표준 설치 위치에서 탐색. 없으면 실행 전 오류 안내 |

Windows에서 `shell.command`가 `node`처럼 인자 없는 실행 파일 토큰 하나이고 직접 실행할 수 있으면,
명시적 `args`의 따옴표를 보존하기 위해 네이티브 실행 경로를 사용합니다. 셸 문법이 있는 본문은 PowerShell이 해석합니다.
`command` 타입도 Windows의 `.exe`·`.com`은 가능한 경우 직접 실행하고, `npm.cmd` 같은 shim이나 셸 명령은
PowerShell을 통해 인용된 인자를 전달합니다. POSIX의 `command`는 각 인자를 인용해 셸에 전달합니다.
따라서 화면에 표시되는 인용 부호나 실행 래퍼는 플랫폼에 따라 달라도, 설정할 때 기준으로 삼을 것은
위의 **실행 파일과 argv 경계**입니다. Windows 스크립트/shim을 거치는 인자의 세부 처리는 해당 도구의 파서에도 영향을 받습니다.

PowerShell 7이 설치되어 있어도 `&&`·`||`가 없는 본문을 자동으로 7로 바꾸지는 않습니다.
`%NAME%`, `dir /b`는 cmd 문법이므로 PowerShell 본문에 그대로 쓰지 말고 앞의 `cmd.exe` 예시처럼
인터프리터를 명시하세요. Bash 전용 문법도 캡처 모드의 `/bin/sh`에 기대지 말고 Bash를 직접 실행하세요.

단순히 빌드 다음에 테스트를 실행하려는 경우에는 다음처럼 나누면 각 단계의 상태를 따로 볼 수 있습니다.
프로젝트의 `package.json`에 `build`, `test` 스크립트가 있어야 합니다.

```json
[
  {
    "id": "project.check",
    "title": "Build and test",
    "action": {
      "description": "빌드 성공 후 테스트를 실행합니다.",
      "tasks": [
        { "id": "build", "type": "command", "command": "npm", "args": ["run", "build"] },
        { "id": "test", "type": "command", "command": "npm", "args": ["test"] }
      ]
    }
  }
]
```

### 작업 폴더와 환경변수

| 필드 | 설명 |
| --- | --- |
| `cwd` | 프로세스의 작업 디렉터리. 상대 경로는 액션 워크스페이스 기준. 생략 시 액션 워크스페이스 |
| `env` | 상속한 환경변수에 추가·덮어쓸 문자열 맵. `env` 값도 TaskHub 변수 치환 지원 |
| `revealTerminal` | 일반 터미널 표시 방식. 기본 `always`, VS Code의 조건부 표시 `silent`, 자동으로 열지 않는 `never` |
| `passTheResultToNextTask` | 기본 `false`. `true`이면 완료 후 stdout/stderr를 결과로 제공 |
| `isOneShot` | 기본 `false`. `true`이면 실행 시작 후 다음 단계로 진행. 캡처와 함께 쓰지 않음 |
| `output` | 캡처 결과의 표시·저장·추출·Problems 진단. [출력 캡처와 표시](#8-출력-캡처와-표시) 참조 |

`cwd`는 `command`, `shell`, 동적 `quickPick`, `browser`, 내장·외부 `zip`/`unzip`에서 같은
기준을 사용합니다. 워크스페이스가 `/work/sensor`일 때 `"cwd": "build"`는 `/work/sensor/build`이며,
그 명령의 `args: ["script.py"]`는 보통 `/work/sensor/build/script.py`를 가리킵니다.
`cwd`는 폴더를 생성하지 않으므로 미리 존재해야 합니다. 앞 태스크에서 `cd`해도 다음 태스크의 작업 폴더는
바뀌지 않습니다. 필요한 태스크에 각각 `cwd`를 지정하세요.

워크스페이스 없이 상대 `cwd`를 지정하면 오류로 안내합니다. 절대 `cwd`를 쓰거나 프로젝트 폴더를 여세요.
`cwd`와 워크스페이스가 모두 없을 때 명령·아카이브는 확장 호스트의 작업 디렉터리를 사용합니다.
`writeFile.path`와 `output.filePath`는 프로세스 `cwd`가 아니라 액션 워크스페이스를 기준으로 해석합니다.

환경변수는 다음 두 방법을 구분합니다.

| 작성 위치 | 해석 시점 / 예 |
| --- | --- |
| `args: ["${env:MODE}"]` | TaskHub가 실행 시작 시 캡처한 확장 호스트의 `MODE` 값으로 치환 |
| `env: { "MODE": "release" }` | 이 태스크의 자식 프로세스에 `MODE=release`를 전달 |
| `shell.command`의 `$MODE`(POSIX), `$env:MODE`(PowerShell) | 셸이 자식 프로세스 환경에서 확장 |
| `command.args`의 `"$MODE"` | 환경변수 이름을 포함한 문자열 그대로 전달 |

`env.MODE`를 지정해도 같은 태스크의 `${env:MODE}`가 그 새 값을 읽지는 않습니다. 여러 태스크에 같은
값이 필요하면 앞선 입력 결과를 각각 참조하세요. `export`·`set`을 실행해도 다른 태스크의 환경까지
변경되지는 않습니다. 환경변수 참조 등 민감 문맥을 사용하는 태스크의 출력 제한은 [민감한 입력](#민감한-입력)을 참고하세요.

### 종료 시점과 출력 확인

기본 실행은 프로세스가 끝날 때까지 기다리고, 종료 코드가 0이 아니면 실패합니다. `stderr`에 글자가
있다는 이유만으로 실패하는 것은 아닙니다. `shell` 안의 `;`나 파이프 `|`는 해당 셸의 종료 상태 규칙을
따르므로, 앞쪽 명령의 실패도 반드시 잡아야 한다면 태스크를 나누세요.

| 목적 | 설정과 확인 위치 |
| --- | --- |
| 빌드 로그를 실시간으로 보기 | 캡처 옵션 생략. 일반 터미널에 출력 |
| 다음 태스크에서 stdout 사용 | `passTheResultToNextTask: true`, `${taskId.output}` 참조 |
| 캡처한 결과를 화면으로 보기 | 위 옵션 + `output: { "mode": "editor" }` 또는 `"terminal"` |
| 오래 실행되는 프로그램을 시작하고 바로 계속하기 | `isOneShot: true`. 완료·준비 상태나 최종 성공을 기다리지 않음 |

`isOneShot`은 서버가 요청을 받을 준비가 됐다는 뜻이 아닙니다. 바로 뒤의 테스트가 서버 준비를
전제로 한다면 별도의 준비 상태 확인 단계가 필요합니다. 일반 캡처 모드는 입력을 주고받는 터미널이
아니므로 비밀번호 프롬프트 등 대화형 CLI에는 기본 터미널 실행을 사용하세요.

액션 우클릭 → **미리 실행 (Dry-run)**(영문: **Preview Run (Dry-run)**)에서 변수 치환·cwd·명령 형태를 확인하고,
실행 후에는 **History → 실행된 명령 보기**와 터미널/캡처 결과를 비교하세요. Preview는 입력값과
프로그램 출력을 자리표시자로 모의하므로 실제 argv까지 확인하려면 [인자 출력 예제](../examples/command_shell/README.md)를 실행합니다.

## 5. 사용자 입력

### `fileDialog`, `folderDialog`, `pathDialog`

세 타입은 같은 `options`와 결과 형식을 사용합니다. `pathDialog`만 `mode`가 추가로 필요합니다.

```json
{
  "id": "firmware",
  "type": "fileDialog",
  "options": {
    "title": "펌웨어 선택",
    "openLabel": "분석하기",
    "filters": { "Firmware": ["elf", "bin", "hex"] },
    "canSelectMany": false
  }
}
```

| `options` 필드 | 설명 |
| --- | --- |
| `title` | 대화상자 제목. 운영체제에 따라 표시되지 않을 수 있음 |
| `openLabel` | 확인 버튼 문구 |
| `defaultUri` | 처음 열 절대 경로 또는 URI. 생략하면 이 액션·태스크가 마지막으로 사용한 위치 |
| `filters` | 표시 이름과 확장자 배열. `folderDialog`에서는 사용하지 않음 |
| `canSelectMany` | 여러 파일·폴더 선택 |
| `canSelectFiles`, `canSelectFolders` | 직접 지정할 선택 종류. 보통 생략하며 `pathDialog`에서는 `mode`가 우선 |

`pathDialog.mode`는 `file`, `folder`, `both` 또는 그 값으로 해석되는 정확한 변수 참조입니다.

```jsonc
{ "id": "kind", "type": "quickPick", "items": [
  { "label": "파일 선택", "value": "file" },
  { "label": "폴더 선택", "value": "folder" }
] },
{ "id": "target", "type": "pathDialog", "mode": "${kind}",
  "options": { "openLabel": "대상 선택" } }
```

Windows와 Linux에서 `mode: "both"`는 파일·폴더 종류를 먼저 묻고 해당 네이티브 대화상자를 엽니다.
macOS에서는 한 대화상자에서 둘 다 선택할 수 있습니다.

| 결과 | 값 |
| --- | --- |
| `path`, `name`, `dir`, `fileNameOnly`, `fileExt` | 첫 번째 선택 정보 |
| `paths`, `names`, `count` | 전체 선택 경로·이름·개수 |

`folderDialog`의 `path`는 선택한 폴더이고 `dir`은 그 부모 폴더입니다. 여러 경로를 command 인자로 넘길
때는 `args`의 원소 전체를 `"${files.paths}"`로 작성합니다.

### `inputBox`

```json
{
  "id": "tag",
  "type": "inputBox",
  "prompt": "릴리스 태그를 입력하세요",
  "placeHolder": "v1.2.3",
  "value": "v1.0.0",
  "validatePattern": "^v\\d+\\.\\d+\\.\\d+$",
  "validateMessage": "v1.2.3 형식으로 입력하세요"
}
```

| 필드 | 설명 |
| --- | --- |
| `prompt`, `placeHolder` | 안내 문구 |
| `value` | 초기값. 변수 참조 가능 |
| `prefix`, `suffix` | 입력한 값 앞뒤에 추가 |
| `validatePattern`, `validateMessage` | 입력값 정규식 검증과 실패 문구 |
| `extractPattern` | 보간된 `value`에서 초기 입력값을 추출하는 정규식 |
| `password` | 입력 마스킹 및 History·로그·Preview 저장 방지 |

결과는 `${tag.value}`이며 `${tag}`로 줄여 쓸 수 있습니다.

### `quickPick`

문자열 배열은 보이는 문구와 실행값이 같습니다.

```json
{
  "id": "board",
  "type": "quickPick",
  "placeHolder": "보드를 선택하세요",
  "items": ["stm32f4", "stm32f7", "nrf52"]
}
```

표시 문구와 명령 인자를 다르게 하려면 객체 항목을 사용합니다.

```jsonc
{ "id": "mode", "type": "quickPick", "items": [
  { "id": "debug", "label": "디버그 빌드", "value": ["--mode", "debug"] },
  { "id": "release", "label": "릴리스 빌드", "value": ["--mode", "release"] },
  { "id": "plain", "label": "추가 옵션 없음", "value": [] }
] },
{ "id": "build", "type": "command", "command": "builder",
  "args": ["${mode}"] }
```

- `label`: 화면에 보이는 문구
- `description`, `detail`: 보조 설명
- `value`: command에 넘길 값. 생략하면 `label`; 배열은 여러 argv; 빈 배열은 인자 없음
- `args`: `value`와 별도로 command에 넘길 argv. 하나면 문자열, 여러 개면 배열
- `id`: 선택 기억과 History 재실행에 쓰는 선택적 고정 식별자

항목이 많으면 `items`를 label-keyed 객체로 줄여 쓸 수 있습니다. 객체 키가 화면의 `label`이 됩니다.

```jsonc
"items": {
  "ZIP 파일": { "value": "file", "args": "--input-file" },
  "압축 해제 폴더": { "value": "folder", "args": "--input-dir" }
}
```

축약 객체의 값은 다음처럼 해석합니다.

| 값 | 의미 |
| --- | --- |
| `null` 또는 `{}` | `label`을 그대로 `value`로 사용 |
| 문자열 또는 문자열 배열 | 해당 값을 `value`로 사용 |
| 객체 | `id`, `description`, `detail`, `value`, `args`를 상세 지정 |

**공백이 있는 문자열은 자동으로 여러 인자로 나뉘지 않습니다.** `command` 태스크의 `args`에
`"${selectSlot}"`을 원소 하나로 넣었을 때, 선택 항목의 값에 따른 차이는 다음과 같습니다.

| 선택 항목의 값 | 프로그램에 전달되는 인자 |
| --- | --- |
| `"--slot 0"` | `--slot 0` 전체가 인자 1개 |
| `["--slot 0"]` | 원소가 하나이므로 위와 동일하게 인자 1개 |
| `["--slot", "0"]` | `--slot`과 `0`이 각각 인자 1개씩, 총 2개 |

`--slot` 옵션에 `0`이나 `1`을 전달하려면 다음처럼 옵션과 값을 별도 배열 원소로 작성합니다.
아래 두 태스크를 액션의 `tasks` 배열에 넣고, `tool`을 실제 실행할 프로그램으로 바꿉니다.

```jsonc
{ "id": "selectSlot", "type": "quickPick", "items": {
  "slot 0": ["--slot", "0"],
  "slot 1": ["--slot", "1"]
} },
{ "id": "run", "type": "command", "command": "tool",
  "args": ["${selectSlot}"] }
```

`slot 0`을 고르면 `tool --slot 0`처럼 두 인자를 전달합니다. `${selectSlot}`은
`${selectSlot.value}`의 축약형이며, `args` 원소 전체로 참조해야 배열이 여러 인자로 펼쳐집니다.
실행 명령이 `"--slot" "0"`처럼 표시되더라도 TaskHub가 인자를 감싸기 위해 붙인 따옴표는 실제
인자에 포함되지 않습니다. 위 표의 앞 두 경우에는 `"--slot 0"` 전체가 인자 하나로 인용되므로,
옵션과 값을 따로 전달하려면 위 예제처럼 원소를 나눕니다.

같은 label을 여러 행에 쓰거나 표시 순서를 엄격히 고정해야 하거나, 항목마다 `label`을 명시해 읽는 편이
나으면 기존 배열 형식을 사용합니다. 배열형과 축약형은 실행 결과가 같으며 기존 배열형도 계속 지원합니다.
특히 `"0"`부터 `"4294967294"`까지의 정수형 label은 JavaScript 객체 규칙에 따라 다른 label보다 먼저
숫자 오름차순으로 표시됩니다. 보드레이트·연도·숫자 버전처럼 작성 순서를 유지해야 하는 숫자 label은
배열 형식으로 작성합니다.

선택값을 `pathDialog.mode` 같은 흐름 제어에도 쓰고 command 옵션도 만들어야 한다면 `value`와 `args`를
같이 둡니다. `${kind.args}`는 배열이므로 command의 `args` 원소 전체에 넣어야 argv 여러 칸으로
펼쳐집니다. 정적 항목 중 하나라도 `args`를 선언하면 이 태스크는 항상 `args` 결과를 만듭니다.
매핑이 없는 항목이나 `allowCustom` 직접 입력을 고르면 `args: []`가 되어 인자를 추가하지 않습니다.
JSONL 동적 목록도 같은 계약을 사용합니다.

```jsonc
{ "id": "kind", "type": "quickPick", "items": {
  "ZIP 파일": { "value": "file", "args": "--input-file" },
  "압축 해제 폴더": { "value": "folder", "args": "--input-dir" }
} },
{ "id": "target", "type": "pathDialog", "mode": "${kind}" },
{ "id": "run", "type": "command", "command": "parser",
  "args": ["${kind.args}", "${target.path}"] }
```

| 태스크 필드 | 설명 |
| --- | --- |
| `items` | 항목 배열 또는 label을 키로 쓰는 축약 객체 |
| `canPickMany` | 여러 항목 선택 |
| `default` | 처음 활성화할 label. 다중 선택이면 label 배열. 명시하면 기억한 선택보다 우선하며 변수 참조 가능 |
| `allowCustom` | 목록 밖의 직접 입력 허용. `canPickMany`와 함께 사용할 수 없음 |
| `rememberLastSelection` | 마지막 선택을 워크스페이스·액션·태스크별로 복원 |
| `itemsFromCommand` | 문자열 또는 플랫폼별 객체로 지정한 셸 명령의 stdout으로 목록 생성. 지정하면 정적 `items`는 사용하지 않음 |
| `itemsFromCommandFormat` | `lines` 또는 줄마다 객체인 `jsonl` |
| `itemsExclude` | 동적 목록에서 제외할 문자열 또는 문자열 배열. `lines`는 줄 전체, `jsonl`은 id·label·원본 JSON 줄과 정확히 비교 |

주요 결과는 다음과 같습니다.

| 결과 | 값 |
| --- | --- |
| `value` | 첫 선택의 매핑값. `${taskId}`로 줄여 쓸 수 있음 |
| `args` | 태스크의 별도 command 인자 배열. 정적 항목 중 하나라도 `args`를 선언하거나 동적 형식이 `jsonl`이면 항상 생성 |
| `label` | 첫 선택의 표시 문구 |
| `valueList`, `labelList` | 전체 선택의 손실 없는 배열 |
| `values`, `labels` | 다중 선택 값을 쉼표로 이은 문자열 |
| `custom` | 목록 밖 직접 입력 여부 |

다음 태스크는 Node.js가 PATH에 있는 환경에서 실제로 실행할 수 있는 동적 목록 예제입니다.
`Debug`를 고르면 `${mode.value}`와 `${mode.label}`은 모두 `Debug`입니다.

```json
{
  "id": "mode",
  "type": "quickPick",
  "itemsFromCommand": "node -e \"console.log('Debug'); console.log('Release')\"",
  "itemsFromCommandFormat": "lines",
  "default": "Debug",
  "placeHolder": "실행 모드를 선택하세요"
}
```

목록 생성 명령에는 다음 규칙을 적용합니다.

- Windows는 `cmd.exe /c`, macOS·Linux는 사용자의 로그인 셸로 실행합니다. 일반 `shell` 태스크와
  셸이 같다고 가정하지 마세요. 플랫폼별 명령은 `itemsFromCommand`의 `windows`·`macos`·`linux`로 지정합니다.
- `cwd`는 [작업 폴더 규칙](#작업-폴더와-환경변수)을 따릅니다. 태스크의 별도 `args`와 `env`는 이 명령에
  전달하지 않습니다. 필요한 인자는 `itemsFromCommand` 문자열 안에 해당 셸 문법으로 작성합니다.
- 명령 자체는 최대 15초, stdout와 stderr 합계는 최대 1MiB입니다. 태스크의 `timeoutSeconds`를 더 길게
  지정하거나 `0`으로 두어도 이 두 제한은 유지됩니다.
- 명령 실패, 잘못된 JSONL, 필터 적용 후 빈 목록은 태스크 실패입니다. stdout에는 목록 데이터만 출력하고
  진행 로그는 stderr로 보내세요.

동적 목록은 기본적으로 앞뒤 공백을 제거한 비어 있지 않은 stdout 한 줄을 label/value로 사용합니다. 객체 매핑이 필요하면
`itemsFromCommandFormat: "jsonl"`을 쓰고 줄마다 다음 형식으로 출력합니다.

```jsonl
{"id":"local","label":"로컬 실행","value":[]}
{"id":"release","label":"릴리스 배포","value":["--mode","release"]}
```

동적 항목도 의미값과 command 인자를 나누려면
`{"id":"archive","label":"아카이브","value":"file","args":"--input-file"}`처럼 인자 하나는 문자열로,
여러 개는 `"args":["--input-file","--recursive"]`처럼 문자열 배열로 출력합니다.

### `envPick`

로그인 셸에서 사용할 수 있는 환경변수 **이름**을 선택해 `value`로 반환합니다.

```json
{ "id": "variable", "type": "envPick", "placeHolder": "환경변수 이름 선택" }
```

선택한 이름은 `${variable}`입니다. 이름이 미리 정해진 환경변수의 값은 `${env:NAME}`으로 참조하고,
실행 중 고른 이름은 고정된 command의 인자로 전달해 조회합니다.

### `confirm`

```json
{
  "id": "confirmDeploy",
  "type": "confirm",
  "message": "${target.label}에 배포할까요?",
  "confirmLabel": "배포",
  "cancelLabel": "취소"
}
```

`message`를 생략하면 기본 확인 문구를 사용합니다. 확인 결과는 `confirmed: "true"`이며 취소는 액션 취소로
처리됩니다.

### 민감한 입력

`password: true`, 환경변수, 클립보드, 선택 텍스트에서 파생된 값은 History, 입력 프로필, QuickPick 기억,
Preview, 실행 보고서와 일반 로그에 원문을 남기지 않습니다. 이 값을 `writeFile`, `appendFile`,
`output.mode: "file"`로 저장하려면 해당 태스크에 `allowSecretContent: true`를 명시해야 합니다.

## 6. 파일·브라우저·아카이브·값 변환

### `stringManipulation`

```json
{
  "id": "name",
  "type": "stringManipulation",
  "function": "basenameWithoutExtension",
  "input": "${firmware.path}"
}
```

결과는 `${name.output}`이며 `${name}`으로도 참조할 수 있습니다.

| `function` | 동작 |
| --- | --- |
| `stripExtension` | 마지막 확장자 제거 |
| `basename` | 파일명만 반환 |
| `basenameWithoutExtension` | 확장자 없는 파일명 |
| `dirname` | 부모 경로 |
| `extension` | 점 없는 확장자 |
| `toLowerCase`, `toUpperCase`, `trim` | 대소문자·공백 변환 |

### `writeFile`, `appendFile`

```json
{
  "id": "manifest",
  "type": "writeFile",
  "path": "build/selected.txt",
  "content": "${firmware.path}\n",
  "encoding": "utf8",
  "eol": "lf",
  "overwrite": true,
  "mkdirs": true
}
```

`path`와 `content`는 필수이며 변수 참조를 지원합니다. 상대 경로는 액션 워크스페이스 기준이고 워크스페이스
밖의 경로는 거부합니다. 결과는 작성한 절대 경로 `${manifest.path}`입니다.

- `encoding`: `utf8`(기본), `utf8bom`, `ascii`
- `eol`: `keep`(기본), `lf`, `crlf`
- `mkdirs`: 부모 폴더 자동 생성, 기본 `true`
- `overwrite`: `writeFile`의 덮어쓰기, 기본 `true`
- `allowSecretContent`: 민감값 저장을 명시적으로 허용

### `browser`

앞선 태스크가 만든 HTML이나 HTTP(S) 주소를 VS Code 내장 브라우저 또는 OS 기본 브라우저로 엽니다.
생성한 파일을 바로 확인하려면 `writeFile`의 `${taskId.path}` 결과를 `url`에 연결하는 방식이 가장
간단합니다.

다음 두 태스크를 `action.tasks` 배열에 넣습니다.

```jsonc
{
  "id": "generate",
  "type": "writeFile",
  "path": "build/report.html",
  "content": "<!doctype html><meta charset=\"utf-8\"><h1>Build report</h1>"
},
{
  "id": "preview",
  "type": "browser",
  "url": "${generate.path}",
  "target": "integrated"
}
```

`url`은 다음 형식을 지원합니다.

- `https://example.com/report` 또는 `http://localhost:3000`: WHATWG URL로 검증·정규화해 엽니다.
- `file:///.../report.html`: 로컬 파일 URL을 엽니다. `file://server/share/...`처럼 네트워크 authority가
  있는 file URL은 다른 로컬 경로로 오인하지 않도록 거부합니다.
- `/absolute/path/report.html` 또는 `build/report.html`: 로컬 절대·상대 경로를 엽니다. 상대 경로는
  `cwd`가 있으면 그 디렉터리, 없으면 액션 워크스페이스를 기준으로 해석합니다.
- `${generate.path}`처럼 앞선 태스크 결과를 사용할 수 있습니다. 성공 결과의 `${preview.url}`은
  TaskHub가 검증한 정규화 URL입니다. 로컬 file URI는 경로의 공백·한글 등을 percent-encoding하면서
  query와 fragment의 구분과 기존 인코딩을 보존합니다. 비-Remote HTTP(S)를 내장 브라우저로 열 때도
  query의 기존 percent-encoding을 다시 해석하지 않습니다. 로컬 파일을 연 경우에만 사람이 읽을 수 있는
  절대 경로 `${preview.path}`도 제공합니다. 입력이 `${pick.value}`처럼 URL인지 파일인지 실행 전에는 알
  수 없는 동적 값이라면 `path` 결과는 보장되지 않습니다.

| 필드 | 설명 |
| --- | --- |
| `url` | 열 URL 또는 로컬 경로. 필수이며 변수 참조 지원 |
| `target` | `integrated`(기본) 또는 `default` |
| `cwd` | 상대 로컬 경로의 기준 디렉터리. 상대 `cwd` 자체는 액션 워크스페이스 기준이며, 워크스페이스가 없으면 절대 `cwd` 필요 |

`target: "integrated"`는 최신 VS Code의 내장 브라우저를 사용합니다. HTTP(S)는 호환되는 VS Code에서
Simple Browser로 대체될 수 있지만, 로컬 파일을 내부에서 열 수 없는 VS Code에서는 OS 브라우저로 몰래
전환하지 않고 액션을 실패시킵니다. 외부 브라우저를 원할 때만 `target: "default"`를 명시합니다. 이 대상은
VS Code의 `openExternal` URI 경계를 사용하므로 query 값 안의 `%26`처럼 이미 인코딩된 reserved 문자를
브라우저까지 동일하게 전달해야 한다면 `integrated`를 사용하세요.

Remote SSH·Dev Container·Codespaces에서는 확장 호스트의 로컬 경로나 `file:` URL을 브라우저가 직접
읽을 수 없으므로 `target`과 관계없이 열기 전에 명시적으로 실패합니다. HTML 디렉터리에서 HTTP 서버를
실행한 뒤 `http://localhost:<port>/report.html`을 `url`로 넘기세요. `target: "integrated"`이면 TaskHub가
VS Code의 포트 전달 주소로 변환해 엽니다. `target: "default"`에서는 `openExternal`이 내부에서 전달을
처리하므로 `${preview.url}`은 정규화된 원본 URL일 수 있습니다.

### `zip`

```json
{
  "id": "package",
  "type": "zip",
  "source": ["${firmware.path}", "${manifest.path}"],
  "archive": "build/firmware.zip"
}
```

`source`는 경로 또는 경로 배열이고 `archive`는 생성할 파일입니다. `tool`을 생략하면 내장 ZIP 엔진을
사용하며, 지정하면 7z 호환 도구를 사용합니다. 상대 `source`와 `archive`는 `cwd`, 없으면 액션
워크스페이스를 기준으로 해석합니다. 결과 `${package.archivePath}`는 해석된 절대 경로입니다.

내장 엔진은 `.zip`만 지원합니다. 다른 형식은 해당 형식을 지원하는 외부 `tool`을 지정해야 합니다.
`source`의 각 항목은 실제 파일 또는 폴더 경로이며, `args`처럼 배열 참조를 펼치지 않습니다.

| 설정 | 실제로 찾는 대상 |
| --- | --- |
| `"source": ["build/a.bin", "build/b.bin"]` | 두 파일 |
| `"source": "build/images"` | 해당 폴더 |
| `"source": ["${files.paths}"]` | 선택한 경로를 공백으로 이은 **경로 하나**. 다중 선택을 한 ZIP에 전달하는 방법이 아님 |

여러 파일을 각각 ZIP으로 만들려면 앞의 다중 선택 `files` 태스크 뒤에 다음 부분 예제를 넣습니다.
두 파일을 선택하면 `build/part-1.zip`, `build/part-2.zip`이 생성됩니다.

```json
{
  "id": "packageEach",
  "type": "zip",
  "forEach": "${files.paths}",
  "source": "${each}",
  "archive": "build/part-${each.number}.zip"
}
```

### `unzip`

```json
{
  "id": "extract",
  "type": "unzip",
  "archive": "${archive.path}",
  "destination": "build/extracted"
}
```

`archive`, `destination`은 직접 경로를 받습니다. 이전 태스크 ID를 연결하는 기존 `inputs.archive`,
`inputs.file`, `inputs.destination` 형식도 지원합니다. 결과는 `${extract.outputDir}`이며 `${extract}`로도
참조할 수 있습니다. 상대 `archive`와 `destination`은 `cwd`, 없으면 액션 워크스페이스를 기준으로
해석하며 결과는 절대 경로입니다.

`zip`과 `unzip`의 `tool`은 플랫폼별 객체를 사용할 수 있습니다.

```json
{
  "windows": "C:\\Program Files\\7-Zip\\7z.exe",
  "macos": "/opt/homebrew/bin/7z",
  "linux": "/usr/bin/7z"
}
```

`cwd`는 내장 엔진의 상대 경로 기준과 외부 도구의 작업 디렉터리에 모두 적용됩니다. `tool`을 지정한
경우 `env`를 자식 프로세스에 추가할 수 있습니다. `tool`, `cwd`, `env` 값은 변수 치환을 지원합니다.
ZIP 경로는 파일·폴더 대화상자로 워크스페이스 밖의 항목을 다루는 용도도 있으므로 워크스페이스 안으로
제한하지 않습니다.

## 7. 조건·분기·반복

### `when`

```json
{
  "id": "flash",
  "type": "command",
  "command": "flash-tool",
  "when": { "var": "${mode}", "equals": "release" }
}
```

`equals`, `notEquals`, `matches`, `in` 중 정확히 하나를 사용합니다. 조건이 거짓이면 실패가 아니라
건너뜀입니다.

| 비교 필드 | 의미 |
| --- | --- |
| `equals`, `notEquals` | 문자열 전체가 같은지·다른지 비교 |
| `matches` | 정규식 부분 일치. 전체 일치가 필요하면 `^...$` 사용 |
| `in` | 문자열 배열 중 하나와 전체 일치. 예: `["debug", "release"]` |

`var`만 변수로 치환하며 비교값은 리터럴입니다. 예를 들어 `"equals": "${other.value}"`는 다른
태스크의 값과 비교하지 않습니다. 조건이 잘못된 것 같으면 실행 전 Doctor로 확인하세요.

**조건으로 건너뛴 태스크의 결과를 직접 참조하는 후속 태스크도 건너뜁니다.** 어느 분기든 결과 하나만
있으면 계속하려는 경우에는 `??`로 대안을 연결합니다. 아래 부분 예제는 파일을 열거나 생성하지 않고
선택할 경로 문자열만 만듭니다. `debug`를 선택하면 `${chosenPath.output}`은 `build/debug.bin`입니다.

```jsonc
{ "id": "mode", "type": "quickPick", "items": ["debug", "release"] },
{ "id": "debugPath", "type": "stringManipulation", "function": "trim",
  "input": "build/debug.bin", "when": { "var": "${mode}", "equals": "debug" } },
{ "id": "releasePath", "type": "stringManipulation", "function": "trim",
  "input": "build/release.bin", "when": { "var": "${mode}", "equals": "release" } },
{ "id": "chosenPath", "type": "stringManipulation", "function": "trim",
  "input": "${debugPath.output ?? releasePath.output}" }
```

### `switch`

QuickPick 선택마다 실행할 태스크 자체가 달라질 때 사용합니다.

```jsonc
{ "id": "operation", "type": "quickPick", "items": [
  { "label": "빌드", "value": "build" },
  { "label": "테스트", "value": "test" },
  { "label": "아무것도 안 함", "value": "skip" }
] },
{ "id": "selectedWork", "type": "switch", "on": "${operation}",
  "cases": {
    "build": { "type": "command", "command": "npm", "args": ["run", "build"] },
    "test": { "type": "command", "command": "npm", "args": ["test"] }
  }
}
```

- 일치하는 case가 없고 `defaultCase`도 없으면 아무 작업 없이 성공
- 결과의 `matched`는 case 일치 여부, `selected`는 `on`의 해석값
- case는 `command`, `shell`, `stringManipulation`, `writeFile`, `appendFile`, `browser`, `zip`, `unzip`만 지원
- 바깥 `switch`의 `command`, `args`, `cwd`, `env`, `output` 같은 공통 실행 필드는 case가 상속하며,
  case에 같은 필드를 쓰면 case 값이 우선
- `id`, `when`, `dependsOn`, `parallel`, `forEach`, `continueOnError`, `timeoutSeconds`와 분기 필드는
  바깥 `switch`에서만 설정
- 대화상자는 case 안에 넣지 않고 별도 태스크와 `pathDialog`를 사용

`env`, `output` 같은 객체 필드도 case가 선언하면 **객체 전체를 대체**하며, 내부 키끼리 합치지 않습니다.
`defaultCase`는 `cases` 안의 각 값과 같은 `{ "type": ..., ... }` 형태로 작성합니다.

### `forEach`

여러 파일이나 다중 QuickPick 값을 각각 처리할 때 비대화형 태스크에 추가합니다.

```jsonc
{ "id": "files", "type": "fileDialog",
  "options": { "canSelectMany": true } },
{ "id": "inspect", "type": "command",
  "forEach": "${files.paths}",
  "command": "python",
  "args": ["inspect.py", "${each}", "--number", "${each.number}"] }
```

| 반복 변수 | 값 |
| --- | --- |
| `${each}`, `${each.value}` | 현재 값 |
| `${each.index}` | 0부터 시작하는 위치 |
| `${each.number}` | 1부터 시작하는 순번 |
| `${each.count}` | 전체 개수 |

`forEach`는 배열로 해석되는 정확한 참조 하나 또는 고정 문자열 배열을 받습니다. 쉼표로 이은 문자열
`"a,b"`는 배열이 아닙니다. 고정 배열 안의 문자열은 변수 참조도 가능합니다. 최대 1,000개이며, 항목은
배열 순서대로 **하나씩** 처리합니다. 동적 배열이 비어 있으면 실행 횟수는 0입니다.

다음 부분 예제는 외부 프로그램 없이 `build/item-1.txt`에 `alpha`, `build/item-2.txt`에 `beta`를 씁니다.
재실행 시에는 `writeFile`의 기본 덮어쓰기 규칙을 따릅니다.

```json
{
  "id": "writeItems",
  "type": "writeFile",
  "forEach": ["alpha", "beta"],
  "path": "build/item-${each.number}.txt",
  "content": "${each}\n"
}
```

반복 전체에 적용되는 규칙도 구분하세요.

- `when`은 반복 전에 한 번 판정하므로 반복별 `${each}`를 조건에 사용할 수 없습니다.
- `timeoutSeconds`는 각 항목별 제한이 아니라 반복 전체의 제한입니다.
- 어느 항목이든 처음 실패하면 남은 반복을 중단합니다. `continueOnError: true`도 다음 항목을 실행하는 옵션이
  아니라 **다음 태스크**로 진행하는 옵션이며, 실패한 반복 태스크의 결과는 `{}`가 됩니다. 이미 쓴
  파일이나 실행한 명령은 되돌리지 않습니다.
- 대화형 태스크, `browser`, `switch`, `isOneShot` 태스크에는 사용할 수 없습니다.

성공한 반복 태스크의 결과는 다음과 같습니다. `command`·`shell`의 출력 집계에는 캡처 옵션이 필요합니다.

| 결과 | 값 |
| --- | --- |
| `count` | 실행한 항목 수 |
| `outputs`, `stderrs` | 각 반복에서 받은 문자열 출력 배열 |
| `paths` | 각 반복의 `path`·`archivePath`·`outputDir` 중 경로 결과를 모은 배열 |
| `output`, `stderr` | 수집된 문자열이 있으면 줄바꿈으로 이은 값 |
| 나머지 결과 키 | 마지막 반복의 값. 모든 항목을 담은 배열이 아님 |

위 예제의 `${writeItems.paths}`에는 생성된 파일의 절대 경로 두 개가 들어갑니다. 결과가 너무 크면
[파이프라인 결과 크기 설정](features.md#21-설정-레퍼런스)의 한도로 실패할 수 있습니다.

## 8. 출력 캡처와 표시

### Output Capture

`command`·`shell`의 stdout을 뒤 태스크에서 사용하려면 `passTheResultToNextTask: true`가 필요합니다.
다음 부분 예제는 Git이 설치되어 있고 액션 워크스페이스에 커밋이 있는 Git 저장소가 있을 때 실행할 수 있습니다.

```json
{
  "id": "revision",
  "type": "command",
  "command": "git",
  "args": ["rev-parse", "HEAD"],
  "passTheResultToNextTask": true
}
```

- `${revision.output}`: 앞뒤 공백과 줄바꿈을 제거한 stdout
- `${revision.stderr}`: 앞뒤 공백과 줄바꿈을 제거한 stderr
- `${revision}`: 대표 결과인 stdout

예를 들어 프로세스가 `"  abc123\n"`을 출력하면 `${revision.output}`은 `abc123`입니다. 원본의 앞뒤
공백이나 바이너리 바이트를 보존해야 한다면 프로그램에서 파일로 저장하고 그 경로를 다음 태스크에 전달하세요.

`output.capture`는 문자열 `output`에서 일부를 이름 있는 값으로 추출합니다. 위 `revision` 태스크에
다음 필드를 합치면 `${revision.shortSha}`로 짧은 커밋 해시를 참조할 수 있습니다.

```json
{
  "output": {
    "capture": {
      "name": "shortSha",
      "regex": "^([a-f0-9]{7})",
      "group": 1,
      "trim": true
    }
  }
}
```

`capture`는 규칙 객체 하나 또는 규칙 배열입니다.

| 필드 | 의미 |
| --- | --- |
| `name` | 필수 결과 키. 영문자·밑줄로 시작하고 이후 영문자·숫자·밑줄 사용. 같은 규칙 목록에서 중복 불가 |
| `regex` | 첫 번째 정규식 일치에서 추출. `line`과 함께 쓰면 regex 우선 |
| `group` | `0`은 전체 일치. 생략하면 캡처 그룹이 있을 때 `1`, 없을 때 `0` |
| `flags` | 정규식 옵션. 예: `m`은 여러 줄의 시작·끝, `i`는 대소문자 무시. 여러 일치를 배열로 추출하지는 않음 |
| `line` | regex 대신 한 줄 선택. 첫 줄은 `0`, `-1`은 마지막 줄 |
| `trim` | 선택한 문자열의 앞뒤 공백 제거. 기본 `false` |

`regex`와 `line`을 모두 생략하면 전체 `output`을 사용합니다. 정규식 불일치, 없는 캡처 그룹 또는
범위를 벗어난 줄 번호는 **태스크 실패가 아니라 해당 결과 키 미생성**입니다. 예를 들어 `output`이
`abc123`인데 `regex: "^(v[0-9]+)$"`이면 `${revision.shortSha}`는 만들어지지 않습니다.
후속 참조는 원문 `${revision.shortSha}`로 남으므로 [변수 대안](#9-변수-참조)이나 별도 검증으로 처리하세요.
잘못된 정규식, 중복·예약 `name`은 태스크 실패입니다.

`name`은 `output`, `stderr`, `path`, `url`, `value`, `matched` 같은 내장 결과 키와 겹칠 수 없습니다.
URL을 추출할 때는 `url` 대신 `capturedUrl`처럼 별도 이름을 사용하세요. Doctor는 충돌을
`capture.reserved` 오류로 알려줍니다.

`command`·`shell`은 캡처 옵션을 켜야 하며, `stringManipulation`은 항상 문자열 `output`을 제공합니다.
문자열 `output`이 없는 태스크에는 capture가 적용되지 않습니다. capture는 `stderr`를 검색하지 않으므로
필요하면 뒤의 `stringManipulation` 태스크에서 `input: "${revision.stderr}"`로 받아 추출하세요.

### 출력 표시·저장

다음 필드를 결과를 표시할 태스크에 합칩니다. `output.mode`로 표시·저장하려면
`passTheResultToNextTask: true`가 필요합니다.

```json
{
  "passTheResultToNextTask": true,
  "output": {
    "mode": "editor",
    "language": "json"
  }
}
```

| `output.mode` | 동작 |
| --- | --- |
| `editor` | 편집·저장할 수 있는 새 Untitled 문서로 표시. `language` 지정 가능하며, 편집해도 태스크 결과 자체는 바뀌지 않음 |
| `terminal` | 읽기 전용 터미널로 표시 |
| `file` | `filePath`에 저장. `overwrite`, `content` 지원 |

`mode: "file"`에는 다음 필드를 사용합니다.

| 필드 | 동작 |
| --- | --- |
| `filePath` | 필수 저장 경로. [작업 폴더 규칙](#작업-폴더와-환경변수)을 따르는 워크스페이스 내부 경로만 허용 |
| `overwrite` | 기본 `false`. 기존 파일이 있으면 실패. `true` 또는 문자열 변수로 치환한 `true`로 덮어쓰기 허용 |
| `content` | 생략하면 stdout, 문자열 stdout이 없는 결과는 JSON. 지정하면 앞선 태스크의 결과를 보간한 내용 사용 |

부모 폴더는 자동으로 만듭니다. 다음 필드를 `revision` 태스크에 합치면 캡처한 stdout을
`build/revision.txt`에 저장하며, 두 번째 실행에서도 덮어쓰도록 설정합니다.

```json
{
  "passTheResultToNextTask": true,
  "output": {
    "mode": "file",
    "filePath": "build/revision.txt",
    "overwrite": true
  }
}
```

자기 태스크의 `${revision.output}`을 `output.content`에서 참조할 수는 없습니다. 자신의 stdout을
저장할 때는 위처럼 `content`를 생략하세요. 민감한 입력에서 파생된 값은 [별도 출력 제한](#민감한-입력)을 따릅니다.

`output.diagnostics`는 stdout과 stderr를 함께 검사해 Problems 항목으로 바꿉니다. `command`·`shell`에는
캡처 옵션이 필요하며, 실패한 명령의 출력도 진단 대상입니다. 값으로 `"$gcc"`, `"$tsc"`
프리셋을 쓰거나, 사용자 정규식 객체에 `pattern`과 `file`, `line`, `message` 그룹 번호를 지정합니다.
필요하면 `column`, `endLine`, `endColumn`, `severity`, `defaultSeverity`, `source`도 추가할 수 있습니다.

## 9. 변수 참조

앞 태스크의 결과는 `${taskId.key}`로 참조합니다.

```json
{
  "command": "tool",
  "args": ["${target.path}", "${mode.value}"]
}
```

- `output`, `outputDir`, `value`가 대표 결과인 태스크는 `${taskId}`로 줄여 쓸 수 있습니다.
- `${a.value ?? b.value}`는 왼쪽부터 실제로 존재하는 첫 값을 사용합니다. 빈 문자열·`0`·`false`·빈 배열도 유효한 값입니다.
- 배열 참조가 `args` 원소 전체이면 여러 argv로 펼쳐집니다.
- `"--file=${files.paths}"`처럼 다른 글자와 섞이면 공백으로 합친 argv 하나가 됩니다.
- 해석되지 않은 참조는 일반적으로 `${…}` 리터럴로 남고 Doctor가 진단합니다.
- 태스크 자신은 참조할 수 없습니다.

`??`는 **태스크 결과나 내장 변수 참조 사이의 대안**입니다. JavaScript 수식을 실행하지 않으므로
`${a.value ?? "default"}`처럼 문자열 리터럴을 기본값으로 넣을 수는 없습니다. 고정 기본값이 필요하면
별도 `stringManipulation` 태스크 등에서 값을 만든 뒤 그 결과를 대안으로 참조하세요. 예를 들어
`a.value`가 빈 문자열이고 `b.value`가 `backup`이면 `${a.value ?? b.value}`의 결과는 빈 문자열입니다.
조건으로 실행되지 않은 분기의 대안 연결은 [when 예제](#when)를 참고하세요.

배열 참조가 `args` 원소 전체이거나 `command` 타입의 `command` 안에서 독립된 전체 토큰일 때는
여러 인자로 확장됩니다. 다른 문자열 위치에서는 공백으로 이은 문자열입니다. 특히 [ZIP의 source](#zip)는
경로 배열을 자동 확장하지 않습니다. 결과 객체 전체를 JSON으로 자동 변환하거나 `${files.paths[0]}`로 배열 원소를
선택하는 문법도 지원하지 않습니다. 다중 파일의 첫 경로는 `${files.path}`, 각 항목 처리는 `forEach`를 쓰세요.

### 보간되는 필드와 그대로 쓰는 필드

`${…}`는 JSON 전체를 재귀적으로 치환하지 않습니다. 다음은 태스크를 작성할 때 구분해야 할 문자열 필드입니다.

| 위치 | 보간되는 값 |
| --- | --- |
| `command`·`shell` | `command`, `args`, `cwd`, `env`의 값 |
| `inputBox` | `prompt`, `value`, `placeHolder`, `prefix`, `suffix` |
| `quickPick` | `placeHolder`, `default`, 정적 `items`의 label·description·detail·value·args, `itemsFromCommand`, `cwd` |
| `pathDialog` | `mode` |
| `envPick`·`confirm` | 각각 `placeHolder`, `message` |
| `stringManipulation` | `input` |
| `writeFile`·`appendFile` | `path`, `content` |
| `browser` | `url`, `cwd` |
| `zip`·`unzip` | 경로 문자열, `tool`, `cwd`, 외부 도구에 전달할 `env` 값 |
| 조건·반복·출력 | `when.var`, `switch.on`, `forEach`의 참조/고정 배열 원소, `output.content`, 파일 모드의 `output.filePath`·문자열 `output.overwrite` |

다음 값은 **리터럴**로 작성합니다.

- `options` 안의 모든 값: `defaultUri`, `title`, `openLabel`, `filters` 등
- `validatePattern`, `extractPattern`, `validateMessage`, `confirmLabel`, `cancelLabel`, `itemsExclude`
- `when.equals`·`notEquals`·`matches`·`in`, `output.capture`·`diagnostics` 안의 규칙, `output.language`
- 태스크·항목 `id`, `type`, `dependsOn`의 태스크 ID, `function`, `encoding`, `eol` 같은 식별자·허용값

예를 들어 `"options": { "defaultUri": "${workspaceFolder}/build" }`는 프로젝트 경로로 치환되지
않습니다. `defaultUri`를 생략해 마지막 선택 위치를 사용하거나 해당 환경의 절대 경로/URI를 지정하세요.
`"when": { "var": "${mode}", "equals": "${other.value}" }`의 비교값 역시 문자 그대로입니다.

### 내장 변수와 사용 조건

실행 시작 시 캡처되는 내장 변수는 다음과 같습니다.

| 변수 | 값 |
| --- | --- |
| `${workspaceFolder}` | 액션 워크스페이스 폴더 |
| `${extensionPath}` | TaskHub 설치 경로 |
| `${file}` | 활성 파일 절대 경로 |
| `${relativeFile}` | **활성 파일이 속한** 워크스페이스 폴더 기준 상대 경로 |
| `${relativeFileDirname}` | 위 상대 경로의 폴더 |
| `${fileDirname}` | 활성 파일의 절대 폴더 |
| `${fileBasename}` | 확장자를 포함한 파일명 |
| `${fileBasenameNoExtension}` | 확장자 없는 파일명 |
| `${fileExtname}` | 점을 포함한 확장자 |
| `${fileWorkspaceFolder}` | 활성 파일이 속한 워크스페이스 |
| `${selectedText}` | 선택한 텍스트 |
| `${lineNumber}`, `${columnNumber}` | 커서 위치, 1부터 시작 |
| `${clipboard}` | 클립보드 텍스트 |
| `${env:NAME}` | 환경변수 값 |

활성 파일이 없는데 `${file}`을 쓰거나 정의되지 않은 `${env:NAME}`을 쓰면, 일반적인 미해결 태스크
참조와 달리 **해당 태스크가 실패**합니다. `${relativeFile}`·`${fileWorkspaceFolder}`는 활성 파일이
워크스페이스 안에 있어야 합니다. 비어 있는 클립보드나 선택 문자열은 정상 값이지만, 필요한 읽기 문맥이
없는 경우에는 실패할 수 있습니다. 사용 불가능한 내장값도 `??` 뒤에 유효한 참조가 있으면 대체할 수 있습니다.

멀티루트에서 액션은 `/work/appA`, 활성 파일은 `/work/appB/src/main.c`에 있다면 `${workspaceFolder}`는
`/work/appA`, `${relativeFile}`은 `src/main.c`입니다. 현재 파일 자체를 명령에 전달하려면 `${file}`로
절대 경로를 넘기세요. `file`, `workspaceFolder`처럼 내장 변수와 같은 태스크 ID는 피하는 편이 좋습니다.
동명 태스크가 있으면 `${file}` 같은 축약 참조에서도 그 태스크의 결과가 내장 변수보다 우선합니다.

변수 한 번의 치환값은 최대 32,768자이며 NUL 문자는 허용하지 않습니다. 큰 출력 전체나 바이너리를
변수로 전달하지 말고 파일을 생성해 경로를 연결하세요. 이는 [출력 캡처 크기 설정](features.md#21-설정-레퍼런스)과
별개의 제한입니다.

## 10. 자주 쓰는 조합

### 경로 종류와 command 옵션을 각각 선택

첫 QuickPick은 `pathDialog.mode`와 입력 종류 옵션을 함께 만들고, 두 번째 QuickPick은 파서 옵션을
만듭니다. 각 선택의 `value`는 흐름 제어용 의미값, `args`는 command 전용 argv입니다.

```json
[
  {
    "id": "firmware.parse",
    "title": "Parse firmware",
    "action": {
      "description": "입력 종류와 파서 옵션을 선택해 실행합니다.",
      "tasks": [
        {
          "id": "kind",
          "type": "quickPick",
          "placeHolder": "입력 종류를 선택하세요",
          "items": {
            "ZIP 파일": { "value": "file", "args": "--input-file" },
            "압축 해제 폴더": { "value": "folder", "args": "--input-dir" }
          },
          "rememberLastSelection": true
        },
        {
          "id": "target",
          "type": "pathDialog",
          "mode": "${kind}",
          "options": { "openLabel": "분석 대상 선택" }
        },
        {
          "id": "parserOptions",
          "type": "quickPick",
          "placeHolder": "파서 옵션을 선택하세요",
          "items": {
            "기본 실행": [],
            "상세 분석": ["--verbose"],
            "강제 재분석": ["--force", "--verbose"]
          },
          "rememberLastSelection": true
        },
        {
          "id": "run",
          "type": "command",
          "command": "python",
          "args": ["parser.py", "${kind.args}", "${parserOptions}", "${target.path}"]
        }
      ]
    }
  }
]
```

### JavaScript 파일에 실행 옵션 전달

번들 [`media/actions_example.json`](../media/actions_example.json)의 **Complete Example: Run JavaScript
with Parameters**는 Node.js가 설치된 환경에서 `.js` 파일을 실행합니다. 선택한 스크립트가 `--env`,
`--port`, 선택적 `--verbose` / `--flag` 인자를 받도록 작성되어 있어야 합니다.

파일 경로와 입력값은 `args`의 개별 원소로 전달합니다. 추가 옵션은 QuickPick의 `args` 배열로
선택하며, **No extra options**는 빈 배열이므로 argv를 추가하지 않습니다. **Verbose with flag**는
`--verbose`와 `--flag`를 각각 전달합니다. 직접 입력한 문자열의 공백은 자동으로 여러 인자로
분리하지 않습니다. 여러 옵션은 이 예제처럼 배열로 정의합니다.

### 여러 파일을 각각 처리

`fileDialog.options.canSelectMany`로 고른 배열을 command의 `forEach`에 연결합니다.

```jsonc
{ "id": "files", "type": "fileDialog",
  "options": { "canSelectMany": true, "openLabel": "파일 선택" } },
{ "id": "convert", "type": "command",
  "forEach": "${files.paths}",
  "command": "converter", "args": ["${each}"] }
```

### 선택값에 따라 명령 자체 변경

인자만 달라지고 의미값이 필요 없으면 QuickPick의 `value` 배열이 가장 짧습니다. 같은 선택을 흐름
제어에도 쓰면 `value`와 `args`를 나누고, 실행할 프로그램이나 태스크 종류까지 달라질 때만 `switch`를
사용합니다.

## 11. 실행 전 확인

- JSON 자동완성과 오류 밑줄: [`schema/actions.schema.json`](../schema/actions.schema.json)
- **Preview Run**: 액션 우클릭 → 실제 명령·쓰기·대화상자 없이 한 액션 시뮬레이션
- **TaskHub Doctor**: 전체 액션 소스의 변수, 분기, 의존성, 보안상 위험을 Problems 패널에서 검사
- 실행 기록과 입력 재사용: [`features.md`의 액션 실행 히스토리](features.md#14-액션-실행-히스토리)

Preview와 Doctor의 차이 및 진단 목록은 [`features.md`의 TaskHub Doctor](features.md#23-taskhub-doctor-action-lint)를
참고합니다.
