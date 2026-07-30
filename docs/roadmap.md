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
| 병렬 실행 / Task DAG (이전 §4) | 0.4.41부터 제공. `parallel: true` opt-in + `dependsOn` 런타임 honoring + `${taskId.x}` 자동 의존성 추론 + 사이클/missing/self 검증 + task 단위 timeout/stop + 출력 격리 (streamed terminal group / output.mode terminal 키 분리) + interactive prompt mutex + `taskhub.pipeline.maxParallelTasks` 설정. 기존 직렬 액션은 동작 변화 없음 | [docs/features.md §24](./features.md#24-병렬-실행--task-dag) |

## 테스트 부채

기능이 아니라 **검사의 판별력** 문제라 위 표와 따로 둡니다. CHANGELOG 는 append-only 이력이라 몇 릴리스만 지나면 묻히므로 여기서 추적합니다.

| 항목 | 규모 | 메모 |
| --- | --- | --- |
| `jsonEditorUtils.test.ts` 의 소스 정규식 검사 | 65건 | 함수의 **소스 텍스트**를 정규식으로 검사한다 — 코드에 그 글자가 있는지만 보므로 로직이 틀려도 통과한다. 0.6.47 에서 "디스크 단계 실패 시 복구 fallback" 1건을 실행 기반으로 옮겼다. 대부분은 **웹뷰 스크립트 문자열**(호스트에서 실행할 수 없는 코드)을 보므로 성격이 조금 다르다 — Memory Map 저장 상한과 JSON 키보드 가드에서 쓴 "핸들러를 HTML 에서 꺼내 가짜 DOM 으로 실행" 방식으로 옮길 수 있는 것부터 고르면 된다. |
| Windows 실행 경로 | - | raw `shell` 의 세 실행 모드(0.6.49)는 계약을 순수 함수로 고정했지만 **실제 프로세스 기동은 Windows 러너에서 미검증**이다. `IT-132`/`IT-133` 의 프로세스 트리 종료도 Windows 판별력은 확인되지 않았다. |

## 우선순위 요약

| 순위 | 기능 | 근거 | 구현 크기 |
| --- | --- | --- | --- |
| 2 | CMSIS-SVD 기반 Register/SFR Hover | 벤더 헤더 없는 프로젝트에서 차별점 | 대 |
| 3 | ELF Symbol Navigator | 기존 ELF 파서를 활용한 검색/점프 UX. 단독 가치 있음 | 소 |
| 6 | Named Input Profiles | 인터랙티브 입력 재실행("수정해서 실행")의 더 큰 그림. 임베디드 워크플로 fitness 강함 | 중 |
| 7 | Action Run Report | History 패널 자연 확장. 출력 로그 영속화와 페어 | 중 |
| 8 | 출력 로그 영속화 + 회전 | 작은 비용. Action Run Report에 흡수 가능 | 소 |
| 9 | 백그라운드 완료 알림 + 소요 시간 | 데이터 재활용, UI만 추가. 임베디드 빌드 즉시 통지 | 소 |

> 순위 4(병렬 실행 / Task DAG)와 5(TaskHub Doctor / Action Lint)는 각각 0.4.41 / 0.4.40 릴리스에 포함되었습니다 — 상단 "이미 구현된 항목" 표 참조.

**권장 시작 순서**: CMSIS-SVD 기반 Register/SFR Hover(2) → ELF Symbol Navigator(3). 6~9는 액션 시스템 / UX 영역.

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

## 2. CMSIS-SVD 기반 Register/SFR Hover

`.svd` 파일을 읽어 peripheral/register/field 정보를 hover로 제공.

- `.vscode/taskhub_types.json`에 SVD 경로 지정
- 레지스터명 hover 시 address, reset value, bit field 표시
- 숫자 리터럴 hover에서 "이 값이 어떤 bit field를 켜는지" 디코딩
- Command Palette: `Decode Register Value`
- 관련 문서: [docs/features.md](./features.md) 섹션 15

## 3. ELF Symbol Navigator

기존 [src/elfParser.ts](../src/elfParser.ts)를 활용한 심볼 검색/점프 UX.

- 심볼 이름 검색 → 주소/크기/섹션/hex dump
- Memory Map과 양방향 점프

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

## 7. Action Run Report

실행 후 파이프라인 단위 요약 보고서.

- 항목: task별 소요 시간, exit code, 캡처된 변수, 생성/수정된 파일, diagnostics 개수, 출력 로그 링크
- 표시: History 패널 entry 클릭 → webview 또는 출력 채널 보고서
- 아래 D(출력 로그 영속화)와 페어로 작동 — 보고서가 로그 파일로 링크
- History 패널의 last-run 배지가 1줄 요약이라면 이건 풀 보고서.
- 영역: 액션 시스템 / UX

## 8. 출력 로그 영속화 + 회전

액션 실행 출력을 워크스페이스에 자동 저장.

- 경로: `<workspace>/.taskhub/logs/<actionId>/<timestamp>.log`
- 회전: N개 또는 X일 (settings)
- C(Action Run Report)에 흡수 가능 — 단독 가치는 "진단 받은 뒤 이전 실행 로그 비교"
- Output Channel은 휘발성이라 디버깅·회고 시 한계 명확
- 영역: 액션 시스템 / UX (Action Run Report와 묶을지 분리할지 결정 필요)

## 9. 백그라운드 완료 알림 + 소요 시간

설정 임계치(예: 10초) 넘는 액션 종료 시 OS notification + statusbar 잠깐 깜빡.

- 임베디드 빌드 / 플래시 같은 분 단위 작업에서 VS Code 다른 창 보고 있어도 결과 즉시 인지
- History 패널의 last-run 배지가 *사후 회고*라면 이건 *즉시 통지* — 데이터 재활용, UI만 추가
- 비용 작음 (settings 임계치 + `vscode.window.showInformationMessage` / statusbar 토글)
- 영역: 액션 시스템 / UX

---

## 메모

- 원본 논의: 현재 강점(Memory Map, C/C++ Hover, 파이프라인)을 더 쓸모 있게 만드는 방향이 "새 영역 확장"보다 우선.
- 구현 순서 설계 원칙: 임베디드 세부 도구(2~3) → 액션 시스템 / UX 후보(6~9).
- 이번 릴리스에서 완료된 항목(Output Parser / Preview Run / timeoutSeconds / continueOnError / Problem Matcher)은 상단 "이미 구현된 항목" 표 참조.
