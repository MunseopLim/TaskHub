# TaskHub VS Code 확장 프로그램

반복적인 개발 작업을 자동화하고, 임베디드 C/C++ 개발을 위한 전문 도구를 제공하는 VS Code 확장 프로그램입니다.

## 주요 기능

### 워크플로우 자동화

- **사용자 정의 액션**: 셸 명령, 파일 압축/해제, 문자열 처리 등 다양한 태스크를 JSON으로 정의하고 실행
- **파이프라인**: 여러 태스크를 순서대로 실행하며 `${task_id.property}` 형식으로 결과를 연결
- **액션 생성 마법사**: 코드 작성 없이 대화형 UI로 새 액션 생성
- **Preset**: 프로젝트 환경별 action 설정을 팀원들과 공유하고 적용

### 패널 구성

| 패널 | 설명 |
|------|------|
| **메인 패널** | 액션 버튼과 폴더 트리, 검색/그룹화 지원 |
| **링크 패널** | Built-in / Workspace 링크 관리 (브라우저 열기, 복사, 편집) |
| **즐겨찾기 패널** | 자주 사용하는 파일을 줄 번호와 함께 저장 |
| **히스토리 패널** | 액션 실행 기록 추적, 상태 표시, 빠른 재실행 |

### C/C++ Hover 기능

임베디드 개발에 특화된 hover tooltip을 제공합니다:

- **Number Base Hover**: 숫자 리터럴의 진법 자동 변환 (Hex / Dec / Bin) 및 비트 정보 표시
- **SFR Bit Field Hover**: 레지스터 비트 필드 정보 (비트 위치, 접근 타입, 리셋 값, 비트 마스크)
- **Struct Size Hover**: 구조체/클래스의 크기, 멤버별 오프셋, 패딩 자동 계산
- **커스텀 타입 설정**: `.vscode/taskhub_types.json`으로 프로젝트별 타입 크기 정의
- **Bit Operation Hover** (실험적): 비트 연산 결과 미리보기

### 기타

- Multi-root 워크스페이스 완벽 지원
- 검색 및 그룹화 기능
- JSON 스키마 기반 설정 검증
- 실행 중인 액션 개별/전체 종료

> 각 기능의 상세 설명, JSON 예제, hover 출력 예시 등은 [docs/features.md](docs/features.md)를 참조하세요.

## 설정

| 설정 ID | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `taskhub.showTaskStatus` | `boolean` | `true` | 액션 상태 아이콘 및 완료 팝업 알림 활성화 |
| `taskhub.pipeline.showVerboseLogs` | `boolean` | `false` | 파이프라인 실행 시 상세 로그 표시 |
| `taskhub.pipeline.pythonIoEncoding` | `string` | `utf-8` | `PYTHONIOENCODING` 환경 변수 값 |
| `taskhub.pipeline.windowsPowerShellEncoding` | `string` | `utf8` | Windows PowerShell 출력 인코딩 |
| `taskhub.history.maxItems` | `number` | `10` | 히스토리 최대 개수 (1-50) |
| `taskhub.history.showPanel` | `boolean` | `true` | 히스토리 패널 표시 여부 |
| `taskhub.hover.numberBase.enabled` | `boolean` | `true` | Number Base / SFR Hover 활성화 |
| `taskhub.experimental.bitOperationHover.enabled` | `boolean` | `false` | [실험적] 비트 연산 hover 활성화 |
| `taskhub.preset.selected` | `string` | `none` | 자동 적용할 프리셋 선택 |

## 설치

1. 이 저장소를 클론합니다.
2. VS Code에서 프로젝트를 엽니다.
3. 터미널에서 `npm install`을 실행합니다.
4. `F5` 키를 눌러 새 확장 개발 호스트 창에서 확장 프로그램을 실행합니다.

## 사용법

1. 활동 표시줄의 'H' 아이콘을 클릭하여 TaskHub 뷰를 엽니다.
2. '메인 패널'에서 다양한 액션을 탐색하고 '링크 패널'에서 리소스에 빠르게 접근합니다.
3. `.vscode/actions.json`, `.vscode/links.json`, `.vscode/favorites.json` 파일을 수정하여 사용자 지정합니다.

## 문서

| 문서 | 설명 |
|------|------|
| [docs/features.md](docs/features.md) | 상세 기능 문서 (태스크 타입, JSON 예제, hover 기능 등) |
| [docs/architecture.md](docs/architecture.md) | 프로젝트 구조, 주요 컴포넌트, 데이터 구조 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 개발 환경 셋업, 빌드, 테스트, 기여 가이드 |
| [CHANGELOG.md](CHANGELOG.md) | 버전별 변경 이력 |
