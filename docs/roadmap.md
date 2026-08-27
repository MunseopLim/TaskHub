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

## 우선순위

| 우선순위 | 항목 | 규모 | 사용자 결과 |
| --- | --- | --- | --- |
| P0 | 선호 소스 루트와 Hover/Register 정합성·응답성 | 소~중 | 사용자가 고른 프로젝트 문맥에서 상세 Hover를 유지하면서 오해석과 지연을 줄임 |
| P1 | 프로젝트 원본·빌드 복사본 이동 | 소 | 대응 파일을 빠르게 열고 VS Code에서 비교 |
| P1 | ARM toolchain Action 예제 | 소 | 주소·크기·심볼 분석을 기존 도구로 바로 실행 |
| P1 | Memory Map 소스 이동 정확성 | 소~중 | 반복 선택을 줄이고 ELF 기록 내용과 일치하는 소스 후보를 식별 |

## P0 — 선호 소스 루트와 Hover/Register 정합성·응답성

프로젝트별로 이름이 같은 매크로·SFR·Register 정의가 있을 때 LSP가 반환한 첫 위치를 정답으로
간주하지 않습니다. 상세 Hover를 유지하는 데 필요한 최소한의 사용자 선택도 같은 단계에서
제공합니다.

- workspace folder마다 사용자가 명시적으로 선택한 선호 프로젝트 소스 root 하나만 기억합니다.
- 선택된 동안에만 workspace 상대경로에서 만든 짧은 이름을 상태바에 표시하고, 클릭하면 변경하거나
  해제할 수 있게 합니다. 경로가 사라지거나 workspace 밖을 가리키면 비활성화합니다.
- 이 root는 사용자 선택 힌트일 뿐 실제 컴파일·링크 참여의 증거로 표현하지 않습니다.
- definition/declaration 후보를 모두 수집한 뒤 각 위치에서 필요한 정보를 파싱합니다. 후보를 모두
  확인하기 전에 첫 위치로 SFR 비트 필드나 Register 값을 해석하지 않습니다.
- 현재 문서의 선언이나 실제 단일 후보는 상세 표시합니다. 여러 후보는 제한 시간 안에 전부 파싱되고
  상세 해석에 영향을 주는 값과 layout이 모두 같을 때만 표 하나로 합치며 중복 경로를 함께 표시합니다.
- 후보 수 상한, 시간 예산 또는 파싱 실패로 확인하지 못한 위치는 버리지 않고 미해결 후보로 남깁니다.
  일부 결과만으로 모든 정의가 같다고 판단하지 않습니다.
- 선호 root 안에 후보가 정확히 하나면 표보다 먼저 `선호 소스 기준`과 경로를 밝히고 상세 표시합니다.
  root 밖의 다른 후보도 숨기지 않습니다.
- 서로 다른 값이나 layout이 남고 선호 root로도 하나를 고를 수 없으면 후보별 차이와 경로를
  간단히 표시하며 LSP 첫 후보로 폴백하지 않습니다.
- 멀티루트에서도 같은 상대경로를 구별할 수 있도록 후보 경로에 workspace folder를 포함합니다.
- Hover 중 자동 workspace symbol 전체 검색을 제거합니다. 모든 정의 탐색은 VS Code의 F12/Peek와
  검색 기능에 맡깁니다.
- 한 Hover의 전체 처리 시간을 제한하고, 취소되거나 시간 예산을 넘으면 추가 LSP 후속 작업을
  중단합니다. 숫자 변환처럼 이미 얻은 저비용 결과는 가능한 범위에서 표시합니다.
- 느린 LSP, 취소, 동일·충돌 정의, 멀티루트 경로를 재현하는 테스트를 추가하고 대표 프로젝트에서
  선호 root 적용 전후의 실제 후보 수를 확인합니다.

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

## P1 — Memory Map 소스 이동 정확성

- 현재 열린 Memory Map 패널 세션에서만 DWARF 기록 경로와 후보 집합별 사용자의 명시적 선택을
  기억해 다시 사용합니다. 패널 Refresh, ELF·후보 집합·선호 소스 root 변경 시 저장값을 폐기합니다.
- 지원되는 DWARF 5 line table에 `DW_LNCT_MD5`가 있으면 해당 소스 위치와 checksum을 함께 보존하고,
  이미 찾은 후보의 디스크 내용을 열기 시점에만 비교합니다.
- 기억한 명시적 선택이 없는 경우, 모든 후보 비교가 완료되고 비교 대상 문서에 저장하지 않은 편집이
  없으며 일치 후보가 정확히 하나일 때만 자동으로 엽니다. 그 외에는 선호 소스 root를 QuickPick
  정렬과 초기 포커스에만 사용합니다.
- checksum 결과는 UI에서 `ELF 기록과 일치`, `ELF 기록과 불일치`, `checksum 확인 불가`로 짧게
  구분하고 자세한 이유는 tooltip으로 제공합니다. 이를 `이 빌드에 포함` 또는 `빌드에 없음`으로
  표현하지 않습니다.
- 후보 파일별 크기와 한 번의 선택에서 읽는 총 바이트에 상한을 적용합니다. 상한 초과나 읽기 실패는
  `checksum 확인 불가`로 처리하고 기존 소스 선택을 막지 않습니다.
- checksum을 위해 workspace 검색 범위를 넓히지 않으며 Hover 후보 판별, Build Set 또는 복사 원본
  추론에 사용하지 않습니다.
- checksum 없음, 유일·복수 일치, 읽기 상한, 미저장 변경과 후보 변경을 재현하는 테스트를 추가합니다.

DWARF checksum은 선택적인 보조 정보입니다. DWARF 2~4, checksum이 없는 DWARF 5, stripped ELF는
현재 경로 후보 선택 동작을 그대로 사용합니다. 파일 내용만 확인할 뿐 전처리 문맥을 증명하지 못하고,
기준 ELF가 불명확한 Hover에서 파일 I/O를 일으키므로 Hover 후보 판별에는 사용하지 않습니다.

## 실제 요청이 확인되면 재검토

- 현재 열린 Memory Map의 단일 주소 찾기: `addr2line` Action 사용 빈도가 충분할 때 검토합니다.
- 빌드 간 Memory Map 비교: 기존 Full Dump와 VS Code Diff로 부족한 사례가 쌓일 때 region 합계부터
  검토합니다.
- 압축 DWARF, DWARF64, `DW_FORM_strx*`, supplementary object: 실제 실패 ELF와 회귀 fixture가 확보된
  형식만 각각 독립적으로 검토합니다.

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
