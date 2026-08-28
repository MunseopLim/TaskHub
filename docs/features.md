# TaskHub 상세 기능 문서

이 문서는 TaskHub의 모든 기능에 대한 상세 설명을 제공합니다.
간략한 소개는 [README.md](../README.md)를 참조하세요.

## 목차

1.  [사용자 지정 메인 뷰](#1-사용자-지정-메인-뷰)
2.  [사용자 지정 아이콘](#2-사용자-지정-아이콘)
3.  [JSON 설정 파일](#3-json-설정-파일)
4.  [링크 패널 (Workspace Links)](#4-링크-패널-workspace-links)
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
21. [설정 레퍼런스](#21-설정-레퍼런스)
22. [Markdown / HTML 우클릭 열기](#22-markdown--html-우클릭-열기)
23. [TaskHub Doctor (Action Lint)](#23-taskhub-doctor-action-lint)
24. [병렬 실행 / Task DAG](#24-병렬-실행--task-dag)
25. [파일/폴더 다이얼로그 위치 기억](#25-파일폴더-다이얼로그-위치-기억)

---

## 1. 사용자 지정 메인 뷰

이 확장 프로그램은 VS Code 활동 표시줄에 'H' 아이콘으로 식별되는 사용자 지정 뷰 컨테이너를 도입합니다. 이 메인 뷰(`mainView`)는 네 개의 하위 뷰를 호스팅합니다:

*   **Actions 패널 (`mainView.main`)**: 다양한 액션 버튼과 정보를 포함하며, 'M' 아이콘으로 식별됩니다.
*   **워크스페이스 링크 패널 (`mainView.linkWorkspace`)**: 현재 워크스페이스에 정의된 링크를 표시하며, 'L' 아이콘으로 식별됩니다.
*   **즐겨찾기 패널 (`mainView.favorite`)**: 구성 가능한 즐겨찾는 파일 목록을 표시하며, 'F' 아이콘으로 식별됩니다.
*   **히스토리 패널 (`mainView.history`)**: 최근 실행한 액션들의 기록을 추적하고 관리하며, 'R' 아이콘으로 식별됩니다.

### Status Bar 기능 런처

VS Code 하단 Status Bar 왼쪽의 도구 아이콘과 **TaskHub** 텍스트를 누르면 자주 쓰는 기능을 한 목록에서
검색해 실행할 수 있습니다. Command Palette의 **TaskHub: 기능 선택…**도 같은 목록을 엽니다.

- 목록은 TaskHub 사이드바·설정, 액션 도구, 임베디드 도구, 미리 보기로 나뉘니다. 항목의 제목과
  설명을 모두 검색하므로 예를 들어 `hex`, `Memory`, `JSON`만 입력해도 대상을 줄일 수 있습니다.
- **Markdown 미리 보기**와 **HTML을 기본 브라우저에서 열기**는 파일 선택 창을 먼저 열어, 현재
  편집기 종류와 관계없이 원하는 파일을 고를 수 있습니다. 두 선택 창은 용도별로 직전에 사용한
  폴더를 기억합니다.
- 선택한 기능은 위쪽 **최근 사용**에 최대 3개까지 표시되며 VS Code를 다시 열어도 유지됩니다.
- Status Bar 항목은 워크스페이스 전체에 적용되는 단일 왼쪽 항목이며 별도 색상을 사용하지 않습니다.
  표시가 필요 없으면 Status Bar를 마우스 오른쪽 버튼으로 누르고 **TaskHub 기능**을 끕니다.

## 2. 사용자 지정 아이콘

활동 표시줄의 메인 뷰는 사용자 지정 'H' 모양의 SVG 아이콘(`media/h_icon.svg`)을 사용합니다.

## 3. JSON 설정 파일

이 확장 프로그램은 `actions.json`, `links.json`, 그리고 `favorites.json` 파일을 사용하여 뷰의 내용을 구성합니다.

*   **파일 로드 우선순위**:
    *   Actions 패널은 워크스페이스의 `.vscode/actions.json`, 선택한 프리셋, 확장에 번들된 예제(`media/actions.json`)를 병합하여 표시합니다. 자세한 규칙은 아래 [액션 소스와 병합 우선순위](#액션-소스와-병합-우선순위) 참조.
    *   링크 패널은 워크스페이스의 `.vscode/links.json`만 표시합니다.
    *   즐겨찾기 패널은 워크스페이스의 `.vscode/favorites.json`을 표시합니다.
    *   관련 JSON 파일이 수정, 생성 또는 삭제되면 해당 뷰는 자동으로 새로 고쳐집니다.

### 편집 지원 (스키마 + `${…}` 자동완성)

`actions.json`에는 JSON 스키마([schema/actions.schema.json](../schema/actions.schema.json))가 연결돼 있어 키·타입·허용값이 제안되고 잘못된 값에 밑줄이 그어집니다. `options` 안의 `canSelectMany` 같은 다이얼로그 옵션도 여기에 포함됩니다(0.6.57부터 — 그전에는 `options`가 빈 객체 타입이라 **아무것도 제안되지 않았습니다**).

**결과 참조(`${…}`)는 스키마가 다룰 수 없습니다.** 값 문자열 *안*에 있고, 무엇이 유효한지가 같은 액션의 다른 태스크 타입에 달려 있기 때문입니다. 그래서 0.6.57부터 전용 자동완성을 제공합니다 — `${`를 입력하면 **같은 액션의 다른 태스크 id**와 현재 파일·선택 영역 같은 내장 문맥 변수가, `${pick.`처럼 점을 찍으면 **그 태스크 타입이 실제로 내는 결과 키**가 제안됩니다 (`fileDialog`이면 `path` · `dir` · `paths` · `names` · `count` …). `${env:` 뒤에는 현재 환경변수 이름이 제안됩니다(값은 목록에 표시하지 않음).

- 결과 키 목록은 Preview Run · Doctor가 쓰는 시뮬레이션과 **같은 출처**입니다. 태스크에 결과 키가 늘면 세 곳이 함께 늘어납니다.
- `output.capture`로 이름을 정의했다면 그 이름도 함께 제안됩니다.
- **해석되지 않을 참조는 제안하지 않습니다.** `passTheResultToNextTask: true`가 없는 `shell`/`command`의 `${id.output}`이 그 예입니다 — 런타임이 출력을 캡처하지 않아 리터럴로 남는 자리이고, Doctor의 `output.not-captured`가 잡는 가장 흔한 설정 실수입니다.
- 자기 자신과 **다른 액션의 태스크**는 제안하지 않습니다(참조할 수 없습니다).
- `??` 체인 안에서는 **커서가 놓인 대안**만 봅니다 — `${pick.path ?? ask.`에서는 `ask`의 키가 제안되고, 항목을 골라도 앞의 `pick.path ?? `는 그대로 남습니다.
- 낱말 중간(`${ask.va|lue}`)에서는 삽입/대체 두 범위를 제공하므로 `editor.suggest.insertMode` 설정이 그대로 적용됩니다 — `replace`면 꼬리(`lue`)가 사라지고 `insert`면 남습니다. 대체 범위는 **고른 항목에 맞춰** 정해집니다: 후보가 커서 뒤 글자와 그대로 이어질 때만 그만큼 덮으므로, `${as|k.value}`에서 `ask`를 골라도 `.value`가 지워지지 않고 `??` 뒤도 건드리지 않습니다.
- **태스크 id를 치는 자리에서는 뒤따르는 `.key`를 건드리지 않습니다.** `ask`와 `asky`가 함께 있을 때 `${as|k.value}`에서 `asky`를 골라도 `${asky.value}`가 됩니다. 전역 참조(`workspaceFolder`, `file` 등)는 `.key`를 갖지 않으므로 표현식 전체를 대체합니다.
- **닫는 `}`가 없으면 커서 뒤를 덮지 않습니다.** `"cp ${gen.|report.html dist/"`처럼 참조가 닫혀 있지 않으면 뒤 글자가 참조의 속성인지 명령 인자인지 알 수 없어, 확신할 수 있는 자리(`}` · `"` · 줄바꿈 · `??`)에서만 덮습니다. 꼬리가 붙어 남을 수는 있어도 **입력한 것을 잃지는 않습니다.**
- **커서가 `??` 안(`${a.b ?|? c.d}`)이면 제안하지 않습니다** — 그 자리에서는 무엇을 골라도 `??`가 지워져 체인이 통째로 리터럴이 되기 때문입니다.
- 편집 중이라 JSON이 아직 유효하지 않아도 동작합니다 — 자동완성이 불리는 시점의 문서는 거의 항상 미완성이기 때문입니다.

### 액션 소스와 병합 우선순위

Actions 패널의 목록은 세 종류의 소스를 병합해 만듭니다. 같은 `id`가 겹치면 **워크스페이스 > 프리셋 > 번들 예제** 순으로 우선합니다.

| 소스 | 위치 | 언제 보이나 |
| --- | --- | --- |
| 워크스페이스 액션 | 각 워크스페이스 폴더의 `.vscode/actions.json` | 항상 (멀티루트면 폴더별로 모두) |
| 프리셋 | 확장 `presets/` 또는 워크스페이스 `.vscode/presets/` | `taskhub.preset.selected`로 선택했을 때 ([§17](#17-preset-기능)) |
| 번들 예제 (`defaultButton.*`) | 확장의 `media/actions.json` | `taskhub.builtinActions` 설정에 따름 (기본 `auto`) |

**번들 예제의 `auto` 동작**: 예제를 액션 목록에 넣지 않고, 액션이 없을 때 뜨는 [빈 상태 안내](#빈-상태-안내와-제목-표시줄-구성)의 *Browse Examples* 버튼으로 연결합니다.

| 값 | 액션 목록에 예제 | 빈 상태 CTA의 *Browse Examples* |
| --- | --- | --- |
| `auto` (기본) | 넣지 않음 | 표시 |
| `always` | 넣음 (0.6.14 이전 동작) | — (목록이 비지 않으므로 CTA 자체가 없음) |
| `never` | 넣지 않음 | 숨김 |

- 예제가 목록에 없으면 id 충돌 검사 대상에서도 빠집니다 — 즉 자기 액션에 `defaultButton.showEnv` 같은 id를 써도 충돌로 막히지 않습니다.
- 예제 정의는 언제든 제목 표시줄 `…` 메뉴의 *Show Example JSON* 으로 볼 수 있습니다.

**교차 소스 id 중복은 오류가 아니라 경고입니다.** 같은 `id`가 두 소스에 있으면 위 우선순위로 해소되고, Actions 트리 맨 위에 지속되는 경고 행이 표시됩니다. 행의 툴팁은 충돌한 소스와 실제 최종 적용된 정의를 보여 주며, 상위 폴더 ID 충돌로 중첩 정의가 모두 제거된 경우도 구분합니다. 클릭하면 전체 내용을 기록한 TaskHub 출력 채널을 엽니다. 충돌 구조에 따라 중첩 액션이 최종 트리에서 제외될 수 있고, `taskhub.runAction.<id>` 커맨드와 History 조회는 **최종 트리에 남은 쪽**만 가리키므로 경고를 확인해 의도한 정의인지 점검하세요. (같은 파일 *안*의 중복은 다릅니다 — 그건 로드 자체가 실패합니다.)

> [액션 생성 마법사](#8-액션-생성-마법사)는 현재 트리에 병합되는 전체 소스를 기준으로 ID 중복을 검사합니다. 선택된 프리셋과 다른 워크스페이스 폴더도 포함하고, `builtinActions` 설정으로 제외된 예제는 검사하지 않습니다.

### JSON Editor 커맨드

Command Palette에서 `taskhub json`을 검색하면 두 개의 JSON Editor 커맨드가 표시됩니다. 용도가 다르므로 상황에 맞게 선택하세요.

| 커맨드 | 동작 | 사용 시점 |
| --- | --- | --- |
| **TaskHub: Open JSON Editor** (`taskhub.openJsonEditor`) | 파일 선택 대화상자를 띄워 임의의 JSON 파일을 고른 뒤 JSON Editor로 엽니다. 활성 에디터와 무관하게 항상 동일하게 동작합니다. | Command Palette에서 임의의 JSON 파일을 바로 열고 싶을 때 |
| **TaskHub: Open with JSON Editor** (`taskhub.openJsonEditorFromUri`) | URI 인자를 받는 컨텍스트 커맨드입니다. 에디터/탐색기/SCM 컨텍스트 메뉴의 *Open with JSON Editor* 항목에서 대상 파일을 전달받아 엽니다. Command Palette에서 인자 없이 실행하면 현재 활성 에디터가 `.json` 파일일 때 그 파일을 열고, 그 외에는 *Open JSON Editor* 동작으로 폴백해 파일 선택 대화상자를 띄웁니다. | `.json` 파일을 연 상태에서 빠르게 JSON Editor로 전환하거나, 탐색기/에디터 우클릭 메뉴에서 호출할 때 |

#### 여는 파일의 조건

**루트가 객체이거나 배열이어야 합니다.** 표(시트)로 보여 주는 도구라 그 둘만 의미가 있기 때문입니다. `null`·숫자·문자열·불리언은 그 자체로 유효한 JSON이지만 열 수 없고, 패널을 만들기 전에 어떤 루트였는지 밝히는 오류로 거절합니다.

**표의 행은 객체를 전제합니다.** `[null, 1, "a"]`처럼 원시값이나 배열인 행은 값만 표시하고 읽기 전용으로 둡니다. 저장해도 원문은 보존되며, 객체 키가 하나도 없는 시트는 **값**(Value) 열을 사용합니다.

#### 데이터 보호

JSON Editor는 다음 규칙으로 사용자 변경을 보호합니다.

- **잘못된 셀 차단**: 객체·배열 셀의 JSON 파싱이 실패하면 편집 상태와 오류를 유지하고 저장하지 않습니다.
- **Undo / Redo**: 셀 commit, 행 추가·삭제·정렬, 값 변환을 최대 20단계·16MB까지 되돌립니다. 셀 입력 중에는 브라우저 input의 undo가 우선합니다.
- **Dirty-close 복구**: commit된 변경은 워크스페이스 상태에 저장합니다. 다시 열 때 파일의 mtime·size가 같으면 복구를 묻고, 외부 변경이 확인되면 폐기합니다. 아직 파싱되지 않는 셀의 편집 중 raw text는 스냅샷에 포함하지 않습니다.
- **복구 한도**: 최신 20개·총 32MB 중 먼저 닿는 한도를 적용해 오래된 항목부터 제거합니다. 단일 스냅샷이 총량보다 커도 그 항목 하나는 남깁니다.
- **타입 보존과 변환**: 기존 문자열은 문자열로, 숫자·불리언·`null`은 원래 타입으로 commit합니다. 배열도 항목별로 적용하며 새 빈 항목은 주변 타입을 따릅니다. `a→s`·`s→a`와, 손실 없는 경우에만 보이는 `s→#`·`#→s`로 의도적인 변환을 수행합니다.
- **외부 변경 감지**: dirty가 아니면 자동으로 다시 읽고, dirty면 *다시 읽기 / 현재 편집 유지*를 묻습니다.

#### 기타 단축키

- `Ctrl+S` (macOS `Cmd+S`): 저장. 편집 중 셀이 있으면 commit 을 시도하고 실패 시 저장을 중단합니다.
- `Ctrl+F` (macOS `Cmd+F`): VS Code 기본 찾기 위젯으로 현재 보이는 셀 값/헤더를 검색합니다.
- `Alt+↑` / `Alt+↓` (0.6.19부터): 행 순서 변경. 행 왼쪽의 `⠿` 그립에 포커스를 두고 누릅니다 (Tab으로 이동 가능). 이동 후 포커스는 옮겨진 행을 따라가므로 연속으로 누를 수 있고, 이동 결과는 스크린리더에 알림으로 전달됩니다. 마우스 드래그 방식도 그대로 동작합니다.

#### 지역화 / 접근성 (0.6.19부터)

- 웹뷰 안의 모든 문자열이 VS Code 언어 설정을 따릅니다 (한국어 / 영어). 이전에는 `Save`, `Reload`, `+ Row` 등이 영어로 고정돼 있었습니다. 문자열은 확장 호스트가 로케일을 해석해 번들로 주입하며, `<html lang>` 속성도 함께 맞춰집니다.
- 아이콘만 있는 버튼(↶ ↷ ✕ ⠿ a→s s→a s→# #→s)에 `aria-label`이 붙습니다.
- **대비·타깃 크기 (0.7.0부터)**: 삭제 버튼은 배경으로 설계된 테마 토큰을 써 다크 테마에서 5.49:1 (WCAG 1.4.3 AA 통과). 삭제 버튼은 최소 24×24 크기를 가지고, 변환 배지는 **보이는 크기는 작게 두되 클릭·터치 영역만** 24×24 를 지킵니다 (WCAG 2.2 SC 2.5.8 AA) — 셀마다 붙는 것이라 상자를 키우면 표가 배지로 뒤덮입니다. 답답하면 `--touch-min` 한 줄로 조절할 수 있습니다.
- **포커스 링**: 모든 버튼·셀·탭에 `:focus-visible` 윤곽선이 붙습니다. 키보드로 표를 훑거나 ✕ / 변환 버튼을 누른 뒤 코드가 옮겨 놓은 포커스가 어디 있는지 보입니다 (마우스 클릭 뒤의 프로그램적 포커스 이동은 `:focus-visible` 대상이 아닙니다).
- **편집을 벗어나는 길**: 배열 항목 input도 셀 밖을 클릭하거나 앞으로 Tab해 나가면 commit 됩니다. 같은 셀 안에서 Tab하거나 ✕ / +를 누르는 것은 편집을 끝낸 것으로 보지 않으며, 해당 버튼에서도 Escape로 편집을 취소할 수 있습니다. 삭제·이동 버튼의 라벨에는 행 번호가 포함됩니다(예: *3번 행 삭제*).
- 수정 표시는 `role="status"`, 오류 메시지는 `role="alert"` live region으로 노출되고, 행 이동 같은 변화는 전용 알림 영역으로 전달됩니다. 아이콘 전용 열 머리글에는 화면에 보이지 않는 이름(순서 변경 / 행 번호 / 작업)이 들어갑니다.
- **셀 편집 진입 (0.6.31부터)**: 셀에 Tab으로 이동해 `Enter` 또는 `Space`로 편집을 시작할 수 있습니다. 이전에는 클릭 전용이라 키보드만으로는 값을 고칠 수 없었습니다 — 표를 읽을 수는 있으나 편집기로는 쓸 수 없는 상태였습니다.
- **시트 탭 (0.6.31부터)**: `Tab`으로 탭 줄에 진입하고 `←` / `→`로 이동합니다(양끝에서 순환). 0.6.19는 모든 탭을 Tab 순서에 넣었는데, 이는 스크린리더가 `role="tab"`을 보고 안내하는 조작법(화살표 이동)과 어긋났습니다. 탭과 표 영역이 `aria-controls` / `role="tabpanel"`로 서로를 가리키므로 어느 시트를 보고 있는지도 전달됩니다.

## 4. 링크 패널 (Workspace Links)

*   **워크스페이스 링크 (`mainView.linkWorkspace`)**: 워크스페이스의 `.vscode/links.json`에 정의된 링크를 표시합니다. 제목에는 링크의 총 개수가 표시되며 VS Code 언어가 한국어면 `워크스페이스 링크 (5)`, 그 외에는 `Workspace Links (5)` 형식을 사용합니다.

**주요 기능:**
*   **링크 클릭**: 링크 항목을 클릭하면 기본 브라우저에서 URL이 열립니다.
*   **행 액션**: 링크 항목을 클릭하면 열리고, 마우스를 올리면 자주 쓰는 URL 복사 아이콘 하나만 표시됩니다. 키보드 사용자는 `Shift+F10`의 우클릭 메뉴에서 링크 열기·URL 복사·편집·삭제에 모두 접근할 수 있습니다.
*   **링크 추가 / 편집**: **+**에서 URL과 제목을 입력합니다. 제목은 URL host로 미리 채우며 그룹·태그는 `links.json`에서 편집합니다. 저장 시 `http`·`https`·`mailto`만 허용하고 URL 구문을 검사합니다. 손상된 `links.json`은 덮어쓰지 않고 파일을 열어 고칠 수 있는 알림을 표시합니다.
*   **검색**: 돋보기 아이콘을 클릭하여 링크를 빠르게 검색할 수 있습니다.
*   **파일 편집**: 연필 버튼을 클릭하여 `links.json` 파일을 직접 편집할 수 있습니다.

## 5. Actions 패널 (`mainView.main`)

워크스페이스의 `.vscode/actions.json`, 선택한 프리셋, 설정에 따라 번들 예제를 합쳐 실행 가능한 액션 트리를 만듭니다. 실제 작성법은 [`actions.json` 작성 가이드](actions.md), JSON 형식의 정본은 [actions.schema.json](../schema/actions.schema.json)을 참고하세요.

### 빈 상태 안내와 제목 표시줄 구성

액션이 없으면 *Create Action*·*Browse Examples*·*Import Actions…*를 안내합니다. JSON 파싱이나 스키마 검증이 실패한 경우에는 빈 상태로 처리하지 않고 오류 행을 표시하며, 클릭하면 실패한 파일을 엽니다. 제목에는 확장 버전이 표시되고, 검색·생성과 실행 중에만 보이는 중지 명령을 아이콘으로 노출합니다. `actions.json` 편집은 `…` 메뉴에 둬 제목 표시줄이 복잡해지지 않게 합니다.

### 멀티 task 액션의 진행 표시

여러 태스크를 실행할 때 액션 옆에 `2/3 · link` 또는 병렬 실행 중인 태스크 요약이 표시됩니다. 병렬 실행 문구는 VS Code 언어 설정을 따릅니다. 단일 태스크에는 표시하지 않고 종료 시 제거합니다. 상태와 진행률은 스크린리더용 이름에도 함께 제공됩니다. `taskhub.showTaskStatus: false`의 직접 범위는 Actions 뷰의 상태 아이콘·진행률·접근성 상태 문구이며 중지 기능은 그대로 동작합니다. 기본 `executionNotifications: "followStatus"`에서는 일반 완료·실패 알림도 이 값을 따르고, 알림만 유지하려면 `"on"`을 선택합니다.

### 장시간 액션 완료 알림

기본 10초 이상 실행된 액션이 성공·실패·중지되면 소요 시간을 상태 표시줄에 5초 동안 보여 줍니다. 완료 시점에 VS Code 창이 포커스되지 않았다면 알림도 보내며, 750ms 안의 성공·중지 알림은 결과 개수별 요약 하나로 묶습니다. 실패는 액션 이름과 원인을 잃지 않도록 기존 상세 오류 알림을 개별로 유지하고 상태 표시줄 요약에만 합칩니다. 기존 `successMessage`와 같은 결과를 두 번 알리지 않으며, 비밀번호 입력에서 파생된 실패는 민감 디버그 버튼이 있는 기존 알림을 우선합니다.

`taskhub.executionNotifications`는 액션 지정 완료 메시지·상세 실패 알림·부분 취소 안내와 이 장시간 완료 표시를 제어합니다. 기본값 `followStatus`는 기존 동작을 보존하므로 일반 알림은 `taskhub.showTaskStatus`를 따르지만, 기존에도 독립적이던 분리 실행 원샷 실패 알림은 계속 표시합니다. `on` 또는 `off`를 선택하면 원샷 실패까지 포함한 실행 알림 전체를 Actions 뷰 상태와 독립적으로 켜고 끌 수 있습니다. 실행 중 설정을 바꾸면 완료 시점의 값을 적용합니다. `taskhub.backgroundCompletion.*` 설정은 알림이 켜진 범위 안에서 장시간 완료 표시의 임계값·포커스 정책·대상 결과만 좁힙니다. 자세한 옵션은 [§21 설정 레퍼런스](#21-설정-레퍼런스)를 참조하세요.

### 액션에 단축키 할당

ID가 있는 액션은 `taskhub.runAction.<encoded-id>` 커맨드로 동적 등록됩니다. 액션 우클릭 → **Assign Shortcut**을 선택하면 VS Code Keyboard Shortcuts가 해당 커맨드로 필터링됩니다. 액션 변경 시 등록도 동기화되며, 폴더와 구분선은 등록하지 않습니다.

### Quick Action Palette (`TaskHub: Run Any Action…`)

Actions 제목 표시줄의 돋보기, Command Palette 또는 직접 지정한 단축키로 모든 액션을 fuzzy 검색합니다. 폴더 breadcrumb도 검색 대상이며, 최근 실행 항목은 History에서 유도합니다.

- 최근 항목 수는 `taskhub.runAnyAction.recentLimit`, 보관 가능한 상한은 `taskhub.history.maxItems`가 결정합니다.
- 삭제된 액션과 도구 열람 기록은 목록에서 제외합니다.
- 최근 항목에는 마지막 실행 시각·소요 시간·실패/취소 상태가 표시됩니다.

### `actions.json` 작성

Actions 패널의 항목은 워크스페이스의 `.vscode/actions.json`, 선택한 프리셋과 번들 예제를 병합해
구성합니다. 액션 하나는 여러 태스크를 순서대로 실행할 수 있으며 사용자 입력, 명령 실행, 파일 쓰기,
압축·해제, 조건 분기와 반복을 조합할 수 있습니다.

실제 JSON 작성법은 별도 문서인 [`actions.json` 작성 가이드](actions.md)를 참고하세요. 다음 내용을
코드 없이 작성할 수 있도록 한곳에 정리합니다.

- 최소 액션 구조와 `action.tasks`의 정확한 중첩 위치
- 모든 task type의 용도, 주요 필드와 결과 키
- `fileDialog`·`folderDialog`·`pathDialog` 옵션
- QuickPick의 표시값·실행값·다중 argv 매핑
- 변수 참조, 출력 캡처, 조건·분기·반복
- QuickPick 여러 개와 경로 선택·command 인자를 조합하는 완성 예제

### Preview Run (Dry-run)

액션 우클릭 → **Preview Run**은 실제 명령·파일 쓰기·대화상자 없이 선택된 액션을 시뮬레이션합니다.

- 현재 플랫폼에서 선택될 명령·도구·작업 디렉터리와 출력 처리 방식을 표시합니다.
- 상류 결과는 placeholder로 만들어 변수 연결, `??` 대안, 조건과 자동 의존성을 검사합니다.
- 미해결 참조, 무시되는 필드, 워크스페이스 밖 쓰기와 실행 불가능한 플랫폼 분기를 요약합니다.
- 현재 플랫폼만 보므로 모든 OS 분기는 [TaskHub Doctor](#23-taskhub-doctor-action-lint)로 검사합니다.

태스크별 Preview 해석 기준은 [`actions.json` 작성 가이드](actions.md), 전체 액션 소스의 정적 진단은
[TaskHub Doctor](#23-taskhub-doctor-action-lint)를 참고하세요.

## 6. 즐겨찾기 패널 (`mainView.favorite`)

`.vscode/favorites.json`의 파일을 표시하며 제목에는 전체 개수가 붙습니다. 항목은 `title`, 워크스페이스 상대 `path`, 선택적인 `line`·`group`·`tags`를 가질 수 있습니다.

- 제목 표시줄의 **+**에서 여러 파일을 고르면 basename을 제목으로 즉시 저장합니다. 워크스페이스 밖 파일과 기존 항목은 건너뛰며, 중복뿐이면 파일을 다시 쓰지 않습니다.
- *열려 있는 파일 즐겨찾기에 추가*는 활성 파일과 현재 커서 줄을 저장합니다.
- 손상된 `favorites.json`은 덮어쓰지 않고 파일을 열어 고칠 수 있는 알림을 제공합니다.
- 항목을 클릭하면 저장된 줄로 이동합니다. 제목 표시줄에서는 검색·파일 편집을, 항목 우클릭 메뉴에서는 확인 후 삭제를 수행합니다.

## 7. 확장 프로그램 버전 표시

Actions 뷰 제목 옆 설명에 현재 확장 버전을 표시합니다. 별도 트리 행은 만들지 않으므로 액션이 없을 때 welcome 화면이 정상적으로 보입니다. `CHANGELOG.md`와 세 JSON 예제는 제목 표시줄의 `…` 메뉴에서 엽니다.

## 8. 액션 생성 마법사

Actions 뷰 제목 표시줄의 **+**에서 시작합니다. 필수 값만 받고 나머지는 기본값으로 채운 뒤 `.vscode/actions.json`에서 세부 옵션을 다듬는 흐름입니다.

1.  **워크스페이스 폴더 선택**: 워크스페이스 폴더가 하나뿐이면 자동으로 그것이 사용되며, 여러 폴더를 연 경우에만 선택지가 표시됩니다.
2.  **템플릿 선택**: 생성할 task 구조가 서로 다른 일곱 가지 중 하나를 고릅니다. 안전한 직접 실행이 기본이고, 셸 해석은 위험이 드러나는 고급 선택지로 분리됩니다.

    | 템플릿 | 생성되는 task | 노출하는 개념 |
    | --- | --- | --- |
    | **Direct Command** | `command` | 셸 해석 없는 안전한 기본 실행 |
    | **Shell Script (Advanced)** | `shell` | 파이프·리다이렉션 등 셸 문법, 신뢰할 수 있는 고정 명령 전용 |
    | **File Picker + Command** | `fileDialog` → `command` | 대화형 입력 + `${selectFile.path}` |
    | **Folder Picker + Command** | `folderDialog` → `command` | `${selectFolder.path}` |
    | **Text Input + Command** | `inputBox` → `command` | 실행 시점 값 입력 + `${input.value}` |
    | **Choice List + Command** | `quickPick` → `command` | 고정 목록 선택 + `${choice.value}` |
    | **Multi-step Pipeline** | `command` × N (`step1`…`stepN`) | 순차 실행 (앞 단계 실패 시 중단) |

    동적 값을 사용하는 템플릿은 안전하게 argv로 넘기기 위해 `command`를 만듭니다. 여기에 `&&`·`|`·`>` 같은 셸 연산자를 입력하면 저장 전에 경고합니다. 셸 문법이 꼭 필요하면 **Shell Script (Advanced)**를 선택하되 사용자 입력이나 파일 경로를 명령 문자열에 보간하지 마세요. Multi-step Pipeline은 최대 10단계이며, 선택지 입력은 쉼표로 나누고 빈 값과 중복을 제거합니다.
3.  **제목 입력**: 제목에서 유니코드를 보존한 ID를 자동 생성하고, 충돌하면 `-2`, `-3`을 붙입니다. 확인 단계에서 ID를 바꿀 수 있습니다.
4.  **핵심 값 입력**: 템플릿별로 1~2개 값만 묻고, 필요한 `${task.key}` 참조를 예시에 채웁니다. `cwd`, `revealTerminal`, 완료 메시지 같은 옵션은 기본값을 사용합니다.
5.  **저장 위치 선택**: actions.json에 폴더(`type: 'folder'` 항목)가 있을 때만 위치 선택 Quick Pick이 뜹니다. 폴더가 하나도 없는 평탄한 actions.json이면 이 단계는 자동으로 건너뜁니다. 루트(폴더 밖)는 actions.json 배열 끝에 추가됩니다.
6.  **저장 전 확인**: ID·위치·task 목록을 검토합니다. Doctor는 새 액션이 추가한 문제만 표시하고, *자세히 보기*는 해당 액션의 JSON과 [Preview Run](#preview-run-dry-run)을 엽니다. 취소하면 파일을 수정하지 않습니다.
7.  **저장과 후속 작업**: 저장 후 Actions 뷰를 갱신하고 *actions.json 열기*와 *바로 실행*을 제공합니다.

기존 `actions.json`이 파싱 또는 스키마 검사에 실패하면 덮어쓰지 않고 파일을 열어 고칠 수 있는 알림을 표시합니다.

## 9. 검색 기능

링크와 즐겨찾기 패널에는 빠른 검색 기능이 내장되어 있습니다.

*   **링크 검색**: `mainView.linkWorkspace` 패널의 제목 표시줄에 있는 돋보기 아이콘을 클릭하면 워크스페이스 링크를 검색할 수 있는 Quick Pick이 표시됩니다. 링크 제목과 URL을 기준으로 검색할 수 있으며, 선택하면 해당 링크가 브라우저에서 열립니다.
*   **즐겨찾기 검색**: `mainView.favorite` 패널의 제목 표시줄에 있는 돋보기 아이콘을 클릭하면 즐겨찾기 파일을 검색할 수 있습니다. 파일 제목과 경로를 기준으로 검색할 수 있으며, 선택하면 해당 파일이 에디터에서 열립니다.

## 10. 그룹화 기능

링크와 즐겨찾기는 그룹으로 정리할 수 있어 관련 항목을 체계적으로 관리할 수 있습니다.

*   **링크 그룹**: `links.json` 파일에서 `group` 속성을 사용하여 링크를 그룹화할 수 있습니다. 같은 그룹 이름을 가진 링크들은 접을 수 있는 트리 노드로 묶여서 표시됩니다.
*   **즐겨찾기 그룹**: `favorites.json` 파일에서 `group` 속성을 사용하여 즐겨찾기를 그룹화할 수 있습니다. 그룹은 계층적으로 표시되어 많은 파일을 효율적으로 관리할 수 있습니다.
*   **개수 표시**: 각 패널의 제목에는 전체 항목 개수가 표시되고 VS Code 언어 설정을 따릅니다 (예: `워크스페이스 링크 (5)` / `Workspace Links (5)`, `즐겨찾는 파일 (12)` / `Favorite Files (12)`).

## 11. 작업 종료

실행 중인 행의 사각형 아이콘이나 해당 행의 우클릭 메뉴로 액션 하나를, Actions 제목 표시줄의 **Stop All Actions**(`taskhub.stopAllActions`)로 전체를 중지합니다. 전체 중지 버튼은 실행 중인 액션이 있을 때만 보이며, 대상이 여러 개면 확인을 받습니다. 중지된 실행은 History에 `cancelled`·`stopped`로 기록되고 실패 알림은 표시하지 않습니다.

### 대화형 태스크를 기다리는 중의 중지

- `inputBox`와 `quickPick`은 즉시 닫힙니다.
- OS 네이티브 `fileDialog`·`folderDialog`·`pathDialog`는 강제로 닫을 수 없으므로, 사용자가 대화상자를 끝내는 즉시 파이프라인을 중단합니다.
- **TaskHub 터미널 닫기**(`taskhub.closeAllTerminals`)는 `TaskHub: ` 접두사의 터미널만 닫으며 액션 실행 상태를 바꾸지 않습니다.

실행 중지와 터미널 닫기는 별도 명령입니다. 예전의 `taskhub.terminateAllActions`는 기존 단축키 호환을 위해 두 동작을 차례로 수행하지만 메뉴와 명령 팔레트에는 노출되지 않습니다.

## 12. Multi-root 워크스페이스 지원

이 확장 프로그램은 VS Code의 multi-root 워크스페이스를 완벽하게 지원합니다.

*   **워크스페이스별 설정**: 각 워크스페이스 폴더는 자체 `.vscode/actions.json`, `.vscode/links.json`, `.vscode/favorites.json` 파일을 가질 수 있습니다.
*   **자동 폴더 선택**: 여러 워크스페이스 폴더가 있는 경우, 파일을 추가하거나 편집할 때 대상 폴더를 선택하는 프롬프트가 표시됩니다.
*   **변수 치환**: `${workspaceFolder}` 변수는 각 워크스페이스 폴더에 맞게 올바르게 해석됩니다.

## 13. 쉬운 설정 관리

*   **설정 파일 편집**: Actions는 제목 표시줄의 `…` 메뉴에서, 링크와 즐겨찾기는 제목 표시줄의 연필 아이콘에서 각각 `actions.json`, `links.json`, `favorites.json`을 열어 편집합니다. 파일이 없으면 새로 생성됩니다.
*   **예제 JSON 보기**: Actions 패널 제목 표시줄의 `…` 메뉴에서 세 설정 파일의 예제를 선택합니다.
*   **확장 프로그램 설정 열기**: 명령 팔레트(Cmd/Ctrl+Shift+P)에서 `TaskHub: Open Extension Settings`를 실행하여 확장 프로그램과 관련된 모든 설정을 VS Code 설정 화면에서 쉽게 확인하고 수정할 수 있습니다.

## 14. 액션 실행 히스토리

History 패널은 액션 실행과 Memory Map·Hex Editor·JSON Editor 열람을 저장합니다.

- 상태는 `running`·`success`·`failure`·`cancelled`이며, 취소는 사용자가 누른 Stop과 닫은 프롬프트를 구분합니다. 완료 항목은 실행 시각과 소요 시간 배지를 표시합니다.
- 액션 항목 클릭은 행을 선택할 뿐 실행하지 않습니다. 도구 항목은 클릭하면 저장된 파일과 열기 옵션으로 다시 엽니다. 액션은 행에 남긴 기본 재실행 버튼이나 우클릭 메뉴처럼 의도가 분명한 명령으로만 다시 실행합니다.
- 기본 **재실행**은 입력을 새로 묻고, **저장 입력으로 재실행**만 `inputBox`·`quickPick`·`envPick`·`fileDialog`·`folderDialog`·`pathDialog`·`confirm`의 저장 결과를 사용합니다. 현재 검증 규칙이나 선택지와 맞지 않는 값은 다시 묻고, `password: true`와 환경변수·클립보드·선택 텍스트에서 파생된 입력은 저장하지 않습니다.
- 반복해서 쓸 입력 조합은 History 항목을 우클릭해 **입력값을 프로필로 저장…**으로 이름 붙입니다. 프로필은 팀 파일이 아닌 이 워크스페이스의 `workspaceState`에만 남으며, 액션 우클릭의 **입력 프로필로 실행…**과 **입력 프로필 관리…**에서 실행·이름 변경·삭제합니다. 삭제된 액션의 프로필은 Command Palette의 **TaskHub: 입력 프로필 관리…**에서 정리할 수 있습니다.
- 프로필은 저장 당시의 task ID와 type을 현재 액션에 대조하고 기존 입력 검증도 다시 적용합니다. 바뀌었거나 검증할 수 없는 값은 *오래됨*으로 표시하며, 사용자 확인 없이 버리지 않습니다. 확인하고 실행하면 검증된 값만 재사용하고 나머지는 다시 묻습니다. 0.7.27 이전 History에는 type 서명이 없으므로 거기서 만든 프로필은 첫 실행에서 값을 다시 묻습니다.
- 비밀번호 입력은 프로필에도 저장하지 않습니다. 프로필은 하나당 128KB, 워크스페이스당 50개·총 2MB로 제한됩니다.
- `command`·`shell`의 실제 실행 명령은 태스크별 읽기 전용 문서로 볼 수 있습니다. 비밀 입력은 기록 전에 마스킹합니다.
- 액션 기록의 **실행 보고서 보기**는 실행 당시 결과·소요 시간·실패 사유·실패한 태스크 이름·심각도별 진단 개수와 파일 결과를 태스크 요약 표와 함께 보여 줍니다. 태스크별 명령·출력 상세는 성공한 실행에서는 접고, 실패·중지된 실행에서는 펼친 채로 엽니다. 현재 액션 정의를 다시 읽지 않으므로 액션이 이름 변경·삭제된 뒤에도 실행 당시 보고서를 열 수 있습니다.
- 우클릭 메뉴의 **실행 보고서 보기**는 액션 기록이면 항상 있으며, 로그가 없으면 이유와 함께 **지금 켜기**·**설정 열기**를 제안합니다 — 기능이 있는 줄도 모른 채 지나가지 않도록.
- 행에는 가장 자주 쓰는 **새 입력으로 재실행**만 인라인 버튼으로 남깁니다. 키보드 사용자는 `Shift+F10`의 우클릭 메뉴에서 같은 재실행과 저장 입력 재실행, 명령·실패 출력·실행 보고서 보기, 개별 삭제에 접근할 수 있으며, 제목 표시줄에서는 확인 후 전체 삭제합니다.
- 보관 개수와 패널 표시 여부는 `taskhub.history.maxItems`와 `taskhub.history.showPanel`로 설정합니다. 자세한 기본값은 [§21](#21-설정-레퍼런스)을 참조하세요.

### 실행 로그 영속화 (선택)

`taskhub.runLogs.enabled`(기본 `false`)를 켜면 액션별 구조화 로그를 워크스페이스의
`.taskhub/logs/`에 JSON `.log` 파일로 저장합니다. Command Palette의 **TaskHub: 실행 로그 폴더
열기**로 저장 위치를 바로 열 수 있습니다.

- 액션·태스크 상태, 소요 시간, 마스킹된 명령, `cwd`, 종료 코드, 실패 사유, 진단 개수,
  TaskHub가 직접 확정한 파일 결과와 **이미 캡처 모드로 받은** stdout/stderr를 남깁니다. 임의
  도구 출력에서 산출물을 추측하지 않습니다. VS Code 터미널로 스트림한 출력과 백그라운드
  one-shot 출력은 동작을 바꾸어 캡처하지 않고 각각 `terminal`·`background-one-shot`으로 표시합니다.
- `password: true` 입력을 사용한 태스크의 명령과 `cwd`는 마스킹하고 출력은 `redacted`로만
  기록합니다. 다만 일반 출력에 토큰·프로젝트 데이터가 들어 있는지는 TaskHub가 완전히
  판별할 수 없으므로, 이 기능은 기본으로 꺼져 있습니다.
- History에는 로그 본문이 아니라 워크스페이스 상대 참조만 저장합니다. 보관 정책으로 회전된
  로그, 삭제·손상된 파일, 워크스페이스 폴더가 열려 있지 않은 경우는 보고서에서 각각 이유를
  안내합니다.
- TaskHub가 만든 실패 사유(사용자 중지, 비밀번호 파생 실패 숨김)는 문장이 아니라 코드로
  저장하고 보고서를 여는 시점의 UI 언어로 옮깁니다. 도구가 낸 오류 원문은 번역하지 않습니다.
- 개별 파일은 8MB에서 잘리며 `truncated`와 원래 바이트 수를 남겨 완전한 출력처럼
  보이지 않게 합니다. 기본 보관 정책은 워크스페이스 전체 100개·30일·100MB이며, 만료
  기간 → 개수 → 총 용량 순서로 오래된 파일을 정리합니다. 자세한 상한은 [§21](#21-설정-레퍼런스)에
  있습니다.
- `logs/.gitignore`가 없으면 자동 생성해 로그가 Git에 실수로 포함되지 않게 합니다. 기존
  파일은 덮어쓰지 않습니다. 저장·회전 실패는
  TaskHub 출력 채널에 경고만 남기고 액션의 성공·실패 결과를 바꾸지 않습니다.

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
*   `taskhub.hover.numberBase.enabled` (기본값: `true`): **C/C++ hover 파이프라인 전체의 마스터 토글**. 이 값이 `false` 이면 Number Base / SFR Bit Field / Struct Size / Register Decoder / Macro Expansion 이 모두 중단되며, Bit Operation Hover(§16.1)도 상위 게이트가 닫히므로 동작하지 않습니다. 세부 설명·관련 설정은 [§21 설정 레퍼런스](#21-설정-레퍼런스) 참조.

### 15.5. Register Value Decoder

`reg.dword = 0x...;` 처럼 레지스터 연합/구조체에 상수를 대입하는 문장에서 **숫자 리터럴 위에 hover** 하면, 같은 레지스터의 비트 필드 정의를 참조해 각 필드가 어떤 값으로 디코드되는지를 함께 표시합니다. 내부적으로는 [src/registerDecoder.ts](../src/registerDecoder.ts)가 LSP 정의 점프 + SFR Bit Field 파서 결과를 결합해 계산합니다.

**동작 조건**
- 좌변이 SFR 비트 필드 주석을 가진 레지스터 멤버(예: `.dword`, `.word`)에 할당.
- 우변이 숫자 리터럴 (`0x30B`, `0b1100`, `777` 등 Number Base Hover가 인식하는 형식).
- `taskhub.hover.numberBase.enabled: true` 필요.

**예시**
```cpp
uart_ctrl.dword = 0x30B;   // 0x30B 위에서 hover
// → TX_EN=1, RX_EN=1, PARITY_EN=0, STOP_BITS=1, BAUD_SEL=3
```

예제 파일: [examples/test_register_decoder.h](../examples/test_register_decoder.h) (UART / IRQ / GPIO 레지스터 샘플).

### 15.6. Macro Expansion Hover

`#define`으로 정의된 매크로 식별자 위에 hover 하면 최종 확장 결과가 함께 표시됩니다. 다른 매크로를 참조하는 compound/nested 매크로도 재귀 확장되며, 수치 표현식이 안전 식(`+ - * / | & ^ ~ << >> ()`)으로만 구성된 경우 `MacroExpander.evaluateToNumber()`가 정적 계산한 결과도 함께 보여줍니다. 표현식 길이는 ReDoS/huge-eval 방지를 위해 4096자로 제한합니다 ([src/macroExpander.ts](../src/macroExpander.ts)).

**예시**
```cpp
#define BASE_ADDR  0x40000000
#define REG_OFFSET 0x1000
#define UART_CTRL  (BASE_ADDR + REG_OFFSET)   // UART_CTRL 위 hover
// → 확장: (0x40000000 + 0x1000) → 0x40001000

#define IRQ_ENABLE ((1 << 0) | (1 << 5) | 0x40)  // IRQ_ENABLE 위 hover → 0x61
```

**동작 조건**
- **매크로 정의가 현재 활성 편집기의 같은 파일 안에 있어야 함.** 지금 구현은 `document.getText()` 결과에서 `#define` 라인만 수집하므로 헤더 파일로의 include 체인을 따라가지 않는다. include 건너서 정의된 매크로는 표시되지 않는다.
- `#if` / `#else` 등 전처리기 분기는 평가하지 않으며, 텍스트에 남아 있는 모든 `#define` 을 그대로 수집한다.
- 확장 후 `cleaned` 길이가 4096자 이하. 초과 시 숫자 평가는 건너뛰고 확장 문자열만 표시.
- **확장 예산 (0.6.58부터)**: 깊이 제한만으로는 부족합니다 — `#define Mn M(n-1) M(n-1)` 형태는 깊이가 얕아도 결과가 2^n 으로 커져 hover 하나가 Extension Host 를 세울 수 있습니다. 결과 문자열 **64KB**, 치환 **20,000회**, 내부 단계 기록 **500줄** 중 먼저 걸리는 쪽에서 멈춥니다. 실제 헤더의 매크로는 이 한도에 닿지 않습니다.
    - **한도에 걸리면 그 매크로의 hover 가 뜨지 않습니다** — 오류 문구가 표시되는 것이 아니라 아무것도 나타나지 않습니다. 확장할 수 없는 매크로를 hover 했을 때와 같은 화면입니다.
- **공유 하위식은 한 번만 확장**합니다. 같은 매크로가 여러 번 나오면 처음 결과를 재사용해 지수 팽창을 선형으로 접습니다. 순환 참조에 얽힌 매크로는 결과가 "누가 위에서 확장 중인가"에 달라지므로 재사용 대상에서 제외되며, 재사용이 깊이 제한을 우회하지도 않습니다(같은 정의 집합이면 토큰 순서와 무관하게 같은 답).

> **hover 에 표시되는 것은 확장 *결과*(Hex / Dec / Bin)이지 확장 *단계*가 아닙니다.** 확장기는 단계 기록(`expansionSteps`)을 만들지만 현재 hover 는 그 **개수만** 보고("확장할 것이 있는가") 내용은 쓰지 않습니다.

예제 파일: [examples/test_macro_expansion.h](../examples/test_macro_expansion.h) (단순 / 복합 / 다단계 중첩 매크로).

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

Bit Operation Hover는 Number Base Hover 파이프라인 위에 얹혀 동작하므로 **두 설정이 모두 `true`** 여야 합니다. 어느 하나라도 `false`이면 hover 자체가 반환되지 않습니다.

- `taskhub.hover.numberBase.enabled` = `true` (기본값이므로 특별히 껐다면 다시 켜야 함)
- `taskhub.experimental.bitOperationHover.enabled` = `true`

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
   - **Keep both**: 기존 actions를 모두 유지하고, 충돌하지 않는 preset actions만 추가 (충돌하는 preset 항목은 제외 — `actions.json` 스키마는 ID 유일성을 요구하므로 *중복 허용*은 가능하지 않습니다)

> **데이터 보호 (v0.4.33부터)**: 기존 `actions.json`이 JSON 파싱 또는 스키마 검증에 실패하면 *Replace / Merge* prompt 직전에 modal *손상된 파일 백업 후 계속 / 취소* 가 뜹니다. 백업을 선택하면 원본이 `actions.json.bak`으로 옮겨진 뒤 빈 배열로 진행되어, 손상된 파일을 무방비로 덮어쓰지 않습니다. (`Import Actions`와 같은 가드)

**2. Preset 저장하기**

Command Palette (Cmd+Shift+P)에서 **"TaskHub: Save as Preset"** 실행:

1. Preset ID 입력 (예: integration, hil)
2. 저장 위치 선택:
   - **Workspace**: `.vscode/presets/`에 저장 (Git으로 공유)
   - **Extension**: Extension `presets/` 폴더에 저장
   - **Custom location**: 원하는 위치에 파일로 저장

> **덮어쓰기 보호 (v0.4.33부터)**: *Workspace / Extension* 위치에서 같은 ID의 preset 파일이 이미 존재하면 modal *덮어쓰기 / 기존 파일 열기* 가 뜹니다. *Custom location*은 `showSaveDialog`가 OS 레벨 덮어쓰기 confirm을 자동으로 띄우므로 별도 prompt가 없습니다. 같은 ID로 두 번 저장해 이전 preset이 조용히 사라지던 동작을 차단합니다.

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
          "command": "git checkout main"
        },
        {
          "id": "pull",
          "type": "shell",
          "command": "git pull"
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
2. 파일의 스키마 유효성을 검사합니다. 스키마뿐 아니라 **액션 ID / 태스크 ID 중복**도 정상 로드 경로와 동일하게 검증하여, 가져오기 성공 후 다음 로드가 깨지는 상황을 막습니다.
3. **실행 가능한 설정 신뢰 확인**: Doctor 진단 유무와 관계없이 파일을 쓰기 전에 항상 모달을 표시합니다. `switch`의 각 case/defaultCase는 바깥 공통 설정과 합친 실제 실행 형태로 각각 표시하며, 가져올 액션의 `shell`/`command` 명령·argv·cwd·env, `quickPick.itemsFromCommand`, `writeFile`/`appendFile` 경로, `browser`의 URL·target·cwd, ZIP 작업과 외부 도구의 cwd·env, file output을 요약합니다. **원본 검토**가 기본 버튼이며 원본을 연 뒤에도 다시 명시적으로 동의해야 합니다. 닫기·취소는 가져오기를 중단합니다.
   - Doctor는 셸 보간, 동적·중첩 인터프리터, 워크스페이스 밖 파일 쓰기와 분석 실패를 **추가 진단**으로 표시합니다. 진단이 없다는 것은 `curl … | sh`처럼 고정된 악성 명령이 안전하다는 판정이 아닙니다.
   - 목록이 접혔거나 명령이 축약됐다면 기본 동작인 원본 검토에서 파일 전체를 확인해야 합니다. 이 절차는 신뢰 결정을 돕는 UI이며 샌드박스가 아닙니다.
   - 처음 파싱한 뒤 원본 파일이 변경되면 가져오기를 취소합니다. 다시 선택해 최신 내용을 검토해야 합니다.
   - 원본을 연 뒤의 최종 동의는 편집을 방해하지 않는 알림으로 표시됩니다. 방해 금지 모드 등으로 화면에 보이지 않으면 VS Code 알림 센터에서 계속하거나 취소할 수 있습니다.
4. 기존 `.vscode/actions.json`과 병합합니다:
   - ID가 중복되지 않는 액션만 추가됩니다.
   - 중복된 ID는 건너뛰고, 건너뛴 항목을 알림으로 표시합니다.
5. **기존 `actions.json`이 손상되어 있을 때**는 덮어쓰지 않고 "기존 파일 검토 / 손상된 파일 백업 후 계속 / 취소" 모달을 표시합니다. 검토가 기본 동작입니다. 검토 중 파일을 고쳐 유효해졌다면 최신 내용을 다시 검증해 정상 병합하고, 여전히 손상됐다면 동의 시점의 최신 내용을 `actions.json.bak`로 보존한 뒤 가져온 액션만 저장합니다.
6. `.vscode` 폴더가 없으면 자동으로 생성합니다.

**지원하는 Import 형식:**
- `.taskhub` 파일 (TaskHub Export 형식)
- `actions.json` 파일 (raw JSON 배열 형식)

## 19. Memory Map 시각화

ARM `.axf`/`.elf` 바이너리 또는 ARM Linker Listing을 분석해 Flash/RAM 배치와 사용량을 표시합니다. ELF·Listing 입력 한도는 100MB, linker/scatter 파일 입력 한도는 10MB이며, Listing은 개별 엔트리를 최대 50만 개까지 그립니다. 상한을 넘겨도 Image Totals 요약은 전체 파일 기준입니다.

### 사용 방법

Command Palette에서 **TaskHub: Show Memory Map**을 실행합니다. Explorer에서 `.elf`·`.axf`·`.out`
파일을 우클릭해 **Memory Map으로 열기**를 선택하면 입력 형식과 파일을 다시 묻지 않고 바로 엽니다.
빠른 열기는 파일이 속한 workspace folder의 `taskhub_types.json` 영역 설정을 사용하며, 설정이 없으면
기존 `PT_LOAD` 기반 영역 감지를 사용합니다. 분석 중에는 VS Code 창의 진행 상태에 파일명을 표시합니다.

1. **AXF/ELF** 또는 **ARM Linker Listing**을 선택합니다.
2. AXF/ELF는 `.axf`·`.elf`·`.out` 파일을 고릅니다. 메모리 영역 설정이 없으면 GNU linker script나 ARM scatter file을 선택할 수 있습니다.
3. Listing은 `armlink --list` 출력 파일을 고릅니다. Execution Region에서 영역 크기를 자동으로 읽습니다.
4. 같은 파일을 다시 열면 기존 패널을 재사용하고, 다른 파일은 별도 탭에 엽니다.

Memory Map 패널의 **Refresh**는 현재 입력을 다시 읽어 같은 탭의 결과를 갱신합니다. AXF/ELF는
처음 열 때 선택한 GNU linker script 또는 ARM scatter file도 함께 다시 읽고, ARM Linker Listing은
현재 Listing 파일을 다시 분석합니다. 파일 변경을 자동 감시하지 않는다는 안내가 Refresh 옆에 항상
표시됩니다. 분석이 오래 걸리면 중복 Refresh를 허용하지 않고 기다려야 함을 상태 영역에
안내합니다.

성공하면 완료 시각과 Flash/RAM 사용량 변화를 표시하고, 검색어·현재 검색 위치·영역과 Object Summary의
접기 상태·함수 열·정렬·스크롤 위치를 복원합니다. 분석 중이거나 실패 상태에서 바꾼 화면도 마지막 조작을
기준으로 보존합니다. 실패하면 이전 결과를 그대로 두면서 실패 시각과 원인을 표시하고, 세부 정보는 닫아 간단한
이전 결과 표시로 줄이거나 같은 disclosure 버튼으로 다시 펼칠 수 있습니다. 파일을 고친 뒤 같은 버튼으로
다시 시도할 수 있습니다. 사라진 ELF·Listing·linker/scatter 파일은 raw 시스템 오류와 절대 경로 대신
파일명과 복원·재빌드·재선택 방법을 안내합니다. 성공 안내는 완료 시각을 남긴 채 자동으로 작게 줄어듭니다.

History에 저장된 linker/scatter 파일이 없어졌거나 잠시 파싱되지 않아도 패널을 다시 여는 동작은 저장된
영역 또는 ELF의 `PT_LOAD` 영역으로 계속 진행합니다. 단, **Refresh**는 잘못된 영역으로 성공 처리하지 않고
실패 상태와 이전 결과를 유지합니다.

ELF 패널의 **링커 스크립트 선택…**은 영역 유무와 관계없이 Refresh 옆에 항상 표시됩니다.
현재 ELF를 유지한 채 linker/scatter 파일만 선택하며, 성공·실패 결과를 패널에 남깁니다. 성공한
설정은 History에도 새로 기록되어 다시 열 때 같은 파일을 사용합니다.

### 표시 정보

- Region별 Base·Size·Used·Free·Usage와 사용률 바
- 코드·읽기 전용 데이터·초기화 데이터·BSS 요약
- 영역 안 섹션과 빈 공간의 배치, 섹션 주소·inclusive End·크기·타입
- Listing의 링커 보고값과 TaskHub 계산값 구분
- Region Overview 행 클릭, 접기/펼치기, 실제 수치 기준 열 정렬

사용률은 70% 이상 주황, 90% 이상 빨강으로 표시합니다. 1~3바이트 alignment padding은 계산된 free space에서 제외합니다.

### AXF/ELF 심볼 기반 상세 분석

ELF 프로그램 헤더와 심볼 테이블을 사용합니다.

- `PT_LOAD` 세그먼트에서 메모리 영역을 자동 감지합니다.
- 심볼이 있으면 함수(`FUNC`)와 전역 객체(`OBJECT`) 단위 크기를 보여 줍니다.
- ELF에 DWARF 2~5 `.debug_line` 정보가 있으면 함수 행의 **소스 열기**에서 기록된
  파일과 줄로 이동합니다. 기록된 절대 경로, ELF 기준 상대 경로, 현재 워크스페이스의
  경로 suffix를 먼저 확인합니다. 후보가 없으면 워크스페이스에서 기록 경로의 긴 suffix부터
  단계적으로 검색하며, 후보가 여러 개면 선택 목록을 표시합니다. 한 단계에서 100개를 넘으면
  잘못된 파일을 자동 선택하지 않고 워크스페이스 범위를 좁히도록 안내합니다. 기록된 줄이
  현재 파일 범위를 벗어나면 오래된 위치를 열지 않고 안내합니다.
- DWARF 5 file table에 `DW_LNCT_MD5`가 있으면 이미 찾은 후보의 현재 파일 내용과 비교합니다.
  모든 후보를 확인할 수 있고 저장하지 않은 편집이 없으며 **ELF 기록과 일치**하는 후보가 정확히
  하나일 때 자동으로 선택합니다. 후보가 하나뿐이면 고를 것이 없으므로 불일치나 확인 불가를
  패널 세션에서 한 번만 비차단 경고로 알리고 바로 엽니다. 후보가 여러 개면 Quick Pick에서 각 후보를 아이콘과 함께
  **ELF 기록과 일치**, **ELF 기록과 불일치**, **checksum 확인 불가**로 표시하고, 전체 경로와
  확인하지 못한 이유를 상세 줄에 보여 줍니다. 전부 불일치하면 빌드 후 소스가 바뀌었을 수 있음을
  목록 상단에 안내하며, 불일치하거나 확인할 수 없는 파일도 사용자가 직접 열 수 있습니다.
- 명시적으로 고른 후보는 현재 열린 패널에서 같은 DWARF 기록 경로와 같은 후보 집합에 한해
  다시 사용합니다. **Refresh**를 실행하거나 ELF·후보 집합이 달라지면 기억을 버립니다.
  checksum 비교는 후보 하나당 8MB, 한 번의 선택에서 총 32MB까지만 읽으며, 이 비교 때문에
  workspace 검색 범위를 넓히거나 Hover의 정의 후보를 판정하지 않습니다. 비교 중에는 VS Code
  하단에 진행 상태가 표시되고 취소할 수 있습니다. 같은 패널에서 후보 파일의 크기·수정 시각이
  그대로면 비교 결과를 재사용하며, 파일이 바뀌면 다시 읽습니다. checksum이 없는
  DWARF 2~5는 기존처럼 단일 후보를 바로 열고 복수 후보만 선택 목록을 표시합니다.
- DWARF 5의 0-based directory/file table과 `DW_FORM_string`·`DW_FORM_line_strp`·
  `DW_FORM_strp` 경로를 지원합니다. `.debug_line_str`·`.debug_str` 참조는 ELF 안에서만
  읽고, 잘못된 인덱스나 문자열 범위는 동명 파일로 추측하지 않습니다. 아직 해석하지 않는
  `DW_FORM_strx*`·`DW_FORM_strp_sup` 경로나 압축 문자열 section을 참조한 unit은 손상
  경고 대신 지원 범위를 안내하고 건너뜁니다.
- 심볼이 덮지 않는 섹션 구간은 `[other]`로 표시합니다.
- stripped 바이너리, DWARF가 없는 파일, 아직 지원하지 않는 DWARF64·압축 line section은
  소스 열을 숨기고 기존 섹션·심볼 분석은 그대로 제공합니다. 압축 플래그가 붙은 `.debug_line`과
  실제로 압축 문자열 section이나 미지원 경로 form을 참조한 unit은 파서 오류 대신 아직 지원하지
  않는 형식임을 안내합니다. 정상 unit이 함께 있으면 그 위치의 소스 열은 계속 제공합니다.
- 심볼과 섹션의 **바이트 보기**는 ELF 원본 파일을 Hex Viewer로 열고, 가상 주소에
  대응하는 파일 오프셋 범위를 바로 선택합니다. BSS/NOBITS처럼 파일에 저장되지 않는
  범위는 **파일 바이트 없음**으로 표시하고 이유를 안내합니다.
- Memory Map을 연 뒤 ELF 파일이 다시 빌드되거나 교체되면 오래된 오프셋과 소스 위치를
  사용하지 않고 **Refresh**하도록 안내합니다. ARM Linker Listing에는 대응 바이너리와
  DWARF가 없으므로 바이트·소스 열을 표시하지 않습니다.

### Region별 Object Summary

오브젝트가 둘 이상인 region은 `.o` 파일별 총 크기·바이트·점유율·섹션 수를 접힌 표로 제공합니다. *섹션 행* 토글로 Address·End·Size·Type을 펼칠 수 있고, 정렬할 때 오브젝트와 하위 섹션이 한 묶음으로 이동합니다.

### 함수명 표시 (Region Details)

Function 토글은 Section과 Function 열을 함께 표시합니다. ARM Listing은 `.text.`·`.rodata.` 같은 알려진 prefix를 제거해 함수명을 추출하며, 알 수 없는 prefix는 원문을 유지합니다.

### 리포트 복사

- **Copy Report**: 파일 정보, Memory Regions, region별 큰 섹션과 free hole, 포화 영역 경고를 담은 짧은 Markdown 보고서
- **Copy Full Dump**: 모든 region·section을 담은 고정폭 텍스트. diff나 회귀 비교에 적합

공유할 때 문구가 안정적으로 유지되도록 복사되는 보고서 본문은 영어입니다.

### HTML 저장

**Save HTML**은 저장 시점에 렌더된 Memory Map을 standalone HTML로 저장합니다. VS Code 없이 브라우저에서
열 수 있으며 검색·정렬·영역 펼치기/접기는 그대로 동작합니다. 브라우저에서 동작하지 않는 host 전용
툴바·Refresh 상태·설정 이동 버튼과 Hex/Source 열은 내보내지 않고, 저장된 스냅샷이라는 안내를 표시합니다.
저장 순간의 검색·lazy render DOM이 새 문서의 내부 상태와 어긋나지 않도록, standalone 문서는 검색을 비우고
영역을 접은 일관된 상태에서 시작합니다.

### 성능 최적화

Region 상세는 펼칠 때 생성하고, 200행을 넘는 표는 가상 스크롤을 사용합니다. 검색과 정렬은 원본 데이터 배열에서 처리합니다.

### 검색 및 탐색

- 상단 검색은 오브젝트·섹션·함수·주소·크기·타입을 필터링합니다. `Ctrl/Cmd+F`로 포커스하고 `Esc`로 비웁니다.
- 일치 부분을 강조하고 `Enter`·`Shift+Enter` 또는 `◀`·`▶`로 순환 이동합니다. 결과가 없는 region은 숨기며 Object Summary도 같은 필터를 적용합니다.
- **Go to Symbol**(`Ctrl/Cmd+Shift+O`)은 심볼·섹션·region을 Quick Pick으로 찾아 행으로 이동합니다. 목록은 큰 항목 5,000개로 제한하고 크기가 0인 심볼은 제외합니다.
- C/C++ 편집기의 **커서의 심볼 보기**는 열려 있는 모든 맵의 전체 행을 검색합니다. Itanium ABI의 이름부와 `.constprop.N`·`.isra.N` clone을 인식하되 부분 문자열은 일치시키지 않습니다. 후보가 여러 개면 주소·크기·영역·파일을 보고 선택합니다.
- 검색 필터가 이동 대상을 숨긴 경우에만 필터를 비우며, 접힌 region과 가상 스크롤 행은 자동으로 펼치고 이동합니다.
- region 카드와 정렬 헤더는 키보드로 조작할 수 있고 포커스·상태를 스크린리더에 전달합니다.

### 메모리 영역 설정

`.vscode/taskhub_types.json`의 `memoryMap.regions`로 영역을 명시할 수 있습니다.

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

`origin`은 시작 주소, `size`는 바이트 단위 크기입니다. 이 설정이 있으면 링커 스크립트 선택을 생략합니다. ELF32의 little/big endian과 Cortex-R/M 계열을 지원합니다.
`regions`가 배열이 아니거나 항목의 `name`·`origin`·`size`가 잘못되면 부분만 임의로 쓰지 않고 설정
전체를 무시한 뒤 ELF의 `PT_LOAD` 영역 자동 감지로 폴백합니다.

### 링커 스크립트 자동 파싱

GNU Linker Script의 `MEMORY` 블록(`.ld`·`.lds`·`.lcf`)과 ARM Scatter File(`.sct`)에서 이름·시작 주소·크기를 추출합니다.

```ld
MEMORY {
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 1M
    RAM (rwx)   : ORIGIN = 0x20000000, LENGTH = 256K
}
```

### ARM Linker Listing 파싱

ARM Compiler 5/6의 `armlink --list` 출력을 지원합니다. Execution Region, 섹션 주소·크기·타입·오브젝트, Image Totals를 읽고 같은 섹션 이름을 집계합니다. 오브젝트 요약과 Function 열도 동일한 UI에서 제공합니다.

### 지원 파일 형식

| 확장자 | 설명 |
| --- | --- |
| `.axf`, `.elf`, `.out` | ELF 실행 바이너리 |
| `.ld`, `.lds`, `.lcf` | GNU Linker Script |
| `.sct` | ARM Scatter File |
| `.txt` | ARM Linker Listing |
## 20. Hex Viewer

Intel HEX, Motorola SREC, raw binary 펌웨어를 VS Code 안에서 주소·Hex·ASCII 형태로 표시합니다. 입력 한도는 50MB이며, HEX/SREC 파서에는 비정상적으로 희소하거나 큰 입력을 막는 3,200만 byte-entry 상한이 추가로 적용됩니다.

### Hex/Text 변환기

파일 없이 문자열과 Hex 바이트를 빠르게 바꾸려면 Command Palette에서
**TaskHub: Hex/Text 변환기**를 실행합니다. 별도 변환 버튼은 없습니다. 왼쪽 **Text** 또는 오른쪽
**Hex bytes**에 입력하는 즉시 반대쪽 값, 문자·바이트 수, 첫 8바이트의 정수·부동소수점 해석이
함께 갱신됩니다.

- 문자 인코딩은 `UTF-8`과 `ASCII` 중에서 선택합니다. ASCII 범위를 벗어난 문자·바이트와 올바르지
  않은 UTF-8은 입력 영역 아래에 즉시 안내됩니다.
- Hex는 `48656C6C6F`, `48 65 6C 6C 6F`, `0x48, 0x65` 형식을 모두 지원합니다. 입력을 마치고
  포커스를 옮기면 선택한 **Hex 표시 단위**에 맞춰 정리됩니다. 1·2·4바이트 단위로 묶을 수 있고,
  마지막 바이트가 단위보다 짧아도 그대로 표시합니다(예: `4865 6C6C 6F`).
- **한 줄 바이트 수**에서 8·16·32바이트 중 하나를 선택합니다. Hex 입력 왼쪽에는 첫 행
  `0x00000000`부터 각 행의 byte offset이 표시되며, Hex를 세로로 스크롤하면 함께 이동합니다.
- Hex 표시 단위는 공백 위치만 바꾸며 원본 바이트 순서는 바꾸지 않습니다. Little-Endian/Big-Endian
  선택도 값 해석에만 적용됩니다. 2·4바이트 표시에서 마지막 그룹이 덜 찬 경우 바이트 수 옆에
  부족한 개수를 알리고, 미리보기에서 실제 바이트는 보조 색상으로, 부족한 `··`는 warning 색상으로
  구분합니다. `··`는 화면 안내일 뿐 실제 Hex나 Text에 `00`을 추가하지 않습니다.
- **Text 복사**·**Hex 복사**로 결과를 클립보드에 복사하고, **모두 지우기**로 새 변환을 시작합니다.
- 자주 쓰는 값은 각 카드의 **Text 저장**·**Hex 저장**으로 등록합니다. 넓은 화면에서는 오른쪽에,
  좁은 화면에서는 변환기 아래에 저장 목록이 표시되며, 항목을 누르면 저장 당시 인코딩·바이트 순서와
  값을 즉시 불러옵니다. 최대 24개, 항목당 16KB까지 저장되고 VS Code를 다시 열어도 유지됩니다.
- 입력·한 줄 바이트 수는 같은 탭의 Webview가 다시 로드되어도 복원됩니다. 마지막으로 사용한
  **Text encoding**, **Hex grouping**, **Numeric byte order**는 패널을 닫거나 VS Code를 다시 열어도
  다음 변환기의 초기값으로 유지됩니다. 실시간 변환 입력은 1MB로 제한됩니다. 64KB 이하의 일반
  입력은 매 입력 이벤트에서 즉시 변환하고, 그보다 큰 입력은 키 입력을 막지 않도록 120ms 동안
  이어진 변경을 한 번으로 합쳐 갱신합니다.

### 사용 방법

Command Palette에서 **TaskHub: Open Hex Viewer**를 실행하고 파일을 고릅니다. 알려진 확장자는 그 형식을 우선 사용하고, 그 밖의 파일만 길이·자릿수·체크섬이 유효한 레코드를 찾아 텍스트 형식을 감지합니다.

서로 다른 파일은 각각 별도의 Hex Viewer 탭으로 유지되며, 같은 파일을 다시 열면 기존 탭을
표시하고 최신 내용으로 다시 읽습니다. 이 파일별 탭은 웹뷰가 표시 데이터를 받은 뒤 확장 호스트의
파싱 결과를 해제하지만, 각 탭의 표시 데이터와 화면 상태는 유지됩니다. 큰 파일을 여러 개 확인한
뒤 사용하지 않는 탭은 닫는 것이 좋습니다.

ELF/AXF Memory Map의 **바이트 보기**에서 열면 ELF 컨테이너를 raw binary로 표시하고,
선택한 심볼·섹션의 파일 오프셋 범위를 기존 Go-to/selection 흐름으로 바로 선택합니다.
이 경로에도 50MB 입력 한도가 적용됩니다.

### 화면 구성

| 영역 | 설명 |
| --- | --- |
| 헤더 | 파일명, 포맷, 크기, 주소 범위, Entry Point |
| 툴바 | Unit, Endian, Go to, Find, Copy |
| Address | 실제 메모리 주소 |
| Hex / ASCII | 단위별 바이트와 출력 가능한 문자 |
| 상태바 | 선택한 바이트의 offset·address·정수 해석 |

### Unit 크기 옵션

1·2·4·8바이트 단위와 Little/Big Endian을 선택할 수 있습니다. 파일 끝이 unit 크기에 못 미치면 남은 바이트를 짧은 마지막 셀로 표시하며 선택·Go to·Find에도 포함합니다.

| Unit | 예시 | 대표 용도 |
| --- | --- | --- |
| 1 Byte | `00 20 00 08` | 개별 바이트 |
| 2 Bytes | `2000 0800` | 16-bit 값 |
| 4 Bytes | `00200008` | 32-bit 포인터·정수 |
| 8 Bytes | `0020000800000000` | 64-bit 값 |

### 검색 기능

`Ctrl/Cmd+F`에서 `08 00 00 20`처럼 바이트 패턴을 검색하고 Prev/Next로 이동합니다.

### 기타 기능

- **Go to**로 주소 이동
- 드래그 또는 Shift+클릭으로 범위 선택 후 `Ctrl/Cmd+C` 복사
- Intel HEX/SREC의 비어 있는 주소를 gap으로 표시
- 키보드 화살표·PageUp/PageDown·Home/End로 이동하고 Shift와 함께 범위 선택
- 지역화된 UI, 연결된 레이블, live region과 `aria-label` 제공

### 대용량 파일 지원

가상 스크롤로 보이는 행만 렌더링하고, 바이트는 `postMessage`로 웹뷰에 전달합니다. raw binary는 `Uint8Array`로 유지합니다.

### 지원 포맷

| 포맷 | 확장자 | 특징 |
| --- | --- | --- |
| Intel HEX | `.hex`, `.ihex` | Extended Linear/Segment Address, Entry Point |
| Motorola SREC | `.srec`, `.s19`, `.s28`, `.s37` | S1/S2/S3 데이터, S7/S8/S9 Entry Point |
| Raw Binary | `.bin`, `.dat` | 주소 0부터 순차 표시 |

---
## 21. 설정 레퍼런스

설정 정의의 정본은 [package.json](../package.json)의 `contributes.configuration`입니다. 이 표는 같은 키·타입·기본값·범위를 사용자 관점에서 설명하는 레퍼런스이며, README는 자주 쓰는 설정의 짧은 안내와 이 섹션을 가리키는 포인터만 유지합니다.

설정을 수정하려면 VS Code에서 `File > Preferences > Settings` → "TaskHub"로 검색하거나, 워크스페이스 `.vscode/settings.json`에 직접 키를 추가하세요.

### 21.1. 전체 설정 표

| 설정 ID | 타입 | 기본값 (범위) | 요약 | 관련 기능 |
| --- | --- | --- | --- | --- |
| `taskhub.showTaskStatus` | `boolean` | `true` | Actions 뷰의 상태 아이콘·다중 태스크 진행률·접근성 상태 문구를 직접 제어한다. 기본 `executionNotifications: "followStatus"`의 일반 알림도 이 값을 따르며, 동시 실행 가드와 중지 기능은 그대로다. | [§5 Actions 패널](#5-actions-패널-mainviewmain) |
| `taskhub.executionNotifications` | `"followStatus"` \| `"on"` \| `"off"` | `"followStatus"` | 액션 지정 완료 메시지, 상세 실패 알림, 부분 취소 안내, 장시간 완료 표시를 제어한다. `followStatus`는 기존 동작을 보존해 일반 알림은 `showTaskStatus`를 따르고 분리 실행 원샷 실패는 유지한다. `on`·`off`는 원샷 실패를 포함한 실행 알림 전체에 독립 적용된다. 알림을 꺼도 History·출력 채널·중지 기능은 유지되며 실행 중 변경은 완료 시점부터 반영된다. | [§5 장시간 액션 완료 알림](#장시간-액션-완료-알림), [§14 히스토리](#14-액션-실행-히스토리) |
| `taskhub.backgroundCompletion.thresholdSeconds` | `number` | `10` (0–86400) | 장시간 완료 표시의 최소 실행 시간(초). `0`이면 모든 액션을 포함한다. | [§5 장시간 액션 완료 알림](#장시간-액션-완료-알림) |
| `taskhub.backgroundCompletion.notificationMode` | `"whenUnfocused"` \| `"always"` \| `"never"` | `"whenUnfocused"` | 장시간 성공·중지 완료 알림의 포커스 정책. `executionNotifications`가 켜진 상태라면 `never`여도 짧은 상태 표시줄 안내와 기존 액션 지정 메시지·상세 실패 알림은 유지된다. | [§5 장시간 액션 완료 알림](#장시간-액션-완료-알림) |
| `taskhub.backgroundCompletion.outcomes` | `array` | `["success","failure","stopped"]` | 장시간 완료 표시 대상 결과. 빈 배열이면 다른 실행 피드백은 유지하면서 이 기능만 끈다. 750ms 안의 완료는 하나로 묶는다. | [§5 장시간 액션 완료 알림](#장시간-액션-완료-알림) |
| `taskhub.pipeline.showVerboseLogs` | `boolean` | `false` | 파이프라인 실행 시 TaskHub OutputChannel에 상세 명령/STDOUT/STDERR/exit code를 출력. 디버깅에만 켤 것. | [§5 Actions 패널](#5-actions-패널-mainviewmain) |
| `taskhub.runLogs.enabled` | `boolean` | `false` | 구조화된 액션 실행 로그를 `.taskhub/logs/`에 저장. 일반 stdout/stderr의 미식별 비밀·프로젝트 데이터 영속화 위험 때문에 기본은 꺼짐. | [§14 실행 로그](#실행-로그-영속화-선택) |
| `taskhub.runLogs.maxFiles` | `integer` | `100` (1–1000) | 워크스페이스 전체에 보관할 액션 실행 로그 파일 최대 개수. | [§14 실행 로그](#실행-로그-영속화-선택) |
| `taskhub.runLogs.retentionDays` | `integer` | `30` (0–3650) | 설정 일수보다 오래된 로그를 삭제. `0`은 기간 기준만 끄고 개수·총 용량 상한은 유지. | [§14 실행 로그](#실행-로그-영속화-선택) |
| `taskhub.runLogs.maxTotalSizeMb` | `integer` | `100` (8–4096) | 워크스페이스 전체 로그 합계 용량(MB). 개별 파일 8MB 상한은 별도로 적용. | [§14 실행 로그](#실행-로그-영속화-선택) |
| `taskhub.pipeline.pythonIoEncoding` | `string` | `"utf-8"` | TaskHub가 실행하는 모든 명령의 `PYTHONIOENCODING` 환경변수 값. 빈 문자열이면 강제 설정 안 함. `utf-8:ignore` 같은 값도 가능. | [§5 shell/command 태스크](#5-actions-패널-mainviewmain) |
| `taskhub.pipeline.windowsPowerShellEncoding` | `"utf8"` \| `"system"` | `"utf8"` | Windows PowerShell의 콘솔 출력과 `>`/`>>` 파일 리다이렉션 인코딩. `"utf8"`의 파일은 Windows PowerShell 5.1에서 BOM이 붙고 PowerShell 7에서는 BOM이 없다. UTF-8을 인식하지 못하는 레거시 도구가 있으면 `"system"`으로 전환해 현재 콘솔 코드 페이지를 유지. | [§5 shell/command 태스크](#5-actions-패널-mainviewmain) |
| `taskhub.pipeline.outputCaptureLimitMb` | `number` | `10` (1–1024) | 캡처 모드(`passTheResultToNextTask: true`)에서 누적되는 stdout/stderr 총 크기 상한(MB). 초과 시 프로세스를 종료하고 명확한 에러로 실패. | [`actions.json` Output Capture](actions.md#output-capture) |
| `taskhub.pipeline.totalOutputLimitMb` | `number` | `32` (1–4096) | 한 액션이 들고 있는 **모든 태스크 결과의 합계** 상한(MB). 위 설정이 태스크 하나를 막는다면 이 설정은 합계를 막는다. **태스크 상한보다 작아지지 않는다.** 초과 시 액션 실패. | [`actions.json` Output Capture](actions.md#output-capture) |
| `taskhub.pipeline.maxParallelTasks` | `integer` | `4` (1–32) | 한 액션 안에서 동시에 실행될 수 있는 task 최대 개수. `parallel: true`가 붙은 task만 "이전 모든 task를 기다림" barrier에서 빠지며, barrier에서 빠진 뒤에도 명시적 `dependsOn`과 `${taskId.x}` 자동 추론 의존성은 그대로 기다린다. `parallel: true`가 없는 task는 `dependsOn` 유무와 무관하게 sync barrier로 동작. 기본 4는 임베디드 빌드(linker/LTO)의 메모리 부담을 고려한 보수적 값 — 자원 여유가 있는 머신에서는 늘리고, 완전 순차로 강제하려면 `1`로 설정. | [§5 Actions 패널](#5-actions-패널-mainviewmain) |
| `taskhub.history.maxItems` | `number` | `10` (1–50) | 저장되는 액션 실행 히스토리 최대 개수. 초과분은 오래된 순으로 자동 제거. | [§14 히스토리](#14-액션-실행-히스토리) |
| `taskhub.runAnyAction.recentLimit` | `number` | `5` (0–20) | `TaskHub: Run Any Action…` 팔레트의 *Recently used* 섹션에 표시할 최대 개수. `0`이면 섹션 자체가 숨겨진다. 목록은 히스토리에서 유도되므로 `taskhub.history.maxItems`가 상한으로 작용하고, 표시 시점에 stale 항목(삭제된 액션)을 걸러내므로 실제 보이는 개수는 이 값 이하가 될 수 있다. | [§5 Quick Action Palette](#5-actions-패널-mainviewmain) |
| `taskhub.history.showPanel` | `boolean` | `true` | 사이드바의 History 패널 표시 여부. `false`면 뷰 자체가 감춰지지만 기록은 그대로 유지된다. | [§14 히스토리](#14-액션-실행-히스토리) |
| `taskhub.preview.showSourceControlContextMenu` | `boolean` | `true` | Source Control 변경 파일 우클릭 메뉴에 TaskHub 프리뷰/브라우저 열기 항목을 표시할지 여부. VS Code SCM 메뉴는 확장자 context key를 안정적으로 제공하지 않으므로 켜져 있으면 대상 확장자 외 파일에도 항목이 보일 수 있으며, 실제 실행은 핸들러가 확장자로 재검증한다. | [§22 Markdown / HTML 우클릭 열기](#22-markdown--html-우클릭-열기) |
| `taskhub.builtinActions` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | 확장에 번들된 예제 액션(`defaultButton.*`)을 Actions 목록에 병합할지. `auto`는 목록에 넣지 않고 빈 상태 CTA의 *Browse Examples* 로만 안내, `never`는 그 버튼까지 숨김, `always`는 0.6.14 이전처럼 목록에 병합. | [§3 액션 소스와 병합](#액션-소스와-병합-우선순위) |
| `taskhub.dialog.rememberLastLocation` | `boolean` | `true` | TaskHub의 파일/폴더 다이얼로그를 같은 용도로 마지막에 사용한 위치에서 연다. 그 용도의 기억이 없으면 가장 최근에 사용한 다이얼로그 위치를 이어받는다. `false`면 TaskHub가 시작 위치를 **일절 지정하지 않고** VS Code의 기본 규칙과 `files.dialog.defaultPath` 설정에 맡긴다. 저장 다이얼로그는 제안 파일명도 함께 사라진다. 액션 JSON의 `options.defaultUri`는 어느 쪽이든 존중한다. | [§25 다이얼로그 위치 기억](#25-파일폴더-다이얼로그-위치-기억) |
| `taskhub.hover.numberBase.enabled` | `boolean` | `true` | C/C++ hover 파이프라인 전체의 **마스터 토글**. 이 값이 `false`이면 Number Base / SFR Bit Field / Struct Size / Register Decoder / Macro Expansion 모두 비활성화되며, Bit Operation Hover의 상위 게이트도 닫힌다. | [§15 C/C++ Hover](#15-cc-hover-기능), [§16.1 Bit Operation](#161-bit-operation-hover) |
| `taskhub.experimental.bitOperationHover.enabled` | `boolean` | `false` | **[실험적]** C/C++ 비트 연산식(`value \|= 0x80` 등) 위 Before/After 값 표시. 향후 변경될 수 있음. | [§16.1 Bit Operation Hover](#161-bit-operation-hover) |
| `taskhub.preset.selected` | `string` | `"none"` | 자동 적용할 프리셋 ID. `"none"`이면 워크스페이스 액션만 사용. 확장 내장 또는 워크스페이스 `.vscode/presets/` 내 프리셋 ID를 입력. | [§17 Preset](#17-preset-기능) |

### 21.2. 설정 추가 체크리스트

새 설정을 도입할 때는 **아래 모든 항목을 같은 PR에서** 갱신해 drift를 막아야 합니다.

1. [package.json](../package.json) `contributes.configuration.properties`에 키·타입·기본값·(필요 시) min/max·`description` 또는 `markdownDescription` 추가.
2. 위 §21.1 표에 한 행 추가 — 관련 기능 섹션으로의 링크 필수.
3. 기능의 소개 섹션(해당 §N) 본문에서 **자연스러운 맥락**으로 한 번 언급. 전체 스펙은 반복하지 말고 "자세한 옵션은 §21 참조"로 충분.
4. [CHANGELOG.md](../CHANGELOG.md) 해당 릴리스 항목에 새 설정 명기.
5. (선택) 동작 경계(min/max, 예외 경로)에 대한 유닛 테스트 추가.

README([README.md](../README.md) / [README.en.md](../README.en.md))는 자주 쓰는 설정 이름을 짧게 소개하고 이 표로 연결합니다. 타입·기본값·범위는 복제하지 않으므로 새 설정을 추가하거나 값을 바꿀 때 README까지 기계적으로 고칠 필요는 없습니다. 다만 사용자의 첫 설정 흐름이 달라지면 설명 문장도 함께 검토하세요.

---

## 22. Markdown / HTML 우클릭 열기

VS Code의 소스 컨트롤·탐색기·에디터 탭에서 마크다운 / HTML 파일을 우클릭해 곧바로 렌더링된 형태로 열기 위한 컨텍스트 메뉴 항목입니다. 기본적으로 SCM diff 뷰는 텍스트 비교만 보여주기 때문에 별도의 클릭 한 번 없이 프리뷰로 점프하는 경로가 없었고, 그 빈자리를 메우는 단순한 어댑터입니다.

### 22.1. 적용 범위

| 확장자 | 메뉴 항목 | 동작 |
| --- | --- | --- |
| `.md`, `.markdown` | **TaskHub: Open Markdown Preview** | VS Code 내장 명령 `markdown.showPreviewToSide`에 위임 — 옆 컬럼에 렌더링된 프리뷰. |
| `.html`, `.htm` | **TaskHub: Open HTML in Default Browser** | `vscode.env.openExternal`로 OS 기본 브라우저에서 열기. |

대소문자는 가리지 않습니다(`README.MD` / `INDEX.HTML` 모두 매칭). 위 외 확장자(`.svg`, `.mmd` 등)는 의도적으로 제외 — VS Code가 이미 자동 렌더하거나(SVG) 외부 익스텐션이 필요한 경우(Mermaid)이기 때문에 단순 어댑터로 끼워넣을 가치가 적습니다.

HTML **우클릭 메뉴**는 빠르게 외부에서 확인하는 기존 동작을 유지하므로 항상 OS 기본 브라우저를
사용합니다. 반면 액션이 생성한 HTML이나 HTTP(S) 주소를 VS Code 안에서 열 때는 `browser` 태스크의
`target: "integrated"`를 사용합니다. 로컬 파일의 내장 브라우저 지원 여부는 VS Code 버전에 따라 다르며,
지원되지 않을 때 외부 브라우저로 자동 전환하지 않습니다. 필드, 경로 기준, Remote 환경 사용법은
[`actions.json` 작성 가이드의 `browser` 태스크](actions.md#browser)를 참고하세요.

### 22.2. 컨텍스트 메뉴 노출 위치

세 곳 모두에서 동일한 항목이 보입니다.

- **Explorer** (`explorer/context`) — 파일 탐색기에서 우클릭.
- **Editor 탭** (`editor/title/context`) — 현재 열려 있는 탭 우클릭.
- **Source Control** (`scm/resourceState/context`) — 변경된 파일 우클릭. SCM에서 직접 프리뷰로 점프할 수 있게 한 것이 이 기능을 만든 1차 동기. 단, VS Code SCM 메뉴는 `resourceExtname` / `resourceFilename` / `resourceLangId`를 안정적으로 제공하지 않으므로 확장자별 메뉴 노출은 불가합니다. 대신 `taskhub.preview.showSourceControlContextMenu` 설정으로 SCM 메뉴 전체를 켜고 끌 수 있고, 실행 시에는 핸들러가 실제 URI 확장자를 다시 검증합니다.

명령 ID는 각각 `taskhub.openMarkdownPreview`, `taskhub.openHtmlInBrowser`로, Command Palette 및 키보드 단축키 등록(`keybindings.json`)에도 그대로 사용할 수 있습니다.

### 22.3. URI 해석 규칙

각 메뉴 surface가 명령에 넘기는 첫 번째 인자의 모양이 다르기 때문에, 핸들러 진입 직후 `coerceToUri()`가 모두 `Uri`로 정규화합니다.

| Surface | 1번째 인자 모양 |
| --- | --- |
| `explorer/context` | `Uri` (단일) 또는 `Uri[]` (멀티 셀렉트) |
| `editor/title/context` | `Uri` |
| `scm/resourceState/context` | `SourceControlResourceState` (`{ resourceUri: Uri, ... }`) 또는 그 배열 |
| Command Palette / 프로그래매틱 | `undefined` 또는 임의 |

정규화 후 다음 순서로 대상 URI를 결정합니다.

1. 정규화된 `Uri`가 있고 대상 확장자에 매칭되면 — 그 URI를 사용.
2. 정규화된 `Uri`가 없거나 활성 에디터로 폴백하는 경우 — 활성 에디터의 문서 URI가 대상 확장자에 매칭되면 사용.
3. 그 외 — 한국어/영어 에러 메시지("마크다운 파일이 아닙니다." / "HTML 파일이 아닙니다.")를 출력하고 종료.

대상 URI 정규화·결정 로직과 핸들러는 [src/previewOpener.ts](../src/previewOpener.ts)에 모여 있고, 모든 VS Code API 호출은 의존성 주입 가능한 구조여서 단위 테스트가 실제 VS Code 명령을 호출하지 않고도 위임 경로 + SCM 인자 모양 처리 + 폴백 경로를 검증합니다([src/test/previewOpener.test.ts](../src/test/previewOpener.test.ts)).

---

## 23. TaskHub Doctor (Action Lint)

`actions.json` 전체를 한 번에 정적 분석해 깨진 액션을 빠르게 찾아내는 진단 도구입니다. Preview Run([§5 "Preview Run"](#preview-run-dry-run))이 *한 액션*의 실행 시뮬레이션이라면, Doctor는 *모든 소스*(`media/actions.json` + 선택된 preset + 워크스페이스별 `.vscode/actions.json`)의 건강검진을 한 번에 돌립니다. 결과는 VS Code Problems 패널에 게시되며, 각 항목을 클릭하면 해당 액션이 정의된 라인으로 점프합니다.

### 23.1. 실행 방법

Command Palette에서 **`TaskHub: Doctor — Lint Actions`** 를 실행하면 됩니다. 별도 인자/선택 없이 현재 로드된 모든 `actions.json` 소스를 한 번에 점검합니다. 발견된 문제가 없으면 정보 토스트로 알리고, 문제가 있으면 경고 토스트와 함께 **Problems 열기** 버튼을 제시합니다.

진단 컬렉션은 `taskhub-doctor` 라는 별도 source로 게시되며, 액션 실행 중 Problem Matcher가 만들어내는 진단(`taskhub:<actionId>`)과 분리되어 있습니다 — Doctor 재실행은 자기 결과만 지우고, 빌드 실행 결과는 건드리지 않습니다.

### 23.2. 검사 항목

| 코드 | 심각도 | 설명 |
| --- | --- | --- |
| `json.parse` | error | JSON 파서가 실패한 경우. 위치는 JS 엔진이 보고한 오프셋을 라인/컬럼으로 환산. |
| `schema.*` | error | AJV 스키마 위반. `keyword`에 따라 코드가 `schema.required` / `schema.enum` / `schema.additionalProperties` 등으로 세분화. 메시지는 위반된 JSON Pointer(`/0/action/tasks/1/output`)와 함께 표시되며, 가능한 한 해당 라인을 가리킵니다. |
| `duplicate.action.id` | error | 같은 파일 안에서 같은 action `id`가 두 번 이상 정의됨. |
| `duplicate.task.id` | error | 한 액션의 `tasks[]` 배열에 같은 task `id`가 두 번 이상 등장. |
| `when.operators` | error / warning | `when`에 연산자(`equals`/`notEquals`/`matches`/`in`)가 여럿이면 error — 런타임은 정해진 순서로 **첫 번째만** 적용하고 나머지를 조용히 무시한다. 하나도 없으면 warning (태스크가 항상 실행됨). |
| `when.regex` | error | `when.matches`가 `new RegExp()` 컴파일에 실패. 런타임은 던지지 않고 "맞지 않음"으로 보므로, 잡아 주지 않으면 그 분기가 영영 꺼진 채로 남는다. |
| `when.dead-branch` | warning | 풀리지 않는 `when.var`, 상수 `var`, 빈 `in` 등으로 결과가 항상 참 또는 거짓인 조건. 런타임이 실제로 적용할 연산자만 판정하며 전방 참조는 제외. |
| `when.literal-operand` | warning | `equals`·`notEquals`·`matches`·`in`에 `${…}`가 있음. 피연산자는 보간하거나 의존성으로 읽지 않으므로 적힌 문자열 그대로 비교됨. |
| `foreach.when-each` | error | `forEach` 태스크의 `when.var`가 항목별 `${each}`를 참조함. task-level 조건은 반복 시작 전에 평가되므로 런타임도 이 설정을 실행 전에 거부합니다. 단, id가 `each`인 별도 producer가 있으면 그 결과 참조로 인정합니다. |
| `capture.regex` | error | `output.capture.regex`가 `new RegExp()` 컴파일에 실패. |
| `capture.group` | warning | `output.capture.group` 인덱스가 regex의 capture group 개수를 벗어남. |
| `capture.reserved` | error | `output.capture.name`이 reserved 집합(`output`/`path`/`value` 등 task 결과 빌트인 키)과 충돌. 스키마는 이름 패턴만 검사하므로 schema-pass 후 런타임에서 throw 하던 케이스를 Doctor가 사전에 잡음. |
| `capture.duplicate` | error | 같은 task 안에서 `output.capture.name`이 두 번 이상 정의됨. |
| `diagnostics.regex` | error | `output.diagnostics.pattern`이 컴파일 실패. `g` 플래그는 런타임과 동일하게 사전 제거된 뒤 검사. |
| `diagnostics.group` | warning | `file`/`line`/`message` 등의 그룹 인덱스가 regex가 정의한 capture group 수보다 큼. |
| `diagnostics.preset` | error | `"$gcc"` / `"$tsc"` 같은 preset 단축 문자열이 알 수 없는 이름이거나 `$` 없이 적힘. |
| `variable.unresolved` | warning | 보간 후에도 `${…}`가 남음. `??`는 모든 대안이 실패할 때만 해당하며, OS별 객체는 모든 branch를 검사. 현재 플랫폼만 보려면 [Preview Run](#preview-run-dry-run) 사용. |
| `variable.dead-alternative` | warning | `??` 체인 안에 없는 태스크·자기 참조·지원하지 않는 키·캡처되지 않은 출력처럼 절대 선택되지 않는 대안이 있음. |
| `args.array-joined` | warning | 배열 참조가 `args` 원소의 다른 글자와 섞여 한 argv로 합쳐짐. 여러 인자로 펼치려면 원소 전체를 참조 하나로 작성. |
| `quickpick.label-as-argument` | info | value mapping이 있는 QuickPick의 표시용 `${pick.label}`을 command/args에 전달함. 실행값은 `${pick}` 또는 `${pick.value}`를 쓰고, label 자체가 필요한 경우만 유지하도록 안내. |
| `quickpick.item-id-duplicate` | error | 한 QuickPick 안에서 안정 `id`가 중복됨. 선택 기억·History가 다른 mapping을 복원하지 않도록 각 항목에 고유한 id를 사용. |
| `quickpick.numeric-label-order` | info | label-keyed QuickPick 축약형에 정수형 label이 있음. JavaScript가 이 키를 다른 label보다 먼저 숫자 오름차순으로 배치하므로, 작성 순서를 유지하려면 배열형 `items`를 사용. |
| `output.not-captured` | warning | `passTheResultToNextTask: true`가 없는 shell/command의 output 또는 capture를 참조함. 대체 체인은 대안 단위 진단을 사용. |
| `tool.platform-missing` | warning | `zip`·`unzip`의 `tool`이 현재 플랫폼에서 비었거나 OS별 값이 없음. 검사하는 OS에 따라 결과가 달라짐. |
| `output.ignored` | warning | 런타임이 읽지 않는 `output` 필드가 있음. `mode`·`content`·`filePath`·`overwrite`·`language`는 `passTheResultToNextTask: true`가 필요하고, `filePath`·`overwrite`는 `mode: "file"`, `language`는 `mode: "editor"`에서만 사용됩니다. `capture`·`diagnostics`는 이 게이트 밖에서 동작하지만 태스크 결과에 문자열 `output`이 있어야 합니다. |
| `path.outside-workspace` | error | `writeFile` / `appendFile` / `output.filePath`의 해석 결과가 워크스페이스 밖. 런타임이 실행을 거부할 경로. (변수 치환 후에도 `${…}`가 남은 경우는 검사를 건너뜀 — 안전 결정 불가) |
| `secret.file-optin` | error | 민감한 실행 문맥 파생 값을 `allowSecretContent: true` 없이 파일로 저장하려 함(`writeFile` / `appendFile` / `output.mode: "file"`). 런타임이 실행 중에 거부하므로 실행 전에 알림. 오염은 런타임과 같은 규칙으로 전이됨 — 민감 입력을 참조한 태스크의 결과도 민감하다고 본다. |
| `secret.allow-unused` | warning | `allowSecretContent`가 켜져 있지만 허용하는 것이 없음(파일을 쓰지 않거나, 쓰더라도 민감 입력 파생 값이 아님). "여기서 비밀을 다룬다"는 잘못된 신호를 남기므로 지울 것. |
| `dependsOn.self` | error | task의 `dependsOn`에 자기 자신이 포함됨. |
| `dependsOn.missing` | error | `dependsOn`이 같은 액션에 존재하지 않는 task id를 가리킴. |
| `dependsOn.cycle` | error | task 간 `dependsOn` 그래프에 순환이 있음. 출력 메시지에 순환 경로 포함. |
| `parallel.interactive` | warning | `inputBox` / `quickPick` / `envPick` / `confirm` / `fileDialog` / `folderDialog` / `pathDialog` 같은 interactive task에 `parallel: true`가 붙음. 런타임은 prompt mutex로 다이얼로그를 강제 직렬화하므로 병렬 표시는 *post-prompt* 처리에만 적용되며, 사실상 효과가 없는 경우가 대부분. |
| `command.nested-interpreter` | warning | `command` 태스크가 `cmd /c`, `sh -c`, `powershell -Command`처럼 스크립트를 다시 해석하는 인터프리터를 호출하고 그 스크립트 자리에 `${…}` 값을 넣음. argv 인용은 중첩 인터프리터 앞에서 끝나므로 값을 직접 argv나 `env`로 전달해야 합니다. 안전한 고정 목록·엄격한 `validatePattern`·`--` 뒤 데이터 인자는 제한적으로 제외하지만, 명령·변수 대입·리다이렉션·스크립트 블록·옵션이 될 수 있는 자리는 보수적으로 경고합니다. |
| `command.dynamic-interpreter` | warning | `command` 태스크가 **실행 파일(또는 스크립트 스위치)을 보간값으로 정해**, 무엇이 실행될지 정적으로 알 수 없음. 그것이 셸(`sh -c` · `cmd /c` · `powershell -Command`)로 풀리면 같은 argv 의 다른 보간값이 스크립트 텍스트가 되어 문법으로 다시 읽힙니다 — `command.nested-interpreter` 가 잡는 것과 같은 위험인데, 인터프리터 이름이 참조라서 그 검사에 닿지 못하는 경우입니다. 고정 `quickPick` 처럼 값 집합을 열거할 수 있으면 열거해 실제로 판정하므로 이 경고 대신 `command.nested-interpreter` 가 붙습니다. |
| `doctor.analysis-failed` | error | 그 소스를 분석하는 도중 예외가 발생해 검사를 끝내지 못함. 소스마다 따로 분석하므로 **다른 소스의 진단은 그대로 게시**됩니다. 메시지에 예외 내용이 실립니다. |
| `shell.interpolated-command` | warning | `shell` 태스크의 command 문자열에 `${…}` 보간이 있음. `shell`은 문자열을 셸에 그대로 넘기므로 보간된 값도 셸 문법으로 해석되어, 값에 `;`나 `$(...)`가 있으면 의도하지 않은 명령이 실행됨. 값은 `args` 배열로 넘기거나 `command` 타입을 사용. OS별 객체는 어느 한 branch에만 있어도 검출. |

### 23.3. `dependsOn` / `parallel` 런타임 동작

`task.dependsOn`은 이제 런타임에서도 honored됩니다 — `parallel`과 함께 task graph를 구성해 DAG로 실행됩니다. 자세한 시맨틱은 [§24 병렬 실행 / Task DAG](#24-병렬-실행--task-dag) 참고. Doctor와 런타임은 **같은 `buildTaskGraph` + `detectGraphCycle`**을 공유하므로 cycle 검사는 단일 출처입니다 (`${taskId.x}` 자동 추론 의존성으로 만들어진 cycle도 양쪽에서 동일하게 잡힘). self/missing 검사는 doctor와 런타임이 각자의 사용자-facing 메시지를 제공하지만, 거부되는 입력은 같습니다.

### 23.4. 동작상 한계

- **메시지의 위치 정밀도**: AJV 에러는 JSON Pointer를 라인/컬럼으로 매핑하는 자체 워커(`src/doctor.ts` `locateJsonPointer`)가 처리합니다. 워커가 path를 따라가지 못하면 *가장 깊이 들어간 지점*으로 폴백하므로, 가끔 정확한 노드 대신 그 부모 라인이 표시될 수 있습니다. 그래도 점프 위치는 항상 해당 액션 내부.
- **`type: 'tool'` 경로 / `vscodeTask` label 매칭**은 현 범위에 없습니다. 두 기능 모두 actions 스키마에 아직 정식 진입하지 않았으며, 들어오는 시점에 Doctor 검사 항목으로 추가될 예정.
- **워크스페이스 외부 경로 검사는 실제 fs 접근 없이** path normalization만으로 판정합니다. 심볼릭 링크/`..` 트릭은 런타임 가드(`resolveWithinWorkspace`, [src/pipelineUtils.ts](../src/pipelineUtils.ts))가 최종적으로 막습니다.
- **중첩 인터프리터 검사가 보는 범위**는 argv 의 실행 파일과 `env`/`busybox` 래퍼까지입니다. `sudo sh -c …`, `xargs sh -c …`, 스크립트 파일 안에서 다시 셸을 부르는 형태처럼 **한 단계 더 들어가는 호출**은 정적으로 따라가지 않습니다. 대신 그런 명령을 **인자를 다시 코드로 읽는 명령**으로 취급해, 그 뒤에 오는 보간값에는 `validatePattern` 면제를 적용하지 않습니다.
- **한 소스의 분석이 실패해도 나머지는 게시**합니다. 실패한 소스에는 `doctor.analysis-failed` 진단이 붙습니다.

## 24. 병렬 실행 / Task DAG

한 액션 안의 task들을 의존성에 따라 병렬로 실행합니다. **기본은 여전히 순차** — `parallel: true`를 명시한 task만 동시 실행 풀에 들어갑니다. 기존 직렬 액션의 동작은 변하지 않습니다.

### 24.1. 시맨틱 한 줄 요약

```text
parallel false/omitted = 이전 *모든* task에 암묵 의존 (sync barrier)
parallel true          = explicit dependsOn + ${taskId.x} 자동 의존성만 기다림
```

`parallel: true`는 **detached가 아닙니다.** 뒤따르는 `parallel: false` task는 여전히 sync barrier로 동작해 그 task를 기다립니다. 진짜 fire-and-forget이 필요하면 별도 액션으로 분리하세요.

### 24.2. 예시

```json
{
  "id": "fw.matrix",
  "title": "Build all targets",
  "action": {
    "description": "stm32f4 / stm32f7 build를 병렬, 끝나면 합쳐서 패키지",
    "tasks": [
      { "id": "buildF4", "type": "shell", "command": "make TARGET=f4" },
      { "id": "buildF7", "type": "shell", "command": "make TARGET=f7", "parallel": true },
      {
        "id": "package",
        "type": "shell",
        "command": "scripts/pack.sh build/f4.bin build/f7.bin",
        "dependsOn": ["buildF4", "buildF7"]
      }
    ]
  }
}
```

- `buildF4`와 `buildF7`은 동시에 시작 (`buildF7`이 `parallel: true`라 직전 task의 barrier에서 빠짐).
- `package`는 `parallel`이 없으므로 두 빌드를 모두 기다림. `dependsOn`을 명시했지만, 이 패턴은 `parallel: false` 기본의 barrier 규칙으로도 자동으로 만족되므로 — 명시한 이유는 "이 task가 두 빌드의 산출물을 합친다"는 의도를 코드에서 읽히게 하기 위함.
- 한 빌드가 `continueOnError: true`였다면 실패해도 `package`까지 진행되며, 실패한 빌드의 결과는 `{}`로 전파.

> **출력 캡처가 필요할 때만**: shell task의 stdout을 `${buildF4.output}`처럼 다음 task 변수로 쓰려면 `passTheResultToNextTask: true`를 함께 두거나 `output.capture` 규칙으로 명시적으로 캡처해야 한다 ([`actions.json` Output Capture](actions.md#output-capture) 참조). 그렇게 캡처된 변수를 다음 task가 참조하면 *자동 추론된 의존성*이 잡혀 `dependsOn`을 생략해도 같은 순서가 강제된다.

### 24.3. 자동 의존성 추론

task의 string 필드(`command`, `args`, `env` 값, `cwd`, `output.filePath`, `output.content`, 인터랙티브 prompt 등)에 `${taskId.x}` 형태의 참조가 있으면 그 `taskId`는 자동으로 의존성으로 잡힙니다. 이렇게 해야:

- `parallel: true`를 붙였더라도 출력을 참조하는 task가 먼저 실행되는 사고를 막을 수 있고,
- `dependsOn`을 잊어도 정확한 순서가 유지됩니다.

`${workspaceFolder}` / `${file}` 같은 점 없는 reserved 참조는 같은 id의 task가 없을 때만 자동 추론에서 제외됩니다. 동명 task가 있으면 bare 참조도 그 task의 대표 결과를 뜻하고 의존성으로 잡힙니다. `${env:BAR}` / `${input:foo}` 같은 reserved prefix(`env:`, `input:`)는 항상 제외됩니다. `output.capture[].regex` / `output.diagnostics[].regex` 안의 `${…}` 리터럴도 정규식 패턴이지 변수 참조가 아니므로 제외됩니다. `forEach`의 `${each}`는 반복 본문에서만 지역값이며, 반복 소스와 task-level `when.var`에서는 동명 task 참조로 처리합니다.

> **현재 한계**: `${env:VAR}`는 0.7.32부터 실행 시작 시점의 환경값으로 치환됩니다. `${input:foo}`는
> action-level 입력을 위한 예약 이름이지만 아직 치환되지 않으므로 리터럴로 남습니다. task id를
> `env:` / `input:`로 시작하지 마세요.

### 24.4. 실패 정책

- **일반 실패** (`continueOnError: false`, 기본): 새 task 스케줄링을 멈추고, 이미 실행 중인 sibling은 완료까지 기다린 뒤 액션 실패로 처리. 단일 실패는 원본 Error 그대로 throw해서 기존 메시지/스택/`instanceof` 체크 호환성을 유지. 두 개 이상의 task가 동시에 실패하면 모든 cause를 묶어 `AggregateError`로 throw — 메시지는 `Action '<id>' had N task failures — taskA: ..., taskB: ...` 요약이며, 개별 cause는 `error.errors`에 보존되어 두 빌드 동시 실패 같은 사례에서 두 번째 cause가 묻히지 않습니다.
- **continueOnError 실패**: 결과를 `{}`로 저장하고 dependents 실행을 허용. 직렬 모드와 동일.
- **timeout**: task 단위로 그 task의 child process / 스트림 터미널만 종료. sibling은 영향 없음.
- **사용자 Stop**: 액션 전체를 죽이며, 해당 액션의 모든 task의 child process / 스트림 터미널을 정리.

### 24.5. 동시 실행 한도

`taskhub.pipeline.maxParallelTasks` 설정으로 한 액션 안에서 동시에 돌 수 있는 task 수를 제한합니다 — 기본 **4**, 범위 1~32. 임베디드 빌드의 linker / LTO 단계는 GB 단위의 RAM을 먹는 경우가 흔해서 코어 수 자동값(`os.cpus().length`)보다 보수적인 4로 시작합니다. 자원 여유가 있는 머신에서는 늘리고, 완전 순차 강제하려면 1로 설정하면 됩니다.

### 24.6. 출력 격리

액션 안에 `parallel: true` task가 하나라도 있으면 그 액션의 출력 채널을 task별로 분리합니다 — 두 빌드의 컴파일러 에러가 같은 터미널에 섞이지 않게 하기 위함:

- **streamed shell task**: VS Code Task terminal group이 `actionId:taskId` 단위로 갈라져 task마다 별도 터미널이 열림.
- **`output.mode: "terminal"`**: TaskHub 터미널 키가 `actionId:taskId`로 분리.
- **`spawn` 캡처 task**: 캡처 자체는 process별이라 섞일 일이 없음 — 별도 격리 불필요.

기존의 직렬 액션은 영향받지 않습니다 (`parallel: true` 없으면 출력이 한 터미널을 공유하던 기존 동작 유지).

### 24.7. Interactive task와 `parallel: true`

`inputBox` / `quickPick` / `envPick` / `confirm` / `fileDialog` / `folderDialog` / `pathDialog`에 `parallel: true`를 붙이면 Doctor가 `parallel.interactive` warning을 보고합니다. 런타임은 그 task의 실행을 거부하진 않고, 대신 **prompt mutex**로 다이얼로그를 강제 직렬화합니다 — 즉 modal 두 개가 동시에 뜨는 일은 없으며, 사실상 그 task의 "병렬" 부분은 post-prompt 처리(capture 등)에만 적용됩니다. 대부분의 경우 `parallel: true`를 빼는 게 의도와 가깝습니다.

### 24.8. 그래프 검증

액션 진입 시 `validateTaskGraph`가 다음 조건을 거부하고 액션을 즉시 실패시킵니다:

- `dependsOn`이 자기 자신을 가리킴 (self-dependency)
- `dependsOn`이 같은 액션에 없는 task id를 가리킴 (missing-dependency)
- explicit / inferred / barrier 의존성 union에 순환이 있음 (cycle)

Doctor는 같은 `buildTaskGraph` + `detectGraphCycle` 헬퍼를 공유하므로 cycle 거부 조건이 런타임과 정확히 일치합니다. self/missing은 Doctor가 별도 메시지(액션 id 접두사 포함)로 보고하지만 거부되는 입력 집합은 같습니다.

---


## 25. 파일/폴더 다이얼로그 위치 기억

TaskHub가 여는 다이얼로그는 같은 용도로 마지막에 사용한 디렉터리를 기억합니다. 구현은 [dialogMemory.ts](../src/dialogMemory.ts)에 있으며 `taskhub.dialog.rememberLastLocation` 설정으로 전체 동작을 끌 수 있습니다.

### 25.1. 시작 위치 결정 순서

1. 호출자나 액션의 `options.defaultUri`가 지정한 실제 존재 경로.
2. 같은 용도(scope)로 마지막에 선택한 디렉터리.
3. 현재 워크스페이스에서 가장 최근에 사용한 TaskHub 다이얼로그 위치.
4. 활성 에디터의 워크스페이스 폴더, 없으면 첫 워크스페이스 폴더.
5. 후보가 없으면 `defaultUri`를 전달하지 않고 VS Code 기본 동작에 맡김.

저장 다이얼로그는 호출자가 알고 있는 `defaultDir`을 3번보다 우선합니다. 기억된 경로가 사라졌다면 조용히 다음 후보로 내려갑니다.

### 25.2. 기억 단위 (scope)

- Hex Viewer, JSON Editor, Memory Map의 각 입력/저장 단계, 즐겨찾기, Import/Export, Preset은 서로 다른 scope를 사용합니다.
- `fileDialog`·`folderDialog`·`pathDialog` 태스크는 **액션 ID + 태스크 ID** 단위로 구분합니다.
- 파일 선택은 선택한 파일의 상위 디렉터리, 폴더 선택은 선택한 폴더 자체를 기억합니다.
- 취소한 다이얼로그는 위치를 갱신하지 않습니다.
- scope별 위치는 workspace와 global 상태에 저장해 같은 프로젝트를 우선하면서 새 프로젝트에서도 같은 용도의 마지막 위치를 사용할 수 있습니다.
- 저장 맵은 최대 100개이며 오래된 항목부터 정리합니다.

### 25.3. 직전 다이얼로그 위치 이어받기

같은 scope의 기록이 없으면 현재 워크스페이스에서 가장 최근에 사용한 TaskHub 다이얼로그 위치를 사용합니다. 이 값은 scope별 기억을 덮지 않으며 다른 VS Code 창으로 공유하지 않습니다. 따라서 한 액션에서 펌웨어 파일을 고른 뒤 처음 사용하는 출력 폴더 다이얼로그를 열어도 방금 사용한 디렉터리에서 이어갈 수 있습니다.

### 25.4. 끄기

`taskhub.dialog.rememberLastLocation`을 `false`로 두면 TaskHub는 위치를 읽거나 기록하지 않고 `defaultUri`도 지정하지 않습니다. 다만 액션이 명시한 `options.defaultUri`는 계속 존중합니다. 저장 다이얼로그는 VS Code API 제약상 `defaultUri`를 생략하면 제안 파일명도 함께 사라집니다.

자세한 설정 정보는 [§21 설정 레퍼런스](#21-설정-레퍼런스)를 참조하세요.
