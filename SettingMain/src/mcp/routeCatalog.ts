/**
 * SettingManager REST 계약의 **자기 설명적 카탈로그**.
 *
 * MCP 도구를 라우트마다 하나씩 등록하지 않고 카탈로그 + 범용 호출 두 개로 노출하기 위한 자료다
 * (형제 프로젝트 `SettingAgent/src/mcp/server.ts` 의 `setting_rpc` 와 같은 설계 —
 * 라우트가 늘어도 MCP 파일은 바뀌지 않는다).
 *
 * 두 플래그가 안전의 축이다.
 *   `mutating`    설정·저장소를 바꾼다 (되돌리려면 다시 써야 한다)
 *   `movesCamera` **카메라를 물리적으로 움직인다** — 호출자가 confirm 을 명시해야 한다
 *
 * 이 카탈로그가 실제 라우트와 어긋나지 않는지는 `test/routeCatalog.test.ts` 가 지킨다.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteCatalogEntry {
  method: HttpMethod;
  /** `:id` 자리표시자를 쓰는 경로 템플릿. */
  path: string;
  title: string;
  mutating: boolean;
  movesCamera: boolean;
  notes?: string;
}

export const ROUTE_CATALOG: readonly RouteCatalogEntry[] = [
  // --- 상태 ---------------------------------------------------------------
  { method: 'GET', path: '/api/health', title: '서비스 상태', mutating: false, movesCamera: false },

  // --- 설정·기기 -----------------------------------------------------------
  { method: 'GET', path: '/api/settings', title: '설정 조회 (비밀번호 제외)', mutating: false, movesCamera: false },
  {
    method: 'PUT', path: '/api/settings', title: '설정 저장', mutating: true, movesCamera: false,
    notes: 'core.provider 로 코어 구현(bridge·remote)을 바꾼다. 비밀번호는 빈 값이면 기존 유지.',
  },
  { method: 'GET', path: '/api/cameras', title: '카메라 목록', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/cameras', title: '기기 추가', mutating: true, movesCamera: false, notes: '{ id, kind?, controlUrl?, streamUrl?, ... }' },
  { method: 'POST', path: '/api/cameras/active', title: '활성 카메라 전환', mutating: true, movesCamera: false, notes: '{ id }' },
  { method: 'POST', path: '/api/cameras/:id/test', title: '연결 테스트 (저장 없음)', mutating: false, movesCamera: false, notes: '실패도 200 { ok:false, error } 로 온다.' },
  { method: 'DELETE', path: '/api/cameras/:id', title: '기기 삭제', mutating: true, movesCamera: false, notes: '그 기기의 프리셋도 함께 지운다. 마지막 1대는 409.' },

  // --- PTZ ----------------------------------------------------------------
  { method: 'GET', path: '/api/ptz', title: '현재 PTZ (raw + 도)', mutating: false, movesCamera: false },
  {
    method: 'POST', path: '/api/ptz/absolute', title: '절대 좌표 이동', mutating: false, movesCamera: true,
    notes: '{ cameraId?, pan, tilt, zoom, speed? } — 계약 좌표(raw). 응답의 limited[] 는 잘린 축이다.',
  },
  {
    method: 'POST', path: '/api/ptz/nudge', title: '상대 이동', mutating: false, movesCamera: true,
    notes: '{ cameraId?, axis: pan|tilt|zoom, delta } — delta 는 raw 눈금.',
  },

  // --- 코어 (구현 무관 단일 제어면) -----------------------------------------
  {
    method: 'GET', path: '/api/core/capabilities', title: '현재 코어가 할 수 있는 것', mutating: false, movesCamera: false,
    notes: '★ 코어 작업 전에 먼저 확인하라. 지원하지 않는 능력은 501 로 거절되며 사유가 실린다.',
  },
  {
    method: 'POST', path: '/api/core/center', title: '클릭 지점을 화면 중앙으로', mutating: false, movesCamera: true,
    notes: '{ cameraId?, x, y } — 1920×1080 논리 프레임 정수.',
  },
  { method: 'POST', path: '/api/core/center-box', title: '영역 센터+줌', mutating: false, movesCamera: true, notes: '{ startX, startY, endX, endY }' },
  { method: 'GET', path: '/api/core/discovery/presets', title: '탐색 프리셋 목록', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/core/discovery/presets', title: '탐색 프리셋 생성', mutating: true, movesCamera: false },
  { method: 'PUT', path: '/api/core/discovery/presets/:id', title: '탐색 프리셋 수정', mutating: true, movesCamera: false },
  { method: 'DELETE', path: '/api/core/discovery/presets/:id', title: '탐색 프리셋 삭제', mutating: true, movesCamera: false },
  { method: 'POST', path: '/api/core/discovery/presets/:id/goto', title: '탐색 프리셋으로 이동', mutating: false, movesCamera: true },
  { method: 'GET', path: '/api/core/discovery/presets/:id/points', title: '탐색 점 목록', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/core/discovery/presets/:id/points', title: '탐색 점 추가', mutating: true, movesCamera: false },
  { method: 'PUT', path: '/api/core/discovery/presets/:id/points/:pointId', title: '탐색 점 수정', mutating: true, movesCamera: false },
  { method: 'DELETE', path: '/api/core/discovery/presets/:id/points/:pointId', title: '탐색 점 삭제', mutating: true, movesCamera: false },
  {
    method: 'POST', path: '/api/core/calibration/start', title: '캘리브레이션 시작', mutating: true, movesCamera: true,
    notes: '{ mode: full|verify } — 카메라를 수십 분 점유할 수 있다. status 로 폴링한다.',
  },
  { method: 'GET', path: '/api/core/calibration/status', title: '캘리브레이션 상태', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/core/calibration/stop', title: '캘리브레이션 중단', mutating: false, movesCamera: false, notes: '실행 중이 아니어도 오류가 아니다.' },
  {
    method: 'POST', path: '/api/core/calibration/mint', title: '캘리브레이션 발행', mutating: true, movesCamera: false,
    notes: '방금 끝난 full 스윕을 프로파일 리비전으로 발행한다. { apply?, force? } — 게이트 미달이면 422 + 사유이고, force:true 로 넘기면 사유가 문서에 박힌다.',
  },
  {
    method: 'POST', path: '/api/core/plate-homing/start', title: '번호판 호밍 시작', mutating: true, movesCamera: true,
    notes: '{ presetId, pointIds? } — 점마다 카메라를 조준·줌인한다.',
  },
  { method: 'GET', path: '/api/core/plate-homing/status', title: '번호판 호밍 상태', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/core/plate-homing/stop', title: '번호판 호밍 중단', mutating: false, movesCamera: false },
  {
    method: 'GET', path: '/api/core/discovery/presets/:presetId/points/:pointId/home-trace',
    title: '번호판 호밍 과정 (스텝별 숫자·상자)', mutating: false, movesCamera: false,
    // 스텝 프레임(`/api/core/home-frame/...`)은 **일부러 싣지 않는다** — `image/jpeg` 라
    // `/api/stream` 과 같은 이유로 MCP 대화에 실을 수 없다. 여기 응답의 `frameUrl` 이
    // 그 주소를 알려 주므로, 필요하면 사람이 브라우저로 연다.
    notes: '아직 호밍하지 않은 점도 200 + 빈 스텝이다(오류가 아니다).',
  },

  // --- 카메라 프로파일 (발행본) --------------------------------------------------
  // 경로는 정규식으로 잡으므로 위 소스 스캔에 잡히지 않는다. 그래도 여기 적는다 —
  // 에이전트가 광학 곡선을 읽고 넣는 유일한 창구이고, 없으면 그 문이 없는 것과 같다.
  { method: 'GET', path: '/api/profiles/camera/:id', title: '프로파일 리비전·현재 적용본·드리프트', mutating: false, movesCamera: false },
  {
    method: 'GET', path: '/api/profiles/camera/:id/@:rev', title: '프로파일 고정 조회', mutating: false, movesCamera: false,
    notes: '리비전은 불변이라 이 조회는 영원히 같은 값을 답한다.',
  },
  {
    method: 'POST', path: '/api/profiles/camera/:id', title: '프로파일 발행(import)', mutating: true, movesCamera: false,
    notes: '{ optics: { zoomHfov[], centeringGain?[] }, apply?, force? } — 적용이 먼저, 발행이 나중이다. 손으로 넣은 곡선은 문서가 스스로 "재지 않았다"고 말한다.',
  },
  {
    method: 'POST', path: '/api/profiles/camera/:id/copy', title: '프로파일 복사', mutating: true, movesCamera: false,
    notes: '{ from, revision? } — **광학만** 옮긴다. 눈금(device 블록)은 대상 기기 것으로 새로 찍는다.',
  },
  {
    method: 'POST', path: '/api/profiles/camera/:id/apply', title: '프로파일 적용·되돌리기', mutating: true, movesCamera: false,
    notes: '{ revision? } — 다음 조준부터 이 곡선을 쓴다. 카메라를 지금 움직이지는 않는다.',
  },
  {
    method: 'DELETE', path: '/api/profiles/camera/:id', title: '프로파일 퇴역', mutating: true, movesCamera: false,
    notes: '파기가 아니라 .trash 로 이동이다. 런타임 적용본은 건드리지 않는다.',
  },

  {
    method: 'GET', path: '/api/core/vehicle-box/status', title: '3D 차량 박스 준비 상태', mutating: false, movesCamera: false,
    notes: '사이드카가 죽어 있어도 200 으로 사실을 답한다.',
  },
  {
    method: 'GET', path: '/api/core/vehicle-box/history', title: '3D 차량 박스 검출 이력', mutating: false, movesCamera: false,
    notes: '?limit= (기본 20, 최대 200). detections 는 사이드카 어휘 그대로다.',
  },
  {
    method: 'POST', path: '/api/core/vehicle-box', title: '지금 프레임의 차량 3D 육면체', mutating: false, movesCamera: false,
    notes: '본문 없음. 스냅샷은 서버가 뜬다. detections[] 는 추론 사이드카 어휘 그대로다.',
  },
  {
    method: 'GET', path: '/api/core/slots', title: '커미셔닝 주차면 목록', mutating: false, movesCamera: false,
    notes: '★ /api/slots(시뮬·로컬 목록)와 다른 것이다 — 사람이 확정해 저장한 조준해다.',
  },
  {
    method: 'POST', path: '/api/core/slots', title: '커미셔닝 주차면 저장', mutating: true, movesCamera: false,
    notes: '{ x, y, name?, box? } — 지금 자세를 그 주차면의 클로즈업으로 삼는다.',
  },
  { method: 'POST', path: '/api/core/slots/:id/goto', title: '주차면 조준해로 이동', mutating: false, movesCamera: true },
  { method: 'DELETE', path: '/api/core/slots/:id', title: '커미셔닝 주차면 삭제', mutating: true, movesCamera: false },

  // --- 로컬 프리셋 ---------------------------------------------------------
  { method: 'GET', path: '/api/presets', title: '로컬 프리셋 목록', mutating: false, movesCamera: false, notes: '장비 내장 프리셋과는 별개의 정본이다.' },
  { method: 'POST', path: '/api/presets', title: '로컬 프리셋 추가', mutating: true, movesCamera: false, notes: '{ name, ptz? } — ptz 생략 시 현재 자세를 저장한다.' },
  { method: 'PUT', path: '/api/presets/:id', title: '로컬 프리셋 수정', mutating: true, movesCamera: false },
  { method: 'DELETE', path: '/api/presets/:id', title: '로컬 프리셋 삭제', mutating: true, movesCamera: false },
  { method: 'POST', path: '/api/presets/:id/goto', title: '로컬 프리셋으로 이동', mutating: false, movesCamera: true },

  // --- 장비 내장 프리셋 -----------------------------------------------------
  { method: 'GET', path: '/api/device-preset-capability', title: '장비 프리셋 지원 여부', mutating: false, movesCamera: false },
  { method: 'GET', path: '/api/cameras/:id/device-presets', title: '장비 프리셋 목록', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/cameras/:id/device-presets/:number/go', title: '장비 프리셋 이동', mutating: false, movesCamera: true, notes: '{ mode: preset|coordinate }' },
  { method: 'POST', path: '/api/cameras/:id/device-presets/:number/sync-coordinate', title: '장비 프리셋 좌표 학습', mutating: true, movesCamera: true, notes: '본문은 빈 객체.' },

  // --- 커미셔닝 DB ----------------------------------------------------------
  {
    method: 'GET', path: '/api/db/tables', title: 'DB 테이블 목록 + 열', mutating: false, movesCamera: false,
    notes: '열 목록은 SQLite 가 답한 것이다(PRAGMA). timeColumn 이 null 이면 기간 검색을 쓸 수 없다.',
  },
  {
    method: 'POST', path: '/api/db/query', title: 'DB 테이블 조회', mutating: false, movesCamera: false,
    notes: '{ table, text?, textColumn?, from?, to?, conditions?, orderBy?, limit?, offset? } — 테이블·열·비교는 화이트리스트다.',
  },
  { method: 'GET', path: '/api/db/places', title: '장소 목록', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/db/places', title: '장소 추가·이름변경', mutating: true, movesCamera: false, notes: '{ place_id, place_name }' },
  { method: 'PUT', path: '/api/db/places/:id', title: '장소 이름 변경', mutating: true, movesCamera: false },
  { method: 'DELETE', path: '/api/db/places/:id', title: '장소 삭제', mutating: true, movesCamera: false, notes: '쓰는 카메라가 있으면 409.' },
  { method: 'GET', path: '/api/db/cameras', title: 'DB 카메라 목록 (분류)', mutating: false, movesCamera: false },
  {
    method: 'PUT', path: '/api/db/cameras/:id', title: 'DB 카메라 분류 수정', mutating: true, movesCamera: false,
    notes: 'cam_name·cam_type·place_id 만. **접속정보는 config.json 이 주인이다.**',
  },
  { method: 'DELETE', path: '/api/db/cameras/:id', title: 'DB 카메라 삭제', mutating: true, movesCamera: false, notes: '프리셋·주차면이 CASCADE 로 함께 사라진다.' },
  { method: 'GET', path: '/api/db/presets', title: 'DB 프리셋 목록', mutating: false, movesCamera: false, notes: '?cam_id= 로 좁힌다.' },
  { method: 'POST', path: '/api/db/presets', title: 'DB 프리셋 추가', mutating: true, movesCamera: false, notes: '{ cam_id, preset_name, pos{pan,tilt,zoom}, place_id? }' },
  { method: 'PUT', path: '/api/db/presets/:camId/:presetId', title: 'DB 프리셋 수정', mutating: true, movesCamera: false, notes: '본문에 cam_id·preset_id 를 주면 그 자리로 옮긴다 — 주차면도 함께 간다(movedSlots 로 답한다).' },
  { method: 'DELETE', path: '/api/db/presets/:camId/:presetId', title: 'DB 프리셋 삭제', mutating: true, movesCamera: false, notes: '그 안의 주차면이 함께 사라진다(removedSlots 로 답한다).' },

  // --- API 계층 (VPD·LPD·LPR) -----------------------------------------------
  {
    method: 'GET', path: '/api/detectors', title: '검출기 설정 상태', mutating: false, movesCamera: false,
    notes: 'configured=주소가 채워졌는가 · implemented=이 저장소에 구현이 있는가. LPR 은 implemented:false 다.',
  },
  {
    method: 'POST', path: '/api/detectors/:name/detect', title: '스냅샷 1장을 검출기로', mutating: false, movesCamera: false,
    notes: '이미지를 보내지 않는다 — 대상 카메라의 스냅샷을 서버가 찍어 보낸다. 미설정·미구현은 501.',
  },

  // --- 주차면·영상 ---------------------------------------------------------
  { method: 'GET', path: '/api/slots', title: '주차면 목록', mutating: false, movesCamera: false, notes: 'source 가 simulator 인지 local 인지 함께 온다.' },
  { method: 'GET', path: '/api/snapshot', title: '스냅샷 1장 (image/jpeg)', mutating: false, movesCamera: false, notes: 'MCP 로는 바이너리를 싣지 않는다 — 크기만 답한다.' },

  // --- 시뮬레이터 툴 (언리얼 Park3D RPC 경유) --------------------------------
  //
  // **카메라·DB 와 무관한 평면이다.** 여기서 움직이는 것은 시뮬레이터 안의 카메라이고,
  // 이 서비스가 관리하는 실기기가 아니다.
  {
    method: 'GET', path: '/api/sim/catalog', title: '시뮬레이터가 허용하는 메서드 목록', mutating: false, movesCamera: false,
    notes: '이 목록 밖 메서드는 프록시가 400 으로 거절한다. 시뮬레이터 자신이 무엇을 갖고 있는지는 system.catalog 로 따로 묻는다.',
  },
  {
    method: 'GET', path: '/api/sim/car-catalog', title: '차량 프리팹 이름 (prefabId 순)', mutating: false, movesCamera: false,
    notes: '정본은 config/car_catalog.json — 배열 순서가 곧 prefabId(1부터)다. 시뮬레이터 RPC 는 이 목록을 주지 않는다.',
  },
  {
    method: 'GET', path: '/api/sim/files/:kind', title: '시뮬레이터 저장 파일 목록', mutating: false, movesCamera: false,
    notes: 'kind = preset | car | camera. save/3D/{Preset,CarPos,CameraPos} 를 읽는다. 폴더가 없으면 빈 목록이다(오류가 아니다).',
  },
  {
    method: 'GET', path: '/api/sim/files/:kind/:name', title: '저장 파일 내용', mutating: false, movesCamera: false,
    notes: '★ 좌표를 RPC 계(언리얼 Z-up)로 바꿔서 준다 — 파일은 Unity(Y-up)다. RPC(x,y,z) = 파일(z,x,y).',
  },
  {
    method: 'POST', path: '/api/sim/files/:kind/parse', title: '올린 파일 내용 해석', mutating: false, movesCamera: false,
    notes: '{ name, data } — 저장 폴더의 파일과 **같은 해석기·같은 좌표 변환**을 태운다. 디스크를 쓰지 않는다.',
  },
  {
    method: 'POST', path: '/api/sim/files/preset/serialize', title: '주차면 프리셋을 파일 모양으로', mutating: false, movesCamera: false,
    notes: '{ presets } — 저장용. 좌표를 Unity 계로 되돌리고 키 이름도 파일 것(offsetPos)으로 쓴다. 디스크를 쓰지 않는다.',
  },
  {
    // **한 경로에 80가지 행위가 들어 있다.** 실제 행위는 본문의 `method` 가 정하므로
    // 이 항목 하나로는 안전한 것과 위험한 것을 가를 수 없다. 그래서 가장 위험한 쪽에
    // 맞춰 표시한다 — `cam.setPTZ` 처럼 카메라를 실제로 돌리는 것이 목록에 있다.
    method: 'POST', path: '/api/sim/rpc', title: '시뮬레이터 RPC 호출', mutating: true, movesCamera: true,
    notes: '{ method, params } — 실제 행위는 method 가 정한다. 읽기(cam.list·map.get 등)도 이 경로로 가지만, 목록에 카메라를 움직이는 것이 섞여 있어 보수적으로 표시한다. 허용 목록은 GET /api/sim/catalog.',
  },
];

/** 경로 템플릿을 실제 경로에 맞춰 본다. `:이름` 은 슬래시 없는 한 조각과 맞는다. */
export function matchCatalog(method: string, pathname: string): RouteCatalogEntry | undefined {
  return ROUTE_CATALOG.find((entry) => {
    if (entry.method !== method) return false;
    const pattern = new RegExp(`^${entry.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, '[^/]+')}$`);
    return pattern.test(pathname);
  });
}
