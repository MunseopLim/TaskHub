# AGENTS.md

TaskHub는 VS Code 확장 프로그램으로, 반복적인 개발 작업 자동화와 임베디드 C/C++ 개발 지원 도구를 제공합니다.

이 파일은 **Codex(및 다른 AI 에이전트)가 작업 시 지켜야 할 규칙**만을 담습니다. 프로젝트 구조·빌드/테스트 절차·기여 가이드는 아래 문서 맵을 통해 해당 문서 하나로만 관리합니다.

## 에이전트 지침 동기화

- [CLAUDE.md](CLAUDE.md)와 [AGENTS.md](AGENTS.md)는 항상 같은 작업에서 함께 확인하고 업데이트합니다.
- `CLAUDE.md`의 실질적인 규칙을 추가·수정·삭제할 때는 `AGENTS.md`에도 같은 변경을 반영합니다.
- `AGENTS.md`의 실질적인 규칙을 추가·수정·삭제할 때도 `CLAUDE.md`에 같은 변경을 반영합니다.
- 파일 제목과 대상 에이전트명처럼 도구별로 달라야 하는 표현을 제외하고, 두 파일의 규칙과 의미는 동일하게 유지합니다.
- 한 파일만 변경된 상태로 작업을 완료하지 않으며, 완료 전에 두 파일의 차이가 의도된 도구별 표현뿐인지 확인합니다.

## 문서 맵 (단일 출처)

| 찾는 내용 | 문서 |
| --- | --- |
| 프로젝트 구조 / 모듈 역할 / 데이터 구조 / 활성화·보안 / 디버깅 | [docs/architecture.md](docs/architecture.md) |
| 빌드·테스트·로컬 실행·VSIX·실험적 기능 추가 절차·PR 체크리스트·npm overrides | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 기능별 상세 레퍼런스 (태스크 타입, 호버, JSON Editor, Hex/Memory Map 등) | [docs/features.md](docs/features.md) |
| 설정·명령·메뉴 정의 (원본) | [package.json](package.json) `contributes.*` |
| 릴리스 이력 | [CHANGELOG.md](CHANGELOG.md) |
| 예제 파일 매핑 | [examples/README.md](examples/README.md) |

**같은 사실을 여러 문서에 복제하지 않습니다.** 어떤 설명을 추가할 때는 위 표에서 해당 범주의 문서를 찾아 거기에만 쓰고, 다른 문서에서는 링크로 참조합니다.

## 코딩 컨벤션

- **TypeScript**: strict 모드, ES2022 타겟, Node16 모듈
- **세미콜론** 필수
- **===** 사용 (== 금지)
- **중괄호** 필수 (if/else/for 등)
- **네이밍**: camelCase (함수/변수), PascalCase (클래스/인터페이스)
- **들여쓰기**: 4 spaces (탭 아님)
- **문서 언어**: 한국어 기본 (README, CHANGELOG, 커밋 메시지)

## 다국어 지원 (i18n)

사용자에게 보이는 모든 메시지는 `src/i18n.ts`의 `t(ko, en)` 함수를 사용하여 한국어/영어 두 벌을 제공한다.

- VS Code가 한국어(`ko`)로 설정된 경우 한국어 메시지를 표시하고, 그 외에는 영어를 표시
- `vscode.env.language.startsWith('ko')`로 판별

### 적용 대상

- `vscode.window.showErrorMessage`, `showWarningMessage`, `showInformationMessage`
- `showQuickPick`, `showInputBox`의 `placeHolder`, `prompt`, `validateInput` 반환값
- QuickPick 항목의 `label`, `description`
- `showOpenDialog`의 `openLabel`

### 적용 제외

- 패널 제목 등 짧은 영어 식별자 (예: `Hex: ${fileName}`, `Memory Map: ${fileName}`)
- 사용자 설정에서 가져오는 값 (`action.successMessage`, `task.placeHolder` 등)
- 예시 형식 문자열 (`e.g. npm run build`, `https://example.com`)
- 모달 확인 버튼 텍스트 (`'Yes'` 등 — VS Code가 반환값으로 사용)

### 사용법

```typescript
import { t } from './i18n';

// 단순 문자열
vscode.window.showErrorMessage(t('파일을 찾을 수 없습니다.', 'File not found.'));

// 템플릿 리터럴
vscode.window.showErrorMessage(t(
    `파싱 실패 (${fileName}): ${e.message}`,
    `Failed to parse (${fileName}): ${e.message}`
));

// QuickPick label (비교가 필요한 경우 변수로 저장)
const skipLabel = t('건너뛰기', 'Skip');
const items = [{ label: skipLabel, description: t('섹션 정보만 표시', 'Show sections only') }];
if (selected.label === skipLabel) { ... }
```

### package.json 안의 문자열 (manifest)

`t()`는 TypeScript 코드에서만 쓸 수 있다. `package.json`의 `contributes.*`에 있는 사용자 노출 문자열은 VS Code의 nls 메커니즘으로 지역화한다.

- 대상: 명령 `title`, 뷰 `name`, `viewsWelcome.contents`, 설정 `description` / `markdownDescription` / `enumDescriptions`
- 방법: package.json에는 `%key%`만 두고, 문구는 `package.nls.json`(영어, 기본)과 `package.nls.ko.json`(한국어)에 둔다
- 제외: 브랜드명 `TaskHub` (`displayName`, `category`, 뷰 컨테이너 `title`) — 번역 대상이 아니므로 nls를 거치지 않고 리터럴로 둔다

**조용한 실패 모드에 주의한다.** ko 번들에 키가 없으면 VS Code는 오류 없이 영어로 폴백하므로, 한국어 사용자에게 영어가 섞여 보일 뿐 아무 신호도 나지 않는다. `src/test/packageNls.test.ts`가 두 번들의 키 집합 일치·미사용 키·번역 누락(양쪽 값이 동일)·welcome 본문의 `command:` 대상 일치를 검사한다.

`viewsWelcome` 본문을 번역할 때 `[문구](command:id)`의 **문구는 번역하되 `id`는 절대 바꾸지 않는다** — 바꾸면 버튼이 아무 동작도 하지 않고 화면상 아무 표시가 없다.

### 새 메시지 추가 시 규칙

1. 하드코딩된 문자열 대신 반드시 `t(ko, en)` 사용 (manifest는 위 `%key%` 방식)
2. 한국어가 먼저, 영어가 뒤에 위치
3. QuickPick `label`이 이후 비교에 사용되면, `t()` 결과를 변수에 저장하여 비교에도 동일 변수 사용
4. **웹뷰**: 호스트가 `buildXStrings()`로 번들을 만들어 주입하고, 웹뷰 스크립트는 `S.key`만 쓴다. 정적 마크업이든 `innerHTML`로 조립하는 마크업이든 예외 없다 — 후자는 `src/test/webviewStringCoverage.test.ts`의 검사 범위 밖이라 리뷰에서만 걸린다

## Git 커밋과 푸시 권한

- 사용자가 **현재 요청에서 명시적으로 커밋을 지시한 경우에만** `git commit`을 수행합니다.
- 사용자가 **현재 요청에서 명시적으로 푸시를 지시한 경우에만** `git push`를 수행합니다.
- 커밋 지시는 푸시 허가를 포함하지 않으며, 푸시 지시는 필요한 커밋을 임의로 만들어도 된다는 뜻이 아닙니다.
- 이전 요청의 지시, 테스트 통과, 작업 완료 또는 변경사항이 준비된 상태를 새 커밋·푸시의 허가로 간주하지 않습니다.
- 명시적 지시가 없으면 변경사항은 작업 트리에 남기고, 수행한 검증과 현재 상태만 사용자에게 보고합니다.

## 커밋 메시지

```
[버전] 변경 설명
```

예시:
- `[0.2.36] npm 취약점 해결 및 의존성 업데이트`
- `[0.2.35] codex 코드 리뷰 반영 및 성능 개선`

규칙:

- Co-Authored-By 라인이나 `[claude]` 태그는 넣지 않는다.
- 버전을 올릴 때 `package.json`과 `package-lock.json`의 버전을 반드시 함께 업데이트한다.
- **테스트/문서만 변경된 커밋은 버전을 올리지 않는다.** `[버전]` 브라켓 대신 간결한 한국어 설명으로 시작한다 (예: `테스트 보강 — ...`, `문서 일관성 교정 — ...`).

### 짧게 쓴다

**제목 한 줄로 끝내는 것이 기본이다.** 무엇이 왜 바뀌었는지의 서술은 [CHANGELOG.md](CHANGELOG.md)가 단일 출처이므로, 커밋 메시지에 그 내용을 옮겨 적지 않는다 — 같은 사실을 두 곳에 두지 않는다는 문서 맵 원칙이 여기에도 적용된다.

- 제목은 72자 이내, 한 줄.
- 본문은 **꼭 필요할 때만** 쓰고, 쓰더라도 3~5줄을 넘기지 않는다. 필요한 경우란 보통 이런 것들이다: 되돌리기 어려운 결정의 근거, 커밋을 나눈 이유, 다른 커밋/이슈와의 의존 관계.
- 변경 목록을 불릿으로 나열하지 않는다. 그것은 CHANGELOG가 할 일이다.
- 테스트 수치·파일 목록·리뷰 반영 항목 나열은 넣지 않는다.

```
[0.6.52] 0.6.11~0.6.51 리뷰 반영 — 진단 오탐과 아카이브 경로 기준점
```

## 커밋 전 확인 (요약)

커밋 전 다음을 확인한다. 전체 절차와 체크리스트는 [CONTRIBUTING.md](CONTRIBUTING.md) "커밋 전 체크리스트" 참조.

1. `npm run test` 통과
2. `npm run package` 통과 (타입체크 + 린트 + esbuild)
3. 기능 추가/변경 시 해당 범주 문서만 갱신 (위 "문서 맵" 기준, 복제 금지)
