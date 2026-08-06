import type { PtzRaw } from './ptz.js';

/**
 * 프리셋 도메인. **정본은 `preset_info` 표다**(2026-08-06) — 이 파일에는 저장 위치와 무관한
 * 이름 규칙만 남는다.
 *
 * 예전에는 여기에 목록을 통째로 받아 새 목록을 내는 순수 함수들(`listFor`·`addPreset`·
 * `updatePreset`·`removePreset`)이 있었다. 저장소가 JSON 파일 하나라 배열이 곧 전부였기
 * 때문이다. DB 로 옮기면서 그 배열이 사라졌고, 남겨 두면 **아무도 부르지 않는데 규칙만
 * 두 벌**이 된다(도메인 배열판 + 저장소 SQL판). 그래서 걷어내고 규칙 자체만 남겼다.
 */

export interface Preset {
  /** `preset_info.id`(대리키)의 문자열. 화면에는 불투명한 값이다. */
  id: string;
  /** `camera_info.cam_uuid`. 서비스가 쓰는 기기 id 다. */
  cameraId: string;
  name: string;
  ptz: PtzRaw;
}

export class PresetError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

/** 저장 전에 이름을 다듬고 검사한다. 빈 이름은 콤보박스에서 고를 수 없는 줄이 된다. */
export function normalizeName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new PresetError('프리셋 이름이 필요합니다');
  if (value.length > 60) throw new PresetError('프리셋 이름은 60자 이하여야 합니다');
  return value;
}
