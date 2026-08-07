import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

describe('주차면 탐색 영상 클릭 센터링 UI 계약', () => {
  it('고정 중앙 십자와 마지막 클릭 원을 영상 viewport에 둔다', async () => {
    const html = await source('../web/parking.html');
    expect(html).toContain('id="viewport"');
    expect(html).toContain('class="stream-center-cross"');
    expect(html).toContain('id="streamClickMarker"');
  });

  it('왼쪽 클릭은 구현과 무관하게 단일 코어 센터링 경로로 간다', async () => {
    const js = await source('../web/parkingDiscovery.js');
    expect(js).toContain("import { streamPointFromPointer } from './streamCentering.js';");
    expect(js).toContain('api.centerPoint(');
    // 화면이 구현을 고르던 흔적이 남아 있으면 안 된다.
    expect(js).not.toContain('useBackendCore');
    expect(js).not.toContain('independent-core');
  });

  /**
   * 클릭 센터링은 **탐색 탭에만** 있다. 껍데기는 활성 패널이 `onViewportClick` 을 내놓을
   * 때만 부르므로, 캘리브레이션 패널에 그 키가 없다는 것이 곧 "꺼져 있다"는 뜻이다 —
   * 플래그로 끄면 언젠가 켜지지만, 없는 것은 켜지지 않는다.
   */
  it('뷰포트 클릭은 활성 패널에게만 간다', async () => {
    const shell = await source('../web/parking.js');
    expect(shell).toContain("el('viewport').addEventListener('mousedown'");
    expect(shell).toContain('active?.panel.onViewportClick?.(event)');
    expect(await source('../web/parkingDiscovery.js')).toContain('onViewportClick:');
    // 키를 **내놓지 않는다**. 주석에 이름이 나오는 것은 상관없다 — 없는 것은 켜지지 않는다.
    expect(await source('../web/parkingCalibration.js')).not.toContain('onViewportClick:');
    expect(await source('../web/parkingVehicleBox.js')).not.toContain('onViewportClick:');
  });

  it('영상 위에 커서 십자를 강제하지 않는다', async () => {
    const css = await source('../web/app.css');
    expect(css).not.toContain('.viewport:has(img.live) { cursor: crosshair; }');
    expect(css).toContain('.stream-center-cross');
  });

  /**
   * 캘리브레이션은 **카메라 광학 곡선을 재는** 다른 일이고 20분간 카메라를 통째로 점유한다.
   * 탐색 화면에 함께 두면 탐색 작업 중에 실수로 스윕이 시작된다(2026-08-07 분리).
   */
  it('탐색 탭에 캘리브레이션 제어가 없다', async () => {
    const js = await source('../web/parkingDiscovery.js');
    expect(js).not.toContain('calibrationStart');
    expect(js).not.toContain('calibrationStop');
    expect(js).not.toContain('/api/core/calibration');
  });
});
