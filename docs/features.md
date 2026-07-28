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

## 2. 사용자 지정 아이콘

활동 표시줄의 메인 뷰는 사용자 지정 'H' 모양의 SVG 아이콘(`media/h_icon.svg`)을 사용합니다.

## 3. JSON 설정 파일

이 확장 프로그램은 `actions.json`, `links.json`, 그리고 `favorites.json` 파일을 사용하여 뷰의 내용을 구성합니다.

*   **파일 로드 우선순위**:
    *   Actions 패널은 워크스페이스의 `.vscode/actions.json`, 선택한 프리셋, 확장에 번들된 예제(`media/actions.json`)를 병합하여 표시합니다. 자세한 규칙은 아래 [액션 소스와 병합 우선순위](#액션-소스와-병합-우선순위) 참조.
    *   링크 패널은 워크스페이스의 `.vscode/links.json`만 표시합니다.
    *   즐겨찾기 패널은 워크스페이스의 `.vscode/favorites.json`을 표시합니다.
    *   관련 JSON 파일이 수정, 생성 또는 삭제되면 해당 뷰는 자동으로 새로 고쳐집니다.

### 액션 소스와 병합 우선순위

Actions 패널의 목록은 세 종류의 소스를 병합해 만듭니다. 같은 `id`가 겹치면 **워크스페이스 > 프리셋 > 번들 예제** 순으로 우선합니다.

| 소스 | 위치 | 언제 보이나 |
| --- | --- | --- |
| 워크스페이스 액션 | 각 워크스페이스 폴더의 `.vscode/actions.json` | 항상 (멀티루트면 폴더별로 모두) |
| 프리셋 | 확장 `presets/` 또는 워크스페이스 `.vscode/presets/` | `taskhub.preset.selected`로 선택했을 때 ([§17](#17-preset-기능)) |
| 번들 예제 (`defaultButton.*`) | 확장의 `media/actions.json` | `taskhub.builtinActions` 설정에 따름 (기본 `auto`) |

**번들 예제의 `auto` 동작 (0.6.24 기준)**: 예제를 **액션 목록에 넣지 않습니다.** 대신 액션이 없을 때 뜨는 [빈 상태 안내](#빈-상태-안내와-제목-표시줄-구성-0615부터)가 *Browse Examples* 버튼으로 예제 접근을 제공합니다.

> 0.6.14의 `auto`는 "프로젝트가 비었을 때만 예제를 트리에 넣는다"였지만, 0.6.15에서 추가한 빈 상태 CTA와 충돌했습니다 — VS Code는 트리가 **완전히 비어야** welcome 뷰를 띄우므로, 예제가 주입되면 정작 CTA가 필요한 빈 프로젝트에서 CTA가 뜰 수 없었습니다. 0.6.24에서 CTA를 살리는 쪽으로 정리했습니다.

| 값 | 액션 목록에 예제 | 빈 상태 CTA의 *Browse Examples* |
| --- | --- | --- |
| `auto` (기본) | 넣지 않음 | 표시 |
| `always` | 넣음 (0.6.14 이전 동작) | — (목록이 비지 않으므로 CTA 자체가 없음) |
| `never` | 넣지 않음 | 숨김 |

- 예제가 목록에 없으면 id 충돌 검사 대상에서도 빠집니다 — 즉 자기 액션에 `defaultButton.showEnv` 같은 id를 써도 충돌로 막히지 않습니다.
- 예제 정의는 언제든 제목 표시줄 `…` 메뉴의 *Show Example JSON* 으로 볼 수 있습니다.

**교차 소스 id 중복은 오류가 아니라 경고입니다.** 같은 `id`가 두 소스에 있으면 위 우선순위로 조용히 해소되고, 어떤 소스가 가려졌는지는 TaskHub 출력 채널에만 기록됩니다. 액션은 사라지지 않지만 `taskhub.runAction.<id>` 커맨드와 History 조회는 **살아남은 쪽 하나**만 가리키므로, 의도한 액션이 아닐 수 있습니다. (같은 파일 *안*의 중복은 다릅니다 — 그건 로드 자체가 실패합니다.)

> **0.6.32**: [액션 생성 마법사](#8-액션-생성-마법사-create-action)가 이 목록 전체를 보게 됐습니다. 이전에는 대상 폴더의 파일과 번들 예제만 확인해, 선택된 프리셋이나 **다른 워크스페이스 폴더**와 같은 id를 만들어도 막지 못했고(위 경고만 남고 한쪽이 가려짐), 반대로 `builtinActions`가 숨긴 예제의 id는 쓸데없이 예약된 채였습니다. 이제 트리 목록과 마법사가 같은 판단 근거를 씁니다.

### JSON Editor 커맨드

Command Palette에서 `taskhub json`을 검색하면 두 개의 JSON Editor 커맨드가 표시됩니다. 용도가 다르므로 상황에 맞게 선택하세요.

| 커맨드 | 동작 | 사용 시점 |
| --- | --- | --- |
| **TaskHub: Open JSON Editor** (`taskhub.openJsonEditor`) | 파일 선택 대화상자를 띄워 임의의 JSON 파일을 고른 뒤 JSON Editor로 엽니다. 활성 에디터와 무관하게 항상 동일하게 동작합니다. | Command Palette에서 임의의 JSON 파일을 바로 열고 싶을 때 |
| **TaskHub: Open with JSON Editor** (`taskhub.openJsonEditorFromUri`) | URI 인자를 받는 컨텍스트 커맨드입니다. 에디터/탐색기/SCM 컨텍스트 메뉴의 *Open with JSON Editor* 항목에서 대상 파일을 전달받아 엽니다. Command Palette에서 인자 없이 실행하면 현재 활성 에디터가 `.json` 파일일 때 그 파일을 열고, 그 외에는 *Open JSON Editor* 동작으로 폴백해 파일 선택 대화상자를 띄웁니다. | `.json` 파일을 연 상태에서 빠르게 JSON Editor로 전환하거나, 탐색기/에디터 우클릭 메뉴에서 호출할 때 |

#### 데이터 보호

JSON Editor는 사용자 입력이 조용히 사라지거나 stale 상태로 디스크에 기록되는 시나리오를 다음 네 가지 메커니즘으로 막습니다.

- **Invalid 셀 저장 차단**: object/array를 JSON으로 직접 편집하는 셀에서 파싱이 실패하면 Save / Ctrl+S 가 진행되지 않습니다. 해당 셀은 편집 상태가 유지되고 에러 메시지가 표시되어, "잘못된 입력이 그대로 저장됐다"가 아니라 "사용자가 고치고 다시 저장"하는 흐름이 됩니다.
- **Undo / Redo (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`, 툴바 ↶ ↷)**: 셀 commit, 행 추가/삭제, 드래그 정렬, string ↔ array 변환, 태그 추가/삭제 단위로 메모리 스냅샷을 쌓습니다. 20 step / 16 MB 중 먼저 도달하는 cap 으로 가장 오래된 항목부터 정리. 셀 편집 중에는 단축키가 동작하지 않아 브라우저 input 의 기본 undo 가 우선합니다.
- **Dirty-close 복구**: 미저장 변경이 있는 상태로 패널을 닫아도 워크스페이스 상태에 wrapped data 스냅샷이 남습니다. 같은 파일을 다시 열 때 디스크 mtime + size fingerprint 가 캡처 시점과 일치하면 *복구하시겠습니까?* 다이얼로그가 뜨고, 외부에서 파일이 변경됐다면 (mtime 변경 또는 mtime 보존 + size 변경) 스냅샷은 자동 폐기됩니다. 자동 복원이 아닌 명시적 프롬프트 — 의도적으로 닫은 변경이 원치 않게 되살아나지 않습니다. mtime 과 size 가 모두 같은 채로 내용만 바뀌는 외부 변경(예: 같은 길이로 in-place 패치)은 감지하지 못한다는 한계가 있어, 외부 변경이 의심되면 사용자가 *다시 읽기* 로 명시적 동기화를 트리거하는 것이 안전합니다. **복구 대상은 parse 가능한 셀 단위 변경과 commit 된 mutation** 입니다 — object/array 셀을 JSON textarea 로 직접 편집하는 도중 mid-edit invalid JSON 상태에서 패널을 닫으면 그 raw text 자체는 보존되지 않고 (parse 실패라 snapshot 대상에서 제외됩니다), 대신 dirty 표시가 유지되어 외부 변경 *Reload/Keep* 모달이나 다른 파일 열기 시 *변경사항 버리기* confirm 으로 silent discard 만 차단합니다.
- **복구 스냅샷 보관 한도 (0.6.36부터)**: 스냅샷은 **최신 20개, 총 32MB** 까지만 보관합니다. 항목 하나가 파일 전체의 파싱 결과라 제한이 없으면 워크스페이스 상태가 무한히 자라기 때문입니다. 둘 중 먼저 걸리는 쪽이 적용되며, 넘으면 **가장 오래 전에 캡처된 스냅샷부터 조용히 사라집니다** — 별도 알림은 띄우지 않습니다. 따라서 미저장 변경이 있는 파일을 21개 이상 닫아 두었다면 가장 오래된 것의 복구 프롬프트가 뜨지 않을 수 있습니다. (총량을 넘는 큰 파일이라도 스냅샷 하나는 반드시 남습니다.) 수명 기준으로는 지우지 않으므로, 개수·총량 안에 있는 한 시간이 지나도 유지됩니다.
- **외부 변경 감지**: 파일이 외부(예: `git checkout`)에서 수정되면 감시자가 이를 감지합니다. dirty 가 아니면 자동으로 다시 읽고 상태바에 알리며, dirty 라면 *다시 읽기 / 현재 편집 유지* 모달을 띄워 사용자가 결정합니다. JSON Editor 자신이 막 쓴 변경은 mtime + size fingerprint 가 모두 일치할 때만 무시되므로, 외부 도구가 mtime 을 보존한 채 내용을 바꾸는 경우(`touch -r`, 일부 sync 도구) 도 외부 변경으로 처리됩니다.

#### 기타 단축키

- `Ctrl+S` (macOS `Cmd+S`): 저장. 편집 중 셀이 있으면 commit 을 시도하고 실패 시 저장을 중단합니다.
- `Ctrl+F` (macOS `Cmd+F`): VS Code 기본 찾기 위젯으로 현재 보이는 셀 값/헤더를 검색합니다.
- `Alt+↑` / `Alt+↓` (0.6.19부터): 행 순서 변경. 행 왼쪽의 `⠿` 그립에 포커스를 두고 누릅니다 (Tab으로 이동 가능). 이동 후 포커스는 옮겨진 행을 따라가므로 연속으로 누를 수 있고, 이동 결과는 스크린리더에 알림으로 전달됩니다. 마우스 드래그 방식도 그대로 동작합니다.

#### 지역화 / 접근성 (0.6.19부터)

- 웹뷰 안의 모든 문자열이 VS Code 언어 설정을 따릅니다 (한국어 / 영어). 이전에는 `Save`, `Reload`, `+ Row` 등이 영어로 고정돼 있었습니다. 문자열은 확장 호스트가 로케일을 해석해 번들로 주입하며, `<html lang>` 속성도 함께 맞춰집니다.
- 아이콘만 있는 버튼(↶ ↷ ✕ ⠿ a→s s→a)에 `aria-label`이 붙습니다. 삭제·이동 버튼의 라벨에는 행 번호가 포함됩니다 (예: *3번 행 삭제*).
- 수정 표시는 `role="status"`, 오류 메시지는 `role="alert"` live region으로 노출되고, 행 이동 같은 변화는 전용 알림 영역으로 전달됩니다. 아이콘 전용 열 머리글에는 화면에 보이지 않는 이름(순서 변경 / 행 번호 / 작업)이 들어갑니다.
- **셀 편집 진입 (0.6.31부터)**: 셀에 Tab으로 이동해 `Enter` 또는 `Space`로 편집을 시작할 수 있습니다. 이전에는 클릭 전용이라 키보드만으로는 값을 고칠 수 없었습니다 — 표를 읽을 수는 있으나 편집기로는 쓸 수 없는 상태였습니다.
- **시트 탭 (0.6.31부터)**: `Tab`으로 탭 줄에 진입하고 `←` / `→`로 이동합니다(양끝에서 순환). 0.6.19는 모든 탭을 Tab 순서에 넣었는데, 이는 스크린리더가 `role="tab"`을 보고 안내하는 조작법(화살표 이동)과 어긋났습니다. 탭과 표 영역이 `aria-controls` / `role="tabpanel"`로 서로를 가리키므로 어느 시트를 보고 있는지도 전달됩니다.

## 4. 링크 패널 (Workspace Links)

*   **워크스페이스 링크 (`mainView.linkWorkspace`)**: 워크스페이스의 `.vscode/links.json`에 정의된 링크를 표시합니다. 제목에는 링크의 총 개수가 표시됩니다 (예: "Workspace Links (5)").

**주요 기능:**
*   **링크 클릭**: 링크 항목을 클릭하면 기본 브라우저에서 URL이 열립니다.
*   **인라인 액션**: 각 링크 항목에 마우스를 올리면 다음 인라인 아이콘들이 표시됩니다:
    *   복사 아이콘: URL을 클립보드에 복사
    *   브라우저 아이콘: 브라우저에서 열기
    *   연필 아이콘: 링크 편집
    *   휴지통 아이콘: 링크 삭제
*   **링크 추가 / 편집**: 뷰 상단의 + 버튼은 *URL → 제목(URL의 host로 자동 채워짐, Enter로 그대로 사용) → 저장* (2 prompt). URL prompt 는 `validateLinkUrlForSave` 게이트를 거치며 ① scheme allowlist (http / https / mailto 만 허용 — `javascript:` / `file:` / `vscode:` 같은 schemes 는 입력 단계에서 빨간 줄로 차단), ② WHATWG `new URL()` parse (스킴만 붙은 `https://` 같은 입력도 입력 단계에서 차단)를 한 번에 적용합니다. 같은 게이트가 워크스페이스 링크 *편집* prompt 에도 적용되어 Add 와 Edit 의 검증이 대칭입니다. 그룹/태그는 묻지 않으며, 저장 직후 알림의 *links.json 열기* 버튼으로 곧장 편집기에 점프해 다듬을 수 있습니다. `links.json`이 파싱 실패면 마법사가 저장을 거부하고 *links.json 열기* 버튼이 달린 에러 알림으로 회복 경로를 제공합니다 (이전 버전은 깨진 파일을 신규 1개 항목으로 덮어써서 기존 데이터가 유실됐습니다). WHATWG parse 의 한계상 `https:///path` 같은 입력은 슬래시가 정규화되어 `https://path/` (host = `path`) 로 조용히 해석되며 게이트는 통과합니다 — 사용자 의도와 다르게 host 가 바뀐 상태로 저장될 수 있어, click 시점의 `vscode.Uri.parse` 가 최종 fail-safe 입니다.
*   **검색**: 돋보기 아이콘을 클릭하여 링크를 빠르게 검색할 수 있습니다.
*   **파일 편집**: 연필 버튼을 클릭하여 `links.json` 파일을 직접 편집할 수 있습니다.

## 5. Actions 패널 (`mainView.main`)

이 패널은 워크스페이스의 `.vscode/actions.json`(그리고 선택한 프리셋 / 조건에 따라 번들 예제 — [§3 액션 소스와 병합 우선순위](#액션-소스와-병합-우선순위) 참조)에 정의된 다양한 구성 가능한 액션을 제공합니다. 새로운 스키마는 '태스크(Task)'라는 통일된 개념을 중심으로 설계되어, 간단한 명령어부터 여러 단계를 거치는 복잡한 파이프라인까지 일관된 방식으로 정의할 수 있습니다.

> 마지막 실행 시각·소요 시간 같은 회고 정보는 [§14 액션 실행 히스토리](#14-액션-실행-히스토리)에서 확인합니다 — Actions 패널은 "지금 무엇을 실행할지"에만 집중합니다.

### 빈 상태 안내와 제목 표시줄 구성 (0.6.15부터)

표시할 액션이 없으면 패널이 비어 보이는 대신 VS Code의 welcome 뷰로 다음 단계를 제안합니다. Workspace Links / Favorite Files 패널도 동일합니다.

| 상황 | 안내 |
| --- | --- |
| 폴더를 열지 않음 | *Open Folder* — TaskHub는 프로젝트 단위로 동작하므로 폴더가 먼저 필요합니다. |
| 폴더는 열렸고 액션이 없음 | *Create Action* / *Browse Examples* / *Import Actions…* |
| Links / Favorites가 비어 있음 | 각각 *Add Link* / *Add File to Favorites* |

- **`actions.json`이 깨진 경우는 빈 상태가 아닙니다.** 파싱/스키마 오류가 나면 "액션을 불러오지 못했습니다" 행이 실패 이유와 함께 표시되고, 클릭하면 **실제로 실패한 파일**이 열립니다 (0.6.24부터 — 이전에는 워크스페이스 폴더를 다시 묻는 명령이라 멀티루트에서 멀쩡한 파일을 열 수 있었습니다). 소스 간 중복 id처럼 특정 파일로 좁힐 수 없는 오류는 폴더 선택 경로로 폴백합니다. 액션 200개짜리 파일을 가진 사용자에게 "첫 액션을 만드세요"라고 안내하지 않기 위한 구분입니다.
- **확장 버전은 트리 행이 아니라 뷰 제목 옆**(`Actions 0.6.15`)에 표시됩니다. 예전에는 목록 첫 줄을 상시 차지했고, 그 때문에 트리가 절대 비지 않아 빈 상태 안내 자체가 뜰 수 없었습니다. CHANGELOG는 제목 표시줄 `…` 메뉴에서 엽니다.
- **제목 표시줄 아이콘은 3개**입니다: *Create Action*, *Edit actions.json*, 그리고 실행 중일 때만 나타나는 *Stop All Actions*([§11](#11-작업-종료)). 예제 보기 / Import / Export / 터미널 닫기 / Changelog는 `…` 오버플로 메뉴로 옮겼습니다.

### 멀티 task 액션의 진행 표시

여러 task로 구성된 액션이 실행 중일 때, 액션 라벨 옆에 현재 진행 중인 task가 표시됩니다.

- 형식: `2/3 · link` — 전체 3개 task 중 2번째 task `link`가 현재 실행 중.
- `taskhub.showTaskStatus: false`면 상태 아이콘과 함께 이 진행 표시도 나오지 않습니다. 다만 **가려지는 것은 겉모습뿐**이라, 실행 중인 액션의 인라인 *중지* 버튼과 제목 표시줄의 *Stop All Actions* 는 그대로 동작합니다 (0.6.16부터 — 이전에는 트리가 다시 그려질 때마다 꺼 둔 아이콘이 되살아났습니다).
- 단일 task 액션은 진행 표시를 노출하지 않습니다 (`1/1`은 노이즈).
- 액션이 종료되면(`success`/`failure`/manual stop) 진행 표시는 자동으로 사라지고, 상태 아이콘(✓/✗)만 남습니다.
- `continueOnError: true`로 스킵된 task는 인덱스만 진행되며 별도 표시는 없습니다 — task 완료/실패 자체는 History 패널에서 회고 가능합니다.

### 액션에 단축키 할당

`id`가 지정된 모든 액션은 자동으로 `taskhub.runAction.<id>` VS Code 커맨드로 노출됩니다. 따라서 사용자는 키바인딩으로 직접 액션을 실행할 수 있습니다.

- **권장 사용법**: Actions 패널에서 액션을 우클릭 → **Assign Shortcut** → VS Code의 Keyboard Shortcuts UI가 해당 액션의 커맨드 ID로 미리 필터링되어 열립니다. 사용자는 거기서 평소처럼 키를 입력해 등록합니다.
- 확장이 사용자 `keybindings.json`을 직접 수정하지 않으므로, 키 충돌·`when` 절·플랫폼별 키 차이는 모두 VS Code 기본 UI에서 다룰 수 있습니다.
- `actions.json`이 변경되면 추가/삭제된 액션에 맞춰 동적 커맨드도 즉시 동기화됩니다 (`syncActionCommands`). 액션이 사라져도 사용자가 등록한 키바인딩 항목은 `keybindings.json`에 남지만, 해당 커맨드가 없으면 VS Code가 조용히 무시하므로 무해합니다.
- `id`가 없는 폴더·구분선·액션은 등록 대상이 아닙니다.
- 커맨드 ID 도출은 단일 함수(`buildActionCommandId`)에 있으며 **bijective percent-encoding**을 사용합니다. `[A-Za-z0-9_.-]` 문자는 그대로 유지되어 일반적인 ID(`fw.build`, `defaultButton.showEnv`)는 keybindings.json에서 자연스럽게 보입니다. 그 외 문자(공백, `/`, `:`, 한글 등)는 UTF-8 바이트별로 `%HH`로 인코딩되므로 distinct ID가 distinct 커맨드 ID로 매핑되어 collision이 구조적으로 발생하지 않습니다.

### Quick Action Palette (`TaskHub: Run Any Action…`)

액션마다 단축키를 등록하지 않고도 **단일 커맨드 + 두세 글자**로 어떤 액션이든 실행할 수 있습니다. Command Palette(`Cmd/Ctrl+Shift+P`)에서 `TaskHub: Run Any Action…`을 호출하거나, `taskhub.runAnyAction` 한 명령에만 키바인딩을 걸어 두면 됩니다.

- **모든 runnable 액션이 한 리스트로 평면화**: 폴더·구분선은 노출되지 않습니다. 검색 시 `matchOnDescription`으로 폴더 breadcrumb(예: `Firmware`)도 매칭 면에 포함되어, `fw build` 처럼 부모 폴더 + 액션명 조합으로도 좁혀집니다.
- **최근 실행 액션이 위 섹션 (`Recently used`) 에 표시**: 목록은 **[§14 히스토리](#14-액션-실행-히스토리)에서 유도**됩니다 (0.6.12부터). 팔레트로 고른 실행뿐 아니라 왼쪽 트리 클릭, 키바인딩(`taskhub.runAction.<id>`), History 재실행이 모두 같은 순서에 반영되며, 같은 액션의 반복 실행은 가장 최근 기록 하나로 접힙니다. 히스토리는 워크스페이스 단위로 저장되므로 다른 프로젝트의 액션 ID가 섞이지 않습니다. 표시 개수는 `taskhub.runAnyAction.recentLimit` 설정으로 제어 (기본 5, 범위 0–20, `0`이면 섹션 비활성). 자세한 옵션은 §21 참조.
    - 히스토리 보관량(`taskhub.history.maxItems`, 기본 10)이 상한으로 작용합니다 — 그보다 큰 `recentLimit`을 지정하면 보관된 기록만큼만 표시됩니다.
    - 최근 행에는 **마지막 실행 정보**가 둘째 줄로 붙습니다: `14:30 · 1.2s`, 실패였다면 `실패 · 14:30 · 1.2s`, 아직 실행 중이면 `실행 중`. 폴더 breadcrumb은 검색 대상(`matchOnDescription`)으로 남겨 두기 위해 첫째 줄에 그대로 유지됩니다.
    - Memory Map / Hex / JSON Editor 열람 기록은 실행 가능한 액션이 아니므로 최근 섹션에 섞이지 않습니다.
- **stale 항목은 표시 시점에 필터링**: 액션이 삭제되었거나 폴더 ID 가 우연히 기록에 들어 있어도, 매번 팔레트가 열릴 때 현재 액션 트리에 존재하는 runnable ID 만 추려서 노출합니다 — "더 이상 존재하지 않는 항목을 선택하는 경로" 자체를 차단합니다.
- 키 한 방으로 액션 하나를 직접 실행하고 싶다면 위 "액션에 단축키 할당" 절의 `taskhub.runAction.<id>` 동적 커맨드를 사용하세요. 두 경로는 같은 실행 인프라를 공유합니다.

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
        -   Windows 환경에서 `PATH`상에 `.exe`/`.com`로 존재하는 실제 실행 파일(`node`, `git`, `cmd`, `powershell` 등)은 셸 없이 직접 실행하여 인자(특히 `"` 가 포함된 인자)가 그대로 전달되도록 합니다. `echo`·`dir` 같은 셸 빌트인, `.cmd`/`.bat`/`.ps1`/`.js` 스크립트, `npm`/`npx`/`pnpm`/`yarn` 같은 `.cmd` shim은 `PowerShell`을 거쳐 실행됩니다(유니코드 출력 보존 포함). 캡처 모드(`passTheResultToNextTask: true`)에서는 직접 실행이 실패하면 한 번 더 PowerShell 경로로 재시도하는 안전망이 있습니다.
        -   이 모드에서는 출력을 캡처하지 않으므로, **다음 태스크에서 이 태스크의 결과를 변수로 사용할 수 없습니다.**
    -   **`true` - 캡처 모드 (Capture Mode):**
        -   명령어의 출력이 터미널에 표시되지 않고, 내부적으로 **캡처**됩니다.
        -   캡처된 결과는 파이프라인의 다음 태스크에서 `${task_id.output}` 형태로 사용할 수 있습니다.
        -   캡처된 결과는 `output` 블록을 통해 파일이나 에디터로 보내는 등 추가적인 처리가 가능합니다.
        -   **메모리 보호를 위한 캡처 한도**: 캡처 모드에서 누적되는 stdout/stderr의 총 크기가 `taskhub.pipeline.outputCaptureLimitMb` (기본값 10MB, 범위 1~1024MB)를 초과하면 프로세스를 종료하고 명확한 에러(`Captured output exceeded the N MB limit ...`)를 반환합니다. 의도적으로 큰 로그를 생성하는 파이프라인이라면 설정을 높이거나 커맨드에서 `> file`로 리다이렉션해 캡처를 우회하세요.
        -   **액션 전체 합계 한도 (0.6.43부터)**: 위 설정은 **태스크 하나**를 막습니다. 태스크 결과는 뒤 태스크가 `${앞태스크.stdout}` 을 참조할 수 있어야 하므로 액션이 끝날 때까지 메모리에 남는데, 그 **합계**에는 제한이 없었습니다 — 기본값(10MB)에서는 태스크가 수십 개여야 문제가 되지만, 로그가 잘려서 태스크 상한을 1024MB 로 올린 환경에서는 태스크 서넛만으로 GB 단위가 됩니다. `taskhub.pipeline.totalOutputLimitMb` (기본값 32MB, 범위 1~4096MB)가 합계를 막고, 초과하면 액션이 실패합니다.
            -   **태스크 상한보다 작아지지 않습니다.** "이 태스크 출력 100MB 를 받겠다"고 설정해 놓고 총량이 32MB 라 곧바로 실패하면 두 설정이 서로를 부정하는 꼴이므로, 실효 총량은 둘 중 큰 값입니다.
    -   참고: `revealTerminal` 속성은 스트림 모드(`passTheResultToNextTask: false`)에서만 적용됩니다. 캡처 모드에서는 터미널이 열리지 않습니다.

-   **`output`** (`object`, *선택*): 캡처된 결과를 어떻게 처리할지 정의합니다. `mode` 사용은 캡처 모드(`passTheResultToNextTask: true`)에서만 동작하지만, `capture` 규칙만 쓸 때는 `mode`를 생략할 수 있습니다.
    -   `"mode": "editor"`: 새 에디터 탭에 결과를 표시합니다.
    -   `"mode": "file"`: 지정된 파일에 결과를 저장합니다. (`filePath`, `overwrite` 속성 사용)
        -   `overwrite` (boolean | string, *선택*, 기본값: `false`): `true`로 설정하면 기존 파일을 덮어씁니다. `false`이거나 생략하면 파일이 이미 존재할 때 실행이 실패합니다. 문자열로 지정하면 변수 치환(예: `"${someVar}"`)을 사용할 수 있으며, 치환된 값이 `"true"`(대소문자 무시)이면 덮어쓰기가 활성화됩니다.
    -   `"mode": "terminal"`: 액션 ID별로 재사용되는 **읽기 전용 터미널**(`TaskHub: <액션 ID>`)에 결과를 표시합니다. 셸이 없는 출력 전용 터미널이므로 결과 본문이 명령으로 실행되지 않습니다.
    -   `"capture"` (object | array, *선택*): 태스크 출력 문자열에서 **원하는 값만 뽑아 파생 변수**를 만듭니다. 자세한 내용은 아래 [Output Capture](#output-capture) 섹션 참고.
    -   `"diagnostics"` (object | string | array, *선택*): 출력에서 컴파일러 에러·경고를 정규식으로 추출해 VS Code **Problems 패널에 진단**으로 표시. 자세한 내용은 아래 [Output Diagnostics](#output-diagnostics-problems-패널-통합) 섹션 참고.

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

#### Output Diagnostics (Problems 패널 통합)

`shell`/`command`/`stringManipulation` 태스크의 출력 문자열에서 컴파일러 에러·경고를 정규식으로 추출해 **VS Code Problems 패널**에 진단(Diagnostic)으로 표시합니다. 사용자는 Problems 항목을 클릭해 해당 파일·라인·칼럼으로 즉시 점프할 수 있고, 에디터에 빨간 squiggly가 자동으로 그려지며, F8 키로 다음 에러로 순환 가능합니다.

**동작 조건** (capture와 동일)
- `shell`/`command`: `passTheResultToNextTask: true` 필요. 스트림 모드(`false`)에서는 silent skip (verbose 로그에 경고).
- `stringManipulation`: 항상 문자열 반환이므로 가능.

**라이프사이클**
- 진단은 액션별로 별도 `DiagnosticCollection`(`taskhub:<actionId>`)으로 관리되어, 같은 액션을 재실행하면 **이전 진단이 자동으로 clear**된 뒤 새 진단으로 교체됩니다 (다른 액션 진단은 영향 없음).
- 매처가 매칭하지 못한 라인은 무시. 액션 종료 후에도 진단은 그대로 남아 사용자가 해결할 때까지 보입니다.
- 상대 경로(`src/main.c`)는 task의 `cwd` 기준으로 해석.

**프리셋 사용 예시 (`$gcc`)**

```json
{
  "id": "build",
  "type": "shell",
  "command": "make all",
  "passTheResultToNextTask": true,
  "output": { "diagnostics": "$gcc" }
}
```

`$gcc`는 `path:line:col: severity: message` 형태의 gcc / clang / arm-none-eabi-gcc 출력을 매칭. `severity`는 `error`/`warning`/`note`/`fatal error`를 자동 normalize.

**커스텀 패턴 예시 (특수 toolchain)**

```json
{
  "output": {
    "diagnostics": {
      "pattern": "^(.+?)\\((\\d+)\\):\\s*(error|warning):\\s*(.+)$",
      "file": 1,
      "line": 2,
      "severity": 3,
      "message": 4,
      "defaultSeverity": "error",
      "source": "keil"
    }
  }
}
```

여러 매처를 한 task에 결합 (예: 빌드 출력과 lint 출력이 섞인 경우):

```json
{
  "output": {
    "diagnostics": [
      "$gcc",
      { "pattern": "^lint: (.+?):(\\d+): (.+)$", "file": 1, "line": 2, "message": 3, "defaultSeverity": "warning", "source": "lint" }
    ]
  }
}
```

**필드**

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `pattern` | `string` (**필수**) | 출력의 각 라인에 매칭할 정규식. `g` 플래그는 자동 제거되므로 사용 불필요. |
| `flags` | `string` | 정규식 플래그 (예: `"i"`). |
| `file` | `integer` (**필수**) | 파일 경로의 1-based 캡처 그룹 인덱스. |
| `line` | `integer` (**필수**) | 라인 번호의 1-based 캡처 그룹 인덱스 (라인 번호 자체는 1-based로 해석). |
| `column` | `integer` | 칼럼 번호의 캡처 그룹. 선택. |
| `endLine` / `endColumn` | `integer` | 다중 캐릭터 범위의 끝 위치. 선택. |
| `severity` | `integer` | 심각도 텍스트(`error`/`warning`/`note`/...)의 캡처 그룹. 선택. |
| `message` | `integer` (**필수**) | 메시지 텍스트의 캡처 그룹. |
| `defaultSeverity` | `"error"`/`"warning"`/`"info"`/`"hint"` | severity 그룹이 누락되거나 인식 안 될 때 사용. 기본값 `"error"`. |
| `source` | `string` | Problems 패널에 표시될 출처 라벨. 기본값 `"taskhub:<task_id>"`. |

**내장 프리셋**

| 프리셋 | 매칭 형식 | 대표 도구 |
| --- | --- | --- |
| `$gcc` | `path:line:col: severity: message` | gcc, clang, arm-none-eabi-gcc, 기타 GNU 호환 |
| `$tsc` | `path(line,col): severity TS####: message` | TypeScript Compiler |

**실패 정책**
- 매칭되지 않으면 조용히 skip — task의 다른 출력 라인은 정상 진행.
- 설정 오류(잘못된 정규식, 알 수 없는 프리셋 `$foo`, 누락된 `file`/`line`/`message` 필드)는 **즉시 에러**로 실행 중단 — 사용자가 첫 실행에서 발견하도록.

#### Preview Run (Dry-run)

액션을 **실행하지 않고** 파이프라인이 어떻게 해석되는지 미리 보는 기능입니다. Actions 패널에서 해당 액션을 우클릭하고 **Preview Run (Dry-run)** 을 선택합니다. (컨텍스트 전용 명령이며 Command Palette에는 노출되지 않습니다.)

결과는 `TaskHub Preview` 출력 채널에 표시되며 다음을 포함합니다:

- 각 태스크의 해석된 `command` / `args` / `cwd` / `env`
- `parallel: true` 태스크 헤더의 `[parallel]` 마커
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

### `fileDialog` 태스크

사용자에게 파일 선택 대화상자(`vscode.window.showOpenDialog`)를 표시하고 선택된 파일 경로의 구성 요소를 다음 태스크가 참조할 수 있는 키로 노출합니다. 사용자가 대화상자를 취소하면 태스크가 `File selection was canceled.` 오류로 실패하며, 파이프라인은 중단됩니다(취소를 허용하려면 task에 `continueOnError: true`).

- `type` (string, **필수**): `fileDialog`로 설정해야 합니다.
- `options` (object, *선택*): VS Code의 [`OpenDialogOptions`](https://code.visualstudio.com/api/references/vscode-api#OpenDialogOptions)가 그대로 전달됩니다. 별도로 덮어쓰지 않으므로 사용자가 제공한 값이 기본 동작을 결정합니다. 자주 쓰는 키:
    - `openLabel` (string): "Open" 버튼 라벨 (예: `"Select firmware ELF"`).
    - `title` (string): 다이얼로그 제목.
    - `defaultUri` (string, URI 형식): 다이얼로그가 처음 열릴 위치.
    - `filters` (object): 확장자 필터 (예: `{ "Firmware": ["elf", "bin", "hex"] }`).
    - `canSelectMany` (boolean, 기본 false): 다중 선택 허용. **주의**: 현재 첫 번째 선택값만 task 결과로 노출되므로 다중 선택은 권장하지 않습니다.
    - `canSelectFiles` / `canSelectFolders` (boolean): 기본값(파일만 선택 가능) 그대로 두면 됩니다. 폴더 전용 다이얼로그가 필요하면 `fileDialog` 대신 `folderDialog`를 사용하세요.
- **실행 결과**: 선택된 파일 경로를 분해해 다음 태스크가 참조할 수 있도록 합니다.
    - `${task_id.path}` — 절대 경로 (예: `C:/proj/build/app.elf`)
    - `${task_id.dir}` — 부모 디렉터리 (예: `C:/proj/build`)
    - `${task_id.name}` — 파일명(확장자 포함, 예: `app.elf`)
    - `${task_id.fileNameOnly}` — 확장자를 제외한 파일명 (예: `app`)
    - `${task_id.fileExt}` — 확장자(앞의 `.` 제외, 예: `elf`)

### `folderDialog` 태스크

사용자에게 폴더 선택 대화상자를 표시합니다. 내부적으로 `vscode.window.showOpenDialog`를 호출하면서 `canSelectFiles=false`, `canSelectFolders=true`를 강제로 적용하므로, `options`에 다른 값을 지정해도 폴더 선택 모드는 항상 유지됩니다. 사용자가 대화상자를 취소하면 `Folder selection was canceled.` 오류로 실패합니다(`continueOnError: true`로 무시 가능).

- `type` (string, **필수**): `folderDialog`로 설정해야 합니다.
- `options` (object, *선택*): `OpenDialogOptions`와 동일하지만 `canSelectFiles` / `canSelectFolders`는 위와 같이 강제됩니다. 그 외 `openLabel`, `title`, `defaultUri`는 그대로 적용됩니다.
- **실행 결과**: `fileDialog`와 동일한 키 셋(`path` / `dir` / `name` / `fileNameOnly` / `fileExt`)을 제공합니다. 단, 폴더에는 확장자가 없는 것이 일반적이므로 보통 `fileNameOnly === name`이고 `fileExt`는 빈 문자열입니다.
    - 예: 사용자가 `C:/proj/build`를 선택한 경우 — `path=C:/proj/build`, `dir=C:/proj`, `name=build`, `fileNameOnly=build`, `fileExt=""` (빈 문자열).
    - 폴더 이름에 `.`이 포함된 경우(예: `release.v1`)는 `node:path`의 `extname` 규칙을 그대로 따라 `fileNameOnly=release`, `fileExt=v1`이 됩니다 — 보통 의도하지 않은 결과이므로 폴더에서는 `${task_id.path}` 또는 `${task_id.name}`을 사용하는 것이 안전합니다.

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
-   `validatePattern` (string, *선택*): 입력값이 만족해야 하는 정규식(RegExp source)입니다. 입력 도중 형식이 맞지 않으면 실시간으로 거부되고 `validateMessage`(없으면 기본 문구)가 표시됩니다. 잘못된 정규식은 무시됩니다(검증 미적용). 예: Jira 티켓 키 `^[A-Z][A-Z0-9]+-\\d+$`.
-   `validateMessage` (string, *선택*): `validatePattern` 검증 실패 시 표시할 메시지입니다. 생략 시 기본 문구를 사용합니다.
-   `extractPattern` (string, *선택*): 보간된 `value`에 적용해 기본값을 추출하는 정규식입니다. 캡처 그룹 1이 있으면 그 값을, 없으면 전체 매치를 사용합니다. 매치가 없으면 빈 값으로 두어 사용자가 새로 입력하게 합니다. `prefix`/`suffix`는 최종 입력값에 그대로 적용됩니다. 예: 브랜치 이름 `feature/ABCTEST-123-foo`에서 Jira 키 추출 `[A-Z][A-Z0-9]+-\\d+`.
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
-   `items` (array, **조건부 필수**): 선택 가능한 항목 목록입니다. 문자열 배열 또는 객체 배열을 사용할 수 있습니다. `itemsFromCommand`를 지정하면 생략 가능하며, 이때 `items`는 무시됩니다.
    -   문자열 배열: `["dev", "staging", "production"]`
    -   객체 배열: `[{"label": "dev", "description": "개발 환경", "detail": "상세 설명"}]`
-   `itemsFromCommand` (string | OS별 객체, *선택*): stdout 출력을 선택 목록으로 채우는 셸 명령입니다. 각 비어 있지 않은 줄(trim 후)이 하나의 항목이 됩니다. `cwd`(없으면 워크스페이스 폴더)에서 로그인 셸로 실행되며, 변수 보간과 `command`와 동일한 OS별 객체 형태를 지원합니다. 지정 시 `items`는 무시됩니다(정적 `items`로 폴백하지 않습니다). OS별 객체를 줄 경우 `command`와 동일하게 **현재 플랫폼 branch가 없으면 오류**가 나므로 실행할 플랫폼을 모두 정의하세요. 예: `git for-each-ref --format='%(refname:short)' refs/remotes/origin`으로 origin 브랜치 목록 채우기.
-   `itemsExclude` (string | string[], *선택*): `itemsFromCommand` 출력에서 제외할 정확한 줄(예: `origin/HEAD`). `itemsFromCommand`가 없으면 무시됩니다.
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

**예시 4: origin 브랜치 + Jira 티켓으로 CI 실행**

`itemsFromCommand`로 origin 브랜치를 동적으로 채우고, 선택한 브랜치에서 Jira 키를 자동 추출해 입력값 기본으로 채운 뒤, 두 값을 CI 스크립트 파라미터로 넘기는 흐름입니다.

```json
{
  "tasks": [
    {
      "id": "fetch",
      "type": "shell",
      "command": "git fetch --prune"
    },
    {
      "id": "pick_branch",
      "type": "quickPick",
      "placeHolder": "CI에서 테스트할 origin 브랜치 선택",
      "itemsFromCommand": "git for-each-ref --format='%(refname:short)' refs/remotes/origin --sort=-committerdate",
      "itemsExclude": ["origin", "origin/HEAD"]
    },
    {
      "id": "pick_ticket",
      "type": "inputBox",
      "prompt": "Jira 티켓 번호",
      "placeHolder": "예: ABCTEST-123",
      "value": "${pick_branch.value}",
      "extractPattern": "[A-Z][A-Z0-9]+-\\d+",
      "validatePattern": "^[A-Z][A-Z0-9]+-\\d+$",
      "validateMessage": "형식: 프로젝트키-숫자 (예: ABCTEST-123)"
    },
    {
      "id": "run_ci",
      "type": "shell",
      "command": "./trigger-ci.sh",
      "args": ["--branch", "${pick_branch.value}", "--ticket", "${pick_ticket.value}"]
    }
  ]
}
```

`pick_branch.value`가 `origin/feature/ABCTEST-123-foo`이면 `pick_ticket`의 기본값은 `ABCTEST-123`으로 채워져 엔터만 누르면 됩니다.

> **참고 (symbolic HEAD)**: `git for-each-ref ... %(refname:short)`는 `refs/remotes/origin/HEAD`를 `origin/HEAD`가 아니라 **`origin`** 으로 축약해 출력합니다. 그래서 `itemsExclude`에는 `origin`과 `origin/HEAD`를 함께 넣어야 가짜 브랜치 `origin`이 목록에 남지 않습니다. (또는 명령 단에서 symbolic ref를 걸러도 됩니다.)

> **보안 (값 전달은 `args`로)**: 원격 브랜치 이름은 완전히 신뢰할 수 없고 셸 메타문자가 포함될 수 있습니다. 선택한 값을 `command` 문자열에 직접 끼워 넣으면 명령 주입 표면이 되므로, 위 예시처럼 `command`(실행 파일)와 `args`(인자 배열)를 분리해 전달하세요. TaskHub는 `args` 각 항목을 OS별 규칙으로 quoting합니다. 같은 이유로 `${pick_ticket.value}` 같은 사용자 입력값도 `args`로 넘기는 것이 안전합니다.

**예시 5: 로컬 브랜치 + Jira 티켓 (origin 불필요)**

원격(origin) 존재 여부를 확인하지 않고 **로컬 브랜치**만 고르고 싶다면 `refs/remotes/origin` 대신 `refs/heads`를 사용합니다. 로컬 브랜치는 `%(refname:short)`가 `origin/` 접두사 없이 `main`·`feature/ABCTEST-123-foo`처럼 출력하므로 `itemsExclude`(symbolic HEAD 제거)도 필요 없습니다. 아래는 선택한 값을 터미널에 출력해 동작을 확인하는 액션입니다.

```json
{
  "id": "testButton.ciBranchTicket",
  "title": "Test: CI Branch + Jira Ticket Params",
  "action": {
    "description": "로컬 브랜치를 골라 Jira 티켓을 입력받고 두 값을 파라미터로 출력합니다.",
    "tasks": [
      {
        "id": "pick_branch",
        "type": "quickPick",
        "placeHolder": "테스트할 로컬 브랜치 선택",
        "itemsFromCommand": "git for-each-ref --format='%(refname:short)' refs/heads --sort=-committerdate"
      },
      {
        "id": "pick_ticket",
        "type": "inputBox",
        "prompt": "Jira 티켓 번호",
        "placeHolder": "예: ABCTEST-123",
        "value": "${pick_branch.value}",
        "extractPattern": "[A-Z][A-Z0-9]+-\\d+",
        "validatePattern": "^[A-Z][A-Z0-9]+-\\d+$",
        "validateMessage": "형식: 프로젝트키-숫자 (예: ABCTEST-123)"
      },
      {
        "id": "show_params",
        "type": "shell",
        "command": {
          "windows": "cmd /c echo branch=${pick_branch.value} ticket=${pick_ticket.value}",
          "macos": "printf 'branch=%s\\nticket=%s\\n' '${pick_branch.value}' '${pick_ticket.value}'",
          "linux": "printf 'branch=%s\\nticket=%s\\n' '${pick_branch.value}' '${pick_ticket.value}'"
        },
        "revealTerminal": "always"
      }
    ]
  }
}
```

> **참고**: `itemsFromCommand`는 `cwd`(없으면 워크스페이스 폴더)에서 실행됩니다. 결과가 0줄이면 "got no items …" 오류가 나며, 에러 메시지에 실행 `cwd`와 출력 줄 수가 포함되므로 잘못된 폴더에서 실행됐는지 바로 확인할 수 있습니다. 위 `show_params`는 동작 확인용이라 값을 명령 문자열에 직접 넣었지만, 실제 CI 스크립트에 넘길 땐 예시 4처럼 `args`로 전달하세요.

### `envPick` 태스크

사용자 셸이 실제로 노출하는 **환경변수 이름**만을 정렬해 QuickPick 으로 보여주고, 사용자가 고른 이름을 다음 태스크로 전달합니다. 값은 picker 에 노출하지 않으므로 이름만으로 안전하게 탐색할 수 있습니다.

-   `type` (string, **필수**): `envPick` 으로 설정해야 합니다.
-   `placeHolder` (string, *선택*): QuickPick 에 표시될 안내 문구. 생략 시 기본 문구 ("Select an environment variable name" / "환경변수 이름을 선택하세요") 사용.
-   **실행 결과**: `${task_id.value}` — 선택된 환경변수의 **이름**. 값은 반환하지 않으므로 `printenv ${task_id.value}` 등 후속 `shell` 태스크에서 값을 조회합니다.
-   취소 시 파이프라인이 중단됩니다.

**셸 환경 필터링**: 첫 호출 시 사용자의 기본 로그인 셸 (`$SHELL -l -c env`, Windows 는 `cmd /c set`) 을 한 번 실행해서 실제 노출되는 변수 목록을 캐시한 뒤, `process.env` 의 키 중 그 목록에 포함된 것만 picker 에 표시합니다. VS Code / Electron 이 확장 호스트 프로세스에 주입하는 `VSCODE_*`, `ELECTRON_RUN_AS_NODE` 같은 변수들은 후속 `printenv` 셸 태스크에서 보이지 않으므로 자동 제외됩니다. probe 호출 자체에도 sanitize 된 env 만 넘겨 확장 호스트 변수가 자식 프로세스로 새는 것을 막고, 호출부에서 `VSCODE_*`/`ELECTRON_*` prefix 와 알려진 Electron 전용 이름들의 hardcoded blocklist 를 한 번 더 적용합니다 (belt-and-suspenders). 셸 호출이 5초 안에 끝나지 않거나 실패하면 fallback 으로 blocklist 만 사용합니다.

> **기준**: 필터 기준은 "**VS Code 가 task 로 spawn 한 셸 터미널에서 보이는 env**" 입니다 (사용자 보고 버그가 `revealTerminal: 'always'` 인 셸 task 의 `printenv` 실패였기 때문). `passTheResultToNextTask` 경로에서 사용되는 `executeShellCommand` 는 내부적으로 `process.env` 전체를 자식에 넘기므로 (확장 host 변수 포함), 이론상 picker 에서 가려진 변수도 그 경로에서는 읽을 수 있습니다. 다만 실제 envPick 사용 패턴은 거의 모두 "사용자가 셸에서 설정한 변수를 고른다" 이므로 picker 노출 기준은 더 엄격한 (a) 쪽으로 맞춰 일관된 UX 를 제공합니다.

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
*   **즐겨찾기 추가**: 뷰 제목 표시줄의 + 아이콘을 클릭하면 파일 선택 다이얼로그가 뜹니다 (multi-root 환경에서는 활성 편집기의 워크스페이스 폴더가 default). v0.4.32부터 선택한 파일들은 *제목 = basename, 경로 = 워크스페이스 상대경로* 로 즉시 저장됩니다 — 파일별 제목/그룹/태그/줄 번호 prompt는 모두 사라졌습니다. v0.4.33부터는 동일 항목이 이미 있으면 (path + line + title + group 일치) 중복으로 분류해 disk write를 생략하고, 알림 본문이 *N개 추가됨 (M개 중복 건너뜀, K개 건너뜀)* 형태로 결과를 요약합니다. 모든 파일이 중복이면 disk write를 생략하고 중복 개수에 맞는 *이미 존재* 안내(*이 즐겨찾기는 …에 이미 존재합니다* / *N개의 즐겨찾기가 이미 …에 존재합니다*) + *favorites.json 열기* 회복 토스트만 뜹니다. 워크스페이스 밖 파일은 경고와 함께 건너뛰며, 어떤 `favorites.json`이 파싱 실패면 그 파일에 해당하는 항목들은 저장하지 않고 회복 알림이 별도로 뜹니다.
*   **열려 있는 파일 추가**: 편집기 컨텍스트 메뉴의 *열려 있는 파일 즐겨찾기에 추가* 또는 명령 팔레트로 호출합니다. v0.4.32부터 prompt는 0개 — 활성 편집기의 파일을 *제목 = basename, 줄 = 현재 커서* 로 즉시 저장하고 *favorites.json 열기* 버튼이 달린 알림을 표시합니다. 저장되는 경로는 워크스페이스 상대경로 (`${workspaceFolder}/...`, POSIX 슬래시)이며, `favorites.json`이 깨져 있으면 저장을 거부하고 회복 알림을 띄웁니다. v0.4.33부터 같은 줄/제목/그룹의 항목이 이미 있으면 *이 항목은 favorites.json에 이미 존재합니다* 회복 토스트로 끝내고 disk write를 생략합니다.
*   **클릭하여 열기**: 즐겨찾기 항목을 클릭하면 해당 파일이 VS Code에서 열립니다. 줄 정보가 있으면 해당 줄로 자동으로 이동합니다.
*   **인라인 액션**: 각 즐겨찾기 항목에 마우스를 올리면 휴지통 아이콘이 표시되며, 클릭하여 즐겨찾기를 삭제할 수 있습니다 (modal 확인이 표시됩니다).
*   **검색**: 돋보기 아이콘을 클릭하여 즐겨찾기를 빠르게 검색할 수 있습니다.
*   **파일 편집**: 연필 버튼을 클릭하여 `favorites.json` 파일을 직접 편집할 수 있습니다.

## 7. 확장 프로그램 버전 표시

`mainView.main` 패널은 확장 프로그램의 현재 버전을 상단에 표시합니다. 버전 항목을 클릭하면 `CHANGELOG.md` 파일이 열려 최신 변경 내역을 확인할 수 있습니다. 또한 패널 제목 표시줄의 전구(💡) 아이콘을 클릭하면 `actions.json`, `links.json`, `favorites.json`의 예제 JSON 파일을 빠르게 열어볼 수 있습니다.

## 8. 액션 생성 마법사

`mainView.main` 패널의 제목 표시줄에 있는 '+' 아이콘을 클릭하면 대화형 액션 생성 마법사가 시작됩니다. 이 마법사를 통해 코드를 직접 작성하지 않고도 새로운 액션을 쉽게 생성할 수 있습니다.

흐름은 "꼭 필요한 것만 묻고 나머지는 기본값으로 채운 뒤 사용자가 actions.json을 열어 다듬을 수 있게" 두는 방향으로 정리되어 있습니다.

1.  **워크스페이스 폴더 선택**: 워크스페이스 폴더가 하나뿐이면 자동으로 그것이 사용되며, 여러 폴더를 연 경우에만 선택지가 표시됩니다.
2.  **템플릿 선택**: 여섯 가지 중 하나를 고릅니다 (0.6.17부터 확장). 각 템플릿은 **생성되는 구조가 서로 다릅니다** — 명령어 문자열만 바뀌는 변형(Build / Test 등)은 넣지 않고 명령어 입력란의 예시 문구로 대신합니다.

    | 템플릿 | 생성되는 task | 노출하는 개념 |
    | --- | --- | --- |
    | **Single Shell Command** | `shell` | 기본 |
    | **File Picker + Shell** | `fileDialog` → `shell` | 대화형 입력 + `${selectFile.path}` |
    | **Folder Picker + Shell** | `folderDialog` → `shell` | `${selectFolder.path}` |
    | **Text Input + Shell** | `inputBox` → `shell` | 실행 시점 값 입력 + `${input.value}` |
    | **Choice List + Shell** | `quickPick` → `shell` | 고정 목록 선택 + `${choice.value}` |
    | **Multi-step Pipeline** | `shell` × N (`step1`…`stepN`) | 순차 실행 (앞 단계 실패 시 중단) |

    Multi-step Pipeline은 1단계를 필수로 받고, 2단계부터는 **빈 값으로 Enter를 누르면 거기서 끝납니다** (Esc는 마법사 전체 취소). 단계 수는 최대 10개로 제한되며, 그보다 긴 파이프라인은 actions.json에서 직접 작성하는 편이 낫습니다.

    선택지 목록은 쉼표로 구분해 입력하며(`stm32f4, stm32f7, nrf52`) 공백·빈 항목·중복은 자동으로 정리됩니다.
3.  **제목 입력**: TaskHub 트리에 보일 사람용 제목 한 줄. **액션 ID는 이 제목에서 자동 도출**됩니다 (소문자화 + 문자·숫자가 아닌 구간을 하이픈으로 압축, 같은 ID가 있으면 `-2`, `-3` 형태로 충돌 회피). 유니코드 문자는 보존되므로 `펌웨어 빌드` → `펌웨어-빌드`가 됩니다 (0.6.25부터 — 이전에는 ASCII만 남겨 한글 제목이 모두 `action`, `action-2`가 됐습니다). ID는 아래 6단계 확인 창에서 바로 고칠 수 있습니다.
4.  **템플릿 핵심 입력**: 템플릿마다 1~2개 질문만 받습니다. 대화형 task가 포함된 템플릿은 명령어 입력란에 참조 변수가 미리 채워져 나옵니다(예: `echo Selected file: ${selectFile.path}`, `echo ${input.value}`) — 변수 이름을 외우지 않아도 되도록. 작업 디렉터리(cwd), 터미널 reveal 모드, 성공/실패 메시지 같은 부수 옵션은 묻지 않고 기본값(`always` reveal, 메시지 없음)으로 채워집니다.
5.  **저장 위치 선택**: actions.json에 폴더(`type: 'folder'` 항목)가 있을 때만 위치 선택 Quick Pick이 뜹니다. 폴더가 하나도 없는 평탄한 actions.json이면 이 단계는 자동으로 건너뜁니다. 루트(폴더 밖)는 actions.json 배열 끝에 추가됩니다.
6.  **저장 전 확인** (0.6.18부터): 디스크에 쓰기 직전 modal로 마지막 확인을 받습니다. 여기서 취소하면 파일은 전혀 건드리지 않습니다.
    *   **자동 도출된 `id`를 표시하고, *ID 변경* 버튼으로 그 자리에서 고칠 수 있습니다** (0.6.25부터). 이 값은 `taskhub.runAction.<id>` 커맨드 이름이 되어 `keybindings.json`에 노출되므로, 나중에 바꾸면 지정해 둔 단축키가 깨집니다. 입력값은 비어 있지 않고 공백이 없으며 기존 id와 겹치지 않는지 검사합니다 — 문자 종류에는 제약이 없습니다(한글 id도 유효하며, 커맨드 id로는 percent-encoding되어 들어갑니다). ID를 바꾸면 Doctor 검사도 새 id 기준으로 다시 돌립니다.
    *   저장 위치와 task 목록(최대 8줄, 초과분은 개수로 접힘)을 함께 보여줍니다.
    *   **[TaskHub Doctor](#23-taskhub-doctor-action-lint)를 저장 전에 돌립니다.** 파일 전체를 린트한 결과에서 *새 액션이 새로 만들어 낸 문제만* 골라 보고합니다 — 기존 액션이 원래 갖고 있던 경고까지 새 액션 탓으로 보이지 않도록 before/after를 비교합니다.
    *   *자세히 보기* 버튼은 **추가될 액션 하나의 JSON**과 [Preview Run](#preview-run-dry-run) 시뮬레이션 결과를 임시 문서로 엽니다 (파일 전체를 덤프하지는 않습니다 — 액션이 수십 개인 파일에서는 미리보기로서 쓸모가 없기 때문입니다. 삽입 위치는 확인 창의 *위치* 줄에서 확인하세요). **문서를 연 뒤에는 확인 창이 modal이 아닌 알림으로 바뀝니다** (0.6.27부터) — VS Code modal은 워크벤치 전체를 가리고 입력을 잡아, 방금 연 문서를 스크롤하거나 선택할 수 없기 때문입니다. 선택지(*저장* / *ID 변경* / *자세히 보기*)는 그대로이고, 알림을 닫으면 저장하지 않고 끝납니다. 문서를 닫아도 저장 여부에는 영향이 없습니다.
    *   검사기가 오류를 내더라도 생성 자체는 막지 않습니다 — 점검은 참고용이며, 실패는 TaskHub Output 채널에만 기록됩니다.
7.  **자동 저장 + 후속 액션**: 생성된 액션은 워크스페이스의 `.vscode/actions.json`에 즉시 기록되며 Actions 패널이 갱신됩니다. 알림 본문은 *"'X' 액션이 actions.json에 추가되었습니다. cwd, revealTerminal, 성공/실패 메시지 등 추가 설정이 필요하면 actions.json을 편집하세요."* 형태로, 마법사가 묻지 않고 default 로 채운 부수 옵션이 존재한다는 사실을 사용자에게 알려줍니다. 알림의 *actions.json 열기* / *바로 실행* 버튼으로 곧바로 편집기에 점프하거나 액션을 시험 실행할 수 있습니다.

기존 `.vscode/actions.json`이 파싱 실패 / 스키마 위반으로 깨져 있으면 마법사가 곧바로 종료되지 않고, "actions.json 열기" 버튼을 가진 에러 알림을 띄워 사용자가 그 자리에서 파일을 열어 고칠 수 있게 합니다.

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

실행 중인 액션은 개별적으로 또는 모두 한 번에 종료할 수 있습니다. **실행 중지와 터미널 닫기는 서로 다른 명령입니다** (0.6.13부터) — 빌드를 멈추려다 읽고 있던 출력까지 사라지지 않도록 분리했습니다.

*   **개별 액션 종료**: 실행 중인 액션 항목을 마우스 오른쪽 버튼으로 클릭하거나 인라인 아이콘(사각형)을 클릭하여 해당 액션만 종료할 수 있습니다.
*   **모든 액션 중지** (`taskhub.stopAllActions`): `mainView.main` 제목 표시줄의 사각형 아이콘. **실행 중인 액션이 있을 때만 표시**됩니다 (`taskhub.hasRunningActions` context key). 터미널은 건드리지 않습니다.
    *   대상이 2개 이상이면 중지할 액션 이름과 개수를 modal로 먼저 보여줍니다 (5개까지 나열하고 나머지는 "외 N개").
    *   중지된 액션의 히스토리 항목은 `실패` + `Action stopped by user`로 마감됩니다 — 예전에는 일괄 종료 시 항목이 `실행 중` 상태로 남았습니다. (0.6.13~0.6.21에서는 이 기록이 종료 오류 메시지로 덮이고 불필요한 실패 알림이 함께 떴습니다. 0.6.22에서 수정되었습니다.)
    *   확인 창에서 취소하면 어떤 액션도 중지되지 않고, 호환 명령 `taskhub.terminateAllActions`로 실행한 경우 **터미널도 닫지 않습니다**.
    *   이미 끝난 액션의 ✓/✗ 아이콘은 지우지 않습니다.
    *   확인 창이 떠 있는 동안 대상이 스스로 모두 끝났다면 *"대상 액션이 이미 모두 끝났습니다"* 로 알립니다 (0.6.29부터). 예전에는 같은 상황에서 *"중지할 활성 태스크를 찾지 못했습니다"* 경고가 떠, 정상적인 경합을 오류처럼 보이게 했습니다.

### 대화형 태스크를 기다리는 중의 중지 (0.6.29)

`inputBox` / `quickPick` / `fileDialog` 프롬프트 앞에서 대기 중인 액션도 중지할 수 있습니다. 이 상태의 액션은 실행 중인 프로세스가 없어서, 예전에는 중지 버튼을 눌러도 *"활성 태스크를 찾을 수 없습니다"* 경고만 뜨고 프롬프트는 화면에 그대로 남았습니다.

*   `inputBox`와 `quickPick`은 **프롬프트가 즉시 닫힙니다.** TaskHub가 실행마다 `CancellationToken`을 만들어 넘기고, VS Code가 취소 시 프롬프트를 닫습니다.
*   `fileDialog` / `folderDialog`가 여는 **OS 네이티브 대화상자는 프로그램적으로 닫을 수 없습니다.** 중지 요청은 기록되고, 사용자가 대화상자를 닫거나 파일을 고르는 순간 파이프라인이 중단됩니다 — 고른 파일로 뒤 단계가 계속 진행되지 않습니다.
*   어느 경우든 히스토리는 다른 중지 경로와 동일하게 `실패` + `Action stopped by user`로 마감되며, 실패 알림은 뜨지 않습니다.
*   **TaskHub 터미널 닫기** (`taskhub.closeAllTerminals`): `TaskHub: ` 접두사를 가진 터미널을 모두 닫습니다. 제목 표시줄 `…` 오버플로 메뉴 또는 Command Palette에서 실행하며, 액션 실행에는 영향을 주지 않습니다.

> `taskhub.terminateAllActions`는 두 동작을 한 번에 하던 예전 명령입니다. 기존 `keybindings.json`이 깨지지 않도록 **호환용으로만 남겨 두었고**(중지 후 터미널 닫기), 메뉴와 팔레트에는 노출되지 않습니다. 새로 키를 지정한다면 위 두 명령을 쓰세요.

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

메인 뷰의 최하단에 위치한 히스토리 패널은 최근 실행한 액션과 TaskHub 도구 열람 기록을 추적하고 관리합니다.

**주요 기능:**
*   **기록 추적**: 액션을 실행하거나 Memory Map / Hex Editor / JSON Editor를 성공적으로 열 때마다 히스토리에 자동으로 추가되며, 제목에는 총 개수가 표시됩니다 (예: "History (10)").
*   **상태 표시**: 각 히스토리 항목은 실행 상태를 시각적으로 표시합니다:
    *   성공
    *   실패
    *   실행 중
*   **"Last run" 배지 (시각 + 소요 시간)**: 종료된 항목은 라벨 옆에 짧은 배지가 함께 표시됩니다 — 확장을 재시작해도 그대로 남아 "오늘 빌드 됐었지?"에 한눈에 답이 됩니다.
    *   형식: `HH:mm · 1.2s` / `어제 14:30 · 45ms`. 성공/실패는 위의 상태 아이콘(녹색 ✓ / 빨간 ✗)으로만 표시하며, 같은 신호를 배지 텍스트에 중복하지 않습니다.
    *   시각 표기: 같은 날 `HH:mm`, 어제 `어제 HH:mm` (영문은 `Yest HH:mm`), 더 오래된 항목 `MM/DD`.
    *   소요 시간 표기: `Nms` (1초 미만) / `N.Ns` (1분 미만, 절삭) / `Nm Ms` (1시간 미만) / `Hh Mm`.
    *   진행 중(`running`) 항목은 배지 대신 상태 아이콘만 표시합니다.
    *   VS Code를 24시간 이상 켜둔 채 자정을 넘겨도 배지는 자동으로 갱신됩니다 (시간당 background tick + 패널 재진입 시 갱신).
*   **실행/열람 시간 정보**: 히스토리 항목에 마우스를 올리면 액션 실행 또는 도구 열람의 정확한 시간이 툴팁으로 표시됩니다 (예: "Executed at: 2025-12-28 14:30:45", "Opened at: 2025-12-28 14:30:45").
*   **빠른 재실행/다시 열기**: 액션 히스토리 항목을 클릭하면 해당 액션을 즉시 재실행합니다. Memory Map / Hex Editor / JSON Editor 히스토리 항목(각각 `graph` / `file-binary` / `json` 아이콘으로 구분)은 저장된 파일 경로로 해당 도구를 다시 엽니다. Memory Map은 ELF/AXF인지 ARM Linker Listing인지와 당시 사용한 메모리 region 설정을 함께 보존하므로, 다시 열 때 입력 형식·링커 스크립트 선택 다이얼로그를 건너뜁니다. 재실행 또는 다시 열기는 새로운 히스토리 엔트리로 추가됩니다.
*   **저장된 입력값으로 재실행 (Re-run with Saved Inputs)**: 액션 실행 중 사용자가 입력한 인터랙티브 task 결과(`inputBox` / `quickPick` / `envPick` / `fileDialog` / `folderDialog` / `confirm`)는 자동으로 해당 히스토리 엔트리에 함께 기록됩니다. **히스토리 항목을 클릭해 재실행하면, 저장된 입력값이 있는 한 다이얼로그를 다시 띄우지 않고 이전 응답값(예: 직전에 선택한 디렉터리)을 그대로 재사용합니다.** 저장된 입력값이 있는 항목 옆에는 ▶ 아이콘도 표시되며, 동일하게 입력값을 재사용해 재실행합니다.
    *   같은 task ID에 대해 저장된 값이 있을 때만 다이얼로그가 스킵됩니다. 액션 정의에 새 인터랙티브 task가 추가되어 매칭되는 저장값이 없으면, 그 task만 정상적으로 다이얼로그를 띄웁니다. 입력을 새로 고르고 싶을 때는 히스토리가 아니라 원본 액션을 실행합니다.
    *   **보안**: `inputBox` task에 `"password": true`가 설정된 경우 해당 입력값은 히스토리에 저장되지 않습니다. 비밀번호/토큰을 받는 task는 항상 새로 입력해야 합니다.
*   **실행한 명령 보기 (View Executed Command)**: `command` / `shell` task가 실제로 실행한 명령줄이 `${...}` 치환(선택한 디렉터리 등 포함)이 끝난 상태로 히스토리에 함께 기록됩니다. 명령이 기록된 항목 옆의 터미널 아이콘을 클릭하면 **재실행하지 않고** 어떤 명령이 어떤 인자로 실행됐는지 task ID별로 정리된 읽기 전용 문서로 보여줍니다. (출력 보기와 달리 실행 결과가 아니라 실행한 명령 자체를 표시합니다.)
*   **인라인 액션**: 각 히스토리 항목에 마우스를 올리면 다음 아이콘들이 표시됩니다:
    *   ▶ 아이콘: 저장된 입력값으로 재실행합니다. 인터랙티브 task가 있었던 항목에만 표시됩니다.
    *   터미널 아이콘: 실행한 명령줄을 봅니다 (재실행 안 함). `command` / `shell` task가 있었던 항목에만 표시됩니다.
    *   출력 보기 아이콘: 실패한 액션의 에러 메시지를 확인할 수 있습니다. 출력이 있는 항목에만 표시됩니다.
    *   휴지통 아이콘: 개별 히스토리 항목을 삭제합니다 (v0.4.33부터 modal 확인 대화상자 표시 — `Delete Favorite` / `Delete Link`와 같은 보호 수준).
*   **전체 히스토리 삭제**: 패널 제목 표시줄의 버튼을 클릭하여 모든 히스토리를 한 번에 삭제할 수 있습니다 (확인 대화상자 표시).
*   **자동 제한**: 히스토리는 설정된 최대 개수까지만 유지되며, 초과 시 가장 오래된 항목부터 자동으로 삭제됩니다 (기본값: 10개).
*   **패널 표시/숨김**: 설정에서 히스토리 패널을 숨길 수 있으며, `TaskHub: Toggle History Panel` 명령으로 표시/숨김을 전환할 수 있습니다.

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

> 0.6.27 이전에는 *Export Action* · *Preview Run* · *Assign Shortcut* 세 항목이 **한 번도 실행하지 않은 액션에서만** 보였습니다. 실행 상태가 TreeItem의 `contextValue`로 인코딩되는데(`runningAction` / `succeededAction` / `failedAction`) 메뉴 조건이 `action` 하나만 나열했기 때문입니다. 세 항목 모두 실행 상태와 무관하게 노출되도록 고쳤습니다. `taskhub.showTaskStatus`를 꺼도 `contextValue`는 실제 상태를 유지하므로(인라인 중지 버튼이 사라지면 안 되기 때문 — [§21 설정 레퍼런스](#21-설정-레퍼런스)) 설정으로 우회할 수 있는 문제도 아니었습니다.

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
3. 기존 `.vscode/actions.json`과 병합합니다:
   - ID가 중복되지 않는 액션만 추가됩니다.
   - 중복된 ID는 건너뛰고, 건너뛴 항목을 알림으로 표시합니다.
4. **기존 `actions.json`이 손상되어 있을 때**는 덮어쓰지 않고 "손상된 파일 백업 후 계속 / 취소" 모달을 표시합니다. 사용자 동의 시 원본을 `actions.json.bak`로 보존한 뒤 가져온 액션만 저장합니다.
5. `.vscode` 폴더가 없으면 자동으로 생성합니다.

**지원하는 Import 형식:**
- `.taskhub` 파일 (TaskHub Export 형식)
- `actions.json` 파일 (raw JSON 배열 형식)

## 19. Memory Map 시각화

> **지역화 / 접근성 (0.6.21부터)**: 웹뷰 UI(버튼·제목·열 이름·검색·상태)가 VS Code 언어 설정을 따릅니다. **단 *Copy Report* / *Copy Full Dump* 로 복사되는 리포트 본문은 영어로 유지**됩니다 — 이슈·커밋·문서에 붙여 공유하는 산출물이라 문구가 안정적인 편이 낫기 때문입니다. 접근성 측면에서는 정렬 가능한 열 머리글이 키보드(Tab → Enter/Space)로 동작하고 `aria-sort`로 현재 정렬 상태를 알리며(▲/▼ 글리프는 스크린리더가 읽지 못합니다), 검색 결과 개수는 live region, 아이콘 전용 버튼(◀ ▶ ↑)에는 `aria-label`, *모두 펼치기* 버튼에는 `aria-expanded`가 붙습니다. 사용량 막대는 같은 수치가 이미 텍스트로 있으므로 `aria-hidden`으로 중복 낭독을 막습니다.
>
> **0.6.31부터**: region 카드와 Object Summary 헤더가 `role="button"` + `tabindex` + `aria-expanded`를 갖춰 키보드(Tab → Enter/Space)로 펼칠 수 있습니다 — 이전에는 마우스 없이 영역 상세를 볼 방법이 아예 없었습니다. 0.6.21의 정렬 접근성이 정적 All Sections 표에만 적용돼 있던 것도 보완해, **런타임에 조립되는 region 상세 / Object Summary 표**의 정렬도 키보드로 동작하고 `aria-sort`를 갱신합니다.

ARM `.axf`/`.elf` 바이너리 파일을 파싱하여 메모리 사용량을 시각적으로 표시합니다. 임베디드 개발 시 Flash/RAM 사용량을 한눈에 파악할 수 있습니다.

> **입력 크기 한도**: 파일은 **100MB** 까지 받습니다. ARM Linker Listing 은 여기에 더해 **엔트리 50만 개** 상한이 있습니다 (0.6.40부터) — listing 은 한 줄이 엔트리 하나라 파일 크기만으로는 부족하고, 엔트리 하나가 파싱 객체 → 파생 배열 → JSON → HTML → (모두 펼치기 시) DOM 노드로 증폭되기 때문입니다. 상한을 넘으면 **경고를 띄우고** 앞의 50만 개만 표시합니다. 이때도 **요약 수치(Total RO/RW/ROM)는 파일 전체 기준**이라 정확합니다 — 잘리는 것은 개별 엔트리 목록뿐입니다.

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
- 열 머리글(Object / Size / Bytes / %)을 눌러 다시 정렬할 수 있습니다. **Details를 펼친 상태에서도 오브젝트와 그에 딸린 섹션 행이 한 묶음으로 함께 이동**하며, 정렬 기준은 화면 표시값이 아니라 원본 값(바이트 수, 반올림 전 퍼센트)입니다.

> **0.6.34에서 수정**: 이 표의 정렬이 두 가지 이유로 깨져 있었습니다. (1) 정렬 시 오브젝트 행만 재배치하고 섹션 상세 행은 제자리에 남겨, Details를 펼친 상태에서 묶음이 통째로 어긋났습니다. (2) 오브젝트 행의 `colspan` 때문에 헤더 순번과 셀 순번이 어긋나, **Percent 정렬은 빈 셀을 읽어 아무 동작도 하지 않았고** Size/Bytes는 반올림된 퍼센트 셀을 읽었습니다. 후자는 퍼센트가 바이트에 비례해 방향은 대체로 맞아 보였지만, `toFixed(1)` 동률 구간에서는 직전 정렬 순서가 남아 크기 순서가 보장되지 않았습니다 — 패널을 막 열었을 때는 목록이 이미 크기 내림차순이라 정확해 보이고, Object 이름으로 한 번 정렬한 뒤 Size를 누르면 드러납니다.

### 함수명 표시 (Region Details)

Region Details 테이블에서 Function 컬럼을 토글하여 각 엔트리의 함수/심볼명을 확인할 수 있습니다:

- **ARM Linker Listing**: 섹션 토큰에서 `.text.`, `.rodata.` 등 알려진 prefix를 제거하고 함수명 추출 (예: `.text._ZN4Test8FuncEv` → `_ZN4Test8FuncEv`)
- 괄호 없는 오브젝트 형식(`idx  .text._ZN...  Object.o`)에서도 함수명 추출 지원
- 알려지지 않은 prefix의 경우 섹션 토큰 전체를 그대로 표시
- 테이블 컬럼: **Object** | **Section** | **Function** | Address | End | Size | Bytes | Type
- "Function ▶" 버튼 클릭으로 Section + Function 컬럼 함께 표시/숨김 전환

### 리포트 복사

Memory Map 패널 상단에 **두 개의 복사 버튼**이 있습니다 — 의도가 "공유용 요약"인지 "원시 데이터 dump"인지에 따라 골라 사용합니다.

- **"Copy Report"** — 큐레이션된 markdown 요약(약 50줄). 헤더(파일명/경로/Entry Point/생성 시각), Memory Regions 표, region별 Top 5 섹션 + 가장 큰 free hole, 그리고 Highlights(가장 큰 섹션·가장 큰 free hole·≥80% 포화 region 경고). 형식은 markdown 표라 GitHub 이슈/PR, Slack, Notion에 그대로 붙여 넣어도 정렬이 깨지지 않습니다.
- **"Copy Full Dump"** — region별 모든 섹션 + 전체 섹션 표(Address/End/Size/Bytes/Type)를 monospace 텍스트로 그대로 복사. grep / diff / 회귀 비교가 필요할 때 사용. 대용량 listing 파일은 수백~수천 줄에 이를 수 있습니다.

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

- **키워드 검색**: 상단 검색창에서 오브젝트/섹션/함수 이름, 주소, 크기, 타입으로 필터링. 검색 중 검색 대상이 되는 Section/Function 컬럼은 자동으로 표시됩니다(검색어를 비우면 원래대로). `Ctrl/Cmd+F`로 검색창에 포커스(기존 입력은 전체 선택), `Esc`로 검색어 초기화 후 다시 한 번 누르면 포커스 해제
  - **매치 하이라이트**: Region Details 테이블(가상 스크롤 포함)과 All Sections / Overview 테이블 모두에서 검색어와 일치하는 부분 문자열을 에디터 "찾기" 강조색으로 칠해 위치를 즉시 알 수 있습니다
  - **매치 네비게이션**: 검색창 오른쪽 `◀ ▶` 버튼과 `3 / 17` 위치 카운터로 매치 사이를 이동합니다. `Enter` = 다음, `Shift+Enter` = 이전, 양 끝에서 순환. 이동 시 해당 행을 화면 가운데로 가져오고 "현재 매치"를 진하게 강조하며, 검색 직후 첫 매치가 자동 선택됩니다. 결과가 없으면 `No matches`를 경고색으로 표시
  - **결과 중심 정리**: 검색 중에는 매치가 0개인 region 카드를 숨기고, 헤딩에 매치 수를 표기합니다 — `All Sections (12 / 540)`, `Region Details — 2 regions matched`. 매치가 있는 region은 자동으로 펼쳐집니다
  - **검색창 상단 고정**: 검색 박스(입력창 + 카운터 + ◀▶)가 화면 상단에 고정되어, 결과를 보러 아래로 스크롤해도 계속 보입니다
- **다중 패널**: 서로 다른 파일을 열면 각각 별도 탭으로 표시됩니다. 동일 파일명이라도 경로가 다르면 독립 패널로 열리며, 같은 파일을 다시 열면 기존 패널을 재사용합니다.
- **Region 이동** (`Ctrl+Shift+O`): Memory Map 패널이 활성화된 상태에서 VS Code QuickPick으로 region 목록을 표시하고, 선택 시 해당 region으로 스크롤 및 펼침 (마지막으로 활성화된 패널 기준)
- **Region 요약 테이블 클릭**: 상단 Overview 테이블의 row 클릭 시 해당 Region Details로 스크롤 및 자동 펼침
- **Region 폴딩**: 각 region 카드가 기본 접힘 상태로 표시되며, 클릭으로 토글 가능 (헤더 + 사용률 바는 항상 표시)
- **Expand/Collapse All 토글**: Region Details 섹션 헤더의 단일 버튼으로 전체 region을 일괄 펼침/접기. 라벨은 현재 상태에 따라 `▼ Expand All` ↔ `▶ Collapse All`로 자동 전환되며, 개별 region을 수동으로 펼치거나 접어도 다음 클릭이 수행할 동작에 맞게 동기화된다.
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

> **지역화 / 접근성 (0.6.20부터)**: 툴바·헤더·상태 표시줄·찾기 바의 모든 문자열이 VS Code 언어 설정을 따릅니다. `Unit` / `Endian` / `Go to` 라벨이 `for` 속성으로 각 컨트롤과 연결되고, placeholder만 있던 찾기 입력과 아이콘 전용 버튼(◀ ▶ ✕)에는 `aria-label`이 붙습니다. 찾기 결과 개수와 바이트 검사 결과는 live region으로 노출되어 스크린리더가 변화를 읽습니다. `Little-Endian`, `ASCII`, 예시 입력값 같은 짧은 기술 식별자는 규칙대로 번역하지 않습니다.
>
> **0.6.31부터**: 바이트 선택을 키보드로 할 수 있습니다. 표 전체가 하나의 tab stop이고(행이 가상 스크롤로 만들어졌다 사라지므로 셀마다 `tabindex`를 줄 수 없습니다), 진입 후 **화살표**로 이동, **PageUp/PageDown**으로 16행씩, **Home/End**로 처음/끝, **Shift+화살표**로 범위를 넓힙니다. 조작법은 표의 `aria-label`이 안내합니다.

> **파일 끝의 불완전한 unit (0.6.36부터)**: 2/4/8-byte unit 모드에서 파일 길이가 unit의 배수가 아니면 마지막 셀은 남은 바이트만 담습니다 (예: 18바이트 파일 + 4-byte 모드 → offset 16에 2바이트). 그 셀도 **정상적으로 표시되며**(자리수가 짧고 흐리게 렌더됩니다) 선택·Go to·Find 대상이 됩니다. 0.6.35 이전에는 이 셀을 아예 그리지 않아 키보드·Go to가 존재하지 않는 위치를 가리켰고, 0.6.36 초안에서 이를 clamp로 막았더니 **Go to 17이 조용히 12로 바뀌는** 더 나쁜 동작이 됐습니다 — Find도 같은 경로를 쓰므로 끝부분 검색 결과가 엉뚱한 곳을 가리켰습니다. 표현할 수 있는 것을 그대로 표현하는 쪽으로 정리했습니다.

펌웨어 이미지 파일(`.hex`, `.bin`, `.srec`)을 VS Code 내에서 Hex dump 형태로 열어볼 수 있는 뷰어입니다. Trace32의 `Data.dump`와 유사한 UX를 제공합니다.

> **입력 크기 한도**: 파일은 **50MB** 까지 받습니다. 넘으면 오류를 띄우고 열지 않습니다 — 외부 Hex Editor 를 쓰라고 안내합니다.
>
> **데이터 전송 방식 (0.6.42부터)**: 바이트는 HTML 에 박히지 않고 `postMessage` 로 웹뷰에 전달됩니다. 이전에는 Base64 로 만들어 HTML 문자열에 인라인했는데, 그러면 같은 내용이 네 벌(원본 배열 → Base64 문자열 → HTML → `atob` 결과)로 늘어나 50MB 파일의 peak 가 수백 MB 였습니다. 지금은 **HTML 크기가 파일 크기와 무관하게 약 39KB 로 고정**되고, Base64 인코딩·`atob` 디코딩 비용도 사라져 여는 속도도 함께 빨라집니다. 대가는 데이터가 한 프레임 늦게 도착한다는 것뿐이라, 그동안 *불러오는 중…* 을 표시합니다.
>
> 파서에는 별도로 **byte entry 상한(32M)** 이 있습니다. 여기서 entry 는 *주소 하나에 담긴 바이트 하나*이고, 이 상한은 **HEX/SREC 에만** 해당합니다 (binary 는 Map 대신 raw 버퍼를 씁니다). HEX/SREC 는 텍스트 포맷이라 1바이트를 최소 2자 남짓으로 적으므로, 50MB 파일이 만들 수 있는 entry 는 최대 약 25M 입니다 — 즉 이 상한은 정상 파일을 거부하지 않는 backstop 입니다. 0.6.41 이전에는 100M 이라 **어떤 입력으로도 걸리지 않았고**, 두 상한의 관계는 이제 테스트가 고정합니다.

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

---

## 21. 설정 레퍼런스

TaskHub가 `contributes.configuration`으로 VS Code에 등록하는 모든 설정의 **단일 출처** 입니다. 원본은 [package.json](../package.json)이며, 이 표는 그 내용을 그대로 한국어 설명과 함께 정리해 둔 것입니다. README는 이 섹션을 가리키는 포인터만 유지합니다.

설정을 수정하려면 VS Code에서 `File > Preferences > Settings` → "TaskHub"로 검색하거나, 워크스페이스 `.vscode/settings.json`에 직접 키를 추가하세요.

### 21.1. 전체 설정 표

| 설정 ID | 타입 | 기본값 (범위) | 요약 | 관련 기능 |
| --- | --- | --- | --- | --- |
| `taskhub.showTaskStatus` | `boolean` | `true` | Actions 뷰의 실행 상태 아이콘(running/success/failure)·진행률 표시와 완료 알림 표시 여부. `false`면 **실패 알림(액션의 `failMessage` 포함)도 함께 억제**되므로 실패 여부는 History 패널이나 출력 채널로 확인해야 한다. 동시 실행 가드, 인라인 *중지* 버튼, *Stop All Actions* 노출은 그대로 동작한다. | [§5 Actions 패널](#5-actions-패널-mainviewmain), [§14 히스토리](#14-액션-실행-히스토리) |
| `taskhub.pipeline.showVerboseLogs` | `boolean` | `false` | 파이프라인 실행 시 TaskHub OutputChannel에 상세 명령/STDOUT/STDERR/exit code를 출력. 디버깅에만 켤 것. | [§5 Actions 패널](#5-actions-패널-mainviewmain) |
| `taskhub.pipeline.pythonIoEncoding` | `string` | `"utf-8"` | TaskHub가 실행하는 모든 명령의 `PYTHONIOENCODING` 환경변수 값. 빈 문자열이면 강제 설정 안 함. `utf-8:ignore` 같은 값도 가능. | [§5 shell/command 태스크](#5-actions-패널-mainviewmain) |
| `taskhub.pipeline.windowsPowerShellEncoding` | `"utf8"` \| `"system"` | `"utf8"` | Windows PowerShell 출력 인코딩. UTF-8을 인식하지 못하는 레거시 도구가 있으면 `"system"`으로 전환해 현재 콘솔 코드 페이지를 유지. | [§5 shell/command 태스크](#5-actions-패널-mainviewmain) |
| `taskhub.pipeline.outputCaptureLimitMb` | `number` | `10` (1–1024) | 캡처 모드(`passTheResultToNextTask: true`)에서 누적되는 stdout/stderr 총 크기 상한(MB). 초과 시 프로세스를 종료하고 명확한 에러로 실패. | [§5 Output Capture](#output-capture) |
| `taskhub.pipeline.totalOutputLimitMb` | `number` | `32` (1–4096) | 한 액션이 들고 있는 **모든 태스크 결과의 합계** 상한(MB). 위 설정이 태스크 하나를 막는다면 이 설정은 합계를 막는다. **태스크 상한보다 작아지지 않는다.** 초과 시 액션 실패. | [§5 Output Capture](#output-capture) |
| `taskhub.pipeline.maxParallelTasks` | `integer` | `4` (1–32) | 한 액션 안에서 동시에 실행될 수 있는 task 최대 개수. `parallel: true`가 붙은 task만 "이전 모든 task를 기다림" barrier에서 빠지며, barrier에서 빠진 뒤에도 명시적 `dependsOn`과 `${taskId.x}` 자동 추론 의존성은 그대로 기다린다. `parallel: true`가 없는 task는 `dependsOn` 유무와 무관하게 sync barrier로 동작. 기본 4는 임베디드 빌드(linker/LTO)의 메모리 부담을 고려한 보수적 값 — 자원 여유가 있는 머신에서는 늘리고, 완전 순차로 강제하려면 `1`로 설정. | [§5 Actions 패널](#5-actions-패널-mainviewmain) |
| `taskhub.history.maxItems` | `number` | `10` (1–50) | 저장되는 액션 실행 히스토리 최대 개수. 초과분은 오래된 순으로 자동 제거. | [§14 히스토리](#14-액션-실행-히스토리) |
| `taskhub.runAnyAction.recentLimit` | `number` | `5` (0–20) | `TaskHub: Run Any Action…` 팔레트의 *Recently used* 섹션에 표시할 최대 개수. `0`이면 섹션 자체가 숨겨진다. 목록은 히스토리에서 유도되므로 `taskhub.history.maxItems`가 상한으로 작용하고, 표시 시점에 stale 항목(삭제된 액션)을 걸러내므로 실제 보이는 개수는 이 값 이하가 될 수 있다. | [§5 Quick Action Palette](#5-actions-패널-mainviewmain) |
| `taskhub.history.showPanel` | `boolean` | `true` | 사이드바의 History 패널 표시 여부. `false`면 뷰 자체가 감춰지지만 기록은 그대로 유지된다. | [§14 히스토리](#14-액션-실행-히스토리) |
| `taskhub.preview.showSourceControlContextMenu` | `boolean` | `true` | Source Control 변경 파일 우클릭 메뉴에 TaskHub 프리뷰/브라우저 열기 항목을 표시할지 여부. VS Code SCM 메뉴는 확장자 context key를 안정적으로 제공하지 않으므로 켜져 있으면 대상 확장자 외 파일에도 항목이 보일 수 있으며, 실제 실행은 핸들러가 확장자로 재검증한다. | [§22 Markdown / HTML 우클릭 열기](#22-markdown--html-우클릭-열기) |
| `taskhub.builtinActions` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | 확장에 번들된 예제 액션(`defaultButton.*`)을 Actions 목록에 병합할지. `auto`는 목록에 넣지 않고 빈 상태 CTA의 *Browse Examples* 로만 안내, `never`는 그 버튼까지 숨김, `always`는 0.6.14 이전처럼 목록에 병합. | [§3 액션 소스와 병합](#액션-소스와-병합-우선순위) |
| `taskhub.dialog.rememberLastLocation` | `boolean` | `true` | TaskHub의 파일/폴더 다이얼로그를 같은 용도로 마지막에 사용한 위치에서 연다. `false`면 TaskHub가 시작 위치를 **일절 지정하지 않고** VS Code의 기본 규칙과 `files.dialog.defaultPath` 설정에 맡긴다. 저장 다이얼로그는 제안 파일명도 함께 사라진다. 액션 JSON의 `options.defaultUri`는 어느 쪽이든 존중한다. | [§25 다이얼로그 위치 기억](#25-파일폴더-다이얼로그-위치-기억) |
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

README([README.md](../README.md) / [README.en.md](../README.en.md))는 사용자가 자주 손대는 5–6개 설정만 **이름 + 한 줄 용도**의 하이라이트 표로 노출합니다. 타입·기본값·범위 같은 사실은 그쪽에 복제하지 않으므로(이름만으로는 단일 출처가 깨지지 않음), 새 설정을 추가하거나 기본값을 바꿀 때 README 표를 동시에 고칠 필요는 없습니다 — 다만 새 설정이 *자주 조정될 만한 사용자 노출 다이얼*이라면 README 하이라이트에 한 행 더 넣을지 검토하세요.

---

## 22. Markdown / HTML 우클릭 열기

VS Code의 소스 컨트롤·탐색기·에디터 탭에서 마크다운 / HTML 파일을 우클릭해 곧바로 렌더링된 형태로 열기 위한 컨텍스트 메뉴 항목입니다. 기본적으로 SCM diff 뷰는 텍스트 비교만 보여주기 때문에 별도의 클릭 한 번 없이 프리뷰로 점프하는 경로가 없었고, 그 빈자리를 메우는 단순한 어댑터입니다.

### 22.1. 적용 범위

| 확장자 | 메뉴 항목 | 동작 |
| --- | --- | --- |
| `.md`, `.markdown` | **TaskHub: Open Markdown Preview** | VS Code 내장 명령 `markdown.showPreviewToSide`에 위임 — 옆 컬럼에 렌더링된 프리뷰. |
| `.html`, `.htm` | **TaskHub: Open HTML in Default Browser** | `vscode.env.openExternal`로 OS 기본 브라우저에서 열기. |

대소문자는 가리지 않습니다(`README.MD` / `INDEX.HTML` 모두 매칭). 위 외 확장자(`.svg`, `.mmd` 등)는 의도적으로 제외 — VS Code가 이미 자동 렌더하거나(SVG) 외부 익스텐션이 필요한 경우(Mermaid)이기 때문에 단순 어댑터로 끼워넣을 가치가 적습니다.

**Simple Browser 미지원 (의도)**: 초기 설계에서는 `simpleBrowser.show`로 VS Code 내부 webview에 HTML을 띄우는 명령도 함께 제공했으나, Simple Browser는 webview iframe 구조 + CSP 제약 때문에 `file://` 로컬 HTML의 CSS·이미지·스크립트 로딩이 사실상 보장되지 않습니다. "보이긴 하는데 깨진" 결과가 나오는 명령을 메뉴에 두는 것이 더 나쁘다고 판단해 정리했습니다. VS Code 내부에서 HTML을 안전히 보고 싶다면 자체 `WebviewPanel`로 파일을 읽어 렌더하는 별도 기능이 필요하며, 현재 범위에는 포함하지 않습니다.

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
| `capture.regex` | error | `output.capture.regex`가 `new RegExp()` 컴파일에 실패. |
| `capture.group` | warning | `output.capture.group` 인덱스가 regex의 capture group 개수를 벗어남. |
| `capture.reserved` | error | `output.capture.name`이 reserved 집합(`output`/`path`/`value` 등 task 결과 빌트인 키)과 충돌. 스키마는 이름 패턴만 검사하므로 schema-pass 후 런타임에서 throw 하던 케이스를 Doctor가 사전에 잡음. |
| `capture.duplicate` | error | 같은 task 안에서 `output.capture.name`이 두 번 이상 정의됨. |
| `diagnostics.regex` | error | `output.diagnostics.pattern`이 컴파일 실패. `g` 플래그는 런타임과 동일하게 사전 제거된 뒤 검사. |
| `diagnostics.group` | warning | `file`/`line`/`message` 등의 그룹 인덱스가 regex가 정의한 capture group 수보다 큼. |
| `diagnostics.preset` | error | `"$gcc"` / `"$tsc"` 같은 preset 단축 문자열이 알 수 없는 이름이거나 `$` 없이 적힘. |
| `variable.unresolved` | warning | Preview Run과 동일한 simulation 컨텍스트에서 변수 치환 후에도 남는 `${…}` 가 있음. 런타임에는 리터럴로 전달되므로 의도된 placeholder가 아니면 거의 항상 버그. |
| `output.not-captured` | warning | `${A.output}`(또는 A의 capture 이름)을 참조하지만 shell/command 태스크 A에 `passTheResultToNextTask: true`가 없음. 런타임은 출력을 스트리밍만 하고 빈 결과를 넘기므로 참조가 리터럴로 남음 — 가장 흔한 설정 실수. 선언 순서와 무관하게(전방 참조 포함) 검출. |
| `output.ignored` | warning | shell/command 태스크에 `output.mode`/`capture`/`diagnostics`가 정의되어 있지만 `passTheResultToNextTask: true`가 없음. 런타임이 조용히 무시하는 죽은 설정. |
| `path.outside-workspace` | error | `writeFile` / `appendFile` / `output.filePath`의 해석 결과가 워크스페이스 밖. 런타임이 실행을 거부할 경로. (변수 치환 후에도 `${…}`가 남은 경우는 검사를 건너뜀 — 안전 결정 불가) |
| `dependsOn.self` | error | task의 `dependsOn`에 자기 자신이 포함됨. |
| `dependsOn.missing` | error | `dependsOn`이 같은 액션에 존재하지 않는 task id를 가리킴. |
| `dependsOn.cycle` | error | task 간 `dependsOn` 그래프에 순환이 있음. 출력 메시지에 순환 경로 포함. |
| `parallel.interactive` | warning | `inputBox` / `quickPick` / `envPick` / `confirm` / `fileDialog` / `folderDialog` 같은 interactive task에 `parallel: true`가 붙음. 런타임은 prompt mutex로 다이얼로그를 강제 직렬화하므로 병렬 표시는 *post-prompt* 처리에만 적용되며, 사실상 효과가 없는 경우가 대부분. |

### 23.3. `dependsOn` / `parallel` 런타임 동작

`task.dependsOn`은 이제 런타임에서도 honored됩니다 — `parallel`과 함께 task graph를 구성해 DAG로 실행됩니다. 자세한 시맨틱은 [§24 병렬 실행 / Task DAG](#24-병렬-실행--task-dag) 참고. Doctor와 런타임은 **같은 `buildTaskGraph` + `detectGraphCycle`**을 공유하므로 cycle 검사는 단일 출처입니다 (`${taskId.x}` 자동 추론 의존성으로 만들어진 cycle도 양쪽에서 동일하게 잡힘). self/missing 검사는 doctor와 런타임이 각자의 사용자-facing 메시지를 제공하지만, 거부되는 입력은 같습니다.

### 23.4. 동작상 한계

- **메시지의 위치 정밀도**: AJV 에러는 JSON Pointer를 라인/컬럼으로 매핑하는 자체 워커(`src/doctor.ts` `locateJsonPointer`)가 처리합니다. 워커가 path를 따라가지 못하면 *가장 깊이 들어간 지점*으로 폴백하므로, 가끔 정확한 노드 대신 그 부모 라인이 표시될 수 있습니다. 그래도 점프 위치는 항상 해당 액션 내부.
- **`type: 'tool'` 경로 / `vscodeTask` label 매칭**은 현 범위에 없습니다. 두 기능 모두 actions 스키마에 아직 정식 진입하지 않았으며, 들어오는 시점에 Doctor 검사 항목으로 추가될 예정.
- **워크스페이스 외부 경로 검사는 실제 fs 접근 없이** path normalization만으로 판정합니다. 심볼릭 링크/`..` 트릭은 런타임 가드(`resolveWithinWorkspace`, [src/pipelineUtils.ts](../src/pipelineUtils.ts))가 최종적으로 막습니다.

### 23.5. 구현 메모

핵심 분석 로직은 `vscode`에 의존하지 않는 순수 모듈([src/doctor.ts](../src/doctor.ts))에 있고, 익스텐션 레이어는 (1) 워크스페이스/preset/번들 actions.json을 모두 모아 `DoctorInput[]`을 만들고 (2) 결과 `DoctorFinding[]`을 `vscode.Diagnostic`으로 변환해 publish 하는 두 역할만 합니다. AJV validator는 함수 파라미터로 주입되므로 같은 검사를 단위 테스트에서 그대로 돌릴 수 있습니다 — `src/test/doctor.test.ts`가 모든 finding code를 커버합니다.

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

> **출력 캡처가 필요할 때만**: shell task의 stdout을 `${buildF4.output}`처럼 다음 task 변수로 쓰려면 `passTheResultToNextTask: true`를 함께 두거나 `output.capture` 규칙으로 명시적으로 캡처해야 한다 ([§5 Output Capture](#output-capture) 참조). 그렇게 캡처된 변수를 다음 task가 참조하면 *자동 추론된 의존성*이 잡혀 `dependsOn`을 생략해도 같은 순서가 강제된다.

### 24.3. 자동 의존성 추론

task의 string 필드(`command`, `args`, `env` 값, `cwd`, `output.filePath`, `output.content`, 인터랙티브 prompt 등)에 `${taskId.x}` 형태의 참조가 있으면 그 `taskId`는 자동으로 의존성으로 잡힙니다. 이렇게 해야:

- `parallel: true`를 붙였더라도 출력을 참조하는 task가 먼저 실행되는 사고를 막을 수 있고,
- `dependsOn`을 잊어도 정확한 순서가 유지됩니다.

`${workspaceFolder}` / `${extensionPath}` 같은 reserved 이름과 `${env:BAR}` / `${input:foo}` 같은 reserved prefix(`env:`, `input:`)는 자동 추론에서 제외됩니다 — 같은 이름의 task가 존재하더라도 이 reference는 task가 아니라 빌트인으로 간주되어 가짜 의존성/사이클을 만들지 않습니다. `output.capture[].regex` / `output.diagnostics[].regex` 안의 `${…}` 리터럴도 정규식 패턴이지 변수 참조가 아니므로 제외.

> **현재 한계**: `${workspaceFolder}` / `${extensionPath}`는 런타임에 실제 경로로 치환되지만, `${env:VAR}` / `${input:foo}`는 *예약은 되어 있지만 아직 치환되지는 않습니다* — interpolation 단계를 통과해서 셸에 리터럴로 전달됩니다(대부분의 셸은 이를 그대로 인쇄). VS Code 빌트인과의 동일성은 향후 작업이며, 현재 권장은 `task.env.VAR`로 명시 주입하는 패턴입니다. reserved prefix는 그래프 정확성을 위한 안전장치이며 task id를 `env:` / `input:`로 시작하지 마세요.

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

`inputBox` / `quickPick` / `envPick` / `confirm` / `fileDialog` / `folderDialog`에 `parallel: true`를 붙이면 Doctor가 `parallel.interactive` warning을 보고합니다. 런타임은 그 task의 실행을 거부하진 않고, 대신 **prompt mutex**로 다이얼로그를 강제 직렬화합니다 — 즉 modal 두 개가 동시에 뜨는 일은 없으며, 사실상 그 task의 "병렬" 부분은 post-prompt 처리(capture 등)에만 적용됩니다. 대부분의 경우 `parallel: true`를 빼는 게 의도와 가깝습니다.

### 24.8. 그래프 검증

액션 진입 시 `validateTaskGraph`가 다음 조건을 거부하고 액션을 즉시 실패시킵니다:

- `dependsOn`이 자기 자신을 가리킴 (self-dependency)
- `dependsOn`이 같은 액션에 없는 task id를 가리킴 (missing-dependency)
- explicit / inferred / barrier 의존성 union에 순환이 있음 (cycle)

Doctor는 같은 `buildTaskGraph` + `detectGraphCycle` 헬퍼를 공유하므로 cycle 거부 조건이 런타임과 정확히 일치합니다. self/missing은 Doctor가 별도 메시지(액션 id 접두사 포함)로 보고하지만 거부되는 입력 집합은 같습니다.

### 24.9. 구현 메모

핵심 로직은 [src/pipelineUtils.ts](../src/pipelineUtils.ts)의 `buildTaskGraph` / `inferTaskDependencies` / `validateTaskGraph` / `TaskScheduler` / `withInteractivePromptLock`에 모여 있고, 모두 `vscode`에 의존하지 않는 순수 함수입니다. 실제 task 실행은 [src/extension.ts](../src/extension.ts) `executeActionPipeline`이 graph + scheduler를 소비하면서 `executeSingleTask`를 launching하는 형태로 짜여 있습니다. 단위 테스트는 [src/test/taskGraph.test.ts](../src/test/taskGraph.test.ts)가 graph 구성·자동 추론·cycle·scheduler lifecycle을, [src/test/pipelineUtils.test.ts](../src/test/pipelineUtils.test.ts)가 prompt mutex serialization을, [src/test/doctor.test.ts](../src/test/doctor.test.ts)가 `parallel.interactive` warning을 커버합니다.

---

## 25. 파일/폴더 다이얼로그 위치 기억

TaskHub가 여는 모든 파일/폴더 선택 다이얼로그는 **같은 용도로 마지막에 사용한 위치**에서 열립니다. `defaultUri`를 주지 않으면 VS Code가 자체 기본 규칙(대체로 최근 활성 파일 → 워크스페이스 루트, `files.dialog.defaultPath` 설정이 있으면 그쪽 우선)으로 위치를 정하는데, 그 기준은 TaskHub의 용도 구분과 무관하므로 Hex Viewer 열기가 방금 편집하던 소스 파일 폴더에서 열리는 식의 부자연스러운 동작이 나옵니다. 구현은 [src/dialogMemory.ts](../src/dialogMemory.ts)에 모여 있습니다.

### 25.1. 시작 위치 결정 순서

1. 호출자(또는 액션 JSON의 `options.defaultUri`)가 명시한 위치 — 실제로 존재할 때만.
2. 같은 용도(scope)로 마지막에 선택했던 디렉터리.
3. 활성 에디터가 속한 워크스페이스 폴더, 없으면 첫 워크스페이스 폴더.
4. 위 후보가 모두 없으면 `defaultUri` 없이 — VS Code 기본 동작.

기억된 경로는 열 때마다 존재 여부를 확인하므로, 폴더를 지우거나 옮겼으면 조용히 다음 후보로 내려갑니다.

저장은 workspace 상태와 global 상태 양쪽에 하며 읽을 때 workspace를 우선합니다. 프로젝트별로 다른 위치를 기억하되, 새 프로젝트에서 처음 여는 다이얼로그는 다른 창에서 쓰던 같은 용도의 위치를 물려받습니다.

**저장 크기 (0.6.33부터)**: 위치는 scope → 경로 맵 하나(`taskhub.dialogLocations`)에 담기고 **최대 100개**까지만 유지합니다. 넘으면 가장 오래 전에 기록된 것부터 버립니다. `fileDialog` / `folderDialog` scope는 액션 id로 만들어지므로 액션을 바꾸거나 지울 때마다 쓰이지 않는 scope가 남는데, 이전에는 정리 경로가 없어 global 상태에 계속 쌓였습니다. 0.6.32 이전 형식(scope당 키 하나)은 확장 활성화 시 한 번 흡수되고 옛 키는 삭제됩니다.

> 쓰이지 않는 scope를 **현재 열린 프로젝트의 액션 목록과 대조해** 지우는 방식은 쓰지 않습니다. global 상태는 창 사이에 공유되므로, 지금 열린 프로젝트에 없는 scope가 곧 죽은 scope인 것이 아닙니다 — 그 방식은 다른 프로젝트가 물려받아 쓰는 위치를 지워 위 "물려받기" 동작을 깨뜨립니다. 총량만 제한합니다.

### 25.2. 기억 단위 (scope)

용도가 다른 다이얼로그는 위치를 공유하지 않습니다. Hex Viewer / JSON Editor / Memory Map(ELF·Linker Listing·링커 스크립트·HTML 저장) / 즐겨찾기 추가 / 액션 Import·Export / Preset 저장이 각각 독립적으로 기억됩니다.

`fileDialog` / `folderDialog` 태스크([§5](#5-actions-패널-mainviewmain))는 **액션 id + 태스크 id 단위**로 기억합니다. 한 액션 안에서 "펌웨어 파일 고르기"와 "출력 폴더 고르기"를 연달아 하더라도 서로의 위치를 덮어쓰지 않습니다.

폴더 선택 다이얼로그는 고른 폴더 *자체* 를(같은 출력 폴더를 반복해 고르는 경우가 많으므로), 파일 선택은 고른 파일이 있던 폴더를 기억합니다. 취소하면 아무것도 갱신하지 않습니다.

### 25.3. 끄기

`taskhub.dialog.rememberLastLocation`을 `false`로 두면 저장도 복원도 하지 않습니다 ([§21 설정 레퍼런스](#21-설정-레퍼런스)). 구체적으로는 위 우선순위 표 전체가 꺼져 **TaskHub가 `defaultUri`를 지정하지 않으며**, 시작 위치 결정을 VS Code에 맡깁니다.

**VS Code가 그때 하는 일**: `defaultUri`가 없으면 VS Code가 자체 기본 규칙으로 위치를 정합니다 — 대체로 최근 활성 파일, 그다음 워크스페이스 루트를 따르며 `files.dialog.defaultPath` 설정이 있으면 그쪽이 우선합니다. **"창과 확장 프로그램이 공유하는 전역 최근 경로"가 아닙니다** (0.6.11~0.6.35의 설명이 그렇게 잘못 적혀 있었습니다). 정확한 순서는 VS Code 내부 구현이라 버전에 따라 달라질 수 있으므로 여기서 못박지 않습니다 — TaskHub 관점에서 보장하는 것은 "우리가 지정하지 않는다" 하나입니다.

예외는 두 가지입니다.

*   액션 JSON에 적어 둔 `options.defaultUri`는 그대로 존중합니다 — TaskHub의 추측이 아니라 액션 작성자의 명시적 지시이기 때문입니다.
*   저장 대화상자도 `defaultUri`를 지정하지 않으며, 이때 **제안 파일명도 함께 사라집니다** (0.6.35부터). VS Code API는 파일명만 제안하는 수단이 없어(`defaultUri` 하나뿐), 0.6.30~0.6.34처럼 파일명만 담은 상대 경로 Uri를 넘기면 파일시스템 루트를 지정하는 셈이 됩니다 — 설정 약속과 어긋나는 쪽이 파일명 제안보다 더 나쁩니다.

> 0.6.11~0.6.29에서는 이 설정이 `recall`/`remember` 안쪽에서만 확인돼, 꺼도 워크스페이스 폴더 폴백이 그대로 적용됐습니다. TaskHub가 여전히 `defaultUri`를 지정하고 있었으므로 VS Code의 자체 규칙은 실제로 쓰인 적이 없습니다. 0.6.30에서 구현을 고쳤고, 0.6.36에서 그 규칙이 무엇인지 정확히 적었습니다.

> **참고**: 액션 JSON의 `options.defaultUri`는 문자열로 작성하지만 VS Code API는 `Uri`를 요구하므로, TaskHub가 파일 경로로 해석해 승격시킵니다 (`scheme://` 형태만 URI로 파싱하므로 `C:\proj\build` 같은 Windows 경로가 드라이브 문자를 scheme으로 오인당하지 않습니다).
