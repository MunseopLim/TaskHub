# TaskHub Examples

이 폴더에는 TaskHub의 각 기능을 직접 테스트해볼 수 있는 예제 파일들이 있습니다. 각 파일을 VSCode에서 열어 hover/뷰어 기능을 시연할 수 있습니다.

상세 기능 설명은 [`docs/features.md`](../docs/features.md) 참조.

## 파일 → 기능 매핑

| 파일 | 대응 기능 | 참조 |
|---|---|---|
| [test_numbers.cpp](test_numbers.cpp) | Number Base Hover (숫자 리터럴) | features.md §15.1 |
| [test_const_enum_define.cpp](test_const_enum_define.cpp) | Number Base Hover (const / enum / #define 식별자) | features.md §15.1 |
| [test_sfr_bitfields.h](test_sfr_bitfields.h) | SFR Bit Field Hover | features.md §15.2 |
| [test_register_decoder.h](test_register_decoder.h) | Register Value Decoder Hover | features.md §15.x |
| [test_macro_expansion.h](test_macro_expansion.h) | Macro Expansion Hover | features.md §15.x |
| [bit_operations_example.h](bit_operations_example.h), [bit_operations_example.cpp](bit_operations_example.cpp) | Bit Operation Hover (Experimental) | features.md §16.1 |
| [sample_armlink.txt](sample_armlink.txt), [sample_armlink_large.txt](sample_armlink_large.txt) | Memory Map Viewer (ARM linker list) | features.md §19 |
| [sample_binary.bin](sample_binary.bin) | Hex Viewer | features.md §20 |

## C/C++ Hover 기능 (Stable)

### 1. Number Base Hover

숫자 값에 마우스를 올리면 hex / decimal / binary 변환과 비트 정보를 표시합니다.

- **[test_numbers.cpp](test_numbers.cpp)** — `0xFF`, `0b1010`, `1'000'000` 등 다양한 리터럴 형식 위에서 hover
- **[test_const_enum_define.cpp](test_const_enum_define.cpp)** — `const int MASK = 0xFF;`, `enum { FLAG_A = 0x01 };`, `#define MAX_SIZE 0x1000` 등 식별자 위에서 hover 시 값이 해석되어 표시됨

### 2. SFR Bit Field Hover

임베디드 개발에서 사용하는 SFR(Special Function Register) 비트 필드 주석을 파싱하여 비트 위치·접근 타입·리셋 값·마스크를 표시합니다.

- **[test_sfr_bitfields.h](test_sfr_bitfields.h)** — `int0_set`, `int_field_0` 같은 필드 위에서 hover. 선언부뿐 아니라 `uIntTestSts.rst.int0_set = 1;` 같은 사용처에서도 동작

인식되는 주석 형식:
```cpp
Type field_name : bit_width; // [bit_pos][ACCESS_TYPE][reset_val] Description
```

### 3. Register Value Decoder

`reg.dword = 0x...;` 같은 할당문의 숫자 값 위에서 hover하면, 해당 레지스터의 비트 필드 정의를 참조하여 각 필드가 어떻게 디코드되는지 표시합니다.

- **[test_register_decoder.h](test_register_decoder.h)** — UART / IRQ / GPIO 제어 레지스터 예제. 예: `uart_ctrl.dword = 0x30B;` 의 `0x30B` 위에서 hover → `TX_EN=1, RX_EN=1, PARITY_EN=0, STOP_BITS=1, BAUD_SEL=3`로 디코드되어 표시

### 4. Macro Expansion Hover

`#define`으로 정의된 매크로 식별자 위에서 hover 시 최종 확장 결과를 표시합니다. 다른 매크로를 참조하는 compound/nested 매크로도 재귀 확장.

- **[test_macro_expansion.h](test_macro_expansion.h)** — 단순/복합/다단계 중첩 매크로 모두 포함
  - `MAX_SIZE` → `0x1000`
  - `IRQ_ENABLE` → `(1 << 0) | (1 << 5) | 0x40` → `0x61`
  - `UART_CTRL` → `BASE_ADDR + REG_OFFSET` → `0x40001000`
  - `LEVEL4` → `LEVEL3 → LEVEL2 → LEVEL1` 다단계 확장 경로

## Bit Operation Hover (Experimental)

변수의 비트 연산이나 상수 비트 표현식 위에서 hover 시 연산 전·후 값을 hex/dec/bin으로 함께 표시합니다.

### 활성화

VSCode 설정에서 활성화 필요:

- `taskhub.experimental.bitOperationHover.enabled` = `true`

### 예제 파일

- **[bit_operations_example.h](bit_operations_example.h)** — 레지스터 비트 설정/클리어, 마스킹, 시프트, 플래그 관리, 필드 조작 등 헤더 스타일 패턴
- **[bit_operations_example.cpp](bit_operations_example.cpp)** — GPIO / SPI / Timer / ADC / DMA / Flash 등 실용적 예제, 지원되지 않는 패턴과 우회 방법 포함

### 지원 패턴

✅ 가능한 경우
- `value |= 0x80` — 할당 연산자 (`|=`, `&=`, `^=`, `<<=`, `>>=`)
- `value & 0xFF` — 비트 연산자 (`&`, `|`, `^`, `<<`, `>>`)
- `~value` — NOT 연산
- `1U << 5`, `0xFF & 0x0F` — 상수 표현식 (항상 결과 표시)
- 오른쪽 피연산자는 **반드시 숫자 리터럴**

❌ 지원되지 않는 경우
- `a ^ b` — 변수와 변수 간 연산
- `value &= func()` — 함수 호출 결과와의 연산
- `value &= (1 << bit)` — 외곽은 불가, 내부 `1 << bit` 상수 표현식만 hover 가능

### Before 값 표시 조건

변수 연산의 경우 LSP로 정의를 찾아 초기값이 리터럴일 때만 Before 값이 표시됩니다. 파라미터, 함수 반환값, 런타임 계산 결과는 After만 표시됩니다.

상수 표현식은 정적 계산이 가능하므로 항상 Left / Result 형식으로 표시됩니다.

## Memory Map Viewer

ARM linker listing 파일을 Memory Map 뷰어로 시각화합니다.

- **[sample_armlink.txt](sample_armlink.txt)** — 기본 크기 샘플
- **[sample_armlink_large.txt](sample_armlink_large.txt)** — 많은 섹션을 포함한 대용량 샘플

사용법: 파일 열기 → 명령 팔레트 → `TaskHub: Open Memory Map`.

## Hex Viewer

바이너리 파일을 hex/ASCII 이중 패널로 탐색합니다.

- **[sample_binary.bin](sample_binary.bin)** — 다양한 바이트 값이 섞인 샘플 바이너리

사용법: 파일 열기 → 명령 팔레트 → `TaskHub: Open Hex Viewer`.

## 참고: VSIX 패키징에서 제외됨

이 폴더는 [.vscodeignore](../.vscodeignore)에서 제외되므로 마켓플레이스 배포물(VSIX)에는 포함되지 않습니다. 개발·테스트용 리포지토리 자산입니다.
