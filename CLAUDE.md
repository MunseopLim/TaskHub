# CLAUDE.md

TaskHub는 VS Code 확장 프로그램으로, 반복적인 개발 작업 자동화와 임베디드 C/C++ 개발 지원 도구를 제공합니다.

이 파일은 **Claude Code(및 다른 AI 에이전트)가 작업 시 지켜야 할 규칙**만을 담습니다. 프로젝트 구조·빌드/테스트 절차·기여 가이드는 아래 문서 맵을 통해 해당 문서 하나로만 관리합니다.

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
- `vscode.env.language === 'ko'`로 판별

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

### 새 메시지 추가 시 규칙

1. 하드코딩된 문자열 대신 반드시 `t(ko, en)` 사용
2. 한국어가 먼저, 영어가 뒤에 위치
3. QuickPick `label`이 이후 비교에 사용되면, `t()` 결과를 변수에 저장하여 비교에도 동일 변수 사용

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

## 커밋 전 확인 (요약)

커밋 전 다음을 확인한다. 전체 절차와 체크리스트는 [CONTRIBUTING.md](CONTRIBUTING.md) "커밋 전 체크리스트" 참조.

1. `npm run test` 통과
2. `npm run package` 통과 (타입체크 + 린트 + esbuild)
3. 기능 추가/변경 시 해당 범주 문서만 갱신 (위 "문서 맵" 기준, 복제 금지)
