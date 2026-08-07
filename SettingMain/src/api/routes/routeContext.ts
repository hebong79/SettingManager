import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { CameraDriver } from '../../devices/cameraDriver.js';
import { createDriver, findCamera } from '../../devices/driverFactory.js';
import type { HucomsPresetClient } from '../../devices/hucoms/hucomsPresetClient.js';
import type { SettleOptions } from '../../devices/waitForSettle.js';
import type { ConfigStore } from '../../config/configStore.js';
import type { ProfileStore } from '../../profiles/profileStore.js';
import type { AppConfig, CameraConfig } from '../../config/types.js';
import { clampPtz, type PtzRaw } from '../../domain/ptz.js';
import type { DevicePresetRegistryStore } from '../../store/devicePresetRegistryStore.js';
import type { PresetStore } from '../../store/presetStore.js';
import type { SlotStore } from '../../store/slotStore.js';
import { HttpError, requireNumber } from '../httpUtil.js';

/** 서버 조립에 필요한 것 전부. 라우트 모듈은 이것만 보고 동작한다. */
export interface ServerDeps {
  configStore: ConfigStore;
  presetStore: PresetStore;
  slotStore: SlotStore;
  devicePresetRegistryStore: DevicePresetRegistryStore;
  /** 테스트에서 외부 HTTP 를 가로채기 위한 주입 지점. */
  fetchImpl?: typeof fetch;
  /** 정착 대기 파라미터. 테스트가 실제 시간을 흘려보내지 않도록 주입한다. */
  settleOptions?: SettleOptions;
  /** 장비 capability 직접 조회의 테스트 주입 지점. production에서는 native HTTP adapter를 쓴다. */
  directPresetClientFactory?: (camera: CameraConfig) => DirectPresetClient;
  /**
   * 커미셔닝 산출 DB(SQLite). 브리지 코어의 탐색 프리셋·점·주차면이 여기 산다.
   * 주지 않으면 그 능력들이 꺼진 채로 뜬다 — 서버는 DB 없이도 기동한다.
   */
  db?: DatabaseSync;
  /**
   * 발행본 저장소. 주지 않으면 서버가 DB 를 물려 기본값을 만든다 —
   * 테스트가 임시 폴더를 쓰기 위한 주입 지점이다(발행이 저장소 루트에 파일을 남긴다).
   */
  profiles?: ProfileStore;
}

export type DirectPresetClient =
  Pick<HucomsPresetClient, 'getCapability'> & Partial<Pick<HucomsPresetClient, 'goPreset' | 'getPtz' | 'goPtz'>>;

/** 요청 1건의 실행 맥락. 라우트 모듈이 요청을 해석하는 데 필요한 것만 담는다. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  deps: ServerDeps;
  pathname: string;
  method: string;
  searchParams: URLSearchParams;
  /** 대상 카메라와 그 드라이버를 조립한다. cameraId 생략 시 질의 파라미터 → 활성 기기 순으로 찾는다. */
  driverFor(cameraId?: string): { camera: CameraConfig; config: AppConfig; driver: CameraDriver };
}

/**
 * 라우트 처리 결과.
 * `true` 는 "내가 응답했다", `false` 는 "내 소관이 아니다 — 다음으로 넘겨라"다.
 * 소관이 아닌 것을 404 로 답해 버리면 뒤의 라우트가 영원히 닿지 못한다.
 */
export type RouteHandler = (ctx: RouteContext) => Promise<boolean>;

export function createRouteContext(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, url: URL): RouteContext {
  return {
    req,
    res,
    deps,
    pathname: url.pathname,
    method: req.method ?? 'GET',
    searchParams: url.searchParams,
    driverFor(cameraId?: string) {
      const config = deps.configStore.get();
      const camera = findCamera(config, cameraId ?? url.searchParams.get('cameraId') ?? undefined);
      return { camera, config, driver: createDriver(camera, config, deps.fetchImpl) };
    },
  };
}

// --- 여러 라우트가 함께 쓰는 본문 해석 -------------------------------------------

export function asId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readPtz(body: Record<string, unknown>): PtzRaw | undefined {
  const raw = body.ptz;
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const values = [p.pan, p.tilt, p.zoom].map(Number);
  if (!values.every(Number.isFinite)) throw new HttpError(400, 'ptz 는 pan·tilt·zoom 숫자를 가져야 합니다');
  return clampPtz({ pan: values[0]!, tilt: values[1]!, zoom: values[2]! });
}

/** 센터링 좌표는 Hucoms 논리 프레임(1920×1080) 안의 정수여야 한다. */
export function requireCenterCoordinate(body: Record<string, unknown>, key: string, maximum: number): number {
  const value = requireNumber(body, key);
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new HttpError(400, `${key} 는 0..${maximum} 정수여야 합니다`);
  return value;
}
