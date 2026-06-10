# 전체 코드·문서 리뷰 보고서 (2026-06-10)

`src/` 전체(테스트 포함), 문서 전체(README ko/en, CLAUDE.md, CONTRIBUTING.md, docs/*), package.json·빌드·CI 설정을 대상으로 한 전수 리뷰 결과.
모든 발견 사항은 실제 코드 대조(일부는 Node 실행 재현)로 검증됨.

> 이 문서는 `feature/code_review` 브랜치의 작업 추적용이다. 항목을 수정하면 체크박스를 채우고, 필요 시 수정 커밋 해시를 기록한다. 작업 완료 후 이 문서는 삭제하거나 보관 위치를 결정한다.

---

## 🔴 Critical

### C1. JSON Editor: `atob()` UTF-8 미디코딩 → 비ASCII 데이터 영구 손상
- [ ] 수정
- **위치**: `src/jsonEditor.ts:868` (인코딩), `src/jsonEditor.ts:1181`, `1199-1201` (디코딩)
- **내용**: 호스트는 `Buffer.from(JSON.stringify(data), 'utf-8').toString('base64')`로 UTF-8 바이트를 인코딩하지만, 웹뷰는 `JSON.parse(atob('${jsonBase64}'))`로 디코딩한다. `atob()`는 latin1이라 멀티바이트 문자가 전부 mojibake가 된다 (`{"k":"한글-—≥"}` → `íê¸-ââ¥`, JSON.parse는 성공하므로 **오류 없이 조용히** 깨짐). 셀 하나만 고치고 Save해도 웹뷰의 전체 데이터(mojibake 포함)가 디스크에 기록되어 한글/유니코드 값이 영구 손상된다. `savedBase64` 경로도 동일하며 baseline 비교(dirty 판정)까지 오염된다. `memoryMapViewer.ts:495-508`에 같은 버그를 이미 고친 기록("atob() mojibake we previously hit on '—' / '≥'")이 있으나 jsonEditor에 전파되지 않았다.
- **수정안**: memoryMapViewer와 동일하게 base64 대신 `JSON.stringify(v).replace(/</g, '\\u003c')` 직접 주입, 또는 웹뷰에서 `new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))`로 UTF-8 디코딩. `savedBase64`도 함께 수정. 한글 포함 JSON의 열기→저장 round-trip 테스트 추가.

---

## 🟠 Major

### M1. `output.mode: 'terminal'` — 출력 본문을 셸에 "타이핑"하여 임의 라인이 실행됨
- [ ] 수정
- **위치**: `src/extension.ts:3122-3141`
- **내용**: `vscode.window.createTerminal()`로 만든 실제 셸 터미널에 `terminal.sendText(content, false)`로 출력을 보낸다. 본문에 포함된 개행이 Enter로 해석되어 마지막 줄을 제외한 모든 줄이 셸에서 **실행**된다. 빌드 출력에 `del ...` 같은 줄이 있으면 실제로 실행됨.
- **수정안**: Pseudoterminal(읽기 전용) 또는 OutputChannel로 교체. 최소한 각 줄 앞에 `# ` 주석 처리.

### M2. Intel HEX ELA 레코드 `<< 16` 부호 오버플로 — 상위 절반 주소 공간 깨짐
- [ ] 수정
- **위치**: `src/hexParser.ts:117`
- **내용**: `baseAddress = parseInt(...) << 16`은 32비트 부호 있는 결과라 ELA 값 ≥ 0x8000이면 음수가 된다 (`0x9000 << 16 === -1879048192` 실측). 0x80000000 이상 주소(STM32 QSPI 0x90000000, PIC32 kseg 등 임베디드 실존 주소)의 데이터가 음수 주소로 저장되어 minAddress/maxAddress, toFlatArray, 뷰어 렌더링이 전부 깨진다. 기존 테스트는 양수 범위(0x0800)만 검증.
- **수정안**: `baseAddress = parseInt(...) * 0x10000;` 또는 `(... << 16) >>> 0`. ELA ≥ 0x8000 회귀 테스트 추가.

### M3. registerDecoder — bit 32 이상 필드를 하위 비트로 잘못 디코딩
- [ ] 수정
- **위치**: `src/registerDecoder.ts:143-152` (extractFieldValue), `:248`, `:416`
- **내용**: `[35:32]` 같은 주석을 받아 totalBits를 32 초과로 키우지만, `registerValue >>> bitStart`는 시프트 카운트가 `& 31` 처리되어 `[35:32]` 필드가 **하위 [3:0] 값을 그대로** 보여준다. 0이 아니라 그럴듯한 쓰레기 값이라 더 위험. 마스크 계산도 32비트에 갇혀 있음.
- **수정안**: bitStart ≥ 32 또는 totalBits > 32이면 BigInt 경로로 디코딩하거나, 파싱 단계에서 명시적 에러로 거부. 64비트 케이스 테스트 추가.

### M4. structSizeCalculator — 파싱 불가 선언을 조용히 누락하고 `success: true`
- [ ] 수정
- **위치**: `src/structSizeCalculator.ts:439` (선언자 정규식), `:499` (parseDeclarator)
- **내용**: 다차원 배열(`int matrix[2][3]`), 매크로/식별자 차원(`uint8_t buf[SIZE]` — 임베디드 최빈 패턴), 함수 포인터(`void (*cb)(int)`)가 매칭 실패 → 문장 전체 무시되는데 `hasUnresolvedTypes` 플래그가 안 서서 멤버가 빠진 채 `success: true`로 보고된다. 사용자는 잘못된 sizeof를 신뢰하게 됨.
- **수정안**: 매칭 실패 시 "skipped/unparsed member" 플래그를 전파해 `success: false`(또는 경고 목록). 최소 `name[A][B]`와 식별자 차원 지원 또는 명시적 실패 처리. 미지원 입력 실패 동작 테스트 추가.

### M5. Hex Viewer — 8-byte unit에서 BigInt→Number 변환으로 2^53 초과 값 표시/복사 오류
- [ ] 수정
- **위치**: `src/hexViewer.ts:694` (buildRow), `:1122` (buildCopyText)
- **내용**: `readUnit()`은 BigInt로 읽지만 표시 직전 `Number(...)` 변환으로 정밀도가 깨진다. `FF*8` → `10000000000000000`(17자리) 표시·복사.
- **수정안**: BigInt 상태로 바로 포맷 (`toString(16)`은 BigInt에서도 동작, mask도 BigInt 유지).

### M6. Hover — 64-bit 리터럴(>2^53) 진법 변환값 오표시 (BigInt 미사용)
- [ ] 수정
- **위치**: `src/numberBaseHoverProvider.ts:561-592` (parseNumber), `:597-611`
- **내용**: `parseInt` 기반이라 `0xFFFFFFFFFFFFFFFF` 호버 시 Hex `0x10000000000000000` 등 틀린 Dec/Bin이 표시된다. 비트 테이블은 가드가 있으나 상단 변환 3줄은 가드 없음.
- **수정안**: `BigInt('0x...')` 기반 파싱(C++14 구분자 `'` 제거 후), 표시도 BigInt `toString(16/10/2)`. MAX_SAFE_INTEGER 이하만 기존 경로 유지 가능.

### M7. Hex Viewer — standalone 패널과 Custom Editor가 모듈 전역 메시지 핸들러 공유 → cross-talk
- [ ] 수정
- **위치**: `src/hexViewer.ts:13-14`, `270-299`, `326`, `1227`, 등록부 `src/extension.ts:5931-5935`
- **내용**: `currentMessageDisposable`이 전역 1개인데 standalone 패널과 custom editor(`supportsMultipleEditorsPerDocument: true`) 양쪽이 공유한다. 한쪽을 열면 다른 쪽 핸들러가 dispose되고, custom editor 2개면 마지막 것만 살아남으며, 패널 onDidDispose가 남의 핸들러를 끊을 수 있다.
- **수정안**: 메시지 disposable을 webview/panel 단위로 보관. custom editor는 resolveCustomEditor 지역 변수 + `webviewPanel.onDidDispose`에서 해제.

### M8. Hover — h-suffix 정규식 `\b` 누락 → 식별자 일부에 호버 매치
- [ ] 수정
- **위치**: `src/numberBaseHoverProvider.ts:522` (findNumberAtPosition)
- **내용**: `/[0-9a-fA-F][0-9a-fA-F']*[hH]/g`에 word boundary가 없어 `Foo123h` 식별자 내부 `123h`에 매치된다. `0x` 정규식(:518)도 `0x12g3`에서 `0x12`까지 partial 매치.
- **수정안**: `/\b[0-9a-fA-F][0-9a-fA-F']*[hH]\b/g`, 0x/0b에 `(?![\w])` lookahead 추가.

### M9. Doctor/Preview — `passTheResultToNextTask` 미설정 시 `${A.output}` 거짓 음성
- [ ] 수정
- **위치**: `src/previewRun.ts:76-78`, `src/doctor.ts:842` (런타임 대조: `src/extension.ts:3005-3016`)
- **내용**: `simulateTaskResult`가 shell/command에 무조건 `{ output: ... }`을 반환하지만, 런타임은 `passTheResultToNextTask`가 falsy면 `{}`라 다운스트림 `${A.output}`이 리터럴로 셸에 들어간다. 가장 흔한 설정 실수를 Doctor/Preview 둘 다 검출하지 못함. `output.mode`/`capture`/`diagnostics`가 false와 결합된 경우도 미진단.
- **수정안**: `simulateTaskResult`에서 `task.passTheResultToNextTask !== true`이면 `{}` 반환. Doctor에 ① 미캡처 태스크 output 참조 경고, ② output.mode/capture/diagnostics + false 결합 경고 추가.

### M10. `resolveWithinWorkspace` — 어휘적 비교뿐, 심볼릭 링크/정션 우회 가능
- [ ] 수정
- **위치**: `src/pipelineUtils.ts:151-188`
- **내용**: "Security contract"로 명시된 워크스페이스 격리가 `path.resolve` + `path.relative` 문자열 비교에만 의존. 워크스페이스 내부의 외부 지향 심링크/정션(Windows 권한 없이 생성 가능)으로 우회되고, 8.3 단축 경로·예약 디바이스 이름(`CON`, `NUL`)도 미정규화.
- **수정안**: 비교 전 `fs.realpathSync.native` 정규화 + Windows 예약 디바이스 이름 거부. 최소한 JSDoc에 심링크 한계 명시.

### M11. Hex Viewer Find — debounce 없이 키 입력마다 전체 데이터 선형 스캔
- [ ] 수정
- **위치**: `src/hexViewer.ts:1098` (input 리스너), `1030-1036` (스캔 루프)
- **내용**: 키 입력마다 최대 128MB span을 JS 이중 루프로 스캔해 대용량 파일에서 웹뷰가 수 초씩 멈춘다. 매치 수 상한도 없음.
- **수정안**: 200~300ms debounce(memoryMapViewer `searchTimeout` 패턴), 매치 상한(예: 10,000 + "10,000+ matches"), 가능하면 chunk 분할 스캔.

### M12. Hover — 모든 단어 호버마다 LSP 왕복 + 전체 문서 재파싱
- [ ] 수정
- **위치**: `src/numberBaseHoverProvider.ts:142-170` (호출 순서), `788-789` → `980-1023`, `707-708`, `876-878` 등
- **내용**: 숫자 검사(비용 0)보다 `tryBitFieldHover` → `tryBitFieldFromDefinition`(LSP `executeDefinitionProvider`, 최대 3초 타임아웃)을 먼저 수행. 매크로 파싱도 호버마다 `document.getText()` 전체 재파싱, bitfield/register/struct 경로는 전체 라인 배열 복사. 수만 줄 SFR 헤더에서 지연 체감.
- **수정안**: ① 숫자 리터럴 검사 최우선, ② 비트필드 가능성 사전 필터 후 LSP 진입, ③ 매크로 테이블 document version 캐시, ④ 라인 배열 복사 1회 통합.

---

## 🟡 Minor

### 코어 (extension.ts / providers)

- [ ] **m1. `executeStreamedTask` race — 액션 영구 'running'** (`src/extension.ts:3286-3326`): 매우 짧은 명령에서 `onDidEndTaskProcess`가 `taskExecution` 할당 전에 도착하면 Promise가 영원히 pending → 중복 실행 가드로 재실행도 차단. 이벤트 버퍼링 또는 `e.execution.task === vsCodeTask` 보조 비교로 보강.
- [ ] **m2. `mergeActions` — `keep-both`와 `keep-existing`이 동일 구현** (`src/extension.ts:276-291`, UI `5526-5558`): 존재하지 않는 선택지를 사용자에게 제시. 하나 제거 또는 keep-both를 진짜 "둘 다 유지"(id 접미사)로 구현.
- [ ] **m3. `importActions` 개수 메시지 부정확 (음수 가능)** (`src/extension.ts:5880`, `mergeImportedActions:4023-4055`): skipped는 자식 id까지 포함한 id 목록인데 최상위 항목 수에서 빼서 계산. "스킵된 최상위 항목 수"를 별도 반환하고 `addedCount = newActions.length` 기준으로.
- [ ] **m4. `saveAsPreset` — 확장 설치 디렉터리에 사용자 데이터 저장** (`src/extension.ts:5652-5655`): 확장 업데이트 시 프리셋 소실, 일부 환경에서 쓰기 실패. `context.globalStorageUri`로 이전 + `discoverPresets` 스캔 경로 추가 + 1회 마이그레이션.
- [ ] **m5. `stopAction` — 프롬프트 대기 중 중지 불가 + 플래그 소실 race** (`src/extension.ts:4705-4734`): inputBox/quickPick 대기 중엔 중지 불가. `!stopped` 분기의 `manuallyTerminatedActions.delete(id)`가 직전 Stop의 플래그를 지울 수 있음. actionId별 CancellationTokenSource 도입, delete는 이번 호출에서 추가한 경우에만.
- [ ] **m6. id 없는 폴더가 `folderState:undefined` 키 공유** (`src/providers/mainViewProvider.ts:61`): 읽기 쪽에만 id 가드 부재. `id ? workspaceState.get(...) : undefined`로 대칭화.
- [ ] **m7. HistoryProvider `workspaceState.update` fire-and-forget** (`src/providers/historyProvider.ts:534, 555, 579, 588, 594, 603`): 창 닫으면 마지막 상태 전이 유실 가능, 매 실행 refresh 2회. Promise 반환 + await, 상태+inputs 통합 메서드로 refresh 1회화.
- [ ] **m8. 들여쓰기 위반 — `showExampleJson` 블록 2칸** (`src/extension.ts:5126-5163`): 4칸으로 재정렬. `:5164`의 한 줄 압축 등록 코드, `:43-46` 한 줄 다문장도 풀어 쓰기.
- [ ] **m9. unzip/zip 경로는 워크스페이스 경계 검사 미적용** (`src/extension.ts:3777-3899`): writeFile/appendFile은 `resolveWithinWorkspace`를 거치는데 unzip destination/zip archive는 임의 절대 경로 허용 — 비대칭. 동일 적용하거나 의도적 예외임을 features.md에 문서화.

### 파서

- [ ] **m10. armlink `*` 엔트리 마커를 섹션명으로 오인** (`src/armLinkListParser.ts:165`): 괄호 패턴 분기의 `tokens.find`에 `!/^[-*]+$/` 필터 누락 (괄호 없는 분기 `:185`에는 있음). 1줄 수정 + `*` 포함 라인 테스트.
- [ ] **m11. Intel HEX 제어 레코드 byteCount 미검증** (`src/hexParser.ts:109-121`): `:00000004FC` 같은 레코드에서 체크섬 문자를 주소로 읽어 이후 전체 주소가 어긋남. `case 0x02/0x04: if (byteCount !== 2) continue;`, `0x03/0x05: !== 4`.
- [ ] **m12. structSizeCalculator — static 멤버를 레이아웃에 포함** (`src/structSizeCalculator.ts:427-449, 671-676`): `static int s;`가 4바이트로 계산됨. 문장 초입에서 `/^\s*(static|extern)\b/` 스킵.
- [ ] **m13. macroExpander 시프트 우선순위 위반 + 일관성 결여** (`src/macroExpander.ts:247-254`): `1 << 2 + 3` → 7 (C는 32). 리터럴 치환 경로와 JS 네이티브 경로의 32비트 결과 불일치. BigInt 기반 평가로 통일.
- [ ] **m14. macroExpander 확장 폭 무제한 (지수 팽창 DoS)** (`src/macroExpander.ts:86-148`): 깊이 50 제한만 있고 폭 제한 없음 — 체인 30~50단계로 2^30자 팽창 가능. `result.length` 임계값(64KB) 초과 시 throw → `success: false` 경로.
- [ ] **m15. elfParser `symEntSize` 하한 미검증** (`src/elfParser.ts:270, 283-291`): 1~15 값이면 섹션 파싱이 멀쩡한 파일 전체가 실패 처리. `symEntSize >= 16`일 때만 심볼 파싱 (아니면 심볼 생략, 섹션은 반환).
- [ ] **m16. linkerScriptParser 주석 처리 허점** (`src/linkerScriptParser.ts:63, 71, 105-106`): ① MEMORY 블록 내 주석의 `}`로 잘림, ② `0x10K`를 16바이트로 오해석, ③ 스캐터 `//`·`/* */` 주석 미제거로 braceDepth 오염. 블록 추출 전 주석 제거 + LENGTH 패턴 보강.
- [ ] **m17. hexParser `Map<number, number>` 대용량 메모리 비용** (`src/hexParser.ts:8, 49, 96`): 32MB HEX에서 수백 MB 힙. 64KB 세그먼트별 `Uint8Array` + 갭 비트맵 구조 검토, 상한 하향.
- [ ] **m18. registerDecoder — 주석 속 `struct` 키워드로 union 파싱 오동작** (`src/registerDecoder.ts:335`): 주석 제거 후 라인에 `struct` 검사 적용.

### 웹뷰/호버

- [ ] **m19. memoryMapViewer `saveHtml` 기본 경로가 드라이브 루트** (`src/memoryMapViewer.ts:302`): `Uri.file('xxx.html')` 상대명 → 원본 파일 디렉터리 기준 절대 경로로.
- [ ] **m20. 하드코딩 한국어 `title="맨 위로"` — i18n 위반** (`src/memoryMapViewer.ts:831`): `t('맨 위로', 'Back to top')`.
- [ ] **m21. `==` 사용 — 프로젝트 전체 유일 위반** (`src/memoryMapViewer.ts:857`): `(text === null || text === undefined)`로 교체.
- [ ] **m22. JSON Editor saveResult race — 미저장 편집 dirty 소실** (`src/jsonEditor.ts:2095-2099`): 저장 전송 시점 snapshot을 보관했다가 성공 시 그것을 baseline으로, 현재와 다르면 dirty 유지.
- [ ] **m23. Hover(experimental) 음수 결과 `0x-1` 류 깨진 표기** (`src/numberBaseHoverProvider.ts:1899-1920, 1981-1989`): 표시 직전 `>>> 0` unsigned 정규화.
- [ ] **m24. hexViewer `copySelection` 호스트 핸들러 dead code** (`src/hexViewer.ts:273-276`): 삭제 또는 토스트 연결.
- [ ] **m25. jsonEditor querySelector raw 키 연결 — 특수문자 키 예외** (`src/jsonEditor.ts:1793`): `CSS.escape(col)` 사용.
- [ ] **m26. Hex Custom Editor 상태 보존 없음** (`src/extension.ts:5931-5935`, `src/hexViewer.ts:1171-1229`): `getState/setState`로 scrollTop·selection·unit·endian 직렬화 복원 권장 (retainContext는 메모리 비용 큼).
- [ ] **m27. jsonEditor reload 시 `detectedIndent` 미갱신** (`src/jsonEditor.ts:347, 583-599, 776-791`): reload 성공 분기에서 재계산.

### 파이프라인/Doctor/스키마

- [ ] **m28. 보간기/추론기 trim 비대칭** (`src/pipelineUtils.ts:228 vs 263`): `${ taskA.output }`이 그래프엔 잡히지만 치환은 실패. 양쪽 trim 통일 (치환 쪽에 trim 적용 권장).
- [ ] **m29. 보간 컨텍스트 프로토타입 체인 누출** (`src/pipelineUtils.ts:229-232`): `${constructor.name}` → `"Object"` 치환됨. `hasOwnProperty` 가드 또는 `Object.create(null)` 기반 컨텍스트.
- [ ] **m30. 중복 task id 시 스케줄러가 같은 id를 한 배치에 두 번 반환 → 예외** (`src/pipelineUtils.ts:528-541, 754-766`): `buildTaskGraph`에서 중복 id는 order에 push하지 않거나 `validateTaskGraph`에 duplicate-id 이슈 추가.
- [ ] **m31. previewRun — null/비정상 태스크 항목 가드 부재** (`src/previewRun.ts:306-321`): doctor/pipelineUtils와 동일한 `if (!task || typeof task.id !== 'string') continue;` 가드 + "(invalid task entry — skipped)" 표시.
- [ ] **m32. previewRun — zip 태스크 `source` 필드 미스캔** (`src/previewRun.ts:446-465`): source 보간·표시·interpolated 포함 (Doctor와 결과 어긋남 해소).
- [ ] **m33. doctor `findIdLine` occurrence가 파일 전역 기준 → 위치 어긋남** (`src/doctor.ts:433-445, 459, 480`): 액션 블록 시작 오프셋 이후부터 검색하도록 `fromOffset` 파라미터 추가.
- [ ] **m34. 자기 참조 `${self.x}` 미검출** (`src/previewRun.ts:567-571`, `src/doctor.ts:789-794`): forwardTaskIds에서 `id !== task.id` 제외 + `variable.self-reference` 경고 추가.
- [ ] **m35. JSON 스키마 — 타입별 필수 필드 조건부 검증 부재** (`schema/actions.schema.json:350`, `src/schema.ts`): command 없는 shell 등이 통과. `allOf + if/then` 타입별 required, `id`에 `^[^.${}\s]+$` 패턴, `function`에 enum. 스키마 변경이 부담이면 Doctor 검사로 대체.
- [ ] **m36. 보간 값 인자 경계 침범 (argument injection)** (`src/pipelineUtils.ts:858-895, 901-910`): 사용자 입력이 공백/따옴표 포함 시 옵션 주입 가능 (`--force main`). features.md에 "사용자 입력은 args 배열로" 권고 명시 + Doctor info 안내 검토. 토크나이저의 단어 중간 `'`(O'Brien) 처리 개선 여지.
- [ ] **m37. `getToolCommand` 순진한 공백 인용** (`src/pipelineUtils.ts:844-847`): 내부 `"` 이스케이프 또는 JSDoc "shell-safe" → "tokenizer-safe" 정정.
- [ ] **m38. pipelineUtils throw 메시지 영어 전용 → 토스트에 그대로 노출** (`resolveWithinWorkspace`, `withTaskTimeout` 등): doctor의 `message`/`messageKo` 패턴처럼 error code → 표시 계층 `t()` 매핑, 또는 로케일 주입형 t 변형 도입. extension.ts의 throw 메시지 현지화 비일관(`:3351, 3359, 3419, 3536, 3564, 3959` 영어 vs `:3513-3516` 등 t() 사용)도 같은 방침으로 통일.

---

## 🔵 Info / 권장 사항

- [ ] **i1. ReDoS 소지 (낮은 실위험)** (`src/armLinkListParser.ts:42`, `src/diagnosticMatcher.ts:42`): 인공 입력에서 O(n²) 백트래킹. 라인 길이 상한(4KB 초과 스킵) 권장.
- [ ] **i2. macroExpander 기능 한계 문서화** : 함수형 매크로/줄 연속/`##` 미지원을 모듈 주석에 명시. `evaluateToNumber`의 `Infinity` 반환 구멍에 `Number.isFinite` 체크.
- [ ] **i3. `parseLinkerFileWithDiagnostics` 프로덕션 미사용** (`src/linkerScriptParser.ts`): 호출처 없음. 사용 시 warnings i18n 필요.
- [ ] **i4. `UNRESOLVED_VAR_RE` 전역 g 플래그를 `.test()`와 공용** (`src/previewRun.ts:88` 외 6곳): 비-g 헬퍼로 분리해 lastIndex 함정 제거.
- [ ] **i5. `timeoutSeconds * 1000` 32비트 한도 초과 시 즉시 발화** (`src/pipelineUtils.ts:1296-1301`): `Math.min(..., 2**31 - 1)` 클램프.
- [ ] **i6. `windowsCommandIsDirectlyLaunchable` 주석-코드 불일치** (`src/pipelineUtils.ts:1006-1008`): 낡은 JSDoc 괄호 문구 삭제.
- [ ] **i7. doctor 순환 검출 `process.platform` 고정** (`src/doctor.ts:922`): 3개 플랫폼 각각으로 buildTaskGraph 실행 검토. `:763`의 `hasItemsFromCommand` 판정과 `pipelineUtils.ts:357` 판정 미세 불일치도 정리.
- [ ] **i8. `runCommandCaptureLines` O(n²) byteLength 재계산** (`src/extension.ts:3466-3468`): 누적 바이트 카운터 방식으로 통일. `deactivate()` outputChannel 이중 dispose(`:4373`, `:5954`)도 정리.
- [ ] **i9. extension.ts 모놀리스 분리** (5,957라인 / 49개 명령 / 책임 8~9개): 다음 리팩터링 목표 — `src/run/`(실행기+태스크 핸들러+셸 엔진), `src/presets.ts`(프리셋+import/export), `src/commands/`(도메인별 registerCommand 묶음). 기존 re-export 패턴으로 점진 이전 가능.

---

## 🔧 빌드/인프라

- [ ] **b1. PR/push CI 부재** (`.github/workflows/release.yml`이 유일 — 태그 푸시 시에만 실행): `ci.yml` 신설 — `on: [push, pull_request]`, `matrix.os: [ubuntu-latest, windows-latest]`, Linux `xvfb-run -a npm test`, 공통 `npm run package`. (release.yml 자체는 양호: 버전 검증·vsce 고정·fail_on_unmatched_files.)
- [ ] **b2. eslint 전부 `warn` → lint 게이트 무력** (`eslint.config.mjs:17-27`): `curly`/`eqeqeq`/`semi`를 `error`로 격상 또는 `eslint src --max-warnings 0`. 들여쓰기 4칸 규칙(`@stylistic/indent`) 추가 검토. 첫 객체 `{ files: [...] }` no-op 정리.
- [ ] **b3. `.vscodeignore`에 `docs/**` 추가** : VSIX에 docs 이미지 2.2MB + md 4종 포함 중 (`vsce ls` 확인). repository 필드가 있어 마켓플레이스 README 이미지는 GitHub URL로 재작성되므로 동봉 불필요.
- [ ] **b4. 미사용 devDeps 제거** : `chai`, `@types/chai` — src/test 전체에서 import 0건 (전부 Node `assert`).
- [ ] **b5. `src/types/minimatch-compat.d.ts` 삭제** : `@types/glob`이 lockfile에 더 이상 없음. 제외 후 `tsc --noEmit` 통과 검증 완료.
- [ ] **b6. `ajv` 의존성 분류 비일관** (`package.json:691`): 런타임 import인데 devDeps (adm-zip은 deps). 번들 전제로 통일.
- [ ] **b7. npm overrides 재검증** (`package.json:699-703`): mocha 11이 이미 패치판 요구 — override 없이 audit 0일 가능성. 다음 의존성 정리 때 제거 시도.
- [ ] **b8. 설정 스키마 `history.maxItems`/`runAnyAction.recentLimit` → `"integer"`** (`package.json:103, 110`).
- [ ] **b9. `editor/context`의 `addOpenFileToFavorites` when 부재** (`package.json:489-492`): 노이즈 감소용 when 추가 검토.
- [ ] **b10. 팔레트 명령 일부 `category` 부재** (`showVersion`, `showChangelog` 등): `"category": "TaskHub"` 추가.

✅ 이상 없음 확인: 명령 46개 선언/등록 전수 일치 (내부 전용 2개 미선언은 올바름), 메뉴 viewItem 11종·키바인딩·config when 키 모두 유효, 설정 13종 전부 사용됨, activationEvents 합리적, esbuild 프로덕션 설정(minify, no sourcemap, external vscode) 정상, `npm audit` 취약점 0, lockfile 버전 일치, schema/·presets/ VSIX 포함 정상.

---

## 📄 문서

- [ ] **d1. [major] integration-tests.md 대장에 IT 시나리오 22건 누락** : IT-033b, IT-072d, IT-072e, IT-088~IT-100, IT-102~IT-107 (Quick Action Palette 블록 통째). "문서 먼저" 절차 위반 상태. 대장에 한 줄 요약 추가 + docConsistency.test.ts에 코드↔대장 IT-ID 양방향 검증 추가로 재발 방지. (역방향은 깨끗함: 대장 97개 ID 전부 코드에 존재. IT-101은 결번 — 주석 한 줄 권장.)
- [ ] **d2. "Mocha + Chai" 표기 정정** (CONTRIBUTING.md "테스트 작성", docs/architecture.md 트리 주석): 실제는 Node `assert`. "Mocha + Node `assert`"로 (b4와 연계).
- [ ] **d3. features.md §21.2 — 존재하지 않는 "README 하이라이트 표" 서술** (1810행 부근): README 현재 상태(1~2개 키 산문 언급 + §21 포인터)에 맞게 수정.
- [ ] **d4. architecture.md "개발 시 주의사항" 번호 3 중복 + 불릿 위치 오류** : 1~6 재정렬, HistoryProvider suite 불릿을 1번 항목으로 이동.
- [ ] **d5. roadmap.md 우선순위 1 결번 미설명** : 행방 명시 또는 재번호.
- [ ] **d6. CLAUDE.md 문서 맵에 roadmap.md / integration-tests.md 행 누락** : "향후 계획 → docs/roadmap.md", "통합 테스트 시나리오(IT-xxx) → docs/integration-tests.md" 추가.
- [ ] **d7. README ko/en 의미 차이 1곳** : Actions 불릿 ko "검색/그룹화" vs en "search and filtering" — 통일.
- [ ] **d8. architecture.md 트리에 `src/types/` 누락** (그 외 README.en.md, media 아이콘 일부): 다음 갱신 시 최소 src/types/ 추가.

✅ 이상 없음 확인: CHANGELOG 최신 항목(0.6.1) = package.json 버전, 0.6.1 신기능(itemsFromCommand 등) features.md 반영 완료, Built-in Links(0.5.2 제거) 잔재 0건, examples/README ↔ 실제 파일 1:1 일치, 앵커·이미지·명령/설정 표본 교차 점검 전부 유효, roadmap 미구현 항목 검증 정확.

---

## 종합 평가

**강점**: 방어적 코딩 수준이 매우 높다. 셸 인용(PowerShell `-EncodedCommand`, POSIX 인용), 엄격한 웹뷰 CSP(nonce + `default-src 'none'`), zip-slip 차단, 회귀 테스트 ID를 인용하는 주석 문화, i18n·`===` 컨벤션 준수율(위반 각 1건), 문서 단일 출처 체계와 자동화(docConsistency.test.ts)까지 성숙한 프로젝트.

**약점 패턴 3가지**:
1. **학습이 모듈 간 전파되지 않음** — atob mojibake(C1)는 memoryMapViewer에서 이미 고친 버그가 jsonEditor에 남은 사례. null 가드·경계 검사도 모듈마다 수준이 다름.
2. **"조용히 틀린 값"** — HEX 주소(M2), 64-bit 디코딩(M3/M5/M6), struct sizeof(M4)는 오류 없이 그럴듯한 오답을 보여줘 임베디드 도구로서 가장 위험한 부류.
3. **extension.ts 모놀리스** — 5,957라인/49개 명령. 분리 계획은 i9 참조.

**권장 수정 순서**: C1 → M1 → M2~M4 (파서 오답, 각 1~10줄) → M9 (Doctor 거짓 음성) → M5~M8 → M10~M12 → b1~b3 (CI/eslint/vscodeignore) → d1 → 나머지 minor/info.
