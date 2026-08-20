# TaskHub 기능 로드맵

이 문서는 **아직 구현되지 않은 기능과 기술 부채**만 추적합니다. 이미 배포된 기능은
[CHANGELOG.md](../CHANGELOG.md), 현재 사용법은 [features.md](./features.md)를 참조하세요.
새 후보가 확정되면 우선순위와 규모도 함께 기록합니다.

## 우선순위

| 우선순위 | 항목 | 규모 | 핵심 이유 |
| --- | --- | --- | --- |
| P2 | Memory Map DWARF 5·압축 line table | 대 | 현재 지원 범위 밖인 디버그 정보를 가진 ELF에서도 소스 이동 제공 |

## Memory Map DWARF 5·압축 line table

DWARF 5의 새 line-table header·directory/file entry format과 문자열 form을 해석하고,
`SHF_COMPRESSED` 및 GNU `.zdebug_line`을 기존 파서 한도 안에서 복원합니다.

- DWARF 5의 `address_size`, `segment_selector_size`, entry format descriptor와 관련 문자열
  section 참조를 검증한 뒤 DWARF 2~4와 같은 주소 범위로 변환합니다.
- 압축을 해제하기 전에 선언 크기와 실제 출력 크기를 검증하고 32MB `.debug_line` 상한을
  동일하게 적용합니다.
- DWARF 2~4, stripped ELF, 손상된 unit의 현재 동작과 opaque host target 경계를 유지합니다.

## 테스트 부채

- `jsonEditorUtils.test.ts`의 소스 문자열 정규식 검사를 실행 기반 테스트로 점진적으로 교체합니다.
