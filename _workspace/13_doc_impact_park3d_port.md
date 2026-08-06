# 10. 문서·영향도 — park3d-rpc 포트 정정

정본 문서: `docs/20260806_140701_Park3D_제어영상_포트분리_정정.md`

## 산출물

| 파일 | 성격 |
|---|---|
| `_workspace/11_architect_plan_park3d_port.md` | 설계 (사실 확정 · 전수 조사 · 검증 기준) |
| `_workspace/12_qa_report_park3d_port.md` | 검증 (typecheck + vitest 실행 결과, 기존 실패 분리 증명) |
| `docs/20260806_140701_Park3D_제어영상_포트분리_정정.md` | 한글 상세 문서 + 영향도 |
| `docs/20260805_003651_*.md` | 상단 **정정 각주** 추가 (본문 미수정 — 이력 보존) |

## 변경 파일 (6)

| 파일 | 성격 |
|---|---|
| `SettingMain/web/optionsDb.js` | 로직 — `portPairWarning` park3d 검증, `streamHint` 값 출처·문구, `camPark3d` 배선 |
| `SettingMain/config/config.example.json` | 예시 — `_comment` · park3d `streamUrl` |
| `SettingMain/src/devices/park3d/park3dRpcClient.ts` | **주석만** |
| `SettingMain/test/optionsPark3dUi.test.ts` | 옛 전제 고정 단언 제거 + 신규 6건 |
| `SettingMain/test/park3dRpcClient.test.ts` | 픽스처 포트 |
| `SettingMain/test/park3dRpcServerRoutes.test.ts` | 픽스처 포트 + 주석 |

## 영향도 요지

- **런타임 동작 변화 없음.** 서버·드라이버 로직은 한 줄도 안 바뀌었다. 바뀐 것은 화면 경고와 문구·예시·주석이다.
- `portPairWarning` 호출부는 `streamHint()` **한 곳뿐**(전수 확인). 4번째 인자는 선택적이라 하위 호환이며
  테스트가 이를 고정한다.
- **hucoms · backend-core 무영향** — `+10` 분기 보존, 회귀 3건 통과.
- **이미 저장된 잘못된 행은 자동으로 안 고쳐진다.** 화면 경고로 드러날 뿐이다(임의 마이그레이션 안 함).
- 형제 `SettingAgent` 는 직접 영향 없으나, 그쪽도 스트림 주소를 다룬다면 같은 규칙을 쓰는지 **확인 필요**
  (이 작업 범위 밖이라 확인하지 않았다).

## 남은 위험

- 포트 공식 `13600 + camId` 는 마스터 확정 + camId 2↔13602 실측. 50대 전수 확인은 아니다.
  규칙이 바뀌면 고칠 곳은 `portPairWarning` 안의 `STREAM_PORT_BASE` 한 곳.
- 브라우저 실동작 미확인 — `npm start` 후 사람이 봐야 한다.
- 전체 회귀의 기존 실패 20건은 범위 밖이라 손대지 않았다(DB 이관 작업 소관).
