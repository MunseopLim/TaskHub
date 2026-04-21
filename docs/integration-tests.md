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

## 시나리오 추가 절차

1. 새 기능의 integration 측면이 생기면 이 문서의 "시나리오 그룹" 표에 먼저 한 줄 요약을 추가합니다.
2. 필요한 경우 "상세" 섹션에 기대 동작과 비자명한 제약(예: IT-006의 filePath 타이밍)을 남깁니다.
3. 테스트 파일에 `IT-XXX: <요약>` 네이밍으로 테스트를 추가합니다.
4. 테스트가 깨지면 **먼저 이 문서의 시나리오를 점검**하세요 — 스펙 해석 차이일 수 있습니다.
