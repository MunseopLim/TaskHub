# Change Log

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
