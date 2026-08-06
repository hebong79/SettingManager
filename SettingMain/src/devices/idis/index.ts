/**
 * IDIS 서브트리의 **공개 표면**. 바깥(`driverFactory.ts` 등)은 이 배럴만 본다 —
 * 다른 파일을 직접 import 하지 않는 것이 규약이다.
 */

export { IdisCameraClient, type IdisCapabilities, type IdisClientOptions, type IdisPreset } from './idisCamera.js';
export { buildBasicHeader, buildDigestHeader } from './digest.js';
export {
  panToContract,
  panToWire,
  pointToWire,
  ptzToContract,
  ptzToWire,
  tiltToContract,
  tiltToWire,
  zoomToContract,
  zoomToWire,
} from './idisCoords.js';
export { classifyReply, parseQueryReply, IdisAuthError, IdisUnknownActionError, type ReplyClass } from './idisReply.js';
export { IdisTransportError, isTransportError } from './idisTransport.js';
export { ACTION, ACTION_CATALOG, MODE, MOVE_COMMANDS, RETURN_CODE, WIRE_RANGE } from './idisConstants.js';
