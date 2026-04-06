# Change Log

## [0.3.6] - 2026-04-07

### Enhanced

**UI 개선: 버전 클릭 → Changelog, 예제 JSON 버튼 이동**
- 메인 패널 버전 항목 클릭 시 CHANGELOG.md를 열도록 변경
- 예제 JSON 보기 버튼을 패널 제목 표시줄의 전구(💡) 아이콘으로 이동하여 발견성 개선

**예제 JSON 보강**
- `command` 타입 예제 추가 (VS Code 빌트인 명령 실행)
- `confirm` 타입 예제 추가 (확인 대화상자)
- `shell` 타입에 `env`, `cwd`, `args` 속성 예제 추가
- `fileDialog`의 모든 출력 변수 (`path`, `dir`, `name`, `fileNameOnly`, `fileExt`) 예제 추가
- `folderDialog`에 `title` 옵션 예제 추가
- `inputBox`의 `password` 속성 예제 추가
- `stringManipulation`의 누락된 함수 5개 (`extension`, `stripExtension`, `toLowerCase`, `toUpperCase`, `trim`) 예제 추가
- Complete Example에 `confirm` 단계 추가

## [0.3.5] - 2026-04-06

### Added

**Memory Map: HTML 저장 기능**
- Memory Map 패널 상단에 "Save HTML" 버튼 추가
- 현재 화면 상태(펼침/접기, 검색 필터 등)를 그대로 standalone HTML 파일로 저장
- 저장된 파일은 브라우저에서 바로 열 수 있어 팀 공유 및 보관 용도로 활용 가능

## [0.3.4] - 2026-04-03

### Fixed

**Memory Map: Region 내 Section/Function/Object 중복 표시 수정**
- Object Summary 상세 행에서 Section 컬럼이 Object 이름과 동일하게 표시되던 버그 수정 (section 필드 우선 표시로 변경)
- ARM 링커 리스팅 파서에서 알 수 없는 prefix의 토큰이 section과 func에 동일하게 설정되던 버그 수정
- `.mysection.FuncName` 형식의 미등록 prefix도 함수명 추출 지원 (두 번째 `.` 이후 추출)

## [0.3.3] - 2026-04-03

### Enhanced

**Memory Map: Region Details UI 개선**
- Region Details 테이블에 Section 컬럼 복원 (Function 토글로 Section/Function 함께 표시/숨김)
- Region Details 테이블에 End Address 컬럼 복원
- Object Summary를 그래프 바 아래로 이동, 기본 접힘 상태로 변경 (클릭으로 펼침/접기)
- Object Summary Details 버튼: 오브젝트별 섹션 상세(Section, Address, End, Size, Type) 행 표시
- Details 버튼 크기를 다른 버튼과 통일

### Fixed

**테이블 정렬 개선**
- Size/Bytes/% 컬럼 첫 클릭 시 내림차순으로 정렬 (이후 토글)
- Object Summary 상세 행이 정렬에 영향을 주지 않도록 수정
- CSS로 숨긴 상세 행의 토글이 동작하지 않던 버그 수정 (getComputedStyle 사용)

## [0.3.2] - 2026-04-03

### Enhanced

**Memory Map: AXF/ELF 심볼 기반 상세 분석**
- ELF 프로그램 헤더(PT_LOAD)로 메모리 리전 자동 감지 — 링커 스크립트 없이도 FLASH/RAM 영역 표시
- ELF 심볼 테이블(.symtab) 파싱으로 함수/변수 단위 크기 분석
- 링커 스크립트 없이 AXF 파일만으로도 리전별 사용량, Free Space 확인 가능

**Memory Map: Region별 오브젝트 요약**
- 각 Region Details 내부에 오브젝트(.o)별 크기 집계 및 해당 region 내 점유율(%) 표시
- Code/RO/RW/ZI 분류별 크기 세부 표시 (Details 토글, region 단위 독립 동작)

**Memory Map: 함수명 추출 및 표시**
- armlink listing 파서가 섹션 토큰에서 함수명 추출 (`.text._ZN4Func` → `_ZN4Func`)
- Region Details 테이블에 Function 컬럼 추가 (토글 버튼으로 표시/숨김)
- 테이블 메인 컬럼을 Object로 변경하여 오브젝트 파일명 표시

## [0.3.0] - 2026-04-02

### Added

**다국어 지원 (i18n)**
- VS Code 언어 설정에 따라 한국어/영어 메시지 자동 전환
- `src/i18n.ts` 모듈 추가: `t(ko, en)` 헬퍼 함수
- 모든 Viewer 및 extension.ts의 사용자 대면 메시지 적용

### Fixed

**WebView 패널 메시지 핸들러 중복 등록**
- JSON Editor, Hex Viewer, Memory Map에서 패널 재사용 시 이전 핸들러를 dispose 후 새로 등록하도록 수정
- 다른 파일 저장 시 이전 파일에 덮어쓸 수 있던 버그 수정

**프리셋 자동 적용 시 중복 ID 처리**
- workspace/preset 간 중복 action ID가 있을 때 전체 로딩 실패 대신 경고 로그로 변경

**구조체 크기 계산 개선**
- `char *ptr;`, `int *p;` 스타일 포인터 멤버 파싱 지원
- Forward reference 해결: 미등록 타입 참조 시 multi-pass로 재시도, 최종 fallback 처리

**Import 검증 강화**
- Import 파일 내부의 중복 action ID 사전 검증 추가

### Enhanced

**Viewer 에러 메시지 개선**
- 파일 크기 제한 추가 (Hex Viewer: 50MB, Memory Map: 100MB, JSON Editor: 10MB)
- 파싱 오류, 파일 읽기 실패 등 상세 에러 메시지 표시

## [0.2.52] - 2026-04-02

### Fixed

**Memory Map Free Space 계산 개선**
- Free space 계산 버그 수정: 섹션 겹침 시 cursor 역행으로 free 영역이 부풀려지던 문제 해결
- Alignment padding (1~3바이트) free space를 Calc Free 및 세그먼트 레이아웃 바에서 제외
- Used 계산을 실제 점유 영역 기반으로 변경: 섹션 겹침/경계 초과 시에도 used + free ≤ max 보장
- Size 컬럼 정렬 시 단위(B/KB/MB)를 고려한 실제 바이트 크기 기준 정렬
- 세그먼트 레이아웃 바의 화면 폭 축소 시 free/used 비율 왜곡 수정 (border → gap, min-width 제거)

### Enhanced

**Memory Map 시각화 UX 개선**
- AXF/ELF와 ARM Linker Listing 파싱 결과 화면 통일: Overview 테이블 컬럼 구조 및 Region 헤더 포맷 일관성 확보
- Region 요약 테이블 row 클릭 시 해당 Region Details로 스크롤 및 자동 펼침
- Region Details 내 섹션 테이블에 컬럼 정렬 기능 추가 (Section, Address, Size, Bytes, Type)
- Region 이름 왼쪽 정렬로 변경
- AXF/ELF 파싱 시 데이터 한계 안내 메시지 표시
- Floating 맨 위로 이동 버튼 추가 (스크롤 200px 이상 시 표시)

## [0.2.50] - 2026-04-02

### Fixed

**Hex Viewer 대용량 파일 지원**
- 바이너리 파일 포맷 오감지 수정: SREC 정규식 multiline 플래그로 인해 대용량 바이너리가 SREC로 오인되는 버그 수정
- Virtual scrolling 적용: 패딩 행(spacer tr) 방식으로 화면에 보이는 행만 렌더링하여 대용량 파일에서 WebView 응답 없음 문제 해결
- 바이너리 파싱 최적화: Map 대신 Uint8Array 사용으로 16MB+ 파일의 Map 크기 초과 오류 해결

## [0.2.47] - 2026-04-01

### Added

**Hex Viewer**
- `TaskHub: Open Hex Viewer` 명령어로 펌웨어 이미지 파일을 Hex dump로 표시
- Intel HEX (`.hex`), Motorola SREC (`.srec`, `.s19`), Raw Binary (`.bin`) 포맷 자동 감지
- Unit 크기 옵션: 1/2/4/8바이트 단위로 표시 전환
- Little-Endian / Big-Endian 전환
- Hex 바이트 패턴 검색 (`Ctrl+F`), Go to Address
- 바이트 선택 시 상태바에 u8/u16/u32 값 해석 표시
- Gap 영역 (데이터 없는 주소) 회색 표시

### Testing
- `hexParser` 유닛 테스트 추가 (Intel HEX, SREC, Binary, toFlatArray, hasData)

## [0.2.46] - 2026-04-01

### Enhanced

**액션 Import/Export UX 개선**
- 메인 패널에서 액션/폴더 우클릭 → "Export Action" 컨텍스트 메뉴 추가 (개별 내보내기)
- 메인 패널 타이틀바에 Import 아이콘 추가 (빠른 접근)
- Import 후 메인 뷰 자동 새로고침

### Testing
- `countActionItems` 유닛 테스트 추가 (단일 액션, 폴더, 중첩 폴더, 빈 폴더)

## [0.2.45] - 2026-04-01

### Enhanced

**Memory Map UI 개선**
- Overview 테이블: Used/Calc Used, Free/Calc Free 컬럼 분리로 링커 보고값과 계산값 명확히 구분
- Region Details: Linker Free / Calc Free 구분 표시
- `Ctrl+Shift+O`: section 대신 region 단위로 이동하도록 변경
- Expand All / Collapse All 버튼 추가
- Flash/RAM 요약 카드 제거 (Overview 테이블로 대체)

## [0.2.44] - 2026-04-01

### Added

**Memory Map 검색 및 탐색 기능**
- 키워드 검색: 섹션 이름, 주소, 타입으로 전체 테이블 필터링 (접힌 region 내부도 검색, 매치 시 자동 펼침)
- `Ctrl+Shift+O` 심볼 검색: VS Code QuickPick으로 region 목록 표시 후 해당 위치로 스크롤
- Region 요약 테이블: 상단에 각 region별 Base, Max, Used, Free, Usage 한눈에 표시

### Enhanced

**Memory Map 표시 개선**
- Region 폴딩: 기본 접힘 상태, 클릭으로 토글 (헤더 + 사용률 바는 항상 표시)
- Linker/Calc 값 구분 표시: listing 파일의 Base, Size, Max 원본 값과 직접 계산한 Used, Free 값을 구분
- Overview 테이블에 Linker Size / Calc Used 컬럼 분리 (listing 파일일 때)

### Fixed

**Listing 파일 메모리 사용량 계산 오류 수정**
- 주소 범위 매칭 대신 execution region 소속 기반으로 계산하여 region 간 중복 집계 해소
- 괄호 없는 엔트리(예: `Region$$Table`) 섹션 이름 추출 개선

## [0.2.43] - 2026-04-01

### Added

**ARM Linker Listing 파서**
- `armlink --list` 출력 파일(`*_axf_link.txt`) 파싱 지원
- ARM Compiler 5 (armcc) / ARM Compiler 6 (armclang) 포맷 모두 지원
- Execution Region에서 메모리 영역 크기 자동 추출 (별도 링커 스크립트 불필요)
- 섹션별 집계 및 오브젝트 파일별 기여도 표시

### Enhanced

**Memory Map Free Space 표시**
- 메모리 영역 내 빈 공간(Free Space) 시각화
- 세그먼트 레이아웃 바: 섹션별 색상 블록 + Free Space 표시
- 영역 카드 테이블에 Address, Type 컬럼 추가, 주소순 정렬
- 영역 헤더에 Free 크기 표시
- 텍스트 리포트에 Free Space 정보 포함

**커밋 전 체크리스트 강화**
- 유닛 테스트 실행 필수화 (CLAUDE.md, CONTRIBUTING.md)
- 기능 변경 시 관련 문서 업데이트 가이드 추가

## [0.2.42] - 2026-03-31

### Added

**Memory Map 시각화**
- ARM `.axf`/`.elf` 바이너리의 메모리 사용량을 WebView에서 시각화
- ELF32 바이너리 직접 파싱 (외부 도구 불필요)
- Flash/RAM 사용률 바 차트, 섹션별 상세 정보 표시
- `.vscode/taskhub_types.json`의 `memoryMap.regions`로 메모리 영역 크기 설정
- GNU 링커 스크립트(`.ld`) 및 ARM Scatter File(`.sct`) 자동 파싱으로 메모리 영역 감지
- Cortex-R/M 시리즈 지원 (Little/Big Endian)

### Enhanced

**JSON 에디터 개선**
- 최상위 배열 형식(actions.json 등) 파일 지원
- 중첩 객체를 JSON 텍스트로 편집 가능
- 객체 배열 미리보기 개선 (`{ key1, key2, ... }` 형식)
- 불필요한 변환 버튼(`s→a`, `a→s`) 제거
- 빈 셀 클릭 시 잘못된 Modified 표시 버그 수정
- 우클릭 메뉴에서 "TaskHub:" 접두사 제거

## [0.2.40] - 2026-03-31

### Added

**`confirm` 태스크 타입**
- 파이프라인 실행 중 사용자 확인 대화상자를 표시하는 새 태스크 타입 추가
- `message`, `confirmLabel`, `cancelLabel` 속성 지원
- 변수 치환(`${...}`) 지원으로 동적 메시지 구성 가능
- 취소 시 파이프라인 실행을 안전하게 중단

**액션 Import/Export**
- `TaskHub: Export Actions` 명령어로 워크스페이스 액션을 `.taskhub` 파일로 내보내기
- `TaskHub: Import Actions` 명령어로 외부 파일에서 액션 가져오기
- `.taskhub` 형식과 raw `actions.json` 배열 형식 모두 지원
- 가져오기 시 ID 중복 검사 및 스키마 유효성 검증
- 팀원 간 액션 공유, 백업, 프로젝트 간 이동에 활용

## [0.2.36] - 2026-03-18

### Fixed

**npm 취약점 해결 (0 vulnerabilities)**
- `serialize-javascript` override 추가 (`6.0.2` → `^7.0.4`)
  - mocha 내부 의존성의 RCE 취약점(GHSA-5c6j-r48x-rmvq) 해결
- eslint, @typescript-eslint 등 devDependencies 마이너 업데이트

### Removed

- 불필요한 문서 파일 정리
  - `vsc-extension-quickstart.md` (VS Code 템플릿 파일)
  - `CODE_REVIEW_BY_CODEX.md` (1회성 리뷰 기록, 이미 반영 완료)

## [0.2.35] - 2026-02-19

### Enhanced

**성능 개선 및 코드 리뷰 반영**
- `debounce`를 `{ run, cancel }` API로 변경하고 watcher 해제 시 `cancel()` 호출
- `loadTypeConfig`의 absent-file 캐시를 `statSync` 호출 전에 확인하도록 수정
- regex/pattern 상수를 모듈 스코프로 호이스팅 (`macroExpander`, `sfrBitFieldParser`, `numberBaseHoverProvider`)
- mtime 기반 type config 캐시 추가 (`NumberBaseHoverProvider`)

### Fixed

**npm 취약점 해결 (16 → 7)**
- `npm-run-all`을 `npm-run-all2`로 교체
- `minimatch`, `diff`에 overrides 적용하여 high/moderate 취약점 9개 해결

### Testing
- debounce 단위 테스트 및 cancel API 테스트 추가

## [0.2.34] - 2026-02-19

### Fixed

**Codex 코드 리뷰 반영 (4건)**
- `structSizeCalculator`: 커스텀 타입 설정 로드 시 기본 타입과 머지하도록 수정 (`||` → spread merge)
- `registerDecoder`: union 파서의 중괄호 추적을 주석/문자열 인식 방식으로 개선
- `extension`: 즐겨찾기 삭제 시 title+group까지 포함한 엄격한 식별자로 변경
- `extension`: 'Keep both' UI 문구를 실제 동작과 일치하도록 수정

### Enhanced

**npm 의존성 업데이트**
- `@typescript-eslint/eslint-plugin`: `^7.0.0` → `^8.0.0` (ESLint 10 호환)
- `@typescript-eslint/parser`: `^6.15.0` → `^8.0.0` (ESLint 10 호환, 버전 통일)
- `@vscode/test-cli`: `^0.0.11` → `^0.0.12`
- `mocha`: `^5.0.5` → `^11.0.0` (minimist/minimatch/diff 취약점 해소)
- `npm-run-all`: `^1.1.3` → `^4.1.5`

## [0.2.33] - 2026-02-09

### Fixed

**코드 안정성 개선**
- `macroExpander`: 순환 참조 감지 시 `expandingMacros` Set 정리 누락 수정 (try/finally)
- `numberBaseHoverProvider`: non-null assertion 제거 및 안전한 null 체크 추가
- `numberBaseHoverProvider`: LSP 요청에 3초 timeout 추가
- `registerDecoder`/`structSizeCalculator`: 문자열/주석 내 중괄호 무시하도록 파싱 개선
- `extension`: deactivate 시 글로벌 Map/Set 메모리 정리 추가

### Testing
- platform 변경 테스트에 try/finally 적용하여 복원 보장

## [0.2.32] - 2026-01-20

### Added

**커스텀 타입 설정 파일 지원** (`.vscode/taskhub_types.json`)
- 프로젝트별로 커스텀 타입 크기와 alignment를 정의할 수 있는 설정 파일 지원
- JSON 스키마 자동 완성 및 유효성 검사 지원 (`taskhub_types.schema.json`)
- `packingAlignment` 옵션으로 구조체 패킹 정렬 설정 가능

### Testing
- 커스텀 타입 설정 관련 테스트 추가

## [0.2.31] - 2026-01-20

### Fixed

**Struct Size Calculator - Windows 타입 지원**
- Windows 타입들의 크기가 올바르게 표시되지 않던 문제 수정
  - 기존: `UINT16`, `UINT64` 등이 모두 기본값 4바이트로 표시됨
  - 수정: 각 타입의 실제 크기로 표시

### Added

**Windows 타입 지원** (`structSizeCalculator.ts`)
- 8비트: `BYTE`, `CHAR`, `UCHAR`, `UINT8`, `INT8`, `BOOLEAN`
- 16비트: `WORD`, `SHORT`, `USHORT`, `UINT16`, `INT16`
- 32비트: `DWORD`, `LONG`, `ULONG`, `UINT32`, `INT32`, `BOOL`
- 64비트: `QWORD`, `LONGLONG`, `ULONGLONG`, `UINT64`, `INT64`, `DWORD64`

**커스텀 타입 자동 등록** (`numberBaseHoverProvider.ts`)
- 문서 내의 모든 struct/class 정의를 자동으로 파싱하여 등록
- 중첩된 커스텀 타입(예: `Test32Class`를 멤버로 가진 구조체)의 크기가 올바르게 계산됨
- 다중 패스 의존성 해결로 복잡한 타입 체인 지원
- 중복 이름 및 forward declaration 처리

**커스텀 타입 설정 파일 지원** (`.vscode/taskhub_types.json`)
- 프로젝트별로 커스텀 타입 크기와 alignment를 정의할 수 있는 설정 파일 지원
- JSON 스키마 자동 완성 및 유효성 검사 지원
- 예시:
  ```json
  {
    "types": {
      "HANDLE": { "size": 8, "alignment": 8 },
      "MyCustomType": { "size": 16, "alignment": 4 }
    },
    "packingAlignment": 8
  }
  ```

### Testing

- Windows Types 테스트 7개 추가
  - `UINT8/UINT16`, `UINT32/UINT64`, `DWORD/QWORD`, `BYTE/WORD/DWORD` 등
- Custom Type Registration 테스트 5개 추가
  - `Test32Class`, `Test64Class`, 복잡한 Context 구조체
  - 의존성 체인 테스트 (TypeA → TypeB → TypeC)
- 총 429개 테스트 통과 (기존 417개 + 신규 12개)

## [0.2.30] - 2026-01-16

### Fixed

**Codex Code Review 기반 버그 수정**

- **registerDecoder.ts**: 32비트 필드에서 비트 마스크 계산 오류 수정
  - `extractFieldValue`에서 `bitWidth >= 32`일 때 `(1 << 32)`가 1로 wrap되는 JavaScript 비트 연산 한계 처리
  - 입력 검증 추가 (`bitStart < 0` 또는 `bitEnd < bitStart` 체크)

- **sfrBitFieldParser.ts**: `calculateBitMask` 함수 32비트 처리 오류 수정
  - `bitEnd > 31` 또는 `bitStart < 0` 범위 검증 추가
  - 전체 32비트 마스크 (`0xFFFFFFFF`) 올바르게 생성

- **numberBaseHoverProvider.ts**: `extractValueFromLine`에서 잘못된 값 반환 방지
  - `symbolName`이 주어졌을 때 해당 심볼의 값만 정확히 매칭하도록 수정
  - 같은 줄에 여러 값이 있을 때 관련 없는 값 반환 문제 해결

- **extension.ts**: 빈 `cwd` 문제 수정
  - 워크스페이스 없이 실행 시 `cwd: ''`로 인한 `ENOENT` 에러 방지
  - `undefined`로 설정하여 Node.js가 `process.cwd()` 사용하도록 변경

- **extension.ts**: "Keep both" 프리셋 병합 시 중복 ID 문제 수정
  - 기존: 단순 배열 병합으로 중복 ID 발생 → validation 실패로 전체 로딩 불가
  - 수정: `filterConflictingItems` 함수로 충돌하는 ID를 가진 항목 자동 필터링
  - `findConflictingIds`에 undefined 체크 추가

### Enhanced

**schema.ts 타입 안전성 개선**
- `options?: any` → 구체적인 `OpenDialogOptions` 인터페이스로 변경
- `inputs?: { [key: string]: string }` → `Record<string, string>`으로 단순화

### Testing

- `filterConflictingItems` 테스트 8개 추가
  - 충돌 ID 필터링, 중첩 children 재귀 필터링, 원본 불변성 확인 등
- `findConflictingIds` 테스트 6개 추가
  - 기본 충돌 감지, 중첩 충돌, 다중 충돌 처리 등
- 총 417개 테스트 통과 (기존 403개 + 신규 14개)

## [0.2.29] - 2026-01-15

### Enhanced

**SFR Bit Field Hover - Access Type Description**
- Access Type 약어에 대한 설명이 hover tooltip에 표시됩니다
  - 예: `RW1C` → `RW1C (Write 1 to Clear)`
- 지원되는 Access Type:
  - `RO` (Read Only)
  - `WO` (Write Only)
  - `RW` (Read / Write)
  - `RW1C` (Write 1 to Clear)
  - `RW1S` (Write 1 to Set)
  - `W1C` (Write 1 to Clear)
  - `RWC` (Read / Write Clear)
  - `RWS` (Sticky bit)

### Testing
- Added 12 unit tests for `getAccessTypeDescription` function

## [0.2.28] - 2026-01-12

### Fixed

**History Status Update**
- Fixed history panel not updating status when action is manually stopped via stop button
  - History entries now correctly show 'failure' status with "Action stopped by user" message
  - Previously, stopped actions would remain in 'running' state indefinitely
  - Added timestamp tracking system (`actionStartTimestamps` Map) to properly correlate stop events with history entries
  - Stop button now immediately updates history status when clicked

### Added

**Testing**
- Added comprehensive unit tests for action stop and history update functionality
  - 11 new test cases covering timestamp tracking, history status updates, and edge cases
  - All 391 tests passing

## [0.2.27] - 2026-01-04

### Added

**Preset 기능**
- 프로젝트 환경별 action 설정을 쉽게 공유하고 적용할 수 있는 Preset 시스템 추가
- **Apply Preset** 명령어: 미리 정의된 preset을 워크스페이스에 적용
  - Replace 모드: 기존 actions.json을 preset으로 교체
  - Merge 모드: 기존 actions와 preset을 병합
  - ID 충돌 시 3가지 해결 전략 제공 (Keep existing/Use preset/Keep both)
- **Save as Preset** 명령어: 현재 actions를 preset으로 저장
  - Workspace preset (`.vscode/presets/`): Git으로 팀원들과 공유 가능
  - Extension preset (`presets/`): 확장 프로그램에 번들로 포함
  - Custom location: 원하는 위치에 파일로 저장
- Extension preset과 workspace preset 자동 발견 및 선택 가능
- 예제 preset 파일 포함 (`presets/preset-example.json`)

**활용 사례**
- 팀 내 여러 환경(integration, hil 등) 간 action 설정 공유
- 새 프로젝트 시작 시 빠른 초기 설정
- 환경별 Git/빌드 명령어 템플릿 관리

## [0.2.26] - 2026-01-03

### First Public Release

TaskHub는 반복적인 개발 작업을 자동화하고, 임베디드 시스템 개발을 위한 전문 도구를 제공하는 VS Code 확장 프로그램입니다.

#### 핵심 기능

**워크플로우 자동화**
- 사용자 정의 액션 및 파이프라인 실행 (셸 명령, 파일 압축/해제, 문자열 처리 등)
- 즐겨찾는 링크와 파일을 한 곳에서 관리
- 액션 실행 히스토리 추적 및 재실행

**임베디드 개발 지원 (C/C++)**
- **Number Base Hover**: 숫자 리터럴의 진법 자동 변환 (Hex ↔ Dec ↔ Bin)
- **SFR Bit Field Hover**: 레지스터 비트 필드 정보 표시 (비트 위치, 접근 타입, 리셋 값, 비트 마스크)
- **Bit Operation Hover** (실험적): 비트 연산 결과 미리보기

**생산성 향상**
- Multi-root 워크스페이스 완벽 지원
- 검색 및 그룹화 기능
- 액션 생성 마법사
- JSON 스키마 기반 설정 검증

임베디드 개발자와 자동화가 필요한 모든 개발자를 위한 올인원 도구입니다.

## [0.2.10] - 2024-11-08

- Added explicit activation events for every exposed view and command so the extension reliably loads before TaskHub UI or palette actions are used.
- Restored `tsc --noEmit` by supplying compatibility declarations for the latest `minimatch` types consumed by `@types/glob`.
- Reworked actions, links, and favorites to understand multi-root workspaces: every `.vscode/*.json` file is monitored per folder, commands prompt for a target folder, and metadata flows through so placeholders such as `${workspaceFolder}` resolve correctly when executing actions.
- Capture-mode tasks now register their spawned processes, allowing `taskhub.stopAction` and `taskhub.terminateAllActions` to cancel pipelines that only streamed output through the output channel.
- Registered the example JSON command as a disposable and refreshed documentation to describe the new behaviour.

## [0.1.0]

- Initial release
