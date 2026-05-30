# TaskHub Examples

이 폴더에는 TaskHub의 각 기능을 직접 테스트해볼 수 있는 예제 파일들이 있습니다. 각 파일을 VSCode에서 열어 hover/뷰어 기능을 시연할 수 있습니다.

상세 기능 설명은 [`docs/features.md`](../docs/features.md) 참조.

## 파일 → 기능 매핑

| 파일 | 대응 기능 | 참조 |
|---|---|---|
| [test_numbers.cpp](test_numbers.cpp) | Number Base Hover (숫자 리터럴) | features.md §15.1 |
| [test_const_enum_define.cpp](test_const_enum_define.cpp) | Number Base Hover (const / enum / #define 식별자) | features.md §15.1 |
| [test_sfr_bitfields.h](test_sfr_bitfields.h) | SFR Bit Field Hover | features.md §15.2 |
| [test_register_decoder.h](test_register_decoder.h) | Register Value Decoder Hover | features.md §15.5 |
| [test_macro_expansion.h](test_macro_expansion.h) | Macro Expansion Hover | features.md §15.6 |
| [bit_operations_example.h](bit_operations_example.h), [bit_operations_example.cpp](bit_operations_example.cpp) | Bit Operation Hover (Experimental) | features.md §16.1 |
| [sample_armlink.txt](sample_armlink.txt), [sample_armlink_large.txt](sample_armlink_large.txt) | Memory Map Viewer (ARM linker list) | features.md §19 |
| [sample_binary.bin](sample_binary.bin) | Hex Viewer | features.md §20 |

## 참고: VSIX 패키징에서 제외됨

이 폴더는 [.vscodeignore](../.vscodeignore)에서 제외되므로 마켓플레이스 배포물(VSIX)에는 포함되지 않습니다. 개발·테스트용 리포지토리 자산입니다.
