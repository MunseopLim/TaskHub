# TaskHub VS Code 확장 프로그램

이 VS Code 확장 프로그램은 사용자 지정 활동 표시줄 뷰를 통해 반복적인 개발 작업을 자동화하고, 자주 사용하는 도구와 링크를 관리하는 유틸리티 기능을 제공합니다.

## 목차

1.  [기능](#기능)
    1.  [사용자 지정 메인 뷰](#1-사용자-지정-메인-뷰)
    2.  [사용자 지정 아이콘](#2-사용자-지정-아이콘)
    3.  [JSON 설정 파일](#3-json-설정-파일)
    4.  [링크 패널 (Built-in / Workspace)](#4-링크-패널-built-in--workspace)
    5.  [메인 패널 (`mainView.main`)](#5-메인-패널-mainviewmain)
    6.  [즐겨찾기 패널 (`mainView.favorite`)](#6-즐겨찾기-패널-mainviewfavorite)
    7.  [확장 프로그램 버전 표시](#7-확장-프로그램-버전-표시)
    8.  [액션 생성 마법사](#8-액션-생성-마법사)
    9.  [검색 기능](#9-검색-기능)
    10. [그룹화 기능](#10-그룹화-기능)
    11. [작업 종료](#11-작업-종료)
    12. [Multi-root 워크스페이스 지원](#12-multi-root-워크스페이스-지원)
    13. [쉬운 설정 관리](#13-쉬운-설정-관리)
2.  [설정](#설정)
3.  [설치](#설치)
4.  [사용법](#사용법)
5.  [개발](#개발)

## 기능

### 1. 사용자 지정 메인 뷰

이 확장 프로그램은 VS Code 활동 표시줄에 'H' 아이콘으로 식별되는 사용자 지정 뷰 컨테이너를 도입합니다. 이 메인 뷰(`mainView`)는 네 개의 하위 뷰를 호스팅합니다:

*   **메인 패널 (`mainView.main`)**: 다양한 액션 버튼과 정보를 포함하며, 'M' 아이콘으로 식별됩니다.
*   **Built-in 링크 패널 (`mainView.linkBuiltin`)**: 확장에서 기본 제공하는 링크를 표시하며, 'L' 아이콘으로 식별됩니다. 읽기 전용입니다.
*   **워크스페이스 링크 패널 (`mainView.linkWorkspace`)**: 현재 워크스페이스에 정의된 링크를 표시하며, 'L' 아이콘으로 식별됩니다.
*   **즐겨찾기 패널 (`mainView.favorite`)**: 구성 가능한 즐겨찾는 파일 목록을 표시하며, 'F' 아이콘으로 식별됩니다.

### 2. 사용자 지정 아이콘

활동 표시줄의 메인 뷰는 사용자 지정 'H' 모양의 SVG 아이콘(`media/h_icon.svg`)을 사용합니다.

### 3. JSON 설정 파일

이 확장 프로그램은 `actions.json`, `links.json`, 그리고 `favorites.json` 파일을 사용하여 뷰의 내용을 구성합니다.

*   **파일 로드 우선순위**:
    *   메인 패널은 `media/actions.json`과 워크스페이스의 `.vscode/actions.json`을 병합하여 표시합니다.
    *   링크 패널은 두 개로 나뉩니다: Built-in은 `media/links.json`만 표시하고, 워크스페이스 링크 패널은 워크스페이스의 `.vscode/links.json`만 표시합니다.
    *   즐겨찾기 패널은 워크스페이스의 `.vscode/favorites.json`을 표시합니다.
    *   관련 JSON 파일이 수정, 생성 또는 삭제되면 해당 뷰는 자동으로 새로 고쳐집니다.

### 4. 링크 패널 (Built-in / Workspace)

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

### 5. 메인 패널 (`mainView.main`)

이 패널은 `media/actions.json` (그리고 `.vscode/actions.json`이 있다면 추가된 내용)에 정의된 다양한 구성 가능한 액션을 제공합니다. 새로운 스키마는 '태스크(Task)'라는 통일된 개념을 중심으로 설계되어, 간단한 명령어부터 여러 단계를 거치는 복잡한 파이프라인까지 일관된 방식으로 정의할 수 있습니다.

#### 기본 구조

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

#### 액션과 태스크 (`action` and `tasks`)

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

- `description` (string, **필수**): 메인 패널에서 액션을 마우스오버 할 때 표시되는 간단한 설명입니다.
- `successMessage` (string, *선택*): 모든 태스크가 성공적으로 완료되었을 때 표시되는 팝업 알림 메시지입니다.
- `failMessage` (string, *선택*): 태스크 실행 중 오류가 발생했을 때 표시되는 팝업 알림 메시지입니다.

#### 태스크 객체 (`Task`)

태스크는 실행의 가장 작은 단위이며, 다음과 같은 주요 속성을 가집니다.

-   `id` (string, **필수**): 태스크의 고유 ID입니다. 파이프라인 내에서 다른 태스크가 이 태스크의 결과를 참조할 때 사용됩니다.
-   `type` (string, **필수**): 태스크의 종류입니다. (예: `shell`, `fileDialog`, `unzip`, `zip`, `stringManipulation`)

#### `shell` / `command` 태스크의 핵심 옵션

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

-   **`output`** (`object`, *선택*): **캡처 모드(`passTheResultToNextTask: true`)에서만 동작합니다.** 캡처된 결과를 어떻게 처리할지 정의합니다.
    -   `"mode": "editor"`: 새 에디터 탭에 결과를 표시합니다.
    -   `"mode": "file"`: 지정된 파일에 결과를 저장합니다. (`filePath`, `overwrite` 속성 사용)
        -   `overwrite` (boolean | string, *선택*, 기본값: `false`): `true`로 설정하면 기존 파일을 덮어씁니다. `false`이거나 생략하면 파일이 이미 존재할 때 실행이 실패합니다. 문자열로 지정하면 변수 치환(예: `"${someVar}"`)을 사용할 수 있으며, 치환된 값이 `"true"`(대소문자 무시)이면 덮어쓰기가 활성화됩니다.
    -   `"mode": "terminal"`: 액션 ID별로 재사용되는 Task 패널(`TaskHub: <액션 ID>`)에 결과를 붙여넣습니다.

-   **`isOneShot`** (`boolean`, *선택*, 기본값: `false`): **스트림 모드에서만 의미가 있습니다.**
    -   `true`로 설정하면, `notepad.exe` 같은 GUI 프로그램처럼 종료되지 않는 프로세스를 실행하고 즉시 '성공'으로 처리합니다.

#### `unzip` 태스크

이 태스크는 지정된 `.zip` 또는 `.7z` 아카이브 파일의 압축을 해제합니다.

-   `type` (string, **필수**): `unzip`으로 설정해야 합니다.
-   `tool` (string | object, **필수**): 압축 해제에 사용할 도구(예: 7-Zip)의 경로를 지정합니다.
-   `inputs.archive` (string, *선택*): 이전 태스크 ID를 지정하여 아카이브 경로를 전달합니다. (예: `{"archive": "select_zip_file"}`)
-   `inputs.file` (string, *선택*): `inputs.archive`의 레거시 별칭입니다.
-   `inputs.destination` (string, *선택*): 이전 태스크 ID를 지정하여 압축 해제 대상 폴더를 전달합니다. (예: `{"destination": "select_destination_folder"}`)
-   `archive` (string, *선택*): 직접 경로를 지정합니다. `${...}` 치환을 활용할 수 있습니다.
-   `destination` (string, *선택*): 직접 대상 폴더 경로를 지정합니다. `${...}` 치환을 활용할 수 있습니다.
-   **실행 결과**: 다음 태스크에서 `${unzip_task.outputDir}`을 사용해 해제된 폴더 경로를 참조할 수 있습니다.

아카이브 경로는 `inputs.archive` → `inputs.file` → `archive` 순으로 해석됩니다. 대상 폴더는 `destination` → `inputs.destination` → (지정된 아카이브의 상위 폴더) 순으로 결정됩니다.

#### `zip` 태스크

이 태스크는 지정된 파일이나 폴더를 압축하여 하나의 아카이브 파일을 생성합니다.

-   `type` (string, **필수**): `zip`으로 설정해야 합니다.
-   `tool` (string | object, **필수**): 압축에 사용할 도구(예: 7-Zip)의 경로를 지정합니다.
-   `source` (string | string[], **필수**): 압축할 파일 또는 폴더의 경로입니다. 단일 경로는 문자열로, 여러 경로는 배열로 지정할 수 있습니다.
-   `archive` (string, **필수**): 생성될 압축 파일의 경로와 이름입니다.
-   **실행 결과**: 생성된 압축 파일 경로는 `${zip_task.archivePath}`로 다음 태스크에서 참조할 수 있습니다.

**예시:**
```json
{
  "id": "action.zip.files",
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
        "archive": "${workspaceFolder}/project-archive.zip"
      }
    ]
  }
}
```

#### `stringManipulation` 태스크

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

#### 변수 치환

파이프라인 내에서, 이전 태스크의 결과는 `${task_id.property}` 형식으로 다음 태스크의 속성(예: `command`, `args`, `filePath` 등)에서 사용할 수 있습니다.

-   `fileDialog` 태스크 (`id: "select_file"`)의 결과 사용 예시:
    -   `${select_file.path}`: 전체 경로
    -   `${select_file.dir}`: 디렉토리 경로
    -   `${select_file.name}`: 파일명
    -   `${select_file.fileNameOnly}`: 확장자를 제외한 파일명
    -   `${select_file.fileExt}`: 확장자
-   `${zip_task.archivePath}`: `zip` 태스크가 생성한 아카이브 경로
-   `${unzip_task.outputDir}`: `unzip` 태스크가 추출한 폴더 경로

#### 전체 예시

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



### 6. 즐겨찾기 패널 (`mainView.favorite`)

이 패널은 `.vscode/favorites.json`에 정의된 사용자가 즐겨찾는 파일 목록을 표시합니다. 필요하다면 파일을 열 때 이동할 줄 번호까지 함께 저장할 수 있으며, 뷰의 제목에는 즐겨찾기된 항목의 총 개수가 표시됩니다 (예: "Favorite Files (12)").

**주요 기능:**
*   **즐겨찾기 추가**: 뷰의 제목 표시줄에 있는 '+' 아이콘을 클릭하여 기존 파일을 즐겨찾기에 추가할 수 있습니다. 선택한 각 파일에 대해 제목, 그룹, 태그, 이동할 줄 번호를 입력할 수 있습니다.
*   **열려 있는 파일 추가**: 열려 있는 편집기에서 마우스 오른쪽 버튼을 클릭하여 컨텍스트 메뉴에서 "열려 있는 파일 즐겨찾기에 추가"를 선택할 수 있습니다. 기본값으로 현재 커서 위치의 줄 번호가 제안됩니다.
*   **클릭하여 열기**: 즐겨찾기 항목을 클릭하면 해당 파일이 VS Code에서 열립니다. 줄 정보가 있으면 해당 줄로 자동으로 이동합니다.
*   **인라인 액션**: 각 즐겨찾기 항목에 마우스를 올리면 휴지통 아이콘이 표시되며, 클릭하여 즐겨찾기를 삭제할 수 있습니다.
*   **검색**: 돋보기 아이콘을 클릭하여 즐겨찾기를 빠르게 검색할 수 있습니다.
*   **파일 편집**: 연필 버튼을 클릭하여 `favorites.json` 파일을 직접 편집할 수 있습니다.

### 7. 확장 프로그램 버전 표시

`mainView.main` 패널은 확장 프로그램의 현재 버전을 상단에 표시합니다. 이 버전 정보를 마우스 오른쪽 버튼으로 클릭하면 `actions.json`, `links.json`, `favorites.json`의 예제 JSON 파일을 빠르게 열어볼 수 있는 메뉴가 표시됩니다.

### 8. 액션 생성 마법사

`mainView.main` 패널의 제목 표시줄에 있는 '+' 아이콘을 클릭하면 대화형 액션 생성 마법사가 시작됩니다. 이 마법사를 통해 코드를 직접 작성하지 않고도 새로운 액션을 쉽게 생성할 수 있습니다.

*   **템플릿 선택**: 두 가지 템플릿 중 선택할 수 있습니다:
    *   **Single Shell Command**: 단일 셸 명령어를 실행하는 간단한 액션을 생성합니다.
    *   **File Picker + Shell**: 파일 선택 대화상자를 먼저 표시한 후, 선택된 파일 경로를 사용하는 셸 명령어를 실행하는 액션을 생성합니다.
*   **자동 저장**: 생성된 액션은 워크스페이스의 `.vscode/actions.json` 파일에 자동으로 추가되며, 메인 패널에 즉시 표시됩니다.
*   **즉시 실행**: 액션 생성 후 바로 실행할 수 있는 옵션이 제공됩니다.

### 9. 검색 기능

링크와 즐겨찾기 패널에는 빠른 검색 기능이 내장되어 있습니다.

*   **링크 검색**: `mainView.linkWorkspace` 패널의 제목 표시줄에 있는 돋보기 아이콘(🔍)을 클릭하면 워크스페이스 링크를 검색할 수 있는 Quick Pick이 표시됩니다. 링크 제목과 URL을 기준으로 검색할 수 있으며, 선택하면 해당 링크가 브라우저에서 열립니다.
*   **즐겨찾기 검색**: `mainView.favorite` 패널의 제목 표시줄에 있는 돋보기 아이콘을 클릭하면 즐겨찾기 파일을 검색할 수 있습니다. 파일 제목과 경로를 기준으로 검색할 수 있으며, 선택하면 해당 파일이 에디터에서 열립니다.

### 10. 그룹화 기능

링크와 즐겨찾기는 그룹으로 정리할 수 있어 관련 항목을 체계적으로 관리할 수 있습니다.

*   **링크 그룹**: `links.json` 파일에서 `group` 속성을 사용하여 링크를 그룹화할 수 있습니다. 같은 그룹 이름을 가진 링크들은 접을 수 있는 트리 노드로 묶여서 표시됩니다.
*   **즐겨찾기 그룹**: `favorites.json` 파일에서 `group` 속성을 사용하여 즐겨찾기를 그룹화할 수 있습니다. 그룹은 계층적으로 표시되어 많은 파일을 효율적으로 관리할 수 있습니다.
*   **개수 표시**: 각 패널의 제목에는 전체 항목 개수가 표시됩니다 (예: "Workspace Links (5)", "Favorite Files (12)").

### 11. 작업 종료

실행 중인 액션은 개별적으로 또는 모두 한 번에 종료할 수 있습니다.

*   **개별 액션 종료**: 실행 중인 액션 항목을 마우스 오른쪽 버튼으로 클릭하거나 인라인 아이콘(사각형)을 클릭하여 해당 액션만 종료할 수 있습니다.
*   **모든 액션 종료**: `mainView.main` 패널의 제목 표시줄에 있는 사각형 아이콘을 클릭하면 `taskhub.terminateAllActions` 명령이 실행되어 확장 프로그램에 의해 시작된 모든 작업 터미널을 한 번에 닫을 수 있습니다. 이 기능은 현재 실행 중인 작업뿐만 아니라, 실행이 완료되어 대기 중인 터미널까지 모두 종료시킵니다.

### 12. Multi-root 워크스페이스 지원

이 확장 프로그램은 VS Code의 multi-root 워크스페이스를 완벽하게 지원합니다.

*   **워크스페이스별 설정**: 각 워크스페이스 폴더는 자체 `.vscode/actions.json`, `.vscode/links.json`, `.vscode/favorites.json` 파일을 가질 수 있습니다.
*   **자동 폴더 선택**: 여러 워크스페이스 폴더가 있는 경우, 파일을 추가하거나 편집할 때 대상 폴더를 선택하는 프롬프트가 표시됩니다.
*   **변수 치환**: `${workspaceFolder}` 변수는 각 워크스페이스 폴더에 맞게 올바르게 해석됩니다.

### 13. 쉬운 설정 관리

*   **설정 파일 편집**: 각 뷰(메인, 링크, 즐겨찾기)의 제목 표시줄에 있는 연필 아이콘(✏️)을 클릭하여 `.vscode` 폴더에 있는 `actions.json`, `links.json`, `favorites.json` 파일을 쉽게 열고 편집할 수 있습니다. 파일이 없으면 새로 생성됩니다.
*   **예제 JSON 보기**: 메인 패널에 표시되는 버전 정보 항목의 컨텍스트 메뉴(마우스 오른쪽 클릭)를 통해 각 설정 파일의 예제 JSON 내용을 확인할 수 있습니다.
*   **확장 프로그램 설정 열기**: 명령 팔레트(Cmd/Ctrl+Shift+P)에서 `TaskHub: Open Extension Settings`를 실행하여 확장 프로그램과 관련된 모든 설정을 VS Code 설정 화면에서 쉽게 확인하고 수정할 수 있습니다.

## 설정

| 설정 ID | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `taskhub.showTaskStatus` | `boolean` | `true` | 메인 뷰의 액션에 대한 상태 아이콘(실행 중, 성공, 실패) 및 작업 완료 후 표시되는 팝업 알림을 활성화/비활성화합니다. |
| `taskhub.pipeline.showVerboseLogs` | `boolean` | `false` | 파이프라인 실행 시 Output 패널에 상세 로그를 표시합니다. 기본적으로는 최소한의 상태 메시지만 표시됩니다. |
| `taskhub.pipeline.pythonIoEncoding` | `string` | `utf-8` | TaskHub에서 실행하는 명령어의 `PYTHONIOENCODING` 환경 변수 값입니다. 빈 문자열로 설정하면 인코딩을 강제하지 않으며, `utf-8:ignore`와 같은 값을 지정할 수도 있습니다. |
| `taskhub.pipeline.windowsPowerShellEncoding` | `string` | `utf8` | Windows에서 PowerShell 출력 인코딩을 제어합니다. `utf8`은 UTF-8(코드 페이지 65001)을 사용하고, `system`은 현재 콘솔 코드 페이지를 유지합니다. UTF-8을 인식하지 못하는 레거시 도구에는 `system`을 사용하세요. |

## 설치

1.  이 저장소를 클론합니다.
2.  VS Code에서 프로젝트를 엽니다.
3.  터미널에서 `npm install`을 실행합니다.
4.  `F5` 키를 눌러 새 확장 개발 호스트 창에서 확장 프로그램을 실행합니다.

## 사용법

1.  활동 표시줄의 'H' 아이콘을 클릭하여 TaskHub 뷰를 엽니다.
2.  '메인 패널'에서 다양한 액션을 탐색하고 '링크 패널'에서 리소스에 빠르게 접근합니다.
3.  `media/actions.json`, `media/links.json`, 그리고 `.vscode/favorites.json` 파일을 수정하여 버튼, 링크 및 즐겨찾는 파일을 사용자 지정합니다.

## 개발

*   `npm run compile`: TypeScript 소스 코드를 컴파일합니다.
*   `npm run watch`: watch 모드로 코드를 컴파일합니다.
*   `npm run test`: 확장 프로그램 테스트를 실행합니다.

---

**참고**: 이 README는 현재까지 구현된 기능을 기반으로 생성되었습니다. 최신 정보는 소스 코드를 참조하십시오.
