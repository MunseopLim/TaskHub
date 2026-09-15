# Contributing to TaskHub

이 문서는 TaskHub에 기여할 때의 **개발자 워크플로우**(환경 셋업·빌드/테스트·로컬 실행·실험적 기능 추가·PR·npm overrides)를 다룹니다.

프로젝트 구조·주요 컴포넌트·데이터 구조·활성화·보안은 [docs/architecture.md](docs/architecture.md)에, 코딩 컨벤션·i18n 규칙·커밋 메시지 형식은 [CLAUDE.md](CLAUDE.md)에 있습니다. 중복 서술 대신 해당 문서를 참조하세요.

## 개발 환경 셋업

### 요구사항
- Node.js 22 이상 (`nvm` 사용 시 저장소의 `.nvmrc`로 버전 선택)
- npm
- Visual Studio Code

### 설치
```bash
nvm use    # nvm을 사용하는 경우
npm ci
```

## 빌드 & 테스트

```bash
npm run compile          # 타입 체크 + 린트 + esbuild 번들링
npm run package          # 프로덕션 빌드 (minify 포함)
npm run check-version    # 버전 동기화와 변경 범위에 따른 버전 증가 검사
npm run check-types      # TypeScript 타입 체크만
npm run lint             # ESLint 검사 (src/)
npm run test             # 유닛·통합·웹뷰 테스트 실행 (vscode-test)
npm run watch            # 개발 시 watch 모드 (esbuild + tsc 병렬)
```

esbuild 는 **번들 두 개**를 만든다 — 확장 호스트용 `dist/extension.js` 와 JSON Editor
webview 의 로직 번들 `dist/jsonEditorWebview.js`. 후자가 없으면 JSON Editor 화면이
통째로 비므로, 테스트를 직접 돌릴 때(`npm run test` 는 `pretest` 가 알아서 빌드한다)나
`vscode-test` 를 수동으로 부를 때는 `node esbuild.js` 를 먼저 실행한다. 배경은
[docs/architecture.md](docs/architecture.md) "webview 스크립트의 두 층" 참조.

### CI 워크플로와 커밋 전 검증

[`.github/workflows/`](.github/workflows/)의 전체 워크플로는 다음과 같다. 실행 조건과 명령의
원본은 각 YAML이며, 워크플로를 추가하거나 검사·환경을 바꾸면 이 표도 함께 갱신한다.

| 워크플로 / 정의 원본 | 실행 조건 | 환경·설치 | 검사·산출물 | 원격 변경 |
| --- | --- | --- | --- | --- |
| **CI** — [ci.yml](.github/workflows/ci.yml) | `main` 브랜치 push, `pull_request`, 수동 `workflow_dispatch` | `ubuntu-latest`·`windows-latest`, Node.js `22`, `npm ci`, Git 전체 이력 | Linux: `xvfb-run -a npm test`; Windows: `npm test`. 버전 비교 기준은 PR의 base SHA 또는 push 직전 SHA | 없음 (`contents: read`) |
| **Release** — [release.yml](.github/workflows/release.yml) | `v*.*.*` 패턴의 태그 push | `ubuntu-latest`, Node.js `22`, `npm ci`, Git 전체 이력 | 태그의 `v`를 뺀 값과 `package.json` 버전 일치 검사 → `xvfb-run -a npm test` → `npx --yes @vscode/vsce@3.9.0 package --out "taskhub-${VSIX_VERSION}.vsix"` (`VSIX_VERSION`은 검사한 패키지 버전) | GitHub Release 생성·릴리스 노트 자동 생성·VSIX 첨부 (`contents: write`) |
| **Dependency Audit** — [security-audit.yml](.github/workflows/security-audit.yml) | 매주 월요일 `03:23` UTC (`23 3 * * 1`), 수동 `workflow_dispatch` | `ubuntu-latest`, Node.js `22`, `npm ci` | `npm audit --omit=dev --audit-level=high`로 운영 의존성의 high 이상 취약점 검사 | 없음 (`contents: read`) |

`npm test`는 `pretest`에서 버전 검사·테스트 컴파일·타입 검사·린트·확장과 웹뷰 번들 빌드를 수행한 뒤
VS Code Extension Host에서 테스트한다. 별도로 요구하는 `npm run package`도 버전 검사 후 프로덕션 빌드를 수행하며,
VSIX 생성은 [VSIX 패키지 빌드 및 설치](#vsix-패키지-빌드-및-설치)를 참고한다. Release의 로컬
재현에는 표에 지정한 `vsce` 버전과 패키징 명령을 사용한다. Dependency Audit는 일반 push/PR에서
자동으로 실행되지 않으므로, 의존성 변경의 검증을 CI 테스트 결과로 대신하지 않는다.

#### 커밋 전 체크리스트

**매 커밋 전, 현재 변경사항이 모든 워크플로에서 통과할 수 있는지 검토한다.** 로컬에서 실행할
수 있는 검사는 실제로 통과시킨 뒤 커밋하며, 실행할 수 없는 환경의 검토 결과와 한계도 남긴다.

1. **전체 워크플로 영향 확인**: 위 표와 `.github/workflows/`의 실제 파일 목록을 대조하고 각 YAML을 읽는다. 변경사항이 테스트·의존성 설치·취약점 검사·버전 검사·VSIX 패키징에 주는 영향과 대상 OS·Node.js 버전을 확인한다. 태그나 일정에서만 실행되는 워크플로도 검토 대상이다.
2. **알려진 CI 실패 확인**: 현재 브랜치와 관련 PR의 실패한 실행이 있으면 해당 job의 OS·로그·실패 테스트를 확인한다. 변경사항과 관련되거나 현재 커밋에도 남아 있는 실패는 원인을 수정하고 다시 검증한다. 환경 또는 외부 서비스 문제로 재현·해결할 수 없으면 근거와 미검증 범위를 기록한다.
3. **로컬 검사 실행**: [버전 관리](AGENTS.md#버전-관리)에 따른 갱신을 마친 뒤, Node.js `22`와 잠금 파일 기준 `npm ci`로 설치를 확인하고 `npm run test` 전체와 `npm run package`를 통과시킨다. 두 명령이 먼저 수행하는 [버전 검사](#버전-검사)도 필수다. 변경 영향이 있는 Audit·Release 검사도 위 표에 따라 로컬에서 재현 가능한 항목을 실행한다. 실패 후 수정했으면 관련 검사와 필수 검사를 다시 통과시킨다.
4. **OS 차이 검토**: Linux/macOS에서 통과했어도 Windows 경로의 구분자·드라이브·대소문자, 공백과 비ASCII 경로, PowerShell/cmd 인자 인용, 자식 프로세스 종료와 파일 잠금, 타이머·취소·비동기 이벤트 순서를 확인한다. 특정 OS에 의존하는 가정을 테스트에 넣지 않았는지 검토하고, 가능하면 대상 OS에서도 해당 검사를 실행한다.
5. **테스트 종료·정리 검증**: 테스트 본문이 통과했어도 `afterEach`·`teardown`의 임시 파일 삭제 실패는 CI 실패다. Windows에서 파일을 붙잡는 VS Code 편집기·탭·프로세스·파일 핸들이 정리되는지 확인한다. 짧은 고정 지연으로 성공을 가정하는 테스트는 완료 이벤트나 명시적인 조건으로 검증하고, 일시적인 잠금 때문에 정리 재시도가 필요하면 시간·횟수를 제한한다.
6. **변경 유형별 문서 동반 갱신**: 아래 [변경 유형별 체크리스트](#변경-유형별-체크리스트)를 따라 같은 커밋/PR에 필요한 문서가 모두 포함되었는지 확인한다.
7. **검증 결과 구분**: 로컬 OS·Node.js 버전·수행한 검사·결과를 기록하고, 실행하지 못한 검사는 항목과 이유를 명시한다. 실제 GitHub 결과를 보고할 때는 해당 커밋과 실행/job을 확인한다. 로컬 통과만으로 GitHub CI나 Windows 검사가 통과했다고 보고하지 않는다.

검증을 위해 원격 실행을 만드는 푸시·태그 게시·릴리스 생성은 별도 권한이 필요한 작업이다.
커밋과 푸시의 허용 범위는 [Git 커밋과 푸시 권한](AGENTS.md#git-커밋과-푸시-권한)을 따른다.

### 버전 검사

버전을 올려야 하는 작업의 기준은 [버전 관리](AGENTS.md#버전-관리)에서 관리한다.
`npm run check-version`은 [검사 스크립트](scripts/check-release-version.cjs)를 실행하며,
`npm test`와 `npm run package`에도 먼저 실행되도록 연결되어 있다.

- `package.json`, `package-lock.json` 최상위·루트 패키지, `CHANGELOG.md` 최상단의 버전이 모두 같아야 한다.
- 비교 범위에 실행 코드, 확장 리소스·스키마·번역, 실행에 영향을 주는 manifest·운영 의존성, 빌드·패키징 변경이 있으면 기준 버전보다 커야 한다. 테스트·문서(문서용 이미지 포함)·지침·CI·개발 도구만의 변경은 버전 증가를 요구하지 않는다. `package.json`과 lockfile은 개발 의존성·검사 명령 변경을 운영 변경과 구분한다. `compile`·`build`·`prepare`·`package`·`vscode:prepublish` 같은 빌드·패키징 명령과 이들의 pre/post·콜론 하위 명령은 검사 명령 예외에 포함하지 않는다.
- 로컬에 미커밋 변경이 있으면 `HEAD`와 작업 트리·스테이징·새 파일을 비교한다. 로컬이 깨끗하면 `HEAD^`와 비교한다. 로컬 미커밋 검사는 이전 커밋 전체를 다시 감사하는 검사가 아니며, 실제 커밋 범위는 CI에서도 확인한다.
- CI는 `TASKHUB_VERSION_BASE`에 PR의 base SHA 또는 push 직전 SHA를 지정한다. 여러 커밋을 한꺼번에 push하고 마지막 커밋이 문서뿐이어도 앞선 실행 변경을 검사한다. Release와 수동 실행처럼 명시 기준이 없으면 깨끗한 체크아웃의 `HEAD^`를 사용한다.
- 비교 기준이나 Git 이력을 읽지 못하면 실패한다. CI/Release는 `fetch-depth: 0`으로 이력을 가져온다. shallow clone이나 force-push 때문에 필요한 기준 커밋이 없으면 해당 이력을 확보해야 하며, 검사를 통과시키려고 임의의 기준으로 바꾸지 않는다.

[회귀 테스트](src/test/releaseVersion.test.ts)는 임시 Git 저장소에서 버전 누락·불일치·개발 전용 변경·여러 커밋의 비교를 직접 실행해 확인한다. 이 검사는 현재 파일의 버전을 검증하며, `git commit` 자체를 가로채는 hook은 아니다. 실제 커밋 전에는 검증한 버전 파일과 변경 파일을 함께 stage했는지도 확인한다.

자동 분류는 파일·필드 기준으로 보수적으로 판단한다. `src/`의 실행 코드 파일은 주석·서식만 바뀌어도 대상이며, 새 파일이 알려진 개발 전용 경로에 속하지 않으면 버전 증가를 요구한다. 개발 도구를 새로 추가해 분류 예외가 필요하면 검사 스크립트와 해당 회귀 테스트를 함께 갱신한다.

### 변경 유형별 체크리스트

같은 사실이 여러 문서에 복제되어 drift가 발생하지 않도록, 변경 유형별로 함께 갱신해야 하는 대상을 아래 표로 고정합니다. 새 항목을 추가하거나 기존 항목을 변경할 때는 **같은 PR**에서 해당 행의 모든 대상을 반영하세요.

| 변경 유형 | 동반 갱신 대상 (모두 같은 PR) |
| --- | --- |
| **기능 추가·변경·삭제 / 버그 수정** | 본 문서 [기능 변경 검증 의무](#기능-변경-검증-의무) 적용 |
| **새 설정** 추가 / 기본값·범위 변경 | [package.json](package.json) `contributes.configuration` (원본) · [docs/features.md §21 설정 레퍼런스](docs/features.md#21-설정-레퍼런스) 표 한 행 · 관련 기능 섹션에서 자연스러운 맥락으로 1회 언급 · [CHANGELOG.md](CHANGELOG.md) |
| **새 명령** 추가 / 인자 요구사항 변경 | [package.json](package.json) `contributes.commands` · 인자 없이 안전히 호출할 수 없는 명령은 `menus.commandPalette` 에 `{"command":"…","when":"false"}` 추가 · [docs/features.md](docs/features.md) 기능 섹션에서 진입점 설명 (컨텍스트 전용이면 "Command Palette" 언급 금지) · [CHANGELOG.md](CHANGELOG.md) |
| **`src/` 파일** 추가·이동·삭제 | [docs/architecture.md](docs/architecture.md) 프로젝트 구조 트리 (§프로젝트 구조) · 필요 시 주요 컴포넌트/데이터 구조 섹션 · 분리되는 모듈이 TreeDataProvider면 `src/providers/` 규약 준수 |
| **features.md 섹션 번호** 변경 (§N 또는 §N.M) | [examples/README.md](examples/README.md)의 `features.md §…` 참조 업데이트 · features.md 자체 TOC · 다른 문서에서 해당 번호를 인용하고 있지 않은지 `grep -rn '§15\.5'` 방식으로 확인 |
| **사용자에게 보이는 문자열** 추가 | `src/i18n.ts`의 `t(ko, en)` 헬퍼 사용 ([CLAUDE.md 다국어 지원](CLAUDE.md#다국어-지원-i18n) 참조) |
| **`package.json` `contributes.*`의 문자열** (명령 title, 뷰 name, `viewsWelcome`, 설정 설명) 추가·변경 | package.json에는 `%key%`만 두고 `package.nls.json` + `package.nls.ko.json` **양쪽**에 문구 추가 ([CLAUDE.md](CLAUDE.md#packagejson-안의-문자열-manifest)) · 한쪽만 넣으면 오류 없이 영어로 폴백한다 |
| **실험적 기능** 추가 / 안정화(graduation) | 본 문서 [실험적 기능 추가 가이드](#실험적-기능-추가-가이드) 전체 절차 · [docs/features.md §16](docs/features.md#16-experimental-features) |
| **보안 가드** (파서 한도·CSP·경로 검증) 변경 | [docs/architecture.md 보안 가드](docs/architecture.md#보안-가드) · 관련 유닛 테스트 (`defensive limits` 등) |
| **`IT-XXX` 통합 테스트** 추가 / suite 신설 | [docs/integration-tests.md](docs/integration-tests.md) "시나리오 그룹" 에 항목 한 줄 (+ 비자명한 제약은 상세 섹션) · `src/test/docConsistency.test.ts` 가 `test('IT-XXX` 제목과 대장을 대조하므로 빠뜨리면 CI 에서 실패 |
| **공용 커밋 메시지 형식**이 필요한 PR | [버전 관리](AGENTS.md#버전-관리)와 [버전 검사](#버전-검사)를 적용한다. 자세한 제목 형식은 [CLAUDE.md 커밋 메시지](CLAUDE.md#커밋-메시지). |

`src/test/docConsistency.test.ts`가 위 표의 일부(설정 키 정합성·팔레트 정책·§번호 참조 유효성·**구조 트리 ↔ `src/*.ts`**·**IT 대장 ↔ 테스트 제목**)와 **AGENTS.md ↔ CLAUDE.md 지침 일치**를 자동 검증하므로, 항목을 빠뜨리면 CI에서 실패합니다. 테스트가 잡지 못하는 범주(예: `examples/README.md` 문장 서술)는 사람 리뷰에서 보조 확인이 필요합니다.

### 로컬 테스트

Extension Development Host로 실행하려면 로컬에 `.vscode/launch.json`을 직접 생성합니다. (저장소에는 커밋되지 않습니다 — 개인별 설정이기 때문에 `.gitignore`에 포함되어 있습니다.)

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Run Extension",
            "type": "extensionHost",
            "request": "launch",
            "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
            "outFiles": ["${workspaceFolder}/dist/**/*.js"]
        }
    ]
}
```

아래 절차에서 빌드를 먼저 실행하므로 이 설정에는 `preLaunchTask`가 없습니다. 새 clone에 별도의
`.vscode/tasks.json`이나 기본 빌드 태스크를 만들 필요가 없습니다.

이후 절차:

1. `npm run watch`로 빌드 watch 모드 실행 (또는 `npm run compile`로 일회성 빌드)
2. VS Code에서 `F5` 키를 눌러 Extension Development Host 실행
3. 새 창에서 변경사항 테스트

### VSIX 패키지 빌드 및 설치

```bash
npx @vscode/vsce package # TaskHub-<version>.vsix 생성
```

생성된 `.vsix` 파일은 VS Code `Extensions: Install from VSIX...` 명령으로 설치해 실제 설치 환경과 동일하게 검증할 수 있습니다.

`.vscodeignore`는 에이전트/개발 설정을 패키지에서 제외합니다. 문서 스크린샷은 저용량 WebP로
압축해 영문 README와 함께 동봉하며, 실행 번들·스키마·내장 예제·아이콘과 업데이트 안내에서 여는
Markdown 문서도 유지합니다. 문서에서 연결하는 `CONTRIBUTING.md`는 `vsce`의 기본 제외를
`!CONTRIBUTING.md`로 해제해 포함합니다. `vsce`는 기본 README의 이미지와 영문 문서 링크를 GitHub URL로
변환합니다. 제외 규칙이나 이미지 형식을 바꾸면 실제 VSIX의 파일 목록과 README 링크를 확인하세요.

스크린샷 갱신 시 `cwebp`로 원본 해상도와 ICC 프로필을 유지합니다. PNG는
`cwebp -lossless -exact -q 100 -m 6 -metadata icc input.png -o output.webp`, JPEG는
`cwebp -preset text -q 75 -m 6 -sharp_yuv -metadata icc input.jpg -o output.webp`를 사용합니다.
변환 뒤 작은 글자의 가독성과 README의 이미지 경로를 확인합니다. 이미지 변환 도구는 일반 빌드에 필요하지 않습니다.

## 코드 스타일

코딩 컨벤션(TypeScript strict, 세미콜론, `===`, 들여쓰기 등)은 [CLAUDE.md](CLAUDE.md#코딩-컨벤션)에서 단일 출처로 관리합니다. 기여 시 해당 규칙을 따라주세요.

## 테스트 작성

### 기능 변경 검증 의무

**기능을 추가·변경·삭제하거나 버그를 수정할 때는 영향받는 동작을 검증하는 자동화 테스트를
반드시 같은 작업에서 추가하거나 수정하고, 직접 실행해 검증합니다.** 커밋 여부와 관계없이
적용하며, 기존 테스트가 모두 통과한다는 사실만으로 변경된 동작의 검증을 대신하지 않습니다.

- **검증 수준 선택:** 계산·파싱·입력 검증은 유닛 테스트로 정상값·경계값·실패 경로를 확인합니다.
  명령 등록, UI와 호스트의 메시지 교환, 파일 접근, 설정 저장·복원처럼 여러 구성 요소가 연결되는
  기능은 통합 테스트로 연결된 동작을 확인합니다. 변경의 영향에 맞는 수준을 선택하고 필요하면
  함께 사용합니다.
- **사용자 결과 확인:** 함수 호출 여부나 소스 문자열의 존재만으로 동작 검증을 끝내지 않습니다.
  특히 웹뷰 초기화·상태 복원·렌더링은 실제 브라우저의 HTML 파싱·CSP·메시지 전달을 거치는
  테스트를 포함합니다. 가짜 DOM이나 메시지 핸들러만 사용하는 테스트가 놓치는 경계를 확인합니다.
- **버그 수정·기능 삭제:** 버그를 재현하는 회귀 테스트를 남기고 수정 후 통과를 확인합니다.
  기능 삭제 시 제거된 명령·UI·동작이 더 이상 제공되지 않고 남은 기능이 정상 동작하는지 검증하며,
  바뀐 사양에 맞춰 기존 테스트를 수정·정리합니다. 실패를 피하려고 테스트를 삭제·건너뛰거나
  단언을 약화하지 않습니다.
- **실행·보고:** 관련 테스트와 변경 영향이 있는 검사를 실행하고 실패 원인을 수정한 뒤 다시
  검증합니다. 수행한 명령·결과와 실행하지 못한 검사의 사유를 보고합니다. 전체 검증 범위와
  환경별 실행 절차는 [CI 워크플로와 커밋 전 검증](#ci-워크플로와-커밋-전-검증)을 따릅니다.

### 작성 형식

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
- 프레임워크: Mocha + Node.js `assert`
- 테스트 설정: `.vscode-test.mjs`

실제 웹뷰 테스트는 창이 다른 창에 가려져도 Chromium의 배경 타이머·렌더링 제한 때문에 멈추지 않도록
테스트 호스트에서만 해당 제한을 해제합니다. 제품의 HTML·CSP·스크립트와 테스트 단언은 그대로 실행합니다.

## Pull Requests

1. [기능 변경 검증 의무](#기능-변경-검증-의무) 준수 및 모든 테스트 통과 확인
2. 린팅 에러 없음 확인
3. 필요 시 문서 업데이트
4. 변경사항에 대한 명확한 설명 포함

## 커밋 메시지 형식

커밋 메시지 규칙(`[버전] 변경 설명`, 테스트/문서-only 예외 포함)은 [CLAUDE.md](CLAUDE.md#커밋-메시지)에서 관리합니다. 기여 시 해당 형식을 따라주세요.

## 다국어 메시지 (i18n)

사용자에게 보이는 모든 메시지는 `t(ko, en)`으로 감싸야 합니다. 적용 대상/제외/사용법 등 자세한 규칙은 [CLAUDE.md](CLAUDE.md#다국어-지원-i18n) "다국어 지원 (i18n)" 섹션에서 관리합니다.


## 실험적 기능 추가 가이드

API나 동작이 바뀔 수 있고 사용자 피드백이 필요한 기능만 experimental로 시작합니다. 버그 수정과 기존 기능의 작은 개선에는 사용하지 않습니다.

추가할 때:

1. `package.json`에 기본값이 `false`인 `taskhub.experimental.<name>.enabled` 설정을 추가하고, 사용자 노출 문구는 NLS 번들 양쪽에 넣습니다.
2. 조건부 뷰가 필요하면 `when: "config.taskhub.experimental.<name>.enabled"`를 사용합니다.
3. Provider는 `src/providers/`에 두고 `activate()`에서 설정을 확인해 등록합니다. TreeView가 아닌 기능도 동일한 게이트를 사용합니다.
4. [features.md §16](docs/features.md#16-experimental-features)에 활성화 방법·범위·한계를 문서화합니다.
5. 활성/비활성, 설정 토글, UI 노출과 핵심 동작을 테스트합니다.

안정화할 때는 Experimental 표기와 조건부 게이트를 제거하고, 설정 키를 바꾸는 경우 기존 사용자를 위한 마이그레이션을 제공합니다.
## npm overrides

보안 취약점 해결을 위해 다음 패키지에 override 적용 중:
- `minimatch`: mocha/eslint 내부 의존성
- `diff`: mocha 내부 의존성
- `serialize-javascript`: mocha 내부 의존성 (RCE 취약점)
- `glob`: mocha 내부의 지원 종료된 glob 10 설치 경고 제거

override 제거 전에 `npm audit`으로 취약점 상태 확인 필요.

### `@types/vscode` 잠금 정책

`engines.vscode`의 `^1.75.0`은 확장의 최소 런타임 호환 범위이고, 개발 시 사용하는 API 타입은
`package-lock.json`에서 `@types/vscode` 1.125.0으로 의도적으로 고정합니다. `package.json`의
`^1.75.0` 범위만으로는 이 버전이 고정되지 않으므로 재현 가능한 설치에는 `npm ci`를 사용합니다.

`npm install`이나 의존성 갱신으로 잠금 버전을 바꿀 때는 변경을 그대로 커밋하지 말고, 새로 허용된
API가 최소 지원 VS Code 1.75에서도 동작하는지 확인합니다. 최소 버전에 없는 API가 필요하면 런타임
기능 감지와 폴백을 함께 제공하고 해당 경로를 테스트합니다.

## 프로젝트 아키텍처

프로젝트 구조, 주요 컴포넌트, 데이터 구조에 대한 상세 설명은 [docs/architecture.md](docs/architecture.md)를 참조하세요.
