import type { AppConfig } from '../config/types.js';
import { DetectorUnsupportedError, type DetectorClient, type DetectorName } from './detectorTypes.js';
import { LpdClient } from './lpdClient.js';
import { VpdClient } from './vpdClient.js';

/**
 * **검출기 분기가 있는 유일한 지점.** 라우트에는 `if (name === 'vpd')` 가 없다.
 * `core/providerFactory.ts` 와 같은 규약이다.
 */

/**
 * 이 검출기를 **지금 부를 수 없는 이유**. 부를 수 있으면 `undefined`.
 *
 * 판정이 여기 한 곳에 있는 이유: 상태 조회(`GET /api/detectors`)와 실제 호출이 서로 다른
 * 기준을 쓰면, 화면은 "쓸 수 있다"고 그려 놓고 누르면 501 이 나는 상태가 된다.
 */
export function detectorUnavailableReason(name: DetectorName, config: AppConfig): string | undefined {
  if (name === 'lpr') {
    // `Sub/` 아래에 대응 서비스가 없다. VPD·LPD 를 본떠 경로를 지어내면 컴파일도 되고 테스트도
    // 그 상상대로 통과하지만, 실제 서비스가 생기는 날 계약이 어긋나 있어도 아무도 알아채지 못한다.
    return 'LPR 검출기는 아직 이 저장소에 구현이 없습니다 — 대응 서비스의 경로·응답이 확정되면 붙입니다';
  }
  if (!config.detectors[name].baseUrl) {
    return `${name.toUpperCase()} 검출기가 설정되지 않았습니다 — config.json 의 detectors.${name}.baseUrl 을 채우세요`;
  }
  return undefined;
}

export function createDetector(name: DetectorName, config: AppConfig, fetchImpl?: typeof fetch): DetectorClient {
  const reason = detectorUnavailableReason(name, config);
  // 빈 주소로 나가면 어디로 갔는지 알 수 없는 실패가 된다. 나가기 전에 확정 답으로 막는다.
  if (reason) throw new DetectorUnsupportedError(name, reason);

  const endpoint = config.detectors[name];
  const options = { baseUrl: endpoint.baseUrl, timeoutMs: endpoint.timeoutMs, fetchImpl };
  return name === 'vpd' ? new VpdClient(options) : new LpdClient(options);
}
