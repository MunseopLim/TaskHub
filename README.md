# 펌웨어 툴킷 VS Code 확장 프로그램

이 VS Code 확장 프로그램은 사용자 지정 활동 표시줄 뷰를 통해 펌웨어 개발을 위한 유틸리티 기능을 제공합니다.

## 목차

1.  [기능](#기능)
    1.  [사용자 지정 메인 뷰](#1-사용자-지정-메인-뷰)
    2.  [사용자 지정 아이콘](#2-사용자-지정-아이콘)
    3.  [JSON 설정 파일](#3-json-설정-파일)
    4.  [링크 패널 (`mainView.link`)](#4-링크-패널-mainviewlink)
    5.  [메인 패널 (`mainView.main`)](#5-메인-패널-mainviewmain)
    6.  [즐겨찾기 패널 (`mainView.favorite`)](#6-즐겨찾기-패널-mainviewfavorite)
    7.  [확장 프로그램 버전 표시](#7-확장-프로그램-버전-표시)
    8.  [모든 작업 종료](#8-모든-작업-종료)
    9.  [쉬운 설정 관리](#9-쉬운-설정-관리)
2.  [설정](#설정)
3.  [설치](#설치)
4.  [사용법](#사용법)
5.  [개발](#개발)

## 기능

### 1. 사용자 지정 메인 뷰

이 확장 프로그램은 VS Code 활동 표시줄에 'H' 아이콘으로 식별되는 사용자 지정 뷰 컨테이너를 도입합니다. 이 메인 뷰(`mainView`)는 세 개의 하위 뷰를 호스팅합니다:

*   **메인 패널 (`mainView.main`)**: 다양한 액션 버튼과 정보를 포함하며, 'M' 아이콘으로 식별됩니다.
*   **링크 패널 (`mainView.link`)**: 구성 가능한 링크 목록을 표시하며, 'L' 아이콘으로 식별됩니다.
*   **즐겨찾기 패널 (`mainView.favorite`)**: 구성 가능한 즐겨찾는 파일 목록을 표시하며, 'F' 아이콘으로 식별됩니다.

### 2. 사용자 지정 아이콘

활동 표시줄의 메인 뷰는 사용자 지정 'H' 모양의 SVG 아이콘(`media/h_icon.svg`)을 사용합니다.

### 3. JSON 설정 파일

이 확장 프로그램은 `actions.json`, `links.json`, 그리고 `favorites.json` 파일을 사용하여 뷰의 내용을 구성합니다.

*   **파일 로드 우선순위**:
    *   각 뷰는 먼저 확장 프로그램의 `media/` 디렉토리에 있는 기본 JSON 파일을 로드합니다.
    *   만약 작업 공간의 `.vscode/` 디렉토리에 동일한 이름의 JSON 파일이 존재한다면, 해당 파일의 내용이 `media/` 파일의 내용 뒤에 **추가됩니다**.
    *   이러한 파일(`media/` 및 `.vscode/` 내의 JSON 파일)이 수정, 생성 또는 삭제되면 해당 뷰는 자동으로 새로 고쳐집니다.

### 4. 링크 패널 (`mainView.link`)

이 패널은 `media/links.json` (그리고 `.vscode/links.json`이 있다면 추가된 내용)에 정의된 링크 목록을 표시합니다. 뷰의 제목에는 링크의 총 개수가 표시됩니다.

*   **구성 가능한 링크**: 링크는 `media/links.json`에서 로드됩니다. 각 항목은 `title`과 `link` URL을 가집니다.
    ```json
    [
      {
        "title": "Google",
        "link": "https://www.google.com"
      },
      {
        "title": "VS Code 문서",
        "link": "https://code.visualstudio.com/docs"
      }
    ]
    ```
*   **링크 아이콘**: 각 링크 항목 앞에는 표준 링크 아이콘이 붙습니다.
*   **클릭하여 열기**: 링크 항목을 클릭하면 기본 웹 브라우저에서 해당 URL이 열립니다.
*   **컨텍스트 메뉴**: 링크 항목을 마우스 오른쪽 버튼으로 클릭하면 세 가지 옵션이 제공됩니다:
    *   `링크 복사`: URL을 클립보드에 복사합니다.
    *   `링크로 이동`: 기본 웹 브라우저에서 URL을 엽니다 (클릭과 동일).
    *   `링크 삭제`: 목록에서 링크를 제거합니다.

### 5. 메인 패널 (`mainView.main`)

이 패널은 `media/actions.json` (그리고 `.vscode/actions.json`이 있다면 추가된 내용)에 정의된 다양한 구성 가능한 액션을 제공합니다.

*   **액션 상태 표시 및 제어**:
    *   **상태 아이콘**: 액션 버튼은 실행 상태에 따라 아이콘이 변경됩니다.
        *   **실행 중**: 액션이 실행 중일 때, 아이콘은 회전하는 동기화 아이콘 (`$(sync~spin)`)으로 표시됩니다.
        *   **성공**: 액션이 성공적으로 완료되면, 파란색 체크 아이콘 (`$(check)`)이 표시됩니다.
        *   **실패**: 액션이 실패하면, 붉은색 에러 아이콘 (`$(error)`)이 표시됩니다.
    *   **액션 중지**: 실행 중인 액션은 마우스 오른쪽 버튼으로 클릭하여 나타나는 컨텍스트 메뉴에서 "Stop Action"을 선택하여 중지할 수 있습니다.
    *   **재실행**: 완료된 (성공 또는 실패) 액션을 다시 클릭하면 재실행됩니다.
    *   이 기능은 [설정](#설정)에서 `firmware-toolkit.showTaskStatus` 옵션을 통해 활성화/비활성화할 수 있습니다.

*   **구성 가능한 버튼**: `media/actions.json`에 있는 `id`가 `button.`으로 시작하는 모든 항목은 클릭 가능한 버튼으로 렌더링됩니다.
    ```json
    [
      {
        "id": "button.build",
        "title": "빌드",
        "action": {
          "type": "shell",
          "command": "echo '빌드 중...'",
          "cwd": "${workspaceFolder}",
          "revealTerminal": "always",
          "successMessage": "빌드 완료!",
          "failMessage": "빌드 실패. 터미널을 확인하세요."
        }
      }
    ]
    ```

*   **폴더 구성**: 액션 버튼들을 폴더로 그룹화하여 정리할 수 있습니다. 폴더는 중첩될 수 있으며, 각 폴더의 열림/닫힘 상태는 작업 공간별로 유지됩니다. `actions.json` 파일에 `type: "folder"` 항목을 추가하여 폴더를 정의할 수 있습니다.

    **예시:**
    ```json
    [
      {
        "type": "folder",
        "title": "빌드 작업",
        "id": "folder.build",
        "children": [
          {
            "id": "button.build.os",
            "title": "운영체제별 빌드",
            "action": {
              "type": "shell",
              "command": {
                "windows": "echo 'Windows에서 빌드 중...'",
                "macos": "echo 'macOS에서 빌드 중...'",
                "linux": "echo 'Linux에서 빌드 중...'"
              }
            }
          },
          {
            "id": "button.build",
            "title": "프로젝트 빌드",
            "action": {
              "type": "shell",
              "command": "npm run build"
            }
          }
        ]
      }
    ]
    ```

    *   `type`: `"folder"`로 설정해야 합니다.
    *   `title`: 폴더의 이름입니다.
    *   `id`: 폴더의 상태를 기억하기 위한 고유 ID입니다. 이 ID를 설정하지 않으면 폴더의 열림/닫힘 상태가 유지되지 않을 수 있습니다.
    *   `children`: 폴더에 포함될 액션 버튼 또는 다른 폴더들의 배열입니다.
*   **구분선**: `type: "separator"`인 항목은 시각적 구분선으로 렌더링됩니다.
*   **구성 가능한 터미널 동작 (`revealTerminal`)**: `shell` 타입 액션의 경우 터미널의 가시성을 제어할 수 있습니다.
*   **성공/실패 알림 (`successMessage`, `failMessage`)**: `shell` 타입 액션의 경우 작업 완료 시 VS Code 알림으로 표시될 메시지를 정의할 수 있습니다.
*   **OS별 명령 (`command` 객체)**: `command` 속성은 단일 문자열 대신 객체를 사용하여 운영 체제(OS)별로 다른 명령을 지정할 수 있습니다.

*   **1회성 실행 작업 (`isOneShot`)**: `shell` 타입의 액션에 `isOneShot: true` 속성을 추가할 수 있습니다. 이 속성이 설정된 작업은 'fire-and-forget' 방식으로 동작합니다. 즉, 명령이 시작된 직후 작업 상태가 '성공'으로 표시되며, 실제 프로세스의 종료 여부를 기다리지 않습니다. 이는 별도의 창을 띄우는 GUI 프로그램을 실행하는 등, 시작 후 즉시 제어권을 반환하는 명령에 유용합니다.

    **예시:**
    ```json
    {
      "id": "button.run.mytool",
      "title": "Run My Tool",
      "action": {
        "type": "shell",
        "command": "C:\\path\\to\\my_tool.exe",
        "isOneShot": true
      }
    }
    ```
*   **파일 선택기**: 지정된 폴더에서 파일을 선택하거나, 파일 시스템을 탐색하거나, 파일 이름을 직접 입력하여 파일을 선택하고 실행할 수 있는 특수 액션 타입(`filePicker`)입니다.

*   **파이프라인 액션**: 여러 단계를 순차적으로 실행하는 복잡한 작업을 정의할 수 있는 `pipeline` 타입의 액션입니다. 각 단계의 출력은 다음 단계의 입력으로 사용될 수 있습니다.

    **예시:**
    ```json
    {
      "id": "button.analyzePackage",
      "title": "Analyze Firmware Package",
      "action": {
        "type": "pipeline",
        "steps": [
          {
            "id": "selectFile",
            "type": "fileDialog",
            "options": {
              "canSelectMany": false,
              "openLabel": "Select Package (.7z, .zip)",
              "filters": {
                "Archives": ["7z", "zip"]
              }
            }
          },
          {
            "id": "unzip",
            "type": "unzip",
            "tool": {
              "macos": "7za",
              "windows": "7z.exe",
              "linux": "7za"
            },
            "inputs": {
              "file": "selectFile"
            }
          },
          {
            "id": "getFileName",
            "type": "command",
            "command": "bash",
            "args": [
              "-c",
              "echo \"${selectFile.name}\" | sed -e 's/\.7z$//' -e 's/\.zip$//'"
            ],
            "inputs": {
              "selectFile": "selectFile"
            },
            "output": {
              "variable": "fileNameWithoutExtension"
            }
          },
          {
            "id": "runScript",
            "type": "command",
            "command": "bash",
            "args": [
              "-c",
              "echo \"Parameter to script.py: ${unzip.outputDir}/${getFileName.fileNameWithoutExtension}\" && python3 \"/Users/munseop/code/test/script.py\" \"${unzip.outputDir}/${getFileName.fileNameWithoutExtension}\""
            ],
            "inputs": {
              "unzip": "unzip",
              "getFileName": "getFileName"
            },
            "output": {
              "showInEditor": true,
              "title": "Analysis Result"
            }
          }
        ],
        "successMessage": "Package analysis completed successfully!",
        "failMessage": "Package analysis failed."
      }
    }
    ```

    *   `type`: `"pipeline"`으로 설정해야 합니다.
    *   `steps`: 파이프라인을 구성하는 단계들의 배열입니다.
    *   **사용 가능한 단계 유형**:
        *   `fileDialog`: 파일 선택 대화상자를 엽니다.
        *   `folderDialog`: 폴더 선택 대화상자를 엽니다.
        *   `unzip`: 선택된 압축 파일을 해제합니다.
        *   `command`: 셸 명령을 실행합니다.
    *   **데이터 전달**: 이전 단계의 결과는 `${stepId.property}` 형식을 사용하여 후속 단계에서 참조할 수 있습니다. 예를 들어, `unzip` 단계의 출력 디렉터리는 `${unzip.outputDir}`로 참조할 수 있습니다.

    **폴더 선택 예시:**
    ```json
    {
      "id": "button.listFolderContents",
      "title": "List Folder Contents",
      "action": {
        "type": "pipeline",
        "steps": [
          {
            "id": "selectFolder",
            "type": "folderDialog",
            "options": {
              "openLabel": "Select a folder to list its contents"
            }
          },
          {
            "id": "listContents",
            "type": "command",
            "command": {
              "macos": "ls",
              "linux": "ls",
              "windows": "dir"
            },
            "args": {
              "macos": ["-la", "${selectFolder.path}"],
              "linux": ["-la", "${selectFolder.path}"],
              "windows": ["${selectFolder.path}"]
            },
            "output": {
              "showInEditor": true,
              "title": "Folder Contents"
            }
          }
        ],
        "successMessage": "Folder contents listed successfully!",
        "failMessage": "Failed to list folder contents."
      }
    }
    ```

*   **OS별 명령어 및 인수**: `command` 단계에서 `command`와 `args` 속성을 객체로 지정하여 운영 체제(OS)별로 다른 명령과 인수를 사용할 수 있습니다.

    **예시:**
    ```json
    {
      "id": "runScript",
      "type": "command",
      "command": {
        "macos": "bash",
        "linux": "bash",
        "windows": "powershell"
      },
      "args": {
        "macos": [
          "-c",
          "echo \"Parameter to script.py: ${selectFolder.path}\" && python3 \"/path/to/script.py\" \"${selectFolder.path}\""
        ],
        "linux": [
          "-c",
          "echo \"Parameter to script.py: ${selectFolder.path}\" && python3 \"/path/to/script.py\" \"${selectFolder.path}\""
        ],
        "windows": [
          "-Command",
          "Write-Host \"Parameter to script.py: ${selectFolder.path}\”; python3 \"/path/to/script.py\" \"${selectFolder.path}\""
        ]
      },
      "output": {
        "showInEditor": true,
        "title": "Analysis Result"
      }
    }
    ```

### 6. 즐겨찾기 패널 (`mainView.favorite`)

이 패널은 `.vscode/favorites.json`에 정의된 사용자가 즐겨찾는 파일 목록을 표시합니다. 뷰의 제목은 "Favorite Files"이며, 즐겨찾기된 파일의 총 개수가 표시됩니다.

*   **즐겨찾기 추가**: 뷰의 제목 표시줄에 있는 "+" 아이콘을 클릭하여 기존 파일을 즐겨찾기에 추가할 수 있습니다.
*   **열려 있는 파일 즐겨찾기에 추가**: 열려 있는 편집기에서 마우스 오른쪽 버튼을 클릭하여 컨텍스트 메뉴에서 "열려 있는 파일 즐겨찾기에 추가" 옵션을 선택하여 현재 파일을 즐겨찾기에 추가할 수 있습니다.
*   **클릭하여 열기**: 즐겨찾기 항목을 클릭하면 해당 파일이 VS Code에서 열립니다.
*   **컨텍스트 메뉴**: 즐겨찾기 항목을 마우스 오른쪽 버튼으로 클릭하면 `즐겨찾기 삭제` 옵션이 제공되어 목록에서 항목을 제거할 수 있습니다.

### 7. 확장 프로그램 버전 표시

`mainView.main` 패널은 확장 프로그램의 현재 버전을 클릭할 수 없는 레이블로 상단에 표시합니다.

### 8. 모든 작업 종료

이 확장 프로그램은 `firmware-toolkit.terminateAllTasks` 명령을 제공하여 확장 프로그램에 의해 시작된 모든 활성 작업 및 관련 터미널을 종료할 수 있습니다. 이 명령은 `mainView.main` 패널의 제목 표시줄에 있는 정지 아이콘(`$(primitive-square)`)을 통해 접근할 수 있습니다. 또한, 모든 액션 버튼의 아이콘을 기본 상태로 초기화합니다.

### 9. 쉬운 설정 관리

*   **설정 파일 편집**: 각 뷰(메인, 링크, 즐겨찾기)의 제목 표시줄에 있는 연필 아이콘(✏️)을 클릭하여 `.vscode` 폴더에 있는 `actions.json`, `links.json`, `favorites.json` 파일을 쉽게 열고 편집할 수 있습니다. 파일이 없으면 새로 생성됩니다.
*   **예제 JSON 보기**: 메인 패널에 표시되는 버전 정보 항목의 컨텍스트 메뉴(마우스 오른쪽 클릭)를 통해 각 설정 파일의 예제 JSON 내용을 확인할 수 있습니다.

## 설정

| 설정 ID | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `firmware-toolkit.showTaskStatus` | `boolean` | `true` | 메인 뷰의 액션에 대한 상태 표시(실행 중, 성공, 실패)를 활성화/비활성화합니다. |

## 설치

1.  이 저장소를 클론합니다.
2.  VS Code에서 프로젝트를 엽니다.
3.  터미널에서 `npm install`을 실행합니다.
4.  `F5` 키를 눌러 새 확장 개발 호스트 창에서 확장 프로그램을 실행합니다.

## 사용법

1.  활동 표시줄의 'H' 아이콘을 클릭하여 펌웨어 툴킷 뷰를 엽니다.
2.  '메인 패널'에서 다양한 액션을 탐색하고 '링크 패널'에서 리소스에 빠르게 접근합니다.
3.  `media/actions.json`, `media/links.json`, 그리고 `.vscode/favorites.json` 파일을 수정하여 버튼, 링크 및 즐겨찾는 파일을 사용자 지정합니다.

## 개발

*   `npm run compile`: TypeScript 소스 코드를 컴파일합니다.
*   `npm run watch`: watch 모드로 코드를 컴파일합니다.
*   `npm run test`: 확장 프로그램 테스트를 실행합니다.

---

**참고**: 이 README는 현재까지 구현된 기능을 기반으로 생성되었습니다. 최신 정보는 소스 코드를 참조하십시오.��