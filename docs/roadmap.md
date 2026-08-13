# TaskHub 기능 로드맵

이 문서는 **아직 구현되지 않은 기능과 기술 부채**만 추적합니다. 이미 배포된 기능은
[CHANGELOG.md](../CHANGELOG.md), 현재 사용법은 [features.md](./features.md)를 참조하세요.
우선순위와 규모는 요구사항이 바뀌면 함께 갱신합니다.

## 우선순위

| 우선순위 | 항목 | 규모 | 핵심 이유 |
| --- | --- | --- | --- |
| P0 | 백그라운드 완료 알림 | 소 | 기존 `durationMs`를 재사용할 수 있어 비용 대비 체감 효과가 큼 |
| P0 | ELF 심볼 → Hex dump | 소~중 | 현재 Memory Map 탐색 흐름을 바이너리 바이트까지 연결 |
| P1 | Named Input Profiles | 소~중 | 반복 입력을 보존하되 비밀·오래된 task ID를 안전하게 처리해야 함 |
| P1 | 출력 로그 영속화·회전 | 중 | Action Run Report의 선행 작업이며 비밀 마스킹 재검증이 필요 |
| P2 | Action Run Report | 중 | 태스크별 실행 데이터를 새로 수집해야 하며 영속 로그에 의존 |
| P3 | CMSIS-SVD 기반 Register/SFR Hover | 대 | XML 파서와 상속·배열·cluster 지원이 필요 |
| P3 | Memory Map → 소스 위치 이동 | 대 | 정확한 구현에는 DWARF line 정보가 필요 |

권장 착수 순서는 **완료 알림 → 심볼/Hex 연결 → Input Profiles → 로그 → 실행 보고서**입니다.
CMSIS-SVD와 DWARF는 독립된 대형 작업으로 분리합니다.

## 1. 백그라운드 완료 알림

설정한 시간보다 오래 걸린 액션이 끝났을 때 알림과 짧은 상태 표시를 제공합니다.

- 완료 시점의 `durationMs`와 `vscode.window.state.focused`를 사용합니다.
- 성공·실패·중지 알림의 정책과 임계값을 설정으로 제공합니다.
- 여러 액션이 비슷한 시각에 끝나면 알림을 묶어 폭주를 막습니다.
- `taskhub.showTaskStatus`와 새 설정의 역할이 겹치지 않도록 정의합니다.

## 2. ELF 심볼 → Hex dump

Memory Map의 심볼이나 섹션에서 해당 바이트를 Hex Viewer로 엽니다.

- [elfParser.ts](../src/elfParser.ts)가 `sh_offset`·`p_offset`을 보존하고 가상 주소를 파일 오프셋으로 변환해야 합니다.
- `.bss`/`NOBITS`처럼 파일에 바이트가 없는 심볼은 명확히 거절합니다.
- ARM Linker Listing에는 대응 바이너리가 없으므로 진입점을 노출하지 않습니다.
- Memory Map은 100MB, Hex Viewer는 50MB 제한이므로 큰 ELF의 실패 경로를 안내합니다.
- Hex Viewer의 기존 Go-to/selection 흐름을 재사용합니다.

## 3. Named Input Profiles

`inputBox`·`quickPick`·파일/폴더 선택 등 반복 입력 조합을 이름 붙여 재사용합니다.

- 첫 구현은 팀 파일이 아닌 `workspaceState`에 저장합니다. 로컬 포트와 경로가 커밋되는 것을 막기 위해서입니다.
- 기존 `presetInputs` 실행 경로와 현재 값 검증을 재사용합니다.
- `password: true` 입력은 저장하지 않습니다.
- 액션의 task ID가 바뀌면 누락된 값을 조용히 무시하지 않고 다시 묻거나 프로필을 오래된 상태로 표시합니다.
- 저장·실행·이름 변경·삭제 흐름을 History와 액션 메뉴에 제공합니다.

팀 공유 요구가 확인되면 `.vscode/` 파일, 스키마, Doctor 검사와 마이그레이션을 별도 단계로 설계합니다.

## 4. 출력 로그 영속화와 회전

액션 실행 출력을 워크스페이스 내부에 저장하고 개수 또는 기간 기준으로 정리합니다.

- 후보 경로: `.taskhub/logs/<actionId>/<timestamp>.log`
- 명령줄·cwd·stdout/stderr·실패 사유가 모두 비밀 마스킹을 거치는지 먼저 검증합니다.
- `.taskhub/`의 Git 제외 안내와 워크스페이스 외부 쓰기 방어를 포함합니다.
- 캡처 상한으로 잘린 출력은 완전한 로그처럼 표시하지 않습니다.
- 보관 개수·기간·총 용량의 우선순위를 정하고 회전 실패가 액션 실행을 실패시키지 않게 합니다.

## 5. Action Run Report

History 항목에서 태스크별 실행 결과를 조회하는 보고서를 제공합니다.

- 태스크별 소요 시간, 종료 코드, 상태, diagnostics 개수와 생성 파일을 수집합니다.
- 비밀 입력과 마스킹 전 명령줄은 보고서에 저장하지 않습니다.
- 큰 본문은 `workspaceState`에 넣지 않고 영속 로그를 참조합니다.
- 로그 기능과 데이터 모델을 먼저 안정화한 뒤 UI를 추가합니다.

## 6. CMSIS-SVD 기반 Register/SFR Hover

SVD 파일을 새 데이터 소스로 읽어 기존 Register Decoder와 SFR 표시 계층에 연결합니다.

- `derivedFrom`, `dim`/`dimIncrement`, cluster와 기본값 상속을 포함해야 합니다.
- 1~10MB 실파일을 고려한 파싱 한도와 캐시가 필요합니다.
- XML 런타임 의존성을 추가할지 제한된 전용 파서를 만들지 먼저 결정합니다.
- 파서와 hover 연결을 별도 단계로 나누고 실제 벤더 파일 기반 fixture를 둡니다.

## 7. Memory Map → 소스 위치 이동

심볼 행에서 정의된 소스 파일과 줄로 이동합니다.

- 정확한 구현은 ELF의 DWARF `.debug_line` 정보가 필요합니다.
- Workspace Symbol Provider 기반 이름 검색은 C++ 오버로드·mangled 이름에서 오탐 가능성이 있어 보조 경로로만 검토합니다.
- DWARF가 없거나 stripped된 바이너리는 기능을 숨기거나 한계를 명확히 안내합니다.

## 테스트 부채

- `jsonEditorUtils.test.ts`의 소스 문자열 정규식 검사를 실행 기반 테스트로 점진적으로 교체합니다.
- Windows 명령 실행·인자 quoting·프로세스 트리 종료 테스트가 추가된 CI의 Windows runner에서
  실제로 통과하는지 확인한 뒤 이 항목을 제거합니다.
