# TaskHub 기능 로드맵

이 문서는 **아직 구현되지 않은 기능과 기술 부채**만 추적합니다. 이미 배포된 기능은
[CHANGELOG.md](../CHANGELOG.md), 현재 사용법은 [features.md](./features.md)를 참조하세요.
우선순위와 규모는 요구사항이 바뀌면 함께 갱신합니다.

## 우선순위

| 우선순위 | 항목 | 규모 | 핵심 이유 |
| --- | --- | --- | --- |
| P1 | Action Run Report | 중 | 영속 로그의 태스크별 실행 데이터를 History UI에 안전하게 연결해야 함 |
| P3 | CMSIS-SVD 기반 Register/SFR Hover | 대 | XML 파서와 상속·배열·cluster 지원이 필요 |
| P3 | Memory Map → 소스 위치 이동 | 대 | 정확한 구현에는 DWARF line 정보가 필요 |

권장 다음 작업은 영속 로그 데이터를 사용하는 **실행 보고서**입니다.
CMSIS-SVD와 DWARF는 독립된 대형 작업으로 분리합니다.

## 1. Action Run Report

History 항목에서 태스크별 실행 결과를 조회하는 보고서를 제공합니다.

- 태스크별 소요 시간, 종료 코드, 상태, diagnostics 개수와 생성 파일을 수집합니다.
- 비밀 입력과 마스킹 전 명령줄은 보고서에 저장하지 않습니다.
- 큰 본문은 `workspaceState`에 넣지 않고 버전 1 `ActionRunLog`를 참조합니다.
- 로그가 꺼져 있거나 회전된 History 항목은 보고서 본문이 없음을 명확히 표시합니다.

## 2. CMSIS-SVD 기반 Register/SFR Hover

SVD 파일을 새 데이터 소스로 읽어 기존 Register Decoder와 SFR 표시 계층에 연결합니다.

- `derivedFrom`, `dim`/`dimIncrement`, cluster와 기본값 상속을 포함해야 합니다.
- 1~10MB 실파일을 고려한 파싱 한도와 캐시가 필요합니다.
- XML 런타임 의존성을 추가할지 제한된 전용 파서를 만들지 먼저 결정합니다.
- 파서와 hover 연결을 별도 단계로 나누고 실제 벤더 파일 기반 fixture를 둡니다.

## 3. Memory Map → 소스 위치 이동

심볼 행에서 정의된 소스 파일과 줄로 이동합니다.

- 정확한 구현은 ELF의 DWARF `.debug_line` 정보가 필요합니다.
- Workspace Symbol Provider 기반 이름 검색은 C++ 오버로드·mangled 이름에서 오탐 가능성이 있어 보조 경로로만 검토합니다.
- DWARF가 없거나 stripped된 바이너리는 기능을 숨기거나 한계를 명확히 안내합니다.

## 테스트 부채

- `jsonEditorUtils.test.ts`의 소스 문자열 정규식 검사를 실행 기반 테스트로 점진적으로 교체합니다.
