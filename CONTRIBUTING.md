# Contributing to TaskHub

이 문서는 TaskHub에 기여할 때의 **개발자 워크플로우**(환경 셋업·빌드/테스트·로컬 실행·실험적 기능 추가·PR·npm overrides)를 다룹니다.

프로젝트 구조·주요 컴포넌트·데이터 구조·활성화·보안은 [docs/architecture.md](docs/architecture.md)에, 코딩 컨벤션·i18n 규칙·커밋 메시지 형식은 [CLAUDE.md](CLAUDE.md)에 있습니다. 중복 서술 대신 해당 문서를 참조하세요.

## 개발 환경 셋업

### 요구사항
- Node.js and npm
- Visual Studio Code

### 설치
```bash
npm install
```

## 빌드 & 테스트

```bash
npm run compile          # 타입 체크 + 린트 + esbuild 번들링
npm run package          # 프로덕션 빌드 (minify 포함)
npm run check-types      # TypeScript 타입 체크만
npm run lint             # ESLint 검사 (src/)
npm run test             # 유닛 테스트 실행 (vscode-test)
npm run watch            # 개발 시 watch 모드 (esbuild + tsc 병렬)
```

### 커밋 전 체크리스트

커밋 전 반드시 다음 항목을 확인:

1. **유닛 테스트 실행**: `npm run test`로 모든 테스트가 통과하는지 확인
2. **프로덕션 빌드**: `npm run package`를 실행하여 다음이 모두 통과하는지 확인:
   - [ ] TypeScript 타입 체크
   - [ ] ESLint 검사
   - [ ] esbuild 번들링 (minify 포함)
3. **문서 업데이트**: 기능 추가/변경 시 관련 문서를 함께 업데이트
   - `CHANGELOG.md`: 버전별 변경 이력 추가
   - `docs/features.md`: 기능 설명 추가/수정
   - `docs/architecture.md`: 구조 변경 시 반영
   - `README.md`: 사용자에게 보이는 주요 변경 시 반영

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
            "outFiles": ["${workspaceFolder}/dist/**/*.js"],
            "preLaunchTask": "${defaultBuildTask}"
        }
    ]
}
```

이후 절차:

1. `npm run watch`로 빌드 watch 모드 실행 (또는 `npm run compile`로 일회성 빌드)
2. VS Code에서 `F5` 키를 눌러 Extension Development Host 실행
3. 새 창에서 변경사항 테스트

### VSIX 패키지 빌드 및 설치

```bash
vsce package            # TaskHub-<version>.vsix 생성
```

생성된 `.vsix` 파일은 VS Code `Extensions: Install from VSIX...` 명령으로 설치해 실제 설치 환경과 동일하게 검증할 수 있습니다.

## 코드 스타일

코딩 컨벤션(TypeScript strict, 세미콜론, `===`, 들여쓰기 등)은 [CLAUDE.md](CLAUDE.md#코딩-컨벤션)에서 단일 출처로 관리합니다. 기여 시 해당 규칙을 따라주세요.

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

## Pull Requests

1. 모든 테스트 통과 확인
2. 린팅 에러 없음 확인
3. 필요 시 문서 업데이트
4. 변경사항에 대한 명확한 설명 포함

## 커밋 메시지 형식

커밋 메시지 규칙(`[버전] 변경 설명`, 테스트/문서-only 예외 포함)은 [CLAUDE.md](CLAUDE.md#커밋-메시지)에서 관리합니다. 기여 시 해당 형식을 따라주세요.

## 다국어 메시지 (i18n)

사용자에게 보이는 모든 메시지는 `t(ko, en)`으로 감싸야 합니다. 적용 대상/제외/사용법 등 자세한 규칙은 [CLAUDE.md](CLAUDE.md#다국어-지원-i18n) "다국어 지원 (i18n)" 섹션에서 관리합니다.

## 실험적 기능 추가 가이드

실험적 기능은 아직 안정화되지 않은 새로운 기능을 테스트하기 위한 프레임워크입니다.

### 사용 기준

**실험적 기능으로 추가해야 하는 경우:**
- 아직 개발 중인 기능
- API/동작이 변경될 수 있는 기능
- 사용자 피드백이 필요한 기능

**실험적 기능으로 추가하지 않는 경우:**
- 버그 수정
- 기존 기능의 소규모 개선
- 핵심 기능

### 추가 절차

#### 1. 설정 추가 (`package.json`)

```json
"taskhub.experimental.<featureName>.enabled": {
    "type": "boolean",
    "default": false,
    "markdownDescription": "**[Experimental]** 기능 설명. ⚠️ This feature is experimental and may change in future versions."
}
```

#### 2. 뷰 추가 (필요한 경우)

```json
{
    "id": "mainView.<featureName>",
    "name": "Feature Name (Experimental)",
    "when": "config.taskhub.experimental.<featureName>.enabled"
}
```

#### 3. Provider 구현 (`src/providers/<featureName>Provider.ts`)

> 기존 4종(`mainViewProvider` / `linkViewProvider` / `favoriteViewProvider` / `historyProvider`)은 `src/providers/`에 분리되어 있습니다. 새 provider도 같은 디렉터리에 모듈 단위로 두고, `extension.ts`는 `activate()`에서 `import` 한 뒤 인스턴스화만 담당합니다.

```typescript
class YourFeatureProvider implements vscode.TreeDataProvider<YourItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<YourItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    public view: vscode.TreeView<YourItem> | undefined;

    constructor(private context: vscode.ExtensionContext) {}

    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: YourItem): vscode.TreeItem { return element; }
    getChildren(): Thenable<YourItem[]> { return Promise.resolve([]); }
}
```

`activate()` 함수에서 조건부 등록:

```typescript
const isEnabled = vscode.workspace.getConfiguration('taskhub.experimental')
    .get<boolean>('featureName.enabled', false);

if (isEnabled) {
    const provider = new YourFeatureProvider(context);
    provider.view = vscode.window.createTreeView('mainView.featureName', {
        treeDataProvider: provider
    });
    provider.refresh();
    context.subscriptions.push(provider.view);
}
```

> TreeView가 아닌 hover provider 등을 확장하는 패턴은 Bit Operation Hover 구현을 참고하세요.

#### 4. 문서 업데이트

- `docs/features.md` 섹션 16에 기능 설명 추가

#### 5. 테스트

- [ ] 기능 활성화 상태에서 테스트
- [ ] 기능 비활성화 상태에서 테스트
- [ ] on/off 토글 테스트
- [ ] 뷰 표시/숨김 동작 확인
- [ ] 유닛 테스트 추가

### 안정화 (Graduation)

실험적 기능을 안정화할 때:

1. "Experimental" 태그 제거
2. `taskhub.experimental.` 접두사 제거
3. `when` 조건절 제거 (항상 표시)
4. 문서 업데이트
5. 기존 설정 사용자를 위한 마이그레이션 경로 고려

## npm overrides

보안 취약점 해결을 위해 다음 패키지에 override 적용 중:
- `minimatch`: mocha/eslint 내부 의존성
- `diff`: mocha 내부 의존성
- `serialize-javascript`: mocha 내부 의존성 (RCE 취약점)

override 제거 전에 `npm audit`으로 취약점 상태 확인 필요.

## 프로젝트 아키텍처

프로젝트 구조, 주요 컴포넌트, 데이터 구조에 대한 상세 설명은 [docs/architecture.md](docs/architecture.md)를 참조하세요.
