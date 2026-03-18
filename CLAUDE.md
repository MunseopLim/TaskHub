# CLAUDE.md

TaskHub는 VS Code 확장 프로그램으로, 반복적인 개발 작업 자동화와 임베디드 C/C++ 개발 지원 도구를 제공합니다.

## 빌드 & 테스트 명령어

```bash
npm run compile          # 타입 체크 + 린트 + esbuild 번들링
npm run package          # 프로덕션 빌드 (minify 포함)
npm run check-types      # TypeScript 타입 체크만
npm run lint             # ESLint 검사 (src/)
npm run test             # 유닛 테스트 실행 (vscode-test)
npm run watch            # 개발 시 watch 모드 (esbuild + tsc 병렬)
```

커밋 전 반드시 `npm run package` 실행하여 타입 체크, 린트, 빌드가 모두 통과하는지 확인.

## 프로젝트 구조

```
src/
├── extension.ts               # 메인 진입점 (activate/deactivate, Provider, 명령어 핸들러)
├── schema.ts                  # TypeScript 인터페이스 정의
├── numberBaseHoverProvider.ts # Number Base / SFR / Struct Size Hover 통합
├── sfrBitFieldParser.ts       # SFR 비트 필드 주석 파서
├── structSizeCalculator.ts    # 구조체 크기/레이아웃 계산
├── registerDecoder.ts         # 레지스터 비트 필드 디코더
├── macroExpander.ts           # C/C++ 매크로 전처리기
└── test/                      # 모듈별 유닛 테스트 (Mocha + Chai)

schema/   # JSON Schema 파일 (actions, links, favorites, taskhub_types)
media/    # 아이콘, 기본 제공 JSON 예제
presets/  # 프리셋 예제
```

- 빌드 출력: `dist/extension.js` (esbuild, CommonJS, 단일 파일 번들)
- 테스트 출력: `out/` (tsc 컴파일)
- 외부 의존성: `vscode` (번들에서 제외)

## 코딩 컨벤션

- **TypeScript**: strict 모드, ES2022 타겟, Node16 모듈
- **세미콜론** 필수
- **===** 사용 (== 금지)
- **중괄호** 필수 (if/else/for 등)
- **네이밍**: camelCase (함수/변수), PascalCase (클래스/인터페이스)
- **들여쓰기**: 4 spaces (탭 아님)
- **문서 언어**: 한국어 기본 (README, CHANGELOG, 커밋 메시지)

## 커밋 메시지

```
[버전] 변경 설명
```

예시:
- `[0.2.36] npm 취약점 해결 및 의존성 업데이트`
- `[0.2.35] codex 코드 리뷰 반영 및 성능 개선`

Co-Authored-By 라인이나 `[claude]` 태그는 넣지 않는다.

## 아키텍처 핵심

### extension.ts 구조
- **TreeDataProvider 4종**: MainViewProvider, LinkViewProvider, FavoriteViewProvider, HistoryProvider
- **액션 실행**: `executeAction()` → `executeSingleTask()` (9가지 태스크 타입)
- **변수 치환**: `${task_id.property}` 형식으로 파이프라인 간 데이터 전달
- **파일 감시**: debounce({ run, cancel }) 패턴으로 JSON 변경 감지

### C/C++ Hover 모듈
- `numberBaseHoverProvider.ts`가 진입점 (HoverProvider 구현)
- 내부적으로 `sfrBitFieldParser`, `structSizeCalculator`, `registerDecoder`, `macroExpander` 호출
- LSP 통합: `vscode.commands.executeCommand('vscode.executeDefinitionProvider', ...)` 사용
- mtime 기반 캐시로 `taskhub_types.json` 설정 로드 최적화

## 실험적 기능 패턴

새 실험적 기능 추가 시:

1. `package.json`에 `taskhub.experimental.<name>.enabled` 설정 추가 (default: false)
2. 필요 시 `views`에 `"when": "config.taskhub.experimental.<name>.enabled"` 조건부 뷰 추가
3. `activate()` 내에서 설정 확인 후 조건부 등록
4. README.md 섹션 16에 문서화

현재 실험적 기능: Bit Operation Hover (`taskhub.experimental.bitOperationHover.enabled`)

## npm overrides

보안 취약점 해결을 위해 다음 패키지에 override 적용 중:
- `minimatch`: mocha/eslint 내부 의존성
- `diff`: mocha 내부 의존성
- `serialize-javascript`: mocha 내부 의존성 (RCE 취약점)

override 제거 전에 `npm audit`으로 취약점 상태 확인 필요.

## 테스트 작성

```typescript
suite('ModuleName Test Suite', () => {
  suite('Category', () => {
    test('should do something', () => {
      assert.strictEqual(result, expected);
    });
  });
});
```

- 테스트 파일: `src/test/<module>.test.ts`
- 프레임워크: Mocha + Chai (assert 스타일)
- 테스트 설정: `.vscode-test.mjs`
