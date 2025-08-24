# 펌웨어 툴킷 VS Code 확장 프로그램

이 VS Code 확장 프로그램은 사용자 지정 활동 표시줄 뷰를 통해 펌웨어 개발을 위한 유틸리티 기능을 제공합니다.

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

이 패널은 `media/links.json` (그리고 `.vscode/links.json`이 있다면 추가된 내용)에 정의된 링크 목록을 표시합니다.

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
      },
      {
        "id": "button.openExplorer",
        "title": "프로젝트 디렉토리 열기",
        "action": {
          "type": "shell",
          "command": "open .",
          "cwd": "${workspaceFolder}",
          "revealTerminal": "silent",
          "successMessage": "프로젝트 디렉토리가 열렸습니다."
        }
      }
    ]
    ```
*   **구분선**: `type: "separator"`인 항목은 시각적 구분선으로 렌더링됩니다.
    ```json
    {
      "id": "separator.1",
      "type": "separator",
      "title": "------------"
    }
    ```
*   **구성 가능한 터미널 동작 (`revealTerminal`)**: `shell` 타입 액션의 경우 터미널의 가시성을 제어할 수 있습니다:
    *   `"always"`: 터미널이 항상 전면으로 표시됩니다.
    *   `"silent"`: 터미널이 표시되지 않고 백그라운드에서 실행됩니다.
    *   `"never"`: 터미널이 표시되지 않고 백그라운드에서 실행됩니다.
    지정하지 않으면 기본값은 `silent`입니다.
*   **성공/실패 알림 (`successMessage`, `failMessage`)**: `shell` 타입 액션의 경우 작업 완료 시 VS Code 알림으로 표시될 메시지를 정의할 수 있습니다:
    *   `"successMessage"`: 작업이 종료 코드 0으로 완료되면 표시됩니다.
    *   `"failMessage"`: 작업이 0이 아닌 종료 코드로 완료되면 표시됩니다.
    이 속성들은 선택 사항입니다. 생략하면 해당 결과에 대한 알림이 표시되지 않습니다.
*   **OS별 명령 (`command` 객체)**: `command` 속성은 단일 문자열 대신 객체를 사용하여 운영 체제(OS)별로 다른 명령을 지정할 수 있습니다. 이는 크로스 플랫폼 프로젝트에서 유용합니다.
    ```json
    {
      "type": "shell",
      "command": {
        "windows": "npm run build:windows",
        "macos": "npm run build:macos",
        "linux": "npm run build:linux"
      },
      "cwd": "${workspaceFolder}"
    }
    ```
    *   `windows`: Windows 운영 체제에서 실행될 명령입니다. PowerShell 또는 CMD에 따라 추가적으로 세분화할 수 있습니다.
        ```json
        "windows": {
          "powershell": "powershell -File build.ps1",
          "cmd": "build.bat"
        }
        ```
    *   `macos`: macOS 운영 체제에서 실행될 명령입니다.
    *   `linux`: Linux 운영 체제에서 실행될 명령입니다.
    현재 OS에 해당하는 명령이 없으면 오류 메시지가 표시됩니다.
*   **실행 파일 선택기**: 지정된 폴더에서 실행 파일을 선택하거나 파일 시스템을 탐색하여 실행 파일을 실행할 수 있는 특수 액션 타입(`executablePicker`)입니다.
    ```json
    {
      "id": "button.selectExecutable",
      "title": "실행 파일 선택",
      "action": {
        "type": "executablePicker",
        "folder": "${workspaceFolder}/bin",
        "runCommand": "bash ${file}"
      }
    }
    ```
    *   `folder`: (선택 사항) 실행 파일을 스캔할 디렉토리입니다. `${workspaceFolder}`를 지원합니다.
    *   `runCommand`: 선택된 파일을 실행할 명령 템플릿입니다. `${file}`은 선택된 실행 파일의 전체 경로로 대체됩니다.
    *   **동작**: 버튼을 클릭하면 빠른 선택 목록이 나타납니다. 이 목록에는 `folder`에 있는 모든 파일과 "찾아보기..." 옵션이 포함됩니다.
        *   목록에서 파일을 선택하면 해당 파일로 `runCommand`가 실행됩니다.
        *   "찾아보기..."를 선택하면 파일 대화 상자가 열리고 모든 파일을 선택하여 실행할 수 있습니다.
    *   **Windows용 `runCommand` 참고**: Windows의 경우, `bash ${file}`은 셸에 따라 조정해야 할 수 있습니다 (예: 배치 파일의 경우 `cmd.exe /c ""${file}""`, PowerShell 스크립트의 경우 `powershell.exe -File ""${file}""`, `.exe` 파일의 경우 단순히 `""${file}""`).

### 6. 즐겨찾기 패널 (`mainView.favorite`)

이 패널은 `.vscode/favorites.json`에 정의된 사용자가 즐겨찾는 파일 목록을 표시합니다.

*   **즐겨찾기 추가**: 뷰의 제목 표시줄에 있는 "+" 아이콘을 클릭하여 기존 파일을 즐겨찾기에 추가할 수 있습니다. 여러 파일을 한 번에 선택할 수 있습니다.
*   **열려 있는 파일 즐겨찾기에 추가**: 열려 있는 편집기에서 마우스 오른쪽 버튼을 클릭하여 컨텍스트 메뉴에서 "열려 있는 파일 즐겨찾기에 추가" 옵션을 선택하여 현재 파일을 즐겨찾기에 추가할 수 있습니다.
*   **구성 가능한 즐겨찾기**: 즐겨찾기 파일은 `.vscode/favorites.json`에서 로드됩니다. 각 항목은 `title` (표시 이름)과 `path` (파일 경로)를 가집니다.
    ```json
    // .vscode/favorites.json 예시
    [
      {
        "title": "내 즐겨찾는 스크립트",
        "path": "/Users/user/project/scripts/my_script.sh"
      },
      {
        "title": "중요 문서",
        "path": "/Users/user/project/docs/important.md"
      }
    ]
    ```
    *   `path` 속성은 절대 경로를 저장합니다.
*   **파일 아이콘**: 각 즐겨찾기 항목 앞에는 일반 파일 아이콘이 붙습니다.
*   **클릭하여 열기**: 즐겨찾기 항목을 클릭하면 해당 파일이 VS Code에서 열립니다.
*   **컨텍스트 메뉴**: 즐겨찾기 항목을 마우스 오른쪽 버튼으로 클릭하면 `즐겨찾기 삭제` 옵션이 제공되어 목록에서 항목을 제거할 수 있습니다.

### 7. 확장 프로그램 버전 표시

`mainView.main` 패널은 확장 프로그램의 현재 버전을 클릭할 수 없는 레이블로 상단에 표시합니다.

### 8. 확장 프로그램 버전 표시 명령

명령 팔레트(Ctrl+Shift+P 또는 Cmd+Shift+P)에서 `firmware-toolkit.showVersion` 명령을 사용하여 정보 메시지로 확장 프로그램 버전을 표시할 수 있습니다.

### 9. 모든 작업 종료

이 확장 프로그램은 `firmware-toolkit.terminateAllTasks` 명령을 제공하여 확장 프로그램에 의해 시작된 모든 활성 작업 및 관련 터미널을 종료할 수 있습니다. 이 명령은 `mainView.main` 패널의 제목 표시줄에 있는 정지 아이콘(`$(primitive-square)`)을 통해 접근할 수 있습니다.

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

**참고**: 이 README는 현재까지 구현된 기능을 기반으로 생성되었습니다. 최신 정보는 소스 코드를 참조하십시오.