import type { DatabaseSync } from 'node:sqlite';
import type { ConfigStore } from '../config/configStore.js';
import type { CameraIntrinsics } from '../config/types.js';
import { ProfileError, type IntrinsicsSink } from './profileStore.js';

/**
 * 런타임 적용본을 쓰는 곳 — 이 저장소에서는 **DB(`camera_info.intrinsics`)** 다.
 *
 * 상류는 `config.json` 의 `devices[].intrinsics` 를 쓰지만, 이 서비스는 카메라 정본이 DB 다.
 * **자리가 다를 뿐 규칙은 같다**: 발행본이 정본이고, 이쪽은 이 프로세스가 실제로 물고 도는 값이다.
 *
 * ## `reloadCameras()` 를 반드시 부른다
 *
 * DB 를 고쳐도 메모리의 `config.cameras` 는 옛 값이다(`configStore.ts` 가 이것을
 * *"이 설계의 유일한 함정"* 이라고 적어 두었다). 안 부르면 **방금 발행한 게인이 다음 조준에
 * 반영되지 않고**, 화면은 "발행 완료"를 보고 있으므로 아무도 그것을 눈치채지 못한다.
 */
export class DbIntrinsicsSink implements IntrinsicsSink {
  constructor(private readonly db: DatabaseSync, private readonly configStore: ConfigStore) {}

  apply(cameraId: string, intrinsics: CameraIntrinsics): void {
    const changed = Number(
      this.db
        .prepare('UPDATE camera_info SET intrinsics = ? WHERE cam_uuid = ?')
        .run(JSON.stringify(intrinsics), cameraId).changes,
    );
    // 등록되지 않은 기기에 적용을 시도한 것이다. 조용히 0줄 갱신으로 넘기면 "적용됐다"고
    // 보고한 뒤 아무 일도 일어나지 않는다 — 발행본만 남고 런타임은 영영 옛 값이 된다.
    if (changed === 0) {
      throw new ProfileError(`기기 ${cameraId} 가 DB(camera_info)에 없습니다 — 등록되지 않은 기기에는 프로파일을 적용할 수 없습니다`, 404);
    }
    this.configStore.reloadCameras();
  }
}
