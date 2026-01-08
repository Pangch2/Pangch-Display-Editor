# 개요
- 해당 프롬포트는 PDE 모델링 툴 개발에 있어 필요한 규칙들을 정의합니다.

# 사용 기술
- HTML5
- CSS3
- JavaScript
- TypeScript

# 코드 스타일
- 주석은 필요한 경우에만 작성하며, 코드의 의도를 명확히 설명해야 합니다.

# 파일 구조
hardcoded/ - 하드코딩 블럭, 아이템 모음
├ blockstates/
└ models/
    ├ block/
    └ item/
main.js
package.json
preload.js
renderer/
├ asset-manager.js - 마인크래프트 에셋 관리
├ entityMaterial.js - 모델에 넣을 셰이더
├ global.d.ts
├ index.html - 메인 화면
├ load-project/ - 프로젝트 불러오기 관련 폴더(block_display, item_display, player_head, group 처리)
│   ├ pbde-worker.ts - upload-pbde.ts전용 web-worker, .bdengine .pdengine파일 파싱
│   └ upload-pbde.ts - pbde-worker.ts의 데이터를 받는 메인쓰레드
├ controls/
│   └ gizmo.js - gizmo 컨트롤러
├ renderer.js - 메인 씬 렌더러
└ ui-open-close.js - UI 열기/닫기 애니메이션
resources/ - 웹,빌드 이미지 모음
tsconfig.json
vite.config.js

# 네이밍
- 변수명, 함수명, 클래스명은 카멜케이스(camelCase)를 사용합니다.
- 파일명은 소문자와 하이픈(-)을 사용하여 구분합니다

# 중요 규칙
- 언어는 기본적으로 한국어를 사용해야 한다
- 명확하지 않은 것은 한국어로 질문해야 한다.
- three js r182이상을 사용중
- three js의 webgpu를 사용해야해 즉 import * as THREE from 'three/webgpu'를 사용해야해
- scene.add(transformControls)은 scene.add(transformControls.getHelper())로 변경해야하
- package.json에 있는 scripts, npm은 실행하지마
- player_head는 hardcoded폴더에 포함되지 않아
- three js문법이 예전버전에 사용된 것이라면 three js 마이그래이션 가이드를 참고하기
- 가이드 링크 : https://github.com/mrdoob/three.js/wiki/Migration-Guide