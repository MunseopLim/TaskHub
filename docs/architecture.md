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
│   ├── i18n.ts                        # 다국어 지원 (한국어/영어, vscode.env.language 기반)
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

## 보안 가드

TaskHub는 사용자가 JSON으로 정의한 임의 명령을 실행하므로, 위험한 입력에 대해 다음 방어 계층을 유지한다:

1.  **변수 치환(`interpolatePipelineVariables`) 입력 정화**
    *   `sanitizeInterpolatedValue(value)`에서 null 바이트(`\0`)를 거부하고 32KB 길이 상한을 강제한다.
    *   object/array 값은 치환 대신 placeholder를 그대로 유지한다 (`${id.prop}` 원형).
2.  **파일 경로 검증(`resolveWithinWorkspace`)**
    *   Task output mode가 `file`일 때, 치환 결과를 `path.resolve` → `path.relative(root, resolved)` 순으로 검사해 워크스페이스 루트 외부 쓰기를 거부한다.
    *   상대 경로(`"report.txt"`, `"build/out.log"` 등)는 `process.cwd()`가 아니라 실행 중인 액션의 워크스페이스 폴더(`defaultWorkspace`) 기준으로 resolve한다. 이를 위해 `resolveWithinWorkspace(targetPath, roots, baseDir)` 시그니처의 3번째 인자로 액션 워크스페이스를 전달한다.
3.  **쉘 인자 이스케이프**
    *   POSIX: `quotePosixArgument`가 각 인자를 싱글쿼트로 감싸고 내부 싱글쿼트는 `'\''`로 이스케이프.
    *   Windows: `buildPowerShellInvocation`이 `quotePowerShellArgument`로 각 인자를 싱글쿼트로 감싸고 PowerShell `-EncodedCommand`로 전달.
4.  **WebView 보안**
    *   모든 WebView(HexViewer, JSON Editor, Memory Map)는 `Content-Security-Policy` 메타 태그를 포함한다.
    *   `script-src`는 패널마다 새로 생성되는 16바이트 nonce만 허용한다. nonce는 `crypto.randomBytes(16).toString('base64')`(CSPRNG)로 생성되며, 인라인 스크립트 전부에 동일 nonce를 부여한다.
    *   CSP가 인라인 이벤트 핸들러를 차단하므로, 모든 UI 컨트롤은 `data-action` 속성을 달고 nonce 스크립트 내부의 위임(delegated) 리스너에서 처리한다. 새 버튼/컨트롤을 추가할 때 절대 `onclick="..."` 형태를 쓰지 말 것.
    *   에러/정보 HTML 출력은 `escapeHtml` 경유를 강제한다.
5.  **파서 입력 한도**
    *   ELF32: 헤더 최소 크기/섹션 테이블/string table 범위를 선검증.
    *   Intel HEX/SREC: 레코드당 최대 255바이트, 누적 `HEX_MAX_BYTE_ENTRIES` 초과 시 throw.
    *   Hex Viewer 렌더링: `HEX_VIEWER_MAX_SPAN = 128 MB`. 주소 범위가 이를 초과하면(sparse 파일) 렌더링 거부.
    *   Macro 전처리: shift 카운트 0–63 clamp, 수식 길이 4KB 제한.
6.  **Hover 타임아웃 및 비동기 IO**
    *   `withLspTimeout(promise, token, 3000)`으로 모든 LSP 호출을 감싼다. `activeHoverCalls: Set<string>`이 동일 위치 재진입을 막는다.
    *   `taskhub_types.json` 로드는 `fs.promises.*`(stat/readFile/realpath) 기반이다. 느린 스토리지에서도 extension host 이벤트 루프를 블로킹하지 않는다.

보안 관련 변경 시 관련 유닛 테스트(`src/test/extension.test.ts`의 `sanitizeInterpolatedValue`, `resolveWithinWorkspace`, 파서별 `defensive` suite)를 함께 갱신한다.
