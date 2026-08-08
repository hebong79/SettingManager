import { describe, expect, it } from 'vitest';
import {
  WIDE_HFOV_DEG, halfExtent, poseFrom, projectToScreen, screenToGround,
  type CameraPose,
} from '../src/sim/simProject.js';

/**
 * 카메라 기하 계약. 숫자는 **2026-08-08 실측**에서 왔다 — 192.168.0.125 의 언리얼
 * 시뮬레이터 1번 카메라에 직접 물어보고, 찍은 영상으로 확인했다.
 *
 * 이 파일이 지키는 것은 "식이 예쁘다"가 아니라 **그날 잰 값이 그대로 나오는가**다.
 * 화각 상수나 부호를 누가 "정리"하면 여기서 걸린다.
 */

const VIEW = { width: 1280, height: 720 };

/** 실측 당시의 1번 카메라. */
const CAM: CameraPose = { pos: { x: -36.3, y: -13.6, z: 13.5 }, pan: 47.1, tilt: 30.4, zoom: 2.4 };

const hfov = (zoom: number) => (2 * Math.atan(halfExtent(zoom, VIEW).tanH) * 180) / Math.PI;
const vfov = (zoom: number) => (2 * Math.atan(halfExtent(zoom, VIEW).tanV) * 180) / Math.PI;

describe('화각 — 실측', () => {
  it('줌 1배 가로 화각은 56.5° 다', () => {
    // cam.setFOV(45·30·20°) 를 넣고 cam.getPTZ 로 읽은 줌 세 점이 모두 이 값을 준다.
    expect(WIDE_HFOV_DEG).toBe(56.5);
    expect(hfov(1)).toBeCloseTo(56.5, 6);
  });

  it('줌이 커지면 화각은 tan 역수로 좁아진다 — setFOV↔getPTZ 왕복 실측', () => {
    // 넣은 FOV → 읽힌 줌. 이 관계가 곧 zoom = tan(H₁/2)/tan(F/2) 다.
    for (const [fov, zoom] of [[45, 1.29720], [30, 2.00530], [20, 3.04729]] as const) {
      expect(hfov(zoom)).toBeCloseTo(fov, 2);
    }
  });

  it('세로 화각은 영상으로 잰 값과 맞는다 (tilt 2° 이동 → 픽셀 이동량)', () => {
    // 실측: zoom 2.4 에서 100px/720, zoom 6.0 에서 250px/720.
    expect(vfov(2.4)).toBeCloseTo(14.33, 1);
    expect(vfov(6.0)).toBeCloseTo(5.76, 1);
  });

  it('세로가 아니라 가로가 기준이다 — 반대였다면 줌 2.4 에서 25.2° 가 나왔어야 한다', () => {
    expect(vfov(2.4)).toBeLessThan(20);
  });

  it('줌이 0 이나 음수로 와도 화각이 무한대가 되지 않는다', () => {
    expect(hfov(0)).toBeCloseTo(56.5, 6);
    expect(hfov(-3)).toBeCloseTo(56.5, 6);
  });
});

describe('월드 → 화면', () => {
  it('겨누고 있는 점은 화면 정중앙이다', () => {
    // 실측: 차량 63-16.48.26 (pos -19.32, 6.05, 0) 을 pan 49.168 · tilt 27.469 로 조준했더니
    // 줌 10배(화각 6.2°)에서 십자가 그 차 위에 꽂혔다.
    const pose: CameraPose = { ...CAM, pan: 49.168, tilt: 27.469, zoom: 10 };
    const screen = projectToScreen(pose, VIEW, { x: -19.32, y: 6.05, z: 0 });
    expect(screen).not.toBeNull();
    expect(screen!.x).toBeCloseTo(VIEW.width / 2, 0);
    expect(screen!.y).toBeCloseTo(VIEW.height / 2, 0);
  });

  it('pan 보다 방위각이 큰 점은 화면 **왼쪽**이다', () => {
    // 실측: pan 을 +3° 돌렸더니 영상 내용이 오른쪽으로 132px 갔다. 곧 pan 을 키워야
    // 중앙에 오는 대상은 그전에 왼쪽에 있었다는 뜻이다. 이 부호를 뒤집으면 클릭이
    // 좌우 반대인 차를 고르는데, 붐비는 주차장에서는 그것이 그럴듯해 보인다.
    const pose: CameraPose = { pos: { x: 0, y: 0, z: 10 }, pan: 0, tilt: 45, zoom: 1 };
    const screen = projectToScreen(pose, VIEW, { x: 10 * Math.cos(0.1745), y: 10 * Math.sin(0.1745), z: 0 });
    expect(screen!.x).toBeLessThan(VIEW.width / 2);
  });

  it('tilt 는 양수가 하향 — 더 먼 점일수록 화면 위쪽이다', () => {
    const pose: CameraPose = { pos: { x: 0, y: 0, z: 10 }, pan: 0, tilt: 45, zoom: 1 };
    const near = projectToScreen(pose, VIEW, { x: 10, y: 0, z: 0 })!;
    const far = projectToScreen(pose, VIEW, { x: 14, y: 0, z: 0 })!;
    expect(far.y).toBeLessThan(near.y);
  });

  it('카메라 뒤쪽 점은 null 이다 — 억지로 투영하면 반대편에 그럴듯한 값이 찍힌다', () => {
    const pose: CameraPose = { pos: { x: 0, y: 0, z: 10 }, pan: 0, tilt: 0, zoom: 1 };
    expect(projectToScreen(pose, VIEW, { x: -50, y: 0, z: 10 })).toBeNull();
  });
});

describe('화면 → 지면', () => {
  it('정중앙 클릭은 카메라가 보고 있는 지면 점이다', () => {
    const pose: CameraPose = { pos: { x: 0, y: 0, z: 10 }, pan: 0, tilt: 45, zoom: 1 };
    const ground = screenToGround(pose, VIEW, { x: VIEW.width / 2, y: VIEW.height / 2 });
    // 높이 10, 부각 45° → 앞으로 정확히 10.
    expect(ground!.x).toBeCloseTo(10, 6);
    expect(ground!.y).toBeCloseTo(0, 6);
    expect(ground!.z).toBe(0);
  });

  it('왕복한다 — 지면 점을 다시 투영하면 같은 픽셀이다', () => {
    for (const point of [
      { x: 120, y: 90 }, { x: 1100, y: 640 }, { x: 640, y: 700 }, { x: 5, y: 500 },
    ]) {
      const ground = screenToGround(CAM, VIEW, point);
      expect(ground, `${point.x},${point.y}`).not.toBeNull();
      const back = projectToScreen(CAM, VIEW, ground!);
      expect(back!.x).toBeCloseTo(point.x, 6);
      expect(back!.y).toBeCloseTo(point.y, 6);
    }
  });

  it('지면 높이를 올리면 카메라 쪽으로 당겨진다', () => {
    const at0 = screenToGround(CAM, VIEW, { x: 640, y: 400 }, 0)!;
    const at2 = screenToGround(CAM, VIEW, { x: 640, y: 400 }, 2)!;
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - CAM.pos.x, p.y - CAM.pos.y);
    expect(far(at2)).toBeLessThan(far(at0));
    expect(at2.z).toBe(2);
  });

  it('하늘을 찍으면 null 이다 — 지면과 만나지 않는다', () => {
    const pose: CameraPose = { pos: { x: 0, y: 0, z: 10 }, pan: 0, tilt: -20, zoom: 1 };
    expect(screenToGround(pose, VIEW, { x: 640, y: 10 })).toBeNull();
  });

  it('카메라가 이미 지면 아래면 null 이다', () => {
    const pose: CameraPose = { pos: { x: 0, y: 0, z: 1 }, pan: 0, tilt: 45, zoom: 1 };
    expect(screenToGround(pose, VIEW, { x: 640, y: 360 }, 5)).toBeNull();
  });
});

describe('cam.get 읽기', () => {
  it('실제 응답 모양을 읽는다', () => {
    const pose = poseFrom({
      camId: 1, name: 'Camera-1',
      pos: { x: -36.29999923706055, y: -13.600000381469727, z: 13.5 },
      pan: 47.099998474121094, tilt: 30.399999618530273, zoom: 2.4000000953674316,
    });
    expect(pose!.pos.z).toBeCloseTo(13.5, 6);
    expect(pose!.pan).toBeCloseTo(47.1, 5);
  });

  it('자리가 비면 null 이다 — 0 으로 채우면 카메라가 원점에 있는 셈이 된다', () => {
    expect(poseFrom({ pos: { x: 1, y: 2 }, pan: 0, tilt: 0, zoom: 1 })).toBeNull();
    expect(poseFrom({ pos: { x: 1, y: 2, z: 3 }, pan: 0, tilt: 0 })).toBeNull();
    expect(poseFrom(null)).toBeNull();
  });
});
