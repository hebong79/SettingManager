export class CameraLeaseError extends Error {
  constructor(readonly cameraId: string) {
    super(`카메라 ${cameraId}에서 다른 독립 작업이 진행 중입니다`);
  }
}

/** 카메라별 독립 작업 점유. 서로 다른 cameraId는 절대 막지 않는다. */
export class CameraLeaseRegistry {
  private readonly owners = new Set<string>();

  acquire(cameraId: string): () => void {
    if (this.owners.has(cameraId)) throw new CameraLeaseError(cameraId);
    this.owners.add(cameraId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.owners.delete(cameraId);
    };
  }

  isBusy(cameraId: string): boolean {
    return this.owners.has(cameraId);
  }
}
