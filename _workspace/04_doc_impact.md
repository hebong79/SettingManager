# 문서화 및 영향도 요약

- 문서: `docs/20260801_114158_탐색_카메라제어형_레이아웃.md`
- 근거: `_workspace/01_architect_plan.md`, `_workspace/02_developer_changes.md`, `_workspace/03_qa_report.md`, 실제 `discovery.html`·`app.css`·`server.test.ts` 변경.
- 구조: `.layout.discovery-layout`의 3 direct child(`discoveryTarget` → `discoveryViewer` → `advanced`), 1101px 이상 좌측 조작/우측 sticky 영상, 1100px 이하 한 열. 영상 버튼은 카드 하단 우측이며 fixed/overlay를 사용하지 않는다.
- 보존 계약: `discovery.js` 스트림 lifecycle·ID/API 재사용, BackendCore 이중 gate, Hucoms discovery 409, centerBox 501, 외부 409/422 및 VLA `saveSpots:false`를 유지한다.
- 신규 외부 표면 없음: API·의존성·설정 포맷·공유 타입 변경 없음. 직접 영향은 `SettingMain/web/discovery.html`, `SettingMain/web/app.css`, `SettingMain/test/server.test.ts`; 관련 소비/생산 경계는 `web/discovery.js`, `src/api/server.ts`, `src/clients/backendCoreClient.ts`, `src/stream/*`다. 형제 `AgentVLA/ParkAgent/SettingAgent`와 운영 카메라 코드는 수정하지 않았다.
- QA: typecheck/build/diff-check exit 0, Vitest 9파일 178 테스트 통과. 13030은 종료하지 않은 기존 프로세스에 GET만 수행했다. 브라우저 부재로 폭별·키보드·sticky 시각 검증은 미검증이며 PTZ 등 제어 명령도 미실행이다.
