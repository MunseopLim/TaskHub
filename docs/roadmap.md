# TaskHub 기능 로드맵

이 문서는 **아직 구현되지 않은 기능과 기술 부채**만 추적합니다. 이미 배포된 기능은
[CHANGELOG.md](../CHANGELOG.md), 현재 사용법은 [features.md](./features.md)를 참조하세요.

TaskHub는 VS Code의 편집·검색·정의 이동·프로젝트 설정을 대체하지 않습니다. VS Code와 ARM
toolchain이 이미 제공하는 기능을 연결하고, 반복 작업과 임베디드 분석에서 자주 생기는 작은 불편을
줄이는 데 집중합니다.

특히 프로젝트별로 같은 이름의 소스·레지스터 헤더를 유지하고 선택한 원본을 공용 경로로 복사해
빌드할 때, TaskHub의 Hover와 소스 이동이 다른 프로젝트 정의를 조용히 선택하지 않도록 합니다.

## 제품 원칙

- VS Code의 기본 검색, F12/Peek, C/C++ 확장의 IntelliSense를 우선 사용합니다.
- ARM toolchain 명령으로 해결할 수 있는 작업은 먼저 Action 예제로 제공합니다.
- 사용자 설정이나 프로젝트 파일을 자동으로 바꾸지 않는 읽기 전용 기능을 우선합니다.
- 내부 리팩터링이나 추측성 호환 기능은 사용자 결과가 확정된 뒤 구현 항목으로 올립니다.
- 실제 사용자 사례 또는 재현 fixture가 없는 큰 기능은 활성 로드맵에 두지 않습니다.

## 0.9.4 검토 결과

다음 작업은 **Memory Map 용량 표시 수정 → 실행 보고서에서 산출물 열기 → 배포 예제로 검증** 순으로
진행하는 것을 권장합니다. 완료 기준은 **CLI로 액션을 실행한 뒤 VS Code에서 해당 보고서와 ELF를 열고,
Flash/RAM 사용률에 쓰인 용량의 출처를 확인할 수 있는 것**입니다.

### 1. Memory Map 용량과 바이트 탐색

- ELF만 열었을 때의 자동 감지는 `PT_LOAD`의 `p_memsz`를 영역 크기로 사용합니다. 이 값은 적재된
  세그먼트의 크기입니다. 예를 들어 40 KiB를 사용한 영역은 자동 감지에서 `100.0%`와 포화 경고가 나오고,
  같은 영역을 256 KiB로 설정하면 `15.6%`가 나옵니다.
  [영역 계산](../src/elfParser.ts) · [ELF 명세](https://gabi.xinuos.com/elf/07-pheader.html#program-header-entry)
- 자동 감지한 영역에는 적재 주소 범위·사용 바이트·`용량 미확인`을 표시합니다. 링커 스크립트, 사용자 설정,
  Listing에서 확인한 영역 용량에는 각각 출처를 표시하고 그 용량 기준의 사용률·여유 공간·포화 경고를 제공합니다.
  화면과 복사·저장한 보고서에 같은 기준을 적용합니다. [현재 Memory Map 동작](features.md#19-memory-map-시각화)
- 이어서 **바이트 보기**가 선택한 파일 범위만 읽도록 보완합니다. Memory Map과 Hex Viewer의 파일 크기 한도가
  다르므로 현재는 60 MiB ELF의 64바이트 심볼도 열 수 없습니다. 범위의 파일 오프셋과 길이를 표시하고,
  ELF가 교체됐다면 새로 고침을 안내합니다. [Memory Map에서 Hex Viewer 열기](../src/memoryMapViewer.ts) · [Hex Viewer 한도](../src/hexViewer.ts)

### 2. 실행 보고서에서 산출물 열기

확장과 독립 실행에서 결과 기록부터 맞춥니다. 현재 VS Code 보고서는 파일 경로를 텍스트로 표시하며,
CLI의 `writeFile`은 파일을 만들지만 로그에 결과 경로를 남기지 않습니다.
[보고서](../src/actionRunReport.ts) · [독립 실행기](../src/standalone/runner.ts)

1. TaskHub가 쓰거나 압축한 파일의 경로를 VS Code·CLI·MCP에서 같은 방식으로 기록합니다. 실행 동등성
   테스트에 파일 경로와 민감 경로 마스킹을 포함합니다. [실행 동등성 테스트](../src/test/executorParity.test.ts)
2. VS Code History에서 현재 워크스페이스에 저장된 CLI·MCP 실행을 조회하고 기존 보고서로 엽니다.
   실행 출처를 표시하고, 출처 필드가 없는 이전 로그는 `출처 미확인`으로 표시합니다. 같은 실행의 확장
   기록과 로그는 한 행으로 보여 주고, 상세 출력은 보고서를 열 때 읽습니다. [현재 로그 조회](features.md#실행과-로그)
3. 보고서에서 `.elf`·`.axf`는 Memory Map, `.bin`·`.hex`는 Hex Viewer로 엽니다. 빌드 명령의 산출물은
   명시한 경로를 명령 성공 후 확인해 표시합니다. 열기 직전에 워크스페이스 경계와 파일 존재 여부를 검사하고,
   삭제·이동된 파일이나 민감 경로에는 열기 동작을 제공하지 않습니다. 링크는 기록된 경로의 현재 파일을 열므로,
   후속 빌드가 같은 경로에 쓰면 새 파일이 열릴 수 있음을 표시합니다.

### 3. 대표 예제와 배포 검증

- Actions 빈 화면에서 센서 이미지 예제의 **미리보기 → 실행 → 결과 확인**을 시작하게 합니다. 설치본에서
  수동 `actions.json` 병합 없이 시작할 수 있게 하고, Python이 필요한 경우 실행 전에 안내합니다. 같은 예제의
  CLI 실행 절차도 제공합니다. [현재 Build → Verify → ZIP 예제](../examples/sensor_pipeline/README.md)
- 배포할 VSIX를 빈 VS Code 프로필에 설치해 예제 시작과 결과 열기를 확인합니다. 작은 ARM ELF를 포함한
  검증 사례에서는 독립 CLI 실행 → VS Code History → 보고서 → Memory Map을 따라가며 용량 출처를 확인합니다.
  [VSIX 릴리스 절차](../.github/workflows/release.yml) · [CLI 설치 검증](../.github/workflows/standalone.yml)

### 후속 후보 — CLI·MCP 입력 사전 점검

기존 `doctor ACTION`의 설정 및 실행 환경 진단에 더해, `preview`에서 입력 파일이나 MCP 입력 객체의 값까지
검사할 수 있게 합니다. 필수 입력 누락, 고정 선택지 불일치, VS Code 전용 단계를 실행 전에 표시하고, 앞 단계의
출력에 따라 정해지는 값은 `실행 시 결정`으로 표시합니다. 검증 결과는 문제의 태스크 ID와 입력 조건을 알려 주고
민감 입력값은 표시하지 않습니다. [현재 CLI 명령](features.md#standalone-cli)

### 후속 후보 — 설치된 확장으로 MCP 사용

현재 MCP를 쓰려면 VSIX와 별도로 `taskhub-cli-<버전>.tgz`와 Node.js 22 이상을 설치해야 합니다. VSIX는
CLI 파일(`bin/`, `dist/cli.js`)을 빼고 배포합니다. [배포 제외 목록](../.vscodeignore) · [Stdio MCP](features.md#stdio-mcp)

- VSIX에 CLI를 함께 넣고 **MCP 설정 복사** 명령을 제공합니다. 이 명령은 VS Code에 들어 있는 Node로 CLI의
  `mcp`를 실행하는 클라이언트 설정과 `claude mcp add`·`codex mcp add` 명령을 만듭니다. 워크스페이스는 현재
  폴더로 채우고 `--trust`는 넣지 않습니다. 실행 허용은 지금처럼 운영자가 시작 인자로 정합니다.
- 확장을 업데이트하면 설치 경로가 바뀌므로, 사용자가 명령을 실행할 때만 최신 확장을 찾아 실행하는 고정 런처를
  만듭니다. 런처의 위치와 내용은 만들기 전에 보여 주고, 다른 클라이언트 설정 파일은 직접 고치지 않습니다.
- VS Code에 들어 있는 Node가 22 미만이면 명령에서 이유와 필요한 VS Code 버전을 안내하고 기존 tgz 설치를 대신
  권합니다. 기능과 제약은 지금 CLI와 같으며, VS Code가 꺼져 있어도 동작합니다.
- 빈 VS Code 프로필에 VSIX만 설치한 상태에서 설정 복사 → MCP 클라이언트의 `list_actions`·`run_action` →
  확장 업데이트 뒤 재실행을 macOS·Windows·Linux에서 확인합니다. VSIX 크기 증가도 함께 기록합니다.

## 우선순위

소스 탐색과 ARM 도구의 구현 순서는 다음과 같습니다.

| 우선순위 | 항목 | 규모 | 사용자 결과 |
| --- | --- | --- | --- |
| P0 | 선호 소스 루트 | 소~중 | 사용자가 고른 프로젝트 문맥에서 상세 Hover 후보를 좁힘 |
| P1 | 프로젝트 원본·빌드 복사본 이동 | 소 | 대응 파일을 빠르게 열고 VS Code에서 비교 |
| P1 | ARM toolchain Action 예제 | 소 | 주소·크기·심볼 분석을 기존 도구로 바로 실행 |

## P0 — 선호 소스 루트

다중 정의가 있을 때 사용자가 선택한 프로젝트 문맥으로 상세 해석을 좁히는 기능을 추가합니다.
현재 후보 처리와 응답성 정책은 [C/C++ Hover](features.md#15-cc-hover-기능)를 참조하세요.

- workspace folder마다 사용자가 명시적으로 선택한 선호 프로젝트 소스 root 하나만 기억합니다.
- 선택된 동안에만 workspace 상대경로에서 만든 짧은 이름을 상태바에 표시하고, 클릭하면 변경하거나
  해제할 수 있게 합니다. 경로가 사라지거나 workspace 밖을 가리키면 비활성화합니다.
- 이 root는 사용자 선택 힌트일 뿐 실제 컴파일·링크 참여의 증거로 표현하지 않습니다.
- 선호 root 안에 후보가 정확히 하나면 표보다 먼저 `선호 소스 기준`과 경로를 밝히고 상세 표시합니다.
  root 밖의 다른 후보도 숨기지 않습니다. 하나로 좁힐 수 없으면 기존 후보 충돌 안내를 유지합니다.
- Memory Map의 소스 후보가 여러 개면 선호 root는 Quick Pick 정렬과 초기 포커스에만 사용하고,
  checksum 결과나 자동 선택 근거로 표현하지 않습니다.
- 멀티루트의 선택 저장·변경·해제, root 삭제·이동, 후보 충돌과 소스 열기 정렬을 테스트하고
  대표 프로젝트에서 선택 전후의 실제 후보 수와 해석 결과를 확인합니다.

공용 resolver, cache 구조, 위치 정규화 같은 구현 세부사항과 Hover 종류별 추가 설정은 로드맵
기능으로 분리하지 않습니다.

## P1 — 프로젝트 원본·빌드 복사본 이동

프로젝트별 원본을 공용 경로로 복사한 뒤 빌드하는 환경을 위해, workspace folder마다 사용자가
선택적으로 공용 빌드 root 하나를 선호 소스 root와 연결할 수 있게 합니다.

- 초기 버전은 프로젝트 원본 root와 공용 빌드 root 한 쌍의 동일 상대경로만 연결합니다.
- `원본 열기`, `빌드 복사본 열기`, VS Code의 파일 비교 명령에만 사용합니다.
- 빌드 root는 Hover의 선호 후보나 실제 빌드 참여 증거로 사용하지 않습니다.
- TaskHub가 파일을 복사하거나 `search.exclude`, `browse.path`, `compile_commands.json` 및 다른
  확장의 설정을 수정하지 않습니다.
- 기본 F12를 대체하는 DefinitionProvider, 진단 URI 변경, 파일 decoration은 추가하지 않습니다.

복잡한 Build Set, artifact fingerprint, provenance 및 `selected`/`verified`/`stale` 상태 머신으로
확장하지 않습니다.

## P1 — ARM toolchain Action 예제

새 분석기나 전용 패널보다 기존 Action 태스크와 ARM toolchain을 먼저 활용합니다.

- `arm-none-eabi-addr2line`: PC 등 코드 주소를 함수명과 소스 위치로 해석
- `arm-none-eabi-size`: ELF의 text/data/bss 크기 요약
- `arm-none-eabi-nm --size-sort`: 큰 심볼 확인
- `arm-none-eabi-objdump`: 사용자가 선택한 범위의 disassembly 확인

GNU Arm toolchain을 기준으로 `fileDialog`, `inputBox`, `command` 태스크를 조합한 복사 가능한 예제를
[actions.md](./actions.md)에 제공합니다. VS Code가 보는 `PATH`를 사용하는 형태와 사용자가 toolchain
실행 파일의 절대경로를 지정하는 형태를 함께 설명합니다. 출력과 파일 이동은 터미널 및 VS Code의
기본 링크 기능을 활용합니다. toolchain 자동 탐색·설치, 별도 artifact cache, HardFault 분석기 또는
disassembly 웹뷰는 만들지 않습니다.

주소 해석의 반복 사용이 확인되면 그때 현재 열린 Memory Map 안에서 주소에 해당하는 심볼 행을
찾는 작은 명령으로 승격합니다.

## 실제 요청이 확인되면 재검토

- 현재 열린 Memory Map의 단일 주소 찾기: `addr2line` Action 사용 빈도가 충분할 때 검토합니다.
- 빌드 간 Memory Map 비교: 기존 Full Dump와 VS Code Diff로 부족한 사례가 쌓일 때 region 합계부터
  검토합니다.
- 압축 DWARF, DWARF64, `DW_FORM_strx*`, supplementary object: 실제 실패 ELF와 회귀 fixture가 확보된
  형식만 각각 독립적으로 검토합니다.
- 실행 중인 VS Code를 MCP 서버로 사용 (2026-11-28 검토): 확장의 실행기를 그대로 써 터미널·선택 텍스트처럼
  CLI가 거부하는 VS Code 전용 단계와 History 기록까지 지원할 수 있습니다. 대신 VS Code가 켜져 있을 때만
  동작하고, 여러 창 사이의 요청 전달과 로컬 접속 인증을 새로 설계해야 합니다. VS Code의 MCP 서버 등록 API는
  VS Code 안의 채팅에만 쓰여 외부 MCP 클라이언트에는 도움이 되지 않습니다. VS Code 전용 단계를 MCP로 실행해야
  하는 실제 요청이 확인되면 [설치된 확장으로 MCP 사용](#후속-후보--설치된-확장으로-mcp-사용) 이후에 검토합니다.

## 범위 밖

- 자체 C/C++ parser, header indexer, language server 또는 기본 F12 대체
- Active Build Context, Build Set, compile DB·Listing 결합 및 Index Doctor
- 범용 source mirror/sync 엔진과 `stageSources` 태스크
- `search.exclude`나 C/C++ `browse.path`를 바꾸는 Focus Mode
- CMSIS-SVD 전체 정규화·탐색기와 별도 Register 데이터베이스
- debugger를 통한 live register 읽기·쓰기와 완전한 HardFault 분석기
- 자체 semantic Memory Map diff·회귀 gate
- 벤더별 flash/debug adapter와 범용 visual workflow node editor

## 테스트 부채

- `jsonEditorUtils.test.ts`의 소스 문자열 정규식 검사를 실행 기반 테스트로 점진적으로 교체합니다.

## 실행 모듈의 기술 부채

`extension.ts`의 프로세스 실행·종료와 태스크 준비를 분리하고 `executeSingleTask`·`prepareTaskExecution`의
`any` 경계를 스키마 기반 타입으로 좁힙니다. 기존 export와 실행 경로 통합 테스트를 유지하면서 책임별로
진행합니다. 환경 병합과 시스템 셸 경로는 `processEnvironment.ts`로 분리했으며, 나머지 영역은 실행 결과를
바꾸지 않는 별도 리팩터링으로 다룹니다. MCP 지원의 전제 조건은 아닙니다. 실행 흐름은 이미
[pipelineEngine.ts](../src/pipelineEngine.ts)를 함께 쓰고, 태스크 단위 실행의 결과 차이는 실행 동등성 테스트가 확인합니다.
