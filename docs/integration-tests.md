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

## 시나리오 추가 절차

1. 새 기능의 integration 측면이 생기면 이 문서의 "시나리오 그룹" 표에 먼저 한 줄 요약을 추가합니다.
2. 필요한 경우 "상세" 섹션에 기대 동작과 비자명한 제약(예: IT-006의 filePath 타이밍)을 남깁니다.
3. 테스트 파일에 `IT-XXX: <요약>` 네이밍으로 테스트를 추가합니다.
4. 테스트가 깨지면 **먼저 이 문서의 시나리오를 점검**하세요 — 스펙 해석 차이일 수 있습니다.
