# TaskHub 기능 로드맵

이 문서는 **아직 구현되지 않은 기능과 기술 부채**만 추적합니다. 이미 배포된 기능은
[CHANGELOG.md](../CHANGELOG.md), 현재 사용법은 [features.md](./features.md)를 참조하세요.
우선순위와 규모는 요구사항이 바뀌면 함께 갱신합니다.

## 우선순위

| 우선순위 | 항목 | 규모 | 핵심 이유 |
| --- | --- | --- | --- |
| P1 | Named Input Profiles | 소~중 | 반복 입력을 보존하되 비밀·오래된 task ID를 안전하게 처리해야 함 |
| P1 | 출력 로그 영속화·회전 | 중 | Action Run Report의 선행 작업이며 비밀 마스킹 재검증이 필요 |
| P2 | Action Run Report | 중 | 태스크별 실행 데이터를 새로 수집해야 하며 영속 로그에 의존 |
| P3 | CMSIS-SVD 기반 Register/SFR Hover | 대 | XML 파서와 상속·배열·cluster 지원이 필요 |
| P3 | Memory Map → 소스 위치 이동 | 대 | 정확한 구현에는 DWARF line 정보가 필요 |

권장 착수 순서는 **Input Profiles → 로그 → 실행 보고서**입니다.
CMSIS-SVD와 DWARF는 독립된 대형 작업으로 분리합니다.

## 1. Named Input Profiles

`inputBox`·`quickPick`·파일/폴더 선택 등 반복 입력 조합을 이름 붙여 재사용합니다.

- 첫 구현은 팀 파일이 아닌 `workspaceState`에 저장합니다. 로컬 포트와 경로가 커밋되는 것을 막기 위해서입니다.
- 기존 `presetInputs` 실행 경로와 현재 값 검증을 재사용합니다.
- `password: true` 입력은 저장하지 않습니다.
- 액션의 task ID가 바뀌면 누락된 값을 조용히 무시하지 않고 다시 묻거나 프로필을 오래된 상태로 표시합니다.
- 저장·실행·이름 변경·삭제 흐름을 History와 액션 메뉴에 제공합니다.

팀 공유 요구가 확인되면 `.vscode/` 파일, 스키마, Doctor 검사와 마이그레이션을 별도 단계로 설계합니다.

## 2. 출력 로그 영속화와 회전

액션 실행 출력을 워크스페이스 내부에 저장하고 개수 또는 기간 기준으로 정리합니다.

- 후보 경로: `.taskhub/logs/<actionId>/<timestamp>.log`
- 명령줄·cwd·stdout/stderr·실패 사유가 모두 비밀 마스킹을 거치는지 먼저 검증합니다.
- `.taskhub/`의 Git 제외 안내와 워크스페이스 외부 쓰기 방어를 포함합니다.
- 캡처 상한으로 잘린 출력은 완전한 로그처럼 표시하지 않습니다.
- 보관 개수·기간·총 용량의 우선순위를 정하고 회전 실패가 액션 실행을 실패시키지 않게 합니다.

## 3. Action Run Report

History 항목에서 태스크별 실행 결과를 조회하는 보고서를 제공합니다.

- 태스크별 소요 시간, 종료 코드, 상태, diagnostics 개수와 생성 파일을 수집합니다.
- 비밀 입력과 마스킹 전 명령줄은 보고서에 저장하지 않습니다.
- 큰 본문은 `workspaceState`에 넣지 않고 영속 로그를 참조합니다.
- 로그 기능과 데이터 모델을 먼저 안정화한 뒤 UI를 추가합니다.

## 4. CMSIS-SVD 기반 Register/SFR Hover

SVD 파일을 새 데이터 소스로 읽어 기존 Register Decoder와 SFR 표시 계층에 연결합니다.

- `derivedFrom`, `dim`/`dimIncrement`, cluster와 기본값 상속을 포함해야 합니다.
- 1~10MB 실파일을 고려한 파싱 한도와 캐시가 필요합니다.
- XML 런타임 의존성을 추가할지 제한된 전용 파서를 만들지 먼저 결정합니다.
- 파서와 hover 연결을 별도 단계로 나누고 실제 벤더 파일 기반 fixture를 둡니다.

## 5. Memory Map → 소스 위치 이동

심볼 행에서 정의된 소스 파일과 줄로 이동합니다.

- 정확한 구현은 ELF의 DWARF `.debug_line` 정보가 필요합니다.
- Workspace Symbol Provider 기반 이름 검색은 C++ 오버로드·mangled 이름에서 오탐 가능성이 있어 보조 경로로만 검토합니다.
- DWARF가 없거나 stripped된 바이너리는 기능을 숨기거나 한계를 명확히 안내합니다.

## 테스트 부채

- `jsonEditorUtils.test.ts`의 소스 문자열 정규식 검사를 실행 기반 테스트로 점진적으로 교체합니다.
