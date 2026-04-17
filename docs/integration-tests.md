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

## 시나리오 추가 절차

1. 새 기능의 integration 측면이 생기면 이 문서의 "시나리오 그룹" 표에 먼저 한 줄 요약을 추가합니다.
2. 필요한 경우 "상세" 섹션에 기대 동작과 비자명한 제약(예: IT-006의 filePath 타이밍)을 남깁니다.
3. 테스트 파일에 `IT-XXX: <요약>` 네이밍으로 테스트를 추가합니다.
4. 테스트가 깨지면 **먼저 이 문서의 시나리오를 점검**하세요 — 스펙 해석 차이일 수 있습니다.
