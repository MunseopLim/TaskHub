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
6. [파일·아카이브·값 변환](#6-파일아카이브값-변환)
7. [조건·분기·반복](#7-조건분기반복)
8. [출력 캡처와 표시](#8-출력-캡처와-표시)
9. [변수 참조](#9-변수-참조)
10. [자주 쓰는 조합](#10-자주-쓰는-조합)
11. [실행 전 확인](#11-실행-전-확인)

## 1. 가장 작은 액션

`actions.json`의 최상위 값은 배열입니다. 실행 가능한 항목은 `id`, `title`, `action`을 가지며,
`description`, `tasks`, `successMessage`, `failMessage`는 모두 **`action` 안에** 작성합니다.

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
| ZIP 압축·해제 | `zip`, `unzip` | `source`/`archive`/`destination` | `archivePath`/`outputDir` |
| 선택값에 따라 작업 변경 | `switch` | `on`, `cases` | `matched`, `selected`, 선택 case 결과 |

## 3. 공통 작성 규칙

### 실행 순서와 실패

태스크는 기본적으로 배열 순서대로 실행되고 첫 실패에서 액션이 중단됩니다.

| 필드 | 동작 |
| --- | --- |
| `timeoutSeconds` | 제한 시간(초). `0` 또는 생략은 제한 없음 |
| `continueOnError` | `true`이면 실패·timeout·입력 취소 후 다음 태스크 계속 실행 |
| `when` | 조건이 참일 때만 실행 |
| `dependsOn` | 먼저 끝나야 할 태스크 ID 배열 |
| `parallel` | `true`이면 앞선 모든 태스크를 기다리는 기본 장벽에서 제외 |
| `forEach` | 배열의 각 값을 대상으로 비대화형 태스크를 반복 |

`${taskId.key}` 참조가 있으면 해당 태스크에 대한 의존성은 자동으로 잡힙니다. 병렬 실행의 자세한 규칙은
[`features.md`의 병렬 실행 / Task DAG](features.md#24-병렬-실행--task-dag)를 참고합니다.

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

### `command`

실행 파일과 인자를 argv로 실행합니다. `&&`, `|`, `>`, 셸 변수 같은 문자는 셸 연산자가 아니라 일반
인자로 전달됩니다.

```json
{
  "id": "flash",
  "type": "command",
  "command": "python",
  "args": ["flash.py", "--board", "${board}", "${firmware.path}"],
  "cwd": "${workspaceFolder}",
  "env": { "MODE": "release" },
  "revealTerminal": "always"
}
```

| 필드 | 설명 |
| --- | --- |
| `command` | 문자열 또는 `{ "windows", "macos", "linux" }` 객체 |
| `args` | argv 배열. 배열 결과를 정확히 한 원소로 참조하면 여러 argv로 펼쳐짐 |
| `cwd` | 작업 디렉터리. 생략 시 액션 워크스페이스 |
| `env` | 자식 프로세스에 추가할 환경변수 |
| `revealTerminal` | `always`, `silent`, `never` |
| `passTheResultToNextTask` | `true`이면 stdout/stderr 캡처 |
| `isOneShot` | 프로세스를 시작한 직후 태스크 성공 처리. 캡처와 함께 사용할 수 없음 |
| `output` | 캡처 결과의 표시·저장·추출·Problems 진단 |

### `shell`

`command` 문자열을 셸에 전달합니다. `&&`, `|`, `>`, 셸 변수 등이 필요할 때만 사용합니다.

```json
{
  "id": "buildAndTest",
  "type": "shell",
  "command": "npm run build && npm test"
}
```

- macOS/Linux 캡처 모드는 `/bin/sh`를 사용합니다.
- Windows는 Windows PowerShell을 사용하며 필요한 경우 PowerShell 7을 찾습니다.
- 플랫폼별 차이를 피하려면 연산자 체인을 여러 `command` 태스크로 나눕니다.

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
- `args`: `value`와 별도로 command에 넘길 argv 배열
- `id`: 선택 기억과 History 재실행에 쓰는 선택적 고정 식별자

선택값을 `pathDialog.mode` 같은 흐름 제어에도 쓰고 command 옵션도 만들어야 한다면 `value`와 `args`를
같이 둡니다. `${kind.args}`는 배열이므로 command의 `args` 원소 전체에 넣어야 argv 여러 칸으로
펼쳐집니다. 정적 항목 중 하나라도 `args`를 선언하면 이 태스크는 항상 `args` 결과를 만듭니다.
매핑이 없는 항목이나 `allowCustom` 직접 입력을 고르면 `args: []`가 되어 인자를 추가하지 않습니다.
JSONL 동적 목록도 같은 계약을 사용합니다.

```jsonc
{ "id": "kind", "type": "quickPick", "items": [
  { "label": "ZIP 파일", "value": "file", "args": ["--input-file"] },
  { "label": "압축 해제 폴더", "value": "folder", "args": ["--input-dir"] }
] },
{ "id": "target", "type": "pathDialog", "mode": "${kind}" },
{ "id": "run", "type": "command", "command": "parser",
  "args": ["${kind.args}", "${target.path}"] }
```

| 태스크 필드 | 설명 |
| --- | --- |
| `canPickMany` | 여러 항목 선택 |
| `default` | 처음 활성화할 label. 다중 선택이면 label 배열 |
| `allowCustom` | 목록 밖의 직접 입력 허용. `canPickMany`와 함께 사용할 수 없음 |
| `rememberLastSelection` | 마지막 선택을 워크스페이스·액션·태스크별로 복원 |
| `itemsFromCommand` | 명령 stdout으로 목록 생성 |
| `itemsFromCommandFormat` | `lines` 또는 줄마다 객체인 `jsonl` |
| `itemsExclude` | 동적 목록에서 제외할 정확한 값 |

주요 결과는 다음과 같습니다.

| 결과 | 값 |
| --- | --- |
| `value` | 첫 선택의 매핑값. `${taskId}`로 줄여 쓸 수 있음 |
| `args` | 태스크의 별도 command 인자 배열. 정적 항목 중 하나라도 `args`를 선언하거나 동적 형식이 `jsonl`이면 항상 생성 |
| `label` | 첫 선택의 표시 문구 |
| `valueList`, `labelList` | 전체 선택의 손실 없는 배열 |
| `values`, `labels` | 다중 선택 값을 쉼표로 이은 문자열 |
| `custom` | 목록 밖 직접 입력 여부 |

동적 목록은 기본적으로 비어 있지 않은 stdout 한 줄을 label/value로 사용합니다. 객체 매핑이 필요하면
`itemsFromCommandFormat: "jsonl"`을 쓰고 줄마다 다음 형식으로 출력합니다.

```jsonl
{"id":"local","label":"로컬 실행","value":[]}
{"id":"release","label":"릴리스 배포","value":["--mode","release"]}
```

동적 항목도 의미값과 command 인자를 나누려면
`{"id":"archive","label":"아카이브","value":"file","args":["--input-file"]}`처럼 출력합니다.

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

## 6. 파일·아카이브·값 변환

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
사용하며, 지정하면 7z 호환 도구를 사용합니다. 결과는 `${package.archivePath}`입니다.

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
참조할 수 있습니다.

`zip`과 `unzip`의 `tool`은 플랫폼별 객체를 사용할 수 있습니다.

```json
{
  "windows": "C:\\Program Files\\7-Zip\\7z.exe",
  "macos": "/opt/homebrew/bin/7z",
  "linux": "/usr/bin/7z"
}
```

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
- case는 `command`, `shell`, `stringManipulation`, `writeFile`, `appendFile`, `zip`, `unzip`만 지원
- 대화상자는 case 안에 넣지 않고 별도 태스크와 `pathDialog`를 사용

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

대화형 태스크, `switch`, `isOneShot` 태스크에는 사용할 수 없습니다. 반복 결과는 `count`, `outputs`,
`stderrs` 등의 배열·집계 결과를 제공합니다.

## 8. 출력 캡처와 표시

### Output Capture

`command`·`shell`의 stdout을 뒤 태스크에서 사용하려면 `passTheResultToNextTask: true`가 필요합니다.

```json
{
  "id": "revision",
  "type": "command",
  "command": "git",
  "args": ["rev-parse", "HEAD"],
  "passTheResultToNextTask": true
}
```

- `${revision.output}`: stdout
- `${revision.stderr}`: stderr
- `${revision}`: 대표 결과인 stdout

`output.capture`로 결과 일부를 이름 있는 값으로 추출할 수 있습니다.

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

이 값은 `${revision.shortSha}`로 참조합니다. `capture`는 객체 하나 또는 배열이며 `regex`, `group`,
`flags`, `line`, `trim`을 지원합니다.

### 출력 표시·저장

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
| `editor` | 읽기 전용 편집기로 표시. `language` 지정 가능 |
| `terminal` | 읽기 전용 터미널로 표시 |
| `file` | `filePath`에 저장. `overwrite`, `content` 지원 |

`output.diagnostics`는 캡처 문자열을 Problems 항목으로 바꿉니다. 값으로 `"$gcc"`, `"$tsc"`
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
- `${a.value ?? b.value}`는 왼쪽부터 실제로 존재하는 첫 값을 사용합니다.
- 배열 참조가 `args` 원소 전체이면 여러 argv로 펼쳐집니다.
- `"--file=${files.paths}"`처럼 다른 글자와 섞이면 공백으로 합친 argv 하나가 됩니다.
- 해석되지 않은 참조는 일반적으로 `${…}` 리터럴로 남고 Doctor가 진단합니다.
- 태스크 자신은 참조할 수 없습니다.

실행 시작 시 캡처되는 내장 변수는 다음과 같습니다.

| 변수 | 값 |
| --- | --- |
| `${workspaceFolder}` | 액션 워크스페이스 폴더 |
| `${extensionPath}` | TaskHub 설치 경로 |
| `${file}` | 활성 파일 절대 경로 |
| `${relativeFile}` | 워크스페이스 기준 활성 파일 경로 |
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
          "items": [
            { "label": "ZIP 파일", "value": "file", "args": ["--input-file"] },
            { "label": "압축 해제 폴더", "value": "folder", "args": ["--input-dir"] }
          ],
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
          "items": [
            { "label": "기본 실행", "value": "default", "args": [] },
            { "label": "상세 분석", "value": "verbose", "args": ["--verbose"] },
            { "label": "강제 재분석", "value": "force", "args": ["--force", "--verbose"] }
          ],
          "rememberLastSelection": true
        },
        {
          "id": "run",
          "type": "command",
          "command": "python",
          "args": ["parser.py", "${kind.args}", "${parserOptions.args}", "${target.path}"]
        }
      ]
    }
  }
]
```

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
