# 센서 이미지 파이프라인 예제

Python 3 표준 라이브러리로 센서 프레임 바이너리를 생성하고, CRC32·SHA-256을 검증한 뒤 TaskHub 내장 ZIP 태스크로 압축합니다. 펌웨어 컴파일러 없이 실행할 수 있는 데모입니다.

1. 이 저장소 루트를 VS Code 워크스페이스로 엽니다.
2. [actions.json](actions.json)의 배열 항목을 워크스페이스 `.vscode/actions.json` 배열에 병합합니다. 기존 파일이 없으면 그대로 복사합니다.
3. Python 3를 PATH에 준비하고 TaskHub Actions에서 **Build → Verify → ZIP**을 실행합니다. Windows는 `python`, macOS·Linux는 `python3`를 사용하며 필요하면 `command`를 수정합니다.

결과는 이 폴더의 `build/`에 저장됩니다. 태스크 필드 설명은 [actions.json 작성 가이드](../../docs/actions.md)를 참조하세요.
