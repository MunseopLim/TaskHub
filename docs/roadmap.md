# TaskHub 기능 로드맵

이 문서는 **아직 구현되지 않은 기능과 기술 부채**만 추적합니다. 이미 배포된 기능은
[CHANGELOG.md](../CHANGELOG.md), 현재 사용법은 [features.md](./features.md)를 참조하세요.
새 후보가 확정되면 우선순위와 규모도 함께 기록합니다.

## 우선순위

| 우선순위 | 항목 | 규모 | 핵심 이유 |
| --- | --- | --- | --- |
| P3 | Memory Map 압축·DWARF64·`strx` 경로 지원 | 중 | 드문 대형·압축·split 디버그 정보에서도 소스 이동 제공 |

## Memory Map 압축·DWARF64·`strx` 경로 지원

`SHF_COMPRESSED` 및 GNU `.zdebug_line`·`.zdebug_line_str`·`.zdebug_str`과 DWARF64 line unit,
`.debug_str_offsets` 기반 `DW_FORM_strx*` 및 supplementary object의 `DW_FORM_strp_sup` 경로를
기존 파서 한도 안에서 복원하고 해석합니다.

- 압축을 해제하기 전에 선언 크기와 실제 출력 크기를 검증하고 `.debug_line` 32MB 및 문자열·누적
  디코딩 상한을 압축 line/string section에도 동일하게 적용합니다.
- DWARF64의 64-bit 길이·문자열 offset을 safe integer 범위 안에서만 처리합니다.
- split DWARF의 문자열 offset table을 경계 검증하고 `DW_FORM_strx`·`strx1`~`strx4` 경로를 해석합니다.
- supplementary object를 안전하게 찾고 `DW_FORM_strp_sup` 경로 offset을 경계 안에서 해석합니다.
- DWARF 2~5, stripped ELF, 손상된 unit의 현재 동작과 opaque host target 경계를 유지합니다.

## 테스트 부채

- `jsonEditorUtils.test.ts`의 소스 문자열 정규식 검사를 실행 기반 테스트로 점진적으로 교체합니다.
