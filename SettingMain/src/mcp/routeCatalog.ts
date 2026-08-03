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
    notes: 'core.provider 로 코어 구현(local·remote)을 바꾼다. 비밀번호는 빈 값이면 기존 유지.',
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
    method: 'POST', path: '/api/core/plate-homing/start', title: '번호판 호밍 시작', mutating: true, movesCamera: true,
    notes: '{ presetId, pointIds? } — 점마다 카메라를 조준·줌인한다.',
  },
  { method: 'GET', path: '/api/core/plate-homing/status', title: '번호판 호밍 상태', mutating: false, movesCamera: false },
  { method: 'POST', path: '/api/core/plate-homing/stop', title: '번호판 호밍 중단', mutating: false, movesCamera: false },

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

  // --- 주차면·영상 ---------------------------------------------------------
  { method: 'GET', path: '/api/slots', title: '주차면 목록', mutating: false, movesCamera: false, notes: 'source 가 simulator 인지 local 인지 함께 온다.' },
  { method: 'GET', path: '/api/snapshot', title: '스냅샷 1장 (image/jpeg)', mutating: false, movesCamera: false, notes: 'MCP 로는 바이너리를 싣지 않는다 — 크기만 답한다.' },
];

/** 경로 템플릿을 실제 경로에 맞춰 본다. `:이름` 은 슬래시 없는 한 조각과 맞는다. */
export function matchCatalog(method: string, pathname: string): RouteCatalogEntry | undefined {
  return ROUTE_CATALOG.find((entry) => {
    if (entry.method !== method) return false;
    const pattern = new RegExp(`^${entry.path.replace(/:[A-Za-z][A-Za-z0-9]*/g, '[^/]+')}$`);
    return pattern.test(pathname);
  });
}
