import type { CameraDriver } from '../clients/cameraDriver.js';
import type { SettleOptions } from '../clients/waitForSettle.js';
import { CameraLeaseRegistry } from './cameraLease.js';
import { CenteringComponent, type CenterPoint, type CenteringResult } from './centeringComponent.js';

export interface IndependentCameraCoreCapability {
  cameraId: string;
  center: boolean;
  calibration: false;
  plateHoming: false;
  busy: boolean;
}

/** SettingMain 내부의 카메라별 독립 제어 진입점. Remote BackendCore를 호출하지 않는다. */
export class IndependentCameraCore {
  private readonly leases = new CameraLeaseRegistry();
  private readonly centering: CenteringComponent;

  constructor(settleOptions?: SettleOptions) {
    this.centering = new CenteringComponent(this.leases, settleOptions);
  }

  capability(cameraId: string, driver: CameraDriver): IndependentCameraCoreCapability {
    return { cameraId, center: Boolean(driver.centerPoint), calibration: false, plateHoming: false, busy: this.leases.isBusy(cameraId) };
  }

  center(cameraId: string, driver: CameraDriver, point: CenterPoint): Promise<CenteringResult> {
    return this.centering.center(cameraId, driver, point);
  }
}
