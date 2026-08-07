/**
 * 시뮬레이터 툴이 부를 수 있는 **언리얼 Park3D RPC 메서드 목록**.
 *
 * 근거: 라이브 실측 `POST 192.168.0.125:13510/rpc {method:"system.catalog"}` (2026-08-07).
 * 그 서버에 등록된 80개 중, 이 화면이 실제로 쓰는 것만 여기 있다.
 *
 * ## 왜 목록이 필요한가
 *
 * 프록시가 아무 메서드나 통과시키면 `/api/sim/rpc` 는 **임의 요청 통로**가 된다.
 * MCP 서버가 카탈로그 밖 경로를 거절하는 것과 같은 판단이다 — 통로를 여는 순간
 * "이 서비스가 시뮬레이터에 무엇을 할 수 있는가"에 답할 곳이 사라진다.
 *
 * ## `movesCamera` 는 무엇인가
 *
 * 시뮬레이터 카메라를 실제로 돌리는 호출이다. 지금 화면은 사람이 누르는 것이라
 * 막지 않지만, 목록에 표시해 두면 나중에 자동화가 붙을 때 게이트를 걸 자리가 있다.
 *
 * ## ⚠ `system.catalog` 로는 알 수 없는 것 — **등록 ≠ 동작**
 *
 * 서버가 등록한 82개 중 **10개는 호출하면 실패한다**(`-32000` 또는 `FailDomain`).
 * 카탈로그는 등록 여부만 알려주므로 그 둘을 구분하지 못한다 —
 * 근거: `docs/reference/unreal/20260807_173431_Park3D_RPC_메서드_목록.md` §10.
 *
 * 그래서 여기 `implemented: false` 를 둔다. **클라이언트가 서버를 두드리기 전에 501 로
 * 거절하고 사유를 말한다** — 눌러 보고 나서 `-32000 미구현` 을 읽는 것보다 낫고,
 * 화면이 그 버튼을 아예 꺼 둘 수 있다.
 *
 * ## 여기 없는 것
 *
 * - `light.*` · `view.*` · `file.list` — **그 서버에 아직 없다**(실측 `-32601`).
 *   설계서 §5.3 의 신설 대상이며, 생기면 여기 한 줄씩 더한다.
 * - `preset.clear` · `car.deleteAll` 같은 전체 삭제는 **있다.** 화면이 확인을 받고 부른다.
 */

export interface SimMethod {
  method: string;
  title: string;
  /** 시뮬레이터의 상태를 바꾸는가(읽기가 아닌가). */
  mutating: boolean;
  /** 시뮬레이터 카메라를 실제로 움직이는가. */
  movesCamera: boolean;
  /**
   * **등록돼 있지만 호출하면 실패한다.** 없으면 동작하는 것으로 본다.
   * 값이 있으면 그 문자열이 곧 사유이며, 클라이언트가 501 로 그대로 돌려준다.
   */
  unimplemented?: string;
}

export const SIM_CATALOG: readonly SimMethod[] = [
  // --- system --------------------------------------------------------------
  { method: 'system.ping', title: '연결 확인', mutating: false, movesCamera: false },
  { method: 'system.health', title: '서버 상태', mutating: false, movesCamera: false },
  { method: 'system.catalog', title: '등록된 메서드 목록', mutating: false, movesCamera: false },

  // --- cam / 카메라 컨트롤 ---------------------------------------------------
  { method: 'cam.list', title: '카메라 목록', mutating: false, movesCamera: false },
  { method: 'cam.get', title: '카메라 조회', mutating: false, movesCamera: false },
  { method: 'cam.select', title: '카메라 선택', mutating: true, movesCamera: false },
  { method: 'cam.create', title: '카메라 추가', mutating: true, movesCamera: false },
  { method: 'cam.delete', title: '카메라 삭제', mutating: true, movesCamera: false },
  { method: 'cam.getPTZ', title: 'PTZ 조회', mutating: false, movesCamera: false },
  { method: 'cam.setPTZ', title: 'PTZ 이동', mutating: true, movesCamera: true },
  { method: 'cam.setPan', title: 'Pan 이동', mutating: true, movesCamera: true },
  { method: 'cam.setTilt', title: 'Tilt 이동', mutating: true, movesCamera: true },
  { method: 'cam.setZoom', title: 'Zoom 이동', mutating: true, movesCamera: true },
  { method: 'cam.setFOV', title: '화각 설정', mutating: true, movesCamera: true },
  { method: 'cam.setPosition', title: '카메라 위치(X·Y)', mutating: true, movesCamera: true },
  { method: 'cam.setHeight', title: '카메라 높이(Z)', mutating: true, movesCamera: true },
  { method: 'cam.savePreset', title: '카메라 프리셋 저장', mutating: true, movesCamera: false, unimplemented: '시뮬레이터에 per-camera 프리셋 메모리가 없습니다' },
  { method: 'cam.loadPreset', title: '카메라 프리셋 열기', mutating: true, movesCamera: false, unimplemented: '시뮬레이터에 per-camera 프리셋 메모리가 없습니다' },
  { method: 'cam.applyPreset', title: '카메라 프리셋 적용', mutating: true, movesCamera: true, unimplemented: '시뮬레이터에 per-camera 프리셋 메모리가 없습니다 — 「웹 프리셋 이동이 PTZ 만 바꾸는」 현상의 직접 원인입니다' },
  { method: 'cam.streamStatus', title: '스트림 채널 상태', mutating: false, movesCamera: false },
  { method: 'cam.pinStream', title: '스트림 슬롯 고정', mutating: true, movesCamera: false },
  { method: 'cam.setStreamSlots', title: '스트림 슬롯 수 변경', mutating: true, movesCamera: false },

  // --- measure / 거리 측정툴 -------------------------------------------------
  { method: 'measure.setTargetPoint', title: '타겟점 설치', mutating: true, movesCamera: false },
  { method: 'measure.distance', title: '거리 측정', mutating: false, movesCamera: false },
  { method: 'measure.angles', title: '각도 측정', mutating: false, movesCamera: false },
  { method: 'measure.cameraHeight', title: '카메라 높이 측정', mutating: false, movesCamera: false },
  { method: 'measure.targetLine', title: '타겟라인 각도', mutating: false, movesCamera: false },

  // --- preset / 프리셋 메이커 (주차면 그룹) -----------------------------------
  { method: 'preset.list', title: '주차면 프리셋 목록', mutating: false, movesCamera: false },
  { method: 'preset.get', title: '주차면 프리셋 조회', mutating: false, movesCamera: false },
  { method: 'preset.create', title: '주차면 프리셋 생성', mutating: true, movesCamera: false },
  { method: 'preset.update', title: '주차면 프리셋 수정', mutating: true, movesCamera: false },
  { method: 'preset.delete', title: '주차면 프리셋 삭제', mutating: true, movesCamera: false },
  { method: 'preset.clear', title: '주차면 프리셋 전체 삭제', mutating: true, movesCamera: false },
  { method: 'preset.select', title: '주차면 프리셋 선택', mutating: true, movesCamera: false },
  { method: 'preset.move', title: '주차면 프리셋 이동', mutating: true, movesCamera: false },
  { method: 'preset.rotate', title: '주차면 프리셋 회전', mutating: true, movesCamera: false },
  { method: 'preset.groupMove', title: '주차면 그룹 이동', mutating: true, movesCamera: false },
  { method: 'preset.groupRotate', title: '주차면 그룹 회전', mutating: true, movesCamera: false },
  { method: 'preset.setSize', title: '주차면 크기', mutating: true, movesCamera: false },
  { method: 'preset.setDirType', title: '주차면 방향 타입', mutating: true, movesCamera: false },
  { method: 'preset.setBoxVisible', title: '3D 육면체 표시', mutating: true, movesCamera: false, unimplemented: '면 단위 큐브 가시성을 지원하지 않습니다 — 전역 3D 는 preset.rebuildAll {showQubeBox} 를 쓰세요' },
  { method: 'preset.renumber', title: '주차면 번호 재계산', mutating: true, movesCamera: false },
  { method: 'preset.rebuildAll', title: '전체 재빌드', mutating: true, movesCamera: false },
  { method: 'preset.save', title: '주차면 프리셋 저장', mutating: true, movesCamera: false },
  { method: 'preset.load', title: '주차면 프리셋 열기', mutating: true, movesCamera: false },

  // --- car / 차량 배치툴 -----------------------------------------------------
  { method: 'car.list', title: '차량 목록', mutating: false, movesCamera: false },
  { method: 'car.get', title: '차량 조회', mutating: false, movesCamera: false },
  { method: 'car.select', title: '차량 선택', mutating: true, movesCamera: false },
  { method: 'car.create', title: '차량 배치', mutating: true, movesCamera: false },
  { method: 'car.createLine', title: '차량 줄 자동배치', mutating: true, movesCamera: false },
  { method: 'car.delete', title: '차량 삭제', mutating: true, movesCamera: false },
  { method: 'car.deleteAll', title: '차량 전체 삭제', mutating: true, movesCamera: false },
  { method: 'car.setPosition', title: '차량 위치', mutating: true, movesCamera: false },
  { method: 'car.setRotationY', title: '차량 회전', mutating: true, movesCamera: false },
  { method: 'car.groupMove', title: '차량 그룹 이동', mutating: true, movesCamera: false },
  { method: 'car.groupRotate', title: '차량 그룹 회전', mutating: true, movesCamera: false },
  { method: 'car.setColor', title: '차량 색상', mutating: true, movesCamera: false },
  { method: 'car.setRandomColor', title: '차량 색상 랜덤', mutating: true, movesCamera: false },
  { method: 'car.setMetallic', title: '차량 재질', mutating: true, movesCamera: false, unimplemented: '시뮬레이터 포트에 metallic 도색 파라미터가 없습니다' },
  { method: 'car.resetColor', title: '차량 색상 초기화', mutating: true, movesCamera: false },
  { method: 'car.resetRandom', title: '랜덤 리셋(색상/객체/개수)', mutating: true, movesCamera: false },
  { method: 'car.show', title: '차량 표시/숨김', mutating: true, movesCamera: false },
  { method: 'car.hideRandom', title: '차량 랜덤 숨김', mutating: true, movesCamera: false },
  { method: 'car.save', title: '차량 배치 저장', mutating: true, movesCamera: false },
  { method: 'car.load', title: '차량 배치 열기', mutating: true, movesCamera: false },
  { method: 'car.clear', title: '차량 배치 초기화', mutating: true, movesCamera: false },

  // --- random / 차량 랜덤 배치 -----------------------------------------------
  { method: 'random.randomizeAll', title: '전체 랜덤화', mutating: true, movesCamera: false, unimplemented: '슬롯/앰비언트 통합 랜덤 백엔드가 없습니다 — car.resetRandom 을 쓰세요' },
  { method: 'random.recreateCars', title: '차량 재생성', mutating: true, movesCamera: false },
  { method: 'random.slotJitter', title: '주차 위치 흔들기', mutating: true, movesCamera: false, unimplemented: '슬롯 지터 백엔드가 없습니다' },
  { method: 'random.frontBack', title: '전/후면 주차 랜덤', mutating: true, movesCamera: false, unimplemented: '전/후면 지터 백엔드가 없습니다' },
  { method: 'random.hideNoise', title: '일부 숨김', mutating: true, movesCamera: false },
  { method: 'random.pickCount', title: '랜덤 대수 뽑기', mutating: false, movesCamera: false },
  { method: 'random.slotPlace', title: '슬롯 배치', mutating: true, movesCamera: false, unimplemented: '주차면 슬롯(CFaceRect) 백엔드가 없습니다 — car.create 반복으로 우회합니다' },
  { method: 'random.placeInView', title: 'PTZ 뷰 안에 배치', mutating: true, movesCamera: false, unimplemented: 'PTZ 뷰포트 배치 백엔드가 없습니다' },

  // --- map -------------------------------------------------------------------
  { method: 'map.get', title: '맵 크기 조회', mutating: false, movesCamera: false },
  { method: 'map.resize', title: '맵 크기 변경', mutating: true, movesCamera: false },
  { method: 'map.save', title: '맵 저장', mutating: true, movesCamera: false },
  { method: 'map.load', title: '맵 열기', mutating: true, movesCamera: false },
] as const;

const BY_NAME = new Map(SIM_CATALOG.map((entry) => [entry.method, entry]));

export function findSimMethod(method: string): SimMethod | undefined {
  return BY_NAME.get(method);
}

/** 등록은 돼 있으나 호출하면 실패하는 것들. 화면이 그 버튼을 꺼 두는 근거다. */
export const UNIMPLEMENTED = SIM_CATALOG.filter((entry) => entry.unimplemented);
