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

## [0.4.22] - 2026-05-01

### 추가 — Problem Matcher / 진단 통합 (TODO §3.1)

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

#### 범위 한정 (TODO §3.1)
- **v1: batched mode only**: 진단은 task 종료 후 stdout 전체를 한 번에 파싱해 등록합니다. 5분짜리 빌드의 에러는 빌드 끝나야 보입니다. **streaming mode (실시간 진단)** 는 v2 — `executeStreamedTask`에 output tee 인프라 추가가 필요한 별도 작업이라 분리.
- **다중 라인 매칭은 미지원**: 한 진단이 여러 라인에 걸쳐 표현되는 형태(gcc note 후속 라인 등)는 v1에선 라인별 독립 매칭. v2 또는 v3에서 검토.

**테스트**: 신규 32케이스 추가 (단위 24: `normalizeSeverity` 3, `resolveDiagnosticMatcher` 4, `$gcc` preset 5, `$tsc` preset 1, multi-pattern + array config 3, 에러 경로 3, 방어 처리 2, 폴백 severity 3; 통합 8: IT-075 기본 등록, IT-076 재실행 자동 clear, IT-077 상대 경로 cwd 기준 해석, IT-078 스트림 모드 silent skip, IT-079 non-zero exit 진단 회귀 가드, IT-080 interpolated cwd 회귀 가드, IT-081 exit 0 + stderr 진단 회귀 가드, IT-082 sibling task 진단 merge 회귀 가드). 전체 961 passing.

## [0.4.21] - 2026-04-30

### 추가 — 멀티 task 액션 진행 표시 (TODO §5.2 일부)

#### Medium (UX 개선)
- **실행 중 액션 카드에 "지금 어디" 진행 표시**: 멀티 task 액션이 실행 중일 때 라벨 옆에 `2/3 · link` 형태로 현재 task 위치와 id를 노출합니다 — "task1 끝났는지, 어디서 막혔는지" 알기 위해 터미널을 직접 안 봐도 되도록. 단일 task 액션은 의도적으로 비워둠(`1/1`은 노이즈). 액션 종료 시 자동으로 사라짐. ([src/providers/mainViewProvider.ts](src/providers/mainViewProvider.ts), [src/providers/actionStatus.ts](src/providers/actionStatus.ts))

#### 내부 구조
- **Pipeline transition 이벤트 도입**: `PipelineExecutionOptions.onTaskTransition` 콜백 추가. `executeActionPipeline`이 각 task에 대해 `running` → 종료 transition (`success`/`failure`/`skipped`) 4종을 1-based `{ taskId, index, total, state }` 형태로 발사. `executeAction`이 이를 받아 `actionStates.progress`를 갱신하고 `mainViewProvider.refresh()`를 호출. 외부 호출자(테스트 등)는 옵션 미전달 시 기존 동작 그대로 — backward compatible.
- **`actionStates` 모델 확장**: `{ state, progress?: { index, total, taskId } }`. progress는 mid-run 전용 — `finalizeActionRun`이 종료 시 자동 clear.
- **회고 정보 vs 진행 정보 분리 명문화**: [docs/architecture.md](docs/architecture.md) "개발 시 주의사항" §2에 정책 추가. 회고(시각·소요 시간)는 `HistoryItem.description`에만, 진행(현재 어디)은 `Action TreeItem.description`에만. 두 surface의 역할이 섞이지 않도록 회귀 가드 4종(IT-068b/072/072b/072c) 명시.

#### 범위 한정 (TODO §5.2)
- 본 릴리스는 TODO §5.2의 두 항목 중 **"단계별 진행 인디케이터"**만 구현합니다. **"단계 클릭 시 해당 task의 터미널/출력으로 점프"**는 의도적으로 제외 — VS Code 터미널 패널이 이미 항상 접근 가능해 추가 클릭 단계의 ergonomics 가치가 낮고, Action TreeItem을 펼쳐지는 트리로 만들면 기존 폴더(`Folder`)와 시각적 충돌 발생. Option B로의 전환 가능성은 향후 사용자 피드백으로 판단.

#### Medium — 1차 리뷰 후속 수정 (콜백 격리)
- **`onTaskTransition` 콜백을 try/catch로 격리**: 진행률 표시는 side channel이므로 콜백이 throw해도 파이프라인의 success/failure 의미가 바뀌면 안 됨. 이전 구현은 `success`/`failure`/`skipped`/`running` 4 callsite에서 직접 호출해, 예컨대 `success` 콜백이 throw하면 정상 task가 실패로 기록되는 회귀가 가능했음. `executeActionPipeline` 내부의 `emitTransition` helper에서 try/catch로 감싸 outputChannel에 `[WARN]`만 남기고 호출자에는 throw하지 않도록 수정. 회귀 가드: `IT-074` (success 경로에서 모든 콜백 throw해도 파이프라인 정상 완료), `IT-074b` (failure 경로에서 콜백 throw해도 task 원본 에러가 그대로 reject — `'callback boom'`이 아니라 `'capture failed'`).

**테스트**: 신규 9케이스 추가 (통합 9: IT-069 정상 시퀀스, IT-070 skipped, IT-071 failure 후 중단, IT-072 progress description 렌더, IT-072b 단일 task noise 회피, IT-072c partial state 방어, IT-073 finalize 자동 clear, IT-074 throwing 콜백 success 경로 격리, IT-074b throwing 콜백 failure 경로 원본 에러 보존). 전체 929 passing.

## [0.4.20] - 2026-04-30

### 추가 — History 패널의 "Last run" 배지 (TODO §5.4 일부)

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

#### 범위 한정 (TODO 5.4)
- 본 릴리스는 TODO §5.4의 두 항목 중 **"마지막 실행 결과 배지: ✓/✗ + 소요 시간"**만 구현합니다. **"빈도 기반 자동 정렬 또는 사용자 지정 핀"**은 의도적으로 제외 — 정렬·핀은 정책 결정이 더 큰 작업이므로 별도 PR에서 다룹니다.
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

#### 범위 한정 (TODO 5.3 일부)
- 본 릴리스는 TODO §5.3에서 제안한 두 모드 중 **"그대로 재실행"**만 구현합니다. **"수정해서 실행"**(저장값을 다이얼로그 기본값으로 prefill 후 사용자 편집)은 후속 작업으로 분리되어 [TODO.md](TODO.md) §5.3에 별도로 추적됩니다.

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
