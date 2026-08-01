---
name: settingmanager-dev
description: SettingManager의 기능 구현, 버그 수정, 리팩터링, 부트스트랩, 테스트 추가 또는 SettingAgent 연동을 4역할 파이프라인으로 수행한다. "만들어줘", "구현해줘", "수정해줘", "재실행", "설계부터" 같은 코드 변경 요청에 사용하며, 단순 조회·질문이나 하네스 자체 변경에는 사용하지 않는다.
---

# SettingManager 개발 하네스

`architect → developer → qa-tester → documenter` 순서로 실행한다. 역할 정의는 `.codex/agents/`에 있다. 최종 소스·문서는 정식 경로에, 중간 산출물은 `_workspace/`에 보존한다.

## 역할 모델 배정

사용자가 별도 변경을 지시할 때까지 역할별 모델은 다음과 같이 배정한다.

| 역할 | 모델 | 책임 |
|---|---|---|
| architect | `gpt-5.6-sol` | 코드 변경 전 설계와 계약·수용 기준 확정 |
| developer | `gpt-5.6-terra` | 승인된 설계 범위의 구현 |
| verification | `gpt-5.6-terra` | 개발 결과의 독립 코드·계약 검토 |
| qa | `gpt-5.6-terra` | 실제 실행, Vitest 및 사용자 시나리오 검증 |
| documenter | `gpt-5.6-luna` | 실제 코드·QA 근거 기반의 한글 문서화와 영향도 분석 |

환경이 역할별 고정 모델을 강제하는 경우에는 사용자 지정 모델을 우선할 수 있는 일반 에이전트로
같은 책임을 수행하고, 산출물 경로·검증 기준·재시도 규칙은 이 하네스를 그대로 따른다.

## 0. 시작 확인

1. `memo/memo.md`, `memo/INDEX.md`, 기존 `docs/*.md`, 기존 `_workspace/`를 읽는다.
2. `_workspace/`가 없으면 초기 실행이다. 있으면 사용자 요청이 부분 수정인지 새 주제인지 판정한다. 새 주제면 이전 폴더를 실제 시각의 `_workspace_prev_yyyyMMdd_HHmmss/`로 이동한 뒤 새 파이프라인을 시작한다.
3. `SettingMain/package.json`이 없으면 설계의 첫 단계에 부트스트랩을 넣는다. 스택 세부 사항은 `settingmanager-stack`을 읽는다.
4. 형제 SettingAgent와의 계약이 불명확하면 구현 전 `확인 필요:`로 사용자에게 올린다.

## 1. 설계

`architect`에게 계획을 위임하고 `_workspace/01_architect_plan.md`를 검토한다. 단계마다 관찰 가능한 성공 기준이 있어야 한다. 계획 없는 기능, 추측한 외부 계약, 확인 불가능한 기준은 다음 단계로 넘기지 않는다.

## 2. 구현과 검증

`developer`에게 계획에 한정해 구현하도록 맡기고 `_workspace/02_developer_changes.md`를 받는다. 모듈이 여러 개면 완료한 모듈부터 `qa-tester`가 점진적으로 검증한다.

QA는 Vitest를 작성하고 실제 실행하며 `_workspace/03_qa_report.md`에 결과를 남긴다. 실패하면 구현자에게 파일:라인, 재현, 기대값/실제값을 보내고 원인만 수정한 뒤 재실행한다. 같은 결함 루프가 3회 넘게 실패하면 중단하고 사용자에게 근거와 선택지를 보고한다. 테스트 기대값을 느슨하게 해서 통과시키지 않는다.

## 3. 문서화와 최종 보고

모든 QA 결과가 확정되면 `documenter`에게 실제 코드와 01~03 산출물을 넘긴다. 문서화 담당자는 `docs/yyyyMMdd_hhmmss_*.md`와 `_workspace/04_doc_impact.md`를 작성한다.

최종 보고에는 변경 파일, 테스트의 통과/실패/스킵 수, 문서 경로, 형제 프로젝트를 포함한 영향도, 미완·미검증 사유를 사실 그대로 쓴다.

## 작업 경계

- 읽기·탐색·독립 검증만 병렬화한다. 같은 파일을 바꿀 수 있는 개발 작업은 직렬로 실행한다.
- 역할 간 결과는 파일 경로와 실행 명령·근거를 남겨 다음 역할이 검증 가능하게 한다.
- 하네스 재구성은 이 스킬이 아니라 저장소의 `AGENTS.md`, `.codex/agents/`, `.agents/skills/`를 직접 수정하는 작업으로 처리한다.
