# 명령·인자 전달 확인 예제

1. Node.js를 PATH에 준비하고 이 저장소 루트를 VS Code 워크스페이스로 엽니다.
2. [actions.json](actions.json)의 배열 항목을 `.vscode/actions.json` 배열에 병합합니다. 기존 파일이 없으면 그대로 복사합니다.
3. TaskHub Actions에서 **Command**, **Shell**, **QuickPick** 예제를 실행하고 열린 JSON 탭의 `argv`를 비교합니다. QuickPick은 각 항목을 골라 다시 실행합니다.

[probe.cjs](probe.cjs)는 받은 인자와 작업 위치, `TASKHUB_DEMO`만 출력합니다. 작업 위치는 개인 절대 경로 대신 `<workspace>/examples/command_shell`로 표시하며, 인자로 받은 파일을 읽거나 만들지 않습니다.

JSON에서 실제 명령과 인자가 만들어지는 규칙은 [명령 실행](../../docs/actions.md#4-명령-실행), 선택 결과의 전달 규칙은 [QuickPick](../../docs/actions.md#quickpick)을 참조하세요.
