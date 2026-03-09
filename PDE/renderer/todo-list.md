# 요청사항
- `renderer/controls/gizmo.ts` 의 handle-key로직을 `renderer/controls/handle-key.ts`로 분리해줘
- 작업을 하면서 지속적인 체크리스트 점검하기

# 체크리스트
- [x] `gizmo.ts`의 handle-key로직이 `handle-key.ts`로 분리가 완료되었는가
- [x] `handle-key.ts` 와 `gizmo.ts`가 서로 상호작용이 가능한가
- [x] 수정 후 `npm run type-check`로 타입 에러 체크가 완료되었나
- [x] 작업이 완료되면 `renderer/rule.prompt.md`의 `# 프로젝트 구조 및 컨텍스트` 부분 수정하기
