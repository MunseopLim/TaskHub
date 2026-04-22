# TaskHub 상세 기능 문서

이 문서는 TaskHub의 모든 기능에 대한 상세 설명을 제공합니다.
간략한 소개는 [README.md](../README.md)를 참조하세요.

## 목차

1.  [사용자 지정 메인 뷰](#1-사용자-지정-메인-뷰)
2.  [사용자 지정 아이콘](#2-사용자-지정-아이콘)
3.  [JSON 설정 파일](#3-json-설정-파일)
4.  [링크 패널 (Built-in / Workspace)](#4-링크-패널-built-in--workspace)
5.  [Actions 패널 (`mainView.main`)](#5-actions-패널-mainviewmain)
6.  [즐겨찾기 패널 (`mainView.favorite`)](#6-즐겨찾기-패널-mainviewfavorite)
7.  [확장 프로그램 버전 표시](#7-확장-프로그램-버전-표시)
8.  [액션 생성 마법사](#8-액션-생성-마법사)
9.  [검색 기능](#9-검색-기능)
10. [그룹화 기능](#10-그룹화-기능)
11. [작업 종료](#11-작업-종료)
12. [Multi-root 워크스페이스 지원](#12-multi-root-워크스페이스-지원)
13. [쉬운 설정 관리](#13-쉬운-설정-관리)
14. [액션 실행 히스토리](#14-액션-실행-히스토리)
15. [C/C++ Hover 기능](#15-cc-hover-기능)
16. [Experimental Features](#16-experimental-features)
17. [Preset 기능](#17-preset-기능)
18. [액션 Import/Export](#18-액션-importexport)
19. [Memory Map 시각화](#19-memory-map-시각화)
20. [Hex Viewer](#20-hex-viewer)

---

## 1. 사용자 지정 메인 뷰

이 확장 프로그램은 VS Code 활동 표시줄에 'H' 아이콘으로 식별되는 사용자 지정 뷰 컨테이너를 도입합니다. 이 메인 뷰(`mainView`)는 다섯 개의 하위 뷰를 호스팅합니다:

*   **Actions 패널 (`mainView.main`)**: 다양한 액션 버튼과 정보를 포함하며, 'M' 아이콘으로 식별됩니다.
*   **Built-in 링크 패널 (`mainView.linkBuiltin`)**: 확장에서 기본 제공하는 링크를 표시하며, 'L' 아이콘으로 식별됩니다. 읽기 전용입니다.
*   **워크스페이스 링크 패널 (`mainView.linkWorkspace`)**: 현재 워크스페이스에 정의된 링크를 표시하며, 'L' 아이콘으로 식별됩니다.
*   **즐겨찾기 패널 (`mainView.favorite`)**: 구성 가능한 즐겨찾는 파일 목록을 표시하며, 'F' 아이콘으로 식별됩니다.
*   **히스토리 패널 (`mainView.history`)**: 최근 실행한 액션들의 기록을 추적하고 관리하며, 'R' 아이콘으로 식별됩니다.

## 2. 사용자 지정 아이콘

활동 표시줄의 메인 뷰는 사용자 지정 'H' 모양의 SVG 아이콘(`media/h_icon.svg`)을 사용합니다.

## 3. JSON 설정 파일

이 확장 프로그램은 `actions.json`, `links.json`, 그리고 `favorites.json` 파일을 사용하여 뷰의 내용을 구성합니다.

*   **파일 로드 우선순위**:
    *   Actions 패널은 `media/actions.json`과 워크스페이스의 `.vscode/actions.json`을 병합하여 표시합니다.
    *   링크 패널은 두 개로 나뉩니다: Built-in은 `media/links.json`만 표시하고, 워크스페이스 링크 패널은 워크스페이스의 `.vscode/links.json`만 표시합니다.
    *   즐겨찾기 패널은 워크스페이스의 `.vscode/favorites.json`을 표시합니다.
    *   관련 JSON 파일이 수정, 생성 또는 삭제되면 해당 뷰는 자동으로 새로 고쳐집니다.

### JSON Editor 커맨드

Command Palette에서 `taskhub json`을 검색하면 두 개의 JSON Editor 커맨드가 표시됩니다. 용도가 다르므로 상황에 맞게 선택하세요.

| 커맨드 | 동작 | 사용 시점 |
| --- | --- | --- |
| **TaskHub: Open JSON Editor** (`taskhub.openJsonEditor`) | 파일 선택 대화상자를 띄워 임의의 JSON 파일을 고른 뒤 JSON Editor로 엽니다. 활성 에디터와 무관하게 항상 동일하게 동작합니다. | Command Palette에서 임의의 JSON 파일을 바로 열고 싶을 때 |
| **TaskHub: Open with JSON Editor** (`taskhub.openJsonEditorFromUri`) | URI 인자를 받는 컨텍스트 커맨드입니다. 에디터/탐색기/SCM 컨텍스트 메뉴의 *Open with JSON Editor* 항목에서 대상 파일을 전달받아 엽니다. Command Palette에서 인자 없이 실행하면 현재 활성 에디터가 `.json` 파일일 때 그 파일을 열고, 그 외에는 *Open JSON Editor* 동작으로 폴백해 파일 선택 대화상자를 띄웁니다. | `.json` 파일을 연 상태에서 빠르게 JSON Editor로 전환하거나, 탐색기/에디터 우클릭 메뉴에서 호출할 때 |

## 4. 링크 패널 (Built-in / Workspace)

이제 링크는 두 개의 별도 패널로 나뉩니다.

*   **Built-in 링크 (`mainView.linkBuiltin`)**: `media/links.json`에 정의된 기본 링크를 표시합니다. 읽기 전용이며, 복사/열기만 가능합니다.
*   **워크스페이스 링크 (`mainView.linkWorkspace`)**: 워크스페이스의 `.vscode/links.json`에 정의된 링크를 표시합니다. 제목에는 링크의 총 개수가 표시됩니다 (예: "Workspace Links (5)").

**주요 기능:**
*   **링크 클릭**: 링크 항목을 클릭하면 기본 브라우저에서 URL이 열립니다.
*   **인라인 액션**: 각 링크 항목에 마우스를 올리면 다음 인라인 아이콘들이 표시됩니다:
    *   복사 아이콘: URL을 클립보드에 복사
    *   브라우저 아이콘: 브라우저에서 열기
    *   연필 아이콘 (워크스페이스 링크만): 링크 편집
    *   휴지통 아이콘 (워크스페이스 링크만): 링크 삭제
*   **링크 추가**: 뷰 상단의 + 버튼을 클릭하여 새 링크를 추가할 수 있습니다.
*   **검색**: 돋보기 아이콘을 클릭하여 링크를 빠르게 검색할 수 있습니다.
*   **파일 편집**: 연필 버튼을 클릭하여 `links.json` 파일을 직접 편집할 수 있습니다.

## 5. Actions 패널 (`mainView.main`)

이 패널은 `media/actions.json` (그리고 `.vscode/actions.json`이 있다면 추가된 내용)에 정의된 다양한 구성 가능한 액션을 제공합니다. 새로운 스키마는 '태스크(Task)'라는 통일된 개념을 중심으로 설계되어, 간단한 명령어부터 여러 단계를 거치는 복잡한 파이프라인까지 일관된 방식으로 정의할 수 있습니다.

### 기본 구조

`actions.json` 파일은 최상위에 객체 배열을 가집니다. 각 객체는 다음 중 하나일 수 있습니다.
-   **액션 (`ActionItem`)**: UI에 버튼으로 표시되는 실행 가능한 항목입니다.
-   **폴더 (`Folder`)**: 다른 액션들을 그룹화하는 폴더입니다. (`type: "folder"`)
-   **구분선 (`Separator`)**: 시각적 구분선입니다. (`type: "separator"`)

**예시:**
```json
[
  {
    "id": "action.simple.echo",
    "title": "Echo Message",
    "action": { ... }
  },
  {
    "type": "separator",
    "title": "----------"
  },
  {
    "id": "folder.build",
    "type": "folder",
    "title": "Build Tasks",
    "children": [ ... ]
  }
]
```

### 액션과 태스크 (`action` and `tasks`)

모든 실행 가능한 액션은 `action` 객체를 가지며, 그 안에는 한 개 이상의 `tasks` 배열이 포함됩니다.
-   `tasks` 배열에 태스크가 하나만 있으면: 간단한 단일 액션입니다.
-   `tasks` 배열에 태스크가 여러 개 있으면: 태스크가 순서대로 실행되는 **파이프라인**입니다.

```json
"action": {
  "description": "Explain what this pipeline does in the TaskHub panel.",
  "successMessage": "Pipeline finished successfully!",
  "failMessage": "Pipeline failed.",
  "tasks": [
    { ... task 1 ... },
    { ... task 2 ... }
  ]
}
```

- `description` (string, **필수**): Actions 패널에서 액션을 마우스오버 할 때 표시되는 간단한 설명입니다.
- `successMessage` (string, *선택*): 모든 태스크가 성공적으로 완료되었을 때 표시되는 팝업 알림 메시지입니다.
- `failMessage` (string, *선택*): 태스크 실행 중 오류가 발생했을 때 표시되는 팝업 알림 메시지입니다.

### 태스크 객체 (`Task`)

태스크는 실행의 가장 작은 단위이며, 다음과 같은 주요 속성을 가집니다.

-   `id` (string, **필수**): 태스크의 고유 ID입니다. 파이프라인 내에서 다른 태스크가 이 태스크의 결과를 참조할 때 사용됩니다.
-   `type` (string, **필수**): 태스크의 종류입니다. (예: `shell`, `fileDialog`, `unzip`, `zip`, `stringManipulation`)

### `shell` / `command` 태스크의 핵심 옵션

가장 일반적으로 사용되는 `shell` 또는 `command` 태스크는 다음과 같은 중요한 옵션을 가집니다.

-   **`command`** (`string` | `object`, **필수**): 실행할 명령어입니다.
    -   단순 문자열: `"command": "echo Hello"`
    -   OS별 객체:
        ```json
        "command": {
          "windows": "dir",
          "linux": "ls -la",
          "macos": "ls -la"
        }
        ```
    -   객체 형태를 사용할 때는 현재 실행 중인 OS에 해당하는 키를 반드시 포함해야 합니다. `default`, `command`와 같은 보조 키는 지원하지 않습니다.

-   **`passTheResultToNextTask`** (`boolean`, *선택*, 기본값: `false`): 태스크의 실행 방식을 결정하는 가장 중요한 옵션입니다.
    -   **`false` (또는 생략 시) - 스트림 모드 (Stream Mode):**
        -   명령어의 출력이 VS Code의 내장 터미널에 **실시간으로 스트리밍**됩니다.
        -   하나의 액션에 포함된 여러 스트림 모드 태스크들은 **하나의 공유된 터미널**에 순차적으로 실행되어, 전체 작업 흐름을 한눈에 파악하기 용이합니다.
        -   작업이 완료된 후 터미널은 바로 닫히지 않고, "계속하려면 아무 키나 누르십시오..." 메시지와 함께 사용자의 입력을 기다립니다.
        -   Windows 환경에서는 `PowerShell`을 기본 셸로 사용하여, 유니코드 문자(예: 한글)의 깨짐 현상을 해결했습니다.
        -   이 모드에서는 출력을 캡처하지 않으므로, **다음 태스크에서 이 태스크의 결과를 변수로 사용할 수 없습니다.**
    -   **`true` - 캡처 모드 (Capture Mode):**
        -   명령어의 출력이 터미널에 표시되지 않고, 내부적으로 **캡처**됩니다.
        -   캡처된 결과는 파이프라인의 다음 태스크에서 `${task_id.output}` 형태로 사용할 수 있습니다.
        -   캡처된 결과는 `output` 블록을 통해 파일이나 에디터로 보내는 등 추가적인 처리가 가능합니다.
    -   참고: `revealTerminal` 속성은 스트림 모드(`passTheResultToNextTask: false`)에서만 적용됩니다. 캡처 모드에서는 터미널이 열리지 않습니다.

-   **`output`** (`object`, *선택*): 캡처된 결과를 어떻게 처리할지 정의합니다. `mode` 사용은 캡처 모드(`passTheResultToNextTask: true`)에서만 동작하지만, `capture` 규칙만 쓸 때는 `mode`를 생략할 수 있습니다.
    -   `"mode": "editor"`: 새 에디터 탭에 결과를 표시합니다.
    -   `"mode": "file"`: 지정된 파일에 결과를 저장합니다. (`filePath`, `overwrite` 속성 사용)
        -   `overwrite` (boolean | string, *선택*, 기본값: `false`): `true`로 설정하면 기존 파일을 덮어씁니다. `false`이거나 생략하면 파일이 이미 존재할 때 실행이 실패합니다. 문자열로 지정하면 변수 치환(예: `"${someVar}"`)을 사용할 수 있으며, 치환된 값이 `"true"`(대소문자 무시)이면 덮어쓰기가 활성화됩니다.
    -   `"mode": "terminal"`: 액션 ID별로 재사용되는 Task 패널(`TaskHub: <액션 ID>`)에 결과를 붙여넣습니다.
    -   `"capture"` (object | array, *선택*): 태스크 출력 문자열에서 **원하는 값만 뽑아 파생 변수**를 만듭니다. 자세한 내용은 아래 [Output Capture](#output-capture) 섹션 참고.

#### Output Capture

`shell`/`command`/`stringManipulation` 태스크의 출력 문자열에서 정규식·라인 인덱스로 값을 뽑아 `${task_id.<name>}` 형태의 파생 변수로 파이프라인 다음 태스크에 전달합니다. 기존 `${task_id.output}`은 그대로 유지되며(원본 보존), 캡처는 순수하게 **추가**입니다.

**동작 조건**
- `shell`/`command`: `passTheResultToNextTask: true` 필요 (스트림 모드에서는 stdout이 캡처되지 않으므로 capture는 무시되고 verbose 로그에 경고가 남음).
- `stringManipulation`: 항상 문자열을 반환하므로 capture 가능.

**단일 규칙 예시**

```json
{
  "id": "git-sha",
  "type": "shell",
  "command": "git rev-parse HEAD",
  "passTheResultToNextTask": true,
  "output": {
    "capture": { "name": "shortSha", "regex": "^([a-f0-9]{7})" }
  }
}
```

다음 태스크에서 `${git-sha.shortSha}` 형태로 사용.

**여러 규칙 예시**

```json
{
  "output": {
    "capture": [
      { "name": "sha",    "regex": "commit ([a-f0-9]+)" },
      { "name": "author", "regex": "Author: (.+)", "trim": true },
      { "name": "last",   "line": -1 }
    ]
  }
}
```

**필드**

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `name` | `string` (**필수**) | 파생 변수 이름. `${task_id.<name>}`로 참조. `/^[A-Za-z_][A-Za-z0-9_]*$/`만 허용. `output`, `path`, `value` 등 내장 키는 예약어로 차단. |
| `regex` | `string` | 출력 전체에 매칭할 정규식. 매칭 시 `group`에 지정한 그룹 값을 사용. |
| `group` | `integer` | 캡처 그룹 인덱스. 기본값: 캡처 그룹이 있으면 `1`, 없으면 `0`(전체 매칭). `0`을 명시하면 항상 전체 매칭. |
| `flags` | `string` | 정규식 플래그 (예: `"i"`, `"m"`, `"is"`). |
| `line` | `integer` | 0부터 시작하는 라인 인덱스. 음수는 끝에서부터 (`-1` = 마지막 라인). `regex`와 함께 지정하면 `regex`가 우선. |
| `trim` | `boolean` | 선택된 값에 `.trim()` 적용. 기본값 `false`. |

**실패 정책**
- 규칙이 매칭되지 않으면 **조용히 건너뜀** — 파생 변수가 생성되지 않고 이후 `${id.<name>}`는 미해결 placeholder로 남음 (Preview Run에서 경고로 보임).
- 설정 오류(이름 누락, 예약어, 잘못된 정규식, 중복 이름)는 **즉시 에러**로 실행 중단.

#### Preview Run (Dry-run)

액션을 **실행하지 않고** 파이프라인이 어떻게 해석되는지 미리 보는 기능입니다. Actions 패널에서 액션 우클릭 → **Preview Run (Dry-run)** 또는 Command Palette에서 `TaskHub: Preview Run (Dry-run)`.

결과는 `TaskHub Preview` 출력 채널에 표시되며 다음을 포함합니다:

- 각 태스크의 해석된 `command` / `args` / `cwd` / `env`
- `output.filePath`의 해석값과 **워크스페이스 외부 쓰기 경고**
- 선언된 `capture` 규칙 목록 (downstream에서 참조되는 변수명 표시)
- 상류 태스크 결과는 `<fileDialog:id:path>` 같은 placeholder로 시뮬레이션되어 변수 연결 확인 가능
- 미해결 `${...}` 변수 요약 (오타·상류 태스크 누락 발견에 유용)

실제 shell 실행, 파일 쓰기, 대화상자 표시는 일어나지 않습니다.

-   **`isOneShot`** (`boolean`, *선택*, 기본값: `false`): **스트림 모드에서만 의미가 있습니다.**
    -   `true`로 설정하면, `notepad.exe` 같은 GUI 프로그램처럼 종료되지 않는 프로세스를 실행하고 즉시 '성공'으로 처리합니다.

### `unzip` 태스크

이 태스크는 지정된 아카이브 파일의 압축을 해제합니다. `tool`을 생략하면 **내장 zip 엔진**(번들 포함)을 사용하고, `tool`을 지정하면 외부 CLI(예: 7z)를 호출합니다.

-   `type` (string, **필수**): `unzip`으로 설정해야 합니다.
-   `tool` (string | object, *선택*): 압축 해제에 사용할 외부 도구의 경로입니다.
    -   **생략 시**: 내장 엔진으로 `.zip` 아카이브를 해제합니다. 별도 설치가 필요 없습니다.
    -   **지정 시**: 해당 CLI를 `x <archive> -o<destDir> -aoa` 인자로 호출합니다 (7z 호환 셰이프). `.7z`, `.rar` 등 내장 엔진이 처리할 수 없는 포맷에 사용하세요.
-   `inputs.archive` (string, *선택*): 이전 태스크 ID를 지정하여 아카이브 경로를 전달합니다. (예: `{"archive": "select_zip_file"}`)
-   `inputs.file` (string, *선택*): `inputs.archive`의 레거시 별칭입니다.
-   `inputs.destination` (string, *선택*): 이전 태스크 ID를 지정하여 압축 해제 대상 폴더를 전달합니다. (예: `{"destination": "select_destination_folder"}`)
-   `archive` (string, *선택*): 직접 경로를 지정합니다. `${...}` 치환을 활용할 수 있습니다.
-   `destination` (string, *선택*): 직접 대상 폴더 경로를 지정합니다. `${...}` 치환을 활용할 수 있습니다.
-   **실행 결과**: 다음 태스크에서 `${unzip_task.outputDir}`을 사용해 해제된 폴더 경로를 참조할 수 있습니다.

아카이브 경로는 `inputs.archive` → `inputs.file` → `archive` 순으로 해석됩니다. 대상 폴더는 `destination` → `inputs.destination` → (지정된 아카이브의 상위 폴더) 순으로 결정됩니다.

내장 엔진은 아카이브 엔트리 이름을 검증하여 대상 디렉터리를 벗어나는 경로(zip-slip)를 거부합니다.

### `folderDialog` 태스크

사용자에게 폴더 선택 대화상자를 표시합니다.

- `type` (string, **필수**): `folderDialog`로 설정해야 합니다.
- `options` (object, *선택*): `vscode.OpenDialogOptions`와 동일한 옵션을 사용할 수 있습니다. (예: `openLabel`, `defaultUri`)
- **실행 결과**: 다음 태스크에서 `${task_id.path}`(절대 경로), `${task_id.dir}`(부모 디렉토리), `${task_id.name}`(폴더 이름), `${task_id.fileNameOnly}`(확장자 제외 이름), `${task_id.fileExt}`(확장자) 등을 사용할 수 있습니다. `fileDialog`와 동일한 속성을 제공합니다.

### `zip` 태스크

이 태스크는 지정된 파일이나 폴더를 압축하여 하나의 아카이브 파일을 생성합니다. `unzip`과 마찬가지로 `tool`을 생략하면 내장 zip 엔진을 사용합니다.

-   `type` (string, **필수**): `zip`으로 설정해야 합니다.
-   `tool` (string | object, *선택*): 압축에 사용할 외부 도구의 경로입니다.
    -   **생략 시**: 내장 엔진이 `.zip` 아카이브를 만듭니다. 디렉터리 source는 그 이름이 아카이브 최상위 폴더로 보존됩니다.
    -   **지정 시**: 해당 CLI를 `a <archive> <source...>` 인자로 호출합니다.
-   `source` (string | string[], **필수**): 압축할 파일 또는 폴더의 경로입니다. 단일 경로는 문자열로, 여러 경로는 배열로 지정할 수 있습니다.
-   `archive` (string, **필수**): 생성될 압축 파일의 경로와 이름입니다.
-   **실행 결과**: 생성된 압축 파일 경로는 `${zip_task.archivePath}`로 다음 태스크에서 참조할 수 있습니다.

**예시 — 내장 엔진 (tool 생략):**
```json
{
  "id": "action.zip.builtin",
  "title": "Zip (built-in)",
  "action": {
    "tasks": [
      {
        "id": "zip_task",
        "type": "zip",
        "source": [
          "${workspaceFolder}/src",
          "${workspaceFolder}/README.md"
        ],
        "archive": "${workspaceFolder}/project-archive.zip"
      }
    ]
  }
}
```

**예시 — 외부 7z:**
```json
{
  "id": "action.zip.external",
  "title": "Zip Project Files",
  "action": {
    "tasks": [
      {
        "id": "zip_task",
        "type": "zip",
        "tool": {
          "windows": "C:\\Program Files\\7-Zip\\7z.exe",
          "macos": "/usr/local/bin/7z"
        },
        "source": [
          "${workspaceFolder}/src",
          "${workspaceFolder}/README.md"
        ],
        "archive": "${workspaceFolder}/project-archive.7z"
      }
    ]
  }
}
```

### `stringManipulation` 태스크

간단한 문자열 후처리를 수행하여 다음 태스크에서 사용할 값을 만들 때 활용합니다.

-   `type` (string, **필수**): `stringManipulation`으로 설정해야 합니다.
-   `function` (string, **필수**): 수행할 내장 함수 이름입니다.
-   `input` (string, **필수**): 변환 대상 문자열입니다. 이전 태스크 결과를 `${...}` 형태로 참조할 수 있습니다.
-   **실행 결과**: 변환된 문자열은 `${task_id.output}`으로 접근합니다.

지원되는 함수 목록:

| 함수 | 설명 |
| --- | --- |
| `stripExtension` | 마지막 확장자를 제거합니다. (`/path/to/file.zip` → `/path/to/file`) |
| `basename` | 경로에서 파일 이름만 추출합니다. (`/path/to/file.zip` → `file.zip`) |
| `basenameWithoutExtension` | 확장자를 제외한 파일 이름을 반환합니다. (`/path/to/file.zip` → `file`) |
| `dirname` | 상위 디렉터리 경로를 반환합니다. (`/path/to/file.zip` → `/path/to`) |
| `extension` | 확장자에서 점을 제외한 문자열을 반환합니다. (`/path/to/file.zip` → `zip`) |
| `toLowerCase` | 전체 문자열을 소문자로 변환합니다. |
| `toUpperCase` | 전체 문자열을 대문자로 변환합니다. |
| `trim` | 문자열 앞뒤의 공백을 제거합니다. |

**예시:**
```json
{
  "id": "string_task",
  "type": "stringManipulation",
  "function": "basenameWithoutExtension",
  "input": "${select_file.path}"
}
```

### `inputBox` 태스크

사용자로부터 텍스트 입력을 받아 다음 태스크에서 사용할 수 있습니다. 명령어 실행 시 필요한 파라미터를 동적으로 입력받을 때 유용합니다.

-   `type` (string, **필수**): `inputBox`로 설정해야 합니다.
-   `prompt` (string, *선택*): 입력 박스에 표시될 프롬프트 메시지입니다.
-   `value` (string, *선택*): 입력 박스의 기본값입니다.
-   `placeHolder` (string, *선택*): 입력 박스의 플레이스홀더 텍스트입니다.
-   `password` (boolean, *선택*, 기본값: `false`): `true`로 설정하면 입력값이 마스킹됩니다 (비밀번호 입력용).
-   `prefix` (string, *선택*): 사용자 입력 앞에 자동으로 추가될 텍스트입니다. 최종값은 `prefix + 사용자입력 + suffix`가 됩니다.
-   `suffix` (string, *선택*): 사용자 입력 뒤에 자동으로 추가될 텍스트입니다.
-   **실행 결과**: 입력된 값(prefix/suffix 포함)은 `${task_id.value}`로 접근합니다.

**예시 1: 간단한 입력**
```json
{
  "id": "input_name",
  "type": "inputBox",
  "prompt": "Enter your name",
  "placeHolder": "John Doe"
}
```

**예시 2: prefix와 suffix 사용**
```json
{
  "id": "input_args",
  "type": "inputBox",
  "prompt": "Enter arguments (prefix '-g' will be added automatically)",
  "placeHolder": "Test 1234 123",
  "prefix": "-g ",
  "suffix": " --verbose"
}
```
사용자가 "Test 1234 123"을 입력하면 `${input_args.value}` = "-g Test 1234 123 --verbose"

**예시 3: 비밀번호 입력**
```json
{
  "id": "input_password",
  "type": "inputBox",
  "prompt": "Enter API key",
  "password": true
}
```

### `quickPick` 태스크

미리 정의된 옵션 목록에서 사용자가 선택할 수 있습니다. 환경 선택, 빌드 타입 선택 등에 유용합니다.

-   `type` (string, **필수**): `quickPick`으로 설정해야 합니다.
-   `items` (array, **필수**): 선택 가능한 항목 목록입니다. 문자열 배열 또는 객체 배열을 사용할 수 있습니다.
    -   문자열 배열: `["dev", "staging", "production"]`
    -   객체 배열: `[{"label": "dev", "description": "개발 환경", "detail": "상세 설명"}]`
-   `placeHolder` (string, *선택*): Quick Pick에 표시될 플레이스홀더 텍스트입니다.
-   `canPickMany` (boolean, *선택*, 기본값: `false`): `true`로 설정하면 다중 선택이 가능합니다.
-   **실행 결과**:
    -   단일 선택: `${task_id.value}` (선택된 항목의 label)
    -   다중 선택: `${task_id.value}` (첫 번째 선택), `${task_id.values}` (모든 선택, 쉼표로 구분)

**예시 1: 간단한 선택**
```json
{
  "id": "select_env",
  "type": "quickPick",
  "placeHolder": "Select deployment environment",
  "items": ["dev", "staging", "production"]
}
```

**예시 2: 설명이 있는 선택**
```json
{
  "id": "select_build",
  "type": "quickPick",
  "placeHolder": "Select build type",
  "items": [
    {
      "label": "debug",
      "description": "Debug build with symbols",
      "detail": "Best for development and debugging"
    },
    {
      "label": "release",
      "description": "Optimized release build",
      "detail": "Best for production deployment"
    }
  ]
}
```

**예시 3: 다중 선택**
```json
{
  "id": "select_features",
  "type": "quickPick",
  "placeHolder": "Select features to enable (multiple selection)",
  "canPickMany": true,
  "items": ["authentication", "logging", "caching", "monitoring"]
}
```
선택 결과: `${select_features.values}` = "authentication,logging"

### `envPick` 태스크

현재 확장 호스트 프로세스의 `process.env` 에 존재하는 **모든 환경변수 이름**을 정렬해 QuickPick 으로 보여주고, 사용자가 고른 이름을 다음 태스크로 전달합니다. 값은 picker 에 노출하지 않으므로 이름만으로 안전하게 탐색할 수 있습니다.

-   `type` (string, **필수**): `envPick` 으로 설정해야 합니다.
-   `placeHolder` (string, *선택*): QuickPick 에 표시될 안내 문구. 생략 시 기본 문구 ("Select an environment variable name" / "환경변수 이름을 선택하세요") 사용.
-   **실행 결과**: `${task_id.value}` — 선택된 환경변수의 **이름**. 값은 반환하지 않으므로 `printenv ${task_id.value}` 등 후속 `shell` 태스크에서 값을 조회합니다.
-   취소 시 파이프라인이 중단됩니다.

**예시: 선택 후 값 출력 (기본 제공 액션과 동일)**
```json
{
  "tasks": [
    {
      "id": "env_pick",
      "type": "envPick",
      "placeHolder": "Type to filter, then select an environment variable"
    },
    {
      "id": "show_env_value",
      "type": "shell",
      "command": {
        "windows": "cmd /c echo %${env_pick.value}%",
        "macos": "printenv ${env_pick.value}",
        "linux": "printenv ${env_pick.value}"
      },
      "revealTerminal": "always"
    }
  ]
}
```

### `confirm` 태스크

파이프라인 실행 중간에 사용자에게 확인 대화상자를 표시합니다. 위험한 작업(플래싱, 배포, 삭제 등) 전에 안전장치로 활용할 수 있습니다.

-   `type` (string, **필수**): `confirm`으로 설정해야 합니다.
-   `message` (string, *선택*, 기본값: `"Are you sure you want to continue?"`): 확인 대화상자에 표시될 메시지입니다. 변수 치환(`${...}`)을 지원합니다.
-   `confirmLabel` (string, *선택*, 기본값: `"Yes"`): 확인 버튼의 레이블입니다.
-   `cancelLabel` (string, *선택*, 기본값: `"No"`): 취소 버튼의 레이블입니다.
-   **실행 결과**: 사용자가 확인을 선택하면 `${task_id.confirmed}` = `"true"`를 반환합니다. 취소를 선택하거나 대화상자를 닫으면 파이프라인 실행이 중단됩니다.

**예시 1: 기본 확인**
```json
{
  "id": "confirm_deploy",
  "type": "confirm",
  "message": "정말 배포하시겠습니까?"
}
```

**예시 2: 커스텀 레이블과 변수 치환**
```json
{
  "id": "confirm_flash",
  "type": "confirm",
  "message": "${select_device.value} 장치에 펌웨어를 플래싱합니다. 계속하시겠습니까?",
  "confirmLabel": "플래싱 시작",
  "cancelLabel": "취소"
}
```

### `writeFile` / `appendFile` 태스크

문자열 콘텐츠를 파일로 쓰거나 기존 파일에 이어 붙입니다. shell의 `echo > file` 우회를 대체하는 일급 태스크로, OS별 분기·셸 이스케이프 없이 동작합니다.

- `type` (string, **필수**): `writeFile` 또는 `appendFile`.
- `path` (string, **필수**): 대상 파일 경로. 변수 치환 지원. 상대 경로는 액션의 워크스페이스 폴더를 기준으로 해석되며, 워크스페이스 외부로 빠져나가는 경로는 거부됩니다.
- `content` (string, **필수**): 파일에 쓸 내용. 변수 치환 지원. 빈 문자열(`""`)도 허용.
- `encoding` (string, *선택*, 기본값: `"utf8"`): `"utf8"` | `"utf8bom"` | `"ascii"`.
    - `utf8`: BOM 없는 UTF-8.
    - `utf8bom`: 선두에 BOM(EF BB BF) 추가. `appendFile`에서는 **대상 파일이 존재하지 않을 때에만** BOM을 추가합니다 (기존 파일 중간에 BOM을 끼워 넣어 깨뜨리지 않음).
    - `ascii`: Node `ascii` 인코딩. 비-ASCII 문자는 안전하지 않으니 ASCII 입력에만 사용하세요.
- `eol` (string, *선택*, 기본값: `"keep"`): 줄바꿈 정규화. `"lf"` | `"crlf"` | `"keep"`.
- `overwrite` (boolean, *선택*, 기본값: `true`): `writeFile`에서만 의미 있음. `false`면 기존 파일이 있을 때 실패합니다. `appendFile`에서는 무시됩니다.
- `mkdirs` (boolean, *선택*, 기본값: `true`): 상위 디렉터리 자동 생성. `false`면 부모 디렉터리가 없을 때 실패.
- **실행 결과**: 다음 태스크에서 `${task_id.path}`로 절대 경로를 참조할 수 있습니다.

**예시 1: 빌드 메타데이터 헤더 생성**
```json
{
  "id": "git-sha",
  "type": "shell",
  "command": "git rev-parse HEAD",
  "passTheResultToNextTask": true,
  "output": { "capture": { "name": "shortSha", "regex": "^([a-f0-9]{7})" } }
}
```
```json
{
  "id": "stamp",
  "type": "writeFile",
  "path": "src/buildinfo.h",
  "content": "#define GIT_SHA \"${git-sha.shortSha}\"\n",
  "eol": "lf"
}
```

**예시 2: 로그에 한 줄 이어쓰기**
```json
{
  "id": "log",
  "type": "appendFile",
  "path": "logs/deploy.log",
  "content": "[${timestamp.value}] deployed by ${user.value}\n"
}
```

**예시 3: BOM 붙은 Windows 친화적 텍스트 파일**
```json
{
  "id": "win-cfg",
  "type": "writeFile",
  "path": "tools/notice.txt",
  "content": "한글 메시지",
  "encoding": "utf8bom",
  "eol": "crlf"
}
```

### Task-level 옵션: `timeoutSeconds` / `continueOnError`

모든 태스크 타입에 공통으로 적용되는 흐름 제어 옵션입니다.

- **`timeoutSeconds`** (number, *선택*): 태스크가 이 시간(초) 안에 끝나지 않으면 취소되고 파이프라인이 timeout 에러로 실패합니다 (`continueOnError: true`이면 다음 태스크로 진행). `0`이거나 생략하면 timeout 비활성. shell/command 태스크의 경우 timeout이 발동하면 실행 중인 자식 프로세스를 best-effort로 종료합니다.
- **`continueOnError`** (boolean, *선택*, 기본값: `false`): `true`이면 이 태스크가 실패해도 (timeout, 사용자 취소, 워크스페이스 경로 위반 등 어떤 사유든) 파이프라인이 다음 태스크로 진행합니다. 실패한 태스크의 결과는 `{}`로 저장되어 downstream의 `${task.output}`/`${task.path}` 등은 미해결 리터럴로 남습니다.

**예시: shell 빌드에 5분 timeout + cleanup은 실패해도 계속**
```json
{
  "id": "build",
  "type": "shell",
  "command": "npm run build",
  "timeoutSeconds": 300
}
```
```json
{
  "id": "cleanup-temp",
  "type": "shell",
  "command": "rm -rf .build-cache",
  "continueOnError": true
}
```

**예시: 사용자 취소를 흐름의 일부로 다루기**
```json
{
  "id": "ask-deploy",
  "type": "confirm",
  "message": "운영에 배포하시겠습니까?",
  "continueOnError": true
}
```
사용자가 취소해도 파이프라인은 다음 태스크로 진행되며, downstream에서 `${ask-deploy.confirmed}`는 미해결 리터럴로 남으므로 "확인됐을 때만 배포"하는 명령어 안에 변수로 끼워두면 자연스럽게 noop이 됩니다.

### 변수 치환

파이프라인 내에서, 이전 태스크의 결과는 `${task_id.property}` 형식으로 다음 태스크의 속성(예: `command`, `args`, `filePath` 등)에서 사용할 수 있습니다.

-   `fileDialog` / `folderDialog` 태스크 (`id: "select_file"`)의 결과 사용 예시:
    -   `${select_file.path}`: 전체 경로
    -   `${select_file.dir}`: 부모 디렉토리 경로
    -   `${select_file.name}`: 파일/폴더명
    -   `${select_file.fileNameOnly}`: 확장자를 제외한 이름
    -   `${select_file.fileExt}`: 확장자
-   `inputBox` 태스크 (`id: "input_name"`)의 결과 사용 예시:
    -   `${input_name.value}`: 입력된 값 (prefix/suffix 포함)
-   `quickPick` 태스크 (`id: "select_env"`)의 결과 사용 예시:
    -   `${select_env.value}`: 선택된 항목 (단일 선택 또는 다중 선택의 첫 번째 항목)
    -   `${select_env.values}`: 선택된 모든 항목 (다중 선택 시 쉼표로 구분된 문자열)
-   `confirm` 태스크 (`id: "confirm_task"`)의 결과 사용 예시:
    -   `${confirm_task.confirmed}`: 확인 여부 (`"true"`)
- `${zip_task.archivePath}`: `zip` 태스크가 생성한 아카이브 경로
- `${unzip_task.outputDir}`: `unzip` 태스크가 추출한 폴더 경로
- `${write_task.path}`: `writeFile` / `appendFile` 태스크가 쓴 파일의 절대 경로
- `${workspaceFolder}`: 현재 워크스페이스 폴더의 절대 경로
- `${extensionPath}`: 확장 프로그램이 설치된 절대 경로. 확장 내부에 포함된 리소스를 참조할 때 유용합니다.

### 전체 예시

```json
[
  {
    "id": "action.pipeline.example",
    "title": "Example: Select File, Echo, and Save",
    "action": {
      "successMessage": "Pipeline finished!",
      "tasks": [
        {
          "id": "select_a_file",
          "type": "fileDialog",
          "options": {
            "openLabel": "Select a text file"
          }
        },
        {
          "id": "echo_in_terminal",
          "type": "shell",
          "command": "echo [STREAM] You selected ${select_a_file.name}",
          "passTheResultToNextTask": false,
          "revealTerminal": "always"
        },
        {
          "id": "capture_file_content",
          "type": "shell",
          "command": {
            "windows": "type \"${select_a_file.path}\"",
            "linux": "cat \"${select_a_file.path}\"",
            "macos": "cat \"${select_a_file.path}\""
          },
          "passTheResultToNextTask": true
        },
        {
            "id": "save_to_file",
            "type": "shell",
            "command": "echo The content of ${select_a_file.name} is:\n\n${capture_file_content.output}",
            "passTheResultToNextTask": true,
            "output": {
                "mode": "file",
                "filePath": "${workspaceFolder}/report.txt",
                "overwrite": true
            }
        }
      ]
    }
  }
]
```

**파일 실행 + 파라미터 입력 예시:**

파일을 선택하고, 환경과 파라미터를 동적으로 입력받아 실행하는 실제 사용 예제입니다.

```json
{
  "id": "action.run.script.with.params",
  "title": "Run Script with Parameters",
  "action": {
    "description": "Select file, environment, and parameters to run a script",
    "successMessage": "Script executed successfully!",
    "tasks": [
      {
        "id": "select_script",
        "type": "fileDialog",
        "options": {
          "filters": {
            "Scripts": ["js", "py", "sh"]
          }
        }
      },
      {
        "id": "select_environment",
        "type": "quickPick",
        "placeHolder": "Select environment",
        "items": [
          {
            "label": "development",
            "description": "Development environment"
          },
          {
            "label": "staging",
            "description": "Staging environment"
          },
          {
            "label": "production",
            "description": "Production environment"
          }
        ]
      },
      {
        "id": "input_port",
        "type": "inputBox",
        "prompt": "Enter port number",
        "value": "3000",
        "placeHolder": "3000"
      },
      {
        "id": "input_extra_args",
        "type": "inputBox",
        "prompt": "Enter extra arguments (optional)",
        "placeHolder": "additional flags",
        "prefix": "--extra "
      },
      {
        "id": "run_script",
        "type": "shell",
        "command": "node ${select_script.path} --env ${select_environment.value} --port ${input_port.value} ${input_extra_args.value}",
        "revealTerminal": "always"
      }
    ]
  }
}
```

이 예제는 다음 과정을 거칩니다:
1. **파일 선택**: 실행할 스크립트 파일 선택 (`.js`, `.py`, `.sh`)
2. **환경 선택**: Quick Pick으로 development/staging/production 중 선택
3. **포트 입력**: 기본값 3000이 제시되며 사용자가 변경 가능
4. **추가 인자 입력**: 사용자가 입력하면 자동으로 `--extra` 플래그가 앞에 붙음
5. **스크립트 실행**: 모든 파라미터를 조합하여 명령어 실행

## 6. 즐겨찾기 패널 (`mainView.favorite`)

이 패널은 `.vscode/favorites.json`에 정의된 사용자가 즐겨찾는 파일 목록을 표시합니다. 필요하다면 파일을 열 때 이동할 줄 번호까지 함께 저장할 수 있으며, 뷰의 제목에는 즐겨찾기된 항목의 총 개수가 표시됩니다 (예: "Favorite Files (12)").

**주요 기능:**
*   **즐겨찾기 추가**: 뷰의 제목 표시줄에 있는 '+' 아이콘을 클릭하여 기존 파일을 즐겨찾기에 추가할 수 있습니다. 선택한 각 파일에 대해 제목, 그룹, 태그, 이동할 줄 번호를 입력할 수 있습니다.
*   **열려 있는 파일 추가**: 열려 있는 편집기에서 마우스 오른쪽 버튼을 클릭하여 컨텍스트 메뉴에서 "열려 있는 파일 즐겨찾기에 추가"를 선택할 수 있습니다. 기본값으로 현재 커서 위치의 줄 번호가 제안됩니다.
*   **클릭하여 열기**: 즐겨찾기 항목을 클릭하면 해당 파일이 VS Code에서 열립니다. 줄 정보가 있으면 해당 줄로 자동으로 이동합니다.
*   **인라인 액션**: 각 즐겨찾기 항목에 마우스를 올리면 휴지통 아이콘이 표시되며, 클릭하여 즐겨찾기를 삭제할 수 있습니다.
*   **검색**: 돋보기 아이콘을 클릭하여 즐겨찾기를 빠르게 검색할 수 있습니다.
*   **파일 편집**: 연필 버튼을 클릭하여 `favorites.json` 파일을 직접 편집할 수 있습니다.

## 7. 확장 프로그램 버전 표시

`mainView.main` 패널은 확장 프로그램의 현재 버전을 상단에 표시합니다. 버전 항목을 클릭하면 `CHANGELOG.md` 파일이 열려 최신 변경 내역을 확인할 수 있습니다. 또한 패널 제목 표시줄의 전구(💡) 아이콘을 클릭하면 `actions.json`, `links.json`, `favorites.json`의 예제 JSON 파일을 빠르게 열어볼 수 있습니다.

## 8. 액션 생성 마법사

`mainView.main` 패널의 제목 표시줄에 있는 '+' 아이콘을 클릭하면 대화형 액션 생성 마법사가 시작됩니다. 이 마법사를 통해 코드를 직접 작성하지 않고도 새로운 액션을 쉽게 생성할 수 있습니다.

*   **템플릿 선택**: 두 가지 템플릿 중 선택할 수 있습니다:
    *   **Single Shell Command**: 단일 셸 명령어를 실행하는 간단한 액션을 생성합니다.
    *   **File Picker + Shell**: 파일 선택 대화상자를 먼저 표시한 후, 선택된 파일 경로를 사용하는 셸 명령어를 실행하는 액션을 생성합니다.
*   **자동 저장**: 생성된 액션은 워크스페이스의 `.vscode/actions.json` 파일에 자동으로 추가되며, Actions 패널에 즉시 표시됩니다.
*   **즉시 실행**: 액션 생성 후 바로 실행할 수 있는 옵션이 제공됩니다.

## 9. 검색 기능

링크와 즐겨찾기 패널에는 빠른 검색 기능이 내장되어 있습니다.

*   **링크 검색**: `mainView.linkWorkspace` 패널의 제목 표시줄에 있는 돋보기 아이콘을 클릭하면 워크스페이스 링크를 검색할 수 있는 Quick Pick이 표시됩니다. 링크 제목과 URL을 기준으로 검색할 수 있으며, 선택하면 해당 링크가 브라우저에서 열립니다.
*   **즐겨찾기 검색**: `mainView.favorite` 패널의 제목 표시줄에 있는 돋보기 아이콘을 클릭하면 즐겨찾기 파일을 검색할 수 있습니다. 파일 제목과 경로를 기준으로 검색할 수 있으며, 선택하면 해당 파일이 에디터에서 열립니다.

## 10. 그룹화 기능

링크와 즐겨찾기는 그룹으로 정리할 수 있어 관련 항목을 체계적으로 관리할 수 있습니다.

*   **링크 그룹**: `links.json` 파일에서 `group` 속성을 사용하여 링크를 그룹화할 수 있습니다. 같은 그룹 이름을 가진 링크들은 접을 수 있는 트리 노드로 묶여서 표시됩니다.
*   **즐겨찾기 그룹**: `favorites.json` 파일에서 `group` 속성을 사용하여 즐겨찾기를 그룹화할 수 있습니다. 그룹은 계층적으로 표시되어 많은 파일을 효율적으로 관리할 수 있습니다.
*   **개수 표시**: 각 패널의 제목에는 전체 항목 개수가 표시됩니다 (예: "Workspace Links (5)", "Favorite Files (12)").

## 11. 작업 종료

실행 중인 액션은 개별적으로 또는 모두 한 번에 종료할 수 있습니다.

*   **개별 액션 종료**: 실행 중인 액션 항목을 마우스 오른쪽 버튼으로 클릭하거나 인라인 아이콘(사각형)을 클릭하여 해당 액션만 종료할 수 있습니다.
*   **모든 액션 종료**: `mainView.main` 패널의 제목 표시줄에 있는 사각형 아이콘을 클릭하면 `taskhub.terminateAllActions` 명령이 실행되어 확장 프로그램에 의해 시작된 모든 작업 터미널을 한 번에 닫을 수 있습니다. 이 기능은 현재 실행 중인 작업뿐만 아니라, 실행이 완료되어 대기 중인 터미널까지 모두 종료시킵니다.

## 12. Multi-root 워크스페이스 지원

이 확장 프로그램은 VS Code의 multi-root 워크스페이스를 완벽하게 지원합니다.

*   **워크스페이스별 설정**: 각 워크스페이스 폴더는 자체 `.vscode/actions.json`, `.vscode/links.json`, `.vscode/favorites.json` 파일을 가질 수 있습니다.
*   **자동 폴더 선택**: 여러 워크스페이스 폴더가 있는 경우, 파일을 추가하거나 편집할 때 대상 폴더를 선택하는 프롬프트가 표시됩니다.
*   **변수 치환**: `${workspaceFolder}` 변수는 각 워크스페이스 폴더에 맞게 올바르게 해석됩니다.

## 13. 쉬운 설정 관리

*   **설정 파일 편집**: 각 뷰(Actions, 링크, 즐겨찾기)의 제목 표시줄에 있는 연필 아이콘을 클릭하여 `.vscode` 폴더에 있는 `actions.json`, `links.json`, `favorites.json` 파일을 쉽게 열고 편집할 수 있습니다. 파일이 없으면 새로 생성됩니다.
*   **예제 JSON 보기**: Actions 패널 제목 표시줄의 전구(💡) 아이콘을 클릭하여 각 설정 파일의 예제 JSON 내용을 확인할 수 있습니다.
*   **확장 프로그램 설정 열기**: 명령 팔레트(Cmd/Ctrl+Shift+P)에서 `TaskHub: Open Extension Settings`를 실행하여 확장 프로그램과 관련된 모든 설정을 VS Code 설정 화면에서 쉽게 확인하고 수정할 수 있습니다.

## 14. 액션 실행 히스토리

메인 뷰의 최하단에 위치한 히스토리 패널은 최근 실행한 액션들의 기록을 추적하고 관리합니다.

**주요 기능:**
*   **실행 기록 추적**: 액션을 실행할 때마다 히스토리에 자동으로 추가되며, 제목에는 총 개수가 표시됩니다 (예: "History (10)").
*   **상태 표시**: 각 히스토리 항목은 실행 상태를 시각적으로 표시합니다:
    *   성공
    *   실패
    *   실행 중
*   **실행 시간 정보**: 히스토리 항목에 마우스를 올리면 액션이 실행된 정확한 시간이 툴팁으로 표시됩니다 (예: "Executed at: 2025-12-28 14:30:45").
*   **빠른 재실행**: 히스토리 항목을 클릭하면 해당 액션을 즉시 재실행할 수 있습니다. 재실행된 액션은 새로운 히스토리 엔트리로 추가됩니다.
*   **인라인 액션**: 각 히스토리 항목에 마우스를 올리면 다음 아이콘들이 표시됩니다:
    *   출력 보기 아이콘: 실패한 액션의 에러 메시지를 확인할 수 있습니다. 출력이 있는 항목에만 표시됩니다.
    *   휴지통 아이콘: 개별 히스토리 항목을 삭제합니다.
*   **전체 히스토리 삭제**: 패널 제목 표시줄의 버튼을 클릭하여 모든 히스토리를 한 번에 삭제할 수 있습니다 (확인 대화상자 표시).
*   **자동 제한**: 히스토리는 설정된 최대 개수까지만 유지되며, 초과 시 가장 오래된 항목부터 자동으로 삭제됩니다 (기본값: 10개).
*   **패널 표시/숨김**: 설정에서 히스토리 패널을 숨길 수 있으며, `TaskHub: Show History Panel` 명령으로 다시 표시할 수 있습니다.

## 15. C/C++ Hover 기능

C/C++ 파일 작업 시 마우스를 올리면 유용한 정보를 자동으로 표시하는 기능들입니다.

> **응답성 보호**: v0.3.12부터 모든 LSP 호출은 3초 타임아웃으로 래핑됩니다. C/C++ IntelliSense가 느리거나 응답하지 않더라도 에디터가 프리징되지 않으며, 값 해석이 불가능한 경우 기본 숫자 정보만 표시됩니다. 10,000자를 초과하는 라인(생성된/minified 코드)에서는 hover가 스킵됩니다.

### 15.1. Number Base Hover

숫자 값에 마우스를 올리면 다양한 진법(hex, decimal, binary)과 비트 정보를 자동으로 표시합니다.

**주요 기능:**
*   **숫자 리터럴 지원**: 다양한 형식의 숫자 리터럴을 인식합니다:
    *   16진수: `0xFF`, `0XFF`, `FFh`, `FFH`
    *   2진수: `0b11111111`, `0B11111111`
    *   10진수: `255`
    *   숫자 구분자: `0xFF'FF'FF`, `1'000'000`
*   **식별자 지원**: const 변수, enum 값, #define 매크로 등의 값도 자동으로 해석합니다:
    *   `const int MASK = 0xFF;` - MASK에 hover 시 0xFF 값 표시
    *   `enum Flags { FLAG_A = 0x01 };` - FLAG_A에 hover 시 0x01 값 표시
    *   `#define MAX_SIZE 0x1000` - MAX_SIZE에 hover 시 0x1000 값 표시
*   **전처리기 지시문 처리**: C/C++ Language Server와 통합되어 `#if`, `#else` 등 전처리기 지시문이 적용된 실제 값을 표시합니다
*   **진법 변환 표시**: Hex, Dec, Bin 형식으로 값을 변환하여 표시
*   **비트 정보 표시**:
    *   32비트 값: 8개의 4비트 그룹으로 한 줄 표시
    *   64비트 값: 16개의 4비트 그룹으로 두 줄 표시
    *   비트 위치 레이블: 각 4비트 그룹의 LSB 위치 표시 (0, 4, 8, 12...)
    *   Set bits 목록: 1로 설정된 모든 비트 위치 나열

**사용 예시:**
```cpp
const int MASK_VALUE = 0xFF;        // Hover 시: Hex: 0xFF, Dec: 255, Bin: 0b11111111
enum Status { READY = 0x01 };       // READY에 Hover 시: 0x01 정보 표시
int value = MASK_VALUE;             // MASK_VALUE에 Hover 시: 0xFF 정보 표시
```

### 15.2. SFR Bit Field Hover

임베디드 시스템 개발에서 사용되는 SFR (Special Function Register) 비트 필드에 마우스를 올리면 상세 정보를 표시합니다.

**지원 형식:**
SFR 헤더 파일에서 다음 형식의 주석을 인식합니다:
```cpp
Type field_name : bit_width; // [bit_pos][ACCESS_TYPE][reset_val] Description
```

**예시:**
```cpp
class RegTestInt {
public:
  template <typename Type>
  union IntRegSts {
    Type dword;
    struct {
      Type int0_set    : 1; // [0]       [RW1C][0x0] Test interrupt 1
      Type int_field_0 : 3; // [12:10]   [RW1C][0x7] Test field 0
      Type reserved    : 19; // [31:13][RO][0x0] Reserved field
    } rst;
  };
  IntRegSts<volatile uint32_t> uIntRegSts;
};
```

**주요 기능:**
*   **비트 필드 선언 및 사용처 모두 지원**: 비트 필드가 선언된 헤더 파일뿐만 아니라, 코드에서 사용하는 곳에서도 hover 정보를 표시합니다
*   **다중 정의 지원**: 동일한 이름의 SFR이 여러 헤더 파일에 정의되어 있을 경우:
    *   첫 번째 정의를 상세 테이블로 표시
    *   추가 정의들은 파일 경로와 요약 정보를 나열
    *   파일 경로를 클릭하면 해당 위치로 이동
*   **LSP 통합**: C/C++ Language Server를 활용하여 정확한 정의 위치를 찾습니다
*   **계층 구조 표시**: 클래스/구조체/유니온 등의 전체 계층 경로를 표시합니다 (예: `RegTestInt::IntRegSts::int_field_0`)

**표시 정보:**
*   **Bit Position**: 비트 위치 (예: `0`, `12:10`, `31:13`)
*   **Bit Width**: 비트 필드 너비 (예: `1 bit`, `3 bits`)
*   **Access Type**: 접근 타입 (예: `RW1C`, `RO`, `WO`)
*   **Reset Value**: 리셋 값 및 진법 변환 (예: `0x7 (Dec: 7, Bin: 0b111)`)
*   **Bit Mask**: 32비트 마스크 값 (해당 비트들이 모두 1일 때의 값, 예: `0x00001C00`)
*   **File**: 정의된 파일 위치 (예: `h1/test.h:47`)
*   **Description**: 비트 필드 설명

**Hover 출력 예시:**
```
### RegTestInt::IntRegSts::int_field_0

| Property | Value |
|---|---|
| Bit Position | 12:10 |
| Bit Width | 3 bits |
| Access Type | RW1C |
| Reset Value | 0x7 (Dec: 7, Bin: 0b111) |
| Bit Mask | 0x00001C00 |
| File | h1/test.h:47 |

Description: Test field 0

---

Additional definitions:

- h2/test.h:47 - RegTestInt::IntRegSts::int_field_0 [11:10][RW1C]
```

**지원되는 접근 타입:**

| 타입 | 의미 |
| --- | --- |
| `RO` | Read Only |
| `WO` | Write Only |
| `RW` | Read / Write |
| `RW1C` | Write 1 to Clear |
| `RW1S` | Write 1 to Set |
| `W1C` | Write 1 to Clear |
| `RWC` | Read / Write Clear |
| `RWS` | Sticky bit |

hover 시 Access Type이 약어와 함께 설명이 표시됩니다 (예: `RW1C (Write 1 to Clear)`)

### 15.3. Struct Size Hover

C/C++ 구조체/클래스 선언에 마우스를 올리면 전체 크기, 멤버별 오프셋, 패딩 정보를 자동으로 계산하여 표시합니다.

**주요 기능:**
*   **자동 크기 계산**: struct/class 키워드 또는 타입 이름에 hover 시 크기 정보 표시
*   **멤버별 상세 정보**: 각 멤버의 오프셋, 크기, alignment 표시
*   **패딩 계산**: 자동으로 패딩 바이트 계산
*   **배열 지원**: `int values[10]` 같은 배열 멤버 크기 계산
*   **커스텀 타입 지원**: 문서 내 정의된 struct/class를 자동으로 인식하여 중첩 타입 크기 계산

**지원 타입:**
*   **C 표준 타입**: `char`, `short`, `int`, `long`, `long long`, `float`, `double`
*   **고정 크기 타입**: `int8_t`, `uint8_t`, `int16_t`, `uint16_t`, `int32_t`, `uint32_t`, `int64_t`, `uint64_t`
*   **Windows 타입**: `BYTE`, `WORD`, `DWORD`, `QWORD`, `UINT8`, `UINT16`, `UINT32`, `UINT64`, `BOOL`, `BOOLEAN` 등
*   **포인터**: `void*`, `int*` 등 (기본 4바이트)

**사용 예시:**
```cpp
struct Context {
    UINT16 Aaaaa;      // offset: 0, size: 2
    UINT16 Bbbbb;      // offset: 2, size: 2
    UINT64 Ccccc;      // offset: 8, size: 8 (padding 4 bytes)
    UINT64 Ddddd;      // offset: 16, size: 8
    UINT32 Fffff[80];  // offset: 24, size: 320
};
// Total: 344 bytes
```

**Hover 출력 예시:**
```
### Struct: Context

**Total Size:** 344 bytes
**Alignment:** 8 bytes
**Padding:** 4 bytes

---

**Members:**

| Offset | Name | Type | Size | Alignment |
|--------|------|------|------|-----------|
| 0 | **Aaaaa** | UINT16 | 2 | 2 |
| 2 | **Bbbbb** | UINT16 | 2 | 2 |
| 8 | **Ccccc** | UINT64 | 8 | 8 |
| 16 | **Ddddd** | UINT64 | 8 | 8 |
| 24 | **Fffff** | UINT32[80] | 320 | 4 |
```

### 15.4. 커스텀 타입 설정 (taskhub_types.json)

프로젝트별로 커스텀 타입의 크기와 alignment를 정의할 수 있습니다.

**설정 파일 위치:** `.vscode/taskhub_types.json`

**파일 형식:**
```json
{
  "types": {
    "HANDLE": { "size": 8, "alignment": 8 },
    "PVOID": { "size": 8, "alignment": 8 },
    "MyCustomType": { "size": 16, "alignment": 4 }
  },
  "packingAlignment": 8
}
```

**속성 설명:**
*   `types`: 타입별 크기와 alignment 정의
    *   `size`: 타입의 크기 (바이트)
    *   `alignment`: alignment 요구사항 (바이트)
*   `packingAlignment`: 기본 struct packing alignment (1, 2, 4, 8). `1`로 설정하면 packed struct처럼 동작

**사용 예시 - 64비트 포인터 환경:**
```json
{
  "types": {
    "HANDLE": { "size": 8, "alignment": 8 },
    "PVOID": { "size": 8, "alignment": 8 },
    "SIZE_T": { "size": 8, "alignment": 8 },
    "ULONG_PTR": { "size": 8, "alignment": 8 }
  },
  "packingAlignment": 8
}
```

**사용 예시 - Packed struct 환경:**
```json
{
  "packingAlignment": 1
}
```

**JSON 스키마 지원:**
*   VS Code에서 자동 완성 및 유효성 검사 제공
*   스키마: `schema/taskhub_types.schema.json`

**설정:**
*   `taskhub.hover.numberBase.enabled`: Number Base Hover 및 SFR Bit Field Hover를 활성화/비활성화합니다 (기본값: `true`)

## 16. Experimental Features

TaskHub는 개발 중인 실험적 기능들을 위한 프레임워크를 제공합니다. 실험적 기능은 아직 완성되지 않았으며, 향후 버전에서 변경되거나 제거될 수 있습니다.

> 실험적 기능 추가 방법에 대한 개발자 가이드는 [CONTRIBUTING.md](../CONTRIBUTING.md)를 참조하세요.

### 16.1. Bit Operation Hover

C/C++ 코드에서 비트 연산의 결과를 hover tooltip으로 표시하는 기능입니다.

**주요 기능:**
- 비트 연산자 감지: `&=`, `|=`, `^=`, `<<=`, `>>=`, `~`, `&`, `|`, `^`, `<<`, `>>`
- 연산 전후 값 비교 (Before/After)
- 변경된 비트 위치 표시
- Set/Cleared 비트 목록
- 16진수, 10진수, 2진수 표현

**현재 상태:**
- 사용 가능

**활성화 방법:**
- VS Code 설정에서 `taskhub.experimental.bitOperationHover.enabled`를 `true`로 설정

**사용 예시:**
```c
uint32_t value = 0x0F;
value |= 0x80;  // Hover over '|=' to see: 0x0F → 0x8F
```

## 17. Preset 기능

Preset 기능을 사용하면 프로젝트 환경별(integration, hil 등) action 설정을 쉽게 공유하고 적용할 수 있습니다.

**주요 기능:**
- **Apply Preset**: 미리 정의된 preset을 현재 워크스페이스에 적용
- **Save as Preset**: 현재 actions를 preset으로 저장하여 팀원들과 공유

### Preset 저장 위치

Preset 파일은 다음 위치에서 자동으로 발견됩니다:

- **Extension Preset** (`presets/preset-*.json`): 확장 프로그램에 번들로 포함된 팀 공통 preset
- **Workspace Preset** (`.vscode/presets/preset-*.json`): 프로젝트별 preset (Git으로 공유 가능)

### 사용 방법

**1. Preset 적용하기**

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Apply Preset"** 실행:

1. 적용할 preset 선택 (example, integration, hil 등)
2. 기존 `actions.json`이 있는 경우:
   - **Replace**: 기존 내용을 preset으로 교체
   - **Merge**: 기존 내용과 preset 병합
3. Merge 선택 시 ID 충돌이 있으면 해결 방법 선택:
   - **Keep existing**: 기존 actions 우선, 충돌하지 않는 preset actions만 추가
   - **Use preset**: Preset actions 우선, 충돌하지 않는 기존 actions만 유지
   - **Keep both**: 모든 actions 유지 (중복 허용)

**2. Preset 저장하기**

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Save as Preset"** 실행:

1. Preset ID 입력 (예: integration, hil)
2. 저장 위치 선택:
   - **Workspace**: `.vscode/presets/`에 저장 (Git으로 공유)
   - **Extension**: Extension `presets/` 폴더에 저장
   - **Custom location**: 원하는 위치에 파일로 저장

### Preset 파일 포맷

Preset은 일반 `actions.json`과 동일한 형식을 사용합니다:

```json
[
  {
    "id": "preset.integration.git.checkout",
    "title": "Git: Checkout main",
    "action": {
      "description": "Switch to main branch",
      "tasks": [
        {
          "id": "checkout",
          "type": "shell",
          "command": "git checkout main && git pull"
        }
      ]
    }
  },
  {
    "id": "preset.integration.build",
    "title": "Build: Integration",
    "action": {
      "description": "Build for integration environment",
      "tasks": [
        {
          "id": "build",
          "type": "shell",
          "command": "make integration-build"
        }
      ]
    }
  }
]
```

### 팀 워크플로우 예시

1. **팀 리드**: 환경별 preset 작성 → `.vscode/presets/` 저장 → Git commit
2. **팀원들**: Git pull → "Apply Preset" 명령어로 원하는 환경 선택
3. **개인화**: 필요한 경우 개인 actions 추가 (Merge 모드 사용)

## 18. 액션 Import/Export

워크스페이스의 액션을 파일로 내보내거나, 외부 파일에서 액션을 가져올 수 있습니다. 팀원 간 액션 공유, 백업, 프로젝트 간 이동에 유용합니다.

### Export (내보내기)

#### 전체 내보내기

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Export Actions"** 실행:

1. 현재 워크스페이스의 `.vscode/actions.json`을 읽어옵니다.
2. 저장할 파일 위치와 이름을 선택합니다 (`.taskhub` 또는 `.json` 형식).
3. 메타데이터(버전, 내보낸 시간)와 함께 액션이 파일에 저장됩니다.

#### 개별 내보내기 (컨텍스트 메뉴)

Actions 패널에서 액션 또는 폴더를 **우클릭** → **"Export Action"** 선택:

1. 선택한 액션 하나 또는 폴더(하위 항목 전체 포함)만 내보냅니다.
2. 저장할 파일 위치와 이름을 선택합니다 (`.taskhub` 또는 `.json` 형식).
3. 내보낸 항목 수가 알림으로 표시됩니다.

**Export 파일 형식 (`.taskhub`):**
```json
{
  "version": 1,
  "exportedAt": "2026-03-31T12:00:00.000Z",
  "actions": [
    {
      "id": "action.build",
      "title": "Build Project",
      "action": { ... }
    }
  ]
}
```

### Import (가져오기)

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Import Actions"** 실행하거나, Actions 패널 타이틀바의 **Import 아이콘** ($(cloud-download))을 클릭:

1. 가져올 파일을 선택합니다 (`.taskhub` 또는 `.json` 형식).
2. 파일의 스키마 유효성을 검사합니다.
3. 기존 `.vscode/actions.json`과 병합합니다:
   - ID가 중복되지 않는 액션만 추가됩니다.
   - 중복된 ID는 건너뛰고, 건너뛴 항목을 알림으로 표시합니다.
4. `.vscode` 폴더가 없으면 자동으로 생성합니다.

**지원하는 Import 형식:**
- `.taskhub` 파일 (TaskHub Export 형식)
- `actions.json` 파일 (raw JSON 배열 형식)

## 19. Memory Map 시각화

ARM `.axf`/`.elf` 바이너리 파일을 파싱하여 메모리 사용량을 시각적으로 표시합니다. 임베디드 개발 시 Flash/RAM 사용량을 한눈에 파악할 수 있습니다.

### 사용 방법

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Show Memory Map"** 실행:

1. 입력 형식을 선택합니다:
   - **AXF/ELF 파일**: ARM 실행 바이너리 직접 파싱
   - **ARM Linker Listing**: `armlink --list` 출력 파일 파싱 (별도 링커 스크립트 불필요)
2. **(AXF/ELF 선택 시)** `.axf`, `.elf`, `.out` 파일을 선택합니다.
   - 메모리 영역 설정이 없으면 링커 스크립트(`.ld`/`.sct`) 선택을 제안합니다.
3. **(ARM Linker Listing 선택 시)** `*_axf_link.txt` 등 armlink listing 파일을 선택합니다.
   - Execution Region에서 메모리 영역 크기를 자동 추출합니다.
4. WebView 패널에서 메모리 사용량을 시각화합니다.

### 표시 정보

- **Region 요약 테이블**: 상단에 각 region별 Base, Size, Used, Free, Usage 한눈에 표시
- **Flash/RAM 요약**: 코드(`.text`), 읽기 전용 데이터(`.rodata`), 초기화 데이터(`.data`), BSS(`.bss`) 크기
- **메모리 영역별 사용률**: 설정된 메모리 영역에 대한 사용량 바 차트 (90% 이상: 빨강, 70% 이상: 주황, 기본: 초록)
- **세그먼트 레이아웃 바**: 메모리 영역 내 섹션 배치를 색상 블록으로 시각화 (CODE: 파랑, RODATA: 보라, DATA: 주황, NOBITS: 회색, FREE: 투명)
- **Free Space**: 메모리 영역 내 빈 공간 표시 (영역 헤더 및 테이블에 포함). Alignment padding (1~3바이트)은 의미 없는 공간으로 간주하여 Calc Free 및 세그먼트 레이아웃 바에서 제외
- **Linker/Calc 구분 표시**: listing 파일의 경우 링커 보고값(Used, Free)과 계산값(Calc Used, Calc Free)을 Overview 테이블과 Region Details 양쪽에서 구분하여 표시
- **전체 섹션 목록**: 이름, 주소, 크기, 타입(CODE/DATA/RODATA/NOBITS)
- **End 주소**: 섹션의 마지막 바이트 주소 (inclusive, `addr + size - 1`)

### AXF/ELF 심볼 기반 상세 분석

AXF/ELF 파일에서 프로그램 헤더(PT_LOAD)와 심볼 테이블(.symtab)을 파싱하여 armlink listing에 근접한 수준의 상세 정보를 제공합니다:

- **자동 리전 감지**: 링커 스크립트 없이도 ELF 프로그램 헤더의 PT_LOAD 세그먼트에서 FLASH/RAM 영역을 자동으로 감지
- **함수/변수 단위 분석**: 심볼 테이블이 포함된 AXF 파일의 경우 함수(FUNC)와 전역 변수(OBJECT) 단위로 크기를 분석
- **미할당 영역 표시**: 심볼로 커버되지 않는 섹션 부분은 `[other]`로 표시

> **참고**: stripped 바이너리(심볼 테이블이 제거된 파일)에서는 섹션 단위 분석만 제공됩니다. 가능하면 디버그 심볼이 포함된 `.axf` 파일을 사용하세요.

### Region별 Object Summary

각 Region Details 내부에 해당 region의 오브젝트(.o) 파일별 메모리 사용량을 집계하여 표시합니다 (오브젝트가 2개 이상인 region에서만 표시):

- 기본 접힘 상태, 클릭으로 펼침/접기
- 각 오브젝트의 총 크기 및 해당 region의 used 대비 점유율(%) 표시
- "Details ▶" 버튼: 오브젝트별 섹션 상세(Section, Address, End, Size, Type) 행 표시/숨김
- 크기순 내림차순 정렬로 가장 큰 오브젝트를 빠르게 파악

### 함수명 표시 (Region Details)

Region Details 테이블에서 Function 컬럼을 토글하여 각 엔트리의 함수/심볼명을 확인할 수 있습니다:

- **ARM Linker Listing**: 섹션 토큰에서 `.text.`, `.rodata.` 등 알려진 prefix를 제거하고 함수명 추출 (예: `.text._ZN4Test8FuncEv` → `_ZN4Test8FuncEv`)
- 괄호 없는 오브젝트 형식(`idx  .text._ZN...  Object.o`)에서도 함수명 추출 지원
- 알려지지 않은 prefix의 경우 섹션 토큰 전체를 그대로 표시
- 테이블 컬럼: **Object** | **Section** | **Function** | Address | End | Size | Bytes | Type
- "Function ▶" 버튼 클릭으로 Section + Function 컬럼 함께 표시/숨김 전환

### HTML 저장

Memory Map 패널 상단의 **"Save HTML"** 버튼을 클릭하면, 현재 보이는 화면 그대로를 standalone HTML 파일로 저장할 수 있습니다:

- 사용자가 펼치거나 접은 상태, 검색 필터 등 현재 DOM 상태가 그대로 반영됩니다
- 저장된 HTML 파일은 VS Code 없이 일반 브라우저에서 열 수 있습니다
- 팀원 공유, 리포트 보관, 오프라인 참조 용도로 활용할 수 있습니다

### 성능 최적화

대용량 ARM Linker Listing 파일(수천 개 엔트리)도 쾌적하게 표시할 수 있도록 다음 최적화가 적용되어 있습니다:

- **Lazy Rendering**: Region 카드는 접힌 상태로 표시되며, 펼칠 때만 상세 테이블을 동적 생성합니다. 초기 로드 시 불필요한 DOM 노드를 생성하지 않습니다.
- **Virtual Scrolling**: 200행을 초과하는 테이블은 보이는 영역 + 버퍼만 렌더링합니다. 스크롤 시 `requestAnimationFrame`으로 효율적으로 갱신됩니다.
- **Data-driven Search/Sort**: 검색과 정렬이 JSON 데이터 배열에서 처리되어 DOM 전체 순회 없이 빠르게 동작합니다.

### 검색 및 탐색

- **키워드 검색**: 상단 검색창에서 섹션 이름, 주소, 타입으로 필터링. 접힌 region 내부도 검색되며 매치 시 자동으로 펼침
- **다중 패널**: 서로 다른 파일을 열면 각각 별도 탭으로 표시됩니다. 동일 파일명이라도 경로가 다르면 독립 패널로 열리며, 같은 파일을 다시 열면 기존 패널을 재사용합니다.
- **Region 이동** (`Ctrl+Shift+O`): Memory Map 패널이 활성화된 상태에서 VS Code QuickPick으로 region 목록을 표시하고, 선택 시 해당 region으로 스크롤 및 펼침 (마지막으로 활성화된 패널 기준)
- **Region 요약 테이블 클릭**: 상단 Overview 테이블의 row 클릭 시 해당 Region Details로 스크롤 및 자동 펼침
- **Region 폴딩**: 각 region 카드가 기본 접힘 상태로 표시되며, 클릭으로 토글 가능 (헤더 + 사용률 바는 항상 표시)
- **Expand All / Collapse All**: Region Details 섹션에서 전체 region을 일괄 펼침/접기 가능
- **섹션 테이블 정렬**: Region Details 및 All Sections 테이블에서 컬럼 헤더 클릭으로 오름차순/내림차순 정렬. Size/Bytes/% 컬럼은 첫 클릭 시 내림차순. Size 정렬 시 단위(B/KB/MB) 관계없이 실제 바이트 크기 기준 정렬
- **맨 위로 이동**: 페이지 하단 스크롤 시 우하단에 floating ↑ 버튼 표시, 클릭 시 페이지 최상단으로 이동

### 메모리 영역 설정

`.vscode/taskhub_types.json`에 `memoryMap.regions`를 추가하면 영역별 사용률 바 차트가 표시됩니다:

```json
{
  "memoryMap": {
    "regions": [
      { "name": "FLASH", "origin": 134217728, "size": 1048576 },
      { "name": "RAM", "origin": 536870912, "size": 262144 }
    ]
  }
}
```

- `origin`: 메모리 영역의 시작 주소 (10진수 또는 정수)
- `size`: 메모리 영역의 총 크기 (바이트)

Cortex-R/M 시리즈 모두 지원합니다 (ELF32, Little/Big Endian).

### 링커 스크립트 자동 파싱

`taskhub_types.json` 설정 대신 링커 스크립트 파일에서 메모리 영역을 자동으로 추출할 수 있습니다.

**GNU Linker Script (`.ld`):**
```
MEMORY
{
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 1M
    RAM (rwx)   : ORIGIN = 0x20000000, LENGTH = 256K
    DTCM (rwx)  : ORIGIN = 0x20010000, LENGTH = 64K
}
```

**ARM Scatter File (`.sct`):**
```
LR_IROM1 0x08000000 0x00100000 {
    ER_IROM1 0x08000000 0x00100000 {
        *.o (RESET, +First)
        .ANY (+RO)
    }
    RW_IRAM1 0x20000000 0x00040000 {
        .ANY (+RW +ZI)
    }
}
```

**우선순위:** `taskhub_types.json`의 `memoryMap.regions` 설정이 있으면 링커 스크립트 선택을 건너뜁니다.

### ARM Linker Listing 파싱

`armlink --list` 옵션으로 생성되는 listing 파일(`*_axf_link.txt`)을 파싱합니다. ELF + 링커 스크립트 조합 없이 이 파일 하나로 메모리 맵 전체를 구성할 수 있습니다.

- ARM Compiler 5 (armcc) 및 ARM Compiler 6 (armclang) 포맷 지원
- Execution Region에서 시작 주소, 현재 크기, 최대 크기 추출
- 섹션 엔트리별 주소, 크기, 타입, 소속 오브젝트 파일 추출
- 동일 섹션 이름 자동 집계 (예: 여러 .o 파일의 `.text` → 하나로 합산)
- **Region별 Object Summary**: 각 region 내부에 오브젝트(.o) 파일별 크기 및 점유율(%) 집계
- **함수명 추출/표시**: 섹션 토큰에서 `.text.` 등 prefix를 제거하여 함수명 추출, Region Details에서 Function 컬럼 토글로 확인
- Image Totals (RO/RW/ROM 크기) 파싱

### 지원 파일 형식

| 확장자 | 설명 |
| --- | --- |
| `.axf` | ARM Executable Format |
| `.elf` | ELF (Executable and Linkable Format) |
| `.out` | GCC 기본 출력 파일 |
| `.ld`, `.lds`, `.lcf` | GNU Linker Script |
| `.sct` | ARM Scatter File |
| `.txt` | ARM Linker Listing (`armlink --list` 출력) |

## 20. Hex Viewer

펌웨어 이미지 파일(`.hex`, `.bin`, `.srec`)을 VS Code 내에서 Hex dump 형태로 열어볼 수 있는 뷰어입니다. Trace32의 `Data.dump`와 유사한 UX를 제공합니다.

### 사용 방법

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Open Hex Viewer"** 실행:

1. 파일을 선택합니다 (`.hex`, `.srec`, `.bin` 등).
2. 포맷을 자동 감지하여 WebView 패널에서 Hex dump를 표시합니다.

### 화면 구성

| 영역 | 설명 |
|------|------|
| **헤더** | 파일명, 포맷 (Intel HEX/Motorola SREC/Binary), 크기, 주소 범위, Entry Point |
| **툴바** | Unit 크기, Endian, Go to, Find, Copy |
| **Address 컬럼** | 실제 메모리 주소 (Intel HEX의 Extended Address 반영) |
| **Hex 컬럼** | 바이트 데이터를 Unit 크기에 맞춰 그룹핑하여 표시 |
| **ASCII 컬럼** | 출력 가능 문자는 그대로, 나머지는 `.` 표시 |
| **상태바** | 선택한 바이트의 Offset, Address, u8/u16/u32 해석 |

### Unit 크기 옵션

표시 단위를 1/2/4/8바이트 단위로 변경할 수 있습니다:

| Unit | 표시 예시 | 용도 |
|------|-----------|------|
| **1 Byte** (기본) | `00 20 00 08` | 바이트 단위 분석 |
| **2 Bytes** (16-bit) | `2000 0800` | 16-bit 레지스터, short 값 확인 |
| **4 Bytes** (32-bit) | `00200008` | 32-bit 포인터, int 값 확인 |
| **8 Bytes** (64-bit) | `0020000800000000` | 64-bit 값 확인 |

Endian 설정 (Little-Endian/Big-Endian)에 따라 바이트 순서가 변경됩니다.

### 검색 기능

`Ctrl+F`로 Hex 바이트 패턴을 검색할 수 있습니다:
- 검색 입력: `08 00 00 20` 형식
- 매치 하이라이트 표시, Prev/Next로 이동

### 기타 기능

- **Go to**: 주소 입력으로 해당 위치로 즉시 스크롤
- **복사** (`Ctrl+C`): 드래그 선택 후 복사 시 탭 없이 스페이스 구분으로 정리된 텍스트 복사
- **Gap 표시**: Intel HEX/SREC에서 데이터가 없는 주소 영역은 회색으로 표시
- **Shift+클릭**: 범위 선택

### 대용량 파일 지원

Virtual scrolling을 사용하여 화면에 보이는 행만 렌더링합니다. 바이너리 파일은 `Uint8Array` 기반으로 파싱하여 64MB 이상의 대용량 파일도 원활하게 표시할 수 있습니다.

### 지원 포맷

| 포맷 | 확장자 | 특징 |
|------|--------|------|
| **Intel HEX** | `.hex`, `.ihex` | Extended Linear/Segment Address 지원, Entry Point 파싱 |
| **Motorola SREC** | `.srec`, `.s19`, `.s28`, `.s37` | S1/S2/S3 (16/24/32-bit 주소), S7/S8/S9 Entry Point |
| **Raw Binary** | `.bin`, `.dat` | 0x00000000부터 순차 표시 |
