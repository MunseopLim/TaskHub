# TaskHub 기능 로드맵 (TODO)

향후 추가를 검토 중인 기능 목록입니다. 우선순위는 구현 크기, 기존 자산 재사용, 사용자 체감 가치를 종합해 정했습니다.

## 이미 구현된 항목

다음은 이전 로드맵에 남아 있었으나 현재 릴리스에 포함되어 TODO에서 제외합니다. 실제 사용법은 `docs/features.md` 해당 섹션 참조.

| 기능 | 구현 상태 | 참조 |
| --- | --- | --- |
| Output Parser (`output.capture` 규칙) | 0.3.x부터 제공. regex/line/group/flags/trim 지원, 다중 규칙 허용 | [docs/features.md §5 "Output Capture"](./features.md#output-capture) |
| 파이프라인 Preview Run (Dry-run) | 0.3.x부터 제공. 액션 우클릭 → Preview Run, 변수 해석·워크스페이스 외부 쓰기 경고·미해결 `${...}` 요약 | [docs/features.md §5 "Preview Run (Dry-run)"](./features.md#preview-run-dry-run) |
| Task-level `timeoutSeconds` / `continueOnError` | 0.3.x부터 제공 | [docs/features.md §5 "Task-level 옵션"](./features.md#task-level-옵션-timeoutseconds--continueonerror) |

조건부 실행 자체는 남은 TODO에 유지합니다 — 아래 `when` / `retry`는 아직 미구현.

## 우선순위 요약

| 순위 | 기능 | 근거 | 구현 크기 |
| --- | --- | --- | --- |
| 1 | Memory Map Diff / Budget Check | 파서/WebView 기반이 이미 있음. 임베디드 정체성 강화 | 중 |
| 2 | 조건부 실행 (`when`) / Retry | Output Parser·Dry-run·`timeoutSeconds`는 이미 구현. 남은 흐름 제어만 보강 | 중 |
| 3 | Hex Viewer Checksum / Compare | 작고 빠른 개선. 펌웨어 검증 실사용 | 소 |
| 4 | Problem Matcher (빌드 에러 파싱) | 빌드 피드백 루프 단축 | 소~중 |
| 5 | CMSIS-SVD 기반 Register/SFR Hover | 벤더 헤더 없는 프로젝트에서 차별점 | 대 |
| 6 | ELF Symbol Navigator | #1의 전제이자 단독 가치도 있음 | 소 |
| 7 | 병렬 실행 / Task DAG | 멀티 타겟 빌드 사용자에 한정적 | 중 |
| 8 | Serial / Target Console | 체감 크지만 구현 범위 큼, 기존 확장과 경쟁 | 대 |

**권장 시작 순서**: Memory Map Diff(1) → 조건부 실행(2).

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

## 2. 조건부 실행 (`when`) / Retry

`timeoutSeconds`, `continueOnError`는 이미 구현되어 있으므로 남은 두 필드만 TODO로 유지합니다.

```json
{
  "id": "flash",
  "type": "shell",
  "command": "pyocd flash firmware.hex",
  "when": "${build.exitCode} == 0",
  "retry": 2
}
```

- 초기 `when`은 단순 truthy / string compare로 시작 (표현식 엔진 금지).
- Output Parser가 제공하는 파생 변수(`${task_id.<name>}`)로 조건을 구성.
- 추후 AND/OR 조합 정도까지 확장.
- 관련 코드: [src/extension.ts](../src/extension.ts) `executeActionPipeline`, [src/schema.ts](../src/schema.ts) `Task` 인터페이스.

## 3. Hex Viewer Checksum / Compare

Hex Viewer 선택 영역에 대한 작고 자주 쓰일 도구들.

- 선택 영역 CRC32, CRC16-CCITT, SHA256
- 선택 영역 binary export
- 두 HEX/SREC/BIN 파일 diff
- address range 추출
- Intel HEX ↔ BIN 변환
- 관련 문서: [docs/features.md](./features.md) 섹션 20

## 4. Problem Matcher (빌드 에러 파싱)

`shell` 태스크 출력을 파싱해 VS Code Problems 패널로 전달.

```json
{ "type": "shell", "command": "make all", "problemMatcher": "gcc" }
```

- 기본 제공 매처: `gcc`, `armcc`, `iar`, `clang`
- 사용자 정의 매처 지원 (regex + file/line/severity 그룹)

## 5. CMSIS-SVD 기반 Register/SFR Hover

`.svd` 파일을 읽어 peripheral/register/field 정보를 hover로 제공.

- `.vscode/taskhub_types.json`에 SVD 경로 지정
- 레지스터명 hover 시 address, reset value, bit field 표시
- 숫자 리터럴 hover에서 "이 값이 어떤 bit field를 켜는지" 디코딩
- Command Palette: `Decode Register Value`
- 관련 문서: [docs/features.md](./features.md) 섹션 15

## 6. ELF Symbol Navigator

기존 [src/elfParser.ts](../src/elfParser.ts)를 활용한 심볼 검색/점프 UX.

- 심볼 이름 검색 → 주소/크기/섹션/hex dump
- Memory Map과 양방향 점프
- #1 Memory Map Diff의 전제 조건

## 7. 병렬 실행 / Task DAG

```json
{ "id": "buildA", "type": "shell", "command": "..." },
{ "id": "buildB", "type": "shell", "command": "...", "parallel": true },
{ "id": "merge",  "dependsOn": ["buildA", "buildB"] }
```

- 멀티 타겟, 멀티 MCU 프로젝트 대상
- 순차 실행 기본값 유지 (하위 호환)

## 8. Serial / Target Console

펌웨어 Flash 후 타겟 로그 확인을 파이프라인 안에서.

```json
{ "type": "serial", "port": "/dev/tty.usbmodem", "baud": 115200, "logFilter": "^\\[ERR\\]" }
```

- Flash → 자동 시리얼 모니터 연동
- 로그 필터/저장
- 주의: 기존 Serial Monitor 확장과 경쟁 범위 확인 필요

---

## 메모

- 원본 논의: 현재 강점(Memory Map, Hex Viewer, C/C++ Hover, 파이프라인)을 더 쓸모 있게 만드는 방향이 "새 영역 확장"보다 우선.
- 구현 순서 설계 원칙: 간판 기능(1) → 흐름 제어 마감(2) → 세부 도구(3~8).
- 이번 릴리스에서 완료된 항목(Output Parser / Preview Run / timeoutSeconds / continueOnError)은 상단 "이미 구현된 항목" 표 참조.
