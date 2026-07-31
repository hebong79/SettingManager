# SettingManager Codex 하네스

SettingManager의 코드 구현·수정·부트스트랩·테스트 요청에서는 반드시 `settingmanager-dev` 스킬을 사용한다. 단순 조회와 질문에는 이 파이프라인을 강제하지 않는다.

## 5대 규칙

1. 구현 전 설계를 완료한다.
2. 모든 변경에 유닛 테스트를 작성하고 실제 실행한다.
3. 가능한 실제 환경에서 동작을 확인한다. 불가능하면 미검증 사유를 남긴다.
4. 변경 사항을 `docs/yyyyMMdd_hhmmss_이름.md` 형식의 한글 문서로 남긴다.
5. 모듈, 의존성, 기존 기능, 형제 프로젝트에 대한 영향도를 구체적 경로와 함께 분석한다.

## 역할 파이프라인

복잡하거나 코드 변경이 있는 작업은 다음 순서를 지킨다. 각 단계의 산출물은 `_workspace/`에 보존하고, 다음 역할이 이전 결과를 읽어 검증할 수 있게 한다.

1. `architect` — `_workspace/01_architect_plan.md`: 범위, 가정·확인 필요 사항, 단계별 검증 기준, 영향 파일, 비범위를 설계한다. 코드를 수정하지 않는다.
2. `developer` — 소스 및 테스트 초안, `_workspace/02_developer_changes.md`: 승인된 계획 범위에서만 구현한다.
3. `qa-tester` — 실제 테스트 실행, `_workspace/03_qa_report.md`: 계획 기준과 생산자·소비자 경계면을 교차 검증한다. 실패하면 구현자와 원인만 수정·재검증한다. 3회 반복 후에도 해결되지 않으면 중단하고 근거를 보고한다.
4. `documenter` — `docs/yyyyMMdd_hhmmss_*.md`, `_workspace/04_doc_impact.md`: 실제 코드와 QA 결과만 근거로 한글 문서와 영향도를 작성한다.

독립적인 읽기·검증만 병렬화한다. 같은 파일을 수정할 수 있는 구현 작업은 직렬로 실행한다. Codex가 역할을 위임할 수 있는 환경이면 위 이름의 프로젝트 에이전트를 사용한다.

## 프로젝트 맥락과 메모

- `SettingMain/`은 TypeScript(Node ESM) 서비스 루트다. 구체 규약은 `settingmanager-stack` 스킬을 따른다.
- SettingManager는 Setting 관련 Agent를 관리한다. 형제 `AgentVLA/ParkAgent/SettingAgent` 연동 계약은 실제 코드·문서로 확인하기 전까지 추측하지 않는다.
- "메모 해줘" 요청의 단일 정본은 `memo/memo.md`다. 세션 시작 시 `memo/memo.md` 및 `memo/INDEX.md`가 있으면 읽는다. 설계·구현 문서는 `docs/`에, 메모는 `memo/`에만 둔다.
