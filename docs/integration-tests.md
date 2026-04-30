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
| IT-017 | confirm 취소 중단 | 사용자가 취소한 confirm task가 pipeline을 중단하고 이후 task를 실행하지 않음 |
| IT-033 | envPick 목록 노출·선택 전달 | `process.env` 의 모든 이름이 정렬되어 QuickPick 에 나오고, 선택된 이름이 downstream 에 전달됨 |
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

### Last-run 배지 (TODO §5.4)
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) (IT-067), [src/test/viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts) (IT-068, IT-068b)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-067 | executeAction은 success/failure 모두 durationMs를 기록 | success 경로와 capture 실패로 reject되는 failure 경로 모두에서 `HistoryEntry.durationMs`가 비음수 정수로 저장됨 |
| IT-068 | HistoryItem.description에 status + 시각 + 소요 시간 배지가 노출 | 종료된 entry는 `✓/✗ 시각 · 소요시간` 형태로 description이 채워지고, 진행 중(`running`) entry는 description이 비어 있음 (스피너 아이콘이 신호 역할) |
| IT-068b | Action TreeItem에는 last-run 배지가 없다 | History 패널로 이동한 배지가 실수로 Actions 패널에 다시 추가되는 회귀를 가드 |

### Task 진행률 (TODO §5.2)
파일: [src/test/pipelineIntegration.test.ts](../src/test/pipelineIntegration.test.ts) (IT-069/070/071/073/074/074b), [src/test/viewProviderIntegration.test.ts](../src/test/viewProviderIntegration.test.ts) (IT-072/072b/072c)

| ID | 제목 | 핵심 검증 |
| --- | --- | --- |
| IT-069 | 모든 task 성공 시 running → success 쌍이 순서대로 발사 | `executeActionPipeline`의 `onTaskTransition`이 task별로 `running` 후 `success` 두 이벤트를 1-based index와 total로 정확히 emit |
| IT-070 | continueOnError 실패 task는 skipped, 나머지는 success | `continueOnError: true`로 capture가 실패해도 `skipped` transition만 발사하고 다음 task가 정상 실행 |
| IT-071 | 실패 task(continueOnError 없음) 후 파이프라인 중단 | `failure` transition 발사 후 throw — 이후 task는 어떤 transition도 발사하지 않음 |
| IT-072 | 멀티 task 액션 running 시 progress description 노출 | `actionStates.progress`가 채워진 멀티 task 액션은 `2/3 · taskId` 형태 description 렌더 |
| IT-072b | 단일 task 액션은 progress description을 채우지 않음 | `total === 1`이면 description undefined — `1/1` 노이즈 회피 |
| IT-072c | progress 없는 running 상태에서도 description은 비어 있음 | `actionStates.state === 'running'`이지만 `progress`가 없을 때 description 비어 있음 (legacy/manual 분기 방어) |
| IT-073 | executeAction 종료 후 actionStates.progress 비움 | `finalizeActionRun`이 mid-run progress를 clear해 종료 후 description이 잔존하지 않음 |
| IT-074 | throwing onTaskTransition은 success 경로 결과를 바꾸지 않음 | 4개 transition(`running`/`success`) 모두에서 콜백이 throw해도 파이프라인이 정상 resolve. `emitTransition` helper의 try/catch 격리 회귀 가드 |
| IT-074b | throwing onTaskTransition은 failure 경로의 원본 에러를 가리지 않음 | failure transition에서 콜백이 throw해도 reject되는 에러는 task의 원본 에러(`'capture failed'`)이지 콜백 에러(`'callback boom'`)가 아님 |

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

## 상세

각 시나리오의 세부 태스크 구성·기대값은 테스트 파일의 주석과 `assert` 문을 정본으로 삼습니다. 이 문서는 의도·커버리지 맵이며, 구현 디테일은 코드에 둡니다.

### IT-001: shell capture → stringManipulation 체인 → 파일 쓰기

shell 태스크의 stdout을 정규식으로 캡처해 파생 변수로 만들고, 이어지는 두 `stringManipulation` 태스크에서 가공한 뒤 마지막 태스크가 `output.mode: "file"`로 파일을 씁니다. 핵심은 **한 파이프라인 안에서 capture → interpolation → file 쓰기까지 모든 단계가 실제로 연결되는가**입니다.

### IT-002: 여러 capture 규칙 (array)

한 shell 태스크의 multi-line 출력에 대해 regex 3개를 배열로 지정하여 `sha`, `author`, `ver` 세 파생 변수를 동시에 만들고, 다음 태스크에서 세 개 모두 interpolation에 사용합니다. `trim` 플래그가 regex 이후에 적용되는지도 확인합니다.

### IT-003: line 인덱스 capture (음수 인덱스)

3줄짜리 출력에서 `line: -1`로 마지막 라인만 뽑습니다. `node -e "process.stdout.write(JSON.stringify한_텍스트)"`로 라인 구분자를 안정적으로 만드는 패턴도 여기서 처음 사용합니다.

### IT-004: stringManipulation 출력에서 capture

`stringManipulation`은 `passTheResultToNextTask` 없이도 `{ output: string }`을 반환합니다. `toUpperCase` 결과에 regex를 적용해 버전 숫자만 뽑는 시나리오로 **capture가 shell 외 태스크 타입에도 동일하게 적용되는지** 확인합니다.

### IT-005: capture miss는 실행을 막지 않음

두 개의 규칙 중 하나는 매칭되고(`hit`), 하나는 `line: 5`로 실패합니다. 실패한 규칙은 조용히 skip되고 파이프라인은 성공하며, 성공한 `hit` 변수만 downstream에서 보이는 것을 검증합니다. (미매칭 변수는 이 PR에서는 `${...}` literal로 남지 않는 대신 기존 interpolation의 폴백 동작을 따릅니다 — 상세는 코드 주석 참고.)

### IT-006: captured 값을 `output.filePath`에 사용

shell capture로 얻은 파생 변수(`name`)를 같은 태스크의 `output.filePath`에는 **쓸 수 없고** (capture 적용이 filePath interpolation보다 늦음), 다음 태스크의 `filePath`에만 사용 가능하다는 제약을 문서화합니다. 테스트는 "다음 태스크에서 filePath 치환이 되는" 쪽만 검증합니다.

### IT-007: 예약된 capture name은 실행 시 에러

`name: "output"` 처럼 내장 키와 충돌하는 이름을 쓰면 `applyOutputCapture`가 던지는 에러가 `executeSingleTask`에서 `Task '<id>' capture failed: ...` 로 래핑되어 파이프라인이 거부합니다. `assert.rejects`로 검증.

### IT-008: 잘못된 정규식은 실행 시 에러

`regex: "("` 같이 파싱 불가능한 패턴은 `new RegExp()` 호출 단계에서 즉시 에러를 던지고, 실행이 중단됩니다.

### IT-009: command args/cwd/env interpolation

첫 task가 `target=release`를 capture하고, 다음 `node` task가 `cwd`, `args`, `env`를 모두 사용해 child process로 실행됩니다. `env` 값에는 `${discover.target}`를 넣어 실제 실행 환경 변수로 전달되는지 확인합니다.

### IT-010: workspace 밖 file output 거부

`output.mode: "file"`의 대상 경로가 테스트 workspace 밖이면 `resolveWithinWorkspace`가 거부해야 합니다. 이 시나리오는 pipeline의 파일 쓰기가 단위 유틸리티와 동일한 보안 경계를 따르는지 확인합니다.

### IT-011: overwrite 없는 기존 파일 쓰기 거부

기존 파일이 있을 때 `overwrite: true`가 없으면 pipeline은 실패해야 하고, 기존 파일 내용은 유지되어야 합니다.

### IT-012: `overwrite` 문자열 변수 평가

앞선 task의 출력이 `"TRUE"`일 때 다음 task의 `output.overwrite: "${allow.output}"`이 boolean `true`로 해석되는지 확인합니다. 대소문자는 무시합니다.

### IT-013: 실패한 shell task가 downstream 중단

`node -e`로 stderr를 쓰고 non-zero exit code로 종료하는 task를 실행합니다. 이후 파일 쓰기 task가 실행되지 않아야 하며, reject 메시지에는 stderr가 포함되어야 합니다.

### IT-014: relative `filePath` 해석

`output.filePath`가 `nested/out.txt` 같은 상대 경로이면 action workspace 기준으로 해석되어 workspace 내부에 파일이 생성되어야 합니다.

### IT-015: quickPick → inputBox → file output

테스트에서 VS Code UI API를 stub 처리해 quickPick 선택값을 만든 뒤, 그 값을 inputBox의 prompt/prefix에서 사용합니다. 최종 파일은 `${target.value}`가 올바르게 조합된 값을 받는지 검증합니다.

### IT-016: quickPick 다중 선택

`canPickMany: true`인 quickPick 결과가 `${features.value}`에는 첫 번째 선택, `${features.values}`에는 쉼표로 연결된 전체 선택으로 노출되는지 확인합니다.

### IT-017: confirm 취소 중단

confirm task에서 취소 라벨이 선택되면 pipeline이 reject되고 다음 task가 실행되지 않아야 합니다.

### IT-033: envPick 목록 노출·선택 전달

`showQuickPick` 을 stub 처리해 `envPick` 이 실제로 어떤 items 를 넘기는지 가로챕니다. 테스트용 sentinel 환경변수를 설정한 뒤, `Object.keys(process.env)` 가 알파벳 순서로 정렬되어 items 로 전달되고 sentinel 이름이 그 안에 포함되는지 확인합니다. 선택된 이름은 `${pick.value}` 로 downstream `stringManipulation` 태스크에 전달되어 파일로 기록되어야 합니다.

### IT-034: envPick 취소 중단

`showQuickPick` 을 `undefined` 반환으로 stub 처리해 사용자가 취소한 상황을 모사합니다. `envPick` 핸들러가 "canceled" 에러를 던져 파이프라인이 reject 되고, 이후 `stringManipulation` 태스크가 만들 예정이던 파일이 실제로는 생성되지 않는지 확인합니다.

### IT-018: fileDialog → folderDialog → stringManipulation → 파일 쓰기

테스트에서 `showOpenDialog`를 stub 처리해 파일 선택과 폴더 선택을 순서대로 반환합니다. `fileDialog`가 만든 `path`, `dir`, `name`, `fileNameOnly`, `fileExt`와 `folderDialog`가 만든 `path`가 다음 task의 interpolation에 노출되고, 마지막 file output은 상대 경로를 workspace 기준으로 해석해야 합니다.

### IT-019: editor output mode

`stringManipulation` 결과를 만든 뒤 다음 task의 `output.mode: "editor"`가 untitled editor 문서를 실제로 엽니다. 이때 `output.language`가 문서 언어로 적용되고, `output.content`는 이전 task 결과를 기준으로 interpolation됩니다. 같은 task의 새 output은 아직 interpolation context에 없다는 현재 실행 순서도 간접적으로 고정합니다.

### IT-020: command task + platform command + output.content override

`type: "command"`가 `shell`과 같은 capture/파일 출력 경로를 공유하되, `command` object에서 현재 OS용 명령을 선택하는지 확인합니다. child process stdout은 존재하지만 `output.content`가 지정되어 있으므로 파일에는 이전 task에서 capture한 값만 기록되어야 합니다.

### IT-021: LinkViewProvider workspace JSON lazy load

임시 workspace folder source를 provider에 주입한 뒤 `.vscode/links.json`을 읽습니다. 생성자에서는 읽지 않고 `getChildren()` 시점에 lazy load되어야 하며, group node가 먼저 정렬되고 group 내부 link도 제목순으로 정렬됩니다. tag normalization, `sourceFile`, view title count도 함께 검증합니다.

### IT-022: FavoriteViewProvider workspace JSON lazy load

임시 workspace의 `.vscode/favorites.json`을 통해 favorites provider가 workspace folder source와 연결되는지 확인합니다. line number는 정수 양수로 normalization되고, tag trimming, `workspaceFolder`, `sourceFile`, group/ungrouped node 구성과 view title count가 보존되어야 합니다.

### IT-023: MainViewProvider TreeItem 구성

`loadActions` callback이 반환한 mixed action tree를 실제 `MainViewProvider`에 넣습니다. version item, expanded folder, separator, action item이 올바르게 만들어지고, `actionStates`에 저장된 success 상태가 action icon/contextValue로 반영되는지 확인합니다.

### IT-024: zip → unzip 왕복으로 source manifest가 복원됨

`getToolCommand`가 사용자 지정 tool을 실행하는지와 `handleZip`/`handleUnzip`이 같은 tool에 정해진 인자 셰이프(`a <archive> <src...>` / `x <archive> -o<destDir> -aoa`)로 호출하는지를 확인합니다. 테스트는 외부 7z 바이너리에 의존하지 않도록 node 기반의 가짜 tool (`fake7z.sh` 또는 `fake7z.cmd`)을 임시 workspace에 만들어 archive 자리에 JSON manifest를 기록하고, `unzip` 호출 시 같은 manifest를 꺼내 놓도록 합니다. 테스트는 archive 파일과 풀린 manifest 양쪽의 `sources` 배열이 원본 입력과 일치하는지 검증합니다.

### IT-025: 빌트인 엔진은 .zip이 아닌 아카이브를 거부

`tool`을 생략했을 때 내장 zip 엔진이 사용되며, 이 엔진은 `.zip` 확장자만 지원한다는 계약을 고정합니다. `archive`가 `.7z`이면 파이프라인은 "Built-in engine only supports .zip archives" 에러로 즉시 중단되어야 합니다. 이 메시지는 사용자가 다른 포맷이 필요할 때 `tool`을 명시하도록 유도합니다.

### IT-035: 빌트인 zip → 빌트인 unzip 왕복

`tool` 없이 번들 내장 엔진(`adm-zip`)을 사용해 두 파일을 `.zip`으로 묶고 다시 해제했을 때, 추출된 파일 내용이 원본과 바이트 단위로 일치하는지 확인합니다. 실제 시스템에 zip CLI가 없어도 파이프라인이 동작한다는 것을 보장합니다.

### IT-036: 빌트인 zip에 디렉터리 source가 재귀적으로 포함됨

디렉터리 경로를 `source`로 주면 `addLocalFolder`가 basename을 최상위 폴더로 두고 하위 파일까지 재귀적으로 아카이브에 추가합니다. 테스트는 중첩 서브폴더 안의 파일이 해제 후에도 동일한 디렉터리 구조로 복원되는지 확인합니다.

### IT-037: 빌트인 unzip은 zip-slip 경로 탈출을 차단

악성 아카이브가 `../outside.txt` 같은 엔트리 이름으로 대상 디렉터리 밖에 파일을 쓰려고 시도할 때, `extractZipArchive`는 추출 전에 모든 엔트리의 해석된 경로가 대상 디렉터리 안에 있는지 검증하고 벗어나면 "Blocked path traversal" 에러를 던집니다. 테스트는 (1) 파이프라인이 실패하는지, (2) 대상 밖 경로에 실제 파일이 생성되지 않는지 둘 다 확인합니다. adm-zip이 `addFile` 시점에 `../`를 자동 정리하므로, 테스트는 `entryName`을 사후 수정하여 실제 공격자 기법을 모사합니다.

### IT-038: 빌트인 엔진으로 pipeline 변수 치환이 적용됨

내장 엔진 경로에서도 기존 외부 tool 경로와 동일한 `interpolatePipelineVariables`가 적용되는지 확인합니다. 이전 `stringManipulation` 태스크의 `output`을 `${name.output}`으로 참조해 `archive` 경로를 구성하고, 실제로 치환된 경로(`bundle.zip`)에 파일이 생성되는지 검증합니다.

### IT-026: terminal mode는 터미널을 만들고 같은 actionId에서 재사용

`output.mode: "terminal"`은 내부 `actionTerminals` 캐시를 키로 사용하므로, 같은 actionId에서 연속 실행될 때 터미널이 한 번만 생성되고 이후에는 캐시된 인스턴스가 재사용되어야 합니다. 테스트에서는 `vscode.window.createTerminal`을 stub 처리하여 생성 횟수와 `sendText`에 전달된 header/content 2라인이 각 터미널 출력마다 정확한 순서로 기록되는지, 그리고 `output.content`가 upstream capture 결과와 올바르게 결합되는지 확인합니다. 테스트 간 캐시 간섭을 피하기 위해 actionId에는 pid·timestamp를 섞어 고유하게 만듭니다.

### IT-027: 성공 경로에서 successMessage와 history 기록

`executeAction`은 내부적으로 `executeActionPipeline`을 호출하고, 성공하면 `handleActionSuccess`가 `action.successMessage`를 `showInformationMessage`로 표시하고 `actionStates`를 `success`로 갱신하며, `HistoryProvider.updateHistoryStatus`로 history entry를 running → success로 이동시킵니다. 이 시나리오는 이 세 가지 부작용이 한 번의 실행에서 모두 일관되게 발생하는지를 고정합니다.

### IT-028: 실패 경로에서 failMessage와 history failure 기록

잘못된 capture regex로 실행 시점에 에러를 유도한 뒤, `handleActionFailure`가 `${failMessage}: ${error.message}` 포맷으로 `showErrorMessage`를 호출하고, `actionStates`가 `failure`로 바뀌며, history entry의 `status`가 `failure`·`output`에 원본 에러가 포함되는지 검증합니다. 에러 자체는 재던져지므로 호출자가 `assert.rejects`로 잡을 수 있어야 합니다.

### IT-029: passTheResultToNextTask=false는 downstream output 접근을 차단

`passTheResultToNextTask`를 끈 shell 태스크는 결과가 `{}`로 저장되어, downstream의 `${silent.output}` 같은 interpolation이 일치하는 키를 못 찾고 `${...}` 리터럴 그대로 남습니다. 이는 `interpolatePipelineVariables`가 미매칭 시 원본 `match`를 반환하는 현재 동작을 테스트에서 고정합니다. capture까지 같이 끊기는 이유(`result.output`이 없으므로 스킵)는 코드 주석 및 IT-005 설명을 참조합니다.

### IT-030: stringManipulation 경로 연산 전체 체인

`basename`/`basenameWithoutExtension`/`stripExtension`/`dirname`/`extension` 다섯 경로 함수가 한 파이프라인에서 서로의 결과나 같은 원본을 입력으로 받아 동작하는 것을 end-to-end로 고정합니다. 특히 `basenameWithoutExtension`은 확장자를 **마지막 `.`만** 제거한다는 점 (`logo.final.png` → `logo.final`) 과, `stripExtension`이 전체 경로를 보존한 채 확장자만 떼어낸다는 차이가 드러나도록 입력을 구성했습니다.

### IT-031: 지원하지 않는 task type은 실행 시 에러

알려지지 않은 `type` 문자열은 `executeSingleTask`의 `switch` 기본 분기에서 `Unsupported task type: <type>` 에러로 즉시 실패합니다. 스키마 validator를 우회해 실행기에 닿는 경로를 가정하므로 테스트에선 `PipelineAction`으로 강제 캐스팅합니다.

### IT-032: shell 태스크의 command 누락은 실행 시 에러

`command`가 없는 `shell` 태스크는 `executeSingleTask`가 interpolation 단계를 통과시키되 `!command` 검사에서 `Task <id> of type 'shell' requires a 'command' property.` 에러를 던집니다. 필수 필드 누락이 파이프라인 어느 지점에서 잡히는지 현재 동작을 고정합니다.

### IT-063: 인터랙티브 task 결과가 history entry.inputs에 누적

`executeAction`은 내부적으로 `recordInputs` 누적 객체를 만들어 `executeActionPipeline`에 전달하고, `shouldRecordTaskInput`을 통과하는 task(`inputBox`/`quickPick`/`envPick`/`fileDialog`/`folderDialog`/`confirm`) 결과를 task id 키로 모은 뒤, 성공·실패 모든 종료 경로에서 `HistoryProvider.setHistoryInputs`로 history entry에 부착합니다. 이 시나리오는 `quickPick` + `inputBox` + `stringManipulation` 조합에서 인터랙티브 두 task만 entry.inputs에 들어가고, `stringManipulation`은 들어가지 않음을 확인합니다.

### IT-064: presetInputs로 재실행하면 다이얼로그를 열지 않고 저장값을 사용

`executeActionPipeline`에 `{ presetInputs: { <taskId>: <savedResult> } }`를 넘기면, 매칭되는 인터랙티브 task의 핸들러는 호출되지 않고 `presetInputs[taskId]`가 그대로 task result로 사용됩니다. 테스트는 `showQuickPick`·`showInputBox`를 throw하도록 monkey patch해 다이얼로그가 열리지 않음을 강제 검증하며, downstream `stringManipulation`이 저장된 값을 interpolation해 정상적으로 파일까지 쓰는지 확인합니다.

### IT-065: `password: true` inputBox는 entry.inputs에 저장되지 않는다

`shouldRecordTaskInput`이 `password: true`인 `inputBox` task에서 `false`를 반환하므로, 비밀번호 입력은 `recordInputs`에 누적되지 않고 history entry.inputs에도 들어가지 않습니다. 테스트는 비밀번호 + 일반 inputBox + quickPick을 한 액션에 섞어, 일반 입력은 모두 저장되고 비밀번호 task id만 빠지는지를 확인합니다. 또한 entry 직렬화에 비밀 문자열이 포함되지 않는 negative assertion도 함께 둡니다.

### IT-066: 재실행 시에도 인터랙티브 task의 output 후처리가 실행됨

`executeSingleTask`는 `presetResult`가 있으면 type-specific dispatch만 우회하고, 공통 후처리(capture + `passTheResultToNextTask && output` 블록)는 정상 경로와 동일하게 실행합니다. 이 시나리오는 `inputBox`에 `output: { mode: 'file', content: 'post-processing fired' }`을 단독으로 둔 액션을 `presetInputs`로 재실행하여, 다이얼로그는 열리지 않으면서도 파일이 정확히 기록되는지 검증합니다. 초기 구현은 preset 경로가 `executeSingleTask` 자체를 우회하는 형태였고, 이때 `output.mode: 'file'` 같은 후처리가 조용히 스킵되는 회귀가 있었습니다 — 이 테스트가 그 회귀를 직접 차단합니다. (참고: task의 `output.content`는 *해당 task 자신*의 결과를 참조할 수 없습니다 — `interpolationContext`가 task 시작 *전*에 구축되기 때문이며, 이는 정상 경로에서도 동일합니다. 그래서 본 테스트는 정적 content 문자열을 사용합니다.)

### IT-067: executeAction은 success/failure 모두 history entry에 durationMs를 기록

`executeAction`은 종료 시점에 `Date.now() - timestamp`로 계산한 wall-clock 소요시간을 `updateHistoryStatus`의 5번째 인자로 넘겨 `HistoryEntry.durationMs`에 저장합니다. 이 시나리오는 (a) 단순 stringManipulation 성공 경로, (b) capture regex 실패로 reject되는 실패 경로 두 가지에 대해 entry의 `status`가 각각 `success`/`failure`로 기록되고 `durationMs`가 number이며 비음수임을 검증합니다. 비음수 검사는 wall-clock 단조성에 의존하지 않도록 방어적으로 둡니다 (NTP 보정 등 극단 케이스에서도 0 이상이 보장됨).

### IT-068: HistoryItem.description에 status + 시각 + 소요 시간 배지가 노출

배지는 액션 카드(Actions 패널)가 아니라 History 패널에 위치합니다 — 시각·소요 시간 데이터는 `HistoryEntry` 자체의 속성이고, 같은 정보를 두 표면에 두지 않는 게 fitness 좋다고 판단했습니다. `HistoryItem` 생성자가 `formatLastRunBadge(entry, Date.now(), lang)`로 `description`을 채우며, 종료된(`success`/`failure`) entry만 배지를 가집니다. 본 시나리오는 (a) 성공/실패 entry가 각각 `✓`/`✗` 접두로 표현되는지, (b) duration 문자열(`1.2s`/`45ms`)이 포함되는지, (c) 진행 중(`running`) entry는 description이 `undefined`로 비어 있는지 세 가지를 확인합니다. 시각 포맷 분기는 `formatHistoryTimestamp` 단위 테스트에서 별도로 검증합니다.

### IT-068b: Action TreeItem에는 last-run 배지가 없다 (회귀 가드)

IT-068의 대칭 가드입니다. 이전 구현은 `MainViewProvider`가 `loadHistory` 콜백을 받아 `Action` TreeItem.description에 배지를 그렸으나, 같은 정보가 두 표면에 분산되는 게 디자인적으로 약하다고 판단해 History 패널로 일원화했습니다. 본 테스트는 `Action` TreeItem.description이 항상 `undefined`임을 명시적으로 고정해, 향후 "오늘 빌드 됐었지?" 류 요구로 누군가 재차 Actions 패널에 배지를 붙이는 회귀를 PR 단계에서 차단합니다. (단, 액션이 *실행 중*일 때 진행 정보(`2/3 · taskId`)는 description에 노출됨 — 이는 회고가 아닌 진행 정보라 별개. IT-072 참조.)

### IT-069: task transition 이벤트가 running → success 쌍으로 발사

`executeActionPipeline`은 각 task 시작 직전 `running`을, 성공 종료 직후 `success` transition을 발사합니다. 본 시나리오는 3-task 액션에서 정확히 6개 이벤트가 `[a:running, a:success, b:running, b:success, c:running, c:success]` 순서로 발사되는지를 `deepStrictEqual`로 고정합니다. 1-based `index`와 일관된 `total`(action.tasks.length)이 모든 이벤트에 동일하게 들어가는지도 함께 검증해, `2/3 · taskId` 같은 description 렌더의 입력 시그널을 stable하게 유지합니다.

### IT-070: continueOnError 실패 task는 skipped transition

실패 task에 `continueOnError: true`가 설정되어 있으면 `executeActionPipeline`은 throw 대신 `skipped` transition을 발사하고 다음 task로 이동합니다. 본 시나리오는 capture 실패(`regex: '('`)로 의도적으로 fail시킨 가운데 task에서 `skipped` transition만 발사되고 그 앞뒤 task는 정상 `running`/`success` 쌍을 발사함을 확인합니다.

### IT-071: 실패 task 이후 파이프라인 중단

`continueOnError`가 없는 실패 task는 `failure` transition을 발사한 직후 throw되어 파이프라인이 중단됩니다. 본 시나리오는 3-task 액션의 가운데 task가 fail할 때 `[ok:running, ok:success, fail:running, fail:failure]`까지만 이벤트가 발사되고 마지막 task는 어떤 이벤트도 emit되지 않음을 확인합니다.

### IT-072: 멀티 task running 시 Action description에 progress 노출

`actionStates.progress`(`{ index, total, taskId }`)가 채워진 running 상태의 멀티 task 액션은 `Action` TreeItem.description에 `2/3 · link` 형태의 진행 표시를 렌더합니다. 본 시나리오는 `progress: { index: 2, total: 3, taskId: 'link' }`를 직접 set한 뒤 description이 정확한 문자열이 되는지를 확인합니다. (transition → progress 갱신 → refresh 흐름의 와이어링 자체는 IT-073에서 검증.)

### IT-072b: 단일 task 액션은 description을 채우지 않음

`total === 1`인 액션은 progress가 채워져 있어도 description이 `undefined`로 유지됩니다 — `1/1 · taskId`는 사용자에게 무의미한 노이즈이므로 의도적으로 렌더하지 않습니다.

### IT-072c: progress 없는 running 상태에서 description은 비어 있음

`actionStates.state === 'running'`이지만 `progress` 필드가 없는 경우(legacy 분기 또는 외부에서 partial하게 설정된 경우) description은 `undefined`를 유지합니다. 부분적으로 채워진 state로 인해 의도하지 않은 description 렌더가 발생하지 않도록 방어.

### IT-073: 종료 후 actionStates.progress가 자동 정리됨

`finalizeActionRun`은 액션이 success/failure 어느 쪽으로든 종료될 때 `actionStates`의 `progress` 필드를 비워, 다음 렌더 사이클에 description이 잔존하지 않도록 합니다. 본 시나리오는 멀티 task 액션을 `executeAction`으로 실행 후 `actionStates.get(id).progress`가 `undefined`가 되었음을 확인합니다 (`state` 자체는 `success`로 유지 — last-run 아이콘이 보존되어야 하므로).

### IT-074: throwing onTaskTransition은 success 경로의 결과를 바꾸지 않는다

진행률 콜백은 side channel입니다 — 버그 있는 UI hook이 정상 task를 실패로 둔갑시켜서는 안 됩니다. 1차 리뷰 Medium 지적: 이전 구현은 `running`/`success`/`failure`/`skipped` 4 callsite에서 콜백을 직접 호출해 `success` 콜백이 throw하면 파이프라인이 reject되는 회귀가 가능했습니다. 본 시나리오는 매 transition마다 throw하는 콜백을 주입한 채 2-task 정상 액션을 실행하고, 파이프라인이 정상 resolve하며 4개 transition (`a:running`/`a:success`/`b:running`/`b:success`)이 모두 시도되었음을 확인합니다 (`emitTransition` helper의 try/catch 격리 회귀 가드).

### IT-074b: throwing onTaskTransition은 failure 경로의 원본 에러를 가리지 않는다

실제 task가 fail하는 동시에 transition 콜백도 failure 이벤트에서 throw할 때, reject되는 에러는 task의 *원본* 에러여야 합니다 — 콜백 에러로 가려지면 `history.output`이 잘못된 원인을 가리키게 됩니다. 본 시나리오는 capture regex가 잘못된 task에 매 콜백마다 `'callback boom'`을 던지는 콜백을 붙이고, `assert.rejects`가 `/capture failed/`(원본 에러)에 매칭되는지를 확인합니다.

## 시나리오 추가 절차

1. 새 기능의 integration 측면이 생기면 이 문서의 "시나리오 그룹" 표에 먼저 한 줄 요약을 추가합니다.
2. 필요한 경우 "상세" 섹션에 기대 동작과 비자명한 제약(예: IT-006의 filePath 타이밍)을 남깁니다.
3. 테스트 파일에 `IT-XXX: <요약>` 네이밍으로 테스트를 추가합니다.
4. 테스트가 깨지면 **먼저 이 문서의 시나리오를 점검**하세요 — 스펙 해석 차이일 수 있습니다.
