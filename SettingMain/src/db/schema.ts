/**
 * 커미셔닝 산출 DB 스키마.
 *
 * 근거: `docs/my_think/my_db_table.md`. 그 문서의 7개 표를 SQLite 로 옮긴 것이고,
 * 아래 주석의 「문서와 다른 점」이 해석이 들어간 자리 전부다 — 임의로 늘리지 않았다.
 *
 * ## 문서와 다른 점 (해석한 자리)
 *
 * 1. **`floor_ROI` 는 테이블이 아니라 VIEW 다.** 문서의 1번은 5번(`slot_setup`)의 진부분집합이고
 *    둘 다 "전체 슬롯 갯수만큼"이다. 같은 값을 두 자리에 저장하면 반드시 어긋나고, 어긋났을 때
 *    어느 쪽이 맞는지 판단할 근거가 없다. 그래서 `slot_setup` 만 저장하고 1번은 뽑아 준다.
 * 2. **`pos`·`ptz` 는 3열로 편다**(`*_pan`·`*_tilt`·`*_zoom`). 한 칸에 문자열로 넣으면
 *    "줌이 8000 이상인 슬롯"조차 질의할 수 없다.
 * 3. **이미지는 경로만 담는다**(`img1`·`img2`). JPEG 를 BLOB 으로 넣으면 DB 가 금방 수백 MB 가
 *    되고, 슬롯 한 줄 읽는 질의까지 무거워진다.
 * 4. **`parking_evnt` 에 `event_id` 를 만든다.** 문서에는 키가 없는데, 입·출차 이력은 같은
 *    `slot_id` 로 여러 줄이 쌓이므로 대리키가 없으면 한 줄을 가리킬 수 없다.
 * 5. **`cam_uuid` 가 SettingManager 의 기기 id 를 담는다.** 이 서비스의 기기 id 는
 *    `real-camera-1` 같은 문자열이고 문서의 `cam_id` 는 정수다. 둘을 잇는 자리가 필요하다.
 * 6. **`marked_x`·`marked_y` 를 더한다.** 문서의 `slot_setup` 에는 "사람이 찍은 픽셀"을 담을 칸이
 *    없다(`slot3d_front_center` 는 3D 에서 **계산된** 점이라 다른 값이다). 그 클릭 좌표가
 *    호밍이 조준하는 출발점이므로 없으면 커미셔닝이 성립하지 않는다.
 * 7. **`camera_info` 에 열 4개를 더한다**(v2) — `timeout_ms`·`kind`·`park3d_cam_id`·`intrinsics`.
 *    문서의 10개 칸만으로는 `config.json` 이 갖고 있던 카메라 정보를 다 담을 수 없고, 그중
 *    `kind` 가 없으면 **드라이버 자체를 만들 수 없다.**
 *    **그리고 v4 에서 `cam_company` 를 지우고 `kind` 하나만 남겼다**(마스터 결정 2026-08-06) —
 *    그래서 이 표는 문서의 10칸 중 `cam_company` 를 **담지 않는다.** 근거는 실 운용 5대에서 두
 *    값이 사실상 1:1 이었다는 것이다(휴컴스↔`hucoms`, 언리얼 Park3D 시뮬↔`park3d-rpc`).
 *    유일한 반례였던 `simulator-1`(제조사 `시뮬레이터` / 프로토콜 `hucoms`)도 실측 PTZ 200 으로
 *    `hucoms` 가 맞음을 확인했다. **감수한 손실**: 제조사를 따로 적을 자리가 없어진다
 *    (`simulator-1` 은 이름 `UE 시뮬 1 (8081)` 에 시뮬이라는 정보가 남는다).
 *    `cam_id`(우리 통번)와 Park3D 서버의 카메라 번호는 여전히 **다른 축**이다 — 우연히 같을
 *    때만 맞아 어긋나면 **엉뚱한 카메라를 움직인다.**
 * 8. **ROI·박스류는 JSON 문자열**이고 `json_valid` 로 막는다. 점 개수까지는 검사하지 않는다 —
 *    스키마가 할 수 있는 일이 아니고, 저장소 계층이 검사한다.
 *
 * ## 좌표 규약
 * PTZ 는 이 서비스의 계약 좌표(Hucoms 논리)와 같다 — pan 0..35999, tilt -2000..9000,
 * zoom 0..65535, 단위는 0.01°(줌은 불투명 raw). 픽셀은 1920×1080 논리 프레임이다.
 */

/**
 * `PRAGMA user_version` 에 기록한다. 스키마를 바꾸면 **올리고 마이그레이션을 추가**한다.
 * 올리지 않으면 옛 파일이 새 코드로 조용히 열려 없는 열을 읽는다.
 * 그래도 잊었을 때를 대비해, 여는 시점에 이 `SCHEMA_SQL` 과 실제 파일을 대조해 없는 표·열을
 * 이름째 던지는 안전망이 있다(`database.ts` 의 `verifySchema`) — 판을 안 올려도 대조가 잡는다.
 */
export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
-- 4. 주차장 정보 -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS place_info (
  place_id   INTEGER PRIMARY KEY,
  place_name TEXT NOT NULL
);

-- 2. 카메라 정보 -------------------------------------------------------------
-- cam_id 는 1부터 시작하는 정수(문서 규약)이고, cam_uuid 가 SettingManager 의 기기 id 다.
CREATE TABLE IF NOT EXISTS camera_info (
  cam_id      INTEGER PRIMARY KEY,
  cam_name    TEXT    NOT NULL,
  cam_uuid    TEXT    NOT NULL UNIQUE,
  url         TEXT    NOT NULL DEFAULT '',
  user_id     TEXT    NOT NULL DEFAULT '',
  password    TEXT    NOT NULL DEFAULT '',
  rtsp_url    TEXT    NOT NULL DEFAULT '',
  cam_type    TEXT    NOT NULL DEFAULT 'ptz' CHECK (cam_type IN ('ptz', 'static')),
  place_id    INTEGER NOT NULL REFERENCES place_info(place_id) ON DELETE RESTRICT,
  -- v2: config.json 이 갖고 있던 나머지. kind 가 없으면 드라이버를 만들 수 없다.
  timeout_ms  INTEGER NOT NULL DEFAULT 5000,
  kind        TEXT    NOT NULL DEFAULT 'hucoms' CHECK (kind IN ('hucoms', 'backend-core', 'park3d-rpc', 'idis')),
  -- park3d-rpc 전용 1-based 카메라 번호. **cam_id 와 다른 값이다**(그쪽은 우리 통번).
  park3d_cam_id INTEGER,
  -- v5: idis 전용. 이 기기 **하나에** 한해 TLS 인증서 검증을 끈다(공장 자체서명 인증서 대응).
  -- 프로세스 전역 NODE_TLS_REJECT_UNAUTHORIZED 는 서비스 전체의 검증을 끄므로 답이 아니다.
  insecure_tls INTEGER NOT NULL DEFAULT 0 CHECK (insecure_tls IN (0, 1)),
  -- 실측 줌→화각 곡선 JSON: {"zoomHfov":[{"z":0,"h":57.14}, …]}. 없으면 브리지 박스줌이 꺼진다.
  intrinsics  TEXT    CHECK (intrinsics IS NULL OR json_valid(intrinsics))
);
CREATE INDEX IF NOT EXISTS idx_camera_place ON camera_info(place_id);

-- 3. 프리셋 정보 -------------------------------------------------------------
-- preset_id 는 **카메라 안에서** 1부터 센다(slot_setup 이 cam_id 와 함께 가리키므로).
-- id 는 문서의 '순서' — 삽입 순서를 잃지 않기 위한 대리키다.
CREATE TABLE IF NOT EXISTS preset_info (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id   INTEGER NOT NULL,
  preset_name TEXT    NOT NULL,
  cam_id      INTEGER NOT NULL REFERENCES camera_info(cam_id) ON DELETE CASCADE,
  pos_pan     INTEGER NOT NULL DEFAULT 0,
  pos_tilt    INTEGER NOT NULL DEFAULT 0,
  pos_zoom    INTEGER NOT NULL DEFAULT 0,
  place_id    INTEGER NOT NULL REFERENCES place_info(place_id) ON DELETE RESTRICT,
  UNIQUE (cam_id, preset_id)
);
CREATE INDEX IF NOT EXISTS idx_preset_cam ON preset_info(cam_id);

-- 5. 센터라이징 산출 (전체 슬롯 갯수만큼) --------------------------------------
-- 커미셔닝의 정본이다. 문서 1번(floor_ROI)은 이 표에서 뽑는다.
CREATE TABLE IF NOT EXISTS slot_setup (
  slot_id             INTEGER PRIMARY KEY,
  cam_id              INTEGER NOT NULL,
  preset_id           INTEGER NOT NULL,
  preset_slotidx      INTEGER NOT NULL,
  -- 와이드 구도에서 사람이 찍은 픽셀(1920×1080). 호밍이 여기서 출발한다.
  marked_x            INTEGER,
  marked_y            INTEGER,
  slot_roi            TEXT    CHECK (slot_roi            IS NULL OR json_valid(slot_roi)),
  slot3d_front_center TEXT    CHECK (slot3d_front_center IS NULL OR json_valid(slot3d_front_center)),
  vpd_bbox            TEXT    CHECK (vpd_bbox            IS NULL OR json_valid(vpd_bbox)),
  lpd_obb             TEXT    CHECK (lpd_obb             IS NULL OR json_valid(lpd_obb)),
  -- 번호판 중심으로 센터라이징·줌인한 결과. 아직 안 잡았으면 NULL 이다 — 0 으로 채우면
  -- "원점을 보고 있다"는 거짓말이 되고, 덜 끝난 슬롯을 골라낼 수 없다.
  ptz_pan             INTEGER,
  ptz_tilt            INTEGER,
  ptz_zoom            INTEGER,
  img1                TEXT,
  updated_at          TEXT    NOT NULL,
  UNIQUE (cam_id, preset_id, preset_slotidx),
  FOREIGN KEY (cam_id, preset_id) REFERENCES preset_info(cam_id, preset_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_slot_preset ON slot_setup(cam_id, preset_id);

-- 1. floor_ROI — 최종 셋업 산출용 뷰 ------------------------------------------
CREATE VIEW IF NOT EXISTS floor_ROI AS
SELECT
  slot_id,
  cam_id,
  preset_id,
  preset_slotidx,
  slot_roi,
  CASE WHEN ptz_pan IS NULL THEN NULL
       ELSE json_array(ptz_pan, ptz_tilt, ptz_zoom) END AS pos
FROM slot_setup;

-- 7. 현재 주차면 상태 (전체 슬롯 갯수만큼) -------------------------------------
CREATE TABLE IF NOT EXISTS parking_slot (
  slot_id     INTEGER PRIMARY KEY REFERENCES slot_setup(slot_id) ON DELETE CASCADE,
  is_occupy   INTEGER NOT NULL DEFAULT 0 CHECK (is_occupy IN (0, 1)),
  update_time TEXT    NOT NULL,
  plate_num   TEXT,
  img1        TEXT,
  img2        TEXT
);

-- 6. 입·출차 이벤트 이력 -------------------------------------------------------
-- 상태(7번)가 '지금'이라면 이쪽은 '언제 무엇이 있었나'다. 덮어쓰지 않고 쌓는다.
CREATE TABLE IF NOT EXISTS parking_evnt (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id     INTEGER NOT NULL REFERENCES slot_setup(slot_id) ON DELETE CASCADE,
  is_occupy   INTEGER NOT NULL CHECK (is_occupy IN (0, 1)),
  update_time TEXT    NOT NULL,
  plate_num   TEXT,
  img1        TEXT,
  img2        TEXT
);
CREATE INDEX IF NOT EXISTS idx_evnt_slot_time ON parking_evnt(slot_id, update_time);
`;
