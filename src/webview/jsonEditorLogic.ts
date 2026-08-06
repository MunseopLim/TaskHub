/**
 * JSON Editor webview 가 쓰는 **순수 로직의 단일 출처**.
 *
 * 예전에는 같은 로직이 두 벌이었다.
 *
 *   1. `getWebviewContent` 의 템플릿 리터럴 안에 있는 사본. 문자열이라 타입체크도
 *      린트도 걸리지 않고, 에디터의 정의로 가기도 안 된다.
 *   2. `src/jsonEditorUtils.ts` — 그 사본을 검사하기 위한 "테스트용 미러".
 *
 * 두 벌은 반드시 어긋난다. 실제로 0.6.68~0.6.70 세 릴리스가 전부 "계약이 한쪽에만
 * 지켜지고 있었다" 였고, 소스에는 `NOTE: … 와 동일해야 한다` 라는, 강제할 수 없는
 * 주석이 여섯 군데 붙어 있었다.
 *
 * 이제 webview 가 미러를 **직접 불러 쓴다.** 이 파일은 esbuild 가 IIFE 로 묶어
 * `dist/jsonEditorWebview.js` 에 내보내고, 전역 `TaskHubJsonEditorLogic` 하나로
 * 노출한다. 인라인 스크립트는 거기서 필요한 것을 꺼낸다.
 *
 * **이 파일과 그 의존성은 `vscode` 를 import 하면 안 된다.** 브라우저(webview)
 * 에서 실행되므로 확장 호스트 API 가 없다. `jsonEditorUtils.ts` 는 import 가
 * 하나도 없는 순수 모듈이라 그 조건을 이미 만족한다.
 */
export {
    parseValue,
    coerceEditedCellValue,
    coerceEditedArrayItems,
    buildSheetMap,
    getRowsByPath,
    effectiveBaseline,
    decideSaveResult,
    buildDraftSnapshot,
    resolveActiveDraftState,
} from '../jsonEditorUtils';
