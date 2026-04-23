# TaskHub

> 반복적인 개발 작업을 자동화하고, 임베디드 C/C++ 개발에 특화된 hover 도구를 제공하는 VS Code 확장 프로그램.

[한국어](README.md) · [English](README.en.md)

---

## 목차

- [핵심 기능](#핵심-기능)
- [스크린샷](#스크린샷)
- [설치](#설치)
- [사용법](#사용법)
- [설정](#설정)
- [문서](#문서)

---

## 핵심 기능

### 워크플로우 자동화
- **사용자 정의 액션** — 셸 명령, 파일 압축/해제, 문자열 처리 등을 JSON으로 정의·실행
- **파이프라인** — 여러 태스크를 순서대로 실행하며 `${task_id.property}`로 결과 연결
- **액션 생성 마법사** — 대화형 UI로 코드 작성 없이 액션 생성
- **Preset** — 팀원들과 action 설정 공유
- **실행 히스토리** — 성공/실패 추적, 빠른 재실행

### 사이드바 패널
- **Actions** — 액션 버튼과 폴더 트리, 검색/그룹화
- **링크** — Built-in / Workspace 링크 관리
- **즐겨찾기** — 자주 쓰는 파일을 줄 번호와 함께 저장
- **히스토리** — 실행 기록과 상태 표시

### C/C++ Hover (임베디드 개발 특화)
- **Number Base Hover** — 숫자 리터럴의 Hex / Dec / Bin 진법 변환과 비트 정보
- **SFR Bit Field Hover** — 레지스터 비트 필드 정보 (위치, 접근 타입, 리셋 값, 마스크)
- **Register Decoder Hover** — 레지스터에 대입된 값을 비트 필드 단위로 디코드
- **Macro Expansion Hover** — `#define` 매크로의 최종 확장 결과
- **Struct Size Hover** — 구조체/클래스 크기, 멤버별 오프셋, 패딩 자동 계산
- **Bit Operation Hover** *(실험적)* — 비트 연산 결과 미리보기

### 뷰어
- **Memory Map 시각화** — ARM Linker Listing / GNU ld 출력 파싱
- **Hex Viewer** — 주소/16진/ASCII 3단, Unit·Endian·Go-to·Find 지원
- **JSON Editor** — JSON 배열/객체를 스프레드시트 UI로 편집

> 상세 설명과 JSON 예제는 [docs/features.md](docs/features.md) 참조.

---

## 스크린샷

### 워크플로우

<table>
  <tr>
    <td align="center" width="34%">
      <b>사이드바</b><br>
      <sub>Actions · Links · Favorites · History 통합 뷰</sub><br>
      <img src="docs/images/sidebar-overview.png" alt="TaskHub 사이드바" width="260">
    </td>
    <td align="center" width="33%">
      <b>액션 실행</b><br>
      <sub>실행 중 상태 아이콘 표시</sub><br>
      <img src="docs/images/actions-running.png" alt="액션 실행 중" width="260">
    </td>
    <td align="center" width="33%">
      <b>실행 히스토리</b><br>
      <sub>성공/실패 기록과 빠른 재실행</sub><br>
      <img src="docs/images/history-panel.png" alt="History 패널" width="260">
    </td>
  </tr>
</table>

### C/C++ Hover

<table>
  <tr>
    <td align="center" width="50%">
      <b>Number Base Hover</b><br>
      <sub>리터럴 진법 변환 + 32-bit 비트 맵</sub><br>
      <img src="docs/images/hover-number-base.png" alt="Number Base Hover">
    </td>
    <td align="center" width="50%">
      <b>Register Decoder Hover</b><br>
      <sub>레지스터 값을 비트 필드별로 디코드</sub><br>
      <img src="docs/images/hover-register-decode.png" alt="Register Decoder Hover">
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <b>SFR Bit Field Hover</b><br>
      <sub>비트 필드 위치·접근 타입·리셋 값 요약</sub><br>
      <img src="docs/images/hover-sfr-bit-field.png" alt="SFR Bit Field Hover">
    </td>
    <td align="center" width="50%">
      <b>Macro Expansion Hover</b><br>
      <sub><code>#define</code> 매크로의 최종 확장</sub><br>
      <img src="docs/images/hover-macro-expansion.png" alt="Macro Expansion Hover">
    </td>
  </tr>
</table>

### 뷰어

**Memory Map 시각화** — ARM Linker Listing / GNU ld 출력을 파싱해 메모리 리전별 사용량·섹션·함수 분포를 시각화.

![Memory Map - ARM Linker 예제](docs/images/memory-map-armlink.png)

**Hex Viewer** — 바이너리 파일을 주소/16진/ASCII 3단으로 표시. Unit(1/2/4/8 Byte), Endian, Go-to, Find 지원.

![Hex Viewer - sample_binary.bin 예제](docs/images/hex-viewer.png)

**JSON Editor** — JSON 배열/객체를 스프레드시트 형태로 편집. 행 추가/삭제/드래그, 셀 타입 변환(`s→a`, `a→s`) 지원.

![JSON Editor - test.json 예제](docs/images/json-editor.png)

---

## 설치

### VSIX 수동 설치

1. [Releases](https://github.com/MunseopLim/TaskHub/releases)에서 최신 `.vsix` 다운로드
2. VS Code에서 `Ctrl+Shift+P` (macOS: `Cmd+Shift+P`) → **Extensions: Install from VSIX...**
3. 다운로드한 `.vsix` 파일 지정

직접 빌드하거나 기여하려면 [CONTRIBUTING.md](CONTRIBUTING.md) 참조.

---

## 사용법

1. 활동 표시줄의 **'H' 아이콘**을 클릭하여 TaskHub 뷰 열기
2. Actions 패널에서 액션 실행, 링크 패널에서 리소스에 빠르게 접근
3. `.vscode/actions.json` · `.vscode/links.json` · `.vscode/favorites.json` 파일을 편집하여 사용자 지정

---

## 설정

VS Code `File > Preferences > Settings`에서 **"TaskHub"** 로 검색하면 전체 설정을 UI로 조정할 수 있습니다. 각 설정의 타입·기본값·범위·관련 기능과 새 설정 추가 절차는 [docs/features.md §21 설정 레퍼런스](docs/features.md#21-설정-레퍼런스)에서 단일 출처로 관리됩니다.

---

## 문서

| 문서 | 설명 |
|------|------|
| [docs/features.md](docs/features.md) | 상세 기능 문서 (태스크 타입, JSON 예제, hover 기능 등) |
| [docs/architecture.md](docs/architecture.md) | 프로젝트 구조, 주요 컴포넌트, 데이터 구조, 보안 |
| [docs/roadmap.md](docs/roadmap.md) | 향후 기능 로드맵 + 이미 구현된 항목 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 개발 환경 셋업, 빌드, 테스트, 기여 가이드 |
| [CLAUDE.md](CLAUDE.md) | AI 에이전트 규칙 (코딩 컨벤션, i18n, 커밋 형식) |
| [CHANGELOG.md](CHANGELOG.md) | 버전별 변경 이력 |
| [examples/README.md](examples/README.md) | 각 기능 시연용 예제 파일 설명 |

---

## 라이선스

[MIT](LICENSE)
