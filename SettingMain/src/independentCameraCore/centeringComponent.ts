import type { CameraDriver } from '../devices/cameraDriver.js';
import type { PtzRaw } from '../domain/ptz.js';
import { waitForSettle, type SettleOptions } from '../devices/waitForSettle.js';
import { CameraLeaseRegistry } from './cameraLease.js';

export interface CenterPoint { x: number; y: number; }
export interface CenteringResult { point: CenterPoint; ptz: PtzRaw; settled: boolean; }

/** BackendCore 없이 선택 카메라의 직접 driver만 사용하는 센터링 컴포넌트. */
export class CenteringComponent {
  constructor(private readonly leases: CameraLeaseRegistry, private readonly settleOptions?: SettleOptions) {}

  async center(cameraId: string, driver: CameraDriver, point: CenterPoint): Promise<CenteringResult> {
    if (!driver.centerPoint) throw new Error('현재 카메라는 영상 클릭 센터링을 지원하지 않습니다');
    const release = this.leases.acquire(cameraId);
    try {
      await driver.centerPoint(point);
      const settle = await waitForSettle(driver, this.settleOptions);
      return { point, ptz: settle.ptz, settled: settle.settled };
    } finally {
      release();
    }
  }
}
