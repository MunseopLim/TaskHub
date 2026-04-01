# TaskHub 아키텍처

이 문서는 TaskHub의 프로젝트 구조, 주요 컴포넌트, 데이터 구조를 설명합니다.

## 프로젝트 구조

```
TaskHub/
├── src/
│   ├── extension.ts                  # 메인 확장 파일
│   │                                  # - activate() / deactivate()
│   │                                  # - Provider: MainView, Link, Favorite, History
│   │                                  # - 액션 실행: executeAction(), executeSingleTask()
│   ├── schema.ts                      # TypeScript 타입 정의
│   ├── numberBaseHoverProvider.ts     # Number Base / SFR Bit Field / Struct Size Hover
│   ├── sfrBitFieldParser.ts           # SFR 비트 필드 파서
│   ├── structSizeCalculator.ts        # 구조체 크기/레이아웃 계산
│   ├── registerDecoder.ts             # 레지스터 비트 필드 디코더
│   ├── macroExpander.ts               # C/C++ 매크로 전처리기
│   ├── elfParser.ts                   # ELF32 바이너리 파서
│   ├── linkerScriptParser.ts          # GNU/ARM 링커 스크립트 파서
│   ├── armLinkListParser.ts           # ARM Linker Listing 파서 (armlink --list)
│   ├── memoryMapViewer.ts             # Memory Map WebView 시각화
│   └── test/
│       ├── extension.test.ts              # 확장 유닛 테스트
│       ├── numberBaseHoverProvider.test.ts # Hover 제공자 테스트
│       ├── sfrBitFieldParser.test.ts      # SFR 파서 테스트
│       ├── structSizeCalculator.test.ts   # 구조체 크기 계산 테스트
│       ├── registerDecoder.test.ts        # 레지스터 디코더 테스트
│       ├── macroExpander.test.ts          # 매크로 확장 테스트
│       ├── elfParser.test.ts              # ELF 파서 테스트
│       └── armLinkListParser.test.ts      # ARM Linker Listing 파서 테스트
├── schema/
│   ├── actions.schema.json       # actions.json 스키마 및 검증
│   ├── links.schema.json         # links.json 스키마 및 검증
│   ├── favorites.schema.json     # favorites.json 스키마 및 검증
│   └── taskhub_types.schema.json # taskhub_types.json 스키마 (커스텀 타입 설정)
├── media/
│   ├── h_icon.svg            # 메인 뷰 아이콘
│   ├── actions.json          # 기본 제공 액션 예제
│   ├── links.json            # 기본 제공 링크 예제
│   └── *_example.json        # 각종 예제 파일들
├── presets/
│   └── preset-example.json   # 프리셋 예제 파일
├── docs/
│   ├── features.md           # 상세 기능 문서
│   └── architecture.md       # 이 파일
├── .vscode/
│   ├── actions.json          # 워크스페이스별 액션 (선택사항)
│   ├── links.json            # 워크스페이스별 링크 (선택사항)
│   ├── favorites.json        # 워크스페이스별 즐겨찾기 (선택사항)
│   └── taskhub_types.json    # 커스텀 타입 크기 설정 (선택사항)
├── package.json              # 확장 메타데이터, 설정, 명령어, 뷰 정의
├── CHANGELOG.md              # 변경 이력
├── CONTRIBUTING.md           # 개발 가이드
└── README.md                 # 사용자 안내
```

**빌드 출력:**
- `dist/extension.js`: esbuild, CommonJS, 단일 파일 번들
- `out/`: tsc 컴파일 (테스트용)
- 외부 의존성: `vscode` (번들에서 제외)

## 주요 컴포넌트

### 1. TreeDataProvider (extension.ts)

각 패널은 `vscode.TreeDataProvider`를 구현합니다:

*   **MainViewProvider**: 액션 버튼과 폴더 트리 관리
*   **LinkViewProvider**: Built-in 및 Workspace 링크 관리
*   **FavoriteViewProvider**: 즐겨찾기 파일 관리
*   **HistoryProvider**: 액션 실행 히스토리 관리

### 2. 액션 실행 파이프라인

*   **executeAction()**: 메인 액션 실행 함수 (히스토리 추적 통합)
*   **executeSingleTask()**: 개별 태스크 실행
    *   지원 태스크 타입: fileDialog, folderDialog, unzip, zip, stringManipulation, inputBox, quickPick, shell/command
*   **변수 치환**: `${task_id.property}` 형식으로 파이프라인 간 데이터 전달
*   **파일 감시**: debounce({ run, cancel }) 패턴으로 JSON 변경 감지

### 3. C/C++ Hover 모듈

`numberBaseHoverProvider.ts`가 진입점 (HoverProvider 구현)이며, 내부적으로 다음 모듈을 호출합니다:

| 모듈 | 역할 |
|------|------|
| `sfrBitFieldParser.ts` | SFR 비트 필드 주석 파싱 및 계층 구조 추출 |
| `structSizeCalculator.ts` | 구조체/클래스 크기, 오프셋, 패딩 계산 |
| `registerDecoder.ts` | 레지스터 비트 필드 값 추출 및 디코딩 |
| `macroExpander.ts` | C/C++ 전처리기 매크로 확장 (`#define`, `#if`/`#else`) |

**LSP 통합:** `vscode.commands.executeCommand('vscode.executeDefinitionProvider', ...)` 사용
**캐시:** mtime 기반 캐시로 `taskhub_types.json` 설정 로드 최적화

## 데이터 구조

### HistoryEntry

```typescript
interface HistoryEntry {
    actionId: string;        // 액션 ID
    actionTitle: string;     // 액션 제목
    timestamp: number;       // 실행 시간 (Unix timestamp)
    status: 'success' | 'failure' | 'running';  // 실행 상태
    output?: string;         // 출력 (실패 시 에러 메시지)
}
```

### LinkEntry

```typescript
interface LinkEntry {
    title: string;
    link: string;
    group?: string;
    tags?: string[];
    sourceFile?: string;
}
```

### FavoriteEntry

```typescript
interface FavoriteEntry {
    title: string;
    path: string;
    line?: number;
    group?: string;
    tags?: string[];
    sourceFile?: string;
    workspaceFolder?: string;
}
```

## 설정 및 저장소

*   **workspaceState**: 히스토리 데이터 저장 (VS Code API)
    *   키: `'taskhub.actionHistory'`
    *   값: `HistoryEntry[]` 배열

*   **configuration**: VS Code 설정
    *   `taskhub.history.maxItems`: 히스토리 최대 개수 (1-50, 기본값: 10)
    *   `taskhub.history.showPanel`: 패널 표시 여부 (기본값: true)

## 실험적 기능 패턴

새 실험적 기능 추가 시:

1. `package.json`에 `taskhub.experimental.<name>.enabled` 설정 추가 (default: false)
2. 필요 시 `views`에 `"when": "config.taskhub.experimental.<name>.enabled"` 조건부 뷰 추가
3. `activate()` 내에서 설정 확인 후 조건부 등록
4. `docs/features.md` 섹션 16에 문서화

현재 실험적 기능: Bit Operation Hover (`taskhub.experimental.bitOperationHover.enabled`)

> 실험적 기능의 상세 추가 가이드는 [CONTRIBUTING.md](../CONTRIBUTING.md)를 참조하세요.

## 개발 시 주의사항

1. **히스토리 기능 수정 시**:
   *   `HistoryProvider` 클래스 수정 (`extension.ts`)
   *   `executeAction()` 함수의 히스토리 추적 로직 확인
   *   테스트 업데이트 (`src/test/extension.test.ts`)

2. **새 패널 추가 시**:
   *   `package.json`의 `views` 섹션에 뷰 정의 추가
   *   `extension.ts`에 TreeDataProvider 클래스 구현
   *   `activate()` 함수에서 등록

3. **새 명령어 추가 시**:
   *   `package.json`의 `commands` 섹션에 명령어 정의
   *   `activate()` 함수에서 명령어 핸들러 등록
   *   필요 시 `menus` 섹션에서 UI 위치 지정

4. **스키마 수정 시**:
   *   `schema/*.schema.json` 파일 업데이트
   *   JSON 검증 로직 확인

## 디버깅

*   **F5** 키: Extension Development Host 실행
*   breakpoint 설정 가능
*   Console 로그: `Developer: Toggle Developer Tools`
*   Output 패널: "TaskHub" 채널에서 로그 확인
