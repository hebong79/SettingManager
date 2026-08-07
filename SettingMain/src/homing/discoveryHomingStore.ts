import type { DiscoveryDbStore } from '../db/discoveryDbStore.js';
import type { HomingPreset, HomingStorePort } from './plateHomingJob.js';

/**
 * 탐색 저장소(`DiscoveryDbStore`)를 호밍 잡이 요구하는 좁은 표면으로 감싼다.
 *
 * **잡이 저장소 전체를 보지 않게 하는 것**이 목적이다. 잡에 저장소를 통째로 넘기면
 * 프리셋을 지우거나 점을 옮기는 것도 할 수 있게 되고, 그러면 "호밍이 무엇을 건드리는가"에
 * 답하려면 잡 전체를 읽어야 한다. 여기서는 **읽기 하나·쓰기 하나**가 전부다.
 */
export function homingStoreFor(store: DiscoveryDbStore): HomingStorePort {
  return {
    async getPreset(presetId) {
      const preset = await store.getPreset(presetId);
      if (!preset) return null;
      return {
        id: preset.id,
        name: preset.name,
        ptz: { panpos: preset.ptz.panpos, tiltpos: preset.ptz.tiltpos, zoompos: preset.ptz.zoompos },
        points: (preset.points ?? []).map((point) => ({ id: point.id, name: point.name, x: point.x, y: point.y })),
      } satisfies HomingPreset;
    },
    async saveAim(presetId, pointId, aim) {
      await store.saveAim(presetId, pointId, aim);
    },
  };
}
