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
| Quick Action Palette (이전 §9) | 0.4.28부터 제공. `TaskHub: Run Any Action…` 단일 커맨드로 모든 액션 fuzzy 검색·실행. 최근 사용 액션은 상위 섹션에 노출, MRU는 액션 ID로 저장(이름 변경 무관)·표시 시점에 stale 항목 필터 | [src/extension.ts](../src/extension.ts) `taskhub.runAnyAction`, `buildRunAnyActionPicks`, `updateRunAnyActionMru` |
| TaskHub Doctor / Action Lint (이전 §5) | 0.4.40부터 제공. `TaskHub: Doctor — Lint Actions` 커맨드가 모든 `actions.json` 소스를 한 번에 정적 분석해 Problems 패널에 게시 (스키마/regex/미해결 변수/외부 쓰기/중복 id/capture group/dependsOn cycle 7종 검사) | [docs/features.md §23](./features.md#23-taskhub-doctor-action-lint), [src/doctor.ts](../src/doctor.ts) |

## 우선순위 요약

| 순위 | 기능 | 근거 | 구현 크기 |
| --- | --- | --- | --- |
| 1 | Memory Map Diff / Budget Check | 파서/WebView 기반이 이미 있음. 임베디드 정체성 강화 | 중 |
| 2 | CMSIS-SVD 기반 Register/SFR Hover | 벤더 헤더 없는 프로젝트에서 차별점 | 대 |
| 3 | ELF Symbol Navigator | #1의 전제이자 단독 가치도 있음 | 소 |
| 4 | 병렬 실행 / Task DAG | 멀티 타겟 빌드 사용자에 한정적. Doctor가 이미 `dependsOn` cycle/missing을 검사 — 본 작업은 런타임 스케줄러 추가 | 중 |
| 6 | Named Input Profiles | 인터랙티브 입력 재실행("수정해서 실행")의 더 큰 그림. 임베디드 워크플로 fitness 강함 | 중 |
| 7 | Action Run Report | History 패널 자연 확장. 출력 로그 영속화와 페어 | 중 |
| 8 | 출력 로그 영속화 + 회전 | 작은 비용. Action Run Report에 흡수 가능 | 소 |
| 9 | 백그라운드 완료 알림 + 소요 시간 | 데이터 재활용, UI만 추가. 임베디드 빌드 즉시 통지 | 소 |

> 순위 5(TaskHub Doctor / Action Lint)는 0.4.40 릴리스에 포함되었습니다 — 상단 "이미 구현된 항목" 표 / [docs/features.md §23](./features.md#23-taskhub-doctor-action-lint) 참조.

**권장 시작 순서**: Memory Map Diff(1) → ELF Symbol Navigator(3). 6~9는 액션 시스템 / UX 영역.

---

## 1. Memory Map Diff / Budget Check

이전 빌드 대비 Flash/RAM 증감, region/symbol/object별 예산 초과 여부 확인.

```json
{
  "memoryMap": {
    "budgets": [
      { "region": "FLASH", "maxUsed": "900KB" },
      { "region": "RAM", "maxUsed": "180KB" }
    ]
  }
}
```

- 커맨드: `TaskHub: Compare Memory Maps`, `TaskHub: Check Memory Budget`
- 또는 액션 태스크 타입으로 통합
- 기반 파서: AXF/ELF, armlink listing, 링커 스크립트 (이미 존재)
- 관련 문서: [docs/features.md](./features.md) 섹션 19

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
- #1 Memory Map Diff의 전제 조건

## 4. 병렬 실행 / Task DAG

```json
{ "id": "buildA", "type": "shell", "command": "..." },
{ "id": "buildB", "type": "shell", "command": "...", "parallel": true },
{ "id": "merge",  "dependsOn": ["buildA", "buildB"] }
```

- 멀티 타겟, 멀티 MCU 프로젝트 대상
- 순차 실행 기본값 유지 (하위 호환)

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
- 구현 순서 설계 원칙: 간판 기능(1) → 임베디드 세부 도구(2~4) → 액션 시스템 / UX 후보(5~9).
- 이번 릴리스에서 완료된 항목(Output Parser / Preview Run / timeoutSeconds / continueOnError / Problem Matcher)은 상단 "이미 구현된 항목" 표 참조.
