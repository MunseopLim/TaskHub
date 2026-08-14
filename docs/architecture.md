# TaskHub 아키텍처

이 문서는 TaskHub의 프로젝트 구조, 주요 컴포넌트, 데이터 구조를 설명합니다.

## 프로젝트 구조

```
TaskHub/
├── src/
│   ├── extension.ts                  # 메인 진입점 (activate/deactivate, 명령어 핸들러)
│   │                                  # - TreeDataProvider 4종 인스턴스는 src/providers/에서 import
│   │                                  # - 액션 실행: executeAction(), executeSingleTask()
│   │                                  # - 재-export 범위는 제한적: 일부 pipelineUtils 헬퍼 +
│   │                                  #   MainViewProvider / Folder / Action 3개 심볼만 (기존 import 호환용)
│   │                                  #   상세는 §주요 컴포넌트 > 1. TreeDataProvider 참조
│   ├── providers/                     # TreeDataProvider 분리 모듈 (Phase 2 split)
│   │   ├── mainViewProvider.ts        # Actions 패널 (폴더 트리)
│   │   ├── linkViewProvider.ts        # 워크스페이스 링크 패널 (.vscode/links.json)
│   │   ├── favoriteViewProvider.ts    # 즐겨찾기 패널
│   │   ├── historyProvider.ts         # 액션 실행 히스토리 패널
│   │   ├── actionStatus.ts            # 액션 실행 상태(actionStates) + 멀티 task 진행률(progress) 관리
│   │   └── normalization.ts           # tags / line 번호 정규화 헬퍼
│   ├── pipelineUtils.ts               # 순수 유틸리티 (vscode 의존 없음)
│   │                                  # - 변수 치환/sanitize, workspace 경로 검증
│   │                                  # - 쉘 토큰화 + POSIX/PowerShell/Windows native 인자 quoting
│   │                                  # - toWorkspaceRelativePath(): 절대경로 → ${workspaceFolder} 정규화
│   │                                  # - wouldExceedCaptureLimit(): 캡처 한도 off-by-one guard
│   ├── previewRun.ts                  # Preview Run (Dry-run) 리포트 생성
│   ├── previewOpener.ts               # preview/browser 열기 명령 헬퍼
│   ├── doctor.ts                      # actions.json 정적 분석(Doctor) 순수 모듈
│   ├── variableCompletions.ts         # actions.json 의 ${…} 참조 자동완성 (결과 키는 previewRun 과 같은 출처)
│   ├── dialogMemory.ts                # 파일/폴더 다이얼로그의 마지막 사용 위치 기억
│   ├── diagnosticMatcher.ts           # shell 출력 → VS Code Diagnostic 매칭 순수 모듈
│   ├── jsonEditor.ts                  # JSON Editor WebView (시트/행 편집)
│   ├── jsonEditorUtils.ts             # JSON Editor 순수 로직 (host·webview 공용, vscode 비의존)
│   ├── webview/
│   │   └── jsonEditorLogic.ts         # 위 로직을 webview 번들로 내보내는 엔트리
│   ├── hexViewer.ts                   # Hex Viewer WebView (assertWithinHexViewerSpan 포함)
│   ├── hexParser.ts                   # Intel HEX / SREC / Binary 파서
│   ├── archiveUtils.ts                # zip/unzip 내장 엔진
│   ├── i18n.ts                        # 다국어 지원 (한국어/영어, vscode.env.language 기반)
│   ├── schema.ts                      # TypeScript 타입 정의
│   ├── numberBaseHoverProvider.ts     # Number Base / SFR Bit Field / Struct Size Hover
│   ├── sfrBitFieldParser.ts           # SFR 비트 필드 파서
│   ├── structSizeCalculator.ts        # 구조체 크기/레이아웃 계산
│   ├── registerDecoder.ts             # 레지스터 비트 필드 디코더
│   ├── macroExpander.ts               # C/C++ 매크로 전처리기 (4096자 ReDoS guard)
│   ├── elfParser.ts                   # ELF32 바이너리 파서
│   ├── linkerScriptParser.ts          # GNU/ARM 링커 스크립트 파서
│   ├── armLinkListParser.ts           # ARM Linker Listing 파서 (armlink --list)
│   ├── memoryMapViewer.ts             # Memory Map WebView 시각화
│   └── test/                          # Mocha + Node.js assert 테스트 (모듈별 *.test.ts)
├── schema/
│   ├── actions.schema.json       # actions.json 스키마 및 검증
│   ├── links.schema.json         # links.json 스키마 및 검증
│   ├── favorites.schema.json     # favorites.json 스키마 및 검증
│   └── taskhub_types.schema.json # taskhub_types.json 스키마 (커스텀 타입 설정)
├── media/
│   ├── h_icon.svg            # Activity Bar 컨테이너 아이콘
│   ├── m_icon.svg            # Actions 뷰 아이콘
│   ├── actions.json          # 기본 제공 액션 예제
│   └── *_example.json        # 각종 예제 파일들 (links_example.json 등)
├── presets/
│   └── preset-example.json   # 프리셋 예제 파일
├── docs/
│   ├── features.md           # 상세 기능 문서
│   ├── architecture.md       # 이 파일
│   ├── roadmap.md            # 미구현 기능 우선순위와 기술 부채
│   └── integration-tests.md  # IT-xxx 통합 테스트 대장
├── .vscode/
│   ├── actions.json          # 워크스페이스별 액션 (선택사항)
│   ├── links.json            # 워크스페이스별 링크 (선택사항)
│   ├── favorites.json        # 워크스페이스별 즐겨찾기 (선택사항)
│   └── taskhub_types.json    # 커스텀 타입 크기 설정 (선택사항)
├── package.json              # 확장 메타데이터, 설정, 명령어, 뷰 정의
├── CHANGELOG.md              # 변경 이력
├── CONTRIBUTING.md           # 개발 가이드
└── README.md                 # 사용자 안내
```

**빌드 출력:**
- `dist/extension.js`: esbuild, CommonJS, 단일 파일 번들 (Node)
- `dist/jsonEditorWebview.js`: esbuild, IIFE, 브라우저 타깃. JSON Editor webview 의 순수 로직 번들 (아래 참조)
- `out/`: tsc 컴파일 (테스트용)
- 외부 의존성: `vscode` (번들에서 제외)

**webview 스크립트의 두 층.** `jsonEditor.ts`의 템플릿 리터럴에는 DOM 어댑터만 두고,
타입 검사가 필요한 순수 로직은 `jsonEditorUtils.ts` 한 벌로 관리합니다.
`src/webview/jsonEditorLogic.ts`가 이를 IIFE 번들로 내보내면 webview는 전역
`TaskHubJsonEditorLogic`에서 사용하고 host 테스트는 원본 모듈을 직접 import합니다.
인라인 스크립트는 tsc/eslint 범위 밖이므로 별도 컴파일 테스트를 유지하며, 번들에서 꺼낸
이름과 같은 인라인 선언을 추가하지 않습니다.

## 주요 컴포넌트

### 1. TreeDataProvider (`src/providers/`)

각 패널은 `vscode.TreeDataProvider`를 구현하며, 독립 모듈로 분리되어 있습니다:

*   **MainViewProvider** ([providers/mainViewProvider.ts](../src/providers/mainViewProvider.ts)): 액션 버튼과 폴더 트리 관리
*   **LinkViewProvider** ([providers/linkViewProvider.ts](../src/providers/linkViewProvider.ts)): Workspace 링크 관리
*   **FavoriteViewProvider** ([providers/favoriteViewProvider.ts](../src/providers/favoriteViewProvider.ts)): 즐겨찾기 파일 관리
*   **HistoryProvider** ([providers/historyProvider.ts](../src/providers/historyProvider.ts)): 액션 실행 및 TaskHub 도구 열람 히스토리 관리 (`workspaceState` 백엔드)

`extension.ts`는 위 모듈에서 클래스를 import해 `activate()`에서 인스턴스를 만듭니다. 기존 호출자(테스트 포함)의 호환성을 위해 `MainViewProvider`, `Folder`, `Action` 세 심볼만 `extension.ts`에서 re-export됩니다. `LinkViewProvider`, `FavoriteViewProvider`, `HistoryProvider` 및 각 엔트리/아이템 타입은 re-export되지 않으므로 **외부/테스트 코드는 `./providers/...`에서 직접 import** 해야 합니다.

### 2. 액션 실행 파이프라인

*   **executeAction()**: 메인 액션 실행 함수 (히스토리 추적 통합)
*   **executeSingleTask()**: 개별 태스크 실행
    *   지원 태스크 타입 (`Task.type` union, [src/schema.ts](../src/schema.ts) 참조): `shell`, `command`, `fileDialog`, `folderDialog`, `unzip`, `zip`, `stringManipulation`, `inputBox`, `quickPick`, `envPick`, `confirm`, `writeFile`, `appendFile`
*   **변수 치환**: `${task_id.property}` 형식으로 파이프라인 간 데이터 전달
*   **Task DAG**: `dependsOn` 및 `${taskId.x}` 자동 추론 의존성으로 그래프를 구성하며, `parallel: true` 태스크는 sync barrier에서 빠져 동시 실행 풀에 들어간다. 상세 시맨틱은 [features.md §24 병렬 실행 / Task DAG](./features.md#24-병렬-실행--task-dag) 참조.
*   **파일 감시**: debounce({ run, cancel }) 패턴으로 JSON 변경 감지

### 2.1. 동적 커맨드 등록 (`syncActionCommands`)

`actions.json`의 모든 액션은 `taskhub.runAction.<sanitized id>` 형태의 VS Code 커맨드로 노출되어, 사용자가 키바인딩을 직접 매핑할 수 있다 (자세한 사용자 흐름은 [features.md "액션에 단축키 할당"](./features.md#액션에-단축키-할당) 참조).

* **저장소**: `Map<commandId, vscode.Disposable>` (모듈 스코프 `actionCommandRegistrations`).
* **Diff sync**: 활성화 시 1회 + `actions.json` / preset / 워크스페이스 watcher 등 cache invalidation 지점마다 `refreshActionsAndCommands(context, mainViewProvider)`를 호출 → `loadAllActions` → 추가/제거된 항목만 register/dispose.
* **Parse error 시 동작**: `loadAllActions`가 throw하면 (mid-edit 저장 등) 기존 등록을 그대로 유지한다. 사용자 키바인딩이 일시적 invalid JSON 때문에 끊기는 것을 방지하기 위함.
* **Deactivate**: `disposeAllActionCommands()`가 `context.subscriptions`로 등록되어 있어 partial state와 무관하게 일괄 dispose된다.
* **Test seam**: `syncActionCommandsFromActions(actions, registry?)`는 `loadAllActions`를 거치지 않는 하위 함수로, 테스트가 격리된 registry를 넘겨 실제 활성화 등록과 충돌 없이 동작 검증할 수 있게 한다.

### 3. C/C++ Hover 모듈

`numberBaseHoverProvider.ts`가 진입점 (HoverProvider 구현)이며, 내부적으로 다음 모듈을 호출합니다:

| 모듈 | 역할 |
|------|------|
| `sfrBitFieldParser.ts` | SFR 비트 필드 주석 파싱 및 계층 구조 추출 |
| `structSizeCalculator.ts` | 구조체/클래스 크기, 오프셋, 패딩 계산 |
| `registerDecoder.ts` | 레지스터 비트 필드 값 추출 및 디코딩 |
| `macroExpander.ts` | C/C++ `#define` 매크로 확장. 현재 활성 문서 전체에서 `#define` 라인만 수집해 재귀 치환하고, 수식은 `evaluateToNumber()`(safe 문자집합 + 4096자 한도)로 계산한다. `#if`/`#else` 전처리나 include 체인 추적은 범위 밖. |

**LSP 통합:** `vscode.commands.executeCommand('vscode.executeDefinitionProvider', ...)` 사용
**캐시:** mtime 기반 캐시로 `taskhub_types.json` 설정 로드 최적화

## 데이터 구조

타입 정의를 문서에 복사하지 않습니다. 필드의 정본과 역할은 다음 소스에 있습니다.

| 구조 | 정본 | 핵심 규약 |
| --- | --- | --- |
| `HistoryEntry` | [providers/historyProvider.ts](../src/providers/historyProvider.ts) | 액션과 도구 열람을 함께 저장합니다. 상태는 `running`·`success`·`failure`·`cancelled`이며, 비밀번호 입력은 `inputs`에 기록하지 않습니다. 레거시 항목은 선택 필드가 없을 수 있습니다. |
| `LinkEntry` | [providers/linkViewProvider.ts](../src/providers/linkViewProvider.ts) | 표시용 정규화 값과 원본 `raw`를 함께 보존하여 알 수 없는 사용자 필드를 잃지 않습니다. |
| `FavoriteEntry` | [providers/favoriteViewProvider.ts](../src/providers/favoriteViewProvider.ts) | 링크와 같은 원본 보존 규약을 따르고 워크스페이스·줄 위치 메타데이터를 가집니다. |
| 액션·태스크 스키마 | [schema.ts](../src/schema.ts), [actions.schema.json](../schema/actions.schema.json) | TypeScript 실행 타입과 사용자 JSON 검증 스키마를 함께 갱신합니다. |

History의 사용자 동작과 저장 입력·명령·소요 시간은 [features.md §14](./features.md#14-액션-실행-히스토리)를 참조하세요.

## 활성화(Activation)

TaskHub 확장은 다음 상황에서 활성화된다:

* `package.json`의 `activationEvents`에 지정된 이벤트가 발생:
  * `onStartupFinished` — 워크벤치 복원이 끝난 시점(블로킹 없이). 동적으로 등록되는 `taskhub.runAction.<id>` 커맨드는 `contributes.commands`에 없어서 VS Code의 `onCommand:<id>` 자동 활성화가 작동하지 않으므로, 사용자가 `keybindings.json`에 매핑한 키를 fresh window에서도 작동시키려면 활성화가 워크벤치 시작 직후에 일어나야 한다.
  * `onLanguage:c` — C 소스 파일 열림
  * `onLanguage:cpp` — C++ 소스 파일 열림
* `contributes.views`의 `mainView.*` 트리가 보이게 됨 (H 아이콘 클릭) — 암시적 활성화.
* `contributes.commands`에 정의된 커맨드 호출 — 암시적 활성화.
* `contributes.customEditors`의 대상 파일(`*.hex`, `*.bin`, …) 열림 — 암시적 활성화.

C/C++ 파일을 열었을 때 hover가 동작하려면 확장이 활성화되어 `vscode.languages.registerHoverProvider(...)`가 실행되어야 하므로, 활성화 이벤트에 언어를 명시한다 (`onStartupFinished`도 같은 보장을 주지만, 명시 유지로 의도를 분명히 둔다).

### 활성화 비용 최적화

`activate()`는 가능한 한 가볍게 유지한다. 다음 두 가지 패턴이 반복 비용의 주범이므로 항상 캐싱한다:

1. **Ajv 스키마 검증기 (`getActionsValidator`)**
   * `actions.json` 스키마 컴파일은 모듈 레벨에서 싱글톤으로 관리.
   * `loadAndValidateActions()`, `parseImportData()` 등 모든 호출 경로에서 동일 인스턴스를 재사용.

2. **`loadAllActions()` 결과 캐시**
   * 캐시 변수는 모듈 스코프(`cachedAllActions`).
   * `invalidateActionsCache()`로만 무효화:
     * `.vscode/actions.json` 파일 watcher 콜백.
     * `taskhub.preset.selected` 설정 변경 핸들러.
     * 쓰기 동작(액션 생성 wizard, 프리셋 적용, import) 직후.
   * 트리 렌더링 때마다 JSON을 다시 파싱하지 않도록 해 UI 응답성을 유지.

또한 Provider 생성자에서 동기 JSON 로드를 수행하면 중복 로드 + activation 경로 가중이 발생하므로, 생성자는 **필드 초기화만** 수행한다. activate()에서도 `workspaceLinkViewProvider.refresh()` 등 초기 `refresh()`를 호출하지 않는다. 실제 로드는:

* 첫 `getChildren()` — 사이드바(H 아이콘)가 열리는 시점.
* 파일 watcher 콜백에서의 `refresh()` — `.vscode/links.json` 등 변경 시.
* 쓰기 동작 직후의 명시적 `refresh()` — 워크스페이스 쓰기 명령에서 호출.

이 때 각 Provider의 `loaded: boolean` 플래그가 "한 번도 로드하지 않음"과 "로드했지만 비어 있음"을 구분한다. `ensureCache()`는 `!this.loaded`일 때만 실제 JSON을 읽고, 첫 로드 직후 `updateTitle()`을 호출하여 뷰 타이틀의 "(N)" 카운트를 갱신한다.

번들된 `media/*.json`은 런타임에 바뀌지 않으므로 해당 FileSystemWatcher는 `context.extensionMode === ExtensionMode.Development`일 때만 등록한다.

## 저장소 (Persistence)

*   **workspaceState**: 히스토리 데이터 저장 (VS Code API)
    *   키: `'taskhub.actionHistory'`
    *   값: `HistoryEntry[]` 배열 — 구조는 위 "데이터 구조" 섹션 참조.

설정 정의의 정본은 [package.json](../package.json)의 `contributes.configuration`입니다. [features.md §21 설정 레퍼런스](./features.md#21-설정-레퍼런스)는 이를 사용자 관점에서 설명하며, 이 문서는 중복 목록 대신 해당 레퍼런스만 가리킵니다. 키·기본값·범위의 정합성은 `src/test/docConsistency.test.ts`가 검사합니다.

## 실험적 기능 패턴

새 실험적 기능 추가 시:

1. `package.json`에 `taskhub.experimental.<name>.enabled` 설정 추가 (default: false)
2. 필요 시 `views`에 `"when": "config.taskhub.experimental.<name>.enabled"` 조건부 뷰 추가
3. `activate()` 내에서 설정 확인 후 조건부 등록
4. `docs/features.md` 섹션 16에 문서화

현재 실험적 기능: Bit Operation Hover (`taskhub.experimental.bitOperationHover.enabled`)

> 실험적 기능의 상세 추가 가이드는 [CONTRIBUTING.md](../CONTRIBUTING.md)를 참조하세요.

## 개발 시 주의사항

- **History**: 액션과 도구 열람은 같은 `taskhub.actionHistory` 저장소를 사용합니다. 종료 경로는 상태·`durationMs`·입력·실행 명령을 함께 확정하고, `password: true` 입력은 기록하지 않습니다. 회고 정보는 History에, 실행 중 진행률은 Actions에만 표시합니다.
- **Problem Matcher**: 문자열 매칭은 [diagnosticMatcher.ts](../src/diagnosticMatcher.ts), VS Code `DiagnosticCollection` 관리는 [extension.ts](../src/extension.ts)가 담당합니다. 컬렉션은 액션별로 격리하고 재실행 시 그 액션의 이전 진단만 지웁니다.
- **새 패널**: TreeDataProvider는 `src/providers/`에 두고 `activate()`에서는 생성·등록만 합니다. 컨텍스트 전용 명령은 Command Palette에서 숨깁니다.
- **새 명령**: `package.json` 선언, `activate()` 핸들러, 필요한 메뉴와 문서를 함께 갱신합니다.
- **스키마**: `schema/*.schema.json`, `src/schema.ts`, 검증·import 경로를 함께 확인합니다. 변경 유형별 전체 체크리스트는 [CONTRIBUTING.md](../CONTRIBUTING.md#변경-유형별-체크리스트)를 따릅니다.

## 디버깅

*   **F5** 키: Extension Development Host 실행
*   breakpoint 설정 가능
*   Console 로그: `Developer: Toggle Developer Tools`
*   Output 패널: "TaskHub" 채널에서 로그 확인

## 보안 가드

TaskHub는 사용자가 JSON으로 정의한 임의 명령을 실행하므로, 위험한 입력에 대해 다음 방어 계층을 유지한다:

1.  **워크스페이스 신뢰와 Import 신뢰 결정**
    *   `package.json`의 `capabilities.untrustedWorkspaces.supported`는 `false`다. 워크스페이스의 `actions.json`이 임의 명령을 실행할 수 있으므로 VS Code Restricted Mode에서는 확장을 활성화하지 않는다.
    *   Import는 스키마·중복 검증 뒤 `collectImportTrustAdvisories()`로 **가져온 액션만** Doctor에 전달하지만, 결과 유무와 관계없이 대상 `actions.json`을 읽거나 쓰기 전에 trust modal을 표시한다. 액션 목록과 명령·argv·cwd·env·파일/아카이브 부작용을 보여 주며, 첫/default 버튼은 원본 열기, 두 번째 버튼만 명시적 import다. Cancel은 `isCloseAffordance` 하나로 두어 Escape·닫기도 쓰기 없이 끝낸다.
    *   Doctor range는 정규화해 재직렬화한 배열 기준이므로 finding의 `filePath`는 실제 원본이 아닌 `<import-review>` 합성 경로다. 현재 UI는 메시지만 사용하며, 이 구분은 나중에 실제 파일의 잘못된 줄로 진단을 게시하는 오용을 막는다.
    *   원본을 처음 읽은 문자열을 최종 동의 시점에 다시 읽은 값과 비교한다. 검토 중 파일이 수정·교체·삭제되면 가져오기를 취소해, 화면에서 확인한 내용과 실제 병합되는 in-memory 스냅샷이 갈라지지 않게 한다.
    *   손상된 기존 `actions.json`도 백업 동의 시점에 다시 읽는다. 검토 중 고쳐져 유효해졌다면 `parseAndValidateActionsContent()`로 그 스냅샷을 정상 병합하고, 여전히 유효하지 않다면 다시 읽은 최신 문자열만 `.bak`에 쓴다. 모달 전에 읽은 오래된 문자열을 백업하거나 최신 편집을 덮어쓰지 않는다.
    *   Doctor 진단은 셸 보간 같은 작성·런타임 위험을 보조할 뿐, `curl … | sh` 같은 고정 악성 명령을 판별하지 못한다. 따라서 진단 0건도 안전 판정으로 표현하지 않으며 이 관문을 샌드박스로 설명하지 않는다.
2.  **변수 치환(`interpolatePipelineVariables`) 입력 정화**
    *   `sanitizeInterpolatedValue(value)`에서 null 바이트(`\0`)를 거부하고 32KB 길이 상한을 강제한다.
    *   object/array 값은 치환 대신 placeholder를 그대로 유지한다 (`${id.prop}` 원형).
3.  **파일 경로 검증(`resolveWithinWorkspace`)**
    *   Task output mode가 `file`일 때, 그리고 `writeFile` / `appendFile`의 `path`와 즐겨찾기 항목 경로에 대해, 치환 결과를 `path.resolve` → `path.relative(root, resolved)` 순으로 검사해 워크스페이스 루트 외부 쓰기를 거부한다.
    *   상대 경로(`"report.txt"`, `"build/out.log"` 등)는 `process.cwd()`가 아니라 실행 중인 액션의 워크스페이스 폴더(`defaultWorkspace`) 기준으로 resolve한다. 이를 위해 `resolveWithinWorkspace(targetPath, roots, baseDir)` 시그니처의 3번째 인자로 액션 워크스페이스를 전달한다.
    *   **`zip` / `unzip`은 이 격리에서 의도적으로 제외된다.** 두 태스크는 `fileDialog` / `folderDialog`로 사용자가 **런타임에 고른** 위치를 그대로 다루는 것이 설계이고(번들 예제 `media/actions_example.json`의 zip 액션이 고른 폴더를 그 자리에서 압축한다), 워크스페이스로 묶으면 그 흐름 자체가 성립하지 않는다. 대신 다른 층으로 방어한다 — 추출은 zip-slip·심볼릭/하드 링크·크기/개수 상한(`archiveUtils.ts`)으로, 생성은 소스 루트 밖을 가리키는 링크 제외로 막는다.
    *   다만 **상대 경로의 기준점은 두 엔진이 같아야 한다.** 내장 엔진은 cwd 개념이 없어 `path.resolve`가 extension host의 `process.cwd()`(= VS Code를 띄운 위치)를 쓰는 반면 외부 `tool` 경로는 자식 프로세스의 cwd를 쓰므로, 같은 태스크가 `tool` 유무로 다른 위치에 파일을 만들었다. `resolveBuiltinArchivePath(targetPath, baseDir)`가 내장 엔진 호출 직전에 `task.cwd` → 워크스페이스 순으로 기준점을 맞춘다(격리는 하지 않는다). 반환하는 `${zip.archivePath}` / `${unzip.outputDir}`도 해석된 절대 경로다.
4.  **쉘 인자 이스케이프 / 실행 경로 선택**
    *   POSIX: `buildPosixCommandLine`이 `quotePosixArgument`로 각 인자를 싱글쿼트로 감싸고(내부 싱글쿼트는 `'\''`) `sh -c`로 실행.
    *   Windows — **실행 경로 판별**: `resolveWindowsDirectExecutable(command, args, { env, cwd })`가 셸 없이 띄울 실제 `.exe`/`.com` 경로를 반환하고, `resolveWindowsTaskSpawn`은 전략과 이 절대 경로를 함께 보존한다. 확장자 없는 이름과 `node.exe` 같은 bare 이름은 `PATH`에서 찾고, 상대 명령 경로와 상대 PATH 항목은 task의 실제 cwd를 기준으로 해석한다. `.cmd`/`.bat`/`.ps1`/`.js` 같은 스크립트·shim(`npm`/`npx`/`pnpm`/`yarn` 등, 실제로는 `*.cmd`), 셸 빌트인/별칭(`echo`, `dir`, `cd`, …)은 제외한다. PATH 해석은 호출자가 넘긴 **task의 실제 실행 env**(`{ ...process.env, ...envOverrides }`)를 기준으로 한다.
    *   Windows — **native 경로**(계획 결과가 `native`일 때): `executeShellCommand`와 비밀번호 입력을 쓰는 민감 one-shot은 `spawn(file, argvArray)`, VS Code Task 경로는 `vscode.ProcessExecution`, 일반 one-shot은 `ProcessStartInfo`(`UseShellExecute=$false`)를 사용하며 모두 계획에 보존한 같은 절대 경로를 실행한다. 인자를 argv 배열 또는 `quoteWindowsCommandLineArgument`로 escape한 문자열로 직접 넘겨 **Windows PowerShell 5.1의 native-command 인자 큐오팅 버그**(`"` 가 사라지는 문제)를 우회한다. 판정 뒤 파일이 사라지거나 실행이 거부되면 원래 bare 이름을 PowerShell로 재해석하지 않고 시작 실패를 반환한다.
    *   Windows — **PowerShell 경로**(계획 결과가 `powershell`/`raw-shell`일 때): `buildPowerShellInvocation`이 `quotePowerShellArgument`로 각 인자를 싱글쿼트로 감싸 PowerShell `-EncodedCommand`로 전달한다. 일반 one-shot은 `Start-Process -FilePath … -ArgumentList @(…)`를 사용해 PATHEXT/파일 연결을 셸처럼 해석한다. 비밀번호 입력을 쓰는 민감 one-shot은 PowerShell 자체를 `stdio: 'ignore'`로 띄우므로 콘솔 출력 인코딩을 바꿀 대상이 없다. 이 경로에서는 `[Console]::OutputEncoding`을 설정하지 않으며, raw 명령의 `>`·`>>`에 필요한 `Out-File:Encoding` 기본값만 유지한다. **이 경로만 `detached`를 쓰지 않는다** — `powershell.exe`를 `DETACHED_PROCESS`로 띄우면 스크립트를 실행하지 않고 exit 0으로 끝나(Windows CI 실측) 작업과 실패 신호를 함께 잃는다. native·POSIX 경로는 그대로 `detached`를 쓰며, 확장 호스트를 붙잡지 않는 `unref()`는 모든 경로에 공통이다.
    *   `password: true` 입력과 그 파생값은 TaskHub의 History·로그·알림·터미널·에디터에서 숨기지만, 실행 대상에는 원래 값이 전달되어야 한다. 따라서 argv에 넣은 값은 Windows 프로세스 명령줄 조회 등 로컬 OS 관찰 수단에 보일 수 있으며, 이 마스킹을 같은 사용자·관리자 권한의 로컬 프로세스에 대한 비밀 격리로 간주하지 않는다. 프로세스 명령줄에서 빼려면 액션 정의와 실행 대상이 stdin이나 별도 비밀 전달 채널을 사용해야 하며, 그것만으로 로컬 프로세스 격리가 생기는 것은 아니다.
5.  **WebView 보안**
    *   모든 WebView(HexViewer, JSON Editor, Memory Map)는 `Content-Security-Policy` 메타 태그를 포함한다.
    *   `script-src`는 패널마다 새로 생성되는 16바이트 nonce만 허용한다. nonce는 `crypto.randomBytes(16).toString('base64')`(CSPRNG)로 생성되며, 인라인 스크립트 전부에 동일 nonce를 부여한다.
    *   CSP가 인라인 이벤트 핸들러를 차단하므로, 모든 UI 컨트롤은 `data-action` 속성을 달고 nonce 스크립트 내부의 위임(delegated) 리스너에서 처리한다. 새 버튼/컨트롤을 추가할 때 절대 `onclick="..."` 형태를 쓰지 말 것.
    *   에러/정보 HTML 출력은 `escapeHtml` 경유를 강제한다.
6.  **파서 입력 한도**
    *   ELF32: 헤더 최소 크기/섹션 테이블/string table 범위를 선검증.
    *   Intel HEX/SREC: 레코드당 최대 255바이트, 누적 `HEX_MAX_BYTE_ENTRIES` 초과 시 throw.
    *   Hex Viewer 렌더링: `HEX_VIEWER_MAX_SPAN = 128 MB`. 주소 범위가 이를 초과하면(sparse 파일) 렌더링 거부.
    *   Macro 전처리: shift 카운트 0–63 clamp, 수식 길이 4KB 제한.
7.  **Hover 타임아웃 및 비동기 IO**
    *   `withLspTimeout(promise, token, 3000)`으로 모든 LSP 호출을 감싼다. `activeHoverCalls: Set<string>`이 동일 위치 재진입을 막는다.
    *   `taskhub_types.json` 로드는 `fs.promises.*`(stat/readFile/realpath) 기반이다. 느린 스토리지에서도 extension host 이벤트 루프를 블로킹하지 않는다.

보안 관련 변경 시 관련 유닛 테스트(`src/test/extension.test.ts`의 `sanitizeInterpolatedValue`, `resolveWithinWorkspace`, 파서별 `defensive` suite)를 함께 갱신한다.
