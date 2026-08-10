# TaskHub 기능 로드맵 (TODO)

향후 추가를 검토 중인 **임베디드 / 펌웨어 도구** 기능 목록입니다. 우선순위는 구현 크기, 기존 자산 재사용, 사용자 체감 가치를 종합해 정했습니다.

## 이미 구현된 항목

다음은 이전 로드맵에 남아 있었으나 현재 릴리스에 포함되어 TODO에서 제외합니다. 실제 사용법은 `docs/features.md` 해당 섹션 참조.

| 기능 | 구현 상태 | 참조 |
| --- | --- | --- |
| Output Parser (`output.capture` 규칙) | 0.3.x부터 제공. regex/line/group/flags/trim 지원, 다중 규칙 허용 | [docs/features.md §5 "Output Capture"](./features.md#output-capture) |
| 파이프라인 Preview Run (Dry-run) | 0.3.x부터 제공. 액션 우클릭 → Preview Run, 변수 해석·워크스페이스 외부 쓰기 경고·미해결 `${...}` 요약 | [docs/features.md §5 "Preview Run (Dry-run)"](./features.md#preview-run-dry-run) |
| Task-level `timeoutSeconds` / `continueOnError` | 0.3.x부터 제공 | [docs/features.md §5 "Task-level 옵션"](./features.md#task-level-옵션-timeoutseconds--continueonerror) |
| Problem Matcher (`output.diagnostics`) | 0.4.22부터 제공. regex/file/line/severity 그룹, 다중 매처, VS Code Problems 패널 통합 | [docs/features.md](./features.md) `output.diagnostics` 섹션 |
| 같은 title 폴더 액션 disambiguation (이전 §12) | 0.4.26부터 제공. History 패널이 같은 title 충돌 시에만 라벨을 풀 경로(`Firmware > Build`)로 스왑, 반복 실행은 충돌로 안 침. 풀 경로는 툴팁에도 항상 노출 | [src/providers/historyProvider.ts](../src/providers/historyProvider.ts) `computeDisambiguatedHistoryLabels` |
| Quick Action Palette (이전 §9) | 0.4.28부터 제공. `TaskHub: Run Any Action…` 단일 커맨드로 모든 액션 fuzzy 검색·실행. 0.6.12부터 *Recently used* 섹션은 History에서 유도 — 트리 클릭·키바인딩·History 재실행까지 한 순서로 반영되고 마지막 실행 시각/성패가 행에 표시됨. 액션 ID 기준(이름 변경 무관)·표시 시점에 stale 항목 필터 | [src/extension.ts](../src/extension.ts) `taskhub.runAnyAction`, `buildRunAnyActionPicks`, [src/providers/historyProvider.ts](../src/providers/historyProvider.ts) `deriveRecentActionRuns` |
| TaskHub Doctor / Action Lint (이전 §5) | 0.4.40부터 제공. `TaskHub: Doctor — Lint Actions` 커맨드가 모든 `actions.json` 소스를 한 번에 정적 분석해 Problems 패널에 게시 (스키마/regex/미해결 변수/외부 쓰기/중복 id/capture group/dependsOn cycle 7종 검사) | [docs/features.md §23](./features.md#23-taskhub-doctor-action-lint), [src/doctor.ts](../src/doctor.ts) |
| ELF Symbol Navigator — 심볼 검색/점프 (이전 §3, 부분) | 0.7.13부터 제공. Memory Map 패널에서 `Ctrl/Cmd+Shift+O` 또는 명령 팔레트로 **실제 심볼/섹션 행**을 QuickPick 검색 → 그 행으로 이동(접힌 영역 펼침·가상 스크롤 스크롤·강조·live region 안내). 남은 것은 아래 §3 참조 (hex dump, 소스↔맵 양방향 점프) | [docs/features.md](./features.md) "검색 및 탐색", [src/memoryMapViewer.ts](../src/memoryMapViewer.ts) `goToSymbol` |
| ELF Symbol Navigator — 소스 → 맵 점프 (§3a) | 0.7.14부터 제공. C/C++ 편집기 우클릭 → *이 심볼을 맵에서 보기* 로 커서 아래 심볼을 **열려 있는** Memory Map 에서 찾아 그 행으로 이동. 대상 바이너리는 열린 패널로 정하고(매핑 설정 없음), C++ mangled 이름은 Itanium `길이+이름` 표기로 뚫으며, 부분 일치는 하지 않는다 | [docs/features.md](./features.md) "검색 및 탐색", [src/memoryMapViewer.ts](../src/memoryMapViewer.ts) `revealSourceSymbolInMemoryMap` |
| 병렬 실행 / Task DAG (이전 §4) | 0.4.41부터 제공. `parallel: true` opt-in + `dependsOn` 런타임 honoring + `${taskId.x}` 자동 의존성 추론 + 사이클/missing/self 검증 + task 단위 timeout/stop + 출력 격리 (streamed terminal group / output.mode terminal 키 분리) + interactive prompt mutex + `taskhub.pipeline.maxParallelTasks` 설정. 기존 직렬 액션은 동작 변화 없음 | [docs/features.md §24](./features.md#24-병렬-실행--task-dag) |

## 테스트 부채

기능이 아니라 **검사의 판별력** 문제라 위 표와 따로 둡니다. CHANGELOG 는 append-only 이력이라 몇 릴리스만 지나면 묻히므로 여기서 추적합니다.

| 항목 | 규모 | 메모 |
| --- | --- | --- |
| `jsonEditorUtils.test.ts` 의 소스 정규식 검사 | 65건 | 함수의 **소스 텍스트**를 정규식으로 검사한다 — 코드에 그 글자가 있는지만 보므로 로직이 틀려도 통과한다. 0.6.47 에서 "디스크 단계 실패 시 복구 fallback" 1건을 실행 기반으로 옮겼다. 대부분은 **웹뷰 스크립트 문자열**(호스트에서 실행할 수 없는 코드)을 보므로 성격이 조금 다르다 — Memory Map 저장 상한과 JSON 키보드 가드에서 쓴 "핸들러를 HTML 에서 꺼내 가짜 DOM 으로 실행" 방식으로 옮길 수 있는 것부터 고르면 된다. 0.7.13 의 [src/test/memoryMapGoToSymbol.test.ts](../src/test/memoryMapGoToSymbol.test.ts) 가 같은 방식의 두 번째 예다 — 웹뷰 함수를 통째로 꺼내 스텁 스코프에서 실행하고, 순서 의존(펼치기 → 행 찾기)까지 스텁이 재현하게 했다. |
| Windows 실행 경로 | - | raw `shell` 의 세 실행 모드(0.6.49)는 계약을 순수 함수로 고정했지만 **실제 프로세스 기동은 Windows 러너에서 미검증**이다. `IT-132`/`IT-133` 의 프로세스 트리 종료도 Windows 판별력은 확인되지 않았다. |

## 우선순위 요약

크기는 **코드에 대고 실측한 값**입니다(0.7.13 기준). 항목을 통째로 재지 않고, 값을 가르는 조각까지 쪼갠 뒤 각 절에 근거를 적었습니다 — 같은 절 안에서도 조각마다 한 단계 이상 차이가 납니다.

| 순위 | 기능 | 근거 | 구현 크기 |
| --- | --- | --- | --- |
| 9 | 백그라운드 완료 알림 + 소요 시간 | `durationMs` 가 이미 완료 지점 4곳에서 계산됨. 설정 임계치 + 창 포커스 판별만 추가 | **소** |
| 3b | ELF Symbol Navigator — **심볼 → Hex dump** | 파서가 파일 오프셋을 버리고 있어 vaddr→offset 변환부터 필요. 안 되는 경우(.bss / listing / 50MB) 처리가 본체 | 소~중 |
| 6 | Named Input Profiles | 실행 엔진(`presetInputs`)·무효값 재질문·비밀 제외가 이미 있음. 저장소와 관리 UI만 신규 | 소~중 (파일 저장이면 중~대) |
| 8 | 출력 로그 영속화 + 회전 | 쓰기·회전은 작지만 **마스킹 재검증이 본체** — 유출이 디스크에 영구화되고 커밋될 수 있음 | 중 |
| 7 | Action Run Report | 태스크별 시간·exit code·diagnostics·생성 파일은 **아직 아무도 수집하지 않음**. 파이프라인 배선이 비용 | 중 |
| 2 | CMSIS-SVD 기반 Register/SFR Hover | 표시 계층(`RegisterDecoder`, 900줄)은 재사용 가능. 비용은 SVD 파서 자체 | 대 |
| 3c | ELF Symbol Navigator — **맵 → 소스 (정확)** | 심볼 테이블에 소스 위치가 없음. DWARF 파서가 필요 | 대 |

> 순위 4(병렬 실행 / Task DAG)와 5(TaskHub Doctor / Action Lint)는 각각 0.4.41 / 0.4.40 릴리스에 포함되었습니다 — 상단 "이미 구현된 항목" 표 참조.

**권장 시작 순서**: ~~3a~~(0.7.14 완료) → 9 → 3b. 셋 다 기존 자산 위에 얹히고 각각 독립적으로 가치가 있습니다. 그 뒤는 **8 → 7** 순서입니다(아래 §7 참조 — 로드맵이 오래 반대로 적고 있던 의존 방향입니다). 2는 단독으로 가장 크므로 마지막입니다.

### 로드맵 크기 표기를 바꾼 이유

이전 표는 §3 전체를 "소", §8을 "소"로 적고 있었습니다. 실제로는 §3 안에 "소"와 "대"가 함께 있었고, §8은 파일 쓰기가 아니라 **보안 재검증**이 본체였습니다. 크기를 절 단위로 적으면 착수 시점에 예상이 무너지므로, 이제 조각 단위로 적습니다.

---

## 0.4.41 후속 작업 (병렬 실행 / Task DAG)

0.4.41에서 MVP 합의 범위를 다 닫았지만, 리뷰에서 짚인 잔여 항목들. B와 A(c)안은 0.4.42, C는 0.4.43에 들어갔고, 남은 미해결 항목은 A(b)안 하나다 — 우선순위 낮음.

### A. Doctor / Preview Run의 full graph-aware 시뮬레이션 *(Medium, future enhancement)*

0.4.42에서 (c)안 — `findUnresolved`가 같은 액션의 valid task id를 tolerated head로 받아 forward ref false positive를 차단 — 을 적용해 정상 패턴은 더 이상 `variable.unresolved`로 잡히지 않는다. 트레이드오프: head가 valid task id이면 capture/result 키 typo (예: `${A.typoKey}` where `A`는 valid이지만 `typoKey`는 없음)도 함께 묻힌다.

진짜 graph-aware 시뮬레이션 ((b)안: `buildTaskGraph` + 토폴로지 정렬로 시뮬레이션 순서를 결정해 런타임과 동일하게 동작)은 필요해질 때 별도 작업으로 진행. 코드량 크고 영향 범위 넓어 우선순위는 낮음.

영향 파일: [src/previewRun.ts](../src/previewRun.ts) `buildPreviewReport` loop, [src/doctor.ts](../src/doctor.ts) `analyzeActionTasks`.

### B. spawn 경로 verbose OutputChannel 로그의 task id prefix  *(0.4.42에 구현됨)*

`executeShellCommand` 내부 5개 verbose 로그 사이트가 `[task:${taskId}] ` prefix를 받도록 정리. multiline `stdout`/`stderr`도 모든 continuation line이 prefix를 가지며 split은 `\r\n`/`\r`/`\n`을 모두 인식. `taskKey` 없는 legacy caller는 기존 unprefixed 포맷 유지. 참조: [src/extension.ts](../src/extension.ts) `executeShellCommand` `appendVerboseLine`.

### C. Actions 패널에서 동시 진행 task 다중 표시  *(0.4.43에 구현됨)*

`ActionProgress`를 `{ total, completed, running: string[] }`로 확장하고 `onTaskTransition`이 4가지 transition 상태를 모두 받도록 정리. TreeItem 렌더(`formatProgressDescription`)가 running 개수에 따라 1개는 `2/3 · link`(기존 호환), 2개는 `2 running · A, B`, 3개+는 `4 running · A, B + 2` overflow 표기, 0개+completed>0인 transition 사이 gap은 `1/3` compact form. 참조: [src/providers/actionStatus.ts](../src/providers/actionStatus.ts), [src/providers/mainViewProvider.ts](../src/providers/mainViewProvider.ts) `formatProgressDescription`, [src/extension.ts](../src/extension.ts) `onTaskTransition`.

---

## 2. CMSIS-SVD 기반 Register/SFR Hover  *(크기: 대)*

`.svd` 파일을 읽어 peripheral/register/field 정보를 hover로 제공.

- `.vscode/taskhub_types.json`에 SVD 경로 지정
- 레지스터명 hover 시 address, reset value, bit field 표시
- 숫자 리터럴 hover에서 "이 값이 어떤 bit field를 켜는지" 디코딩
- Command Palette: `Decode Register Value`
- 관련 문서: [docs/features.md](./features.md) 섹션 15

**이미 있는 것 (재사용 가능)**: 비트 디코딩·마스크/유효범위 계산·접근 타입 설명·계층 표시는 [src/registerDecoder.ts](../src/registerDecoder.ts)(`RegisterDecoder`)와 [src/sfrBitFieldParser.ts](../src/sfrBitFieldParser.ts)에 이미 있습니다(합 900줄). 지금은 **C 헤더의 비트필드 선언/주석**에서 데이터를 얻습니다. SVD는 같은 표시 계층에 붙는 **새 데이터 소스**이지, 새 hover 기능이 아닙니다.

**비용이 큰 이유는 파서입니다**:

- SVD는 XML인데 이 프로젝트의 런타임 의존성은 `adm-zip` / `yauzl` **둘뿐**입니다. XML 파서를 새로 들이거나(의존성 정책과 충돌 — [CONTRIBUTING.md](../CONTRIBUTING.md) npm overrides 절 참조) 부분집합 파서를 직접 씁니다.
- 평면 구조가 아닙니다. `derivedFrom`(peripheral 상속), `dim`/`dimIncrement`(레지스터 배열), cluster, peripheral 기본값 상속을 무시하면 STM32/NXP 실파일에서 **틀린 비트 정보**가 나옵니다. 없는 것보다 나쁘므로 MVP에서 뺄 수 없습니다.
- 실파일이 1~10MB XML이라 파싱 비용·캐싱이 따라옵니다.

**분할 제안**: "SVD 파서"(대)와 "파서 결과를 기존 hover에 연결"(소)로 나눠, 파서만 독립 모듈로 먼저 세우고 테스트를 붙이는 편이 안전합니다.

## 3. ELF Symbol Navigator  *(심볼 검색/점프는 0.7.13에 구현됨)*

기존 [src/elfParser.ts](../src/elfParser.ts)를 활용한 심볼 검색/점프 UX.

- ~~심볼 이름 검색 → 주소/크기/섹션~~ — 0.7.13. Memory Map 패널의 *Go to Symbol* 이 심볼/섹션 행을 QuickPick으로 검색해 해당 행으로 이동한다. 상세는 상단 "이미 구현된 항목" 표 참조

남은 세 조각은 크기가 서로 다릅니다. 한 항목으로 묶어 "소"로 적던 것을 쪼갭니다.

### 3a. 소스 → 맵 점프  *(0.7.14에 구현됨, 0.7.15에서 이름 매칭 보강)*

상단 "이미 구현된 항목" 표 참조. 실측대로 얇게 끝났고(신규 코드 대부분이 매칭 판정), 착수 시 예상하지 못했던 것은 하나였습니다 — **C++ mangled 이름**. 소스에는 `HAL_Init` 로 쓰지만 맵에는 `_ZN3HAL8HAL_InitEv` 로 들어 있어, 이름 비교만으로는 C++ 프로젝트에서 거의 아무것도 찾지 못합니다. 디맹글러 없이 Itanium ABI 의 이름부만 읽어 해결했습니다(§3c 의 디맹글링 부채와는 별개 — 이쪽은 *찾기*만 하면 되고 *복원*할 필요가 없어서 가능했습니다).

**범위를 명시해 둡니다.** 3a 의 이름 매칭은 **흔한 Itanium 이름 형태만 보수적으로 인식합니다** — 중첩 이름 · 템플릿(인자·표현식·인자 팩) · 치환 · 생성자/소멸자 · 최적화 clone 접미사까지. thunk(`_ZTv…`) · 벤더 확장(`U…`) · ABI tag 뒤의 이름 · 특수 엔티티 등 **모르는 문법을 만나면 이름부 읽기를 중단하고 미탐으로 남깁니다** — 재동기화를 시도하면 없는 이름을 만들어 엉뚱한 심볼로 이동시키기 때문입니다(0.7.15 에서 `cxx11` · `E` 두 가짜 이름을 이 경로로 없앴습니다). 정확한 디맹글링이 필요해지면 휴리스틱을 덧대지 말고 **§3c 의 공통 부채**로 한 번에 세울 것.

### 3b. 심볼 → hex dump  *(소~중)*

**막는 것**: [`ElfSection`](../src/elfParser.ts) 과 `ElfSegment` 가 **파일 오프셋(`sh_offset` / `p_offset`)을 버립니다.** 지금 남는 건 `addr`(가상주소)뿐이라 "심볼 주소 → 파일의 몇 번째 바이트"를 계산할 수 없습니다. 파서에 필드를 더하고 vaddr→offset 헬퍼를 세우는 일 자체는 작지만, 모두가 의존하는 파서와 `assembleElf32` 픽스처가 함께 움직입니다.

**붙는 쪽은 수월합니다**: Hex Viewer에 selection/goto 기계가 이미 있어(`parseHexViewerGoToOffset`, `hexCellOverlapsSelection`), 호스트→웹뷰 `goToOffset` 메시지 하나를 더하는 형태입니다 — 0.7.13의 `revealEntry` 와 같은 패턴.

**진짜 비용은 "안 되는 경우"를 정직하게 처리하는 데 있습니다.** 하나라도 빠뜨리면 0.7.13이 고친 "눌러도 아무 일이 없다"가 그대로 재현됩니다.

| 경우 | 필요한 처리 |
| --- | --- |
| `.bss`(NOBITS) 심볼 | 파일에 바이트가 **없다**. 잘못된 오프셋 대신 거절 |
| ARM Linker Listing으로 연 맵 | 바이너리가 없다 → 메뉴 항목 자체를 숨김 |
| 50MB~100MB ELF | Memory Map은 100MB, Hex Viewer는 `HEX_VIEWER_MAX_FILE_SIZE` 50MB. 열리던 맵이 hex에서 거절됨 |

### 3c. 맵 → 소스 점프  *(휴리스틱 중 / 정확 대)*

ELF 심볼 테이블에는 **소스 위치가 없습니다.** 정확히 하려면 DWARF(`.debug_line`) 파서가 필요한데, `elfParser.ts` 전체가 794줄인 것을 감안하면 별도 프로젝트급입니다.

싼 우회로는 `executeWorkspaceSymbolProvider` 로 이름을 찾는 것이고 선례가 [src/numberBaseHoverProvider.ts](../src/numberBaseHoverProvider.ts) 에 있습니다. C에서는 충분하지만 **C++에서 무너집니다** — 맵의 이름은 `_ZN1TEST10Func` 형태의 mangled name이고([src/armLinkListParser.ts](../src/armLinkListParser.ts) 참조) 저장소에 디맹글러가 없습니다. C++ 펌웨어를 다룬다면 디맹글링이 별도 덩어리로 따라옵니다.

## 4. 병렬 실행 / Task DAG  *(0.4.41에 구현됨)*

0.4.41 릴리스로 들어왔습니다. 상세는 [docs/features.md §24](./features.md#24-병렬-실행--task-dag) 참조. 핵심: `parallel: true` opt-in, 자동 의존성 추론(`${taskId.x}`), `validateTaskGraph` 사전 검증, task 단위 timeout/stop, 병렬 액션의 출력 격리, interactive task의 prompt mutex, `taskhub.pipeline.maxParallelTasks` 설정 (기본 4, 범위 1~32).

## 5. TaskHub Doctor / Action Lint  *(0.4.40에 구현됨)*

0.4.40 릴리스로 들어왔습니다. 상세는 [docs/features.md §23](./features.md#23-taskhub-doctor-action-lint) 참조. 현재 범위에 포함된 검사: 스키마 위반, regex 컴파일(capture/diagnostics), capture/diagnostics group 인덱스, 중복 액션·task id, 미해결 `${…}` 변수, 워크스페이스 외부 쓰기, `dependsOn` self/missing/cycle. 보류된 항목: `type: 'tool'` 경로 존재, `vscodeTask` label 매칭 — 두 기능 모두 스키마에 정식 진입한 뒤에 Doctor 검사로 추가.

## 6. Named Input Profiles

인터랙티브 task(`inputBox` / `quickPick` / `envPick` 등)의 응답값 조합을 이름 붙여 저장 → 선택만으로 재실행.

```json
{
  "id": "fw.flash",
  "tasks": [...],
  "profiles": {
    "stm32f4-release": { "board": "stm32f4", "build": "release", "port": "/dev/tty.usbmodem01" },
    "stm32f7-debug":   { "board": "stm32f7", "build": "debug",   "port": "/dev/tty.usbmodem02" }
  }
}
```

- 히스토리 기반 "수정해서 실행"이 마지막 한 번 재실행이라면, profile은 *반복* 사용 케이스 정확히 적중.
- 명령:
  - `TaskHub: Run Action with Profile…` → quickPick으로 profile 선택
  - `TaskHub: Save Last Inputs as Profile…` → 히스토리 기반 이름 부여
- 비밀번호(`password: true`)는 히스토리 저장 정책과 동일하게 profile 저장 제외.
- 임베디드 워크플로 (`board=... + build=... + port=...`)와 fitness 강함.
- 영역: 액션 시스템

### 이 기능을 정당화하는 근거는 "이름"이 아니라 **10개 상한**이다

History는 `workspaceState` 에 저장되고 **기본 10개에서 잘립니다**([src/providers/historyProvider.ts](../src/providers/historyProvider.ts) `addHistoryEntry`, `taskhub.history.maxItems` 기본 10, FIFO). 환경 조합 서너 개를 번갈아 쓰는 사람은 **다른 액션을 열 번만 실행해도** 원하던 조합이 밀려 사라지고, 세 질문에 다시 답해야 합니다. 이건 "찾기 불편"이 아니라 기능의 부재입니다.

반대로 대부분 직전 값 하나만 재사용한다면 지금으로 충분하며, 이 기능은 관리 부담만 늘립니다. **유실 문제로 프레이밍하면 값어치가 있고, 편의 문제로 프레이밍하면 없습니다.**

### 실행 엔진은 만들 것이 없다 (검증됨)

- `presetInputs` 가 인터랙티브 6종을 모두 단락시킵니다 ([src/extension.ts](../src/extension.ts) `PipelineSideChannels`).
- 무효값 재질문이 **파이프라인 안**에 있습니다 — `presetAcceptable = presetResult === undefined || savedInputStillValid(task, presetResult)`. 명령이 걸러 주는 게 아니라 실행 경로가 걸러 주므로, 프로필도 같은 채널로 넣기만 하면 삭제된 quickPick 항목·바뀐 `validatePattern` 재질문을 **그대로 얻습니다**.
- 비밀 제외는 기록 시점(`shouldRecordTaskInput`)에 걸려 있어 프로필로 복사해도 애초에 값이 없습니다.

남는 것은 저장소 하나와 UI 세 곳(History에서 저장 / 액션 메뉴에서 실행 / 이름변경·삭제)입니다.

### 크기를 가르는 결정: 프로필을 어디에 두는가

| | `workspaceState` | `.vscode/` 파일 (위 JSON 예시) |
| --- | --- | --- |
| 크기 | 소~중 (History와 같은 방식) | 중~대 |
| 딸려 오는 것 | 없음 | 스키마 + Doctor 검사 + 예제 + 문서 + 마이그레이션 |
| 팀 공유 | 안 됨 | 됨 |

**`workspaceState` 로 시작할 것.** 파일로 두면 `port: "COM4"` 나 로컬 경로처럼 **애초에 공유하면 안 되는 값**이 커밋으로 새 나갑니다. 위 JSON 예시는 팀 공유 수요가 확인된 뒤의 2단계로 남깁니다.

### 함정 둘

1. **프로필이 액션보다 오래 산다.** History 항목은 곧 밀려 나가지만 프로필은 몇 달을 남습니다. 그 사이 task id가 바뀌면 `presetInputs` 는 id로 매칭하므로 그 키가 **조용히 무시되고**, 사용자는 "왜 이것만 다시 묻지?"를 겪습니다. 저장 시점의 task id 목록을 함께 두고 불일치를 목록에 표시할 것.
2. **`fileDialog` 경로는 존재 검사를 하지 않는다.** `savedInputStillValid` 는 형식만 봅니다. 지운 파일을 가리키는 프로필은 통과한 뒤 실행 중에 깨집니다.

## 7. Action Run Report  *(크기: 중 — §8 다음)*

실행 후 파이프라인 단위 요약 보고서.

- 항목: task별 소요 시간, exit code, 캡처된 변수, 생성/수정된 파일, diagnostics 개수, 출력 로그 링크
- 표시: History 패널 entry 클릭 → webview 또는 출력 채널 보고서
- History 패널의 last-run 배지가 1줄 요약이라면 이건 풀 보고서.
- 영역: 액션 시스템 / UX

**이미 기록되는 것**: `HistoryEntry` 는 `durationMs`(**액션 단위**), `output`, `commands`(태스크별 해석된 명령줄), `inputs` 를 갖습니다.

**아직 아무도 수집하지 않는 것**: 태스크별 소요 시간, exit code, diagnostics 개수, 생성/수정된 파일. `TaskTransitionEvent` 도 `running` / `success` / `failure` / `skipped` 상태만 나르므로, **여기에 시간과 exit code를 싣는 것이 자연스러운 자리**입니다. 보고서 UI가 아니라 이 수집 배선이 비용의 본체입니다.

**의존 방향이 그동안 반대로 적혀 있었다**: 이전 문서는 "§8은 §7에 흡수 가능"이라고 했지만, 실제로는 **§7이 §8을 필요로 합니다.** History는 `workspaceState` 에 사는데(항목 10개 상한) 보고서 본문까지 그곳에 넣으면 워크스페이스 상태가 비대해집니다. 보고서는 디스크의 로그를 **가리켜야** 하고, 그 디스크 저장이 §8입니다. 그래서 순서는 **8 → 7**.

## 8. 출력 로그 영속화 + 회전  *(크기: 중 — 쓰기가 아니라 마스킹 재검증이 본체)*

액션 실행 출력을 워크스페이스에 자동 저장.

- 경로: `<workspace>/.taskhub/logs/<actionId>/<timestamp>.log`
- 회전: N개 또는 X일 (settings)
- 단독 가치는 "진단 받은 뒤 이전 실행 로그 비교"
- Output Channel은 휘발성이라 디버깅·회고 시 한계 명확
- 영역: 액션 시스템 / UX

**greenfield**: `.taskhub` 디렉터리는 아직 코드 어디에도 없습니다. 쓰기·회전 자체는 작습니다.

**크기를 "소"에서 "중"으로 올린 이유는 보안입니다.** 지금까지의 비밀 마스킹(`SECRET_PLACEHOLDER`)은 **휘발성 출력 채널**을 전제로 설계됐습니다. 0.7.12에서 `when` 실패 사유 문구가 비밀번호를 평문으로 흘리던 것을 고쳤듯, 마스킹이 닿지 않는 경로가 하나라도 남아 있으면 디스크 저장은 그 유출을 **영구화하고 git에 커밋시킵니다.** 착수 시 필요한 일:

- 기록되는 모든 경로가 마스킹을 거치는지 재검증 (명령줄·cwd·stdout/stderr·실패 사유)
- `.gitignore` 안내 또는 `.taskhub/` 자동 생성 시 기본 ignore 작성
- 워크스페이스 외부 쓰기 가드(`resolveWithinWorkspace`)와의 정합
- 기존 캡처 상한(1MB)과 회전 정책의 관계 — 상한에 걸려 잘린 출력을 "완전한 로그"로 저장하지 않기

## 9. 백그라운드 완료 알림 + 소요 시간  *(크기: 소 — 가장 싼 항목)*

설정 임계치(예: 10초) 넘는 액션 종료 시 OS notification + statusbar 잠깐 깜빡.

- 임베디드 빌드 / 플래시 같은 분 단위 작업에서 VS Code 다른 창 보고 있어도 결과 즉시 인지
- History 패널의 last-run 배지가 *사후 회고*라면 이건 *즉시 통지* — 데이터 재활용, UI만 추가
- 영역: 액션 시스템 / UX

**데이터가 이미 다 있습니다**: `durationMs` 가 완료 지점 **4곳(성공·실패·취소·중단)에서 이미 계산돼** `updateHistoryStatus` 로 넘어갑니다. 알림 자체도 `showInformationMessage` 로 저장소 전반에서 쓰는 방식입니다.

**남는 결정 두 가지**: (1) 창이 이미 포커스돼 있으면 알리지 않을 것인가(`vscode.window.state.focused`) — 보고 있는 화면에 OS 알림이 겹치면 방해가 됩니다. (2) 병렬 액션이 한꺼번에 끝날 때의 알림 폭주 억제.

---

## 메모

- 원본 논의: 현재 강점(Memory Map, C/C++ Hover, 파이프라인)을 더 쓸모 있게 만드는 방향이 "새 영역 확장"보다 우선.
- 구현 순서 설계 원칙: 임베디드 세부 도구(2~3) → 액션 시스템 / UX 후보(6~9). 다만 **크기 실측(0.7.13) 이후 착수 순서는 영역이 아니라 비용/의존 순서**를 따른다 — 위 "권장 시작 순서" 참조.
- 크기 표기 규칙: 절 단위로 한 값만 적지 않는다. 한 절 안에서 조각마다 한 단계 이상 차이 나는 경우가 실제로 있었다(§3 은 소~대, §7↔§8 은 의존 방향이 반대로 적혀 있었다).
- 이번 릴리스에서 완료된 항목(Output Parser / Preview Run / timeoutSeconds / continueOnError / Problem Matcher)은 상단 "이미 구현된 항목" 표 참조.
