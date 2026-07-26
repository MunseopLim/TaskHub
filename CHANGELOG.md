# Change Log

<!--
=====================================================================
릴리스 항목 작성 템플릿 (다음 릴리스부터 이 형식을 따른다)

## [X.Y.Z] - YYYY-MM-DD

### 수정 / 추가 / 변경 — 한 줄 요약 (대표 지적자나 범주를 붙여도 무방)

#### High (데이터 손실 / 신뢰 손상 / 호환성 깨짐)
- **짧은 제목**: 무엇이 / 왜 / UX 변경 여부. 참조 링크는 `[src/...](src/...)` 형태.

#### Medium (상태 무결성 / 명령 오동작)
- (동일 형식)

#### UX / 일관성
- (동일 형식)

**테스트**: 신규 N 케이스, 최종 M passing.

----- 원칙 -------------------------------------------------------------
1. 한 릴리스 블록 안에서 `#### 헤더`는 중복되지 않게 작성한다. 리뷰가 여러 차례
   있었더라도 동일 릴리스로 묶이면 High/Medium/UX로 일원화한다.
2. 테스트 수치는 "신규 X종" 형태로 쓰되, 릴리스 끝 "테스트 총괄" 줄과 일치시킨다.
3. 테스트/문서-only 커밋이 같은 릴리스에 섞일 수 있으나, 사용자에게 보이는 변경이
   없으면 릴리스 헤더를 새로 만들지 않는다.
4. 링크는 상대 경로(`src/...`)로 통일한다.
=====================================================================
-->

## [0.6.22] - 2026-07-27

### 수정 — 일괄 중지의 비동기 경합 (코드 리뷰 1/6, High)

#### High (0.6.13 회귀)

- **일괄 중지가 수동 종료 플래그를 너무 일찍 지우던 문제**: `taskhub.stopAllActions`가 `terminate()` 직후 `manuallyTerminatedActions`에서 대상 id를 동기적으로 삭제했다. 태스크 종료는 **비동기로** 도착하므로, 그때 실행되는 [executeAction](src/extension.ts)의 catch가 플래그를 보지 못해 사용자 요청 중지를 일반 실패로 처리했다. 개별 중지(`taskhub.stopAction`)는 플래그를 `finalizeActionRun`이 소비하도록 남기는데, 일괄 경로만 그 계약을 어겼다.
  - 증상 셋: **불필요한 실패 토스트**, 방금 기록한 **`Action stopped by user`가 종료 오류 메시지로 덮임**(0.6.13에서 고쳤다고 명시한 바로 그 문제가 일괄 경로에서 되살아남), **✗ 아이콘 잔존**.
  - 수정은 삭제 한 줄 제거에 그치지 않고 오케스트레이션을 `runStopAllActions()`로 분리했다. 이 함수의 의존성 표면(`StopAllActionsDeps`)에는 **플래그를 조작할 수단 자체가 없어**, 같은 회귀를 다시 만들 수 없다. 플래그 소유권은 `finalizeActionRun` 하나로 유지된다.
- **취소해도 터미널이 닫히던 문제**: 호환 명령 `taskhub.terminateAllActions`가 중지 확인 창을 취소한 뒤에도 터미널을 닫았다. `runStopAllActions`가 `'cancelled'`를 돌려주고, 호환 명령은 그때 아무것도 하지 않는다.

**테스트**: 신규 9 케이스([src/test/stopActions.test.ts](src/test/stopActions.test.ts) — 대상 없음/1개/다수 분기, 취소 시 무중지·트리 미갱신·취소 결과 반환, 전부 실패 시 `failed`와 히스토리 미기록, 일부 실패 시 성공분만 기록, 그리고 **의존성 표면에 플래그 조작 수단이 없음을 고정하는 회귀 봉쇄 테스트**), 최종 1610 passing.

## [0.6.21] - 2026-07-26

### 변경 — Memory Map 웹뷰 지역화 · 접근성 (UX 리뷰 6/6 완료)

#### 변경 (지역화)

- **Memory Map 웹뷰 UI가 VS Code 언어 설정을 따른다**: 헤더(`Entry Point`), 버튼(`Copy Report` / `Copy Full Dump` / `Save HTML`), 검색, 섹션 제목(`Memory Regions` / `Region Details` / `All Sections`), 개요·섹션 표의 열 이름, *모두 펼치기/접기*. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `buildMemoryMapStrings`.
  - **리포트 본문은 영어로 유지한다**: *Copy Report* / *Copy Full Dump* 산출물은 이슈·커밋 메시지·문서에 붙여 남과 공유하는 물건이라, 편집기 언어를 따라가는 것보다 문구가 안정적인 편이 낫다고 판단했다. 지역화 범위는 그것을 둘러싼 UI로 한정한다.
  - 반대 방향의 결함도 함께 정리: *맨 위로* 버튼 title이 **한국어로 하드코딩**돼 영어 사용자에게도 한국어가 보였다.

#### 추가 (접근성)

- **열 정렬을 키보드로**: All Sections 표의 머리글이 클릭 전용이었다. `tabindex`로 포커스를 받고 Enter/Space로 같은 정렬을 실행한다.
- **`aria-sort` 갱신**: 정렬 방향을 ▲/▼ 글리프로만 표시해, 스크린리더는 어떤 열로 어떤 방향 정렬됐는지 알 수 없었다. 정렬 시 대상 열은 `ascending`/`descending`, 나머지 열은 `none`으로 갱신하고 title도 다음 동작을 안내하도록 바꾼다.
- **live region**: 검색 결과 개수와 영역 매치 정보가 `role="status"` + `aria-live="polite"`.
- **`aria-label`**: 아이콘 전용 버튼 `◀` / `▶` / `↑`, 검색 입력, Function 열 토글.
- **`aria-expanded`**: *모두 펼치기 / 모두 접기* 버튼이 현재 상태를 노출한다.
- **중복 낭독 제거**: 사용량 막대(`bar-bg`, 개요 표의 `mini-bar`)는 같은 수치가 이미 텍스트로 있으므로 `aria-hidden`. 표의 시각적 구분용 빈 열도 마찬가지.

**테스트**: 신규 15 케이스([src/test/memoryMapWebviewA11y.test.ts](src/test/memoryMapWebviewA11y.test.ts) — 실제 ELF 픽스처로 패널을 열어 렌더된 HTML을 검사. 번들 완전성·`S.*` 참조 대조, 지역화 범위(UI는 번역 / 리포트 본문은 영어 유지 / 하드코딩 한국어 부재), aria-sort·키보드 정렬·live region·aria-expanded·막대 aria-hidden), 최종 1601 passing.

> 웹뷰 3종(JSON Editor 0.6.19, Hex Viewer 0.6.20, Memory Map 0.6.21) 모두 같은 방식 — 호스트가 로케일을 해석해 문자열 번들을 주입하고, 각 웹뷰 테스트가 `S.*` 참조와 번들의 정합을 자동 대조한다. `package.nls.json`(명령·설정 제목 지역화)은 별도 과제로 남겨 둔다.

## [0.6.20] - 2026-07-26

### 변경 — Hex Viewer 웹뷰 지역화 · 접근성 (UX 리뷰 6/6, 2/3)

#### 변경 (지역화)

- **Hex Viewer 웹뷰 문자열이 VS Code 언어 설정을 따른다**: 헤더(`Format` / `Size` / `Range` / `Entry`), 툴바(`Unit` / `Endian` / `Go to` / `Go` / `Find`), 찾기 바, 상태 표시줄(`Address` / `Value` / `no data` / `Selected: N bytes`), `No matches`. 0.6.19의 JSON Editor와 동일하게 호스트가 번들을 주입하는 방식이며 `<html lang>`도 맞춘다. 참조: [src/hexViewer.ts](src/hexViewer.ts) `buildHexViewerStrings`.
  - `Little-Endian` / `ASCII` / `u8` 같은 짧은 기술 식별자와 예시 입력값(`0x08000000 / 1024`, `20020000`)은 프로젝트 i18n 규칙대로 번역 대상에서 제외했다.

#### 추가 (접근성)

- **폼 라벨 연결**: `Unit:` / `Endian:` / `Go to:` 는 `for` 없이 떠 있는 `<label>`이라 스크린리더에서 컨트롤과 묶이지 않았다 — 사용자는 "콤보 상자"라는 것만 듣고 무엇을 고르는지 알 수 없었다. 이제 `for`/`id`로 연결된다. 테스트가 *for 없는 label이 하나도 남지 않았는지* 검사한다.
- **placeholder만 있던 컨트롤에 `aria-label`**: 찾기 입력과 찾기 방식 select. placeholder는 접근 가능한 이름이 아니고 입력을 시작하면 사라진다.
- **아이콘 전용 버튼에 `aria-label`**: `◀` / `▶` / `✕`.
- **live region**: 찾기 결과 개수(`3 / 128`, `결과 없음`)와 바이트 검사 결과가 `role="status"` + `aria-live="polite"`로 노출된다. 이전에는 조용히 바뀌어 검색 성패를 알 수 없었다.
- **표 구조**: 열 머리글에 `scope="col"`, 시각적 구분용 빈 열에는 `aria-hidden="true"` — 빈 칸을 읽느라 표 탐색이 길어지지 않게.

**테스트**: 신규 15 케이스([src/test/hexViewerWebviewA11y.test.ts](src/test/hexViewerWebviewA11y.test.ts) — 번들 완전성·`S.*` 참조 대조, `for` 연결과 고아 label 부재, aria-label·live region, 표 scope/aria-hidden, 기술 식별자 비번역 확인), 기존 hexParser 테스트 1건을 문구 대신 동작 기준으로 갱신, 최종 1586 passing.

## [0.6.19] - 2026-07-26

### 추가 / 변경 — JSON Editor 웹뷰 지역화 · 접근성 (UX 리뷰 6/6, 1/3)

#### 변경 (지역화)

- **JSON Editor 웹뷰의 모든 문자열이 VS Code 언어 설정을 따른다**: 확장 본체는 `t(ko, en)`로 두 벌을 제공하는데 웹뷰 안쪽은 `Save` / `Reload` / `+ Row` / `● Modified` 등이 영어로 고정돼 있었다. 호스트가 로케일을 한 번 해석해 문자열 번들을 웹뷰로 주입하는 방식으로 바꿨다 — 웹뷰 스크립트에는 이제 하드코딩된 라벨이 없다. `<html lang>` 속성도 함께 맞춘다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `buildJsonEditorStrings`.
  - 셀 JSON 오류·기록 복원 실패·스크립트 오류 같은 런타임 메시지도 `{placeholder}` 치환 방식으로 지역화해, 언어별 어순 차이를 수용한다.

#### 추가 (접근성)

- **키보드로 행 순서 변경**: `Alt+↑` / `Alt+↓`. 재정렬은 마우스 드래그 전용이라 키보드만으로는 아예 불가능했다. 행 왼쪽 `⠿` 그립을 실제 `button`으로 만들어 Tab으로 도달할 수 있게 하고, VS Code의 *줄 이동* 과 같은 조합을 쓴다. 이동 후 포커스가 옮겨진 행을 따라가므로 연속 이동이 가능하고, 결과는 live region으로 알린다.
  - 그립에 `draggable="true"`를 유지해 기존 마우스 드래그 경로를 보존했다 — 브라우저는 상호작용 컨트롤에서 상위 요소의 드래그를 시작하지 않으므로, 이 속성이 없으면 그립을 잡아 끄는 동작이 깨진다.
- **아이콘 전용 버튼에 `aria-label`**: ↶ ↷ ✕ ⠿ a→s s→a. 삭제·이동 라벨에는 행 번호가 들어간다(*3번 행 삭제*).
- **live region**: 수정 표시는 `role="status"`, 오류 메시지는 `role="alert"`. 아이콘만 있는 열 머리글(순서 변경 / 행 번호 / 작업)에는 `sr-only` 이름을 넣고 `th`에 `scope="col"`을 붙였다. 시트 탭은 `role="tab"` + `aria-selected` + Enter/Space 활성화를 지원한다.

**테스트**: 신규 12 케이스([src/test/jsonEditorWebviewA11y.test.ts](src/test/jsonEditorWebviewA11y.test.ts) — 번들 완전성과 플레이스홀더 정합, **웹뷰가 참조하는 `S.*` 키가 번들에 실재하는지 자동 대조**(누락 시 화면에 `undefined`가 찍히는 것을 차단), aria-label·live region·`lang` 속성, 키보드 재정렬 경로와 마우스 드래그 보존), 최종 1571 passing.

> 남은 웹뷰: Hex Viewer, Memory Map. 같은 방식으로 버전을 나눠 진행한다.

## [0.6.18] - 2026-07-26

### 추가 — 액션 생성 전 확인 단계 (UX 리뷰 4/6 완료)

#### 추가 (UX)

- **저장 전 확인 modal**: 마법사는 마지막 프롬프트가 끝나면 곧바로 `.vscode/actions.json`에 썼다. 이제 쓰기 직전에 확인을 받으며, 취소하면 파일은 전혀 건드리지 않는다(액션 삽입은 메모리 배열에만 일어난 상태). 참조: [src/extension.ts](src/extension.ts) `confirmWizardAction`.
  - **자동 도출된 `id`를 보여준다** — 지금까지는 파일을 열어야만 확인할 수 있었다. 이 값은 `taskhub.runAction.<id>` 커맨드 이름이 되어 사용자의 `keybindings.json`에 노출되므로, 생성 후에 바꾸면 단축키가 조용히 깨진다.
  - 저장 위치와 task 목록을 함께 표시(최대 8줄, 초과분은 개수로 접힘). `quickPick`은 항목 목록을, `inputBox`는 prompt 문구를 요약에 쓴다.
  - **Doctor를 저장 전에 돌린다**: 파일 전체를 린트하되 *새 액션이 새로 만들어 낸 문제만* 보고한다. 기존 액션이 원래 갖고 있던 경고까지 새 액션 탓으로 보이면 확인 단계가 소음이 되기 때문. 비교는 (code, message) 다중집합 기준 — 액션을 삽입하면 뒤쪽 finding의 줄 번호가 전부 밀리므로 range로 비교하면 무관한 경고가 전부 "새 경고"로 둔갑한다.
  - *자세히 보기* 버튼은 저장될 JSON 전문 + Doctor 결과(주석) + [Preview Run](docs/features.md) 전체 시뮬레이션을 임시 문서로 연다. 문서를 열어도 확인 창으로 되돌아오므로 결정이 유실되지 않는다.
  - 검사기 예외는 생성을 막지 않는다 — 점검은 참고용이고, 실패는 Output 채널에만 남는다.

**테스트**: 신규 15 케이스([src/test/wizardReview.test.ts](src/test/wizardReview.test.ts) — finding 차분(중복 다중도·줄 밀림·감소 케이스), modal 본문(id 노출·위치·task 요약·심각도 집계·로케일별 메시지·8줄 접기), 미리보기 문서(JSON 전문 파싱 가능성·점검 결과가 주석인지)), 최종 1559 passing.

## [0.6.17] - 2026-07-26

### 추가 — 액션 생성 템플릿 2종 → 6종 (UX 리뷰 4/6, 후반부 1/2)

#### 추가 (UX)

- **생성 마법사 템플릿 확장**: 스키마에는 13가지 task 타입이 있지만 마법사는 `shell`과 `fileDialog` 둘만 보여줬다. 나머지 대화형 타입과 다단계 파이프라인은 문서를 읽거나 예제 JSON을 뒤져야 존재를 알 수 있었다. 참조: [src/extension.ts](src/extension.ts) `ACTION_TEMPLATES`.
  - **Folder Picker + Shell** (`folderDialog` → `shell`) — 기존 파일 선택 템플릿의 빠진 짝.
  - **Text Input + Shell** (`inputBox` → `shell`) — 실행 시점에 값을 받아 `${input.value}`로 끼워 넣는다.
  - **Choice List + Shell** (`quickPick` → `shell`) — 쉼표로 입력한 목록에서 고르게 하고 `${choice.value}`로 참조. 공백·빈 항목·중복은 자동 정리.
  - **Multi-step Pipeline** (`shell` × N) — `step1`…`stepN`. 1단계는 필수, 2단계부터는 빈 값 Enter로 종료(Esc는 마법사 전체 취소), 최대 10단계.
  - 대화형 task가 포함된 템플릿은 명령어 입력란에 참조 변수를 미리 채워 준다 — 변수 이름을 외우지 않아도 되게.
  - 단일 쉘 템플릿의 예시 문구를 `e.g. npm run build, make flash, ctest`로 넓혔다.

> **리뷰 원안과의 차이**: 원 리뷰는 `Build` / `Test` / `Script` / `Open Folder` 추가를 제안했다. 그러나 앞의 셋은 생성되는 JSON이 단일 `shell` 하나로 기존 *Single Shell Command* 와 구조가 동일하고 명령어 문자열만 다르다 — 템플릿을 늘리는 게 아니라 placeholder를 바꾸는 일이라, 목록만 길어지고 배울 것은 없다. 그래서 **구조가 서로 다른 템플릿만** 추가하고 Build/Test 류는 예시 문구로 흡수했다. 테스트가 이 원칙(단일 shell 템플릿은 하나뿐)을 회귀 가드로 고정한다.

#### 내부

- 템플릿의 task 조립을 프롬프트에서 분리(`buildTasks`)해 순수 함수로 만들었다. 프롬프트 체인을 구동하지 않고도 생성되는 JSON을 검증할 수 있다.

**테스트**: 신규 20 케이스([src/test/actionTemplates.test.ts](src/test/actionTemplates.test.ts) — 템플릿별 출력 구조, 선택지 파싱(공백/빈 항목/중복), 구조 중복 금지 가드, 그리고 **6개 템플릿의 생성 결과를 `actions.schema.json`으로 검증**해 마법사가 자기 스키마를 위반하는 회귀를 차단), 최종 1544 passing.

## [0.6.16] - 2026-07-26

### 수정 — `showTaskStatus=false`가 재렌더에도 유지되도록 (UX 리뷰 5/6)

#### 수정

- **꺼 둔 상태 아이콘이 트리를 다시 그릴 때마다 되살아나던 문제**: 설정은 실행 직후의 `mainViewProvider.refresh()` 호출만 억제했을 뿐, `Action` TreeItem은 설정을 보지 않고 `actionStates`에서 아이콘·진행률을 그렸다. 폴더를 접었다 펴거나 파일 워처가 트리를 갱신하면 상태 표시가 그대로 돌아왔다. 이제 provider가 렌더 패스마다 설정을 한 번 읽어 각 행에 전달한다. 참조: [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts).
- **설정을 바꿔도 즉시 반영되지 않던 문제**: `taskhub.showTaskStatus` 변경 시 트리를 새로 그린다. 이전에는 다른 이유로 refresh가 일어날 때까지 이전 모습이 남았다.

#### 설계 메모

- 가려지는 것은 **겉모습(`iconPath` / `description`)뿐**이고 `contextValue`는 실제 실행 상태를 유지한다. 상태 표시를 껐다고 실행 중인 액션의 인라인 *중지* 버튼이 사라지면 안 되기 때문 — 0.6.13에서 *Stop All Actions* 노출을 이 설정과 독립시킨 것과 같은 판단이다. 원 리뷰는 "실행 중복 방지 상태와 화면 표시 상태를 분리하라"고 제안했으나 그 분리는 [extension.ts](src/extension.ts) `markActionAsRunning`에 이미 주석까지 달려 구현되어 있었고, 실제 결함은 렌더 게이트 누락이었다.
- 아이콘 선택 로직이 두 갈래(상태 있음 / 없음)로 중복돼 있던 것을 `defaultActionIcon()` 하나로 합쳤다.

**테스트**: 신규 8 케이스([src/test/showTaskStatus.test.ts](src/test/showTaskStatus.test.ts) — off/on × running/success/failure 렌더, contextValue 보존, 인자 생략 시 기본값, 실제 설정을 켠 provider 배선과 재렌더 안정성), 최종 1524 passing.

## [0.6.15] - 2026-07-26

### 추가 / 변경 — 빈 상태 안내와 제목 표시줄 정리 (UX 리뷰 4/6, 전반부)

#### 추가 (UX)

- **빈 상태 안내(`viewsWelcome`)**: Actions / Workspace Links / Favorite Files 패널이 비어 있을 때 아무것도 없는 회색 영역 대신 다음 단계를 제안한다. 폴더를 열지 않은 상태에는 *Open Folder* 를, 폴더는 열렸지만 액션이 없으면 *Create Action* / *Browse Examples* / *Import Actions…* 를 노출한다. 0.6.14에서 번들 예제가 자동으로 감춰지기 시작했으므로 그 자리를 메우는 안내가 함께 필요했다.

#### 변경 (UX)

- **확장 버전 행을 트리에서 뷰 제목 옆으로 이동**: 버전은 목록 첫 줄을 상시 차지했고 — 더 중요하게 — 그 행 때문에 **트리가 절대 비지 않아 welcome 뷰가 구조적으로 뜰 수 없었다**. 이제 `Actions 0.6.15`처럼 제목 옆 muted 텍스트로 표시하고, CHANGELOG는 제목 표시줄 `…` 메뉴에서 연다. 참조: [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts), [src/extension.ts](src/extension.ts).
- **제목 표시줄 아이콘 5개 → 3개**: *Create Action* / *Edit actions.json* / *Stop All Actions*(실행 중에만)만 아이콘으로 남기고 예제 보기 · Import · Export · 터미널 닫기 · Changelog는 `…` 오버플로 메뉴로 옮겼다.
  - 원 리뷰는 *생성* 하나만 남기라고 제안했으나, `actions.json` 편집은 기존 프로젝트에서 매일 쓰는 경로라 아이콘으로 유지했다. 나머지(예제·Import)는 대개 프로젝트당 한 번 쓰는 온보딩 동작이다.

#### 수정

- **`actions.json` 로드 실패가 "액션 없음"으로 보이던 문제**: 파싱/스키마 오류 시 토스트만 띄우고 트리는 사실상 비워, 새 welcome 뷰와 결합하면 액션 200개짜리 파일을 가진 사용자에게 *첫 액션을 만드세요* 가 뜰 수 있었다. 이제 실패 이유를 단 에러 행을 표시하고, 클릭하면 해당 파일이 열린다.

**테스트**: 신규 9 케이스([src/test/emptyState.test.ts](src/test/emptyState.test.ts) — 빈 트리/버전 행 부재/로드 실패 행/복구, manifest의 welcome 명령 실재성·폴더 미개방 분기·아이콘 개수 상한), 기존 IT-023 및 progress 계열 6종의 인덱스 갱신, 최종 1516 passing.

## [0.6.14] - 2026-07-26

### 변경 — 번들 예제 액션을 내 프로젝트 목록에서 분리 (UX 리뷰 3/6)

#### UX / 일관성

- **확장에 번들된 예제 액션(`defaultButton.*`)이 더 이상 모든 프로젝트에 상주하지 않는다**: [media/actions.json](media/actions.json)의 데모 액션은 조건 없이 병합되어, 자기 `actions.json`을 갖춘 프로젝트에서도 Build/Flash 사이에 *Show Environment Variable* 같은 항목이 섞였고 끄는 수단도 없었다. 새 설정 `taskhub.builtinActions` (기본 `auto`)가 이를 가른다. 참조: [src/extension.ts](src/extension.ts) `shouldIncludeBuiltinActions`.
  - `auto`: 워크스페이스 액션도 프리셋도 없는 동안에만 표시 — 예제는 온보딩 역할을 하고, 프로젝트가 자기 액션을 갖는 순간 비켜난다.
  - `always`: 0.6.14 이전 동작 (무조건 병합). `never`: 빈 프로젝트에서도 감춤.
  - 예제가 숨겨지면 **id 충돌 검사 대상에서도 빠진다** — 자기 액션에 `defaultButton.showEnv` 같은 id를 써도 더 이상 막히지 않는다. 파일 읽기 자체를 건너뛴다.
  - 설정을 바꾸면 액션 캐시와 동적 `taskhub.runAction.<id>` 등록이 즉시 갱신된다.
- 문서: [docs/features.md §3](docs/features.md)에 *액션 소스와 병합 우선순위* 절을 추가해 워크스페이스 / 프리셋 / 번들 예제 세 소스와 우선순위를 한 곳에 정리했다.

> **리뷰 원안과의 차이**: 원 리뷰는 액션마다 `Workspace · firmware` / `Preset · stm32` / `Built-in` 출처 배지를 붙이자고 제안했다. 그러나 사용자가 신경 써야 할 것은 자기 프로젝트뿐이고, 실제 문제는 "출처를 모른다"가 아니라 **"내가 넣지 않은 항목이 목록에 있다"** 였다. 라벨을 붙여 계속 인지시키는 대신 원인을 제거하는 쪽을 택했다. 멀티루트 구분은 배지가 아니라 VS Code Explorer와 같은 **폴더 단위 그룹핑**으로 별도 처리 예정.

**테스트**: 신규 9 케이스([src/test/builtinActions.test.ts](src/test/builtinActions.test.ts) — 3-way 모드 × 소스 조합 결정표, manifest enum/기본값, 번들 파일 존재), 최종 1508 passing.

## [0.6.13] - 2026-07-26

### 변경 / 수정 — 실행 중지와 터미널 닫기 분리 (UX 리뷰 2/6)

#### UX / 일관성

- **종료 버튼이 실행 중일 때만 보인다**: Actions 제목 표시줄의 사각형 버튼은 실행 중인 액션이 하나도 없어도 항상 노출됐다. 새 context key `taskhub.hasRunningActions`를 실행 상태 전이(`markActionAsRunning` / `finalizeActionRun` / 중지 명령)마다 갱신해 조건부로 노출한다. 설정 `taskhub.showTaskStatus`와는 무관하게 동작한다 — 상태 아이콘을 꺼 둔 사용자도 폭주하는 빌드를 멈출 수단은 필요하다. 참조: [src/extension.ts](src/extension.ts) `collectRunningActionIds`.
- **`실행 중지`와 `터미널 닫기`를 별도 명령으로 분리**: 기존 `taskhub.terminateAllActions`는 액션을 중지하면서 `TaskHub: ` 터미널을 전부 닫아, 결과를 읽고 있던 터미널까지 사라졌다.
  - `taskhub.stopAllActions` (제목 표시줄 아이콘): 실행 중인 액션만 중지. 터미널은 그대로 둔다.
  - `taskhub.closeAllTerminals` (제목 표시줄 `…` 메뉴 / Command Palette): TaskHub 터미널만 닫는다. 실행에는 영향 없음.
  - `taskhub.terminateAllActions`는 기존 `keybindings.json` 호환을 위해 **등록만 유지**하고(중지 후 터미널 닫기) 메뉴·팔레트에서는 숨겼다.
- **중지 대상과 개수를 먼저 보여준다**: 중지할 액션이 2개 이상이면 이름을 나열한 modal로 확인을 받는다(5개까지 나열, 나머지는 "외 N개"). 잊고 있던 장시간 빌드를 실수로 죽이는 경우를 막는다.

#### 수정

- **일괄 중지된 액션의 히스토리가 `실행 중`으로 남던 문제**: `executeAction`은 수동 종료된 id의 히스토리 마감을 건너뛰는데, 개별 중지(`taskhub.stopAction`)만 이를 보완하고 일괄 종료는 하지 않았다. 그 결과 History 패널에 스피너가 영구히 남고, Run Any Action 팔레트의 최근 실행 배지도 계속 `실행 중`으로 표시됐다. 이제 두 경로가 같은 `recordManualStopInHistory`를 쓴다.
- **일괄 중지가 완료된 액션의 결과 아이콘까지 지우던 문제**: 예전 구현은 `actionStates.clear()`로 전체를 비워, 중지와 무관하게 이미 끝난 액션의 ✓/✗ 표시도 사라졌다. 이제 실제로 중지된 id만 정리한다.

**테스트**: 신규 12 케이스([src/test/stopActions.test.ts](src/test/stopActions.test.ts) — 실행 목록 계산, 확인 문구 접기/로케일, manifest의 `when` 절·메뉴 배치 회귀 가드), 최종 1499 passing.

## [0.6.12] - 2026-07-26

### 변경 — Run Any Action의 *Recently used*를 History에서 유도 (UX 리뷰 1/6)

#### UX / 일관성

- **팔레트의 "최근 실행"이 실제 최근 실행을 반영한다**: `TaskHub: Run Any Action…`은 그동안 팔레트에서 고른 항목만 자체 MRU 목록(`globalState`의 `taskhub.runAnyAction.mru`)에 기록했다. 그래서 왼쪽 트리에서 열 번 실행한 액션이 *Recently used*에 뜨지 않았고, 팔레트를 쓰지 않는 사용자에게는 섹션이 영원히 비어 있었다. 이제 목록을 **History에서 유도**하므로 트리 클릭 / 키바인딩(`taskhub.runAction.<id>`) / History 재실행 / 팔레트 선택이 하나의 순서로 합쳐진다. 참조: [src/providers/historyProvider.ts](src/providers/historyProvider.ts) `deriveRecentActionRuns`, [src/extension.ts](src/extension.ts) `taskhub.runAnyAction`.
  - **프로젝트 간 누수 해소**: 옛 MRU는 `globalState`(전역)에 액션 ID만 저장해, 다른 프로젝트에서 실행한 것과 같은 ID가 이 프로젝트의 *최근 실행*처럼 보일 수 있었다. History는 `workspaceState`(워크스페이스 단위)이므로 구조적으로 섞이지 않는다.
  - **마지막 실행 정보 표시**: 최근 행 둘째 줄에 `14:30 · 1.2s`, 실패면 `실패 · 14:30 · 1.2s`, 진행 중이면 `실행 중`이 붙는다. 폴더 breadcrumb은 첫째 줄에 그대로 둬 `matchOnDescription` 검색이 오염되지 않는다.
  - 같은 액션의 반복 실행은 가장 최근 기록 하나로 접히고, Memory Map / Hex / JSON Editor 열람 기록(tool 항목)은 실행 가능한 액션이 아니므로 최근 섹션에서 제외된다. 삭제된 액션 필터링은 종전과 동일.
  - 히스토리 보관량(`taskhub.history.maxItems`, 기본 10)이 `recentLimit`의 실질 상한으로 작용한다 — 문서에 명시.
  - 은퇴한 `taskhub.runAnyAction.mru` 전역 키는 활성화 시 1회 정리한다. `updateRunAnyActionMru` 헬퍼와 그 테스트(IT-093 ~ IT-097)는 제거.

**테스트**: 신규 20 케이스([src/test/runAnyActionRecents.test.ts](src/test/runAnyActionRecents.test.ts) — 유도 순서·중복 접힘·tool 제외·detail 포맷·History→팔레트 종단 경로), 제거 5 케이스, 최종 1487 passing.

## [0.6.11] - 2026-07-26

### 추가 / 변경 — 파일·폴더 다이얼로그가 마지막 위치를 기억

#### UX / 일관성

- **다이얼로그 위치 기억**: TaskHub가 여는 모든 파일/폴더 선택 다이얼로그가 **같은 용도로 마지막에 사용한 위치**에서 열린다. 이전에는 `defaultUri`를 주지 않아 VS Code의 전역 최근 경로(창·확장 프로그램 공유)에서 열렸고, 그 결과 Hex Viewer 열기가 방금 다른 프로젝트에서 편집하던 폴더에서 시작하는 일이 있었다. 시작 위치는 `호출자 지정 → 같은 scope의 마지막 위치 → 활성 에디터의 워크스페이스 폴더 → 첫 워크스페이스 폴더` 순으로 정해지며, 기억된 폴더가 삭제됐으면 조용히 다음 후보로 내려간다. 참조: [src/dialogMemory.ts](src/dialogMemory.ts).
  - 용도별로 분리 기억: Hex Viewer / JSON Editor / Memory Map(ELF·Listing·링커 스크립트·HTML 저장) / 즐겨찾기 추가 / 액션 Import·Export / Preset 저장. `fileDialog`·`folderDialog` 태스크는 **액션 id + 태스크 id 단위**로 기억해, 한 액션 안의 "펌웨어 파일 고르기"와 "출력 폴더 고르기"가 서로의 위치를 덮어쓰지 않는다.
  - 저장 다이얼로그는 폴더만 기억하고 파일명은 호출부의 제안값을 유지한다 — 같은 종류의 산출물을 늘 같은 폴더로 내보내는 흐름에서 매번 폴더를 다시 찾아가지 않는다.
  - 폴더 선택은 고른 폴더 자체를, 파일 선택은 고른 파일의 상위 폴더를 기억한다. 취소하면 갱신하지 않는다. workspace 상태와 global 상태 양쪽에 저장하고 읽을 때 workspace를 우선하므로, 프로젝트별로 위치가 갈리되 새 프로젝트의 첫 다이얼로그는 다른 창에서 쓰던 위치를 물려받는다.
- **새 설정 `taskhub.dialog.rememberLastLocation`** (기본 `true`): `false`로 두면 저장도 복원도 하지 않고 VS Code 기본 동작으로 되돌아간다. 자세한 내용은 [docs/features.md §25](docs/features.md).

#### 수정

- **`fileDialog` / `folderDialog` 태스크의 `options.defaultUri`가 실제로 적용됨**: 액션 JSON에는 문자열로 쓰지만 VS Code API는 `Uri`를 요구해 그동안 조용히 무시되고 있었다. 이제 파일 경로로 해석해 승격시킨다. `scheme://` 형태만 URI로 파싱하므로 `C:\proj\build` 같은 Windows 경로가 드라이브 문자를 scheme으로 오인당하지 않는다. 참조: [src/extension.ts](src/extension.ts).
- **`folderDialog`가 `task.options`를 직접 변형하던 문제**: `canSelectFiles` / `canSelectFolders`를 원본 객체에 써넣는 대신 복사본에 적용한다.

#### 의존성

- `adm-zip` `0.5.17` → `0.6.0` (Node 엔진 요구사항 `>=12.0` → `>=14.0`).

**테스트**: 신규 32 케이스([src/test/dialogMemory.test.ts](src/test/dialogMemory.test.ts) — 시작 위치 우선순위, 선택 결과 기억, scope 분리, 설정 off, 실제 Memento/디스크 경로), 최종 1472 passing.

## [0.6.10] - 2026-06-27

### 추가 / 변경 — History 실행 명령 보기 · 저장된 입력 재사용 · 의존성 엔진 정합

#### 추가 (History)

- **실행한 명령 보기 (View Executed Command)**: `command` / `shell` task가 실제로 실행한 명령줄을 `${...}` 치환(선택한 디렉터리 등 포함)이 끝난 상태로 히스토리에 함께 기록한다. 명령이 기록된 항목의 터미널 아이콘을 누르면 **재실행 없이** task ID별 명령줄을 읽기 전용 문서로 확인할 수 있다(출력 보기와 별개 — 결과가 아니라 실행한 명령 자체). 문서 생성 로직은 순수 함수 `formatExecutedCommandsDocument`로 분리. 참조: [src/extension.ts](src/extension.ts), [src/providers/historyProvider.ts](src/providers/historyProvider.ts).
  - `HistoryEntry`에 `commands` 필드와 `setHistoryCommands()` 추가, contextValue를 조합형 토큰(`historyItem.inputs.output.commands`)으로 재설계해 메뉴 `when` 절이 정규식으로 각 capability를 독립 매칭하도록 변경.

#### 변경 (UX)

- **History 기본 클릭 재실행이 저장된 입력을 재사용**: 히스토리 항목을 클릭해 재실행하면 직전에 선택한 입력(예: `folderDialog`로 고른 디렉터리)을 그대로 재사용하고 다이얼로그를 다시 띄우지 않는다. 이전에는 기본 클릭이 항상 다이얼로그를 재프롬프트했다(저장값 재사용은 별도 인라인 버튼에서만 가능). 입력을 새로 고르려면 원본 액션을 실행한다. 참조: [src/extension.ts](src/extension.ts).

#### 수정 (의존성 / 엔진)

- **EBADENGINE 경고 해소**: `npm-run-all2`가 v9(Node `>=22.22.2` 요구)로 설치돼 현재 런타임(Node 22.20.0)과 어긋나 npm-run-all2와 하위 의존성에서 EBADENGINE 경고가 연쇄 발생했다. v9의 `latest` 태그는 구버전 Node를 지원하는 v8 라인이므로 `^8.0.4`로 고정(이 패키지는 `watch` 스크립트 한 곳에서만 사용). `@vscode/test-cli`는 `^0.0.15`로 갱신. `@types/node`는 런타임 Node 22와 맞춰 `22.x` 유지.

**테스트**: 신규 13 케이스(commands 기록·영속화·실패 경로, contextValue 조합, `formatExecutedCommandsDocument`, folderDialog 재사용/대조군), 최종 1,436 passing.

## [0.6.9] - 2026-06-10

### 수정 — Preview/Doctor 워크스페이스 판정을 런타임 규칙과 완전 일치 (0.6.8 후속)

#### Medium (도구 정합성)

- **심링크 escape 거짓 음성**: 0.6.8에서 런타임 `resolveWithinWorkspace`는 realpath 정규화로 심링크 escape를 거부하게 됐지만, Preview/Doctor의 `isInsideWorkspace`는 어휘적 비교만 유지해 같은 경로가 Preview에서 안전해 보이다가 런타임에서 거부되는 불일치가 생겼다. 판정 술어(`isInsideWorkspaceRoots`)를 [src/pipelineUtils.ts](src/pipelineUtils.ts)로 추출해 런타임·Preview·Doctor가 공유. 참조: [src/previewRun.ts](src/previewRun.ts), [src/doctor.ts](src/doctor.ts).
- **null byte·빈 경로 가드**: 런타임은 null byte 경로를 거부하지만 공유 술어에는 해당 가드가 빠져 `a\u0000b.txt` 같은 경로가 같은 방식으로 어긋났다. null byte·빈 경로 가드를 술어에 추가해 런타임의 모든 거부 규칙(입력 가드, 빈 루트, Windows 예약 디바이스명, realpath 격리)과 패리티 확보. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts).

**테스트**: 신규 3 케이스(Preview/Doctor 심링크 escape, 런타임 거부 규칙 전수 대조), 최종 1,408 passing.

## [0.6.8] - 2026-06-10

### 수정 — 워크스페이스 격리 강화 · Hex Find/호버 성능 (전수 리뷰 M10~M12)

#### High (보안 경계)

- **워크스페이스 격리 심링크 우회 차단**: `resolveWithinWorkspace`가 어휘적 경로 비교만 수행해 워크스페이스 내부의 외부 지향 심링크/정션으로 격리가 우회되던 문제. realpath 정규화(미존재 대상은 가장 깊은 존재 조상 기준) 후 판정하고, Windows 예약 디바이스 이름(`CON`, `NUL`, `COM1`…)을 거부. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts).

#### Medium (성능)

- **Hex Viewer Find 디바운스 + 매치 상한**: 키 입력마다 전체 데이터를 선형 스캔해 대용량 파일에서 웹뷰가 멈추던 문제 → 250ms 디바운스, 매치 상한 10,000건(`10,000+` 표시). 참조: [src/hexViewer.ts](src/hexViewer.ts).
- **호버 파이프라인 순서·캐시**: 비용 0인 숫자 리터럴 검사보다 LSP 왕복(최대 3초)을 먼저 수행하던 순서를 교정하고, 비식별자 단어의 LSP 진입을 사전 차단. 매크로 테이블·문서 라인 배열을 `document.version` 키로 캐시해 수만 줄 SFR 헤더에서의 호버 지연 완화. 참조: [src/numberBaseHoverProvider.ts](src/numberBaseHoverProvider.ts).

**테스트**: 신규 1 케이스(심링크 우회), 최종 1,405 passing.

## [0.6.7] - 2026-06-10

### 수정 — Hex Viewer 핸들러 cross-talk · 호버 정규식 경계 (전수 리뷰 M7~M8)

#### Medium

- **Hex Viewer 메시지 핸들러 cross-talk**: standalone 패널과 Custom Editor가 모듈 전역 disposable 하나를 공유해, 한쪽을 열면 다른 쪽의 Copy/Goto 메시지 핸들러가 끊기던 문제. Custom Editor는 인스턴스별 disposable로 분리. 참조: [src/hexViewer.ts](src/hexViewer.ts).
- **호버 숫자 정규식 경계**: `\b`/`(?!\w)` 누락으로 `Foo123h` 식별자 내부의 `123h`, 잘못된 리터럴 `0x12g3`의 `0x12`에 부분 매치되던 문제. 참조: [src/numberBaseHoverProvider.ts](src/numberBaseHoverProvider.ts).

**테스트**: 신규 4 케이스, 최종 1,404 passing.

## [0.6.6] - 2026-06-10

### 수정 — 64-bit 값 표시 정확성 (전수 리뷰 M5~M6)

#### High (조용히 틀린 값)

- **Hex Viewer 8-byte unit 정밀도**: 표시/복사 직전 `Number()` 변환으로 2^53 초과 값(`FF*8` 등)이 깨지던 문제 → BigInt 그대로 포맷. 참조: [src/hexViewer.ts](src/hexViewer.ts).
- **호버 64-bit 리터럴 진법 변환**: `parseInt` 기반이라 `0xFFFFFFFFFFFFFFFF` 호버에 `0x10000000000000000` 등 틀린 값이 표시되던 문제 → BigInt 파싱(`parseNumberExact`) 경로 추가, 2^53 초과 값도 64-bit 비트 테이블 표시. 참조: [src/numberBaseHoverProvider.ts](src/numberBaseHoverProvider.ts).

**테스트**: 신규 5 케이스, 최종 1,400 passing.

## [0.6.5] - 2026-06-10

### 수정 — Doctor/Preview 거짓 음성 (전수 리뷰 M9)

#### Medium (도구 정합성)

- **미캡처 출력 참조 검출**: 시뮬레이션이 shell/command에 무조건 `output`을 만들어, 런타임에서는 `passTheResultToNextTask`가 없으면 `${A.output}`이 리터럴로 셸에 들어가는 가장 흔한 설정 실수를 Doctor/Preview 둘 다 놓치던 문제. 시뮬레이션을 런타임과 일치시키고(capture 생략 포함), Doctor에 `output.not-captured`(전방 참조 포함)·`output.ignored`(죽은 output mode/capture/diagnostics) 경고 2종 추가. 참조: [src/previewRun.ts](src/previewRun.ts), [src/doctor.ts](src/doctor.ts), [docs/features.md](docs/features.md).

**테스트**: 신규 9 케이스, 최종 1,395 passing.

## [0.6.4] - 2026-06-10

### 수정 — 파서 "조용히 틀린 값" 3종 (전수 리뷰 M2~M4)

#### High (조용히 틀린 값)

- **Intel HEX ELA 부호 오버플로**: `<< 16`이 32비트 부호 있는 시프트라 ELA ≥ 0x8000(STM32 QSPI 0x90000000, PIC32 kseg 등)의 데이터가 음수 주소로 저장되어 주소 범위·뷰어 렌더링이 깨지던 문제 → 곱셈으로 교체. 참조: [src/hexParser.ts](src/hexParser.ts).
- **레지스터 bit 32 이상 필드 디코딩**: JS 시프트 카운트 `& 31` 처리로 `[35:32]` 필드가 하위 `[3:0]` 값을 그럴듯하게 보여주던 문제 → BigInt 경로 추가. 참조: [src/registerDecoder.ts](src/registerDecoder.ts).
- **struct 멤버 조용한 누락**: 다차원 배열(`int matrix[2][3]`)·함수 포인터(`void (*cb)(int)`)·매크로 차원(`buf[SIZE]`)이 매칭 실패로 통째로 빠진 채 `success: true`로 보고되던 문제. 다차원 배열·함수 포인터는 지원하고, 해석 불가 선언은 `success: false` + 에러로 명시 보고. 참조: [src/structSizeCalculator.ts](src/structSizeCalculator.ts).

**테스트**: 신규 9 케이스, 최종 1,386 passing.

## [0.6.3] - 2026-06-10

### 수정 — `output.mode: "terminal"` 임의 명령 실행 위험 (전수 리뷰 M1)

#### High (보안)

- **출력 본문이 셸에서 실행되던 문제**: 실제 셸 터미널에 `sendText`로 본문을 보내 개행이 Enter로 해석되어 마지막 줄을 제외한 모든 줄이 실행되던 문제(빌드 출력에 `del ...` 줄이 있으면 실제 실행됨). 셸 없는 읽기 전용 Pseudoterminal로 교체 — 표시 UX는 동일하나 본문이 명령으로 해석되지 않음. 참조: [src/extension.ts](src/extension.ts), [docs/features.md](docs/features.md).

**테스트**: IT-026을 pty 기반 검증으로 갱신, 최종 1,377 passing.

## [0.6.2] - 2026-06-10

### 수정 — JSON Editor 유니코드 데이터 영구 손상 (전수 리뷰 C1)

#### High (데이터 손실)

- **atob() mojibake**: 웹뷰가 `JSON.parse(atob(...))`로 데이터를 복원할 때 `atob()`의 latin1 디코딩으로 한글·멀티바이트 문자(`—`, `≥` 등)가 깨지고, 셀 하나만 수정해 저장해도 깨진 전체 데이터가 디스크에 기록되어 영구 손상되던 문제. memoryMapViewer에서 확립한 `escapeForScript`(JSON 리터럴 직접 주입) 패턴으로 교체, saved baseline 경로 포함. 참조: [src/jsonEditor.ts](src/jsonEditor.ts).

**테스트**: 신규 4 케이스(유니코드 round-trip), 최종 1,377 passing.

## [0.6.1] - 2026-06-03

### 추가 — quickPick 동적 항목 · inputBox 검증/추출 (CI/CD 브랜치·Jira 티켓 워크플로)

#### 추가 (기능)

- **quickPick `itemsFromCommand`**: 셸 명령 stdout의 각 비어 있지 않은 줄을 선택 항목으로 채운다. `cwd`(없으면 워크스페이스 폴더)에서 로그인 셸로 실행되며 변수 보간과 `command`와 동일한 OS별 객체 형태를 지원한다. origin 브랜치 목록을 `git for-each-ref ... refs/remotes/origin`으로 동적으로 채우는 등에 사용. 동반 옵션 `itemsExclude`로 출력에서 특정 줄(예: `origin/HEAD`)을 제거. 참조: [src/extension.ts](src/extension.ts), [src/schema.ts](src/schema.ts).
- **inputBox `validatePattern` / `validateMessage`**: 입력값이 만족해야 하는 정규식을 지정하면 입력 도중 형식 위반을 실시간 거부하고 메시지를 표시한다. 잘못된 정규식은 무시(검증 미적용). Jira 티켓 키(`^[A-Z][A-Z0-9]+-\d+$`) 등 형식 강제에 사용. 참조: [src/extension.ts](src/extension.ts).
- **inputBox `extractPattern`**: 보간된 `value`에 정규식을 적용해 기본값을 추출한다(캡처 그룹 1 우선, 없으면 전체 매치, 매치 없으면 빈 값). 브랜치 이름 `feature/ABCTEST-123-foo`에서 티켓 키를 뽑아 입력 기본값으로 채우는 데 사용. 참조: [src/extension.ts](src/extension.ts).

#### 도구 정합성 (Preview / Doctor / 그래프)

- **Preview / Doctor가 `itemsFromCommand` 인식**: Preview Run은 동적 quickPick을 `items (0)` 대신 보간된 명령·cwd와 함께 표시하고, Doctor는 `itemsFromCommand` 안의 `${...}`도 `variable.unresolved` 검사에 포함한다. 의존성 추론도 OS별 branch projection에 `itemsFromCommand`를 포함해 현재 플랫폼에서 실행하지 않는 branch의 ref로 false cycle이 생기지 않는다. 참조: [src/previewRun.ts](src/previewRun.ts), [src/doctor.ts](src/doctor.ts), [src/pipelineUtils.ts](src/pipelineUtils.ts).
- **무시되는 `items`는 검사 제외**: `itemsFromCommand`가 있으면 정적 `items`는 실행되지 않는다 — 명령이 목록을 채우거나, OS별 객체에 현재 플랫폼 branch가 없으면 `command`와 동일하게 오류가 난다(`items`로 폴백 없음). 어느 경우든 `items`는 죽은 값이므로 의존성 추론과 Doctor 모두 `items`에 남은 stale `${...}`를 검사에서 제외한다. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts), [src/doctor.ts](src/doctor.ts).
- **`runCommandCaptureLines` 출력 처리**: child process의 `exit` 대신 `close` 이벤트에서 stdout을 확정해 마지막 줄 유실을 방지. stdout+stderr **합산** 1MB 상한으로 실패 명령의 stderr 폭주에 따른 메모리 증가를 차단. `extractPattern`은 잘못된 정규식일 때도 문서대로 빈 값으로 prefill. 참조: [src/extension.ts](src/extension.ts).
- **문서 (값 전달·HEAD 필터)**: CI 예제가 선택값을 `command` 문자열에 끼우지 않고 quoting되는 `args`로 넘기도록 수정(명령 주입 표면 제거). `git for-each-ref %(refname:short)`가 symbolic HEAD를 `origin`으로 축약하는 점을 반영해 `itemsExclude: ["origin", "origin/HEAD"]` 권장. 참조: [docs/features.md](docs/features.md).

**테스트**: 신규 9 케이스(IT-108 itemsFromCommand+itemsExclude, IT-109 extractPattern+validatePattern, taskGraph projection·items 제외·branch 없을 때 items 유지, Preview 2건, Doctor 2건).

## [0.6.0] - 2026-05-30

### 수정 / 추가 — 전체 코드 리뷰 반영 (호버 정확성 · 파싱 견고성 · i18n · UX)

#### High (데이터 손실 / 신뢰 손상)

- **레지스터 디코더 32비트 필드 부호 오류**: `[31:0]` 전체 필드의 최상위 비트가 셋이면 `&` 연산이 부호 있는 32비트로 떨어져 호버에 음수(`0x-7FFFFFFF`)로 노출되던 문제. `>>> 0` 정규화로 unsigned 값을 표시. 참조: [src/registerDecoder.ts](src/registerDecoder.ts).
- **구조체 크기 계산 — 비트필드 / union / 익명 중첩 / 16진 배열**: `uint32_t flags : 3;` 비트필드, `union`(max가 아닌 합으로 계산되던 것), 익명 중첩 struct·union 멤버, `buf[0x100]` 같은 16진 배열 크기가 누락·오계산되어 잘못된 `sizeof`를 표시하던 문제를 GCC/clang 시맨틱에 맞게 재작성. C11 익명(이름 없는) 멤버는 sub-object 블록으로 배치. 참조: [src/structSizeCalculator.ts](src/structSizeCalculator.ts).
- **JSON Editor 숫자 손실**: `Infinity` / `-Infinity` 입력이 저장 라운드트립에서 `null`로 사라지던 것 → 문자열로 보존. 저장 데이터 누락 시 `'undefined'`가 디스크에 기록되던 경로 차단. 참조: [src/jsonEditor.ts](src/jsonEditor.ts), [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts).

#### Medium (정확성 / 견고성)

- **비트 시프트 호버 32비트 wrap**: `1 << 40`이 JS mod-32 규칙으로 256으로 표시되던 것 → `Math.pow(2, n)` 기반으로 실제 값 계산, `macroExpander`와 일치. 비트 위치 표시 임계값도 `MAX_SAFE_INTEGER`로 통일. 참조: [src/numberBaseHoverProvider.ts](src/numberBaseHoverProvider.ts).
- **HEX / SREC 파싱 견고성**: 선언 byteCount 대비 라인 길이를 검증하지 않아 잘린 레코드의 NaN 바이트가 뷰에 섞이던 문제. 길이·체크섬·바이트 단위 가드 추가. 참조: [src/hexParser.ts](src/hexParser.ts).
- **ELF 파싱 경계 검증**: `phEntSize` 최소 크기, `symtabLink` 섹션 범위, 문자열 테이블 오프셋의 파일 크기 초과를 검증해 손상 ELF에서 throw. 참조: [src/elfParser.ts](src/elfParser.ts).
- **스캐터 파일 파싱**: 16진수 없는 실행 영역(`+0`)·동명 로드/실행 영역이 누락·오분류되던 문제 수정. base를 알 수 없는 심볼릭 로드 영역의 `+offset`은 raw 값을 절대주소로 노출하지 않고 생략. 참조: [src/linkerScriptParser.ts](src/linkerScriptParser.ts).
- **출력 캡처 정규식 `g` 플래그**: `output.capture` 런타임 경로가 `g` 플래그를 제거하지 않아 캡처 그룹 대신 매치 배열을 반환하던 문제. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts).
- **Preview Run / Doctor 일관성**: `envPick` 태스크가 Preview에서 거짓 unresolved 경고·`(unknown task type)`로 표시되던 것 수정. Doctor가 `.output` 폴백 producer의 오타 참조를 잡아내고, 중복 id 진단이 정확한 위치를 가리킴. 참조: [src/previewRun.ts](src/previewRun.ts), [src/doctor.ts](src/doctor.ts).
- **HTML 저장 침묵 실패**: 메모리 맵 HTML 저장 실패가 미처리 예외로 조용히 사라지던 것 → try/catch + 안내 메시지. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts).
- **매크로 접두 오인식**: `#defineFOO`가 `#define`으로 통과되던 것 차단. 참조: [src/macroExpander.ts](src/macroExpander.ts).
- **SFR 스코프 스캔**: 문자열/주석 안의 중괄호를 무시하지 않아 스코프 감지가 어긋나던 backward brace 스캔 보강. 참조: [src/sfrBitFieldParser.ts](src/sfrBitFieldParser.ts).

#### UX / 일관성

- **Hex 상태바 gap 표시**: 데이터 없는 오프셋에서 fill 바이트를 실제 값처럼 보여주던 것 → `Value: no data`로 명확화. 참조: [src/hexViewer.ts](src/hexViewer.ts).
- **링크 삭제 정확성**: 제목·URL이 같은 중복 링크 중 다른 항목까지 삭제될 수 있던 것 → 정체성(title/link/group/tags) 일치 항목 하나만 삭제. 참조: [src/extension.ts](src/extension.ts) `removeLinkByIdentity`.
- **액션 로드 실패 토스트 스팸 억제**: 파일 감시 연속 발화 시 동일 에러 토스트가 누적되던 것 → 동일 메시지는 1회만. 참조: [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts).
- **명령 이름 정정**: `TaskHub: Show History Panel` → `Toggle History Panel`(실제 토글 동작과 일치). 참조: [package.json](package.json).
- **i18n 보강**: Doctor 진단 메시지(Problems 패널)·파일 열기 다이얼로그 라벨·메모리 맵 안내 문구를 한국어/영어 두 벌로 제공. 히스토리 배지 로케일 판별을 `startsWith('ko')`로 통일해 `ko-KR`에서도 한국어 표시. Preview에 `[parallel]` 마커 노출. 참조: [src/doctor.ts](src/doctor.ts), [src/memoryMapViewer.ts](src/memoryMapViewer.ts), [src/providers/historyProvider.ts](src/providers/historyProvider.ts).
- **자원 정리**: TreeDataProvider 4종 및 출력 채널을 `context.subscriptions`/`deactivate`에서 dispose. 클립보드 복사를 `await` 후 성공 토스트. 참조: [src/extension.ts](src/extension.ts).

#### 문서

- `docs/architecture.md` 모듈 트리에 `doctor.ts`·`previewOpener.ts`·`diagnosticMatcher.ts` 추가, Built-in 링크 잔재 및 아이콘 설명 정정, Task DAG 항목 반영. `CLAUDE.md` i18n 판별 규칙(`startsWith`), `CONTRIBUTING.md` VSIX 절차(`npx @vscode/vsce`), `examples/README.md` 중복 산문 제거(매핑 표만 유지).

**테스트**: 신규 26 케이스, 최종 1364 passing.

## [0.5.2] - 2026-05-28

### 변경 — Built-in Links 패널 제거 + 단일 워크스페이스 링크 뷰로 일원화

#### 호환성 깨짐 (Breaking)

- **Built-in Links 패널(`mainView.linkBuiltin`) 제거**: 두 개로 나뉘어 있던 링크 패널을 워크스페이스 링크(`mainView.linkWorkspace`) 하나로 통합. 번들 `media/links.json`은 더 이상 로드되지 않으며 패키지에서도 삭제됐다. 그동안 `media/links.json`에 직접 추가해 사용하던 항목이 있다면 워크스페이스의 `.vscode/links.json`으로 옮겨 두어야 한다 (확장 디렉터리는 업그레이드 시 새 VSIX로 교체되므로 자동 마이그레이션은 제공하지 않는다). 참조: [src/providers/linkViewProvider.ts](src/providers/linkViewProvider.ts), [src/extension.ts](src/extension.ts).
- **`LinkViewProvider` 시그니처 변경**: `mode`/`context` 파라미터 제거 → 인자 없이 `new LinkViewProvider()`로 생성하며 workspace 폴더에서만 로드한다. 외부 소비자가 없으므로 사용자 영향은 없음.

#### 정리

- jsonValidation 매핑에서 `/media/links.json` 항목 제거, 메뉴 `when` 조건에서 `view == mainView.linkBuiltin` 분기 제거, dev 모드 전용 `media/links.json` FileSystemWatcher 제거. [media/links_example.json](media/links_example.json)은 *Show Example JSONs* 명령에서 계속 사용되므로 유지.

## [0.5.1] - 2026-05-27

### 변경 — History 항목의 상태 표시 중복 정리 + 접근성 보강

#### UX / 일관성

- **History 배지에서 `✓`/`✗` 접두 제거**: 각 `HistoryItem`은 이미 status에 따라 색 아이콘(녹색 `pass` / 빨간 `error`)을 그리고 있는데, 0.4.x에서 추가한 last-run 배지(`formatLastRunBadge`)가 같은 상태를 텍스트 접두로 한 번 더 표시해 한 행에 동일 신호가 두 번 노출되고 있었음. 배지 텍스트는 시각·소요 시간만 담당하도록 단순화: `14:30 · 1.2s` / `어제 09:15 · 45ms` / `12/15`. 진행 중(`running`) 항목은 여전히 description 없이 아이콘만으로 표시. 참조: [src/providers/historyProvider.ts](src/providers/historyProvider.ts) `formatLastRunBadge` / `HistoryItem`.

#### 접근성

- **`HistoryItem.accessibilityInformation.label`로 스크린 리더 패리티 유지**: 위 변경으로 시각적 status가 아이콘 색에만 남게 되어 스크린 리더/텍스트 접근에서는 성공/실패를 분간할 수 없는 회귀가 생길 수 있었음. 각 항목에 `Build, 성공, 14:30 · 1.2s` / `Build, 실행 중, 14:30` 형태의 aria 라벨을 부여해 status 단어를 텍스트로 안내. 다국어 분기(`성공/실패/실행 중` ↔ `succeeded/failed/running`)와 tool 엔트리는 `열림/opened`로 표기해 "성공" 오안내를 피함. 새 순수 헬퍼 `buildHistoryItemAriaLabel(entry, displayLabel, now, lang)`을 export해 단위 테스트로 분기 고정. 참조: [src/providers/historyProvider.ts](src/providers/historyProvider.ts) `buildHistoryItemAriaLabel` / `HistoryItem`.

**테스트**: 단위 신규 7 케이스 (`formatLastRunBadge` 글리프 부재 가드 1 + `buildHistoryItemAriaLabel` 분기 6) + 기존 `formatLastRunBadge` 단위 6 케이스 갱신 + 통합 IT-068 (`✓`/`✗` 부재 + iconPath status 매핑 + aria 라벨 status 단어) 확장.

## [0.5.0] - 2026-05-14

### 추가 / 수정 — 병렬 실행 / Task DAG 정식 릴리스 (0.4.41~0.4.44 통합 + 코드 리뷰 반영)

0.4.41 도입한 `parallel: true` opt-in 병렬 실행과 후속 0.4.42~0.4.44 픽스를 단일 0.5.0 릴리스로 묶고, 병렬 도입 이후 발견된 다중 라운드 코드 리뷰 지적을 모두 반영. 사용자 영향 정리:

#### 추가 (병렬 실행 / Task DAG)

- **`task.parallel: true` opt-in 병렬 실행**: `dependsOn` + `${taskId.x}` 자동 추론으로 DAG를 구성, `taskhub.pipeline.maxParallelTasks`(기본 4, 1~32)로 동시 실행 한도 제어. 기본은 직렬 그대로. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts) `buildTaskGraph` / `TaskScheduler`, [src/extension.ts](src/extension.ts) `executeActionPipeline`, [docs/features.md §24](docs/features.md#24-병렬-실행--task-dag).
- **사전 검증**: `validateTaskGraph`가 액션 진입 시 self-dep / missing-dep / 순환을 즉시 실패로 거부. Doctor가 같은 검사를 lint 시점에 적용([src/doctor.ts](src/doctor.ts) `dependsOn.cycle` / `.missing` / `.self` / `parallel.interactive`).
- **Multi-track Actions 패널**: 동시에 실행 중인 task가 여러 개여도 모두 progress 라벨에 표시(`2 running · A, B` / `3 running · A, B + 1`). 단일 실행은 task의 실제 declaration index를 사용해 out-of-order 완료에서 misnumber 안 함. 참조: [src/providers/actionStatus.ts](src/providers/actionStatus.ts), [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts) `formatProgressDescription`.
- **Preview Run graph 검증**: `buildTaskGraph` + `validateTaskGraph` 결과를 Preview에 표기, 사이클/missing-dep가 있으면 summary가 "action would FAIL at start" 분기. 사용자 typo `${alreadyRan.typoKey}`도 별도 `findTypoRefs`로 검출(런타임 `.output` fallback이 가려버리는 케이스). 참조: [src/previewRun.ts](src/previewRun.ts) `findTypoRefs` / `buildPreviewReport`.

#### 수정 (코드 리뷰 반영 — 정확성)

- **Platform-aware dependency inference**: `command` / `tool`의 per-platform `{windows, macos, linux}` 객체에서 *active platform 분기만* 스캔. 이전엔 union을 봤기 때문에 cross-platform 액션이 false-positive cycle로 거부될 수 있었음. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts) `projectActivePlatformBranches`, `inferTaskDependencies({ platform })`.
- **Reserved-head 분리 정확도**: `RESERVED_VARIABLE_HEADS = {workspaceFolder, extensionPath}`와 `RESERVED_HEAD_PREFIXES = ['env:', 'input:']`로 분리. 이전 `head.includes(':')` 광범위 필터는 `id: 'build:fw'` 같은 합법 colon task id의 자동 의존성을 떨어뜨려 parallel consumer가 producer를 race할 위험이 있었음.
- **DAG inputs bare-id**: `unzip`의 `inputs.archive` / `.file` / `.destination`은 `${...}` 없이 raw task id로 참조되는데 `inferTaskDependencies`가 이를 놓쳐, `parallel: true` unzip이 선행 zip을 기다리지 않을 수 있었음. 모든 task의 `inputs` 값을 valid task id와 매칭해 dep으로 추가.
- **Doctor / Preview forward-only toleration**: 이미 시뮬레이션된 task에 대한 ref는 더 이상 suppress하지 않음 — `${alreadyRan.typoKey}` typo를 다시 찾아냄. 참조: [src/doctor.ts](src/doctor.ts) `analyzeActionTasks` `forwardTaskIds`.
- **다중 실패 `AggregateError`**: 한 액션의 두 개 이상 task가 동시에 실패하면 모든 cause를 `AggregateError`로 묶어 throw — 메시지에 모든 task id 요약, `error.errors`에 개별 cause 보존. 단일 실패는 원본 Error 그대로(back-compat).
- **`InFlightOutcome` discriminated union**: scheduler 결과 타입을 `success` / `skipped` / `failed`로 좁혀 `!` non-null assertion 제거.
- **`parallelActions` refcount**: `Set<string>` → `Map<string, number>`로 전환 + `enterParallelAction` / `exitParallelAction` / `isParallelActionActive` 헬퍼. future-proofing.

#### 변경 (런타임 시맨틱)

- **`task.dependsOn` honored**: 0.4.40까지는 선언적이었으나 이번부터 실제 실행 순서를 결정. cycle/missing/self는 즉시 실패(이전엔 무시되고 배열 순서로 실행).
- **활성 task 자료구조 재구조화**: `activeTasks` / `actionChildProcesses`가 `Map<actionId, Map<taskId, ...>>`로 바뀌어 task 단위 timeout/stop이 가능. 사용자 "Stop"은 여전히 액션 전체 종료.
- **출력 격리**: `parallel: true` task가 하나라도 있으면 streamed task terminal group과 `output.mode: 'terminal'` 키가 `actionId:taskId`로 분리. 직렬 액션은 영향 없음.
- **Interactive task + parallel**: prompt mutex로 다이얼로그 직렬화 보장. Doctor가 `parallel.interactive` warning.
- **verbose 로그 prefix**: `executeShellCommand`가 verbose 로그 라인마다 `[task:${taskId}] ` prefix를 붙여 두 task의 close 블록이 섞여도 식별 가능. multi-line stdout/stderr/CRLF/CR/LF 모두 처리.

#### 테스트 / 문서

- 신규 90+ 테스트(graph 유틸 + scheduler + mutex + Doctor warning + output 격리 + AggregateError + platform projection + reserved heads + Preview cycle/missing/typo + IT-076..079 end-to-end). 최종 1331 passing, 1 pending.
- `HistoryProvider`에 `getMaxItems` 옵션 주입 — 테스트가 글로벌 config를 건드리지 않고 maxItems를 결정.
- `docs/features.md` §24 병렬 실행 문서 + §23.3 dependsOn/parallel 런타임 동작 + fileDialog/folderDialog 서브섹션.

## [0.4.44] - 2026-05-14

### 수정 — 0.4.43 코드 리뷰 반영 (DAG inputs 의존성 + Actions 패널 progress 라벨 정확도)

0.4.43 multi-track 표시 변경에 대한 리뷰에서 짚힌 두 건을 즉시 보정.

#### Medium (스케줄러 정확성)

- **`task.inputs` bare-id 참조도 자동 의존성 추론에 포함**: `handleUnzip`이 `task.inputs.archive` / `inputs.file` / `inputs.destination`을 `allResults[id]`로 직접 조회하지만 `inferTaskDependencies`는 `${id.x}` 형태만 head로 추출해서 이 bare-id 경로가 DAG에 빠져 있었다. 결과로 `parallel: true`인 unzip이 선행 zip을 기다리지 않고 시작해 "requires an archive path"로 실패할 수 있는 시퀀스가 있었다. 이제 모든 task 타입의 `inputs` 값을 동등하게 검사해 valid task id와 일치하는 항목만 dep로 추가(자기 자신은 제외, 비 task id 문자열은 무시). 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts) `inferTaskDependencies`.

#### Medium (UI 정확성)

- **Actions 패널 single-running 라벨이 task의 실제 declaration index를 사용**: 0.4.43 렌더는 `${completed+1}/${total} · ${id}` 형태로 표시했는데, 병렬 실행에서 task 2가 먼저 끝나고 task 1이 아직 running인 경우 `2/3 · A`로 표시되는 misnumber가 발생했다(A는 task 1인데도 "2"로 보임). `ActionProgress.running`을 `{ taskId, index }[]` 형태로 확장해 `onTaskTransition`이 `event.index`를 같이 저장하고, 렌더는 `running[0].index`를 사용해 task의 실제 position을 표시. 참조: [src/providers/actionStatus.ts](src/providers/actionStatus.ts) `RunningTaskEntry`, [src/extension.ts](src/extension.ts) `onTaskTransition`, [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts) `formatProgressDescription`.

**테스트**: 신규 5종(inferTaskDependencies inputs 3건 / buildTaskGraph 회귀 1건 / formatProgressDescription P3 회귀 1건), 픽스처 마이그레이션 4건(`running` 엔트리 shape 갱신), 최종 1314 passing.

## [0.4.43] - 2026-05-14

### 변경 — 병렬 실행 액션의 동시 진행 task를 다중 라벨로 표시

0.4.41 병렬 실행 후속의 마지막 잔여 항목(로드맵 §0.4.41 후속 C). 0.4.41까지는 `onTaskTransition`이 `running` 이벤트마다 `actionStates.progress`를 덮어써 두 개 이상의 task가 동시에 실행 중일 때도 Actions 패널에는 "마지막으로 시작된 task" 하나만 표시됐다. 데이터 모델은 동시 transition을 모두 받고 있었지만 UI가 single-track이라 사용자 입장에서는 나머지 task가 묻혔다.

#### UX / 일관성

- **`ActionProgress` shape 확장**: `{ index, total, taskId }` → `{ total, completed, running: string[] }`. `running`은 시작 시각 순으로 정렬된 task id 목록 — 직렬 실행이면 길이 ≤ 1, 병렬 실행이면 동시에 여러 개. 참조: [src/providers/actionStatus.ts](src/providers/actionStatus.ts).
- **`onTaskTransition` 풀 lifecycle 처리**: `running` 이벤트뿐 아니라 `success`/`failure`/`skipped` terminal 이벤트도 받아 `running` 목록에서 task를 제거하고 `completed`를 증가. 동시 transition이 모두 progress에 반영된다. 참조: [src/extension.ts](src/extension.ts) `executeAction`의 `onTaskTransition` 콜백.
- **TreeItem 렌더 분기** (`formatProgressDescription` export): running.length에 따라 1개는 `2/3 · link`(기존 직렬 호환), 2개는 `2 running · A, B`, 3개+는 `4 running · A, B + 2`(overflow), 0개+completed>0(직렬 transition 사이 gap)은 `1/3` compact form. 단일 task 액션(total=1)은 description 미표시 정책 유지 — `1/1 · X` 노이즈 없음. 참조: [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts) `formatProgressDescription`.

**테스트**: 신규 8종(TreeItem 멀티트랙 통합 IT-072d/e + `formatProgressDescription` 단위 6종), 기존 픽스처 마이그레이션 2건(IT-072 / IT-072b 새 shape으로 갱신), 최종 1309 passing.

## [0.4.42] - 2026-05-14

### 수정 — 0.4.41 병렬 실행 후속 잔여 (verbose log task id prefix + Doctor/Preview future task 참조)

0.4.41 병렬 실행 릴리스 직후 코드 리뷰에서 짚힌 잔여 항목 두 가지를 정리한다. 로드맵 §0.4.41 후속 작업의 B(verbose 로그 식별성)와 A(c)안(Doctor/Preview Run의 forward task ref false positive).

#### Medium (디버깅 식별성)

- **verbose 로그 task id prefix**: `executeShellCommand`의 verbose OutputChannel 로그 5개 사이트(WARN PowerShell fallback / INFO Executing / INFO STDOUT/STDERR/finished / ERROR Failed to start)에 `[task:${taskId}] ` prefix가 붙는다. 두 병렬 task의 close 블록이 연달아 찍힐 때 어느 task 결과인지 즉시 식별 가능. multiline `stdout`/`stderr`도 모든 continuation line이 prefix를 받으며, split은 `\r\n` / 단독 `\r` / 단독 `\n` 모두 처리(`foo\rbar` 형태의 progress 로그도 분리). `taskKey` 없는 legacy caller는 기존 unprefixed 포맷 유지. 참조: [src/extension.ts](src/extension.ts) `executeShellCommand` `appendVerboseLine`.

#### Medium (lint 정확성)

- **Doctor / Preview Run의 forward task ref false positive 차단**: 같은 액션 안에서 배열 순서상 뒤에 선언된 task를 `${id.x}`로 참조하는 정상 패턴 (예: `parallel: true`로 `A`가 `${B.output}` 참조, 런타임은 자동 의존성 추론으로 `B → A` 순서로 실행)이 Doctor에서는 `variable.unresolved` warning, Preview Run에서는 "unresolved variables" 보고로 잘못 잡히던 것을 수정. `findUnresolved`에 optional `toleratedHeads` 인자를 추가, 호출자가 같은 액션의 valid task id set을 전달하면 그 head를 가진 참조는 결과에서 제외. 트레이드오프: head가 valid task id이면 capture/result 키 typo(`${A.typoKey}`)는 보고되지 않는다 — 진짜 graph-aware 시뮬레이션(`buildTaskGraph` + topo 정렬)은 로드맵 후속 A(b)로 보류. 참조: [src/previewRun.ts](src/previewRun.ts) `findUnresolved` `extractRefHead`, [src/doctor.ts](src/doctor.ts) `analyzeActionTasks`.

**테스트**: 신규 4종(Doctor forward-ref 통과 / unknown-head fail, Preview Run forward-ref 통과 / unknown-head fail), 최종 1301 passing.

## [0.4.41] - 2026-05-14

### 추가 — 병렬 실행 / Task DAG

`task.parallel: true` opt-in으로 한 액션 안의 task를 의존성 기반 DAG로 실행한다 — 로드맵 §4. 기본은 변함 없이 순차이며 (`parallel`이 없으면 이전 *모든* task에 암묵 의존하는 sync barrier), `parallel: true`만 그 barrier에서 빠져나와 `dependsOn` + `${taskId.x}` 자동 추론 의존성만 기다린다. 멀티 타겟 빌드(stm32f4/f7 동시 빌드 후 패키지)처럼 의존성이 명확한 워크플로에서 wall-clock 시간이 줄어든다. 참조: [docs/features.md §24](docs/features.md#24-병렬-실행--task-dag), [src/pipelineUtils.ts](src/pipelineUtils.ts), [src/extension.ts](src/extension.ts) `executeActionPipeline`.

#### 시맨틱 / 안전장치

- **사전 검증**: `validateTaskGraph`가 액션 진입 시 self-dep / missing-dep / 그래프 cycle을 즉시 실패로 거부. Doctor가 lint 시점에 같은 검사를 미리 적용([src/doctor.ts](src/doctor.ts) `dependsOn.cycle` / `dependsOn.missing` / `dependsOn.self`).
- **자동 의존성 추론**: task의 string 필드(`command` / `args` / `env` / `cwd` / `output.*` / interactive prompt)에 `${taskId.x}` 참조가 있으면 자동으로 의존성으로 잡힘. `dependsOn`을 빼먹어도 출력을 참조하는 task가 먼저 실행되는 사고가 없다.
- **실패 격리**: 일반 실패는 새 task 스케줄링을 멈추되 이미 실행 중인 sibling은 완료까지 대기. `continueOnError: true`는 결과를 `{}`로 전파하던 기존 시맨틱 그대로. timeout은 액션 전체가 아니라 그 task만 종료.
- **출력 격리**: 액션이 `parallel: true`를 하나라도 가지면 그 액션의 streamed task terminal group과 `output.mode: 'terminal'` 터미널 키가 `actionId:taskId` 단위로 분리되어 두 빌드의 출력이 한 터미널에 섞이지 않는다. 기존 직렬 액션은 영향 없음.
- **Interactive task**: `inputBox`/`quickPick`/`envPick`/`confirm`/`fileDialog`/`folderDialog`에 `parallel: true`가 붙으면 Doctor가 `parallel.interactive` warning을 보고하고, 런타임은 prompt mutex로 다이얼로그를 강제 직렬화 (modal 두 개가 동시에 뜨는 일 없음).

#### 영향

- **새 schema 필드**: `Task.parallel: boolean` ([schema/actions.schema.json](schema/actions.schema.json), [src/schema.ts](src/schema.ts)). 기존 액션 파일에 영향 없음 — optional, 기본 false.
- **새 설정**: `taskhub.pipeline.maxParallelTasks` (정수, 기본 4, 범위 1~32). 임베디드 빌드의 RAM 부담을 고려한 보수적 기본값. `1`로 두면 완전 순차 강제.
- **`task.dependsOn`이 런타임에서 honored**됨: 기존 0.4.40 릴리스에서는 선언적이었으나 이번부터 실제 실행 순서를 결정. cycle/missing/self가 있는 액션은 즉시 실패 (이전엔 무시되고 배열 순서로 실행됐음 — Doctor가 이미 보고하던 케이스라 *행동 변화이지 회귀가 아님*).
- **`activeTasks` / `actionChildProcesses` 데이터 구조**가 `Map<actionId, Map<taskId, ...>>`로 재구조화되어 task 단위 timeout/stop이 가능. 사용자 "Stop" 커맨드는 여전히 액션 전체를 죽이지만 내부적으로는 task 단위 정리.
- **Preview Run**: 헤더에 `[parallel]` 마커를 붙여 실제 런타임이 어떤 task를 동시에 시작할 수 있는지 표시. 시뮬레이션 순서는 그대로 (declaration order).

**테스트**: 신규 67종 (graph 유틸 + scheduler + mutex + Doctor warning + output 격리), 최종 1296 passing.

## [0.4.40] - 2026-05-13

### 추가 — TaskHub Doctor (Action Lint)

`TaskHub: Doctor — Lint Actions` 단일 커맨드로 모든 `actions.json` 소스(번들 + 선택된 preset + 워크스페이스별 `.vscode/actions.json`)를 한 번에 정적 분석해 VS Code Problems 패널에 게시한다. Preview Run([docs/features.md](docs/features.md) §5)이 *한 액션*의 실행 시뮬레이션이라면 Doctor는 *모든 소스*의 건강검진 — 1.2 tasks.json Import 이후 들어온 사용자의 첫 마찰점("왜 안 돼?")을 액션을 실제 실행하기 전에 짚기 위해 도입한다. 진단 컬렉션은 `taskhub-doctor` source로 분리되어 있어 액션 실행 중 Problem Matcher가 만들어내는 진단(`taskhub:<actionId>`)과 섞이지 않는다. 참조: [src/doctor.ts](src/doctor.ts), [src/extension.ts](src/extension.ts) `taskhub.doctor`, [docs/features.md §23](docs/features.md#23-taskhub-doctor-action-lint).

#### 검사 항목 (9종)

- **JSON 파싱 실패** (`json.parse`): JS 엔진이 보고한 오프셋을 라인/컬럼으로 환산.
- **JSON 스키마 위반** (`schema.*`): 기존 AJV validator([src/extension.ts](src/extension.ts) `getActionsValidator`)를 그대로 재사용. `keyword`에 따라 `schema.required` / `schema.enum` / `schema.additionalProperties` 등으로 코드 세분화. JSON Pointer를 라인/컬럼으로 매핑하는 자체 워커(`locateJsonPointer`)가 해당 노드까지 추적.
- **중복 id** (`duplicate.action.id` / `duplicate.task.id`): 한 소스 내부의 액션 id 충돌, 한 액션 내부의 task id 충돌. 기존 `performAdditionalActionValidation`이 throw 하던 케이스를 finding으로 변환.
- **regex 컴파일** (`capture.regex` / `diagnostics.regex`) + **group 인덱스 부적합** (`capture.group` / `diagnostics.group`): `output.capture` / `output.diagnostics`의 패턴을 `new RegExp()`로 시도하고, group 인덱스가 capture group 개수를 벗어나면 경고. `g` 플래그는 런타임과 동일하게 사전 제거 후 검사.
- **capture 이름 검증** (`capture.reserved` / `capture.duplicate`): `output.capture.name`이 `applyOutputCapture`의 reserved 집합(`output`/`path`/`value`/`values`/`outputDir`/`dir`/`name`/`fileNameOnly`/`fileExt`/`archivePath`/`confirmed`, [src/pipelineUtils.ts](src/pipelineUtils.ts) 참조)과 충돌하거나, 같은 task 안에서 중복으로 정의된 경우 보고. 스키마는 이름 패턴(`^[A-Za-z_]…`)만 검사하므로 둘 다 schema를 통과한 뒤 런타임에서 throw 하던 경로 — 이제 Doctor가 사전에 잡는다.
- **알 수 없는 diagnostics preset** (`diagnostics.preset`): `"$gcc"` / `"$tsc"` 같은 단축 문자열이 미등록이거나 `$` 누락.
- **미해결 변수** (`variable.unresolved`): Preview Run과 동일한 simulation 컨텍스트(`simulateTaskResult` + `interpolatePipelineVariables`)에서 치환 후에도 남는 `${…}` 가 있으면 경고. 런타임에 리터럴로 통과되어 거의 항상 버그.
- **워크스페이스 외부 쓰기** (`path.outside-workspace`): `writeFile.path` / `appendFile.path` / `output.filePath`의 해석 결과가 워크스페이스 밖이면 오류. 변수 치환 후에도 `${…}`가 남은 경우는 안전 결정 불가로 건너뜀.
- **dependsOn cycle / missing / self** (`dependsOn.cycle` / `dependsOn.missing` / `dependsOn.self`): task 간 의존성 그래프의 순환, 존재하지 않는 task id 참조, 자기 자신 참조. **주의**: 이번 릴리스에서 `task.dependsOn` 필드는 *선언적*으로만 추가됐다 — 런타임은 여전히 배열 순서대로 순차 실행하며 `dependsOn`을 무시한다. 진짜 DAG/병렬 실행은 로드맵 §4("Parallel Execution / Task DAG")로 미루되, Doctor 검사를 먼저 들여서 그 본 작업이 도착할 때 `actions.json`이 문법적으로 준비되어 있도록 한다.

#### 영향

- **새 커맨드**: `taskhub.doctor` (`TaskHub: Doctor — Lint Actions`). Command Palette만 노출, 컨텍스트 메뉴 없음.
- **schema 추가**: `Task.dependsOn: string[]` ([schema/actions.schema.json](schema/actions.schema.json), [src/schema.ts](src/schema.ts)). 기존 액션 파일에 영향 없음 — optional 필드, 런타임 무시.
- **`src/previewRun.ts` 일부 헬퍼 export 전환**: `simulateTaskResult` / `findUnresolved` / `isInsideWorkspace` / `placeholder` / `UNRESOLVED_VAR_RE`를 Doctor가 재사용. 동작 변경은 없으며 기존 호출자는 그대로.

**테스트**: 신규 22종(Doctor), 최종 1229 passing.

## [0.4.39] - 2026-05-12

### 수정 — `windowsCommandIsDirectlyLaunchable` PATH 후보 경로 조합을 `path.win32` 기준으로

이 함수는 Windows 의미론(`PATH`를 `;`로 분리, `\` 구분자)을 다루는데, PATH 디렉터리와 실행 파일명을 합칠 때 `path.join`을 써서 호출 OS의 구분자(macOS에서는 `/`)를 끼워 넣어 후보 경로가 어긋났다. `path.win32.join`으로 바꿔 실행 OS와 무관하게 동작하도록 한다. 실제 Windows에서는 동작 변화 없음(`path.join === path.win32.join`). 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts).

**테스트**: 최종 1257 passing.

## [0.4.38] - 2026-05-12

### 수정 — Windows 셸/스크립트 task 인자 인용 + 크로스플랫폼 테스트 보강

Windows에서 `shell`/`command` task가 인자 안에 `"` 를 포함하면(예: `node -e "process.stdout.write(...)"`) Windows PowerShell 5.1의 native-command 인자 전달 버그로 따옴표가 사라져 명령이 깨지던 문제를 수정한다. macOS/Linux에는 영향이 없으며(`sh -c` 경로), 그래서 그동안 macOS 테스트에서는 드러나지 않았다.

#### 동작 변경

- **Windows 실행 경로 판별 (`windowsCommandIsDirectlyLaunchable`)**: 실행 파일이 셸 없이 OS 프로세스 로더로 바로 띄울 수 있는지 — 명시적 `.exe`/`.com`이거나, 확장자 없는 이름이면 `PATH`(+`.exe`/`.com`)로 해석해 찾으면 — 판별한다. 해당하면 `executeShellCommand`는 `spawn(file, argvArray)`(셸 없이), VS Code Task/스트림 경로(`createShellExecution`)는 `vscode.ProcessExecution`, one-shot(`isOneShot`)은 `ProcessStartInfo`(`UseShellExecute=$false`, `Arguments`는 CommandLineToArgvW 규칙으로 escape)로 실행해 인자(특히 `"` 포함)를 그대로 전달한다. `.cmd`/`.bat`/`.ps1`/`.js` 스크립트, `npm`/`npx`/`pnpm`/`yarn` 같은 `.cmd` shim, 셸 빌트인/별칭(`echo`, `dir`, `cd`, …)은 기존대로 PowerShell 경로(또는 one-shot은 `Start-Process … -ArgumentList @(…)`)를 쓴다. 캡처 모드에서는 추가로, native `spawn`이 `ENOENT`/`EINVAL`/`EACCES`로 실패하면 같은 명령을 PowerShell 경로로 한 번 더 재시도하는 안전망이 있다(스트림/one-shot 경로에는 이 재시도 없음). 판별 시 PATH는 task의 실제 실행 env(`{ ...process.env, ...task.env override }`)를 기준으로 본다 — `task.env.PATH`로 toolchain bin을 추가한 경우 그 `.exe`도 올바르게 native로 인식된다. 참조: [src/pipelineUtils.ts](src/pipelineUtils.ts) (`windowsCommandIsDirectlyLaunchable` / `buildNativeCommandInvocation` / `quoteWindowsCommandLineArgument`), [src/extension.ts](src/extension.ts) (`createShellExecution` / `executeShellCommand` / `wrapCommandForOneShot`).
- **one-shot task(Windows)**: 직접 실행 가능한 명령은 `Start-Process` 대신 `ProcessStartInfo`(`UseShellExecute=$false`, CommandLineToArgvW escape)로 띄워 인자 인용을 정확히 제어한다. shim/스크립트/빌트인은 PATHEXT·파일 연결 해석을 위해 기존 `Start-Process -FilePath … -ArgumentList @(…)` 형태를 유지한다.

#### 문서

- architecture.md "쉘 인자 이스케이프 / 실행 경로 선택" 항목과 features.md §5 스트림 모드 설명을 새 동작에 맞게 갱신. 참조: [docs/architecture.md](docs/architecture.md), [docs/features.md](docs/features.md).

#### 테스트

- Windows 한정으로 실패하던 16건을 해소: PowerShell 인자 깨짐(≈11건)은 위 동작 변경으로, 소스 정규식 검사 테스트의 CRLF 글자수 오차는 줄바꿈 정규화로([src/test/jsonEditorUtils.test.ts](src/test/jsonEditorUtils.test.ts)), 드라이브 레터 대소문자(`c:\` vs `C:\`)는 비교 정규화로([src/test/viewProviderIntegration.test.ts](src/test/viewProviderIntegration.test.ts), [src/test/pipelineIntegration.test.ts](src/test/pipelineIntegration.test.ts)), timeout-kill 직후 temp dir 잠금은 teardown 재시도 + best-effort 처리로 수정.
- 신규 단위 테스트: `quoteWindowsCommandLineArgument` / `buildNativeCommandInvocation` / `windowsCommandIsDirectlyLaunchable`(PATH 해석 포함, lookup 주입으로 결정적) 동작 + `createShellExecution`·`wrapCommandForOneShot`의 native 경로 및 `Start-Process` shim 폴백. 최종 1206 passing / 1 pending(Windows에서 의도적 skip — POSIX 전용 capture-overflow 테스트).

## [0.4.37] - 2026-05-12

### 추가 — History에 JSON Editor 열람 기록

[0.4.36]에서 도입한 도구 열람 히스토리에 JSON Editor를 추가한다. 이전 커밋에서 누락된 것을 보완하는 것으로, Memory Map / Hex Editor와 동일한 `entryType === 'tool'` 모델·`recordHistory` 콜백 패턴을 그대로 사용한다.

#### UX

- **JSON Editor 열람 이력 저장**: `TaskHub: Open JSON Editor`, 컨텍스트 메뉴(`taskhub.openJsonEditorFromUri`), 그리고 History row 다시 열기로 JSON Editor 패널을 성공적으로 열면 History 패널에 기록한다(`json` 아이콘으로 구분). row를 클릭하면 저장된 경로로 다시 열고, 다시 열기도 최신 이력으로 추가된다. 파일을 못 찾거나 파싱 실패·크기 초과 등으로 패널이 열리지 않은 경우, 또는 dirty 상태에서 변경사항 버리기를 취소한 경우에는 기록하지 않는다(`openJsonEditorWithPath`가 `boolean` 반환). 참조: [src/jsonEditor.ts](src/jsonEditor.ts), [src/providers/historyProvider.ts](src/providers/historyProvider.ts), [src/extension.ts](src/extension.ts).

### 수정 — JSON Editor 컨텍스트 메뉴 인자 정규화

`taskhub.openJsonEditorFromUri`가 SCM(`scm/resourceState/context`) 메뉴에서 호출될 때 VS Code가 `Uri`가 아닌 `SourceControlResourceState`(`{ resourceUri: Uri }`)를 넘겨, 기존 코드의 `uri.fsPath`가 `undefined`가 되며 `openJsonEditorWithPath`에서 터지던 문제를 수정한다. previewOpener의 `coerceToUri()`를 재사용해 `Uri` / `Uri[]` / `{ resourceUri }` 형태를 모두 정규화한다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts), [src/previewOpener.ts](src/previewOpener.ts).

#### 문서

- features.md §14 / architecture.md의 `HistoryEntry` 구조·도구 히스토리 노트에 JSON Editor를 반영. 참조: [docs/features.md](docs/features.md), [docs/architecture.md](docs/architecture.md).

**테스트**: 신규 1 케이스 — `createToolHistoryEntry`의 JSON Editor tool 엔트리 생성과 row가 `taskhub.openToolFromHistory`를 호출하는지 검증.

## [0.4.36] - 2026-05-12

### 추가 — History에 Memory Map / Hex Editor 열람 기록

History 패널이 액션 실행만 추적하던 것에서, TaskHub 도구(Memory Map / Hex Editor) 열람 기록까지 함께 남기도록 확장한다. 새 저장소 키를 만들지 않고 기존 `HistoryEntry`에 `entryType` 판별자 + `tool` 메타데이터를 더해 같은 패널·persistence를 재사용한다.

#### UX

- **도구 열람 이력 저장**: `TaskHub: Show Memory Map`으로 연 ELF/AXF/ARM Linker Listing과 `TaskHub: Open Hex Viewer` 또는 `taskhub.hexEditor` custom editor로 연 Hex/Binary 파일을 History 패널에 함께 기록한다. 도구 이력 row(`graph` / `file-binary` 아이콘)를 클릭하면 저장된 파일 경로로 해당 뷰어를 다시 열고, 다시 열기도 최신 이력으로 추가된다. Memory Map은 ELF/listing 입력 종류와 당시 사용한 region 설정을 함께 보존해, 다시 열 때 링커 스크립트 선택 다이얼로그를 건너뛴다. 파싱 실패·크기 초과 등 패널이 열리지 않은 경우에는 기록하지 않는다. 참조: [src/providers/historyProvider.ts](src/providers/historyProvider.ts), [src/extension.ts](src/extension.ts), [src/memoryMapViewer.ts](src/memoryMapViewer.ts), [src/hexViewer.ts](src/hexViewer.ts).

#### 문서

- features.md §14와 architecture.md의 `HistoryEntry` 구조 설명을 action/tool 공용 히스토리 모델에 맞게 갱신. 참조: [docs/features.md](docs/features.md), [docs/architecture.md](docs/architecture.md).

**테스트**: 신규 2 케이스 — `createToolHistoryEntry`의 Memory Map 메타데이터 저장과 tool history row가 `taskhub.openToolFromHistory`를 호출하는지 검증. 최종 1196 passing.

## [0.4.35] - 2026-05-11

### 변경 — Memory Map 검색 매치 네비게이션 + 비매치 region 카드 숨김

0.4.34 의 검색 가시성 개선(매치 하이라이트 / sticky / 첫 매치 스크롤)에 이어, 브라우저 "찾기" 와 같은 매치 이동(◀▶/Enter)과 검색 시 페이지가 *결과 중심* 으로 접히는 동작을 추가한다.

#### UX

- **매치 네비게이션**: 검색창 오른쪽에 `◀ ▶` 버튼과 `3 / 17` 위치 카운터. `Enter` = 다음, `Shift+Enter` = 이전, 양 끝에서 순환. 이동 시 해당 행을 `scrollIntoView({ block: 'center' })` 로 가운데에 두고 "현재 매치" 에 진한 강조(`--vscode-list-activeSelectionBackground` 배경 + 왼쪽 accent border + 그 행의 `<mark>` 는 `--vscode-editor-findMatchBackground`). 검색 직후 첫 매치가 자동 선택된다. 가상 스크롤(>200행) region 의 매치도 — 대부분 DOM 에 없으므로 — 논리 인덱스로 추적해, 이동 시 뷰포트를 해당 행으로 스크롤한 뒤 행을 해석한다. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `rebuildMatchList` / `revealMatch` / `goToMatch` / `updateNavUI`.
- **검색 시 비매치 region 카드 숨김 + 헤딩 매치 수**: 검색 중 매치가 0개인 `.region-card` 는 `display:none` 으로 접어 매치 사이의 노이즈를 없앤다. `All Sections (12 / 540)`, `Region Details — 2 regions matched` 처럼 헤딩에 매치/전체 수를 표기. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `doSearch` (`allSecCount` / `regMatchInfo`).
- **카운트 문구 정리**: 0.4.34 의 `27 matches in 4 regions` 는 네비게이션 카운터 `3 / 17` 로 대체(리전 수는 위 "Region Details" 헤딩으로, All Sections 매치 수는 그 헤딩으로 이전). 결과 없음은 그대로 경고색 `No matches`. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `updateNavUI`.
- **정렬 후 매치 네비게이션 재동기화**: matchList 는 현재 DOM 행 참조(또는 가상 테이블의 행 인덱스)를 담는데, 컬럼 정렬은 그 행들을 재배치(가상 테이블은 재렌더)한다. 정렬 후 ◀▶/Enter 가 옛 순서·detached 행을 잡지 않도록, 검색 활성 상태에서 All Sections / region section 테이블을 정렬하면 `resyncAfterReflow()` 가 matchList 를 다시 만들고 `curMatch` 를 첫 매치로 재설정한 뒤 카운트를 갱신한다(검색과 무관한 obj-summary 정렬은 건드리지 않음). 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `resyncAfterReflow` / `initSort` / 데이터 기반 region 정렬 핸들러.
- **접힌 region 의 매치로 이동 시 자동 펼침**: 검색 후 사용자가 매치 있는 region 을 접거나 `Collapse All` 을 누르면 matchList 항목은 여전히 숨겨진 `.region-detail` 안의 행을 가리킨다. ◀▶/Enter 로 그 매치로 이동할 때 `revealMatch()` 가 대상 행의 region 이 접혀 있으면 먼저 펼친 뒤(`ensureRegionExpanded()` — display 복원 + fold 아이콘·Expand/Collapse All 라벨 동기화, 가상 테이블은 펼친 후 `clientHeight` 가 잡힌 상태에서 뷰포트를 스크롤) 행을 해석한다. 카운터만 움직이고 화면엔 안 나타나던 문제 해소. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `ensureRegionExpanded` / `revealMatch`.

#### 문서

- features.md §19 *검색 및 탐색* 의 키워드 검색 항목을 새 동작(매치 네비게이션 / 비매치 카드 숨김 / 헤딩 매치 수 / 카운터 형식)에 맞게 갱신. 참조: [docs/features.md](docs/features.md).

**테스트**: 기존 webview-HTML 스모크 케이스 2종을 새 동작에 맞게 갱신 — `tr.current-match` 스타일 / `searchPrev`·`searchNext` 버튼 / `allSecCount` 헤딩 span / `goToMatch`·`revealMatch`·`rebuildMatchList`·`resyncAfterReflow`·`ensureRegionExpanded` 헬퍼 / `(curMatch + 1) + ' / ' + matchList.length` 카운터 형식 포함 여부 확인. 최종 1194 passing.

## [0.4.34] - 2026-05-11

### 변경 — Memory Map 검색 결과 가시성 개선

Memory Map 패널에서 클래스명/심볼명을 검색하면 "N matches" 카운트만 나오고 *그 매치가 화면 어디에 있는지* 알기 어렵던 문제를 해결한다. 검색 동작(필터링·자동 펼침) 자체는 그대로 두고, 결과를 눈으로 찾는 비용만 낮췄다.

#### UX

- **매치 텍스트 하이라이트**: Region Details 테이블(가상 스크롤 포함)과 All Sections / Overview 테이블 모두에서 검색어와 일치하는 부분 문자열을 `<mark class="sm-hl">`(에디터 찾기 강조색 `--vscode-editor-findMatchHighlightBackground`)으로 칠한다. 행 단위 배경 틴트(`.search-match`)만 있던 정적 테이블에도 글자 단위 강조가 추가됐다. 정적 테이블은 서버 렌더 HTML이라 원본 `innerHTML`을 캐시한 뒤 텍스트 노드를 순회해 `<mark>`를 끼우고, 검색어가 바뀌거나 비워지면 원본으로 복원한다. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `hl` / `markTextNodes` / `rowHtml`.
- **검색창 상단 고정**: 검색 박스를 `position: sticky; top: 0`으로 고정해, 결과를 보러 아래로 스크롤해도 입력창과 매치 카운트가 항상 보인다. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `.search-box`.
- **첫 매치로 자동 스크롤**: 검색 후 문서 순서상 가장 앞선 매치가 화면 밖(고정 검색바 뒤 포함)에 있으면 `scrollIntoView({ block: 'center' })`로 가져온다. 이미 보이는 위치면 스크롤하지 않는다. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `doSearch`.
- **카운트 문구 보강**: `27 matches` → `27 matches in 4 regions`(단·복수 분기), 결과 없음은 빈 문자열 대신 경고색 `No matches`로 표시. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `doSearch` / `.search-count`.
- **검색 시 Section/Function 컬럼 자동 표시**: `matchSeg()` 는 Section/Function 토큰도 검색하는데 그 두 컬럼(`.func-cell`)은 기본 숨김이라, 함수명으로 검색하면 `<mark>` 가 보이지 않는 셀 안에 생기고 `scrollIntoView` 대상이 크기 0짜리 노드가 되어 *"첫 매치 스크롤 + 보이는 하이라이트"* 가 동작하지 않던 문제. 검색이 활성화되면 두 컬럼을 펼치고(`searchAutoFunc`), 검색어를 비우면 우리가 펼친 만큼만 다시 접는다. 검색 도중 사용자가 `Function ▶/▼` 버튼으로 직접 접/펼치면 `funcUserOverride` 로 기억해 그 검색 세션이 끝날 때까지 다음 입력 이벤트의 자동 펼침이 끼어들지 않는다(검색어가 비워지면 override 도 해제 — 다음 검색은 다시 자동 펼침). 겸사겸사 토글 버튼 라벨이 상태와 무관하게 항상 `Function ▶` 로 고정돼 있던 기존 버그도 `▶`↔`▼` 동기화로 수정. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `doSearch` / `toggleFuncCol` / `syncFuncBtn`.
- **검색창 placeholder 갱신**: `Search sections... (name, address, type)` → `Search... (object, section, function, address, size, type)` — 실제 검색 대상 필드와 일치. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts).

#### 문서

- features.md §19 *검색 및 탐색* 의 키워드 검색 항목을 새 동작(매치 하이라이트 / 상단 고정 / 첫 매치 스크롤 / 매치 수·리전 수 표시)에 맞게 갱신. 참조: [docs/features.md](docs/features.md).

**테스트**: 신규 2 케이스 — 생성된 webview HTML 에 (a) `.search-box { position: sticky }` / `mark.sm-hl` / `.search-count.no-match` 스타일 + `function` 을 언급하는 placeholder, (b) `hl()` · `markTextNodes()` 헬퍼 · 첫 매치 `scrollIntoView` · `No matches` 문구 · `' in '` 리전 수 접미사 · `searchAutoFunc`(검색 시 func 컬럼 자동 표시)가 포함되는지 확인 (`panelRegistry.getHtml` 신규 export). 검색 하이라이트·스크롤 자체는 webview DOM 동작이라 확장 호스트에서 직접 검증 불가 — 깨진 템플릿 리터럴로 `<script>` 가 통째로 누락되는 회귀는 잡힌다. 최종 1194 passing.

## [0.4.33] - 2026-05-07

### 변경 — 액션/즐겨찾기 데이터 보호 (코드 리뷰 4건 반영)

0.4.30~0.4.32 의 broken-JSON 보호 / 흐름 압축 / 확인 누락 차단 패턴을 같은 결로 남아 있던 4 곳에 적용한다. 모두 *깨진 파일을 무방비로 덮어쓰기* / *한 클릭 회복 불가* 카테고리라 한 릴리스로 묶었다.

#### High (실제 데이터 유실 차단)

- **`Apply Preset` 의 `Replace` 경로가 깨진 actions.json 을 검증/백업 없이 덮어쓰던 문제**: `hasExisting` 은 `fs.existsSync` 만 보고, `Replace` 분기는 `loadAndValidateActions` 를 호출하지 않은 채 `finalActions = presetActions` 로 넘어가 바로 `fs.writeFileSync` 했다. 같은 명령의 `Merge` 분기는 `loadAndValidateActions` 가 throw 해서 *프리셋 적용 실패* 로 끝나 — 같은 명령 내부에서도 보호 수준이 비대칭이었다. 0.4.32 의 broken-JSON write 차단과 `Import Actions` 의 `.bak` 백업 패턴을 한 곳으로 합쳐, `Replace`/`Merge` 분기 *공통* 의 사전 검증 단계를 두었다. existing actions.json 이 invalid 면 `손상된 파일 백업 후 계속 / 취소` modal 을 띄우고, 사용자가 백업을 선택하면 `actions.json.bak` 으로 원본을 옮긴 뒤 `existingActions = []` 로 진행한다(`Replace` 는 그대로 preset, `Merge` 는 빈 배열에 preset merge 되어 효과가 같다). `Merge` 분기에서 `loadAndValidateActions` 를 한 번 더 호출하던 부분도 사전 검증 결과를 재사용해 같은 파일을 두 번 읽지 않는다. 참조: [src/extension.ts](src/extension.ts) `taskhub.applyPreset`.

#### Medium (상태 무결성 / 명령 오동작)

- **`Add Favorite File` / `Add Open File to Favorites` 가 동일 항목을 중복 저장하던 문제**: `Add Link` 는 `addLinkEntry` 에서 *title + link* 일치 시 `{ added: false }` 로 반환하고 *links.json 열기* 회복 토스트를 띄우는데, favorite 쪽은 `[...entries, newEntry]` 로 무조건 push 했다. `removeFavoriteByIdentity` 가 *path + line + title + group* 일치하는 모든 행을 한 번에 제거하는 구조라, 중복이 쌓인 후 Delete 를 누르면 의도치 않게 다중 삭제가 발생하는 비대칭이었다. 신규 export `addFavoriteEntry` 를 두어 동일한 identity (path + line + title + group, undefined 와 missing 을 같은 키로 fold) 로 duplicate 를 차단하고, `addFavoriteFile` (다중 파일 다이얼로그) 의 결과 토스트는 *N개 추가됨 (M개 중복 건너뜀, K개 건너뜀)* 으로 합쳐 표시한다. 모든 파일이 중복이면 *이 즐겨찾기는 favorites.json 에 이미 존재합니다* + *favorites.json 열기* 버튼만 띄우고 disk write 자체를 생략 — 변경 없는 파일을 다시 직렬화해 mtime 만 튀게 하던 부수 동작도 같이 사라져, 0.4.30 JSON Editor 의 *external change* prompt 가 무관한 편집기에서 뜨던 잠재 문제도 막힌다. `Add Open File to Favorites` 도 같은 helper 를 거쳐, 같은 라인을 두 번 추가하면 *'name' (줄 N) 는 favorites.json 에 이미 존재합니다* 회복 토스트로 끝낸다. 참조: [src/extension.ts](src/extension.ts) `addFavoriteEntry` / `taskhub.addFavoriteFile` / `taskhub.addOpenFileToFavorites`.

- **`Save as Preset` 이 같은 ID 의 기존 preset 을 확인 없이 덮어쓰던 문제**: `presetId` 입력 후 *Workspace / Extension / Custom* 중 첫 두 위치는 `${dir}/preset-${presetId}.json` 으로 경로를 결정 후 바로 `fs.writeFileSync` 했다. *Custom* 분기는 `showSaveDialog` 가 OS 레벨 덮어쓰기 confirm 을 자동 제공해 보호되어 있어, 같은 명령 안에서도 위치별 보호 수준이 달랐다. 두 분기에 명시적 modal 가드를 추가 — 기존 파일이 있으면 *덮어쓰기 / 기존 파일 열기 / 취소* 3 분기로 묻고, *기존 파일 열기* 를 고르면 해당 파일을 편집기에서 열고 명령을 종료한다. 사용자가 prompt 만 채우다 새 preset 인지 update 인지 분간 못 한 채 기존 작업이 사라지던 케이스 차단. 참조: [src/extension.ts](src/extension.ts) `taskhub.saveAsPreset`.

- **`Delete History Item` 이 confirm 없이 즉시 삭제되던 문제**: `Delete Favorite` / `Delete Link` / `Clear All History` 는 모두 modal 경고로 보호되는데 단일 history 항목만 inline 휴지통 클릭 한 번에 즉시 사라졌다. 같은 카테고리 내부의 비대칭이라 modal `'X' 기록 항목을 삭제하시겠습니까?` 를 추가 — actionTitle 을 본문에 노출해 같은 액션이 여러 번 실행된 패널에서도 행을 식별할 수 있게 했다. 참조: [src/extension.ts](src/extension.ts) `taskhub.deleteHistoryItem`.

#### 문서

- features.md §6 *즐겨찾기 패널* / §14 *액션 실행 히스토리* / §17 *Preset 기능* 의 추가·삭제·덮어쓰기 흐름과 데이터 보호 동작을 새 가드에 맞게 갱신. §17 *Keep both* 분기의 *모든 actions 유지 (중복 허용)* 표현은 실제 동작(`mergeActions` 의 `filterConflictingItems`)과 어긋나 *충돌하지 않는 preset 항목만 추가* 로 정정. §6 의 *모든 파일이 중복* 안내도 단·복수 분기(1개 / N개) 가 모두 있다는 사실을 반영하도록 표현 완화. 참조: [docs/features.md](docs/features.md).

**테스트**: 신규 17 케이스. (a) `addFavoriteEntry` 6종 — unique add / dup by path+title / dup by line / different lines / different groups / undefined-vs-missing group fold. (b) prompt 가드 회귀 11종 — `confirmDeleteHistoryItem` 3종 (cancel / Yes / modal+title 포함 검증), `confirmApplyPresetBackup` 4종 (cancel dismiss / cancel label / backup label / .bak 파일명·reason 본문 포함 검증), `confirmSavePresetOverwrite` 4종 (cancel dismiss / overwrite / open-existing / basename 본문 포함 검증). 헬퍼는 `extension.ts` 에서 export 되어 있으며, 호출처(`taskhub.deleteHistoryItem` / `taskhub.applyPreset` / `taskhub.saveAsPreset`) 도 같은 헬퍼를 거치도록 정리해 prompt 문구·modal 플래그·반환값 매핑이 한 자리에 모이게 했다.

## [0.4.32] - 2026-05-05

### 변경 — Add Link / Add Favorite UX 정리 + broken JSON 데이터 손실 차단 (코드 리뷰 4건 반영)

`Add Link`, `Add File to Favorites`, `Add Open File to Favorites` 세 명령에 0.4.31의 Create Action 마법사 정리(자동 default + post-creation 토스트 + broken-JSON 회복 경로)를 같은 결로 적용했다. 그 와중에 발견된 P1 데이터 유실 버그 — 깨진 links/favorites.json 을 add 명령이 *조용히 덮어쓰는* — 도 같은 릴리스에서 잡았다.

#### High (실제 데이터 유실 차단)

- **깨진 `links.json` / `favorites.json` 이 add/delete/edit 시 신규 1개 항목으로 덮어써지던 문제**: `loadLinksFromDisk` / `loadFavoritesFromDisk` 가 parse 실패 시 에러 토스트만 띄우고 `[]` 를 반환했다. add 명령은 그 빈 배열에 신규 항목을 push 하고 `fs.writeFileSync` 로 디스크를 덮어써 *기존 항목 전체가 사라졌다*. 사용자는 에러 토스트를 봤지만 add 가 성공한 것으로 인식 — 트리 새로고침 시 1개만 남은 모습이 보일 뿐이었다. 동일 패턴이 delete/edit/cleanup 경로에도 있었다. 트리 렌더링은 forgiving 한 [] fallback 이 옳지만 write 경로는 그러면 안 된다는 판단으로 두 provider 에 `read{Links,Favorites}FromDisk` 를 별도로 추가 — `{ ok: true, entries } | { ok: false, error }` tagged result 를 돌려준다. 모든 write 경로(addLink / addFavoriteFile / addOpenFileToFavorites + deleteLink / deleteFavorite + favorites cleanup + workspace link edit) 가 새 함수를 사용해 `!ok` 면 *X.json 열기* 버튼이 달린 에러 토스트로 회복 경로를 제공하고 저장은 거부한다. 0.4.31 의 broken-actions.json 보호 패턴이 links / favorites 쪽으로 확장된 셈이다. 참조: [src/providers/linkViewProvider.ts](src/providers/linkViewProvider.ts) `readLinksFromDisk`, [src/providers/favoriteViewProvider.ts](src/providers/favoriteViewProvider.ts) `readFavoritesFromDisk`.

#### UX / 일관성

- **Add Link / Edit Workspace Link 흐름 압축 + 동일한 save-time URL 게이트**: Add 의 기존 *folder pick → title → URL → group → tags → save* (4 prompt) 를 *folder pick → URL → title* (2 prompt) 로 줄였다. URL prompt 의 `validateInput` 은 `validateLinkUrlForSave` (scheme allowlist + WHATWG `new URL()` parse) 를 거치도록 했다. 두 단계가 모두 필요한 이유: 단순 scheme 검사는 `^scheme:` 정규식만 보기 때문에 `https://` 같은 scheme-only 입력이 통과해 *클릭 시점에야* 에러 토스트로 실패했다. `new URL()` parse 를 추가해 그 케이스를 입력 단계에서 잡는다. 같은 게이트를 *workspace link 편집* prompt 에도 적용 — Add 는 막고 Edit 는 통과하던 비대칭(`javascript:`/`file:` 같은 scheme 으로 기존 항목을 덮어쓸 수 있던 문제)도 함께 해소. title 은 URL 의 host(`new URL(url).host` 에서 `www.` 접두사 제거)로 prefilled 되어 Enter 한 번이면 `github.com` 같은 의미 있는 라벨이 들어간다. group / tags 는 묻지 않고 default `undefined` — *그룹/태그 등 추가 설정이 필요하면 links.json 을 편집하세요* 안내 + *links.json 열기* 버튼이 post-creation 토스트로 그 자리를 메운다. 중복 탐지 시에도 *links.json 열기* 버튼을 제공해 사용자가 흔적을 잃지 않게 한다. 참조: [src/extension.ts](src/extension.ts) `taskhub.addLink` / `promptWorkspaceLinkEdit` / `linkUrlValidateInputMessage`, [src/pipelineUtils.ts](src/pipelineUtils.ts) `validateLinkUrlForSave`. WHATWG parse 의 한계도 명시한다: `https:///path` 같은 입력은 WHATWG 가 슬래시를 정규화해 `https://path/` (host = `path`, pathname = `/`) 로 조용히 해석되어 게이트를 통과한다 — 사용자 의도와 다르게 host 가 바뀌어 저장될 수 있어 click 시점의 `vscode.Uri.parse` 가 최종 fail-safe 로 남는다.
- **Add File to Favorites 흐름 압축 — 다중 파일 선택 후 zero prompt**: 기존 *group → tags → 파일별 title → 파일별 line number* (5+2N prompt) 를 파일 다이얼로그 한 번 + 즉시 저장 으로 단축. 선택한 파일들은 *title = basename, path = 워크스페이스 상대경로* 로 한 번에 기록된다. 다이얼로그의 `defaultUri` 도 multi-root 환경에서 *활성 편집기의 워크스페이스 폴더* 를 우선 사용하도록 바꿔, 매번 `workspaceFolders[0]` 에서 시작하던 비직관적 동작을 고쳤다. 워크스페이스 밖 파일이 섞여 있으면 그 파일만 건너뛰고 *N개 추가됨 (M개 건너뜀)* 결과 요약을 토스트로 보여주며, 어느 `favorites.json` 이 깨져 있으면 그 폴더 분량만 저장 거부 + 별도 회복 토스트 — 다른 폴더의 정상 저장은 계속 진행된다. 그 결과 line prompt 의 *Esc=전체 abort* 와 title prompt 의 *Esc=이 파일만 skip* 비일관성도 자연스럽게 사라졌다(prompt 자체가 없으므로). 참조: [src/extension.ts](src/extension.ts) `taskhub.addFavoriteFile`.
- **Add Open File to Favorites 흐름 압축 — 0 prompt**: *title → group → tags → line number* (4 prompt) 를 모두 제거. 활성 편집기의 파일과 현재 커서 위치(`editor.selection.active.line + 1`)로 즉시 저장하고 post-creation 토스트로 결과를 알린다. 그 결과 *컨텍스트 메뉴 클릭 → 토스트* 단일 동작으로 끝나며, 추가 메타데이터는 토스트의 *favorites.json 열기* 로 다듬는다. 참조: [src/extension.ts](src/extension.ts) `taskhub.addOpenFileToFavorites`.
- **add 명령 전반에 post-creation 토스트 도입**: 기존 add 명령들은 disk write 후 트리 refresh 만 하고 사일런트로 끝났다. Action 마법사 0.4.31 패턴을 따라 *'X' 가 추가되었습니다. 그룹/태그 등 추가 설정이 필요하면 ... 편집하세요* + 해당 JSON 파일 열기 버튼을 두어 (a) 어느 파일에 어떤 항목이 들어갔는지 시각적 확인, (b) default 로 채워진 부수 옵션을 다듬는 진입점, (c) multi-file 결과 요약(*N개 추가됨 / M개 건너뜀*) 을 동시에 제공한다.

#### 문서

- features.md §4 *워크스페이스 링크 패널* / §6 *즐겨찾기 패널* 의 추가 흐름 설명을 새 동작에 맞게 다시 작성. 자동 default(URL host → title), 0-prompt 즉시 저장, multi-root 다이얼로그 default 변경, broken-JSON 회복 경로를 명시. 참조: [docs/features.md](docs/features.md).

**테스트**: 신규 18 케이스 (`deriveLinkTitleFromUrl` 5종, `readLinksFromDisk` / `readFavoritesFromDisk` tagged-result 6종, `validateLinkUrlForSave` 6종, WHATWG `https:///path` 정규화 회귀 가드 1종), 최종 1175 passing.

## [0.4.31] - 2026-05-05

### 변경 — Create Action 마법사 UX 정리 (코드 리뷰 4건 반영)

`TaskHub: Create Action` 흐름이 사용자가 하려는 핵심("이름과 명령어 입력")보다 내부 식별자(`action id` / `task id`)와 토스트 문구(success/fail message) 같은 부수 항목을 먼저 묻고 있었다. 처음 액션 하나 만들 때 8~10개의 단발 prompt 가 줄줄이 떠 흐름이 무거웠다. 두 차례 리뷰에서 같은 결론(P2 4건 + P3 1건)으로 모인 항목을 한 릴리스로 묶어 반영한다.

#### Medium (설명/동작 불일치)

- **루트 destination 항목 설명이 실제 삽입 위치와 달랐다**: Quick Pick 의 루트 항목은 "actions.json 최상단에 추가 / Add at the top of actions.json"라고 표시하지만 `insertActionIntoDestination` 은 `workspaceActions.push(newAction)` 으로 배열 끝에 추가했다. 사용자는 *최상단*을 기대하는데 실제로는 리스트 끝에 만들어져 트리에서 못 찾는 사고가 가능했다. 동작은 기존 테스트(`should push new action to root when destination has no folderRef`)가 보장하는 *append* 가 맞는 의도이므로, 설명을 *위치*가 아니라 *레벨* — "폴더 밖 최상위에 추가 / Add at top level (outside folders)" — 로 교정. 회귀 가드로 description 에 `최상단`/`top of` 가 다시 들어가지 못하게 단언하는 unit test 를 추가. 참조: [src/extension.ts](src/extension.ts) `buildDestinationPickItems`.

#### UX / 일관성

- **prompt 순서 재배치 — 핵심 입력에 빨리 도달**: 기존 흐름 `id → title → description → success → fail → destination → taskId → command → cwd → reveal` 을 `template → title → 핵심 입력(쉘 명령어 한 줄, File Picker + Shell 은 `${selectFile.path}` 가 prefill 된 동일 prompt) → destination(폴더 있을 때만) → 저장 + post-creation` 으로 압축. `action id` 는 제목에서 자동 도출(`deriveActionIdFromTitle`: 소문자 슬러그, 충돌 시 `-2`/`-3` suffix), `task id` 는 `run`/`selectFile` 로 하드코딩, `description` 은 템플릿 default 사용, file picker `openLabel` / `cwd` / `revealTerminal` / `successMessage` / `failMessage` 는 omit (`always` reveal 과 메시지 없음이 default 동작과 동일, `openLabel` default 는 *파일 선택* / *Select file*). 첫 사용 경로가 3-4 prompt 로 줄고, 더 손보고 싶으면 post-creation 의 *actions.json 열기* 로 즉시 점프. 참조: [src/extension.ts](src/extension.ts) `runActionCreationWizard`/`ACTION_TEMPLATES`/`deriveActionIdFromTitle`.
- **destination 단일 옵션 prompt 자동 skip**: actions.json 에 `type: 'folder'` 항목이 하나도 없으면 위치 선택 Quick Pick 은 *Root* 한 항목만 띄우는 의미 없는 단계가 됐다. `buildDestinationPickItems().length === 1` 일 때 prompt 자체를 건너뛰고 root 로 곧장 진행. 참조: [src/extension.ts](src/extension.ts) `promptForActionDestination`.
- **깨진 actions.json 에 *actions.json 열기* 복구 경로 제공**: 기존에는 `loadWizardActionSources` 가 throw 하면 *액션 소스를 불러오지 못했습니다* 토스트만 띄우고 끝났다. 이제 같은 토스트에 *actions.json 열기* 액션 버튼을 함께 두어, 파싱 실패/스키마 위반으로 마법사가 진입조차 안 될 때도 사용자가 그 자리에서 파일을 열어 고칠 수 있다. 참조: [src/extension.ts](src/extension.ts) `runActionCreationWizard` catch 분기.
- **post-creation 토스트에 *추가 설정* 안내 한 줄 추가**: 마법사가 `cwd`/`revealTerminal`/`successMessage`/`failMessage` (그리고 file-dialog 템플릿의 `openLabel`)를 묻지 않고 default 로 채우는 만큼, 그런 옵션이 *존재한다는 사실 자체*를 모르는 사용자가 생긴다. 생성 직후 토스트 본문을 `'X' 액션이 actions.json에 추가되었습니다. cwd, revealTerminal, 성공/실패 메시지 등 추가 설정이 필요하면 actions.json을 편집하세요.` 로 확장 — 같은 토스트의 *actions.json 열기* 버튼이 그 진입점을 그대로 제공한다. 참조: [src/extension.ts](src/extension.ts) `handlePostCreationChoice`.

#### 문서

- features.md §8 *액션 생성 마법사* 절을 새 흐름(템플릿 → 제목 → 핵심 입력 → destination[있을 때만] → 자동 저장)에 맞게 다시 작성. 자동 도출되는 ID, omit 되는 부수 옵션, 깨진 actions.json 복구 경로를 명시. 참조: [docs/features.md](docs/features.md).

**테스트**: 신규 8 케이스 (`buildDestinationPickItems` 3종 + `deriveActionIdFromTitle` 5종), 최종 1157 passing.

## [0.4.30] - 2026-05-05

### 추가 — JSON Editor 데이터 보호 (저장 차단 / Undo / 외부 변경 / 복구)

이 에디터는 "편하게 수정"보다 **"수정한 걸 믿고 저장할 수 있음"** 이 먼저라는 판단 아래, 사용자가 입력한 변경이 조용히 사라지거나 stale 상태로 디스크에 기록되는 시나리오를 한 릴리스에서 함께 잡았다.

#### High (데이터 손실 차단)

- **invalid JSON 셀 편집 중 저장 시 stale data가 기록되던 문제**: object/array JSON 셀이 invalid 상태에서 Save / Ctrl+S 를 누르면, `commitCell`이 파싱 실패로 조용히 early return 했음에도 webview 가 그대로 `vscode.postMessage({ command: 'save' })` 를 보내 호스트가 **이전 값**을 디스크에 저장했고 modified 표시까지 내려갔다. 사용자는 자기 입력이 저장됐다고 믿지만 실제로는 잃었다. `commitCell` 시그니처를 `boolean` 반환으로 바꾸고, Save / Ctrl+S / 다른 셀로의 click-to-edit 모두 false 반환 시 후속 동작을 중단하도록 가드. invalid 셀은 editing 상태 그대로 유지되며 에러 메시지가 보존된다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `commitCell`/`saveAction`.
- **dirty 상태 패널 닫힘 시 미저장 변경 복구 경로 부재**: WebView Panel 은 close veto 가 약해 사용자가 X 버튼으로 탭을 닫으면 unsaved 편집이 그대로 사라졌다. 이제 commit / mutation 마다 webview 가 `'snapshot'` 메시지로 현재 wrapped data를 호스트에 전송하고, 호스트는 300ms 디바운스로 `workspaceState`(키 `taskhub.jsonEditor.recovery`)에 `{data, isRootArray, fileMtimeMs, fileSize?, capturedAt}` 형태로 기록한다. 다음 번 같은 파일을 열 때 디스크 mtime + size fingerprint 가 캡처 시점과 일치하면 "이전 세션의 미저장 변경사항이 있습니다. 복구하시겠습니까?" 다이얼로그를 띄우고, 외부에서 파일이 변경됐다면(mtime 변경 또는 mtime 보존 + size 변경) 자동으로 폐기한다. 옛 엔트리(`fileSize` 없음) 나 stat 실패로 현재 size 를 모를 때는 mtime-only 폴백. mtime + size 모두 같은 채 내용만 바뀌는 외부 변경(같은 길이 in-place 패치 등)은 감지하지 못하는 한계가 남아 있어, 의심되면 사용자가 *다시 읽기* 로 명시적 동기화를 트리거하는 흐름이다. 자동 복원이 아니라 **명시적 프롬프트**라 의도적으로 닫은 사용자가 원치 않게 살아나는 사고를 막는다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `offerRecoveryIfAny`, [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) `shouldOfferRecovery`.
- **JSON Editor가 열린 상태에서 외부 변경(git checkout 등)이 보이지 않던 문제**: 이전에는 메모리 사본이 stale 한 채로 그 위에서 편집하다가 저장하면 외부 변경이 그대로 덮어써졌다. `vscode.workspace.createFileSystemWatcher(RelativePattern)` 으로 대상 파일을 감시하고, JSON Editor 자신이 막 쓴 변경(`currentLastWriteMtime` + `currentLastWriteSize` 모두 일치)은 무시. mtime 만으로는 mtime 보존형 외부 변경(`touch -r`, 일부 sync 도구) 이 self-write 로 오인되므로 size 도 함께 본다. dirty 상태에서 외부 변경이 감지되면 "다시 읽기 / 현재 편집 유지" 모달을 띄우고, dirty 가 아니면 자동으로 다시 읽으면서 상태바에 알림을 띄운다. 파일이 외부에서 삭제된 경우는 경고 메시지로 알린다.

#### Medium (편집 신뢰성)

- **Undo / Redo 신설 (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, 툴바 ↶ ↷ 버튼)**: 셀 commit 성공·행 추가/삭제·드래그 정렬·string↔array 변환·태그 추가/삭제 7가지 mutation 단위로 webview 메모리 히스토리에 `JSON.stringify(data)` 스냅샷을 push 한다. **20 step / 16 MB 중 먼저 도달하는 cap** 으로 가장 오래된 스냅샷부터 evict. 셀 편집 중(`td.editing` 존재) 에는 undo/redo 가 동작하지 않아 브라우저 input 의 기본 undo 가 우선 — 한 글자 지우려다 직전 행 삭제가 되돌려지는 사고를 방지. modified 플래그는 `lastSavedSnapshot` 과 현재 인덱스 비교로 정확하게 갱신된다(undo 로 저장 시점 데이터와 동일해지면 자동으로 깨끗한 상태로). 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `pushHistory`/`undo`/`redo`.

#### UX / 일관성

- **WebView Panel 에 `enableFindWidget: true`**: Ctrl+F (macOS Cmd+F) 로 VS Code 기본 찾기 위젯이 동작해 현재 보이는 DOM 텍스트(셀 값, 컬럼 헤더, 태그 등)를 즉시 검색할 수 있다. 행 필터의 대체재는 아니지만 비용 0 으로 즉시 체감되는 개선이다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `createWebviewPanel` 옵션.

#### 회귀 가드 (drift 방지)

webview JS 가 문자열 템플릿으로 박혀 있어 한쪽만 수정해도 CI 가 통과하던 문제를 줄이려고 mirror sync 테스트를 두텁게 했다. 새로 추가된 가드:

- `commitCell` 가 invalid-JSON 분기마다 `return false` 를 보존하고 함수 끝이 `return true` 로 끝나는지
- `saveAction` 이 `if (editingTd && !commitCell(editingTd)) { return; }` 패턴으로 진입 차단을 하는지
- `undo()` / `redo()` 가 `td.editing` 가드를 가지고 있는지
- 7가지 mutation marker(`data-remove-arr`, `data-add-arr`, `data-convert`, `data-delete-row`, `dragSrcIdx`, `btnAddRow`, `commitCell`) 각각 동일 핸들러 안에서 `pushHistory()` 를 호출하는지

참조: [src/test/jsonEditorUtils.test.ts](src/test/jsonEditorUtils.test.ts) `webview ↔ jsonEditorUtils mirror synchronization` suite.

### 수정 — 코드 리뷰 후속 (debounce / stale row index / recovery baseline)

위 안전성 패치를 처음 들어간 직후 5건의 follow-up 이슈가 코드 리뷰에서 식별돼 같은 릴리스에 묶었다. 모두 데이터 손실/오염으로 직결되거나, 사용자 의도와 어긋나는 경로였다.

#### High (실제 데이터 손실 가능)

- **debounce 창 안에 닫힐 때 pending snapshot 유실**: webview 가 mutation 시 host 로 보낸 snapshot 은 300ms 디바운스로 workspaceState 에 기록되는데, 그 창 안에 사용자가 패널을 X 로 닫으면 dispose 핸들러가 timer 를 cancel 하면서 `currentPendingSnapshot` 을 그대로 버렸다. "edit → 즉시 close" 경로에서 가장 최근 변경이 복구되지 않았다. host 측에 `flushPendingSnapshot()` 클로저를 모듈-레벨로 올리고(`currentFlushPendingSnapshot`), dispose 가 reset 보다 먼저 그것을 호출해 in-flight 변경을 동기적으로 flush. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `flushPendingSnapshot`, dispose 핸들러.
- **셀 편집 중 다른 행 삭제/드래그 시 stale row index commit**: blur 핸들러가 100ms 뒤 `commitCell(td)` 를 지연 실행하는데, 그 사이 사용자가 `[data-delete-row]` 클릭이나 row drag 로 배열을 즉시 mutate + rerender 하면 detach 된 td 의 `dataset.row` 가 stale 인덱스를 들고 있다가 새 배열의 엉뚱한 행에 값을 쓰거나 길이를 넘으면 `getActiveRows()[rowIdx][col]` 이 `undefined[col]` 로 던졌다. row-shifting 핸들러(`data-delete-row`, `dragstart`, `btnAddRow`) 에 공통 가드 `commitActiveCellOrAbort()` 를 추가 — invalid commit 이면 mutation 자체를 중단한다. defense in depth 로 blur timeout 도 `td.isConnected` 체크를 더해 detach 된 td 의 지연 commit 을 차단. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `commitActiveCellOrAbort`/blur timeout `isConnected` guard.
- **외부 변경 Keep + close + reopen 시 편집본 폐기**: dirty 상태에서 외부 변경이 감지돼 *현재 편집 유지* 를 골라도 watcher 가 그냥 return 했고, 이후 snapshot 은 여전히 OLD `baselineMtimeMs` 로 저장됐다. reopen 때 디스크 mtime 은 NEW 라 `shouldOfferRecovery()` 가 stale 로 판정해 자동 폐기 — 사용자가 명시적으로 Keep 을 골랐는데 편집본이 사라졌다. Keep 분기에서 `baselineMtimeMs`/`currentLastWriteMtime` 을 NEW mtime 으로 갱신하고, 마지막으로 받은 snapshot 이 있으면 즉시 새 mtime 으로 recovery entry 를 다시 써 "Keep + 즉시 close" 경로도 보존되게 한다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) watcher Keep 분기.

#### Medium (UX 노이즈 / modified 표시 불일치)

- **Undo 로 saved 상태에 도달했는데 recovery 가 다시 생기는 노이즈**: `restoreFromHistoryIndex()` 가 `setModified(false)` 직후 항상 `'snapshot'` 을 보냈고, host 는 `modified=false` 처리에서 recovery 를 비웠다가 곧이은 `'snapshot'` 으로 clean 상태를 다시 기록했다. 결과적으로 `edit → undo to saved → close → reopen` 경로에서 의미 없는 *복구하시겠습니까?* 프롬프트가 떴다. snapshot 송신을 `dirtyNow` 분기 안으로 이동. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) webview `restoreFromHistoryIndex`/`resetHistoryToCurrent`.
- **복구 데이터를 webview 가 clean baseline 으로 잡는 일관성 깨짐**: host 는 `currentIsDirty = true` 로 두지만, 초기 `resetHistoryToCurrent()` 가 복구된 데이터를 그대로 `lastSavedSnapshot` 으로 잡아 Modified 표시가 안 떴고, 이후 사용자가 편집했다가 undo 로 복구 상태로 돌아오면 host 에 `modified=false` 가 가서 — 아직 디스크에 저장되지 않은 — 복구 내용의 recovery 가 지워질 수 있었다. host 가 `getWebviewContent(data, savedData, ...)` 에 디스크 데이터를 별도로 함께 넘기고, webview 는 base64 두 개를 디코드해 `savedSnapshot` 을 saved baseline 으로, 복구 데이터를 dirty current 로 분리. `resetHistoryToCurrent()` 는 둘이 다르면 자동으로 modified=true. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `getWebviewContent` 시그니처 / webview `savedSnapshot` 디코드 / `resetHistoryToCurrent`.

#### 회귀 가드 추가

- 새 mirror sync 테스트 4종: row-shifting 핸들러의 `commitActiveCellOrAbort()` 가드, blur timeout 의 `td.isConnected` 체크, `restoreFromHistoryIndex` 가 `dirtyNow` 분기 안에서만 snapshot 송신, `resetHistoryToCurrent` 가 `savedSnapshot !== undefined` 일 때 그것을 baseline 으로 사용.
- 새 host contract 테스트 2종: dispose 핸들러가 `currentFlushPendingSnapshot` → `clearSnapshotTimer` 순서로 호출, watcher Keep 분기가 `baselineMtimeMs` 갱신 + `writeSnapshotEntry(currentLastReceivedSnapshot)` 즉시 호출.
- 새 host state round-trip 테스트 2종(in-memory `workspaceState` double): 단일 파일 entry write/read/clear, 여러 파일 동시 entry 보존.

### 수정 — 2차 리뷰 후속 (primitive array 입력 유실 / discard 후 stale recovery / 수동 revert / save vs snapshot race)

#### High (실제 데이터 손실 가능)

- **primitive array 셀에서 태그 입력 후 +Add/✕ 누르면 입력값 유실**: tag 입력은 DOM input 에만 존재하고 data 에는 commit 되지 않은 상태에서 `+ Add` 또는 `✕` 핸들러가 직접 `arr.push/splice` + `renderTable` 을 실행하면 detach 된 td 는 1차 보완에서 추가한 `td.isConnected` 가드 때문에 지연 commit 도 스킵돼 사용자 입력이 그대로 사라졌다. webview JS 에 `syncEditingArrayCellToData(td)` 헬퍼를 도입 — `arr.length = 0; for (v of newArr) arr.push(v)` 패턴으로 *원본 배열 reference 를 유지* 하면서 input value 를 in-place 반영 — 하고, 두 핸들러가 mutation 직전에 호출하도록 변경. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `syncEditingArrayCellToData`/`data-remove-arr`/`data-add-arr` 핸들러.
- **명시적 *변경사항 버리기* 후에도 recovery 가 다시 제안되던 문제**: `confirmDiscardIfDirty()` 가 통과해도 host 가 이전 파일의 pending snapshot 과 workspaceState recovery 엔트리를 비우지 않아, 같은 파일 dirty reopen 시 곧이은 `offerRecoveryIfAny()` 가 *방금 버린 변경* 을 다시 *복구하시겠습니까?* 로 제안하는 모순적인 UX 가 발생했다. opener 의 두 confirmDiscardIfDirty 분기 모두에 `discardPriorRecoveryIfAny()` 호출을 추가 — `currentSnapshotTimer` cancel + `currentPendingSnapshot`/`currentLastReceivedSnapshot` 비움 + `setRecoveryEntry(null)`. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `discardPriorRecoveryIfAny`.
- **save vs in-flight snapshot 의 read-modify-write race**: 디바운스 timer 가 fire 된 직후 save 가 들어오면, 두 `setRecoveryEntry` 호출이 `await context.workspaceState.update(...)` 사이에 interleave 되어 둘 다 같은 baseline map 을 읽고 last-write-wins 가 발생할 수 있다. 의도와 반대 결과(save 가 비운 entry 를 stale snapshot 이 부활) 가능. 모든 update 를 단일 promise chain 으로 직렬화하는 `RecoveryStore` 를 [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) 에 `makeRecoveryStore(state, key)` 팩토리로 분리해 host 가 사용. 단위테스트가 `MinimalWorkspaceState` 더블로 실제 race 시나리오(gated update + interleaved set)를 functional 하게 검증한다.

#### Medium (UX 일관성 / dirty 표시 정확성)

- **수동 revert(`foo→bar→foo`) 시 modified 가 풀리지 않던 문제**: 일반 commit / row / array mutation 핸들러가 `setModified(true)` + `pushHistory()` 를 무조건 호출해, 데이터가 saved baseline 과 같아져도 Modified 표시가 남고 recovery snapshot 도 기록됐다. dirty / snapshot 결정을 `pushHistory()` 한 곳에 중앙화 — `snap !== lastSavedSnapshot` 으로 `dirtyNow` 계산해 `setModified(dirtyNow)` 호출 + dirty 일 때만 `'snapshot'` postMessage 송신. 모든 mutation 핸들러에서 `setModified(true)` 직접 호출을 제거. 같은 정책이 `restoreFromHistoryIndex()` / `resetHistoryToCurrent()` 에도 적용되어 undo / 복구 boot 가 saved 상태와 일치하면 recovery 노이즈가 발생하지 않는다. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `pushHistory`.

#### 회귀 가드 추가

- **functional**: `makeRecoveryStore` round-trip(set/get/clear), 다중 파일 coexistence, gated interleaved updates 직렬화 검증, 개별 update rejection 후에도 chain 진행 — in-memory `MinimalWorkspaceState` 더블 위에서 actual store 동작 테스트.
- **regex 회귀 가드**: discard 분기 양쪽에서 `discardPriorRecoveryIfAny` 호출 / `setRecoveryEntry` 가 `RecoveryStore.set` 으로 라우팅 / `pushHistory` 가 `dirtyNow` 비교 + 분기 안에서만 snapshot 송신 / mutation 사이트들에서 `setModified(true)` 직접 호출 제거 / `syncEditingArrayCellToData` 가 in-place(`arr.length = 0; arr.push(v)`) 갱신 / add/remove 핸들러가 mutation 전에 sync 호출.

**Test gap 정직 명시**: 실제 DOM 이벤트 순서(blur 100ms timeout 과 click handler interleave), webview 내 detach 타이밍, 그리고 host-webview message ordering 은 mock harness 없이 단위테스트가 어렵다. 회귀 가드는 source regex + `MinimalWorkspaceState` functional test 조합으로 두텁게 했지만, 통합 시나리오는 수동 검증이 필요하다.

### 수정 — 3차 리뷰 후속 (탭/Reload 미커밋 입력 유실 / async flush vs sync get / RecoveryStore in-place mutation)

#### High (실제 데이터 손실 가능)

- **탭 전환 / Reload 직전에 활성 셀의 미커밋 입력이 유실되던 문제**: blur 100ms timeout 의 `isConnected` 가드는 row-level mutation 의 stale 인덱스 사고는 막아주지만, 사용자의 입력 자체는 commit 되지 않은 채 detach 된다. 탭 클릭은 즉시 `renderTable()` 로 DOM 을 갈아치우고, Reload 는 host 로 메시지를 직접 보내므로 — 둘 다 detach → blur skip 경로에 빠진다. tab.onclick 과 Reload 클릭 핸들러가 mutation 직전에 `commitActiveCellOrAbort()` 를 호출하도록 변경. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) tab.onclick / btnReload 핸들러.
- **panel close 시 미커밋 입력 복구 부재 → draft snapshot 도입**: 사용자가 commit 전에 패널을 X 로 닫으면 input.value 는 어디에도 기록되지 않아 reopen 시 복구가 불가능했다. 모든 `.cell-edit input/textarea` 에 `input` 이벤트 리스너를 달아 keystroke 마다 `sendDraftSnapshot()` 을 호출 — `data` 의 deep clone 위에 input 값을 적용해 host 로 송신, host 는 workspaceState recovery 엔트리를 즉시 갱신한다. **data 자체는 mutate 하지 않는다** (commitCell 의 `typeof oldVal === 'string' ? raw : parseValue(raw)` 타입 보존이 깨져 숫자 셀이 무성하게 문자열로 강제 변환되는 사고를 막기 위함). JSON-edit textarea 는 partial JSON 이 invalid 라 sync 에서 제외. 참조: [src/jsonEditor.ts](src/jsonEditor.ts) `sendDraftSnapshot` / cell-edit input listener.

#### Medium (race / leak)

- **dispose 비동기 flush 와 sync `RecoveryStore.get()` 의 race**: dispose 핸들러는 `void currentFlushPendingSnapshot?.()` 로 fire-and-forget 호출이고, 이전 `RecoveryStore.get()` 은 `state.get()` 으로 workspaceState 를 직접 읽었다. 사용자가 close → 즉시 같은 파일 reopen 하면 `offerRecoveryIfAny()` 가 아직 persist 되지 않은 in-flight write 를 보지 못해 recovery prompt 를 놓치는 race 가 열려 있었다. `RecoveryStore` 를 **synchronous shadow map + async persist chain** 패턴으로 재구성: `set()` 은 shadow 를 동기적으로 mutate 한 뒤 chain 에 update 를 enqueue 하고, `get()` 은 shadow 를 본다. flush 트리거는 그대로 fire-and-forget 이지만 shadow 가 즉시 갱신되므로 reopen 의 동기 read 가 in-flight write 를 본다. 참조: [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) `makeRecoveryStore`.
- **`RecoveryStore.set()` 의 in-place state mutation**: 이전 구현은 `state.get()` 이 돌려준 map 을 직접 `map[k] = v` / `delete map[k]` 한 뒤 `update()` 를 await 했다. Memento 가 reference 를 그대로 돌려주는 구현(다수 그렇다)에서는 update 실패 전에도 in-memory state 가 새는 leak 이 있었다. 새 store 는 `update()` 에 항상 shadow 의 *clone* (`{ ...shadow }`) 을 넘겨 외부에서 받은 map 을 mutate 해도 store 내부와 격리되도록 했다. 참조: [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) `set` 의 `const snapshot = { ...shadow }`.

#### 회귀 가드 추가

- **functional**: `RecoveryStore.get()` 이 미해결 update 직후에도 in-flight 값을 반환(영원히 resolve 하지 않는 update 약속으로 검증), `set()` 이 update 로 받은 map 의 외부 mutation 으로 shadow 가 오염되지 않음, update 실패해도 shadow 는 그 세션 동안 entry 보존.
- **regex**: tab.onclick 이 `commitActiveCellOrAbort` 를 `activeIdx` 변경보다 먼저 호출 / Reload 클릭 핸들러가 `commitActiveCellOrAbort` → `postMessage('reload')` 순서 / cell-edit input listener 가 `sendDraftSnapshot` 호출 / `sendDraftSnapshot` 이 deep clone 위에서 작업하고 json-edit 을 제외.

**Test gap 정직 명시**: panel close 자체의 race(close → 매우 짧은 시간 내 reopen, 마이크로초 단위) 와 webview JS 의 실제 keystroke 타이밍은 mock harness 없이는 단위테스트가 어렵다. shadow 메커니즘과 회귀 가드 조합으로 race window 를 닫았지만 통합 시나리오는 수동 검증이 필요하다.

### 수정 — 4차 리뷰 후속 (draft recovery 데이터 손상)

3차에서 도입한 draft snapshot 자체가 세 가지 데이터 손상 케이스를 안고 있었다. 모두 *복구 후 저장* 경로에서만 표면화되므로 동일한 릴리스 안에서 같이 잡았다.

#### High (실제 데이터 손실 / 타입 손상)

- **primitive 셀의 미커밋 draft 가 number/boolean/null 을 string 으로 변환**: `sendDraftSnapshot()` 이 plain input 분기에서 무조건 `input.value` (string) 를 넣었는데, 같은 셀의 commit 경로([src/jsonEditor.ts](src/jsonEditor.ts) `commitCell`) 는 `typeof oldVal === 'string' ? raw : parseValue(raw)` 로 타입을 보존한다. 비대칭 때문에 사용자가 숫자 `2` 를 `3` 으로 입력하고 commit 전에 패널을 닫은 뒤 복구 후 저장하면 디스크에 `"3"` (string) 이 기록됐다 — 사용자는 알아차리기 어렵고, 한 번 string 으로 굳으면 같은 키로 들어오는 다른 행도 도미노로 string 이 된다. boolean 의 `true→false`, null 셀의 `null` 도 동일.
- **object/array 셀의 유효한 미커밋 JSON draft 가 복구되지 않음**: `<textarea class="json-edit">` 는 sendDraftSnapshot 진입부에서 일괄 `return` 으로 제외되어 partial JSON 의 invalid 케이스를 피했지만, 사용자가 valid JSON 까지 입력해 둔 상태에서 Ctrl+Enter 없이 패널을 닫으면 그 입력이 어디에도 남지 않았다.

위 두 건을 한 번에 잡으려고 webview 의 `sendDraftSnapshot` 핵심 로직을 [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) 의 `buildDraftSnapshot()` 으로 추출 — webview 는 IIFE 라 외부 모듈을 import 못 하지만, mirror 정책 그대로 동일 본체를 양쪽에 두고 단위테스트는 mirror 쪽에서 직접 호출. plain 분기는 `coerceEditedCellValue` 와 동일한 타입 보존, json-edit 분기는 `JSON.parse(raw)` 가 성공할 때만 parsed 값을 적용 (실패 시 이전 valid draft 가 유지되도록 `skip`).

#### Medium (UX 노이즈)

- **원래 값으로 되돌린 clean draft 가 recovery prompt 를 만듦**: `foo → bar → foo` 처럼 입력만 되돌리고 commit 없이 닫으면, 마지막 keystroke 의 snapshot 이 lastSavedSnapshot 과 비교되지 않고 그대로 host 에 기록되어 다음 reopen 에 의미 없는 *복구하시겠습니까?* 프롬프트가 떴다. `pushHistory()` 에는 이미 같은 가드가 있었지만 draft 경로만 빠져 있던 비대칭. `buildDraftSnapshot()` 이 `JSON.stringify(draft) === lastSavedSnapshot` 비교 후 `clean` 결과를 돌려주면 `sendDraftSnapshot` 이 `setModified(false)` 로 host 의 recovery 엔트리를 비운다. modified 가 이미 false 면 setModified 가 메시지를 송신하지 않으므로 (조건적 게이트), false→false 의 불필요한 트래픽도 없다.

#### 회귀 가드

- **functional**: `buildDraftSnapshot` 단위테스트 16종 — number/boolean/null/string 타입 보존, json-edit valid array/object 캡처, json-edit invalid 시 skip, 동일 baseline 으로 revert 시 clean, baseline 과 다를 때는 snapshot, array item arrIdx 적용, invalid arrIdx/row/path/col → skip, snapshot 과 json-edit 모두 입력 data 를 mutate 하지 않음.
- **regex (mirror sync)**: webview 의 `sendDraftSnapshot` 이 `buildDraftSnapshot` 에 위임하고 결과 분기(`snapshot` postMessage / `clean` 시 setModified(false)) 를 보존, webview `buildDraftSnapshot` 본체에 deep clone / 타입 보존 / json-edit `JSON.parse` / clean revert 비교가 모두 살아 있음, mirror 헤더에 `sendDraftSnapshot` 이 명시됨.

### 수정 — 5차 리뷰 후속 (draft snapshot dirty 동기화 누락 / convert 핸들러 commit 가드 누락)

4차 도입 후 한 차례 더 들어온 리뷰에서 두 건의 데이터 손실 시나리오를 식별. 모두 같은 릴리스에 묶었다.

#### High (실제 데이터 손실 가능)

- **`sendDraftSnapshot()` snapshot 분기가 host 의 dirty 플래그를 못 잡음**: 4차에서 도입한 draft snapshot 송신은 host 에 recovery 엔트리는 만들지만 `'modified'` 메시지를 보내지 않아 host 의 `currentIsDirty` 가 false 로 머문다. 그 사이 외부에서 파일이 변경되면 [src/jsonEditor.ts](src/jsonEditor.ts) watcher 가 dirty=false 로 보고 *Reload/Keep* 모달 없이 자동 reload 분기로 빠져 `setRecoveryEntry(null)` 로 recovery 까지 비워, 사용자의 미커밋 입력이 모달 한 번 없이 사라졌다. 같은 누락 때문에 `foo→bar→foo` clean revert 시 `setModified(false)` 도 `if (modified !== next)` 에서 no-op 이 되어 host 의 stale recovery 엔트리가 비워지지 않았다 (4차 Finding 3 의 의도와 정반대 결과). snapshot 분기에서 `setModified(true)` 를 postMessage 직전에 호출하도록 수정. 이로써 첫 keystroke 가 즉시 dirty 표시를 켜고, 이후 clean revert 의 `setModified(false)` 는 항상 host 까지 메시지가 전달된다.
- **`data-convert` (s↔a) 핸들러에 `commitActiveCellOrAbort()` 가드 부재**: convert 는 cell 의 타입을 바꿔 `renderTable()` 로 모든 td 를 갈아치우는데, 다른 셀이 편집 중인 상태에서 convert 클릭 → blur 의 100ms 지연 commit 은 `td.isConnected` 가드로 skip 되어 사용자의 미커밋 입력이 사라졌다. 동일한 가드 패턴(`if (!commitActiveCellOrAbort()) { return; }`) 을 mutation 전에 추가해 tab/Reload/delete-row/drag/btnAddRow 와 같은 정책으로 통일. 회귀 가드 가이드(rerender 를 트리거하는 모든 핸들러는 commit 부터)도 명문화했다.

#### 회귀 가드

- `sendDraftSnapshot` 의 snapshot 분기가 `setModified(true) → postMessage('snapshot')` 순서로 호출하는지 regex 가드 추가. 한쪽만 살아 있으면 위 두 시나리오 중 한쪽이 부활한다.
- 기존 `row-shifting mutations call commitActiveCellOrAbort first` 가드 배열에 `data-convert` 추가 — convert 는 row 시프트가 아니지만 renderTable 로 다른 셀을 detach 하므로 같은 정책이 필요하다는 점이 이번에 드러나, 가드 코멘트도 "renderTable 을 호출하는 모든 핸들러" 로 일반화.

### 수정 — 6차 리뷰 후속 (json-edit invalid mid-edit 시 dirty 플래그 누락)

5차에서 snapshot 분기에 `setModified(true)` 를 추가했지만, **`buildDraftSnapshot()` 이 `skip` 을 반환하는 경로** 가 별도로 남아 있었다. 가장 흔한 skip 케이스는 object/array 셀의 `<textarea class="json-edit">` 가 mid-edit invalid JSON 인 상황 — 사용자는 키스트로크 단위로 입력 중인데 매 keystroke 마다 `JSON.parse(rawInputValue)` 가 실패해 `skip` 으로 빠진다. `sendDraftSnapshot` 의 5차 코드는 `skip` 에서 아무 것도 하지 않아 `modified` 가 false 로 머물고, 결과적으로:

- 외부 파일 변경 시 watcher 가 dirty=false 로 보고 자동 reload 분기로 빠져 미커밋 입력이 모달 한 번 없이 폐기 ([src/jsonEditor.ts](src/jsonEditor.ts) 외부 변경 watcher / 자동 reload).
- 다른 JSON 파일을 열 때 `confirmDiscardIfDirty()` 가 silent pass 되어 같은 입력이 폐기 ([src/jsonEditor.ts](src/jsonEditor.ts) `openJsonEditorWithPath` 의 다른 파일 분기).

#### High (실제 데이터 손실 가능)

- **`sendDraftSnapshot()` 의 skip 분기에서도 `setModified(true)` 호출**: 활성 셀의 `td.editing` 가드를 통과한 시점에 사용자는 이미 입력을 들고 있다. invalid JSON 이라 recovery snapshot 은 쓸 수 없어도, dirty 표시는 켜야 reload/switch 보호가 동작한다. 명시적으로 `result.kind === 'skip'` 분기에서 `setModified(true)` 를 호출. 모든 keystroke 마다 호출되지만 setModified 는 modified 변수가 false → true 로 전이될 때만 메시지를 보내므로 추가 트래픽 없음. recovery snapshot 자체는 여전히 valid JSON 이 들어와야 비로소 갱신된다 — invalid raw text 의 보존은 별개 이슈로 의도적으로 범위 제외.

#### 회귀 가드

- `sendDraftSnapshot` 의 skip 분기가 `setModified(true)` 를 호출하는지 regex 가드 추가. 한쪽이 빠지면 위 두 시나리오가 부활한다.

### 수정 — 7차 리뷰 후속 (Escape cancel 이 host draft / dirty 상태 미정리)

3차에서 도입된 draft snapshot 인프라가 `cancelCell()` 과는 따로 굴러다녔다. 입력 중 keystroke 마다 `sendDraftSnapshot()` 이 host 의 recovery 엔트리에 draft 를 쓰고 `modified=true` 를 남기는데, 사용자가 `Escape` 로 편집을 취소해도 [src/jsonEditor.ts](src/jsonEditor.ts) `cancelCell()` 은 `td.editing` 클래스만 제거하고 host 상태에는 손대지 않았다. 결과:

#### Medium (UX 노이즈 / 데이터 신뢰)

- **명시적 `Escape` 로 취소한 입력이 reopen 시 *복구하시겠습니까?* 로 되살아남**: cancelCell 이 host 의 `'modified'` / `'snapshot'` 메시지를 보내지 않아 workspaceState 의 recovery 엔트리에 cancelled draft 가 그대로 남고, 패널을 닫고 다시 열면 사용자가 명시적으로 버린 입력이 복구 후보로 제안됐다.
- **취소 후 `data` 는 saved 와 같은데 modified 표시만 남는 false positive**: snapshot 분기와 skip 분기 모두 `setModified(true)` 를 호출하도록 6차에서 정리했는데, cancel 은 그 dirty 표시를 끄지 않아 *수정됨* 표시가 잔존하고 다른 파일을 열 때 confirm 다이얼로그가 불필요하게 뜨곤 했다.

`cancelCell()` 에 `pushHistory` / `restoreFromHistoryIndex` / `resetHistoryToCurrent` 와 동일한 정책을 적용 — `snapshotData() !== lastSavedSnapshot` 비교로 `dirtyNow` 를 계산해 `setModified(dirtyNow)` 를 호출, dirty 일 때만 현재 `data` 의 snapshot 을 host 에 송신. 이로써 두 시나리오가 모두 닫힌다:

1. 취소된 입력이 유일한 미커밋 변경이었다 → `dirtyNow=false` → `setModified(false)` 가 host 까지 가서 recovery 엔트리를 비운다.
2. 다른 커밋된 변경이 남아 있다 → `dirtyNow=true` → cancelled draft 가 들어 있던 host 의 recovery 엔트리를 *현재 data* 로 덮어써 정합 유지.

#### 회귀 가드

- `cancelCell` 본체에 `dirtyNow = snap !== lastSavedSnapshot` 비교, `setModified(dirtyNow)` 호출, `dirtyNow` 분기 안에서만 정확히 한 번 `'snapshot'` postMessage 가 일어나는지 4종의 regex 가드 추가. 분기 밖 snapshot 호출이 새로 생기면 `setModified(false)` 가 비운 recovery 가 곧바로 다시 채워져 의도가 깨진다.

### 수정 — 8차 리뷰 후속 (recovery clear 시 host snapshot cache 누수 → Keep 분기에서 stale draft 부활)

3·4차에서 도입된 host 의 `currentLastReceivedSnapshot` 은 외부 변경 watcher 의 *Keep current edits* 분기 ([src/jsonEditor.ts](src/jsonEditor.ts) Keep 분기) 가 사용자의 마지막 입력을 새 mtime 으로 recovery 엔트리에 즉시 다시 쓰기 위한 캐시였는데, 그 캐시를 비우는 사이트가 일부만 있었다 (`discardPriorRecoveryIfAny`, `onDidDispose`). 이로 인해:

#### Medium (UX 노이즈 / 데이터 신뢰)

- **취소·저장·reload·자동 reload 후 mid-edit invalid 상태에서 외부 변경 → Keep 시 stale draft 부활**: 4개 host 사이트 (`case 'modified'` 의 modified=false 분기, `case 'save'`, `case 'reload'`, watcher 자동 reload) 가 모두 workspaceState 의 recovery 엔트리는 비웠지만 `currentLastReceivedSnapshot` 은 그대로 남겼다. 이후 사용자가 다시 편집을 시작해 json-edit textarea 에서 mid-edit invalid JSON 상태가 되면 `sendDraftSnapshot()` 은 `skip → setModified(true)` 만 일으켜 `'snapshot'` 메시지를 보내지 않는다 (6차에서 의도한 동작). host 의 `currentLastReceivedSnapshot` 은 *이전 사이클의 stale 값* 인 채로 dirty 만 다시 true 가 된다. 이 시점에 외부 변경이 들어오고 사용자가 *Keep current edits* 를 선택하면, watcher Keep 분기가 `currentLastReceivedSnapshot !== undefined` 만 보고 stale snapshot 을 새 mtime 으로 recovery 에 다시 쓴다 — 결국 사용자가 **명시적으로 cancel/save/reload 한 입력** 이 다음 reopen 에서 *복구하시겠습니까?* 로 부활한다.

4개 host 사이트 각각에 `currentLastReceivedSnapshot = undefined;` 라인을 `setRecoveryEntry(context, filePath, null)` 직전에 추가해 cache 와 disk recovery 의 lifecycle 을 일치시켰다. `discardPriorRecoveryIfAny`/`onDidDispose` 가 이미 같은 패턴이라 일관성도 회복.

`offerRecoveryIfAny` 안의 두 추가 `setRecoveryEntry(null)` 호출 (stale entry 폐기 / 사용자 *Discard* 선택) 은 panel 셋업 *이전* 에 실행되므로 `currentLastReceivedSnapshot` 은 그 시점에 이미 undefined — `discardPriorRecoveryIfAny` 또는 직전 `onDidDispose` 가 클리어한 상태. 추가 클리어가 무해하지만 의도를 좁게 가져가려고 검증 대상에서 제외.

#### 회귀 가드

- `case 'modified'` (modified=false 분기), `case 'save'` 성공 분기, `case 'reload'` 성공 분기, watcher 자동 reload 분기 — 4개 사이트 각각이 `setRecoveryEntry(...null)` 와 `currentLastReceivedSnapshot = undefined` 를 같은 분기 안에 *둘 다* 가지고 있는지 source regex 가드 1종 추가. `setRecoveryEntry(...null)` 는 sanity check 로 같이 검증해, regex anchor 가 깨졌을 때 즉시 알림.

### 수정 — 9차 리뷰 후속 (atomic replace 미감지 / RelativePattern glob false positive / 빈 문자열 key skip / 문서 부정확)

#### High (실제 데이터 손실 가능)

- **외부 도구의 atomic replace / delete+create 갱신을 감지하지 못해 stale data 로 외부 변경을 덮어쓰는 경로**: 외부 도구가 `rename(temp, target)` 으로 atomic 하게 파일을 교체하거나 delete + create 시퀀스로 갱신하면 [src/jsonEditor.ts](src/jsonEditor.ts) `createFileSystemWatcher(... ignoreCreateEvents=true ...)` 로 인해 `onDidChange` 가 발화하지 않고 `onDidCreate` 만 들어오는데, 핸들러가 없어 reload/Keep 분기를 못 탔다. clean editor 가 stale data 를 들고 있다가 사용자가 저장하면 외부 변경이 silent 하게 덮어쓰였다. `ignoreCreateEvents` 를 false 로 바꾸고 `onDidCreate` 를 `onDidChange` 와 동일한 `handleExternalChange` 핸들러에 라우팅. 동시에 `onDidDelete` 는 250ms grace period 후 `fs.statSync` 로 파일 존재를 재확인하도록 변경 — atomic replace 의 delete + create 시퀀스에서 사용자가 *file deleted* 경고와 *file changed externally* prompt 를 연속으로 보지 않도록.

#### Medium (false positive / silent skip)

- **`RelativePattern` glob meta-char 미escape + fsPath 미검증**: 파일명에 `*`, `?`, `[`, `{`, `}` 가 들어 있으면 watcher 가 target 을 못 보거나 sibling 을 target 변경으로 오인할 수 있었다. (1) basename 의 glob meta-char 를 character-class 로 escape (`*` → `[*]` 등; `]` 는 class 밖에서 literal 이라 별도 escape 불필요), (2) `handleExternalChange` 콜백에서 `path.normalize(changedUri.fsPath) !== path.normalize(filePath)` 체크로 false positive 를 한 번 더 차단.
- **빈 문자열 column key (`""`) 가 draft snapshot 에서 부당 skip**: [src/jsonEditor.ts](src/jsonEditor.ts) webview 와 [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) mirror 양쪽의 `buildDraftSnapshot` 이 `!col` falsy 검사로 column 유효성을 확인했는데, JSON 은 `{"": "value"}` 처럼 빈 문자열 key 를 허용하므로 해당 셀을 commit 전 패널을 닫으면 dirty 표시만 켜지고 draft recovery 가 남지 않아 미커밋 입력을 잃었다. `typeof col !== 'string'` 으로 변경 — undefined/null 은 여전히 skip, 빈 문자열은 정상 처리.

#### Docs

- **dirty-close 복구 한계 명시**: [docs/features.md](docs/features.md) §3 데이터 보호의 *Dirty-close 복구* 항목이 모든 미저장 변경을 복구하는 것처럼 읽혔다. 실제 동작은 *parse 가능한 셀 단위 변경과 commit 된 mutation* 만 복구되며, object/array 셀의 JSON textarea 가 mid-edit invalid 상태에서 패널이 닫히면 raw text 자체는 보존되지 않고 dirty 표시 → 외부 변경/파일 전환 confirm 으로 silent discard 만 차단된다는 사실을 추가.

#### 회귀 가드

- **functional**: `buildDraftSnapshot` 이 빈 문자열 col 에서 snapshot 결과를 돌려주고 (`{"": "updated"}` 적용), undefined col 에서는 skip 인지 단위테스트 2종.
- **regex**: (1) basename glob escape 패턴 (`/[*?[{}]/g` 치환) 보존, (2) 콜백의 `path.normalize(changedUri.fsPath)` 비교 보존, (3) `createFileSystemWatcher` 가 ignoreCreateEvents=false, (4) `onDidChange` 와 `onDidCreate` 둘 다 `handleExternalChange` 같은 참조에 라우팅, (5) `onDidDelete` 안에 `setTimeout` + `fs.statSync(filePath)` 패턴, (6) webview `buildDraftSnapshot` 본체에 `typeof col !== 'string'` 보존 + `!col` 검사 부재.

### 수정 — 10차 리뷰 후속 (Keep 후 webview baseline 미갱신으로 외부 변경 silent overwrite / glob brace escape 한계)

#### High (실제 데이터 손실 가능)

- **외부 변경 *Keep current edits* 후 webview 의 lastSavedSnapshot 이 옛 디스크 baseline 으로 머물러 silent overwrite**: 9차에서 도입한 `handleExternalChange` 의 Keep 분기가 host 의 `baselineMtimeMs` 와 `currentLastWriteMtime` 만 갱신하고 webview 의 saved baseline 은 그대로 두었다. 시나리오: file `A` 열기 → 사용자 edit `B` (modified=true, recovery=B) → 외부에서 디스크가 `C` 로 변경 → user *Keep* 선택 → host baseline 이 mtime_C 로 갱신, webview 의 `lastSavedSnapshot` 은 여전히 `JSON.stringify(A)` → 사용자가 undo 또는 수동 revert 로 `A` 까지 돌리면 [src/jsonEditor.ts](src/jsonEditor.ts) `pushHistory` 의 `dirtyNow = snap !== lastSavedSnapshot` 비교가 `A === A` 로 보고 `setModified(false)` 송신 → host 가 recovery 엔트리를 비우고 `currentIsDirty=false` → 다음 save 가 *디스크의 외부 변경 `C` 를 silent 하게 `A` 로 덮어쓴다*. Keep 분기에서 디스크를 다시 읽어 `setSavedBaseline` postMessage 로 webview 의 baseline 을 새 디스크 content 로 갱신하도록 변경. webview 의 message 핸들러는 `loadData` 와 달리 user data 는 건드리지 않고 `lastSavedSnapshot` 만 갱신 + `pushHistory` 와 동일한 정책으로 dirty 재평가 (`setModified(dirtyNow)` + dirty 분기 안에서만 snapshot 송신). 디스크 read 가 실패하면 (watcher fire 와 read 사이의 race) 사용자에게 경고 메시지를 띄워 *저장 전 외부 변경 재확인* 을 안내 — best effort.

#### Medium (false negative — 파일명 brace 매치 실패)

- **glob brace escape 가 minimatch 의 brace 확장과 안전 호환되지 않음**: 9차에서 추가한 `path.basename(filePath).replace(/[*?[{}]/g, m => '[' + m + ']')` escape 는 `{` `}` 를 character class 로 감싸지만 (`a{b,c}.json` → `a[{]b,c[}].json`), 일부 minimatch 구현에서는 이 패턴이 원본 파일명과 매치되지 않아 watcher 가 target 을 못 보는 false negative 가 발생한다. 9차의 regex 가드는 escape 코드 *모양* 만 확인했지 실제 매치 동작은 검증하지 못했다 (단위테스트로 minimatch 동작을 검증하는 것은 VS Code API 의 내부 구현 의존성이 높아 가성비가 낮다). 대신 더 단순한 대안을 채택: directory 의 모든 파일을 보는 `*` 패턴 + 콜백의 `path.normalize(changedUri.fsPath)` fsPath gate. 사이드이펙트는 같은 디렉터리의 다른 파일 변경이 콜백을 깨우는 것뿐 — fsPath 비교는 O(1) 라 비용이 작고, 모든 special character (brace 포함) 가 자동 처리된다. 한계: minimatch 의 default `dot:false` 로 `.foo.json` 같은 dotfile 은 패턴이 안 잡힐 수 있지만, 사용자가 수동 reload 로 우회 가능하므로 수용. 9차의 escape 가 부활하지 않도록 negative regex 가드도 함께 추가.

#### 회귀 가드

- watcher 가 `new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), '*')` 형태의 directory-wide 패턴을 사용하는지, 9차의 basename escape 정규식이 부활하지 않았는지, fsPath path.normalize 비교가 보존되는지 — regex 3건.
- Keep 분기가 `fs.readFileSync(filePath, 'utf-8')` 로 디스크를 다시 읽고 `setSavedBaseline` postMessage 를 보내는지 — regex 2건.
- webview 의 `setSavedBaseline` 핸들러가 (1) `lastSavedSnapshot = JSON.stringify(msg.data)` 갱신, (2) `dirtyNow = snapshotData() !== lastSavedSnapshot` 재계산, (3) `setModified(dirtyNow)`, (4) `dirtyNow` 분기 *안* 에서만 `'snapshot'` postMessage — pushHistory / cancelCell 와 동일 정책 — regex 4건.

### 수정 — 11차 리뷰 후속 (Keep 의 isRootArray 클로버 / parse-fail 시 recovery 미도달)

10차에서 Keep 분기에 `setSavedBaseline` 메시지를 도입하면서 두 가지 추가 데이터 손실 경로가 생겼다. 둘 다 *Keep current edits* 가 의도한 "사용자 편집 보존" 약속을 깨는 시나리오.

#### High (실제 데이터 손실 가능)

- **Keep 분기가 host 의 `isRootArray` 를 외부 디스크 shape 로 덮어씌움**: 10차 코드의 `isRootArray = newWrapped.isRootArray;` 라인이, 사용자가 root array `[1,2,3]` 을 편집하던 도중 외부에서 디스크가 object `{"x":1}` 로 바뀐 뒤 *Keep* 을 누르면 host 의 `isRootArray=false` 로 덮어쓰였다. 이후 save 시 [unwrapIfRootArray](src/jsonEditor.ts) 가 array 를 unwrap 하지 못해 디스크에 `{"_rootArray":[1,2,3]}` object 형태로 기록되거나, recovery 엔트리도 `isRootArray:false` 로 저장되어 reopen 후 save 에서 같은 손상 재현. Keep 은 user data 를 안 바꾸므로 host 의 `isRootArray` 도 그대로 둬야 한다 — 라인 한 줄 제거.
- **외부 변경 후 Keep → 디스크가 invalid JSON 으로 깨진 상태에서 패널을 닫고 reopen 시 recovery 도달 불가**: 10차의 Keep 분기는 디스크 read 실패 시 경고만 내고 진행 + recovery 엔트리는 새 mtime 으로 저장된다. 그러나 reopen 시 [openJsonEditorWithPath](src/jsonEditor.ts) 가 `JSON.parse` 실패 → 에러 + early return → `offerRecoveryIfAny` 에 도달하지 못해 사용자가 명시적으로 *Keep* 한 미저장 변경이 영원히 잠긴다. 일반 parse 실패 catch 안에서 offerRecoveryIfAny 를 먼저 호출하도록 변경 — 매칭 recovery (mtime 일치) 가 있으면 사용자에게 복구 제안, 거절 시에만 parse 에러로 빠진다. 디스크에 valid baseline 이 없으므로 webview 의 `savedDataForWebview` 는 빈 객체 sentinel `{}` 로 보내 dirty=true 로 시작 → 사용자가 의식적으로 save 또는 다른 결정을 내리도록 유도. 부수 효과로 reopen-loop (parse 실패 → 복구 → 닫으면 recovery 잔존 → 또 parse 실패) 도 save 한 번으로 끊긴다.

#### 회귀 가드

- Keep 분기 본체에 `isRootArray = newWrapped.isRootArray` 패턴이 *없음* (negative regex), 그러나 `wrapIfArray(newDiskParsed)` 호출은 *있음* (positive regex) — host 변수는 그대로 두고 webview 에 보낼 wrapped form 만 만든다는 의도 보존.
- `openJsonEditorWithPath` 의 `JSON.parse` catch 블록 안에 `offerRecoveryIfAny(...)` 호출이 있고, 그 결과가 null 일 때만 *JSON 파싱 실패* 메시지 후 return 하는 패턴 — regex 2건.

### 수정 — 12차 리뷰 후속 (Keep parse-fail dirty 누수 / stat·size early-return 이 recovery 우회)

10·11차에서 *Keep* 후 baseline 갱신과 parse-fail 시 recovery fallback 을 도입했지만, 같은 분기에 두 가지 추가 결함이 남아 있었다.

#### High (실제 데이터 손실 가능)

- **Keep 후 새 디스크 baseline parse 실패 시 webview 의 dirty 가 옛 baseline 으로 풀릴 수 있음**: 10차에서 추가한 Keep 분기의 try-catch 가 baseline 갱신에 실패하면 경고만 띄우고 `setSavedBaseline` 송신은 건너뛰었다. webview 의 `lastSavedSnapshot` 은 *옛* 디스크 baseline 으로 남아, 사용자가 undo / 수동 revert 로 그 옛 데이터에 도달할 때 `pushHistory` 의 dirty 비교가 false 로 떨어져 host 가 recovery 를 비우고, 다음 save 가 invalid 디스크를 silent 하게 덮어쓴다. catch 블록에서도 `setSavedBaseline` 을 빈 객체 `{}` sentinel 로 송신하도록 수정 — 어떤 user data 도 sentinel 과 같지 않으므로 항상 dirty 유지. (사용자 데이터가 우연히 `{}` 인 극단적 케이스만 dirty=false, 그 경우 손실 위험도 없으므로 수용.)
- **`stat` 실패 / 파일 크기 초과 / 파일 읽기 실패 early-return 이 recovery 를 우회**: 11차의 parse-fail recovery fallback 은 추가됐지만 stat 실패 / 파일 크기 초과 / 읽기 실패 세 경로는 여전히 `offerRecoveryIfAny` 도달 전에 `showErrorMessage` + return 했다. 시나리오: dirty editor 닫은 뒤 대상 파일이 외부에서 삭제됐거나 10MB 초과로 바뀌면, workspaceState 에 recovery 가 있어도 복구 프롬프트 자체에 도달하지 못해 사용자의 미저장 변경이 영구 잠금. 4 가지 disk-step 실패 (stat / size / read / parse) 를 *단일 earlyError 객체* 로 캡쳐하고 마지막에 한 곳에서 `getRecoveryEntry` 로 entry 존재만 먼저 확인 후 `offerRecoveryIfAny` 로 prompt — entry 가 없을 때만 captured error 표시 + return. stat 실패의 경우 currentFileMtimeMs 를 알 수 없으므로 entry 의 own mtime 을 그대로 써서 `shouldOfferRecovery` 가 "캡처 이후 외부 변경 없음" 으로 보고 제안하도록 (파일이 사라진 케이스의 적절한 의미). disk-fail fallback 분기는 webview 의 `savedDataForWebview` 로 빈 객체 sentinel `{}` 을 보내 dirty=true 로 시작 → 사용자가 save 로 디스크를 명시적으로 복구하거나 의식적으로 다른 결정을 내리도록.

#### 회귀 가드

- Keep 분기 catch 블록에 `setSavedBaseline` + `data: {}` 패턴 보존 — regex 1건.
- `openJsonEditorWithPath` 본체에 `earlyError = {` 할당이 4 회 이상 (stat / size / read / parse 4 단계가 각각 캡쳐) — count regex.
- `if (earlyError) {` 블록 안에 `getRecoveryEntry(context, filePath)` + `offerRecoveryIfAny(` 호출 + `if (!fallback)` 후에만 `showErrorMessage(earlyError.msg)` + return — 통합 fallback 구조 보존.
- disk-fail fallback 분기에 `savedDataForWebview = {}` sentinel 패턴 보존.
- 4 개의 개별 `showErrorMessage(...); return;` 패턴이 부활하지 않도록 negative count regex (≤ 1, 통합 earlyError 분기 자신은 허용).

### 수정 — 13차 리뷰 후속 (`{}` sentinel 충돌 / auto-reload parse-fail mtime 누수 / reload 경로 size guard 부재)

12차에서 disk-fail / Keep parse-fail 시 `{}` 객체 sentinel 로 webview 를 dirty 유지시키려 했지만, 사용자가 실제로 빈 객체 `{}` 를 편집 중일 때 dirty=false 로 충돌하는 데이터 손실 케이스가 있었다. 또한 외부 변경 auto-reload 의 parse 실패 catch 와 reload 경로 전반의 size guard 도 누락 상태.

#### High (실제 데이터 손실 가능)

- **`{}` 객체를 baseline-unknown sentinel 로 사용 → 사용자의 빈 객체 편집과 충돌**: 12차의 `savedDataForWebview = {}` (open disk-fail fallback) 와 `setSavedBaseline data: {}` (Keep parse-fail catch) 두 곳 모두, webview 가 `lastSavedSnapshot = JSON.stringify({}) = '{}'` 로 baseline 을 잡았다. 사용자의 data 가 우연히 (또는 실제 의도대로) 빈 객체면 `dirtyNow = ('{}' !== '{}') = false` → setModified(false) → host 가 recovery 비움 → 다음 save 가 invalid 디스크/사라진 파일을 silent 하게 빈 객체로 덮어쓰거나 미저장 변경을 잃는다. *어떤 user data 의 JSON.stringify 결과와도 같을 수 없는* 값을 sentinel 로 써야 한다. webview 에 `BASELINE_UNKNOWN_SENTINEL = ''` (빈 문자열) 을 도입 — `JSON.stringify(data)` 는 어떤 valid 객체 입력에 대해서도 절대 빈 문자열을 만들지 못하므로 안전한 sentinel. host 는 `getWebviewContent` 에 `baselineUnknown: boolean` 파라미터를 추가해 부팅 시 sentinel 을 반영하고, post-boot 의 신호로 `markBaselineUnknown` 메시지를 신설 (Keep 분기가 사용). 12차의 `savedDataForWebview = {}` / `setSavedBaseline data: {}` 패턴은 모두 제거.
- **clean editor 에서 외부 파일이 invalid JSON 으로 바뀌면 auto-reload catch 가 baseline mtime 을 갱신하지 않아 이후 recovery 가 stale 로 폐기**: 12차 시점의 watcher catch 는 단순 `showWarningMessage` 만 했다. 시나리오: clean editor + 외부에서 디스크 깨짐 → auto-reload parse 실패 → `baselineMtimeMs` 는 옛 mtime 그대로 → 이후 user 편집의 recovery 가 옛 mtime 으로 stamp → 패널 close + reopen 시 `stat.mtimeMs` (새 mtime) 와 안 맞아 `shouldOfferRecovery` 가 stale 로 폐기 → 사용자의 미저장 변경 영구 잠금. catch 에서 `baselineMtimeMs = changedStat.mtimeMs`, `currentLastWriteMtime = changedStat.mtimeMs`, `currentIsDirty = true`, `markBaselineUnknown` postMessage 로 webview baseline 도 sentinel 전환 — parse 실패도 외부 변경 버전으로 인정해 mtime 을 갱신하고 webview 를 dirty=true 로 유지.

#### Medium (자원 보호)

- **manual reload / external auto-reload 에 size guard 부재**: open 경로에는 10MB 제한이 있지만 [src/jsonEditor.ts](src/jsonEditor.ts) 의 `case 'reload'` 와 watcher auto-reload 는 size 체크 없이 곧장 `readFileSync` + `JSON.parse` 를 실행했다. 외부에서 파일이 거대 JSON 으로 바뀌면 처리 한도를 우회하고 메모리를 크게 잡아먹는다. `case 'reload'` 에는 사이즈 초과 시 에러 + break, watcher auto-reload 에는 동일 size guard 후 (사이즈 초과면 reload 포기 + invalid-JSON catch 와 동일 정책으로 mtime 갱신 + markBaselineUnknown). 양쪽 모두 `JSON_EDITOR_MAX_FILE_SIZE` 와 `formatFileSize` 를 일관되게 사용.

#### 회귀 가드

- Keep 분기 catch 가 `markBaselineUnknown` postMessage 를 보내고 옛 `data: {}` 패턴이 부활하지 않았는지 — positive + negative regex.
- webview `BASELINE_UNKNOWN_SENTINEL = ''` 상수 + `markBaselineUnknown` 핸들러 본체 (`lastSavedSnapshot = BASELINE_UNKNOWN_SENTINEL` + `setModified(true)`) 보존.
- open 의 disk-fail fallback 이 `baselineUnknownForWebview = true` 플래그를 사용하고 옛 `savedDataForWebview = {}` 가 부활하지 않았는지, `getWebviewContent` 호출에 새 인수 전달.
- `case 'reload'` 와 watcher auto-reload 둘 다 `JSON_EDITOR_MAX_FILE_SIZE` size guard 적용.
- watcher auto-reload catch 가 `baselineMtimeMs = changedStat.mtimeMs` 갱신 + `markBaselineUnknown` postMessage 보존.

**테스트**: 신규 79종(1차 17 + 2차 10 + 3차 6 + 4차 17 + 7차 cancelCell host reconciliation 1 + 8차 host recovery cache lifecycle 1 + 9차 watcher robustness/empty-key 6 + 10차 Keep baseline 2 + 11차 Keep isRootArray & parse-fail recovery 2 + 12차 unified disk-fail fallback 2 + 13차 baselineUnknown signal & reload size guard 4: Keep markBaselineUnknown 1 / webview sentinel + handler 1 / disk-fail fallback baselineUnknownForWebview 1 / reload size guard 1 / auto-reload catch state update 1 + 14차 Keep race / reload failure / size fingerprint 9: shouldOfferRecovery size mismatch + match + legacy fallback + size-unknown fallback 4 / Keep post-prompt re-stat 1 / manual Reload failure handler 1 / writeSnapshotEntry size stamp 1 / watcher self-write suppression mtime+size 1 / currentLastWriteSize paired declaration 1; 12차의 Keep `data:{}` 가드는 markBaselineUnknown 가드로 교체되어 +0 로 통합, 14차에서 기존 Keep baseline 가드는 `postPromptStat` 으로 갱신), 5·6차는 기존 가드 강화로 추가 케이스 0, 최종 1149 passing.

## [0.4.29] - 2026-05-05

### 수정 / 추가 — Memory Map 리포트 개선 + WebView 임베딩 보안 / Region Details UX 정리

#### High (XSS 잠재 위험 / 데이터 손상 / 잘못된 정보)
- **WebView script 임베딩에서 `</script>` 인젝션 차단**: `Copy Report`, `Copy Full Dump`, 그리고 region/section 데이터를 담는 `RD` 변수가 모두 `<script>` 안에 직접 박힙니다. JSON.stringify만으로는 JS 파서 경계만 안전해질 뿐, HTML 파서는 `</script>` 텍스트를 보면 즉시 스크립트를 종료합니다. 사용자 통제 가능한 입력(파일 경로, 파일명, region/section 이름)에 `</script>`가 들어가면 임의 inline `<script>` 실행이 가능했음. 표준 패턴 `JSON.stringify(value).replace(/</g, '\\u003c')`을 헬퍼 `escapeForScript`로 추출해 세 임베딩 모두 통과시킴 — JS 파서는 `<`를 `<`로 디코드해 의미 보존, HTML 파서는 6글자 텍스트로 보아 패턴 형성 안 됨. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `escapeForScript`.
- **`atob()` UTF-8 mojibake로 클립보드 깨짐**: 기존 webview는 base64를 `atob()`로 디코드해 string으로 만들었는데, atob은 binary string(각 char가 한 바이트)을 반환합니다. 새 요약 보고서가 포함하는 `—`(em dash)와 `≥`(ge) 같은 multi-byte UTF-8 문자가 `â`, `â¥`로 깨져 클립보드에 들어갔습니다. base64 + atob 파이프라인을 `JSON.stringify` 임베딩으로 전환 — Unicode 무손실. 동일 helper에서 `<` escape까지 한 번에 처리. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `escapeForScript`, [src/test/elfParser.test.ts](src/test/elfParser.test.ts) UTF-8 round-trip 테스트.
- **Memory Regions 표의 `Base` 컬럼이 region origin이 아니라 가장 큰 섹션 주소**: `computeMemoryUsage` / `computeSymbolUsage`가 `sections`를 size 내림차순으로 정렬해 반환하므로, 새 요약 보고서가 `u.sections[0].addr`를 origin으로 사용하던 게 잘못된 주소를 노출했습니다. `generateSummaryReport`에 `regions: MemoryRegion[]` 인자를 추가해 `originByName` Map으로 정확한 origin lookup. 참조: [src/elfParser.ts](src/elfParser.ts) `generateSummaryReport`.

#### Medium (Region Details 토글 라벨이 실제 동작과 어긋남)
- **개별 펼침 경로 3곳에서 `▼ Expand All` 라벨 동기화 누락**: 단일 토글 버튼은 DOM 상태(펼친 region 존재 여부)에 따라 `▼ Expand All` ↔ `▶ Collapse All`을 자동 전환하는데, `toggleRegion` 외의 자동 펼침 경로 — (1) 검색 키워드로 매치된 region 자동 펼침, (2) Overview 표 row 클릭, (3) `Ctrl+Shift+O` (`scrollToRegion` 메시지) — 가 `syncToggleAllLabel()`을 호출하지 않아 라벨이 stale 상태로 남았습니다. 예: 전체 접힘 상태에서 Overview row 클릭 → region은 펼쳐졌는데 버튼은 여전히 `▼ Expand All`로 보이고, 클릭하면 실제로는 전체 접기가 실행됨. 세 경로 모두에 `if (window.syncToggleAllLabel) window.syncToggleAllLabel();` 한 줄씩 추가. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts).

#### UX / 일관성
- **Region Details의 `Expand All` / `Collapse All` 두 버튼 → 단일 토글 버튼**: 라벨이 다음 클릭이 수행할 동작을 반영. 개별 region을 수동으로 펼치거나 접어도 동기화되어 항상 정확한 액션을 안내. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts) `toggleAll`, `syncToggleAllLabel`.
- **`Copy Report` 보고서 형식 큐레이션 + `Copy Full Dump` 버튼 분리**: 기존 보고서는 region별 모든 섹션 + All Sections 표를 통째로 출력해 sample_armlink_large.txt 기준 ~820줄. 새 `Copy Report`는 markdown 표 형식의 50줄 요약(헤더, Memory Regions 표, region별 Top 5 섹션 + 가장 큰 free hole, Highlights 섹션 — 가장 큰 섹션, 가장 큰 free hole, ≥80% 포화 region 경고). 형식이 markdown이라 GitHub 이슈/PR, Slack, Notion에 그대로 붙여 넣어도 정렬이 깨지지 않음. 기존 dump가 필요한 사용자(grep / diff / 회귀 비교)는 `Copy Full Dump` 버튼으로 종전 동작 그대로 사용. 참조: [src/elfParser.ts](src/elfParser.ts) `generateSummaryReport`, [docs/features.md](docs/features.md) "리포트 복사".
- **WebView에서 `Ctrl/Cmd+F` 단축키로 검색창 포커스**: 기존에는 keydown 핸들러가 없어 webview 내부에서 단축키가 묻혔음. 이제 어디서 누르든 검색창에 focus + 기존 입력이 있으면 전체 선택(바로 덮어쓰기). `Ctrl/Cmd+Shift+F`(VS Code "Find in Files")는 `!shiftKey && !altKey` 가드로 통과시켜 전역 단축키 보존. `Esc`는 검색창 안에서만 동작 — 1차 누름은 검색어 비우고 필터 즉시 리셋, 2차 누름은 blur. 참조: [src/memoryMapViewer.ts](src/memoryMapViewer.ts).
- **Memory Map 스크린샷 갱신**: 단일 토글 버튼 + 두 복사 버튼이 보이는 새 화면으로 교체 — README.md / README.en.md 두 곳에서 같은 경로 참조. 참조: [docs/images/memory-map-armlink.png](docs/images/memory-map-armlink.png).

**테스트**: 신규 13 케이스 — `generateSummaryReport` 7종(헤더 출력 / Memory Regions 표 / Top-N 절단 + `+ N more` / 커스텀 topN / Highlights(가장 큰 섹션·hole·포화 경고 묶음) / usage 없을 때 블록 생략 / 50섹션도 <40줄 컴팩트성 + monospace 패딩 없음), 회귀 가드 6종(**Memory Regions Base가 origin 출력 (largest section addr 아님)**, **UTF-8 출력 보존**, **JS 임베딩 round-trip**, **`<` escape — string 페이로드**, **`<` escape — RD object 페이로드**, **end-to-end: section 이름 with `</script>`가 보고서 임베딩 거쳐도 안전**). 최종 1074 passing.

## [0.4.28] - 2026-05-05

### 추가 — Quick Action Palette (`TaskHub: Run Any Action…`) + `recentLimit` 설정

#### UX (액션 시스템 / 키바인딩 우회 경로)
- **단일 커맨드로 모든 액션을 fuzzy 검색·실행**: `taskhub.runAnyAction` 명령을 추가했습니다. Command Palette에서 `TaskHub: Run Any Action…` 또는 사용자가 이 한 명령에만 키를 바인딩해두면, 트리에 등록된 모든 runnable 액션이 한 QuickPick 리스트로 펼쳐져 두세 글자만 쳐서 실행할 수 있습니다. 폴더 / 별칭 prefix 매칭은 `matchOnDescription: true`로 폴더 breadcrumb까지 검색 면에 포함되어 자동 처리됩니다. 액션마다 `keybindings.json` 에 매핑하지 않아도 "팔레트 + 두세 글자" 근육 기억으로 가치의 80%를 회수하는 우회 경로 — 로드맵 §9 참조: [docs/roadmap.md](docs/roadmap.md). 참조: [src/extension.ts](src/extension.ts) `taskhub.runAnyAction`, `buildRunAnyActionPicks`.
- **최근 사용 액션이 위 섹션에 표시**: 마지막으로 실행한 액션은 `globalState`(`taskhub.runAnyAction.mru`)에 액션 ID로 저장되며 (label 이 아니라 ID 로 저장 — 액션 이름 변경에 영향받지 않게), 다음 팔레트 호출 시 `Recently used` separator 아래 가장 위에 노출됩니다.
- **`taskhub.runAnyAction.recentLimit` 설정** (기본 5, 범위 0–20): 노출되는 최근 사용 항목 개수를 사용자가 조정. `0`으로 두면 *Recently used* 섹션 자체가 사라지고 모든 액션이 단일 리스트로만 보입니다. 사용자가 설정을 줄였을 때(예: 5 → 3)도 다음 팔레트 호출에서 즉시 반영되도록 **읽기 시점 + 쓰기 시점 양쪽**에서 슬라이스 — 저장된 stale 잔여물이 화면에 새지 않습니다.
- **stale MRU 항목은 표시 시점에 필터링**: 사용자가 액션을 삭제하거나 폴더 ID 가 우연히 MRU에 들어가도, 매번 팔레트가 열릴 때 현재 액션 트리에 존재하는 runnable ID 만 추려서 노출합니다 — "실행 시점이 아니라 표시 시점에 필터" 라는 의도적 설계: 더 이상 존재하지 않는 항목을 사용자가 선택하는 경로 자체를 차단합니다.
- **folder / separator 항목은 평면화에서 제외**: `taskhub.runAction.<id>` 동적 등록과 같은 규칙(item에 `.action` 속성이 있어야 runnable) 을 재사용 — 트리 탐색용 폴더는 팔레트에 등장하지 않습니다.

#### Medium — 1차 리뷰 후속 수정 (P2: stale-then-slice 로 valid 최근 항목이 매장되던 문제)
- **`buildRunAnyActionPicks` 가 stale 필터를 limit 보다 먼저 적용**: 초기 구현은 핸들러에서 `stored.slice(0, limit)` 으로 먼저 자른 뒤 `buildRunAnyActionPicks` 안에서 stale 을 걸렀습니다. 그 결과 저장값이 `[deleted×5, valid1, valid2]` 이고 limit=5 면 앞쪽 5개가 모두 삭제된 액션이라 recent 가 0개로 끝나는 회귀가 있었음 ("최대 N개의 최근 runnable" 의도와 어긋남). 이제 `buildRunAnyActionPicks(actions, mru, recentLimit)` 가 stale id 를 먼저 걸러낸 뒤 limit 을 적용합니다 — 사용자가 액션 여러 개를 연속으로 삭제해도 다음 N개의 valid 한 최근 액션이 그대로 보입니다. 핸들러도 `stored` 를 그대로 넘기도록 변경. 또한 selection 후 storage 업데이트의 base 를 `stored` 가 아니라 `recent.map(p => p.actionId)` 로 바꿔, stale id 가 다음 selection 시점에 storage 에서도 자동으로 청소되도록 했습니다.

#### Low — 1차 리뷰 후속 수정 (P3: `recentLimit=0` 일 때 leading separator 가 남던 문제)
- **`buildRunAnyActionPaletteItems` 가 recent 가 비어있을 때 "All actions" separator 를 생략**: 문서는 `recentLimit=0` 이면 단일 flat 리스트로 보인다고 했지만, 핸들러는 `rest.length > 0` 이면 무조건 separator 를 뽑아 위에 비교 대상이 없는 leading heading 이 생겼습니다. QuickPick 아이템 어셈블리를 순수 helper 로 추출하고, recent 가 있을 때만 rest separator 를 emit 하도록 변경 — 이로 P3 도 단위 테스트로 고정 가능해졌습니다.

#### Low — 회귀 가드 (broken actions.json 시 팔레트가 어떻게 동작하는지 단위 테스트로 고정)
- **`planRunAnyAction` 순수 outcome helper 추출**: 핸들러 본문의 "load → 분기 → UI" 흐름을 순수 helper 로 추출했습니다 (`{kind: 'load-error' | 'empty' | 'show-palette', ...}` discriminated union 반환). 핸들러는 outcome.kind 별로 `showErrorMessage` / `showInformationMessage` / `showQuickPick` 만 호출하는 얇은 어댑터가 됩니다. 이 분리 덕분에 "actions.json 이 깨진 경우 팔레트가 빈 채로 열리지 않고 에러 토스트가 뜨는가" 라는 사용자 우려를 단위 테스트로 직접 핀 가능해졌습니다 — JSON parse 실패, schema validation 실패, 빈 액션 배열, out-of-range setting clamp(NaN/음수/초과값) 모두 helper 단에서 검증.

**테스트**: 신규 19 케이스 — `buildRunAnyActionPicks` 7종 (folder/separator 제외 / breadcrumb folderPath / MRU 순서 / stale 필터 / MRU 내부 중복 / **stale-at-front 가 limit 잡아먹지 않음 (P2)** / 명시적 limit override + limit=0 비활성), `updateRunAnyActionMru` 5종 (신규 prepend / 기존 이동 + dedupe / 기본 cap / 명시적 max override / `max=0` 비활성), `buildRunAnyActionPaletteItems` 2종 (**recent=[] 일 때 leading separator 없음 (P3)** / 둘 다 있을 때 separator 순서), `planRunAnyAction` 5종 (**broken JSON parse → load-error**, **schema validation 실패 → load-error**, 빈 배열 → empty, happy path items+recentIds+limit, out-of-range setting clamp). 통합 IT-088~IT-107. 최종 1062 passing.

## [0.4.26] - 2026-05-04

### 추가 — 같은 title 폴더 액션 disambiguation

#### UX (History 패널 식별)
- **충돌 시에만 풀 경로로 표시**: `Firmware/Build` 와 `Bootloader/Build` 처럼 두 폴더에 같은 title 액션이 있어 history 에 둘 다 등장할 때, 두 `HistoryItem` 의 라벨이 각각 `Firmware > Build` / `Bootloader > Build` 로 자동 전환됩니다. 같은 title 충돌이 없으면(또는 같은 actionId 의 반복 실행) 라벨은 그대로 짧은 형태(`Build`)를 유지 — 노이즈 없음. 풀 경로는 항상 툴팁에도 노출됩니다. 참조: [src/providers/historyProvider.ts](src/providers/historyProvider.ts) `computeDisambiguatedHistoryLabels`, [src/extension.ts](src/extension.ts) `findActionPathById`.
- **저장 시점 freeze**: `HistoryEntry.actionPath` 를 액션 실행 시점에 굳혀 저장하므로, 이후 액션을 리네임하거나 삭제해도 history 의 식별 경로는 변하지 않습니다. 레거시 entry(이 필드가 없는 기존 데이터)는 안전하게 짧은 라벨로 폴백합니다.

#### Low — 1차 리뷰 후속 수정 (path 까지 같은 액션 두 개를 구분 못 하던 문제)
- **distinct actionId + 같은 actionPath → `(actionId)` suffix**: 액션 트리에 동일한 폴더 구조가 중복되거나(예: `Firmware/Build` 가 두 군데), 과거 rename 으로 legacy entry 의 path 가 다른 액션의 현재 path 와 일치하면, step 1 의 path swap 만으로는 두 row 가 모두 `Firmware > Build` 로 남아 시각적으로 구별 불가했습니다. `computeDisambiguatedHistoryLabels` 에 2-pass 가드를 추가해, 같은 path-joined 라벨에 distinct actionId 가 둘 이상 매핑되면 모든 멤버에 `(<actionId>)` suffix 를 붙입니다 (`Firmware > Build (fw1.build)` / `Firmware > Build (fw2.build)`). 같은 actionId 의 반복 실행은 distinct id 카운트가 1 이라 suffix 없음 — 회귀 가드 `IT-087b` 그대로 유지. 툴팁의 path 줄도 동일한 disambiguated 텍스트를 사용해, hover 시에도 두 row 가 구별됩니다.

#### Low — 2차 리뷰 후속 수정 (root-level / legacy entry 충돌도 distinct-id 불변 보장)
- **path 가 없는 충돌도 `Title (actionId)` 로 폴백**: 이전 버전은 step 1 에서 `actionPath.length > 1` 인 경우에만 라벨을 생성하고, root-level 액션(`actionPath = ['Build']`) 이나 legacy entry(필드 부재) 가 같은 title 로 충돌하면 둘 다 bare `Build` 로 남아 구별 불가했습니다. 이제 title collision 이 감지되면 usable path 가 없는 entry 도 `Build (root.build.a)` 형태로 actionId 를 붙여 폴백합니다. **불변**: distinct actionId 는 panel 에서 라벨을 절대 공유하지 않음. 회귀 가드: `IT-087e` (두 root-level `Build` → 라벨·툴팁 모두 `Build (<id>)`), `IT-087c` 갱신 (legacy entry 충돌 시 `Build (old)` 로 폴백). 단위 4종 추가: legacy fallback / root fallback / pure root collision / root 반복은 collision 아님.

**테스트**: 신규 21 케이스 — `findActionPathById` 단위 5종, `computeDisambiguatedHistoryLabels` 단위 12종 (no-collision / 반복 / 충돌 / 부분 충돌 / legacy fallback / root fallback / 빈 입력 / path-collision suffix 3종 / pure root collision / root 반복은 collision 아님), 통합 IT-087·IT-087b·IT-087c·IT-087d·IT-087e.

## [0.4.25] - 2026-05-02

### 수정 — `envPick` 가 셸이 보지 못하는 변수까지 노출해서 후속 `printenv` 가 실패하던 문제

#### Medium (사용자 혼란 / 액션 오동작)
- **`envPick` 셸 환경 필터링**: 기존엔 `Object.keys(process.env)` 전체를 picker 에 노출했음. 그런데 VS Code / Electron 이 확장 호스트 프로세스에 주입하는 `VSCODE_*`, `ELECTRON_RUN_AS_NODE` 같은 변수들은 후속 셸 태스크가 spawn 하는 로그인 셸 (`zsh -l`) 환경에는 존재하지 않아, 사용자가 그것들을 고르면 `printenv VARNAME` 이 종료 코드 1로 실패하고 VS Code 가 "failed to launch" 라는 오해 소지 있는 메시지를 띄웠습니다 (기본 제공 액션 "Show Environment Variable" 에서 재현). 이제 `envPick` 첫 호출 시 사용자 셸 (`$SHELL -l -c env`, Windows 는 `cmd /c set`) 을 한 번 실행해 실제 노출되는 이름 목록을 캐시하고, `process.env` 의 키 중 그 목록에 포함된 것만 picker 에 표시합니다. 셸 호출이 5초 안에 끝나지 않거나 실패하면 fallback 으로 `VSCODE_*` / `ELECTRON_*` prefix 와 알려진 Electron 전용 이름들만 차단하는 hardcoded blocklist 를 사용합니다. 참조: [src/extension.ts](src/extension.ts) `getShellAccessibleEnvNames()`, `handleEnvPick()`.

#### High — 1차 리뷰 후속 수정 (probe 가 확장 호스트 env 를 상속해서 필터가 무력화되던 문제)
- **probe spawn 시 env sanitize**: 초기 구현은 `spawn(shell, args, { stdio: [...] })` 처럼 호출해 Node.js 의 기본 env 상속 동작이 적용됐습니다. 그 결과 확장 호스트가 들고 있던 `VSCODE_*` / `ELECTRON_*` 가 그대로 probe 셸 (`zsh -l -c env`) 의 환경에 들어가고 `env` 출력에 포함돼, 필터의 `shellNames.has(n)` 이 그대로 통과시켜 picker 에 노출되는 회귀가 있었습니다 (`VSCODE_TEST_EXTHOST_LEAK=foo zsh -l -c env` 가 로컬에서 그대로 출력되는 것으로 재현). 이제 probe 호출 직전에 `process.env` 를 순회하며 `isExtensionHostOnlyEnvName(key)` 를 통과하는 변수만 모은 sanitize 된 env 객체를 만들어 `spawn(..., { env: probeEnv })` 로 명시 전달합니다. 추가로 호출부(`handleEnvPick`) 에서 `shellNames.has(n) && !isExtensionHostOnlyEnvName(n)` 조합을 항상 적용해, probe 가 어떤 이유로든 오염되더라도 hardcoded blocklist 가 마지막 방어선 역할을 합니다 (belt-and-suspenders).

**테스트**: 신규 1 케이스 (IT-033b) — 캐시 stub 없이 실제 `getShellAccessibleEnvNames()` 를 호출해서, `process.env` 에 심어둔 `VSCODE_TASKHUB_PROBE_LEAK_MARKER` 가 picker 에 노출되지 않는지 검증 (probe 가 env 를 상속하는 회귀를 잡음). 동시에 `TASKHUB_PROBE_USER_MARKER` 같은 일반 사용자 변수는 그대로 통과하는지도 확인. IT-033 갱신 — `__testHook_resetShellEnvNamesCache` 로 캐시를 stub 해 sentinel 변수만 셸에 있는 상황을 모사하고, `process.env` 에 함께 심어둔 `VSCODE_TEST_EXTHOST_ONLY` 가 picker 에서 제외되는지 검증.

## [0.4.24] - 2026-05-01

### 추가 — Markdown / HTML 우클릭 프리뷰·브라우저 열기 (TaskHub: Open Markdown Preview / Open HTML in Default Browser)

#### UX (Source Control diff에서 프리뷰/브라우저로 1-클릭 점프 경로 부재 해소)
- **`.md` / `.markdown` 우클릭 → "TaskHub: Open Markdown Preview"**: VS Code 내장 `markdown.showPreviewToSide`에 위임해 옆 컬럼에 렌더링된 프리뷰를 띄웁니다. SCM 변경 파일 컨텍스트에서도 동일한 메뉴가 노출되어, diff 텍스트가 아닌 렌더된 형태를 즉시 볼 수 있습니다.
- **`.html` / `.htm` 우클릭 → "TaskHub: Open HTML in Default Browser"**: `vscode.env.openExternal`로 OS 기본 브라우저에 즉시 띄웁니다.

#### 메뉴 노출 위치
- 두 명령 모두 `explorer/context`, `editor/title/context`, `scm/resourceState/context` 세 surface에 모두 등록 (총 2 × 3 = 6 메뉴 항목). 명령 ID는 그대로 Command Palette 및 사용자 `keybindings.json`에서 사용 가능.

#### High — 1차 리뷰 후속 수정 (SCM 컨텍스트 메뉴가 잘못된 파일을 열 수 있던 문제)
- **menu surface별 1번째 인자 모양이 다른 점을 정규화 (`coerceToUri`)**: `scm/resourceState/context`는 `SourceControlResourceState`(`{ resourceUri: Uri }`) 를, 멀티 셀렉트 시 그 배열을 첫 인자로 넘깁니다. 초기 구현은 `instanceof vscode.Uri`만 통과시켰기 때문에 SCM에서 우클릭하면 1번째 인자가 거부되고 활성 에디터로 폴백 — 사용자가 SCM에서 **변경된 README.md**를 우클릭해도 현재 열려 있는 **다른 .md 파일**이 프리뷰되는 회귀가 있었음. 핸들러 진입부에 `coerceToUri(arg: unknown)` 정규화기를 두어 `Uri`, `SourceControlResourceState`, 그 배열, 혼합 배열을 모두 처리하고 활성 에디터 폴백은 정규화 결과가 `undefined`일 때만 동작하도록 분기. 명령 등록도 `(arg?: unknown)`으로 변경.

#### Medium — 1차 리뷰 후속 수정 (Simple Browser 명령 정리)
- **`taskhub.openHtmlInSimpleBrowser` 제거**: 초기 설계에 포함됐던 `simpleBrowser.show` 위임 명령은 webview iframe + CSP 제약상 `file://` 로컬 HTML의 CSS·이미지·스크립트 로딩이 보장되지 않아 "보이긴 하는데 깨진" 결과가 나오기 쉽습니다. 동작 못 하는 명령을 메뉴에 두는 것이 더 나쁘다고 판단해 명령·메뉴(3 surface)·테스트·문서를 모두 제거했습니다. VS Code 내부에서 HTML을 안전히 보고 싶다면 `localResourceRoots` 등을 직접 다루는 자체 `WebviewPanel` 구현이 필요하며, 이는 별도 PR로 분리.

#### High — 2차 사용자 피드백 후속 수정 (SCM 컨텍스트 메뉴 visibility)
- **Source Control 메뉴는 설정 토글로 제어**: VS Code의 `scm/resourceState/context`는 `resourceExtname` / `resourceFilename` / `resourceLangId`를 안정적으로 제공하지 않아, 기본 SCM 뷰에서 `.md` / `.html`에만 메뉴를 노출하는 방식은 불가능합니다. 대신 `taskhub.preview.showSourceControlContextMenu`(기본값 `true`) 설정을 추가해 SCM preview/browser 메뉴 전체를 켜고 끌 수 있게 했습니다. 켜져 있으면 대상 확장자 외 파일에도 메뉴가 보일 수 있지만, 실행 시 핸들러가 실제 URI 확장자를 다시 검증해 잘못 여는 동작은 차단합니다.
- Explorer / editor title surface는 계속 `resourceFilename =~ /\.(md|markdown)$/i` / `resourceFilename =~ /\.(html|htm)$/i` 조건으로 대상 확장자에만 메뉴를 노출합니다.

#### 내부 구조
- **`src/previewOpener.ts`**: 모든 VS Code 호출을 `PreviewOpenerDeps` 인터페이스로 주입받아, 단위 테스트가 실제 VS Code 명령을 발생시키지 않고도 ① 위임 경로(어떤 명령에 어떤 인자를 넘기는지) ② 에러 경로(미지원 확장자, 활성 에디터 부재) ③ SCM 인자 모양 처리(단일·멀티·혼합 배열)를 모두 검증합니다.
- 대상 URI 해석 순서: ① `coerceToUri`가 정규화 → 매칭 확장자면 사용, 미매칭이면 에러로 종료 → ② 정규화 결과가 없으면 활성 에디터(매칭 확장자일 때) → ③ 그 외 한·영 에러 메시지 출력 후 종료.

**테스트**: 신규 25 케이스 ([src/test/previewOpener.test.ts](src/test/previewOpener.test.ts)) — 확장자 매칭 헬퍼 6, `coerceToUri` 정규화 6, 핸들러 위임·SCM 모양 수용·폴백·에러 경로 9, 라이브 확장에 대한 통합 검증(명령 등록 + package.json 메뉴 매트릭스 2 × 3 정합성 + SCM `when` 절이 `taskhub.preview.showSourceControlContextMenu` 한 가지로만 게이트되는지의 `IT-PRV-004` 보강) 4.

## [0.4.23] - 2026-05-01

### 추가 — 액션별 키바인딩 1급 지원 v1

#### High (UX impact — Actions 패널 클릭이 유일한 진입점이던 한계 해소)
- **`id`가 있는 모든 액션을 `taskhub.runAction.<id>` VS Code 커맨드로 자동 노출**: 사용자는 자신의 `keybindings.json`에서 액션 id에 키를 매핑하는 것만으로 어디서든 액션을 실행할 수 있습니다. tasks.json 대비 가장 큰 약점이었던 "키 한 방"을 해소.
- **Actions 패널 우클릭 → "Assign Shortcut"**: 클릭 시 VS Code의 Keyboard Shortcuts UI가 해당 액션의 커맨드 id로 미리 필터링되어 열리고, 사용자는 평소처럼 키를 입력해 등록합니다. 확장이 사용자 `keybindings.json`을 직접 수정하지 않으므로 충돌·`when` 절·플랫폼별 차이는 모두 VS Code 기본 UI에서 다룰 수 있고, 자동 동기화로 인한 데이터 손실 위험도 없음.

#### 내부 구조
- **`syncActionCommands` diff-sync**: 활성화 시 1회 + `actions.json` / preset / 워크스페이스 watcher 등 cache invalidation 지점마다 `refreshActionsAndCommands(context, mainViewProvider)`가 invalidate → sync → refresh 3단계를 수행. `Map<commandId, Disposable>` 비교로 추가/제거된 항목만 register/dispose. ([src/extension.ts](src/extension.ts))
- **Parse error 시 등록 보존**: `loadAllActions`가 throw하면 (mid-edit save 등) 기존 등록을 그대로 유지 — 사용자 키바인딩이 일시적 invalid JSON 때문에 끊기지 않게 함.
- **단일 도출 함수 `buildActionCommandId`**: 동적 등록과 `assignShortcut` 핸들러가 같은 함수를 공유. 향후 sanitization 변경 시 한 곳만 바꾸면 양쪽이 자동 일치 — stale 키바인딩 위험을 구조적으로 제거.
- **Test seam**: `syncActionCommandsFromActions(actions, registry?)`는 `loadAllActions` 우회 + 격리 registry 주입을 허용해 활성화된 확장의 실제 등록과 충돌 없이 단위 검증 가능.

#### 의도적 제외 (v1.5 / v2로 분리)
- **현재 바인딩된 단축키 표시**: 동적 커맨드는 `package.json` 정적 `contributes.keybindings`에 없으므로 `keybindings.json`을 jsonc로 직접 읽어야 함. 비용·복잡도가 v1보다 한 단계 높아 v1.5로 분리.
- **`actions.json`의 선언형 `keybinding` 필드 + `Sync Keybindings` 커맨드**: stale entry 처리 UX(자동 정리는 데이터 손실 위험)가 큰 작업이라 v2로 분리. v1은 사용자가 직접 VS Code UI에서 키를 등록하는 경로만 제공.

#### High — 1차 리뷰 후속 수정 (fresh window에서 키바인딩 미작동)
- **`onStartupFinished` activation event 추가** ([package.json](package.json:26)): 동적 커맨드는 `contributes.commands`에 없어서 VS Code의 `onCommand:<id>` 자동 활성화가 작동하지 않습니다. C/C++ 파일이나 TaskHub 사이드바를 먼저 열지 않으면, 사용자가 `keybindings.json`에 등록한 키를 눌러도 확장이 활성화되지 않아 커맨드를 찾지 못하는 회귀가 있었음. `onStartupFinished`는 워크벤치 복원 후(블로킹 없이) 활성화를 보장 — v1의 핵심 가치 "키 한 방"이 fresh window 첫 키 입력에서도 작동하도록 함.

#### Medium — 1차 리뷰 후속 수정 (id sanitizer collision로 인한 wrong-action 실행)
- **`buildActionCommandId`를 bijective percent-encoding으로 교체** ([src/extension.ts](src/extension.ts:351)): 초기 구현은 `[^A-Za-z0-9_.-]/g → _`로 lossy하게 sanitize했고, 이 방식에서는 `a/b`와 `a:b`처럼 distinct ID가 같은 command id `a_b`로 collapse되어 `Assign Shortcut`이 양쪽 액션을 같은 키바인딩 entry에 묶는 문제가 있었음. **스키마 패턴 강제 안 — 이미 사용자 `actions.json`에 들어있을 수 있는 ID(`Build Firmware`, `flash:prod`, 한글 등)를 patch 버전에서 schema-fail로 만드는 건 panel을 빈 상태로 만드는 더 큰 회귀임 (2차 리뷰 지적).** 대신 안전 알파벳은 그대로 두고 그 외 바이트만 `%HH`로 인코딩 — `fw.build` 같은 일반 ID는 출력 변화 없음, 그 외 ID는 distinct → distinct 보장. `%` 자체도 인코딩되어 unambiguously reversible. 회귀 가드: `IT-086` (`fw.build` round-trip + `a/b`·`a:b` distinct + `%` self-encoding).

#### Medium — 1차 리뷰 후속 수정 (키바인딩 경로의 이중 에러 알림)
- **`taskhub.executeActionById`에 pipeline 실패 catch 추가** ([src/extension.ts](src/extension.ts:3171)): 클릭 경로 `taskhub.executeAction`은 `executeAction` 실패를 catch해서 outputChannel에만 기록하는데, 키바인딩이 통하는 `executeActionById`는 `await executeAction(...)`를 그대로 노출해 reject됐음. `handleActionFailure`가 이미 사용자 메시지를 띄운 뒤 throw하므로, 키바인딩 실행에서는 VS Code의 generic "command failed" 토스트가 그 위에 한 번 더 뜨는 회귀가 있었음. 클릭 경로와 동일한 catch로 통일.

**테스트**: 신규 4케이스 (IT-083 등록 / IT-084 dispose / IT-085 rename / IT-086 command id bijective encoding).

## [0.4.22] - 2026-05-01

### 추가 — Problem Matcher / 진단 통합

#### High (UX impact — 빌드 task 사용자에게 매 사이클 시간 절약)
- **shell/command task 출력을 Problems 패널 진단으로 자동 변환**: `output.diagnostics`에 `"$gcc"` 같은 프리셋 또는 커스텀 정규식 패턴을 지정하면, task stdout의 컴파일러 에러·경고가 자동으로 `vscode.Diagnostic` 객체로 변환되어 Problems 패널과 에디터 빨간 squiggly로 노출됩니다. 사용자는 Problems 항목 클릭 → 해당 file:line:col로 즉시 점프, F8로 다음 에러 순환 가능. tasks.json `problemMatcher`의 핵심 가치 흡수.
- **내장 프리셋**: `$gcc` (gcc / clang / arm-none-eabi-gcc 호환), `$tsc` (TypeScript Compiler). 추가 toolchain은 사용자가 커스텀 패턴으로 정의 가능 (`pattern` + 1-based 캡처 그룹 인덱스).
- **상대 경로 자동 해석**: 컴파일러가 `src/main.c`처럼 상대 경로로 출력해도 task의 `cwd` 기준으로 절대 경로 변환. 임베디드 toolchain 출력에 친화적.
- **액션별 격리 + 자동 clear**: 같은 액션 재실행 시 이전 진단이 자동 정리되어 "에러 fix → 다시 빌드 → 옛 에러 잔존" 회귀 차단. 다른 액션의 진단은 영향받지 않음.

#### 데이터 모델
- **신규 `output.diagnostics: DiagnosticConfig`**: `DiagnosticPattern` 객체, 프리셋 string(`"$gcc"`), 또는 둘의 배열 형태 모두 지원. `pattern` + `file`/`line`/`message` 필수, `column`/`endLine`/`endColumn`/`severity`/`defaultSeverity`/`source` 선택. `actions.schema.json`에도 정의 추가되어 JSON Editor / ajv 검증에서 즉시 자동완성·검증 가능.
- **동작 조건은 `output.capture`와 동일**: shell/command는 `passTheResultToNextTask: true` 필요 (스트림 모드는 stdout 캡처 안 됨). stringManipulation은 항상 가능.

#### 내부 구조
- **`src/diagnosticMatcher.ts` 새 모듈**: 순수 함수 `applyDiagnosticMatchers(output, config)` — vscode 의존 없음, 단위 테스트로 직접 경계 고정. `DIAGNOSTIC_PRESETS` 레지스트리에 새 toolchain 추가는 한 줄 entry.
- **per-action `DiagnosticCollection` 라이프사이클**: `actionDiagnosticCollections: Map<actionId, DiagnosticCollection>`이 lazy 생성. `executeAction` 시작 시 `clearActionDiagnostics(id)`로 해당 액션 항목만 비움. `deactivate()`에서 모든 컬렉션 dispose.
- **VS Code Diagnostic 객체 변환**: `applyDiagnosticsToCollection`이 ParsedDiagnostic → `vscode.Diagnostic`(0-based Range)로 변환하고 URI별로 그룹화해 한 번에 set.

#### High — 1차 리뷰 후속 수정 (실패 빌드에서 진단 누락)
- **non-zero exit 빌드 실패에서도 진단 등록**: 초기 구현은 `await handleCommand(...)`가 throw되면 post-processing 블록까지 도달 못 해, **gcc/clang이 stderr에 진단을 쓰고 exit 1로 종료하는 가장 흔한 빌드 실패 케이스**가 Problems 패널에 안 뜨는 회귀가 있었음. 신규 `ShellCommandError`(stdout/stderr/exitCode 보존) + shell/command 분기의 try/catch 래핑으로 매처를 적용한 뒤 원본 에러 re-throw. action은 여전히 failure로 기록되고 history.output에 원본 stderr가 들어감. 회귀 가드: `IT-079`. (테스트는 node로 stderr에 gcc 출력 찍고 exit 1 — 실제 컴파일러 시뮬레이션.)

#### Medium — 1차 리뷰 후속 수정 (진단 cwd가 interpolated 안 된 경로 사용)
- **상대 경로 진단이 interpolated cwd 기준으로 해석되도록 수정**: `task.cwd: "${workspaceFolder}/subdir"` 같이 변수가 들어간 경로의 task에서 실제 명령은 interpolated된 cwd로 실행됐지만, 진단의 상대 경로 해석은 raw `task.cwd` 문자열을 다시 읽어 잘못된 위치로 resolve됐음. `interpolatedCwd`를 `executeSingleTask` 함수 스코프로 lift해 실행과 진단이 동일한 cwd를 보도록 정리. `cwdForTaskOutput` 헬퍼 제거. 회귀 가드: `IT-080`.

#### Low — 1차 리뷰 후속 수정 (`g` flag 문서 정합성)
- `flags` 필드 설명을 [src/schema.ts](src/schema.ts) / [schema/actions.schema.json](schema/actions.schema.json) / [docs/features.md](docs/features.md) 세 곳 모두 "**`g` flag는 silently 제거**"로 통일. 이전엔 일부에서 "automatically added"로 표기되어 사용자 혼동 여지가 있었음.

#### Medium — 2차 리뷰 후속 수정 (성공 경로의 stderr 누락)
- **exit 0 + stderr warning 케이스에서도 진단 등록**: 1차 리뷰에서 실패 경로(`ShellCommandError`)는 stdout/stderr 둘 다 보존했지만 성공 경로는 여전히 stdout만 매처에 통과시키고 있어 비대칭. gcc/clang이 warning만 있을 때 흔한 "exit 0 + stderr 출력" 패턴이 Problems 패널에 안 뜨는 회귀가 있었음. 다음과 같이 정리:
  - `executeShellCommand` 반환 타입을 `Promise<string>` → `Promise<{ stdout, stderr }>`로 변경 — 실패 경로의 `ShellCommandError.stdout/stderr`와 대칭
  - `handleCommand`가 `{ output, stderr }`를 반환. `output`은 historical meaning(=stdout) 그대로라 `output.capture` / `${task.output}` 의미는 완벽 보존 — `result.stderr`는 진단 매칭 전용으로만 노출
  - `combineStdoutStderrForDiagnostics(stdout, stderr)` 헬퍼로 success/failure 두 경로 모두 동일한 결합 규칙 사용 (빈 스트림은 leading/trailing newline 안 만듦)
- 회귀 가드: `IT-081` (exit 0 + stderr warning + `output.diagnostics: "$gcc"` → action success로 기록되면서 진단도 Warning severity로 등록)

#### Medium — 3차 리뷰 후속 수정 (sibling task 진단이 덮어쓰임)
- **같은 액션의 여러 task가 같은 파일에 진단을 내면 모두 보존**: VS Code `DiagnosticCollection.set(uri, ...)`은 해당 URI의 기존 entry 전체를 *replace*하는 의미라, 액션의 두 번째 task가 같은 파일에 진단을 내면 첫 번째 task의 contribution이 덮여 사라지는 회귀가 있었음. `applyDiagnosticsToCollection`이 set 직전 `collection.get(uri)`로 현재 entry를 읽어 concat 후 set하도록 수정 — 액션 시작 `clearActionDiagnostics`는 이전 run에만 적용되므로 같은 run의 sibling 진단은 그대로 누적. 회귀 가드: `IT-082` (한 액션의 compile + lint task가 같은 파일에 각각 warning/error를 내고 둘 다 보존되는지 확인).

#### 범위 한정 (Problem Matcher 1차 범위)
- **v1: batched mode only**: 진단은 task 종료 후 stdout 전체를 한 번에 파싱해 등록합니다. 5분짜리 빌드의 에러는 빌드 끝나야 보입니다. **streaming mode (실시간 진단)** 는 v2 — `executeStreamedTask`에 output tee 인프라 추가가 필요한 별도 작업이라 분리.
- **다중 라인 매칭은 미지원**: 한 진단이 여러 라인에 걸쳐 표현되는 형태(gcc note 후속 라인 등)는 v1에선 라인별 독립 매칭. v2 또는 v3에서 검토.

**테스트**: 신규 32케이스 추가 (단위 24: `normalizeSeverity` 3, `resolveDiagnosticMatcher` 4, `$gcc` preset 5, `$tsc` preset 1, multi-pattern + array config 3, 에러 경로 3, 방어 처리 2, 폴백 severity 3; 통합 8: IT-075 기본 등록, IT-076 재실행 자동 clear, IT-077 상대 경로 cwd 기준 해석, IT-078 스트림 모드 silent skip, IT-079 non-zero exit 진단 회귀 가드, IT-080 interpolated cwd 회귀 가드, IT-081 exit 0 + stderr 진단 회귀 가드, IT-082 sibling task 진단 merge 회귀 가드). 전체 961 passing.

## [0.4.21] - 2026-04-30

### 추가 — 멀티 task 액션 진행 표시

#### Medium (UX 개선)
- **실행 중 액션 카드에 "지금 어디" 진행 표시**: 멀티 task 액션이 실행 중일 때 라벨 옆에 `2/3 · link` 형태로 현재 task 위치와 id를 노출합니다 — "task1 끝났는지, 어디서 막혔는지" 알기 위해 터미널을 직접 안 봐도 되도록. 단일 task 액션은 의도적으로 비워둠(`1/1`은 노이즈). 액션 종료 시 자동으로 사라짐. ([src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts), [src/providers/actionStatus.ts](src/providers/actionStatus.ts))

#### 내부 구조
- **Pipeline transition 이벤트 도입**: `PipelineExecutionOptions.onTaskTransition` 콜백 추가. `executeActionPipeline`이 각 task에 대해 `running` → 종료 transition (`success`/`failure`/`skipped`) 4종을 1-based `{ taskId, index, total, state }` 형태로 발사. `executeAction`이 이를 받아 `actionStates.progress`를 갱신하고 `mainViewProvider.refresh()`를 호출. 외부 호출자(테스트 등)는 옵션 미전달 시 기존 동작 그대로 — backward compatible.
- **`actionStates` 모델 확장**: `{ state, progress?: { index, total, taskId } }`. progress는 mid-run 전용 — `finalizeActionRun`이 종료 시 자동 clear.
- **회고 정보 vs 진행 정보 분리 명문화**: [docs/architecture.md](docs/architecture.md) "개발 시 주의사항" §2에 정책 추가. 회고(시각·소요 시간)는 `HistoryItem.description`에만, 진행(현재 어디)은 `Action TreeItem.description`에만. 두 surface의 역할이 섞이지 않도록 회귀 가드 4종(IT-068b/072/072b/072c) 명시.

#### 범위 한정
- 본 릴리스는 두 항목 중 **"단계별 진행 인디케이터"**만 구현합니다. **"단계 클릭 시 해당 task의 터미널/출력으로 점프"**는 의도적으로 제외 — VS Code 터미널 패널이 이미 항상 접근 가능해 추가 클릭 단계의 ergonomics 가치가 낮고, Action TreeItem을 펼쳐지는 트리로 만들면 기존 폴더(`Folder`)와 시각적 충돌 발생. Option B로의 전환 가능성은 향후 사용자 피드백으로 판단.

#### Medium — 1차 리뷰 후속 수정 (콜백 격리)
- **`onTaskTransition` 콜백을 try/catch로 격리**: 진행률 표시는 side channel이므로 콜백이 throw해도 파이프라인의 success/failure 의미가 바뀌면 안 됨. 이전 구현은 `success`/`failure`/`skipped`/`running` 4 callsite에서 직접 호출해, 예컨대 `success` 콜백이 throw하면 정상 task가 실패로 기록되는 회귀가 가능했음. `executeActionPipeline` 내부의 `emitTransition` helper에서 try/catch로 감싸 outputChannel에 `[WARN]`만 남기고 호출자에는 throw하지 않도록 수정. 회귀 가드: `IT-074` (success 경로에서 모든 콜백 throw해도 파이프라인 정상 완료), `IT-074b` (failure 경로에서 콜백 throw해도 task 원본 에러가 그대로 reject — `'callback boom'`이 아니라 `'capture failed'`).

**테스트**: 신규 9케이스 추가 (통합 9: IT-069 정상 시퀀스, IT-070 skipped, IT-071 failure 후 중단, IT-072 progress description 렌더, IT-072b 단일 task noise 회피, IT-072c partial state 방어, IT-073 finalize 자동 clear, IT-074 throwing 콜백 success 경로 격리, IT-074b throwing 콜백 failure 경로 원본 에러 보존). 전체 929 passing.

## [0.4.20] - 2026-04-30

### 추가 — History 패널의 "Last run" 배지

#### Medium (UX 개선 / 데이터 모델 확장)
- **History 항목에 시각 + 소요 시간 배지 표시**: 각 `HistoryItem`의 `description`에 `✓ 14:30 · 1.2s` / `✗ 어제 09:15 · 45ms` 형태로 상태·실행 시각·소요 시간이 노출됩니다. 확장 재시작 후에도 그대로 남아 "오늘 빌드 됐었지?"류 질문에 한눈에 답이 됩니다. 진행 중(`running`) entry는 배지 대신 상태 아이콘만 표시. 시각 표기는 같은 날 `HH:mm`, 어제 `어제 HH:mm`/`Yest HH:mm`, 그 이전 `MM/DD`. 소요 시간 표기는 `Nms` / `N.Ns` (truncated, "60.0s" 회피) / `Nm Ms` / `Hh Mm`. ([src/providers/historyProvider.ts](src/providers/historyProvider.ts))
- **배지 위치는 History 패널 단일**: 시각·소요 시간 데이터는 `HistoryEntry` 자체의 속성이므로 그 데이터가 있는 표면에서만 보여줍니다. Actions 패널의 `Action` TreeItem에는 의도적으로 같은 배지를 두지 않습니다 — 같은 정보를 두 표면에 분산하는 디자인이 약하다고 판단. 회귀 가드는 `IT-068b`로 명시 고정.
- **데이터 모델 확장**: `HistoryEntry.durationMs?: number` 추가. `executeAction`이 `success`/`failure`/manual-stop 모든 종료 경로에서 `Math.max(0, Date.now() - timestamp)`로 계산해 `updateHistoryStatus`의 5번째 인자로 전달 (clock-skew 음수가 `workspaceState`에 들어가지 않게 clamp). 이전 릴리스 entry는 `durationMs`가 없어 배지에 시각만 표시됨 (호환).

#### 내부 구조
- **순수 포맷터 export**: `formatDuration(ms)` / `formatHistoryTimestamp(ts, now, lang)` / `formatLastRunBadge(entry, now, lang)`을 [src/providers/historyProvider.ts](src/providers/historyProvider.ts)에서 export. 모두 `now`를 인자로 받아 결정적이며 vscode 의존이 없으므로 단위 테스트로 경계값을 직접 고정.
- **`HistoryItem` 생성자에서 description 채움**: `vscode.env.language` 기반 `lang` 결정 후 `formatLastRunBadge`로 description 설정. 진행 중 entry는 `undefined` 반환 → description 비움.
- **`updateHistoryStatus` 시그니처 확장**: 옵셔널 5번째 인자 `durationMs?: number` 추가. 미전달 시 기존 entry의 `durationMs`는 보존됨 (회귀 검출: `updateHistoryStatus without durationMs leaves an existing duration alone` 테스트).
- **`formatLastRunBadge`의 음수 방어**: `executeAction` 측 `Math.max` clamp가 1차 방어, 표시 측 가드를 `>= 0`에서 `!== undefined`로 완화해 `formatDuration`의 `<0 → "0ms"` 분기가 실제로 작동 (이전에는 dead code). "시간 표시 누락"보다 "0ms 표시"가 정확한 시그널.
- **자정 경계 stale 방지**: `TreeItem.description`은 자동 갱신되지 않아 자정을 넘긴 세션에서 어제 23:30 항목이 오늘 자정 이후에도 "23:30"으로 남는 케이스가 있었음. `startHistoryAutoRefresh(provider, 60*60*1000)` 시간당 tick + `historyProvider.view.onDidChangeVisibility` 갱신 두 hook을 [src/extension.ts](src/extension.ts)에서 등록해, 켜둔 채 24시간을 넘겨도 다음 시간 tick(또는 패널 재진입) 시점에 배지가 자동 정정됨. 패널이 hidden일 때 tick은 단지 `onDidChangeTreeData` 이벤트만 발생시키고 실제 `getChildren`은 visible 시점에만 호출되므로 비용은 무시할 수준.

#### 범위 한정
- 본 릴리스는 두 항목 중 **"마지막 실행 결과 배지: ✓/✗ + 소요 시간"**만 구현합니다. **"빈도 기반 자동 정렬 또는 사용자 지정 핀"**은 의도적으로 제외 — 정렬·핀은 정책 결정이 더 큰 작업이므로 별도 PR에서 다룹니다.
- 같은 title을 가진 액션이 폴더 두 개에 있을 때 HistoryItem label이 둘 다 동일하게 보이는 disambiguation 문제는 인지하고 있으나 본 PR 범위 외 — `formatActionPath` 활용 여부와 함께 후속에서 처리 예정.

**테스트**: 신규 21케이스 추가 (단위 18: `formatDuration` 5경계 + `formatHistoryTimestamp` 4경계 + `formatLastRunBadge` 7분기(음수 durationMs → "0ms" 포함) + `durationMs` round-trip 2 + `startHistoryAutoRefresh` interval 동작·dispose 1; 통합 3: IT-067 success/failure durationMs 기록, IT-068 HistoryItem 배지 노출, IT-068b Actions 패널 배지 부재 회귀 가드). 전체 920 passing.

## [0.4.19] - 2026-04-30

### 추가 — 히스토리 입력값 캡처 및 "Re-run with Saved Inputs" 재실행

#### Medium (UX 개선 / 데이터 모델 확장)
- **인터랙티브 task 입력값을 히스토리에 자동 저장**: 액션 실행 중 사용자가 응답한 `inputBox` / `quickPick` / `envPick` / `fileDialog` / `folderDialog` / `confirm` task의 결과가 task id를 키로 해당 history entry의 신규 `inputs` 필드에 누적되어 `workspaceState`에 영속화됩니다. 비인터랙티브 task(shell, stringManipulation 등)는 영향 없음. 데이터 모델 변경: `HistoryEntry.inputs?: Record<string, unknown>` ([src/providers/historyProvider.ts](src/providers/historyProvider.ts)).
- **신규 명령 `taskhub.rerunFromHistoryWithInputs`**: 히스토리 항목 옆에 새로 표시되는 ▶ 인라인 아이콘으로 호출되며, 저장된 입력값을 그대로 task 결과로 주입해 다이얼로그를 다시 띄우지 않고 액션을 재실행합니다. 같은 task id에 저장값이 없는 새 인터랙티브 task만 정상적으로 다이얼로그를 띄웁니다. 기존 클릭 재실행(`taskhub.rerunFromHistory`)은 그대로 유지되어 항상 다이얼로그를 다시 엽니다.
- **`HistoryItem.contextValue` 확장**: 입력값 보유 여부를 반영해 `historyItem` / `historyItemWithOutput` / `historyItemWithInputs` / `historyItemWithOutputAndInputs` 네 가지로 분기되어 메뉴 표시 조건이 정확히 매칭됩니다.

#### Medium — 1차 리뷰 후속 수정 (replay 후처리 누락 회귀 차단)
- **재실행 시에도 인터랙티브 task의 공통 후처리가 실행되도록 수정**: 초기 구현은 `presetInputs`가 매칭되면 `executeActionPipeline` 루프에서 `executeSingleTask`를 통째로 우회했으나, 이 경로는 `executeSingleTask` 끝의 capture + `passTheResultToNextTask && output` 후처리 블록까지 함께 건너뛰는 부작용이 있었습니다. 그 결과 `inputBox`/`quickPick` 같은 인터랙티브 task가 `output: { mode: 'file' }`을 함께 가지면 일반 실행은 파일을 쓰지만 saved-input 재실행은 조용히 스킵되는 회귀가 있었습니다. `executeSingleTask`에 옵셔널 `presetResult` 파라미터를 추가해 type-specific dispatch만 스킵하고 공통 후처리는 그대로 통과하도록 정리. 회귀 검출은 `IT-066`이 `output.mode: 'file'`을 가진 단일 인터랙티브 task의 replay 시 파일 생성을 직접 검증합니다.

#### High (보안)
- **비밀번호 입력은 히스토리에 저장되지 않음**: `inputBox` task의 `"password": true`가 설정된 경우 해당 결과는 `shouldRecordTaskInput`에서 명시적으로 제외되어 `workspaceState`에 도달하지 않습니다. 회귀 검출은 `IT-065` 테스트에서 entry 직렬화에 비밀 문자열이 섞이지 않음을 negative assertion으로 고정합니다.

#### 내부 구조
- **`executeActionPipeline` 옵션 인자 추가**: 신규 `PipelineExecutionOptions { presetInputs?, recordInputs? }` 파라미터를 통해 외부 호출자가 입력값을 주입하거나 누적할 수 있습니다. 기존 호출자(테스트 포함)는 변경 불필요 — 옵션은 모두 옵셔널.
- **`executeAction` 시그니처 확장**: 옵셔널 다섯 번째 인자 `presetInputs?: Record<string, unknown>` 추가. 호출자가 명시적으로 넘기지 않으면 종전과 동일하게 다이얼로그를 띄움.
- **새 export**: `shouldRecordTaskInput(task)` (인터랙티브 + 비-password 판별 헬퍼), `PipelineExecutionOptions`.

#### 범위 한정
- 본 릴리스는 두 모드 중 **"그대로 재실행"**만 구현합니다. **"수정해서 실행"**(저장값을 다이얼로그 기본값으로 prefill 후 사용자 편집)은 후속 작업으로 분리되어 있습니다.

**테스트**: 신규 12케이스 추가 (단위 8: `shouldRecordTaskInput` 3, `setHistoryInputs` 라운드트립·clear·no-op·contextValue 5; 통합 4: IT-063 캡처 누적, IT-064 presetInputs 재실행, IT-065 비밀번호 제외, IT-066 replay 후처리 회귀). 전체 898 passing.

## [0.4.18] - 2026-04-24

### 수정 — 외부 리뷰 지적 11건 + 2차 리뷰 3건 + 3차 리뷰(경계값) 4건 + 4차 리뷰(테스트 품질) 5건 반영

#### 4차 리뷰: 테스트 품질 보강 (시뮬레이션 제거 / 경계값 확장 / 구현 미스매치 방어)
- **HistoryProvider 시뮬레이션 테스트 450줄을 실제 클래스 테스트로 교체**: [src/test/extension.test.ts](src/test/extension.test.ts)의 `HistoryProvider` 및 `Action Stop and History Update` 스위트가 그동안 로컬 `Map`/배열로 JavaScript 컬렉션 동작만 검증해 `addHistoryEntry`/`updateHistoryStatus`/`deleteHistoryItem`/`clearAllHistory`/`trimHistoryToMax` 회귀를 전혀 잡지 못하던 상태였다. `MockMemento` 기반 `ExtensionContext`로 [src/providers/historyProvider.ts](src/providers/historyProvider.ts)의 실제 인스턴스를 만들어 15개 케이스로 재작성. unshift 순서·`maxItems` 트리밍·workspaceState 라운드트립·`(actionId, timestamp)` 매칭·manual-stop/rerun 플로우를 모두 실제 API로 검증.
- **NumberBase `MAX_LINE_LENGTH` (10,000) 경계 테스트**: [src/numberBaseHoverProvider.ts](src/numberBaseHoverProvider.ts)에서 `lineText.length > MAX_LINE_LENGTH` 조건을 순수 predicate `NumberBaseHoverProvider.isLineTooLongForHover(lineText)`로 추출. 9999/10000/10001/빈 문자열/상수값 확인의 5개 경계 테스트 추가. 전체 hover 파이프라인(LSP, `getWordRangeAtPosition`)을 mock 없이 off-by-one만 명확히 검증.
- **MacroExpander 4096 길이 제한 경계 테스트**: [src/macroExpander.ts](src/macroExpander.ts) `evaluateToNumber`의 `cleaned.length > 4096` guard에 대한 4095/4096/4097 정확한 경계 검증 3개 추가. trim에 영향받지 않도록 입력 좌우에 공백을 두지 않도록 구성.
- **JSON Editor webview ↔ mirror 동기화 스모크 테스트**: webview JS가 문자열 템플릿(`getWebviewContent`)으로 내재되어 있어 [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) 미러와의 drift가 CI에서 보이지 않던 문제. `src/jsonEditor.ts`에서 `parseValue` 본문을 regex로 추출·`new Function`으로 재평가한 뒤 미러의 `parseValue`와 `''`/`'null'`/`'true'`/`'00123'`/`'1e10'`/`'0xFF'` 등 15개 fixture에서 결과를 비교. commitCell의 문자열 타입 보존 분기가 webview에 여전히 존재하는지도 텍스트 수준에서 확인.
- **Memory Map Viewer 실패 경로 테스트**: [src/test/memoryMapViewer.test.ts](src/test/memoryMapViewer.test.ts)가 panel registry 3케이스만 검증하던 것을 실패 경로 4종 추가(존재하지 않는 파일 / `MEMORY_MAP_MAX_FILE_SIZE + 1` sparse 파일 / 16바이트 미만 / 잘못된 ELF magic). 각 케이스에서 `panelRegistry`가 건드려지지 않음을 확인해 "조용히 실패" 회귀를 방어. `MEMORY_MAP_MAX_FILE_SIZE`를 export해 boundary를 정확히 pin.

**테스트 (4차 리뷰 관련)**: 신규 30케이스 추가, 시뮬레이션 스위트 25케이스 제거 → 874 → 879 passing.

#### 3차 리뷰: 경계값 테스트 보강 (off-by-one 회귀 방어)
- **캡처 한도 경계 테스트**: `executeShellCommand`의 조건 `capturedBytes + chunkBytes > captureLimitBytes`를 순수 함수 `wouldExceedCaptureLimit(current, chunk, limit)`로 [src/pipelineUtils.ts](src/pipelineUtils.ts)에 추출. `limit-1` / `limit` / `limit+1` / 0-byte chunk / 단일 chunk 등 5개 boundary 테스트를 [src/test/pipelineUtils.test.ts](src/test/pipelineUtils.test.ts)에 추가. `>`를 실수로 `>=`로 바꾸는 회귀를 즉시 포착.
- **`INTERPOLATED_VALUE_MAX_LENGTH` 경계 테스트**: 기존에는 40KB 초과 1건만 확인했으나 이제 32KB-1 / 32KB / 32KB+1 세 boundary를 명시적으로 검증.
- **`applyOutputCapture` group/line boundary 테스트**: 기존 `group: 0` / `5`, `line: 99` / `-99` 수준을 넘어서 `group: m.length-1`(성공) / `m.length`(실패) / `-1`(실패), `line: lines.length-1`(성공) / `lines.length`(실패) / `-lines.length`(성공) / `-lines.length-1`(실패)까지 7개 boundary 테스트 추가.
- **`HEX_VIEWER_MAX_SPAN` 경계 테스트**: [src/hexViewer.ts](src/hexViewer.ts)에서 span 체크 로직을 순수 함수 `assertWithinHexViewerSpan(totalSize)`로 추출. 128MB 정확히 일치(성공) / -1(성공) / +1(실패) / NaN / Infinity / 음수를 검증. 128MB flat buffer를 실제로 할당하지 않고 경계만 검증하도록 분리.

**테스트 (3차 리뷰 관련)**: 신규 19케이스 추가 (855 → 874 passing).

#### 2차 리뷰: 후속 수정 (+1 회귀 테스트)
- **캡처 한도 초과를 "사용자 수동 중단"으로 오분류하던 문제**: [src/extension.ts](src/extension.ts) `executeShellCommand`가 출력 한도 초과 시 `manuallyTerminatedActions.add()`를 호출한 뒤 reject하여, 상위 `executeAction`이 실제 에러 대신 "Action stopped by user"로 히스토리에 기록하던 문제. 이제 overflow는 프로세스 kill만 수행하고, 정상적인 실패 경로를 통해 실제 에러 메시지와 함께 기록된다. 회귀 테스트 신규 추가.
- **Import 시 기존 `actions.json`의 TaskHub 스키마 검증 누락**: "JSON 배열이지만 스키마/추가 검증에는 실패하는 상태"의 파일이 그대로 병합/저장되어 다음 로드에서 깨지던 경계 케이스 수정. 이제 `JSON.parse + Array.isArray` 대신 `loadAndValidateActions()`를 통해 **정상 로드 파이프라인과 동일한 검증**(스키마 + 중복 task ID 등)을 먼저 통과시킨 뒤에만 병합하며, 실패 시 백업 다이얼로그로 안전하게 대응한다.
- **`taskhub.openJsonEditorFromUri` 팔레트 노출 복원**: 이 명령은 인자 없이 호출해도 활성 JSON 파일 또는 파일 선택 fallback이 있어 context-only가 아니다. 문서의 "두 개의 JSON Editor 커맨드" 설명과 일치하도록 `commandPalette` 숨김 목록에서 제외.

#### 1차 리뷰 — High (데이터 손실 / 신뢰 손상)
- **Import: 손상된 `actions.json` 덮어쓰기 방지**: [src/extension.ts](src/extension.ts) `taskhub.importActions`가 기존 파일 파싱에 실패하면 `existingActions = []`로 리셋 후 가져온 액션만 저장해 사용자가 직접 만든 액션이 조용히 사라지던 문제 수정. 이제 파싱 실패 시 "손상된 파일 백업 후 계속 / 취소" 모달을 띄우고, 사용자 동의가 있을 때만 `actions.json.bak`로 백업한 뒤 진행한다. **UX 변경**: 기존에는 알림 없이 파일이 덮어씌워졌으나, 이제는 명시적 동의가 필요하며 원본이 `.bak`로 보존된다.
- **Preset merge "Use preset"이 실제로 프리셋을 사용하지 않던 버그**: [src/extension.ts](src/extension.ts) `mergeActions()`가 strategy와 무관하게 `preset.filter(... !existingIds.has(id))`로 프리셋을 걸러 "use-preset"을 골라도 충돌 프리셋 액션이 항상 드롭되던 문제. 이제 `use-preset`은 역방향(existing에서 conflicting 항목 제거)으로 병합한다. `keep-existing`은 기존과 동일 의미를 유지하도록 내부 구현만 정리. **UX 변경**: QuickPick "프리셋 우선" 선택이 이제 설명대로 작동한다.

#### Medium (상태 무결성 / 명령 오동작)
- **Import 시 duplicate task ID 검증 추가**: [src/extension.ts](src/extension.ts) `parseImportData`가 기존에는 스키마 + 액션 ID 중복만 검사해, 한 액션 내부에 같은 `task.id`가 중복된 파일을 통과시켜 다음 `loadAllActions`에서 전체 로드가 실패하던 문제. 이제 정상 로드 경로와 동일한 `performAdditionalActionValidation`을 재사용한다.
- **Command Palette에서 context-only 명령 숨김**: [package.json](package.json) `menus.commandPalette` 섹션을 새로 추가해 인자 없이 호출하면 throw 가능한 `taskhub.copyLink`, `goToLink`, `executeAction`, `stopAction` 등 컨텍스트 전용 명령을 `when: false`로 모두 숨김 처리.
- **`showTaskStatus=false`일 때 중복 실행 가드 비활성화 문제**: [src/extension.ts](src/extension.ts) `markActionAsRunning`이 `showTaskStatus=false`면 즉시 `return true`하여 동일 ID의 `activeTasks` 충돌을 허용하던 문제. 이제 가드는 항상 동작하고 설정은 뷰 리프레시에만 영향을 준다. `actionStates`도 항상 업데이트해 다음 실행에서 상태 판정이 정확하다.
- **Shell 커맨드 stdout/stderr 캡처 제한**: [src/extension.ts](src/extension.ts) `executeShellCommand`가 출력을 무제한 누적해 대용량 로그 발생 시 extension host OOM 위험이 있었다. 새 설정 `taskhub.pipeline.outputCaptureLimitMb` (기본 10MB, 1~1024MB)를 도입하고 초과 시 프로세스를 종료하며 명시적 에러를 던진다.

#### UX / 일관성
- **JSON Editor — string 타입 보존**: [src/jsonEditor.ts](src/jsonEditor.ts) 셀 편집 시 `parseValue()`가 `"00123"`을 `123`, `"true"`를 `true`, `"null"`을 `null`로 조용히 변환해 데이터 무결성이 깨지던 문제. 원본 셀이 문자열이면 입력값을 그대로 문자열로 저장한다. 새 유닛 테스트는 [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts)의 미러 `coerceEditedCellValue`로 검증.
- **JSON Editor — dirty 상태에서 같은 파일 재오픈 시 확인**: 같은 경로의 파일을 다시 열 때 discard 확인이 스킵되어 미저장 내용이 사라지던 문제. 이제 동일 파일 재오픈 시에도 dirty면 확인 다이얼로그가 표시된다.
- **Favorites 경로 이식성**: `taskhub.addFavoriteFile` / `taskhub.addOpenFileToFavorites`가 파일의 절대경로를 그대로 저장해 `.vscode/favorites.json`이 다른 머신에서 열리지 않던 문제. 워크스페이스 내부 파일은 자동으로 `${workspaceFolder}/...` 형태(POSIX 슬래시 정규화)로 저장되어 예제/스키마와 일치.
- **Obsolete `Select and Run File` 명령 제거**: 빈 핸들러만 남아 있던 `taskhub.showFilePicker` 명령을 `package.json`과 `extension.ts`에서 완전 제거.
- **`exportActions` 멀티-루트 일관성**: 항상 `workspaceFolders[0]`을 쓰던 것을 `pickWorkspaceFolderForCommand`로 교체해 `importActions` / `editActions` / `editLinks` 등과 동일한 플로우로 통일.

**테스트 (1차 리뷰 관련)**: 신규 케이스 12종 — `mergeActions` 3, `toWorkspaceRelativePath` 3, import duplicate-task-id 1, `coerceEditedCellValue` 5.

**0.4.18 릴리스 테스트 총괄**: 1차 12 + 2차 1(capture overflow 회귀) + 3차 19(경계값) + 4차 30 − 4차 시뮬레이션 25 제거 = 순증 +37, 최종 842 → 879 passing.

## [0.4.17] - 2026-04-23

### 수정 — 리뷰에서 지적된 가져오기/JSON Editor/멀티 루트 경계 버그 3종

- **Import 중복 ID 검사 확장**: [src/extension.ts](src/extension.ts) `mergeImportedActions`가 기존에는 가져올 액션의 최상위 `item.id`만 검사해 폴더 내부 자식 ID가 이미 존재하는 액션과 충돌해도 그대로 `actions.json`에 기록되어 다음 로드에서 "duplicate action IDs" 에러로 워크스페이스 설정이 깨질 수 있었다. 이제 가져올 각 최상위 항목의 모든 하위 ID를 재귀 수집해 충돌이 하나라도 있으면 해당 top-level 항목 전체를 skip한다. **UX 변경**: 기존에 "가져오기 성공" 후 다음 로드에서 깨지던 파일은 이제 즉시 skip 알림이 표시된다(원래 버그 상태 노출).
- **JSON Editor dirty 상태 동기화**: [src/jsonEditor.ts](src/jsonEditor.ts) 전역 패널을 재사용하며 새 파일을 열 때 수정사항이 있어도 HTML을 그냥 덮어써 편집 내용이 조용히 사라질 수 있었던 문제 수정. webview가 `setModified`에서 host로 상태 변경을 통보하도록 하고, host는 (1) 같은 패널에 다른 파일을 열 때 dirty면 확인 다이얼로그 표시, (2) Reload 버튼 클릭 시 dirty면 확인, (3) Save는 파일 쓰기 성공 후에야 `saveResult`를 webview에 반환해 modified 플래그를 내리도록 변경. **UX 변경**: Reload/다른 파일 열기 시 수정사항이 있으면 "변경사항 버리기" 확인 다이얼로그가 새로 뜨며, 저장 실패 시 modified 표시가 유지된다.
- **멀티 루트에서 액션별 워크스페이스 올바르게 선택**: `previewAction`이 `${workspaceFolder}`를 항상 `workspaceFolders[0]`로 계산하던 것을 `actionWorkspaceFolderMap`에서 해당 액션의 실제 소속 폴더로 해결하도록 수정. `exportActionItem`의 저장 기본 경로도 같은 방식으로 보정. `importActions`는 기존 `edit actions` 등과 동일하게 `pickWorkspaceFolderForCommand` 피커 사용. `showMemoryMap`은 루트가 2개 이상이고 `taskhub_types.json`이 2곳 이상일 때만 피커가 뜨도록 절충. **UX 변경**: 단일 루트 사용자는 동일. 멀티 루트 사용자는 import에서 새로 피커가 뜬다(기존 다른 명령과의 일관성 회복).

모두 이전 동작과 달라지는 부분이 있어 리뷰어 권고대로 명시적으로 알린다. 테스트: 842 passing (`mergeImportedActions` nested-conflict 2 케이스 추가).

## [0.4.16] - 2026-04-23

### 정리 — provider 재-export shim 제거 + unused import 정리

- [src/extension.ts](src/extension.ts) 상단에 있던 "이제 `./providers/...` 에 있으며 기존 호출자 호환을 위해 re-export한다" 는 3블록 + normalizeTags/normalizeLineNumber 재-export를 제거. providers 분리 마이그레이션의 잔재로, 실제로 extension.ts를 경유해 import하던 테스트는 [src/test/extension.test.ts](src/test/extension.test.ts) 의 `normalizeTags`/`normalizeLineNumber` 2개뿐이어서 이 테스트만 `from '../providers/normalization'` 로 직접 redirect.
- 같은 기회에 extension.ts 에서 실제 사용되지 않던 `LinkTreeNode`, `LinkGroup`, `FavoriteTreeNode`, `FavoriteGroup`, `normalizeTags` import를 제거. 총 약 60줄 감소.
- 참고: TreeDataProvider 4종(`MainViewProvider`/`LinkViewProvider`/`FavoriteViewProvider`/`HistoryProvider`)은 이미 이전 리팩터링에서 `src/providers/` 로 분리 완료된 상태. 이번 변경은 그 마이그레이션의 호환 shim을 걷어내는 마무리 정리.

## [0.4.15] - 2026-04-23

### 정리 — `console.error` 로그를 OutputChannel로 통일

- [src/extension.ts](src/extension.ts) 의 8개 `console.error` 호출을 기존 `TaskHub` OutputChannel(`outputChannel.appendLine('[ERROR] ...')`)로 전환. 기존에는 에러가 Extension Host 콘솔로만 빠져 일반 사용자가 버그 리포트 시 재현하기 어려웠는데, 이제는 다른 `[INFO]/[WARN]` 로그와 같은 채널에서 확인 가능.
- 대상: `terminateChildProcesses`(자식 프로세스 종료 실패), one-shot task 시작 실패, `taskhub.executeAction`/`taskhub.executeActionById`/`taskhub.previewAction`/`taskhub.rerunFromHistory` 의 `loadAllActions` 실패 및 `executeAction` 예외.
- `error instanceof Error ? error.message : String(error)` 패턴으로 non-Error throw 대비.

## [0.4.14] - 2026-04-23

### 정리 — jsonEditor webview JS ↔ jsonEditorUtils 미러 동기화 주석

- [src/jsonEditorUtils.ts](src/jsonEditorUtils.ts) 상단에 "webview JS의 테스트용 미러" 주석 추가. `buildSheetMap`/`getRowsByPath`는 [src/jsonEditor.ts](src/jsonEditor.ts)의 webview HTML 내부 JS 문자열에서 동일 로직으로 복제되어 있는데, 프로덕션 코드는 webview 내부 JS 문자열을 사용하므로 `jsonEditorUtils.ts`를 import하지 못한다. 두 복제본이 말없이 어긋날 위험을 줄이기 위해 양쪽에 상호 참조 주석을 추가했다.
- [src/jsonEditor.ts](src/jsonEditor.ts)의 webview JS `buildSheetMap` 블록 앞에도 "src/jsonEditorUtils.ts 와 동일해야 한다"는 주석 추가.

## [0.4.13] - 2026-04-23

### 정리 — 프로젝트 루트 hover 샘플을 `examples/`로 이동

- 프로젝트 루트에 흩어져 있던 `test_macro_expansion.h`, `test_numbers.cpp`, `test_phase2.cpp`, `test_register_decoder.h`, `test_sfr_bitfields.h` 5개 hover 샘플을 [examples/](examples/)로 이동. 실제 코드·유닛 테스트에서 참조되지 않고 수동 hover 시연용으로만 쓰이던 파일들이라 기존 예제(`bit_operations_example.*`, `sample_armlink*.txt`, `sample_binary.bin`)와 같은 위치로 통합.
- `test_phase2.cpp`는 내용이 const/enum/#define 식별자에 대한 Number Base Hover 시연이어서 [examples/test_const_enum_define.cpp](examples/test_const_enum_define.cpp)로 rename. `git mv`로 히스토리 보존.
- [.vscodeignore](.vscodeignore) 정비: 루트 `test_*.cpp`/`test_*.h` 패턴이 더 이상 매치되지 않으므로 제거하고, `examples/**`를 추가하여 `bit_operations_example.*`·`sample_*` 포함 모든 시연용 자산을 VSIX 배포물에서 제외 (개발 전용 리포지토리 자산).

### 문서 — README 리디자인 + 영문 README 추가

- [README.md](README.md) Level 1 리디자인:
  - 상단 tagline + 언어 선택 줄(`한국어 · English`) 추가
  - 목차(TOC) 6개 섹션으로 네비게이션 제공
  - 기능 소개를 4개 카테고리(워크플로우 / 사이드바 패널 / C/C++ Hover / 뷰어)로 재분류하고 `**제목** — 설명` 형식 통일
  - 스크린샷 재구성: 워크플로우 3-column 그리드(사이드바 / 액션 실행 / History), C/C++ Hover 2x2 그리드(Number Base / Register Decoder / SFR / Macro Expansion)
  - 설치 섹션을 스크린샷 직후로 승격
  - 설정 테이블을 `<details>` 접기 블록으로 전환
- [README.en.md](README.en.md) 신규 — 한국어판과 동일 구조의 영문 README. 상단 언어 선택 줄에서 상호 링크.
- 스크린샷 추가 ([docs/images/](docs/images/)): `actions-running.png`(액션 실행 중 상태), `history-panel.png`(실행 기록 성공/실패 아이콘), `hover-macro-expansion.png`(매크로 최종 확장 표시). README 기능 목록에 Macro Expansion Hover, Register Decoder Hover를 bullet으로 명시적 추가.
- [examples/README.md](examples/README.md) 재작성 — Bit Operation Hover 단일 주제였던 기존 구조를 폴더 실제 내용 전체(Number Base / SFR / Register Decoder / Macro Expansion Hover + Bit Operation + Memory Map + Hex Viewer)를 다루는 문서로 재정리. 파일→기능 매핑 표와 [docs/features.md](docs/features.md) 링크 포함.

## [0.4.12] - 2026-04-22

### 추가 — Action 워크플로우 옵션 3종 (writeFile/appendFile, timeoutSeconds, continueOnError)

- **새 task 타입 `writeFile` / `appendFile`** ([src/extension.ts](src/extension.ts)). 문자열 콘텐츠를 파일로 쓰거나 이어 붙입니다. 기존에 `shell + echo > file`로 우회하던 패턴을 일급으로 대체. OS 분기·셸 이스케이프 없이 동작하고 워크스페이스 외부 경로는 거부됩니다. 옵션: `path`, `content`, `encoding`(`utf8`/`utf8bom`/`ascii`), `eol`(`lf`/`crlf`/`keep`), `overwrite`, `mkdirs`. 결과는 `${task.path}`로 downstream에서 참조 가능. `appendFile + utf8bom`은 기존 파일 중간에 BOM이 끼이지 않도록, 대상이 존재하지 않을 때에만 BOM을 추가합니다.
- **Task-level 옵션 `timeoutSeconds`** ([src/extension.ts](src/extension.ts) `executeActionPipeline`, [src/pipelineUtils.ts](src/pipelineUtils.ts) `withTaskTimeout`). 모든 task 타입에 공통 적용. budget 초과 시 timeout 에러로 종료하며, shell/command task의 경우 실행 중인 자식 프로세스를 best-effort로 terminate (`actionChildProcesses` + `activeTasks` 활용). `0`이거나 omit이면 비활성.
- **Task-level 옵션 `continueOnError`** ([src/extension.ts](src/extension.ts) `executeActionPipeline`). `true`이면 task 실패가 파이프라인 전체를 중단시키지 않고 다음 task로 진행. 실패한 task의 결과는 `{}`로 저장되어 downstream의 `${task.*}` 참조는 리터럴로 남음 (스트림 모드 shell task와 동일한 시맨틱).

### 헬퍼 / 인프라

- [src/pipelineUtils.ts](src/pipelineUtils.ts)에 `normalizeEol(content, eol)`, `encodeFileContent(content, encoding, includeBom)`, `withTaskTimeout(promise, timeoutSeconds, taskId, onTimeout)` 추가. `vscode` 의존성 없는 순수 함수로 unit-testable.
- [src/previewRun.ts](src/previewRun.ts)가 `writeFile`/`appendFile` task의 path resolve / content preview / workspace boundary 경고를 표시. `timeoutSeconds`/`continueOnError`는 모든 task에 공통 라인으로 출력.
- [schema/actions.schema.json](schema/actions.schema.json)에 신규 task 타입과 6개 옵션 등록.

### 테스트 — 44건 추가, 총 890개 통과

- 단위 테스트 ([src/test/pipelineUtils.test.ts](src/test/pipelineUtils.test.ts)) 22건: `normalizeEol` 6, `encodeFileContent` 6, `withTaskTimeout` 10 (race/cancel/no-op/swallowed-rejection 등).
- 통합 테스트 ([src/test/pipelineIntegration.test.ts](src/test/pipelineIntegration.test.ts)) IT-043 ~ IT-062 22건: writeFile/appendFile 14, continueOnError 3, timeoutSeconds 3 (실제 `sleep 10` 프로세스가 0.5초 budget으로 종료되는지까지 확인).

### 문서

- [docs/features.md](docs/features.md) §5에 `writeFile`/`appendFile` 섹션 + Task-level 옵션 (`timeoutSeconds`/`continueOnError`) 섹션 신설. 변수 치환 표에 `${task.path}` 추가.
- [docs/integration-tests.md](docs/integration-tests.md)에 writeFile/appendFile, continueOnError, timeoutSeconds 3개 표 추가 (IT-043 ~ IT-062).

## [0.4.11] - 2026-04-22

### 문서 — README 사이드바 스크린샷 크기 조정

- [README.md](README.md) 에서 sidebar-overview 이미지가 원본 650×1758 로 너무 길어 한 화면에 담기 힘들었던 문제 해결. HTML `<img width="300">` 으로 제한해 약 300×811 로 렌더링 (나머지 스크린샷은 GitHub 최대폭 900 기준 500~662 높이라 그대로 유지).

## [0.4.10] - 2026-04-22

### 개선 — 삭제된 파일을 가리키는 즐겨찾기 UX

- [src/extension.ts](src/extension.ts) `taskhub.openFavoriteFile` 에서 해석된 경로에 파일이 없으면 장문의 VS Code 원본 에러 대신 "즐겨찾기 파일을 찾을 수 없습니다: `<path>`" 한 줄과 **"즐겨찾기에서 제거"** 버튼을 제공. 버튼 클릭 시 `sourceFile` 의 favorites.json 에서 해당 항목만 제거하고 뷰 새로고침. Search Favorites 와 tree view 클릭 모두 동일 핸들러라 양쪽에 적용됨.
- [src/providers/favoriteViewProvider.ts](src/providers/favoriteViewProvider.ts) 에 `removeFavoriteByIdentity(favorites, target)` 순수 함수 추출. `taskhub.deleteFavorite` 와 새 stale-file 제거 경로가 동일한 식별 기준(path + line + title + group)을 공유하도록 DRY.

### 테스트

- IT-039 ~ IT-042 4 개 추가 ([src/test/viewProviderIntegration.test.ts](src/test/viewProviderIntegration.test.ts))
  - IT-039: 존재하지 않는 파일을 가리키는 항목만 제거되고 나머지는 group/tags 포함 원본 보존
  - IT-040: path+title 같고 line 다른 두 항목 중 target 만 제거
  - IT-041: 매칭 없는 target 은 no-op
  - IT-042: group 이 다르면 별개 항목으로 취급
- 전체 **846개 테스트 통과**.

### 문서

- [docs/integration-tests.md](docs/integration-tests.md) View Provider Integration 표에 IT-039 ~ IT-042 추가.

## [0.4.9] - 2026-04-22

### 문서 — README 스크린샷 섹션 추가

- [README.md](README.md) 에 "스크린샷" 섹션 신설. 사이드바 / Memory Map / Number Base Hover / Register Decoder Hover / SFR Bit Field Hover / JSON Editor / Hex Viewer 총 7개 기능을 이미지로 소개.
- [docs/images/](docs/images/) 디렉터리 추가 (문서 전용 리소스, `media/` 확장 리소스와 분리).
- [examples/sample_binary.bin](examples/sample_binary.bin) Hex Viewer 데모용 1 KB 샘플 바이너리 추가. 헤더(TASKHUB 매직) / ASCII 설명 / 문자열 테이블 / 0x00~0xFF 카운터 / 구조체 레코드 / 0xAA55 패턴 / 알파벳 필러로 구성되어 ASCII 컬럼과 16진 컬럼 모두 볼거리가 있도록 배치.

## [0.4.8] - 2026-04-22

### 변경 — 메인 패널 이름을 "Actions"로 변경

- [package.json](package.json) `mainView.main` 뷰의 표시 이름을 `Main` → `Actions` 로 변경. 내부 뷰 ID(`mainView.main`)와 클래스(`MainViewProvider`)는 사용자 settings/keybindings 호환성 위해 유지.
- 관련 문서에서 "메인 패널" 을 "Actions 패널" 로 일괄 갱신 ([README.md](README.md), [docs/features.md](docs/features.md)). TaskHub 활동 표시줄 컨테이너(`mainView`)를 가리키던 "메인 뷰" 는 그대로 유지.

## [0.4.7] - 2026-04-22

### 변경 — 기본 제공 링크 정비

- [media/links.json](media/links.json) Built-in Links 에서 "VS Code Docs" 를 제거하고 "Claude"(https://claude.ai/)와 "GitHub"(https://github.com) 를 추가.

## [0.4.6] - 2026-04-21

### 기능 — zip/unzip 내장 엔진 추가

- **`tool` 필드가 선택 사항으로 변경** — `zip`/`unzip` 태스크에서 `tool`을 생략하면 번들 내장 엔진(`adm-zip`, 순수 JS, MIT)이 `.zip` 아카이브를 처리합니다. 사용자 시스템에 7-Zip 등 외부 CLI가 없어도 기본 zip 동작이 가능. `tool`을 지정하면 기존처럼 해당 CLI를 `a/x` 인자 셰이프로 호출 (하위 호환 유지). [src/archiveUtils.ts](src/archiveUtils.ts) 신규, [src/extension.ts](src/extension.ts) `handleZip`/`handleUnzip` 분기 추가.
- **Zip-slip 방어** — 내장 unzip은 추출 전에 모든 엔트리의 해석된 경로가 대상 디렉터리 안에 있는지 검증하고, `../` 등으로 탈출을 시도하면 "Blocked path traversal" 에러로 중단.
- **`.zip` 외 확장자는 tool 필요** — 내장 엔진은 `.zip`만 지원. `.7z`·`.rar` 등을 사용하려면 `tool`을 명시하도록 명확한 에러 메시지로 안내.
- **Preview(Dry-run) 개선** — [src/previewRun.ts](src/previewRun.ts) 에서 `tool` 생략 시 "`tool: (built-in engine — .zip only)`" 로 표시.
- **JSON Schema 업데이트** — [schema/actions.schema.json](schema/actions.schema.json) 에서 zip/unzip의 `tool` required 제약 제거, 설명을 내장/외부 엔진 양쪽에 맞게 수정.

### 문서

- [docs/features.md](docs/features.md) zip/unzip 섹션을 내장 엔진 기준으로 재작성, 외부 tool 예시는 별도로 유지.
- [docs/integration-tests.md](docs/integration-tests.md) IT-025 의미 업데이트 + IT-035~038 신규 항목 추가.

### 테스트

- IT-025: 빌트인 엔진이 `.7z` 등 비-zip 확장자를 거부하는지 검증 (이전 "tool 미지정 에러" 케이스를 새 의미로 재작성).
- IT-035: 빌트인 zip ↔ 빌트인 unzip 왕복 후 파일 내용이 일치.
- IT-036: 디렉터리 source가 basename을 유지하며 재귀적으로 압축.
- IT-037: zip-slip 공격 아카이브가 추출 전에 거부되고 대상 밖에 파일이 생성되지 않음.
- IT-038: 내장 엔진 경로에서도 `${task_id.output}` 변수 치환이 적용됨.
- buildPreviewReport 에 내장 엔진 표기/외부 tool 경로 표기 분기 검증 3개 추가.
- 전체 **792개 테스트 통과**.

## [0.4.5] - 2026-04-20

### 기능 — 환경변수 보기 기본 액션 복구

- **신규 task type `envPick`** — [src/extension.ts](src/extension.ts) 에 `handleEnvPick` 추가. `process.env` 의 모든 이름을 정렬한 뒤 VS Code QuickPick 으로 노출하고, 선택된 이름을 `{ value }` 로 반환 (quickPick 과 동일 shape). 값은 picker 에 노출하지 않아 이름만으로 안전하게 탐색 가능. [src/schema.ts](src/schema.ts), [schema/actions.schema.json](schema/actions.schema.json) 의 task `type` enum 에 `envPick` 추가.
- **기본 액션 `Show Environment Variable` 복구** — [media/actions.json](media/actions.json) 에 추가. `envPick` 으로 전체 목록에서 선택 → `printenv NAME` / `cmd /c echo %NAME%` 로 **선택된 한 변수의 값만** 터미널에 출력. 0.4.4 에서 제거했던 전체 덤프 방식(`printenv` / `Get-ChildItem Env:`) 대신 의도한 변수 하나만 노출되므로 화면·로그 공유 상황의 credential 유출 위험은 유지.
- **기본 액션 `Show Environment Variable by Name` 추가** — [media/actions.json](media/actions.json) 에 `inputBox` 기반 액션 추가. ARM 툴체인 경로 등 목록에 없는 프로젝트 고유 변수명을 직접 입력해 값 확인 가능.

### 문서

- [docs/features.md](docs/features.md) 에 `envPick` 태스크 섹션 추가.
- [docs/architecture.md](docs/architecture.md) `executeSingleTask` 지원 태스크 타입 목록에 `envPick`, `confirm` 반영.
- [docs/integration-tests.md](docs/integration-tests.md) Interactive Task Pipeline 에 IT-033 / IT-034 추가.

### 테스트

- IT-033: `envPick` 이 `process.env` 전체 이름을 정렬해 노출하고, 선택된 이름이 downstream interpolation 으로 전달되는지 검증.
- IT-034: `envPick` 취소 시 파이프라인이 reject 되고 이후 task 가 실행되지 않는지 검증.
- 전체 **785개 테스트 통과**.

## [0.4.4] - 2026-04-19

### 보안 — 신뢰 경계 강화

- **Hover MarkdownString `isTrusted` 제거** — [src/numberBaseHoverProvider.ts](src/numberBaseHoverProvider.ts) 내 7개 hover 생성 경로에서 `md.isTrusted = true` 를 모두 제거. 소스 주석·SFR 설명·struct 멤버 이름 등 파일 유래 문자열이 markdown 에 그대로 들어가던 상황에서, 악성 주석이 `command:` URI 링크를 심어 VS Code 명령 실행으로 이어질 수 있는 경로를 차단.
- **외부 링크 URL scheme allowlist** — [src/pipelineUtils.ts](src/pipelineUtils.ts) 에 `validateLinkScheme()` 순수 함수 추가, `http`/`https`/`mailto` 만 허용하도록 제한. `taskhub.openLink` / `taskhub.goToLink` 가 이 검증을 거치도록 [src/extension.ts](src/extension.ts) 리팩터 — `command:`, `file:`, `vscode:`, `javascript:` 등 다른 scheme 은 에러 메시지 후 거부.
- **Favorite 파일 경로 워크스페이스 경계 검사** — `taskhub.openFavoriteFile` 이 [src/pipelineUtils.ts](src/pipelineUtils.ts) 의 신규 `resolveFavoriteFilePath()` 를 경유하도록 변경. `${workspaceFolder}/../secret.txt` 같은 traversal, 워크스페이스 밖 절대 경로, null byte 는 `resolveWithinWorkspace()` 로 reject.
- **기본 제공 `Show Environment Variables` action 제거** — [media/actions.json](media/actions.json) 에서 `printenv` / `Get-ChildItem Env:` 를 터미널에 그대로 출력하던 기본 버튼을 삭제. 화면 공유·로그 공유 상황에서 토큰·credential 유출 위험 감소.
- **Workspace Trust 명시** — [package.json](package.json) 에 `capabilities.untrustedWorkspaces: { "supported": false }` 추가. 신뢰할 수 없는 워크스페이스에서는 확장이 비활성으로 고정되어, 악성 `.vscode/actions.json` 이 shell 실행으로 이어지는 경로를 VS Code 레벨에서 차단.

### 테스트

- `validateLinkScheme` 14개, `resolveFavoriteFilePath` 6개, 총 **20개 테스트 추가** ([src/test/pipelineUtils.test.ts](src/test/pipelineUtils.test.ts)). 전체 **783개 테스트 통과**.

## [0.4.3] - 2026-04-17

### 테스트 — Integration Test 시나리오 확장 (Archive / Terminal / Lifecycle / Error)

- [docs/integration-tests.md](docs/integration-tests.md)의 시나리오 인덱스를 확장해 `Archive Task Pipeline`, `Terminal Output Mode`, `Action Lifecycle Messaging`, `Task Output Flow`, `Pipeline Error Handling` 그룹을 추가.
- [src/test/pipelineIntegration.test.ts](src/test/pipelineIntegration.test.ts)에 IT-024~IT-032 시나리오 추가:
  - `zip` → `unzip` 왕복에서 tool 호출 인자 셰이프가 실제로 동작하는지 node 기반 가짜 7z launcher로 검증하고, `tool` 누락 시 즉시 에러 나는 경로도 고정.
  - `output.mode: "terminal"`이 같은 actionId에서 터미널을 재사용하고 header/content 2라인을 순서대로 기록하는지 `createTerminal` stub으로 검증.
  - `executeAction`의 성공/실패 경로에서 `successMessage` / `failMessage` 표시, `actionStates` 전이, `HistoryProvider` entry running → success/failure 갱신이 한 실행에서 같이 동작하는지 검증 (이 목적을 위해 `executeAction`을 export).
  - `passTheResultToNextTask: false`일 때 downstream interpolation에서 `${task.output}`가 리터럴로 남는 현재 동작을 고정.
  - `basename`/`basenameWithoutExtension`/`stripExtension`/`dirname`/`extension` 다섯 `stringManipulation` 경로 함수가 한 파이프라인에서 교차 사용되는지 end-to-end 검증.
  - 지원하지 않는 task type, `shell`의 `command` 누락 같은 설정 에러가 실행 시 어떤 메시지로 중단되는지 고정.

### 내부

- `src/extension.ts`의 `executeAction`을 export로 변경 — lifecycle/메시지/history 통합 테스트에서 단일 진입점으로 직접 호출 가능.

### 테스트

- 전체 **763개 테스트 통과**.

## [0.4.1] - 2026-04-17

### 테스트 — Integration Test 시나리오 확장

- [docs/integration-tests.md](docs/integration-tests.md)의 시나리오 인덱스를 확장해 `Command Execution + Workspace Safety`, `Interactive Task Pipeline` 그룹을 추가.
- [src/test/pipelineIntegration.test.ts](src/test/pipelineIntegration.test.ts)에 IT-009~IT-017 시나리오 추가:
  - `args` / `cwd` / `env` interpolation이 실제 child process 실행에 반영되는지 검증.
  - workspace 밖 파일 출력 거부, 기존 파일 overwrite 보호, 문자열 기반 `overwrite` 평가 검증.
  - 실패한 shell task가 downstream 실행을 중단하는지 검증.
  - 상대 `output.filePath`가 action workspace 기준으로 해석되는지 검증.
  - `quickPick`, `inputBox`, `confirm` 등 interactive task가 파이프라인 변수 전달 및 취소 흐름과 함께 동작하는지 검증.

### 테스트

- 전체 **748개 테스트 통과**.

## [0.4.0] - 2026-04-17

### 기능 — Shell 출력 Parser + 파이프라인 Dry-run

**Output Parser (`output.capture`)**
- `shell`/`command`/`stringManipulation` 태스크의 문자열 출력에서 정규식 또는 라인 인덱스로 **원하는 값만 뽑아 변수화** 가능.
- 기존 `${id.output}`은 그대로 유지되며, 캡처된 값은 `${id.<name>}`으로 파생 변수로 추가됨 (옵트인, 비파괴).
- 지원: `regex`(+ `group`, `flags`), `line`(음수 인덱스로 끝에서부터), `trim`, 여러 규칙을 배열로 선언.
- 예약어(`output`, `path`, `value` 등)·중복 이름·잘못된 정규식은 즉시 에러.
- shell/command는 `passTheResultToNextTask: true`가 필요 (미설정 시 verbose 로그에 경고).

**Preview Run (Dry-run)**
- 액션 우클릭 → **Preview Run (Dry-run)** 또는 Command Palette: `TaskHub: Preview Run (Dry-run)`.
- 실행하지 않고 각 태스크의 command/cwd/env, `output.filePath` 해석값, 캡처 규칙, 워크스페이스 외부 쓰기 여부, 미해결 `${...}` 변수를 `TaskHub Preview` 출력 채널에 표시.
- 상류 태스크 결과는 `<fileDialog:id:path>` 같은 placeholder로 시뮬레이션되어 변수 연결을 눈으로 확인 가능.

**구현 세부**
- `applyOutputCapture()`: [src/pipelineUtils.ts](src/pipelineUtils.ts)에 추가된 순수 함수 (유닛 테스트 17개).
- `buildPreviewReport()`: [src/previewRun.ts](src/previewRun.ts)에 추가된 순수 함수 (유닛 테스트 10개).
- `executeSingleTask`는 태스크 실행 후 `output.capture`가 있으면 결과 객체에 캡처된 키를 merge.
- `Output.mode`를 선택적 필드로 변경 — `capture`만 사용하는 경우 `mode` 생략 가능.

**Preview Run 개선**
- `output.mode: "file"`에서 `overwrite`가 생략된 경우 `overwrite: false (default — write fails if target already exists)` 문구를 명시적으로 표시해, 덮어쓰기 실패 예상 시나리오가 한눈에 보이도록 함.
- `overwrite`가 문자열(`"${var}"`)로 선언되면 preview에서도 interpolate해 실제 truthy/falsy 결과를 함께 표시.

**Integration Test 시나리오 문서화**
- [docs/integration-tests.md](docs/integration-tests.md) 추가 — `IT-XXX` 네이밍 규칙, 시나리오 표, 추가 절차 수록.
- Output Capture 그룹 8개 시나리오 추가: 정규식 단일/배열 capture, line 인덱스, stringManipulation capture, capture miss, filePath interpolation, 예약어/잘못된 정규식 에러 경로. 실행: `npm run test` → 732 passing.

## [0.3.22] - 2026-04-17

### 성능 — 확장 활성화(activation) 경량화

이번 버전은 확장이 처음 활성화될 때 실행되는 작업을 줄여 **로딩 체감 시간을 단축**하는 데 초점을 맞췄습니다.

**활성화 트리거 명시 (hover 관련 동작 이슈 해결)**
- [package.json](package.json)에 `activationEvents`로 `onLanguage:c`, `onLanguage:cpp` 추가.
- 기존에는 VS Code 시작 후 사용자가 **H 아이콘(사이드바)** 을 눌러 TaskHub 뷰를 연 뒤에야 확장이 활성화되어, C/C++ 파일을 열어도 **NumberBase / SFR hover가 동작하지 않는** 문제가 있었음.
- 이제 C/C++ 파일을 여는 것만으로도 확장이 활성화되어 hover가 정상 동작함.

**Ajv 스키마 검증기 모듈 레벨 캐시**
- `actions.json` 스키마를 `Ajv.compile()`로 생성하는 비용을 **매 호출마다** 치르던 것을 제거. 첫 호출 시 한 번만 컴파일하고 재사용 ([extension.ts](src/extension.ts)).
- 영향: `loadAllActions()`, `parseImportData()` 등 액션을 읽는 모든 경로.

**`loadAllActions()` 결과 캐시 + watcher 기반 invalidation**
- 액션 트리 렌더링·액션 실행·export 등에서 반복적으로 호출되던 `loadAllActions()`가 이제 캐시된 결과를 반환.
- 캐시는 다음 시점에만 무효화됨:
  - `.vscode/actions.json` 변경 (파일 watcher)
  - `media/actions.json` 변경 (개발 모드 한정)
  - `taskhub.preset.selected` 설정 변경
  - 액션 생성 wizard / 프리셋 적용 / import 등 쓰기 동작 직후
- 외부 사용을 위해 `invalidateActionsCache()`를 export.

**Provider 생성자의 동기 JSON 로드 제거 + activate()의 eager refresh 제거**
- [LinkViewProvider](src/providers/linkViewProvider.ts)·[FavoriteViewProvider](src/providers/favoriteViewProvider.ts) 생성자가 즉시 JSON을 읽던 동작을 제거.
- 추가로 activate() 초반의 즉시 `refresh()` 4건(링크·즐겨찾기·히스토리·내장 링크)을 제거하여, **사이드바를 한 번도 열지 않는 경우 JSON을 전혀 읽지 않도록** 함. 이로써 `onLanguage:c` / `onLanguage:cpp` 활성화 경로가 실제로 경량화됨.
- 각 Provider에 `loaded: boolean` 플래그를 도입. `ensureCache()`가 "빈 배열 = 미로드"로 착각해 매번 재읽기하던 미묘한 버그도 함께 해결.
- 첫 `getChildren()` 호출 시점에 `updateTitle()`도 수행하여, 사이드바를 열었을 때 뷰 타이틀 카운트가 즉시 표시됨.

**프리셋 저장 후 액션 캐시 무효화 누락 수정**
- `taskhub.saveAsPreset` 커맨드가 파일을 덮어쓴 뒤에도 `invalidateActionsCache()`를 호출하지 않아, 현재 선택된 프리셋을 저장해 덮어쓴 경우 이후 액션 실행/뷰 갱신이 이전 프리셋 내용을 보는 문제가 있었음. 저장 직후 캐시를 무효화하고 Main 뷰를 새로고침하도록 수정.

**`package.json` 반복 디스크 읽기 제거**
- [MainViewProvider.getChildren()](src/providers/mainViewProvider.ts)이 렌더링할 때마다 `package.json`을 `readFileSync`로 읽던 부분을 제거.
- `taskhub.showVersion` 커맨드도 동일하게 수정.
- 이제 VS Code가 제공하는 `context.extension.packageJSON.version`을 사용.

**번들된 `media/*.json` watcher는 개발 모드 전용**
- 설치된 확장의 `media/actions.json`, `media/links.json`은 런타임에 바뀌지 않으므로, 프로덕션에서는 `FileSystemWatcher` 두 개를 더 이상 만들지 않음.
- 개발 시(`ExtensionMode.Development`)에만 watcher 등록.

**기타 정리**
- activate() 초입의 디버그 `console.log` 제거.

### 테스트

- 신규 테스트 12개 추가.
  - `getActionsValidator` 모듈 레벨 캐시 / 유효·무효 입력 검증.
  - `invalidateActionsCache` 함수 시그니처 / 반복 호출.
  - Provider의 `loaded` 플래그 + `cachedEntries/cachedFavorites` 초기값 검증 (회귀 방지: 생성자가 eager load를 다시 추가해도 `loaded=false` 검사에서 실패).
  - `refresh()` 및 `getChildren()`의 지연 로드 경로 전이.
- 전체 **696개 테스트 통과**.

## [0.3.21] - 2026-04-17

### Changed

**`extension.ts` 모듈 분리 2단계 — HistoryProvider 추출 (완료)**
- 신규 모듈 [src/providers/historyProvider.ts](src/providers/historyProvider.ts) 추가. `HistoryProvider`, `HistoryItem`, `HistoryEntry`를 이동.
- `extension.ts`는 위 심볼들을 re-export하므로 기존 `import { ... } from './extension'` 호출부는 변경 없이 동작.
- `extension.ts` 크기 3,376줄 → 3,262줄 (-114줄).
- 2단계 전체 결과: `extension.ts` 3,809줄 → 3,262줄 (-547줄 / -14.4%). 4개의 TreeDataProvider 및 관련 유틸리티가 [src/providers/](src/providers/) 하위로 이동.

### 테스트

- 전체 **684개 테스트 통과**.

## [0.3.20] - 2026-04-17

### Changed

**`extension.ts` 모듈 분리 2단계 — FavoriteViewProvider 추출**
- 신규 모듈 [src/providers/favoriteViewProvider.ts](src/providers/favoriteViewProvider.ts) 추가. `FavoriteViewProvider`, `FavoriteGroup`, `Favorite`, `FavoriteEntry`, `FavoriteTreeNode`, `loadFavoritesFromDisk`를 이동.
- `extension.ts`는 위 심볼들을 re-export하므로 기존 `import { ... } from './extension'` 호출부는 변경 없이 동작.
- `extension.ts` 크기 3,567줄 → 3,376줄 (-191줄).

### 테스트

- 전체 **684개 테스트 통과**.

## [0.3.19] - 2026-04-17

### Changed

**`extension.ts` 모듈 분리 2단계 — LinkViewProvider 추출**
- 신규 모듈 [src/providers/linkViewProvider.ts](src/providers/linkViewProvider.ts) 추가. `LinkViewProvider`, `LinkGroup`, `Link`, `LinkEntry`, `LinkTreeNode`, `loadLinksFromDisk`를 이동.
- 신규 모듈 [src/providers/normalization.ts](src/providers/normalization.ts) 추가. `extension.ts`와 Provider 간의 순환 import를 막기 위해 `normalizeTags`, `normalizeLineNumber`를 이곳으로 이동.
- `extension.ts`는 위 심볼들을 re-export하므로 기존 `import { ... } from './extension'` 호출부(테스트 포함)는 변경 없이 동작.
- `extension.ts` 크기 3,741줄 → 3,567줄 (-174줄).

### 테스트

- 전체 **684개 테스트 통과**.

## [0.3.18] - 2026-04-17

### Changed

**`extension.ts` 모듈 분리 2단계 — MainViewProvider 추출**
- 신규 모듈 [src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts) 추가. `MainViewProvider`, `Folder`, `Action` 클래스를 이동.
- 신규 모듈 [src/providers/actionStatus.ts](src/providers/actionStatus.ts) 추가. `Action` TreeItem과 `extension.ts`의 실행 엔진이 공유하는 `actionStates` 맵을 담아 순환 import를 방지.
- `MainViewProvider` 생성자는 `loadActions: () => ActionItem[]` 콜백을 받도록 변경. 기존 `loadAllActions(context)` 연동은 `activate()`에서 `() => loadAllActions(context)`를 전달해 그대로 유지.
- `extension.ts`는 `MainViewProvider`, `Folder`, `Action`, `actionStates`를 re-export하므로 기존 `import { ... } from './extension'` 호출부(테스트 포함)는 변경 없이 동작.
- `extension.ts` 크기 3,809줄 → 3,741줄 (-68줄).

### 테스트

- 전체 **684개 테스트 통과**.

## [0.3.17] - 2026-04-17

### Changed

**`extension.ts` 순수 유틸리티 함수 분리 (1단계)**
- 신규 모듈 [src/pipelineUtils.ts](src/pipelineUtils.ts) 추가. vscode API 의존성이 없는 13개 함수/상수를 이동:
  `INTERPOLATED_VALUE_MAX_LENGTH`, `resolveWithinWorkspace`, `sanitizeInterpolatedValue`, `interpolatePipelineVariables`, `getCommandString`, `getToolCommand`, `tokenizeCommandLine`, `mergeCommandAndArgs`, `quotePowerShellArgument`, `buildPowerShellInvocation`, `encodePowerShellScript`, `quotePosixArgument`, `buildPosixCommandLine`.
- `extension.ts`는 이들을 import → re-export하므로 기존 `import { ... } from '../extension'` 호출부(테스트 포함)는 변경 없이 동작.
- `extension.ts` 크기 3,967줄 → 3,809줄 (-158줄). 모듈 분리의 첫 단계로, 남은 TreeDataProvider/task handler/command 등록 분리는 별도 PR에서 진행 예정.

### 테스트

- `src/test/pipelineUtils.test.ts` 신설: `../pipelineUtils`에서 직접 import하여 vscode 모듈에 대한 숨겨진 의존성이 없음을 보장하는 13개 스모크 테스트.
- 전체 **684개 테스트 통과**.

## [0.3.16] - 2026-04-17

### Improved

**Hover 경로에서 동기 파일 IO 제거**
- `NumberBaseHoverProvider.loadTypeConfig`가 `fs.statSync`/`fs.readFileSync`/`fs.realpathSync`에서 `fs.promises.*` 비동기 API로 전환.
- `tryStructSizeInfo`가 `async`로 승격되고 `provideHoverImpl`에서 `await`로 호출.
- 네트워크 드라이브/FUSE 마운트 등 느린 스토리지에서도 hover 호출이 extension host 이벤트 루프를 블로킹하지 않음.
- LRU 캐시/`withLspTimeout`/`activeHoverCalls` 재진입 가드는 그대로 유지.

## [0.3.15] - 2026-04-17

### Improved

**파서 에러 처리 계약 명확화**
- `linkerScriptParser.ts`의 모듈-레벨 주석에 에러 처리 계약(throw 안 함, malformed → 빈 배열) 명시.
- 새로운 `parseLinkerFileWithDiagnostics(content, filePath): { regions, warnings[] }` 함수 추가. 기존 `parseLinkerFile`은 유지하되, "왜 빈 결과인가?"를 알고 싶은 호출자는 diagnostics 버전을 사용할 수 있음. 경고 케이스:
  - 빈 입력
  - `.ld` 파일에 `MEMORY { ... }` 블록 없음
  - `MEMORY` 블록은 있으나 region 라인이 매칭되지 않음
  - `.sct` 파일에 execution region 없음 (load region만 있음)
- `registerDecoder.ts`의 `parseRegisterFromStruct` JSDoc 강화: `null`이 "파싱 실패"인지 "bit field가 없음"인지 구별 불가하다는 한계를 명시.

### 테스트

- `parseLinkerFileWithDiagnostics`에 대한 5개 시나리오 테스트 추가 (empty/no MEMORY/empty block/no exec region/정상 매칭).
- 전체 **671개 테스트 통과**.

## [0.3.14] - 2026-04-17

### Fixed

**i18n 누락 보정**
- `loadWizardActionSources` 실패 시 `error.message` 원문만 노출되던 에러 다이얼로그를 "액션 소스를 불러오지 못했습니다" 컨텍스트 prefix와 함께 한국어/영어 이중화 ([extension.ts:1046](src/extension.ts#L1046)).
- `loadAllActions` 실패 케이스에도 동일한 방식으로 컨텍스트 prefix + i18n 적용 ([extension.ts:1091](src/extension.ts#L1091)).
- `handleConfirm`의 기본 confirm 메시지("Are you sure you want to continue?")를 한국어 로캘에서 "계속 진행하시겠습니까?"로 표시. `task.message`가 주어지면 기존대로 사용자 값을 그대로 사용 (CLAUDE.md의 i18n 예외 규칙 준수).
- `numberBaseHoverProvider`의 Hex/Dec/Bin/Alignment 등 짧은 기술 식별자는 CLAUDE.md 예외 조항("패널 제목 등 짧은 영어 식별자")에 해당하므로 영어 유지.

### 테스트

- `src/test/i18n.test.ts` 신설: `t()` 함수의 반환 분기, 템플릿 리터럴 보존, 빈 문자열 처리 4개 케이스.
- 전체 **666개 테스트 통과**.

## [0.3.13] - 2026-04-17

### Fixed (2차 리뷰 반영)

- **Memory Map 컨트롤 CSP 호환성**
  - Region 확장/접기, Expand All/Collapse All, Function 컬럼 토글, Object Summary 컨트롤이 인라인 `onclick`으로 연결되어 있어 v0.3.12의 CSP(`script-src 'nonce-…'`)에서 차단되던 문제 수정.
  - 모든 인라인 핸들러를 제거하고 `data-action` 속성 + nonce 스크립트 내 위임(delegated) 클릭 리스너로 전환.
- **HEX/SREC sparse 주소 범위 보호**
  - `hexParser`의 엔트리 수 cap은 통과하지만 극단적으로 떨어진 두 주소(예: 0, 0x20000000)만 포함된 파일이 멀티-GB `flat/gap buffer`를 강제 할당하는 문제 수정.
  - `buildHexViewerHtml`에 `HEX_VIEWER_MAX_SPAN = 128 MB` 상한 및 명시적 에러 메시지 추가. openPanel/HexEditorProvider 두 진입점 모두 try/catch로 안전 처리.
- **상대 `output.filePath`의 워크스페이스 기준 resolve**
  - `resolveWithinWorkspace(targetPath, roots, baseDir?)` 시그니처에 `baseDir` 추가. 상대 경로는 `process.cwd()`가 아니라 태스크의 워크스페이스 폴더(`defaultWorkspace`) 기준으로 resolve됨.
  - 기존 `"filePath": "report.txt"` 같은 설정이 VS Code 실행 cwd에 따라 예측 불가하게 작동하던 회귀를 차단.
  - 회귀 테스트 4종 추가 (상대 경로/서브 경로/`..` 탈출/baseDir 생략 시 첫 루트 fallback).
- **CSP nonce 생성기를 CSPRNG로 전환**
  - `hexViewer`, `jsonEditor`, `memoryMapViewer` 세 곳의 nonce를 `Math.random()` 기반에서 `crypto.randomBytes(16).toString('base64')`로 교체.

### 테스트

- `resolveWithinWorkspace` 상대 경로 관련 회귀 테스트 4종 추가.
- `buildHexViewerHtml` sparse 범위 거부 테스트 추가.
- 전체 **662개 테스트 통과**.

## [0.3.12] - 2026-04-17

### Security

**파이프라인 변수 치환 강화 (`interpolatePipelineVariables`)**
- 치환 값의 null 바이트(`\0`) 삽입을 차단 (쉘 인자 조기 종료 방지)
- 치환 값 최대 길이 32KB 제한 (메모리/명령 길이 보호)
- 오브젝트/배열은 치환 대신 placeholder 원형 유지 (`${...}` 그대로)
- `sanitizeInterpolatedValue` 함수 export로 단위 테스트 가능

**작업 출력 파일의 경로 탈출 방지**
- Task output mode `file`에서 사용자 JSON 및 `${var}` 치환 결과를 쓰기 전에 워크스페이스 루트 내부인지 검증
- `resolveWithinWorkspace(targetPath, roots)` 추가 — path.resolve 후 path.relative 검사
- 워크스페이스 외부로 향하는 경로는 거부

### 성능/견고성 (파서)

- `elfParser`: ELF32 헤더 최소 크기(52B) 사전 가드, `read16`/`read32` 범위 검증, section header 테이블 초과 검증, `shStrNdx` 범위 검증
- `hexParser`: Intel HEX/SREC에 `HEX_MAX_BYTE_ENTRIES`(100M) 상한 및 레코드당 최대 255바이트 제한 추가 — 악의적 파일로 인한 메모리 폭주 방지
- `macroExpander`: shift 카운트를 0–63 범위로 clamp, 4KB를 초과하는 수식은 null 반환
- `structSizeCalculator`: `calculatePadding`에서 alignment=0/음수일 때 무한 루프 방지 (0 리턴)

### 성능/안정성 (Hover)

- `NumberBaseHoverProvider`: 모든 LSP 명령(`executeDefinitionProvider`, `executeHoverProvider`, `executeWorkspaceSymbolProvider`)을 공통 `withLspTimeout(3s)`로 래핑 — UI 프리징 방지
- 재귀 방지 플래그 `isProcessingHover`를 `activeHoverCalls: Set<string>`(uri+position 기준)으로 재설계 — 다중 hover 이벤트 경합 제거
- 10,000자를 초과하는 라인은 hover 스킵 (정규식 ReDoS/성능 보호)
- `taskhub_types.json` 캐시에 LRU 한도(16개) + `fs.realpath` 정규화 + 파싱 실패 시 마지막 정상 설정 재사용

### 성능/안정성 (WebView)

- `hexViewer`, `jsonEditor`, `memoryMapViewer` 3개 WebView 전체에 **CSP(Content-Security-Policy) + nonce 기반 스크립트** 도입
  - `default-src 'none'; script-src 'nonce-<...>'; style-src <cspSource> 'unsafe-inline'; img-src <cspSource> data:; font-src <cspSource>;`
  - 외부 리소스/인라인 스크립트 주입 경로 차단
- `hexViewer`의 에러 HTML 출력에서 파일명·메시지 삽입을 `escapeHtml`(=`esc`) 경유로 전환 (XSS 방어)
- Memory Map 검색: 이전 쿼리가 새 쿼리의 접두사인 경우 필터 결과 재사용 (증분 검색)
- Workspace folder 변경 핸들러에 150ms debounce 추가 — 짧은 시간 내 다중 이벤트로 watcher 중복/누수 방지

### 테스트

- `interpolatePipelineVariables` 및 `sanitizeInterpolatedValue`에 null byte/길이 제한/타입 검증 테스트 추가
- `resolveWithinWorkspace` 다중 루트·traversal·null byte 케이스 테스트 추가
- `elfParser`에 too-small 버퍼 / 잘못된 매직 넘버 방어 테스트 추가
- `hexParser`에 CSP+nonce 출력 검증 및 잘못된 byteCount 무시 테스트 추가
- `structSizeCalculator`에 alignment=0 regression 테스트 추가
- `macroExpander`에 shift clamp 및 초대형 수식 테스트 추가
- **전체 657개 테스트 통과**

## [0.3.11] - 2026-04-17

### Fixed

**Number Base Hover: enum 식별자/수식 기반 할당 해석 추가**
- `NAME = OTHER` 형태 식별자 참조 할당 지원 (예: `Test_Invalid = Test_Max`)
- `NAME = OTHER - 1`, `NAME = BASE + 5`, `NAME = 1 << 4` 등 단순 이항 수식 지원 (`+ - * / | & ^ << >>`)
- 괄호 `( EXPR )` 1단계 지원
- 라인 내 `// ...` 및 단일 라인 `/* ... */` 주석 제거하여 파싱 안정성 향상
- 이전 버전에서는 식별자 RHS가 매치되지 않아 `Test_Invalid`, `Test_Dummy` 같은 항목이 `<error-constant>` 로 표시되던 문제 해결

## [0.3.10] - 2026-04-17

### Fixed

**Number Base Hover: 대형 enum 암묵값 추출 실패 해결**
- C/C++ IntelliSense가 90번째 근처부터 `<error-constant>` 를 반환하는 문제에 대한 TaskHub 폴백 강화
- `extractEnumValue` 의 100줄 고정 스캔 제한 제거 → enum 본문의 닫는 `}` 까지 끝까지 스캔
- enum 선언 상향 탐색의 100줄 제한 제거 → 스코프 경계(`}` / `};`)까지 탐색
- 항목이 수백 개인 enum에서도 암묵값(A=0, B, C, ...) 표시 정상 동작

## [0.3.9] - 2026-04-07

### Improved

**Memory Map: 다중 패널 지원**
- 서로 다른 파일을 열면 각각 별도의 WebView 탭으로 표시 (기존: 1개만 열림)
- 동일 파일명이라도 경로가 다르면 독립 패널로 열림
- 같은 파일을 다시 열면 기존 패널을 재사용
- Go to Symbol (`Ctrl+Shift+O`)은 마지막으로 활성화된 패널 기준으로 동작

### Fixed

- `tsconfig.json`에 `types: ["node", "mocha"]` 명시하여 IDE에서 `fs`, `Buffer` 타입 인식 오류 해결

## [0.3.8] - 2026-04-07

### Improved

**Memory Map: 대용량 Listing 성능 개선**
- Region 상세 테이블을 Lazy Rendering 방식으로 변경: 펼칠 때만 DOM 생성
- 200행 초과 테이블에 Virtual Scrolling 적용: 보이는 영역만 렌더링하여 스크롤 버벅임 해소
- 검색/정렬을 JSON 데이터 기반으로 변경하여 DOM 전체 순회 제거

### Fixed

- 스크롤 맨 위로(↑) 버튼이 표시되지 않던 문제 수정 (DOM 순서 조정)
- 맨 위로 버튼 화살표가 중앙 정렬되지 않던 문제 수정 (flexbox 적용)
- Copy Report / Save HTML 버튼 간격 추가

### Added

- 대용량 ARM Linker Listing 예제 파일 추가 (`examples/sample_armlink_large.txt`, 1,935 엔트리)

## [0.3.7] - 2026-04-07

### Fixed

**Memory Map: ARM Linker Listing 함수명 추출 및 End 주소 표기 수정**
- 괄호 없는 오브젝트 형식(`7957 .text._ZL16CheckTestFunctionEv TestMgr.o`) 파싱 시 함수명이 추출되지 않던 버그 수정
  - 마지막 토큰이 `.o`인 경우 object로 인식하고, 그 앞의 섹션 토큰에서 함수명을 추출하도록 개선
- End 주소를 exclusive(`addr + size`)에서 inclusive(`addr + size - 1`)로 변경
  - 예: addr=0x1000, size=4 → End: ~~0x1004~~ → 0x1003
  - Region Details, Object Summary, Section Summary, 텍스트 리포트 모두 반영

## [0.3.6] - 2026-04-07

### Enhanced

**UI 개선: 버전 클릭 → Changelog, 예제 JSON 버튼 이동**
- 메인 패널 버전 항목 클릭 시 CHANGELOG.md를 열도록 변경
- 예제 JSON 보기 버튼을 패널 제목 표시줄의 전구(💡) 아이콘으로 이동하여 발견성 개선

**예제 JSON 보강**
- `command` 타입 예제 추가 (VS Code 빌트인 명령 실행)
- `confirm` 타입 예제 추가 (확인 대화상자)
- `shell` 타입에 `env`, `cwd`, `args` 속성 예제 추가
- `fileDialog`의 모든 출력 변수 (`path`, `dir`, `name`, `fileNameOnly`, `fileExt`) 예제 추가
- `folderDialog`에 `title` 옵션 예제 추가
- `inputBox`의 `password` 속성 예제 추가
- `stringManipulation`의 누락된 함수 5개 (`extension`, `stripExtension`, `toLowerCase`, `toUpperCase`, `trim`) 예제 추가
- Complete Example에 `confirm` 단계 추가

## [0.3.5] - 2026-04-06

### Added

**Memory Map: HTML 저장 기능**
- Memory Map 패널 상단에 "Save HTML" 버튼 추가
- 현재 화면 상태(펼침/접기, 검색 필터 등)를 그대로 standalone HTML 파일로 저장
- 저장된 파일은 브라우저에서 바로 열 수 있어 팀 공유 및 보관 용도로 활용 가능

## [0.3.4] - 2026-04-03

### Fixed

**Memory Map: Region 내 Section/Function/Object 중복 표시 수정**
- Object Summary 상세 행에서 Section 컬럼이 Object 이름과 동일하게 표시되던 버그 수정 (section 필드 우선 표시로 변경)
- ARM 링커 리스팅 파서에서 알 수 없는 prefix의 토큰이 section과 func에 동일하게 설정되던 버그 수정
- `.mysection.FuncName` 형식의 미등록 prefix도 함수명 추출 지원 (두 번째 `.` 이후 추출)

## [0.3.3] - 2026-04-03

### Enhanced

**Memory Map: Region Details UI 개선**
- Region Details 테이블에 Section 컬럼 복원 (Function 토글로 Section/Function 함께 표시/숨김)
- Region Details 테이블에 End Address 컬럼 복원
- Object Summary를 그래프 바 아래로 이동, 기본 접힘 상태로 변경 (클릭으로 펼침/접기)
- Object Summary Details 버튼: 오브젝트별 섹션 상세(Section, Address, End, Size, Type) 행 표시
- Details 버튼 크기를 다른 버튼과 통일

### Fixed

**테이블 정렬 개선**
- Size/Bytes/% 컬럼 첫 클릭 시 내림차순으로 정렬 (이후 토글)
- Object Summary 상세 행이 정렬에 영향을 주지 않도록 수정
- CSS로 숨긴 상세 행의 토글이 동작하지 않던 버그 수정 (getComputedStyle 사용)

## [0.3.2] - 2026-04-03

### Enhanced

**Memory Map: AXF/ELF 심볼 기반 상세 분석**
- ELF 프로그램 헤더(PT_LOAD)로 메모리 리전 자동 감지 — 링커 스크립트 없이도 FLASH/RAM 영역 표시
- ELF 심볼 테이블(.symtab) 파싱으로 함수/변수 단위 크기 분석
- 링커 스크립트 없이 AXF 파일만으로도 리전별 사용량, Free Space 확인 가능

**Memory Map: Region별 오브젝트 요약**
- 각 Region Details 내부에 오브젝트(.o)별 크기 집계 및 해당 region 내 점유율(%) 표시
- Code/RO/RW/ZI 분류별 크기 세부 표시 (Details 토글, region 단위 독립 동작)

**Memory Map: 함수명 추출 및 표시**
- armlink listing 파서가 섹션 토큰에서 함수명 추출 (`.text._ZN4Func` → `_ZN4Func`)
- Region Details 테이블에 Function 컬럼 추가 (토글 버튼으로 표시/숨김)
- 테이블 메인 컬럼을 Object로 변경하여 오브젝트 파일명 표시

## [0.3.0] - 2026-04-02

### Added

**다국어 지원 (i18n)**
- VS Code 언어 설정에 따라 한국어/영어 메시지 자동 전환
- `src/i18n.ts` 모듈 추가: `t(ko, en)` 헬퍼 함수
- 모든 Viewer 및 extension.ts의 사용자 대면 메시지 적용

### Fixed

**WebView 패널 메시지 핸들러 중복 등록**
- JSON Editor, Hex Viewer, Memory Map에서 패널 재사용 시 이전 핸들러를 dispose 후 새로 등록하도록 수정
- 다른 파일 저장 시 이전 파일에 덮어쓸 수 있던 버그 수정

**프리셋 자동 적용 시 중복 ID 처리**
- workspace/preset 간 중복 action ID가 있을 때 전체 로딩 실패 대신 경고 로그로 변경

**구조체 크기 계산 개선**
- `char *ptr;`, `int *p;` 스타일 포인터 멤버 파싱 지원
- Forward reference 해결: 미등록 타입 참조 시 multi-pass로 재시도, 최종 fallback 처리

**Import 검증 강화**
- Import 파일 내부의 중복 action ID 사전 검증 추가

### Enhanced

**Viewer 에러 메시지 개선**
- 파일 크기 제한 추가 (Hex Viewer: 50MB, Memory Map: 100MB, JSON Editor: 10MB)
- 파싱 오류, 파일 읽기 실패 등 상세 에러 메시지 표시

## [0.2.52] - 2026-04-02

### Fixed

**Memory Map Free Space 계산 개선**
- Free space 계산 버그 수정: 섹션 겹침 시 cursor 역행으로 free 영역이 부풀려지던 문제 해결
- Alignment padding (1~3바이트) free space를 Calc Free 및 세그먼트 레이아웃 바에서 제외
- Used 계산을 실제 점유 영역 기반으로 변경: 섹션 겹침/경계 초과 시에도 used + free ≤ max 보장
- Size 컬럼 정렬 시 단위(B/KB/MB)를 고려한 실제 바이트 크기 기준 정렬
- 세그먼트 레이아웃 바의 화면 폭 축소 시 free/used 비율 왜곡 수정 (border → gap, min-width 제거)

### Enhanced

**Memory Map 시각화 UX 개선**
- AXF/ELF와 ARM Linker Listing 파싱 결과 화면 통일: Overview 테이블 컬럼 구조 및 Region 헤더 포맷 일관성 확보
- Region 요약 테이블 row 클릭 시 해당 Region Details로 스크롤 및 자동 펼침
- Region Details 내 섹션 테이블에 컬럼 정렬 기능 추가 (Section, Address, Size, Bytes, Type)
- Region 이름 왼쪽 정렬로 변경
- AXF/ELF 파싱 시 데이터 한계 안내 메시지 표시
- Floating 맨 위로 이동 버튼 추가 (스크롤 200px 이상 시 표시)

## [0.2.50] - 2026-04-02

### Fixed

**Hex Viewer 대용량 파일 지원**
- 바이너리 파일 포맷 오감지 수정: SREC 정규식 multiline 플래그로 인해 대용량 바이너리가 SREC로 오인되는 버그 수정
- Virtual scrolling 적용: 패딩 행(spacer tr) 방식으로 화면에 보이는 행만 렌더링하여 대용량 파일에서 WebView 응답 없음 문제 해결
- 바이너리 파싱 최적화: Map 대신 Uint8Array 사용으로 16MB+ 파일의 Map 크기 초과 오류 해결

## [0.2.47] - 2026-04-01

### Added

**Hex Viewer**
- `TaskHub: Open Hex Viewer` 명령어로 펌웨어 이미지 파일을 Hex dump로 표시
- Intel HEX (`.hex`), Motorola SREC (`.srec`, `.s19`), Raw Binary (`.bin`) 포맷 자동 감지
- Unit 크기 옵션: 1/2/4/8바이트 단위로 표시 전환
- Little-Endian / Big-Endian 전환
- Hex 바이트 패턴 검색 (`Ctrl+F`), Go to Address
- 바이트 선택 시 상태바에 u8/u16/u32 값 해석 표시
- Gap 영역 (데이터 없는 주소) 회색 표시

### Testing
- `hexParser` 유닛 테스트 추가 (Intel HEX, SREC, Binary, toFlatArray, hasData)

## [0.2.46] - 2026-04-01

### Enhanced

**액션 Import/Export UX 개선**
- 메인 패널에서 액션/폴더 우클릭 → "Export Action" 컨텍스트 메뉴 추가 (개별 내보내기)
- 메인 패널 타이틀바에 Import 아이콘 추가 (빠른 접근)
- Import 후 메인 뷰 자동 새로고침

### Testing
- `countActionItems` 유닛 테스트 추가 (단일 액션, 폴더, 중첩 폴더, 빈 폴더)

## [0.2.45] - 2026-04-01

### Enhanced

**Memory Map UI 개선**
- Overview 테이블: Used/Calc Used, Free/Calc Free 컬럼 분리로 링커 보고값과 계산값 명확히 구분
- Region Details: Linker Free / Calc Free 구분 표시
- `Ctrl+Shift+O`: section 대신 region 단위로 이동하도록 변경
- Expand All / Collapse All 버튼 추가
- Flash/RAM 요약 카드 제거 (Overview 테이블로 대체)

## [0.2.44] - 2026-04-01

### Added

**Memory Map 검색 및 탐색 기능**
- 키워드 검색: 섹션 이름, 주소, 타입으로 전체 테이블 필터링 (접힌 region 내부도 검색, 매치 시 자동 펼침)
- `Ctrl+Shift+O` 심볼 검색: VS Code QuickPick으로 region 목록 표시 후 해당 위치로 스크롤
- Region 요약 테이블: 상단에 각 region별 Base, Max, Used, Free, Usage 한눈에 표시

### Enhanced

**Memory Map 표시 개선**
- Region 폴딩: 기본 접힘 상태, 클릭으로 토글 (헤더 + 사용률 바는 항상 표시)
- Linker/Calc 값 구분 표시: listing 파일의 Base, Size, Max 원본 값과 직접 계산한 Used, Free 값을 구분
- Overview 테이블에 Linker Size / Calc Used 컬럼 분리 (listing 파일일 때)

### Fixed

**Listing 파일 메모리 사용량 계산 오류 수정**
- 주소 범위 매칭 대신 execution region 소속 기반으로 계산하여 region 간 중복 집계 해소
- 괄호 없는 엔트리(예: `Region$$Table`) 섹션 이름 추출 개선

## [0.2.43] - 2026-04-01

### Added

**ARM Linker Listing 파서**
- `armlink --list` 출력 파일(`*_axf_link.txt`) 파싱 지원
- ARM Compiler 5 (armcc) / ARM Compiler 6 (armclang) 포맷 모두 지원
- Execution Region에서 메모리 영역 크기 자동 추출 (별도 링커 스크립트 불필요)
- 섹션별 집계 및 오브젝트 파일별 기여도 표시

### Enhanced

**Memory Map Free Space 표시**
- 메모리 영역 내 빈 공간(Free Space) 시각화
- 세그먼트 레이아웃 바: 섹션별 색상 블록 + Free Space 표시
- 영역 카드 테이블에 Address, Type 컬럼 추가, 주소순 정렬
- 영역 헤더에 Free 크기 표시
- 텍스트 리포트에 Free Space 정보 포함

**커밋 전 체크리스트 강화**
- 유닛 테스트 실행 필수화 (CLAUDE.md, CONTRIBUTING.md)
- 기능 변경 시 관련 문서 업데이트 가이드 추가

## [0.2.42] - 2026-03-31

### Added

**Memory Map 시각화**
- ARM `.axf`/`.elf` 바이너리의 메모리 사용량을 WebView에서 시각화
- ELF32 바이너리 직접 파싱 (외부 도구 불필요)
- Flash/RAM 사용률 바 차트, 섹션별 상세 정보 표시
- `.vscode/taskhub_types.json`의 `memoryMap.regions`로 메모리 영역 크기 설정
- GNU 링커 스크립트(`.ld`) 및 ARM Scatter File(`.sct`) 자동 파싱으로 메모리 영역 감지
- Cortex-R/M 시리즈 지원 (Little/Big Endian)

### Enhanced

**JSON 에디터 개선**
- 최상위 배열 형식(actions.json 등) 파일 지원
- 중첩 객체를 JSON 텍스트로 편집 가능
- 객체 배열 미리보기 개선 (`{ key1, key2, ... }` 형식)
- 불필요한 변환 버튼(`s→a`, `a→s`) 제거
- 빈 셀 클릭 시 잘못된 Modified 표시 버그 수정
- 우클릭 메뉴에서 "TaskHub:" 접두사 제거

## [0.2.40] - 2026-03-31

### Added

**`confirm` 태스크 타입**
- 파이프라인 실행 중 사용자 확인 대화상자를 표시하는 새 태스크 타입 추가
- `message`, `confirmLabel`, `cancelLabel` 속성 지원
- 변수 치환(`${...}`) 지원으로 동적 메시지 구성 가능
- 취소 시 파이프라인 실행을 안전하게 중단

**액션 Import/Export**
- `TaskHub: Export Actions` 명령어로 워크스페이스 액션을 `.taskhub` 파일로 내보내기
- `TaskHub: Import Actions` 명령어로 외부 파일에서 액션 가져오기
- `.taskhub` 형식과 raw `actions.json` 배열 형식 모두 지원
- 가져오기 시 ID 중복 검사 및 스키마 유효성 검증
- 팀원 간 액션 공유, 백업, 프로젝트 간 이동에 활용

## [0.2.36] - 2026-03-18

### Fixed

**npm 취약점 해결 (0 vulnerabilities)**
- `serialize-javascript` override 추가 (`6.0.2` → `^7.0.4`)
  - mocha 내부 의존성의 RCE 취약점(GHSA-5c6j-r48x-rmvq) 해결
- eslint, @typescript-eslint 등 devDependencies 마이너 업데이트

### Removed

- 불필요한 문서 파일 정리
  - `vsc-extension-quickstart.md` (VS Code 템플릿 파일)
  - `CODE_REVIEW_BY_CODEX.md` (1회성 리뷰 기록, 이미 반영 완료)

## [0.2.35] - 2026-02-19

### Enhanced

**성능 개선 및 코드 리뷰 반영**
- `debounce`를 `{ run, cancel }` API로 변경하고 watcher 해제 시 `cancel()` 호출
- `loadTypeConfig`의 absent-file 캐시를 `statSync` 호출 전에 확인하도록 수정
- regex/pattern 상수를 모듈 스코프로 호이스팅 (`macroExpander`, `sfrBitFieldParser`, `numberBaseHoverProvider`)
- mtime 기반 type config 캐시 추가 (`NumberBaseHoverProvider`)

### Fixed

**npm 취약점 해결 (16 → 7)**
- `npm-run-all`을 `npm-run-all2`로 교체
- `minimatch`, `diff`에 overrides 적용하여 high/moderate 취약점 9개 해결

### Testing
- debounce 단위 테스트 및 cancel API 테스트 추가

## [0.2.34] - 2026-02-19

### Fixed

**Codex 코드 리뷰 반영 (4건)**
- `structSizeCalculator`: 커스텀 타입 설정 로드 시 기본 타입과 머지하도록 수정 (`||` → spread merge)
- `registerDecoder`: union 파서의 중괄호 추적을 주석/문자열 인식 방식으로 개선
- `extension`: 즐겨찾기 삭제 시 title+group까지 포함한 엄격한 식별자로 변경
- `extension`: 'Keep both' UI 문구를 실제 동작과 일치하도록 수정

### Enhanced

**npm 의존성 업데이트**
- `@typescript-eslint/eslint-plugin`: `^7.0.0` → `^8.0.0` (ESLint 10 호환)
- `@typescript-eslint/parser`: `^6.15.0` → `^8.0.0` (ESLint 10 호환, 버전 통일)
- `@vscode/test-cli`: `^0.0.11` → `^0.0.12`
- `mocha`: `^5.0.5` → `^11.0.0` (minimist/minimatch/diff 취약점 해소)
- `npm-run-all`: `^1.1.3` → `^4.1.5`

## [0.2.33] - 2026-02-09

### Fixed

**코드 안정성 개선**
- `macroExpander`: 순환 참조 감지 시 `expandingMacros` Set 정리 누락 수정 (try/finally)
- `numberBaseHoverProvider`: non-null assertion 제거 및 안전한 null 체크 추가
- `numberBaseHoverProvider`: LSP 요청에 3초 timeout 추가
- `registerDecoder`/`structSizeCalculator`: 문자열/주석 내 중괄호 무시하도록 파싱 개선
- `extension`: deactivate 시 글로벌 Map/Set 메모리 정리 추가

### Testing
- platform 변경 테스트에 try/finally 적용하여 복원 보장

## [0.2.32] - 2026-01-20

### Added

**커스텀 타입 설정 파일 지원** (`.vscode/taskhub_types.json`)
- 프로젝트별로 커스텀 타입 크기와 alignment를 정의할 수 있는 설정 파일 지원
- JSON 스키마 자동 완성 및 유효성 검사 지원 (`taskhub_types.schema.json`)
- `packingAlignment` 옵션으로 구조체 패킹 정렬 설정 가능

### Testing
- 커스텀 타입 설정 관련 테스트 추가

## [0.2.31] - 2026-01-20

### Fixed

**Struct Size Calculator - Windows 타입 지원**
- Windows 타입들의 크기가 올바르게 표시되지 않던 문제 수정
  - 기존: `UINT16`, `UINT64` 등이 모두 기본값 4바이트로 표시됨
  - 수정: 각 타입의 실제 크기로 표시

### Added

**Windows 타입 지원** (`structSizeCalculator.ts`)
- 8비트: `BYTE`, `CHAR`, `UCHAR`, `UINT8`, `INT8`, `BOOLEAN`
- 16비트: `WORD`, `SHORT`, `USHORT`, `UINT16`, `INT16`
- 32비트: `DWORD`, `LONG`, `ULONG`, `UINT32`, `INT32`, `BOOL`
- 64비트: `QWORD`, `LONGLONG`, `ULONGLONG`, `UINT64`, `INT64`, `DWORD64`

**커스텀 타입 자동 등록** (`numberBaseHoverProvider.ts`)
- 문서 내의 모든 struct/class 정의를 자동으로 파싱하여 등록
- 중첩된 커스텀 타입(예: `Test32Class`를 멤버로 가진 구조체)의 크기가 올바르게 계산됨
- 다중 패스 의존성 해결로 복잡한 타입 체인 지원
- 중복 이름 및 forward declaration 처리

**커스텀 타입 설정 파일 지원** (`.vscode/taskhub_types.json`)
- 프로젝트별로 커스텀 타입 크기와 alignment를 정의할 수 있는 설정 파일 지원
- JSON 스키마 자동 완성 및 유효성 검사 지원
- 예시:
  ```json
  {
    "types": {
      "HANDLE": { "size": 8, "alignment": 8 },
      "MyCustomType": { "size": 16, "alignment": 4 }
    },
    "packingAlignment": 8
  }
  ```

### Testing

- Windows Types 테스트 7개 추가
  - `UINT8/UINT16`, `UINT32/UINT64`, `DWORD/QWORD`, `BYTE/WORD/DWORD` 등
- Custom Type Registration 테스트 5개 추가
  - `Test32Class`, `Test64Class`, 복잡한 Context 구조체
  - 의존성 체인 테스트 (TypeA → TypeB → TypeC)
- 총 429개 테스트 통과 (기존 417개 + 신규 12개)

## [0.2.30] - 2026-01-16

### Fixed

**Codex Code Review 기반 버그 수정**

- **registerDecoder.ts**: 32비트 필드에서 비트 마스크 계산 오류 수정
  - `extractFieldValue`에서 `bitWidth >= 32`일 때 `(1 << 32)`가 1로 wrap되는 JavaScript 비트 연산 한계 처리
  - 입력 검증 추가 (`bitStart < 0` 또는 `bitEnd < bitStart` 체크)

- **sfrBitFieldParser.ts**: `calculateBitMask` 함수 32비트 처리 오류 수정
  - `bitEnd > 31` 또는 `bitStart < 0` 범위 검증 추가
  - 전체 32비트 마스크 (`0xFFFFFFFF`) 올바르게 생성

- **numberBaseHoverProvider.ts**: `extractValueFromLine`에서 잘못된 값 반환 방지
  - `symbolName`이 주어졌을 때 해당 심볼의 값만 정확히 매칭하도록 수정
  - 같은 줄에 여러 값이 있을 때 관련 없는 값 반환 문제 해결

- **extension.ts**: 빈 `cwd` 문제 수정
  - 워크스페이스 없이 실행 시 `cwd: ''`로 인한 `ENOENT` 에러 방지
  - `undefined`로 설정하여 Node.js가 `process.cwd()` 사용하도록 변경

- **extension.ts**: "Keep both" 프리셋 병합 시 중복 ID 문제 수정
  - 기존: 단순 배열 병합으로 중복 ID 발생 → validation 실패로 전체 로딩 불가
  - 수정: `filterConflictingItems` 함수로 충돌하는 ID를 가진 항목 자동 필터링
  - `findConflictingIds`에 undefined 체크 추가

### Enhanced

**schema.ts 타입 안전성 개선**
- `options?: any` → 구체적인 `OpenDialogOptions` 인터페이스로 변경
- `inputs?: { [key: string]: string }` → `Record<string, string>`으로 단순화

### Testing

- `filterConflictingItems` 테스트 8개 추가
  - 충돌 ID 필터링, 중첩 children 재귀 필터링, 원본 불변성 확인 등
- `findConflictingIds` 테스트 6개 추가
  - 기본 충돌 감지, 중첩 충돌, 다중 충돌 처리 등
- 총 417개 테스트 통과 (기존 403개 + 신규 14개)

## [0.2.29] - 2026-01-15

### Enhanced

**SFR Bit Field Hover - Access Type Description**
- Access Type 약어에 대한 설명이 hover tooltip에 표시됩니다
  - 예: `RW1C` → `RW1C (Write 1 to Clear)`
- 지원되는 Access Type:
  - `RO` (Read Only)
  - `WO` (Write Only)
  - `RW` (Read / Write)
  - `RW1C` (Write 1 to Clear)
  - `RW1S` (Write 1 to Set)
  - `W1C` (Write 1 to Clear)
  - `RWC` (Read / Write Clear)
  - `RWS` (Sticky bit)

### Testing
- Added 12 unit tests for `getAccessTypeDescription` function

## [0.2.28] - 2026-01-12

### Fixed

**History Status Update**
- Fixed history panel not updating status when action is manually stopped via stop button
  - History entries now correctly show 'failure' status with "Action stopped by user" message
  - Previously, stopped actions would remain in 'running' state indefinitely
  - Added timestamp tracking system (`actionStartTimestamps` Map) to properly correlate stop events with history entries
  - Stop button now immediately updates history status when clicked

### Added

**Testing**
- Added comprehensive unit tests for action stop and history update functionality
  - 11 new test cases covering timestamp tracking, history status updates, and edge cases
  - All 391 tests passing

## [0.2.27] - 2026-01-04

### Added

**Preset 기능**
- 프로젝트 환경별 action 설정을 쉽게 공유하고 적용할 수 있는 Preset 시스템 추가
- **Apply Preset** 명령어: 미리 정의된 preset을 워크스페이스에 적용
  - Replace 모드: 기존 actions.json을 preset으로 교체
  - Merge 모드: 기존 actions와 preset을 병합
  - ID 충돌 시 3가지 해결 전략 제공 (Keep existing/Use preset/Keep both)
- **Save as Preset** 명령어: 현재 actions를 preset으로 저장
  - Workspace preset (`.vscode/presets/`): Git으로 팀원들과 공유 가능
  - Extension preset (`presets/`): 확장 프로그램에 번들로 포함
  - Custom location: 원하는 위치에 파일로 저장
- Extension preset과 workspace preset 자동 발견 및 선택 가능
- 예제 preset 파일 포함 (`presets/preset-example.json`)

**활용 사례**
- 팀 내 여러 환경(integration, hil 등) 간 action 설정 공유
- 새 프로젝트 시작 시 빠른 초기 설정
- 환경별 Git/빌드 명령어 템플릿 관리

## [0.2.26] - 2026-01-03

### First Public Release

TaskHub는 반복적인 개발 작업을 자동화하고, 임베디드 시스템 개발을 위한 전문 도구를 제공하는 VS Code 확장 프로그램입니다.

#### 핵심 기능

**워크플로우 자동화**
- 사용자 정의 액션 및 파이프라인 실행 (셸 명령, 파일 압축/해제, 문자열 처리 등)
- 즐겨찾는 링크와 파일을 한 곳에서 관리
- 액션 실행 히스토리 추적 및 재실행

**임베디드 개발 지원 (C/C++)**
- **Number Base Hover**: 숫자 리터럴의 진법 자동 변환 (Hex ↔ Dec ↔ Bin)
- **SFR Bit Field Hover**: 레지스터 비트 필드 정보 표시 (비트 위치, 접근 타입, 리셋 값, 비트 마스크)
- **Bit Operation Hover** (실험적): 비트 연산 결과 미리보기

**생산성 향상**
- Multi-root 워크스페이스 완벽 지원
- 검색 및 그룹화 기능
- 액션 생성 마법사
- JSON 스키마 기반 설정 검증

임베디드 개발자와 자동화가 필요한 모든 개발자를 위한 올인원 도구입니다.

## [0.2.10] - 2024-11-08

- Added explicit activation events for every exposed view and command so the extension reliably loads before TaskHub UI or palette actions are used.
- Restored `tsc --noEmit` by supplying compatibility declarations for the latest `minimatch` types consumed by `@types/glob`.
- Reworked actions, links, and favorites to understand multi-root workspaces: every `.vscode/*.json` file is monitored per folder, commands prompt for a target folder, and metadata flows through so placeholders such as `${workspaceFolder}` resolve correctly when executing actions.
- Capture-mode tasks now register their spawned processes, allowing `taskhub.stopAction` and `taskhub.terminateAllActions` to cancel pipelines that only streamed output through the output channel.
- Registered the example JSON command as a disposable and refreshed documentation to describe the new behaviour.

## [0.1.0]

- Initial release
