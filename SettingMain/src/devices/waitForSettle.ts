import { DEFAULT_TOLERANCE, isSameSpot, type SettleTolerance } from '../domain/settle.js';
import type { PtzRaw } from '../domain/ptz.js';
import type { CameraDriver } from './cameraDriver.js';

export interface SettleOptions {
  pollMs?: number;
  timeoutMs?: number;
  tolerance?: SettleTolerance;
  /** 테스트에서 시간을 흐르게 하지 않기 위한 주입 지점. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SettleResult {
  ptz: PtzRaw;
  /** 멈춘 것을 확인했는가. false 면 상한까지 기다렸는데도 계속 움직이고 있었다는 뜻이다. */
  settled: boolean;
  elapsedMs: number;
  reads: number;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 이동이 멈출 때까지 기다린 뒤 최종 좌표를 돌려준다.
 *
 * 상한을 넘겨도 **던지지 않는다** — 마지막으로 읽은 좌표는 여전히 쓸모 있는 정보이고,
 * 여기서 던지면 화면이 "어디에 있는지조차" 못 보여준다. 대신 `settled: false` 로 알린다.
 */
export async function waitForSettle(driver: CameraDriver, options: SettleOptions = {}): Promise<SettleResult> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  const started = now();
  let previous = await driver.getPtz();
  let reads = 1;

  for (;;) {
    if (now() - started >= timeoutMs) {
      return { ptz: previous, settled: false, elapsedMs: now() - started, reads };
    }
    await sleep(pollMs);
    const current = await driver.getPtz();
    reads += 1;
    if (isSameSpot(previous, current, tolerance)) {
      return { ptz: current, settled: true, elapsedMs: now() - started, reads };
    }
    previous = current;
  }
}
