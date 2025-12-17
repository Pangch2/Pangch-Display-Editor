
---

## Pangch-Display-Editor

**Pangch-Display-Editor**는 Minecraft `display` 엔티티 기반 모델링 및 애니메이션 작업을 위한 도구입니다.

---

## 프로젝트 스크립트

| 명령어            | 설명          |
| -------------- | ----------- |
| `npm install`  | 프로젝트 의존성 설치 |
| `npm run dev`  | 개발 환경 실행    |
| `npm run dist` | 프로젝트 빌드     |

---

## 현재 구현된 기능

### 프로젝트 관리

* 프로젝트 불러오기
* 프로젝트 병합 (merge)

### Display 기능

* display 인스턴싱
* block_display
* item_display
* player_head

---

## 조작키 안내

### Gizmo 조작

* `T` — 이동 (Translate)
* `R` — 회전 (Rotate)
* `S` — 스케일 (Scale)

### 세부 조작 기능

* `Z` — Pivot Mode 변경 (origin / center)
* `X` — TransformControls Space 변경 (world / local)
  ※ scale gizmo도 world space 지원
* `V` — 객체 스케일의 Shear 제거
* `B` — Blockbench 스케일 모드 토글

### 피벗(Pivot) 관련

* `Alt` + 이동(Translate) — 커스텀 피벗 생성
* `Ctrl` + `Alt` — 커스텀 피벗 초기화

### 선택 / 그룹 관리

* `G` — 그룹 생성 / 그룹 해제
* `Ctrl` + `G` — 선택한 그룹 해제
* `Ctrl` + `A` — 전체 선택
* `Ctrl` + `Shift` + `A` — 그룹을 제외한 모든 오브젝트 선택
* `Ctrl` + 클릭 — 그룹을 무시하고 오브젝트 선택

### 오브젝트 편집

* `D` — 선택한 오브젝트 복사
* `Del` / `Backspace` — 선택한 오브젝트 삭제
