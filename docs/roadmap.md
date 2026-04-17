# TaskHub 기능 로드맵 (TODO)

향후 추가를 검토 중인 기능 목록입니다. 우선순위는 구현 크기, 기존 자산 재사용, 사용자 체감 가치를 종합해 정했습니다.

## 우선순위 요약

| 순위 | 기능 | 근거 | 구현 크기 |
| --- | --- | --- | --- |
| 1 | Memory Map Diff / Budget Check | 파서/WebView 기반이 이미 있음. 임베디드 정체성 강화 | 중 |
| 2 | Output Parser (Shell 출력 → 변수) | Dry-run·Conditional·Budget의 공통 기반. 선행 투자 가치 | 소 |
| 3 | 파이프라인 Dry-run / Variable Inspector | 사용자의 JSON 작성 실패율을 즉시 낮춤 | 중 |
| 4 | 조건부 실행 / Retry / Timeout | 워크플로우 자동화의 핵심. `when`은 단순 비교부터 | 중 |
| 5 | Hex Viewer Checksum / Compare | 작고 빠른 개선. 펌웨어 검증 실사용 | 소 |
| 6 | Problem Matcher (빌드 에러 파싱) | 빌드 피드백 루프 단축 | 소~중 |
| 7 | CMSIS-SVD 기반 Register/SFR Hover | 벤더 헤더 없는 프로젝트에서 차별점 | 대 |
| 8 | ELF Symbol Navigator | #1의 전제이자 단독 가치도 있음 | 소 |
| 9 | 병렬 실행 / Task DAG | 멀티 타겟 빌드 사용자에 한정적 | 중 |
| 10 | Serial / Target Console | 체감 크지만 구현 범위 큼, 기존 확장과 경쟁 | 대 |

**권장 시작 순서**: Output Parser(2) → Memory Map Diff(1) → Dry-run(3).
Output Parser가 있어야 Budget 비교, `when` 조건, 미리보기가 공통 기반 위에서 동작합니다.

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

## 2. Output Parser (Shell 출력 → 변수)

현재 `${task_id.output}`는 stdout 전체를 전달한다. 정규식/JSON 경로 파싱을 추가해 파이프라인 표현력을 확장.

```json
{
  "id": "git-sha",
  "type": "shell",
  "command": "git rev-parse HEAD",
  "output": {
    "capture": { "regex": "^([a-f0-9]{7})", "group": 1, "name": "shortSha" }
  }
}
```

- 사용: `${git-sha.shortSha}`
- JSON path 파싱 변형: `{ "jsonPath": "$.version", "name": "ver" }`
- 관련 코드: [src/schema.ts](../src/schema.ts) `Output` 인터페이스

## 3. 파이프라인 Dry-run / Variable Inspector

액션 실행 전 변수 해석·최종 명령·unresolved 변수·위험 쓰기 대상을 미리 보여줌.

- `${task_id.output}` 등 변수가 어떻게 해석될지 미리 보기
- 최종 command / cwd / env / output path 표시
- unresolved variable 경고
- workspace 밖 파일 쓰기, 덮어쓰기 위험 미리 경고
- 진입: 액션 우클릭 → `Preview Run` / `Validate Action`
- 관련 코드: [src/extension.ts](../src/extension.ts) `executeSingleTask` 인근

## 4. 조건부 실행 / Retry / Timeout

현재 순차 실행 파이프라인에 흐름 제어 필드 추가.

```json
{
  "id": "flash",
  "type": "shell",
  "command": "pyocd flash firmware.hex",
  "when": "${build.exitCode} == 0",
  "timeoutMs": 60000,
  "retry": 2,
  "continueOnError": false
}
```

- 초기 `when`은 단순 truthy / string compare로 시작 (expression engine 금지)
- 추후 AND/OR 조합 정도까지 확장

## 5. Hex Viewer Checksum / Compare

Hex Viewer 선택 영역에 대한 작고 자주 쓰일 도구들.

- 선택 영역 CRC32, CRC16-CCITT, SHA256
- 선택 영역 binary export
- 두 HEX/SREC/BIN 파일 diff
- address range 추출
- Intel HEX ↔ BIN 변환
- 관련 문서: [docs/features.md](./features.md) 섹션 20

## 6. Problem Matcher (빌드 에러 파싱)

`shell` 태스크 출력을 파싱해 VS Code Problems 패널로 전달.

```json
{ "type": "shell", "command": "make all", "problemMatcher": "gcc" }
```

- 기본 제공 매처: `gcc`, `armcc`, `iar`, `clang`
- 사용자 정의 매처 지원 (regex + file/line/severity 그룹)

## 7. CMSIS-SVD 기반 Register/SFR Hover

`.svd` 파일을 읽어 peripheral/register/field 정보를 hover로 제공.

- `.vscode/taskhub_types.json`에 SVD 경로 지정
- 레지스터명 hover 시 address, reset value, bit field 표시
- 숫자 리터럴 hover에서 "이 값이 어떤 bit field를 켜는지" 디코딩
- Command Palette: `Decode Register Value`
- 관련 문서: [docs/features.md](./features.md) 섹션 15

## 8. ELF Symbol Navigator

기존 [src/elfParser.ts](../src/elfParser.ts)를 활용한 심볼 검색/점프 UX.

- 심볼 이름 검색 → 주소/크기/섹션/hex dump
- Memory Map과 양방향 점프
- #1 Memory Map Diff의 전제 조건

## 9. 병렬 실행 / Task DAG

```json
{ "id": "buildA", "type": "shell", "command": "..." },
{ "id": "buildB", "type": "shell", "command": "...", "parallel": true },
{ "id": "merge",  "dependsOn": ["buildA", "buildB"] }
```

- 멀티 타겟, 멀티 MCU 프로젝트 대상
- 순차 실행 기본값 유지 (하위 호환)

## 10. Serial / Target Console

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
- 구현 순서 설계 원칙: 공통 기반(2) → 간판 기능(1) → 작성 경험(3) → 흐름 제어(4) → 세부 도구(5~10).
