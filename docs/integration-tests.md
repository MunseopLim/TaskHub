# Integration Test 시나리오

이 문서는 TaskHub의 integration test 시나리오를 한 곳에서 관리합니다.
단위 테스트는 각 소스와 짝을 이룬 `*.test.ts` 파일에 있고, 이 문서는 "여러 모듈이 실제로 연결되어 함께 동작하는가"를 검증하는 상위 레벨 시나리오의 인덱스입니다.

## 개요

- **실행**: `npm run test`
- **테스트 파일 위치**: [src/test/*Integration.test.ts](../src/test/)
- **최상위 진입점**: `executeActionPipeline(action, context, id, workspaceFolderPath, workspaceRoots)` — 실제 JSON 액션을 받아 전체 파이프라인을 실행합니다. `workspaceRoots`를 명시하면 테스트가 VS Code 워크스페이스에 의존하지 않습니다.
- **격리**: 각 테스트는 `os.tmpdir()` 아래 임시 워크스페이스를 생성/삭제하여 병렬 실행 및 반복 실행에 안전합니다.
- **크로스 플랫폼 shell**: 단일 라인은 `printf` (POSIX) / `cmd /c echo` (Windows), 다중 라인은 `node -e` + `args`를 사용합니다. `process.stdout.write(...)` 인자는 `JSON.stringify`로 만들어 셸 인용 문제를 회피합니다.

## 네이밍 규칙

- 시나리오 ID: `IT-XXX` (3자리 0 패딩)
- 테스트 이름: `IT-XXX: <요약>`
- 새 기능을 추가할 때 새 suite를 만들고, 이 문서의 **"시나리오 그룹"** 섹션에 항목을 추가합니다.

## 시나리오 그룹

### Output Capture + Pipeline Chaining
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-001 | shell capture → stringManipulation 체인 → 파일 쓰기 | 정규식 capture의 downstream 전달 + 파일 출력까지 end-to-end |
| IT-002 | 여러 capture 규칙 (array) | regex 3개 + `trim` 조합, 각 파생 변수가 모두 downstream에서 사용 가능 |
| IT-003 | line 인덱스 capture (음수 인덱스) | 다중 라인 출력에서 `-1`로 마지막 라인 선택 |
| IT-004 | stringManipulation 출력에서 capture | shell 외 태스크 타입에서도 `output.capture` 동작 확인 |
| IT-005 | capture miss는 실행을 막지 않음 | 매칭 실패 시 조용히 skip, 나머지 파이프라인 정상 진행 |
| IT-005b | capture miss가 stdout으로 대체되지 않음 | 실패한 파생 변수는 셸 인자 자리에서도 `${...}` 리터럴로 남음 |
| IT-006 | captured 값을 `output.filePath`에 사용 | 파생 변수가 같은 태스크의 파일 쓰기 경로로도 치환됨 |
| IT-007 | 예약된 capture name은 실행 시 에러 | 설정 오류 실패 경로 (`Task '<id>' capture failed: ...`) |
| IT-008 | 잘못된 정규식은 실행 시 에러 | 설정 오류 실패 경로 |

### Command Execution + Workspace Safety
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-009 | command args/cwd/env interpolation | upstream capture가 `env`에 치환되고, `cwd`와 args가 실제 child process 실행에 반영됨 |
| IT-010 | workspace 밖 file output 거부 | `resolveWithinWorkspace` 보안 경계가 pipeline file output에서도 적용됨 |
| IT-011 | overwrite 없는 기존 파일 쓰기 거부 | 기존 파일 보호 동작과 실패 메시지 |
| IT-012 | `overwrite` 문자열 변수 평가 | `${task.output}` 형태의 문자열 boolean이 `true`로 평가되어 overwrite 허용 |
| IT-013 | 실패한 shell task가 downstream 중단 | 실패 exit code/stderr가 reject되고 이후 task가 실행되지 않음 |
| IT-014 | relative `filePath` 해석 | 상대 경로 output이 action workspace 기준으로 생성됨 |

### Interactive Task Pipeline
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-015 | quickPick → inputBox → file output | quickPick 결과가 inputBox prompt/prefix와 downstream interpolation에 전달됨 |
| IT-016 | quickPick 다중 선택 | `value`와 `values`가 downstream에서 각각 사용 가능 |
| IT-108 | quickPick `itemsFromCommand` + `itemsExclude` | 셸 명령 stdout의 각 비어 있지 않은 줄이 항목이 되고, `itemsExclude`가 지정 줄(`origin/HEAD`)을 제거하며, 선택값이 downstream에 전달됨 |
| IT-109 | inputBox `extractPattern` + `validatePattern` | 보간된 `value`(브랜치 이름)에서 Jira 키를 추출해 기본값으로 채우고, `validateInput`이 잘못된 형식은 거부·정상 형식은 통과시킴 |
| IT-017 | confirm 취소 중단 | 사용자가 취소한 confirm task가 pipeline을 중단하고 이후 task를 실행하지 않음 |
| IT-033 | envPick 목록 노출·선택 전달 | 사용자 셸이 노출하는 이름만 정렬되어 QuickPick 에 나오고 (`VSCODE_*` 등 확장 호스트 전용 변수는 필터링), 선택된 이름이 downstream 에 전달됨 |
| IT-033b | envPick 실제 프로브가 확장 호스트 전용 변수를 걸러낸다 (stub 없음) | IT-033 은 목록을 stub 으로 주입한다. 이쪽은 **실제 셸을 띄워** 이름을 수집하므로, 필터가 실전 입력에도 듣는지를 본다 |
| IT-034 | envPick 취소 중단 | 사용자가 취소한 envPick task 가 pipeline 을 중단하고 이후 task 를 실행하지 않음 |

### Dialog + Output Mode Pipeline
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-018 | fileDialog → folderDialog → stringManipulation → 파일 쓰기 | VS Code dialog 결과의 `path/name/fileExt/dir`가 downstream에서 조합되고 상대 output path가 workspace 기준으로 생성됨 |
| IT-019 | editor output mode | `output.mode: "editor"`가 language와 `output.content` interpolation을 적용해 실제 editor 문서를 엶 |
| IT-020 | command task + platform command + output.content override | `type: "command"`의 OS별 command 선택, args 실행, 이전 task 변수 기반 `output.content` override가 함께 동작 |

### View Provider Integration
파일: [src/test/viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-021 | LinkViewProvider workspace JSON lazy load | `.vscode/links.json` 로딩, group 정렬, link 정렬, tag/sourceFile 보존, view title 갱신 |
| IT-022 | FavoriteViewProvider workspace JSON lazy load | `.vscode/favorites.json` 로딩, line/tags normalization, workspaceFolder/sourceFile 보존, view title 갱신 |
| IT-023 | MainViewProvider TreeItem 구성 | version/folder/separator/action TreeItem 구성, folder expanded state, action run-state icon/context 반영 |
| IT-039 | stale favorite 제거 — disk 반영 | `removeFavoriteByIdentity` 로 하나만 제거 후 `serializeFavorites` 직렬화·재로드 시 나머지 항목의 순서·group·tags 보존 |
| IT-040 | 동일 path·title, 다른 line 구분 | 같은 파일의 서로 다른 줄 북마크가 `line` 을 기준으로 정확히 하나만 제거됨 |
| IT-041 | 매칭 없는 target 은 no-op | 식별자 4종 중 하나라도 어긋나는 target 은 기존 리스트를 그대로 반환 |
| IT-042 | 동일 path·title, 다른 group 구분 | `group` 이 다르면 별개 항목으로 취급되어 target 만 제거 |
| IT-083 | 액션마다 `taskhub.runAction.<id>` 동적 등록 | `syncActionCommandsFromActions`가 action에는 커맨드를 등록하고 folder/separator(액션 정의 없음)에는 등록하지 않는다 |
| IT-084 | 액션 제거 시 커맨드 dispose | 두 액션을 등록한 뒤 하나를 빼고 다시 sync 하면 사라진 액션의 등록만 disposed되고 살아남은 등록은 그대로 |
| IT-085 | 액션 id 변경은 옛 등록 dispose + 새 등록 register | `old.id` → `new.id` 변경 후 registry size가 1로 유지되어 leak 없음 |
| IT-086 | command id 스킴 = bijective percent-encoding | `buildActionCommandId`가 `taskhub.runAction.<id>` 프리픽스를 유지하면서 `[A-Za-z0-9_.-]`는 그대로, 그 외 UTF-8 바이트는 `%HH`로 인코딩. 안전 ID는 round-trip 무변화 + 불안전 ID(`a/b` vs `a:b`)는 distinct 출력으로 collision 차단. `%` 자체도 인코딩되어 reversible. 1차 리뷰 후속 수정의 핵심 회귀 가드 |

### Archive Task Pipeline
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-024 | zip → unzip 왕복 (외부 tool) | `zip` 태스크가 tool 호출로 archive를 만들고, 다음 `unzip` 태스크가 같은 archive를 풀어 source 정보가 복원됨 |
| IT-025 | 빌트인 엔진은 .zip이 아닌 아카이브를 거부 | `tool`을 생략하고 `.7z` 등 비-zip 확장자를 넘기면 "Built-in engine only supports .zip archives" 에러로 즉시 중단 |
| IT-035 | 빌트인 zip → 빌트인 unzip 왕복 | `tool`을 생략하면 번들 내장 엔진으로 .zip을 만들고 다시 풀어 원본 파일 내용이 그대로 복원됨 |
| IT-036 | 빌트인 zip 디렉터리 재귀 포함 | 디렉터리 source는 basename을 최상위 폴더로 유지한 채 하위 파일까지 재귀적으로 아카이브에 포함됨 |
| IT-037 | 빌트인 unzip zip-slip 방어 | 엔트리 이름이 대상 디렉터리를 벗어나도록 조작된 악성 아카이브는 추출 전에 거부되고, 대상 밖 경로에는 어떤 파일도 생성되지 않음 |
| IT-038 | 빌트인 엔진 pipeline 변수 치환 | `archive`에 `${task_id.output}` 같은 변수 참조가 섞여 있어도 외부 tool 경로와 동일하게 치환되어 예상 경로에 아카이브가 생성됨 |

### Terminal Output Mode
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-026 | terminal mode 터미널 생성·재사용 | `output.mode: "terminal"`이 첫 호출에서 터미널을 만들고 같은 actionId의 다음 호출에선 재사용 + header/content 2라인 씩 기록 |

### Action Lifecycle Messaging
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-027 | 성공 경로의 successMessage + history | `executeAction` 성공 후 `successMessage`가 `showInformationMessage`로 표시되고, HistoryProvider 기록이 running → success로 갱신 |
| IT-028 | 실패 경로의 failMessage + history | 태스크 실패 후 `failMessage: <error>` 포맷이 `showErrorMessage`로 표시되고, HistoryProvider에 failure + output 메시지가 남음 |

### History Input Replay
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-063 | 인터랙티브 task 결과가 history entry.inputs에 누적 | `executeAction`이 `inputBox`/`quickPick` 등 인터랙티브 task 결과를 task id를 키로 entry.inputs에 모으고, 비인터랙티브 task는 포함하지 않음 |
| IT-064 | presetInputs로 재실행하면 다이얼로그를 열지 않음 | `executeActionPipeline`에 `presetInputs`를 넘기면 매칭되는 task id의 핸들러가 스킵되고 저장된 값이 그대로 result로 사용되어 downstream interpolation이 동작 |
| IT-065 | `password: true` inputBox는 inputs에 저장되지 않음 | 비밀번호 task의 입력값은 `recordInputs`에 누적되지 않으며, history entry 직렬화에 비밀 문자열이 포함되지 않음 |
| IT-066 | 재실행 시에도 인터랙티브 task의 output 후처리가 실행됨 | preset이 type-specific dispatch를 우회하더라도 공통 후처리(capture + `passTheResultToNextTask` output 처리)는 그대로 실행되어 `output.mode: 'file'` 등이 정상 작동 |

### Last-run 배지
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) (IT-067), [src/test/viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts) (IT-068, IT-068b)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-067 | executeAction은 success/failure 모두 durationMs를 기록 | success 경로와 capture 실패로 reject되는 failure 경로 모두에서 `HistoryEntry.durationMs`가 비음수 정수로 저장됨 |
| IT-068 | HistoryItem.description에 시각 + 소요 시간 배지가 노출되고, 상태는 아이콘/aria 라벨로 표시 | 종료된 entry는 `시각 · 소요시간` 형태로 description이 채워지고(상태 글리프 없음), 색 아이콘 `pass`/`error`가 status를 시각적으로 전달하며, `accessibilityInformation.label`이 status 단어를 텍스트로 포함해 스크린 리더 패리티를 유지. 진행 중(`running`) entry는 description은 비어 있어도 aria 라벨에 "실행 중"/"running"이 들어감 |
| IT-068b | Action TreeItem에는 last-run 배지가 없다 | History 패널로 이동한 배지가 실수로 Actions 패널에 다시 추가되는 회귀를 가드 |

### Task 진행률
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) (IT-069/070/071/073/074/074b), [src/test/viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts) (IT-072/072b/072c/072d/072e)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-069 | 모든 task 성공 시 running → success 쌍이 순서대로 발사 | `executeActionPipeline`의 `onTaskTransition`이 task별로 `running` 후 `success` 두 이벤트를 1-based index와 total로 정확히 emit |
| IT-070 | continueOnError 실패 task는 skipped, 나머지는 success | `continueOnError: true`로 capture가 실패해도 `skipped` transition만 발사하고 다음 task가 정상 실행 |
| IT-071 | 실패 task(continueOnError 없음) 후 파이프라인 중단 | `failure` transition 발사 후 throw — 이후 task는 어떤 transition도 발사하지 않음 |
| IT-072 | 멀티 task 액션 running 시 progress description 노출 | `actionStates.progress`가 채워진 멀티 task 액션은 `2/3 · taskId` 형태 description 렌더 |
| IT-072b | 단일 task 액션은 progress description을 채우지 않음 | `total === 1`이면 description undefined — `1/1` 노이즈 회피 |
| IT-072c | progress 없는 running 상태에서도 description은 비어 있음 | `actionStates.state === 'running'`이지만 `progress`가 없을 때 description 비어 있음 (legacy/manual 분기 방어) |
| IT-072d | 두 개 이상 task 가 동시 running 이면 multi-track 라벨 | 병렬 실행에서 한 track 만 보여 주면 진행 상황을 오독한다 |
| IT-072e | 3개 이상 동시 running 은 `+ N` overflow 로 자름 | description 이 무한히 길어져 트리를 밀어내지 않게 |
| IT-073 | executeAction 종료 후 actionStates.progress 비움 | `finalizeActionRun`이 mid-run progress를 clear해 종료 후 description이 잔존하지 않음 |
| IT-074 | throwing onTaskTransition은 success 경로 결과를 바꾸지 않음 | 4개 transition(`running`/`success`) 모두에서 콜백이 throw해도 파이프라인이 정상 resolve. `emitTransition` helper의 try/catch 격리 회귀 가드 |
| IT-074b | throwing onTaskTransition은 failure 경로의 원본 에러를 가리지 않음 | failure transition에서 콜백이 throw해도 reject되는 에러는 task의 원본 에러(`'capture failed'`)이지 콜백 에러(`'callback boom'`)가 아님 |

### Problem Matcher / 진단 통합
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) (IT-075/076/077/078/079/080/081/082). 단위 테스트는 [src/test/diagnosticMatcher.test.ts](../src/test/diagnosticMatcher.test.ts).

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-075 | `$gcc` 매처가 stdout을 파싱해 Problems 패널에 진단 등록 | shell task의 `output.diagnostics: "$gcc"`가 file/line/col/severity/message를 정확히 추출하고 `vscode.languages.getDiagnostics(uri)`에 노출 |
| IT-076 | 같은 액션 재실행 시 이전 진단 자동 clear | `executeAction` 시작 시 `clearActionDiagnostics`가 호출되어, 첫 실행에서 등록된 진단이 두 번째 깨끗한 실행으로 모두 제거됨 |
| IT-077 | 상대 경로는 task `cwd` 기준으로 해석 | 컴파일러가 `relpath.c`처럼 상대 경로를 출력해도 `cwd: subDir`이 설정된 task에서는 정확히 `subDir/relpath.c`로 진단이 등록되고, workspace 루트로 잘못 해석되지 않음 |
| IT-078 | `passTheResultToNextTask: false`에서 진단 emission이 silent skip | 스트림 모드는 stdout이 캡처되지 않아 매칭할 출력이 없으므로 진단을 등록하지 않음 (verbose 로그 경고만 — 다른 동작에 영향 없음) |
| IT-079 | non-zero exit 빌드 실패에서도 진단 등록 (1차 리뷰 High) | gcc/clang 등이 stderr에 진단을 쓰고 exit code 1로 종료하는 정상 빌드 실패 케이스. `ShellCommandError`가 stdout/stderr를 보존해 매처가 적용된 뒤 원본 에러가 re-throw — action은 failure로 기록되면서 진단도 함께 등록 |
| IT-080 | 진단 cwd는 interpolated된 cwd 사용 (1차 리뷰 Medium) | `cwd: "${workspaceFolder}/subdir"` 같이 변수가 들어간 경로의 task에서, 상대 경로 진단이 *interpolated된* 경로 기준으로 resolve되어 정확한 위치에 등록 — raw task.cwd 문자열을 그대로 쓰면 안 됨 |
| IT-081 | exit 0 + stderr warning에서도 진단 등록 (2차 리뷰 Medium) | gcc/clang이 warning만 있을 때 흔한 패턴(exit 0 + stderr 출력). `executeShellCommand`가 성공 경로에서도 `{stdout, stderr}` 튜플로 resolve하고, post-processing 진단 블록이 둘을 합쳐 매처에 통과 — IT-079(failure 경로)와의 비대칭 해소 |
| IT-082 | 같은 액션의 여러 task가 같은 파일에 진단을 내면 모두 보존 (3차 리뷰 Medium) | `collection.set(uri, ...)`은 해당 URI의 기존 entry를 *replace*하는 의미라 sibling task가 같은 파일에 진단 내면 앞 task가 덮였음. `collection.get(uri)`로 먼저 읽어 concat 후 set하도록 수정. 액션 시작 시 clear는 이전 run에만 적용되므로 같은 run의 누적은 보존 |

### History label disambiguation
파일: [src/test/viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-087 | 같은 title이 두 폴더에 있을 때 풀 경로로 disambiguate | `Firmware/Build` + `Bootloader/Build`가 history에 동시 존재 → 두 `HistoryItem` 라벨이 각각 `Firmware > Build` / `Bootloader > Build`로 스왑. 비충돌 entry는 짧은 title 유지 |
| IT-087b | 같은 actionId의 반복 실행은 충돌로 치지 않음 | `actionId`가 동일한 entry가 여러 개 있어도 distinct id 카운트가 1이므로 라벨은 짧은 title 그대로 — 흔한 재실행에서 노이즈 회피 |
| IT-087c | 레거시 entry(actionPath 부재)는 충돌 시 `Title (actionId)`로 폴백 | actionPath가 없는 기존 entry는 path 를 못 그리지만 distinct-id 불변은 유지 — `Build (old)` 형태로 actionId 를 붙여 같이 있는 신규 colliding entry(`Firmware > Build`)와 구별 |
| IT-087d | distinct actionId가 같은 actionPath를 가지면 `(actionId)` suffix로 disambiguate | step 1 의 path swap 만으로는 `Firmware > Build` 가 두 row 에 모두 남아 시각적 구별 불가. 2-pass 가드가 같은 path-joined 라벨에 distinct id 가 둘 이상일 때 모든 멤버에 `(<actionId>)` 를 붙이고, 툴팁의 path 줄도 동일한 disambiguated 텍스트로 채움 |
| IT-087e | 두 root-level 액션이 같은 title을 가지면 `Title (actionId)`로 disambiguate | root entry 의 `actionPath` 는 `['Build']` 한 원소뿐이라 breadcrumb swap 으로는 의미 있는 신호가 안 나옴. step 1 의 path-less collision 폴백이 `Build (root.build.a)` 형태로 actionId 를 붙여 두 row 를 구별. 툴팁의 path 줄도 동일하게 갱신 |

### Task Output Flow
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-029 | passTheResultToNextTask=false | 결과 전달이 꺼진 task의 `${task.output}`/`${task.*}`는 downstream에서 interpolation되지 않고 `${...}` 리터럴로 남음 |
| IT-030 | stringManipulation 경로 연산 체인 | `basename`/`basenameWithoutExtension`/`stripExtension`/`dirname`/`extension` 다섯 연산이 한 파이프라인에서 교차 사용됨 |

### Pipeline Error Handling
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-031 | 지원하지 않는 task type | `executeSingleTask` 기본 분기의 `Unsupported task type: <type>` 에러 |
| IT-032 | shell 태스크 command 누락 | `command` 없이 `shell` 태스크 실행 시 `Task <id> of type 'shell' requires a 'command' property.` 에러 |

### writeFile / appendFile
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-043 | writeFile 변수 치환 | `${task.output}` 치환된 content가 그대로 파일로 저장되고, 상위 디렉터리가 자동 생성됨 |
| IT-044 | writeFile workspace escape 거부 | `../escape.txt` 같은 워크스페이스 외부 경로는 `outside the current workspace` 에러로 거부됨 |
| IT-045 | overwrite=false는 기존 파일 보호 | 대상 파일이 이미 존재하면 `refused to overwrite` 에러로 즉시 중단되고 원본 내용 보존 |
| IT-046 | overwrite 기본값=true | overwrite 미지정 시 기존 파일을 덮어씀 |
| IT-047 | mkdirs 기본값=true | 깊이 3단계 이상의 누락된 상위 디렉터리도 자동 생성됨 |
| IT-048 | mkdirs=false는 부재 디렉터리 거부 | 상위 디렉터리가 없을 때 `parent directory does not exist` 에러 |
| IT-049 | EOL 정규화 (lf, crlf) | CRLF 입력을 lf로, LF 입력을 crlf로 정규화하며 CRCRLF로 doubling되지 않음 |
| IT-050 | utf8bom 인코딩 | 파일 선두에 정확히 0xEF 0xBB 0xBF가 기록되고 그 뒤에 UTF-8 본문 |
| IT-051 | appendFile 기본 이어쓰기 | 기존 파일 끝에 content가 추가됨 |
| IT-052 | appendFile + utf8bom 신규 파일 | 대상이 없으면 첫 append에 BOM이 추가됨 |
| IT-053 | appendFile + utf8bom 기존 파일 | 기존 파일 중간에 BOM이 삽입되지 않음 |
| IT-054 | `${task.path}` downstream 참조 | writeFile 결과의 path 변수가 다음 stringManipulation 입력으로 그대로 들어감 |
| IT-055 | path 누락 즉시 에러 | `requires a non-empty 'path' property` 에러 |
| IT-056 | content 누락 즉시 에러 | `requires a 'content' property` 에러 |

### continueOnError
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-057 | 실패 task 다음으로 흐름 진행 | `continueOnError: true`인 실패 task가 throw하지 않고 다음 task가 정상 실행 |
| IT-058 | skip된 task의 변수는 unresolved literal | 결과가 `{}`로 저장되어 downstream의 `${skipped.path}`가 리터럴로 남음 |
| IT-059 | 기본값(false)은 첫 실패에서 중단 | 옵션 없이 실패 시 기존처럼 throw하고 다음 task는 실행되지 않음 |

### timeoutSeconds
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-060 | shell 프로세스 timeout 종료 | `sleep 10` 같은 장기 프로세스가 0.5초 budget을 넘기면 `timed out after 0.5s` 에러로 즉시 종료 (실제로 10초 기다리지 않음) |
| IT-061 | 충분한 budget은 정상 완료 | 30초 budget 내에 끝나는 writeFile은 timeout 발동 없이 결과 저장 |
| IT-062 | timeout + continueOnError 조합 | timeout으로 실패해도 continueOnError가 true면 다음 task가 실행됨 |


## 추가 시나리오 그룹

최근 회귀 테스트는 그룹별 계약만 기록합니다. 세부 입력과 기대값의 정본은 표에 연결한 테스트 파일의 `test()`와 `assert`입니다.

| ID | 파일 | 그룹 계약 |
| --- | --- | --- |
| IT-088, IT-089, IT-090, IT-091, IT-092, IT-098, IT-099, IT-100, IT-102, IT-103, IT-104, IT-105, IT-106, IT-107 | [viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts) | Quick Action Palette가 실행 가능한 액션만 평면화하고, 폴더 경로·MRU·recent limit·빈 목록·로드 오류를 구분 |
| IT-110, IT-111, IT-112, IT-113, IT-114, IT-115, IT-116 | [pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) | 보간 완료 명령줄을 성공·실패 History에 기록하고, 저장 입력이 있을 때만 대화형 태스크를 건너뜀 |
| IT-117, IT-118 | [pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) | 다이얼로그 위치를 액션 ID + 태스크 ID + 종류별로 분리하고 파일은 부모 폴더, 폴더는 선택 자체를 기억 |
| IT-119, IT-120, IT-121, IT-122, IT-147, IT-148, IT-149 | [wizardCreateFlow.test.ts](../src/test/wizardCreateFlow.test.ts) | 생성 마법사의 ID 변경·저장·바로 실행·취소·상세 검토·알림 닫기 복구를 명령 종단까지 검증 |
| IT-123, IT-124, IT-125 | [stopInteractive.test.ts](../src/test/stopInteractive.test.ts) | inputBox·quickPick 대기 중 중지가 프롬프트와 뒤 태스크를 끝내고 실행별 취소 스코프를 정리 |
| IT-126, IT-127, IT-128, IT-129, IT-130, IT-131, IT-132, IT-133, IT-134, IT-135, IT-136, IT-137, IT-138, IT-139, IT-140, IT-141, IT-145 | [stopInteractive.test.ts](../src/test/stopInteractive.test.ts) | 모든 대화형·프로세스 경로의 중지, 자손 종료, `continueOnError`, 비밀 마스킹, `cancelKind`, 진행도 경계를 검증 |
| IT-142, IT-143, IT-144, IT-146, IT-153, IT-154 | [pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) | 내장·외부 zip/unzip의 상대 경로·`cwd`·OS별 tool·`${extensionPath}` 해석을 같은 기준으로 유지 |
| IT-150 | [pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) | 배열 필드가 없는 옛 History 입력도 단일 선택의 `paths`·`names`·`count`를 복원 |
| IT-151, IT-152 | [pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) | 파일·폴더 다중 선택이 배열 결과와 개별 argv를 보존 |

IT-093~IT-097은 MRU를 별도 저장하던 구현이 제거되면서 함께 삭제된 번호이며 재사용하지 않습니다.

## Memory Map 픽스처와 커버리지 경계

| 입력 | 반드시 여는 렌더링 분기 |
| --- | --- |
| `buildMinimalElf32()` | Overview, All Sections |
| `buildElf32WithSymbols()` | region 상세, Object Summary |
| `examples/sample_armlink.txt` | `func` 열, Function 토글 |

Memory Map 테스트는 다음 규칙을 지킵니다.

1. HTML 내용을 검사하기 전에 `region-card`·`toggle-func-col`처럼 목표 분기가 실제로 렌더됐는지 단언합니다.
2. ELF 픽스처의 심볼·섹션·영역 전제는 [elfFixtures.test.ts](../src/test/elfFixtures.test.ts)에서 따로 검사하고, 생성 코드는 [elfFixtures.ts](../src/test/fixtures/elfFixtures.ts) 한 벌로 공유합니다.
3. `func`는 ARM Listing만 채우므로 Function 열은 Listing 픽스처로 검사합니다. 실행 중 `innerHTML`로 조립되는 마크업은 정적 HTML 문자열 검사 범위 밖이므로 별도 동작 테스트나 리뷰가 필요합니다.
## 시나리오 추가 절차

1. 새 기능의 integration 측면이 생기면 이 문서의 "시나리오 그룹" 표에 먼저 한 줄 요약을 추가합니다.
2. 필요한 경우 "상세" 섹션에 기대 동작과 비자명한 제약(예: IT-006의 filePath 타이밍)을 남깁니다.
3. 테스트 파일에 `IT-XXX: <요약>` 네이밍으로 테스트를 추가합니다.
4. 테스트가 깨지면 **먼저 이 문서의 시나리오를 점검**하세요 — 스펙 해석 차이일 수 있습니다.
