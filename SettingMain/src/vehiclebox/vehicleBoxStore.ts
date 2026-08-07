import type { DatabaseSync } from 'node:sqlite';
import type { PtzRaw } from '../domain/ptz.js';

/**
 * 차량 3D 육면체 검출 이력.
 *
 * **상류에 없는 것이다** — baro_calory 는 검출을 던지고 잊는다. 커미셔닝에는 "그때 뭐가
 * 보였나"가 남아야 하므로 저장한다.
 *
 * ## 측정값은 사이드카 어휘 그대로 담는다
 *
 * `detections[]` 를 열로 펴지 않고 JSON 문자열로 둔다. 그 스키마는 우리 것이 아니라
 * 사이드카 것이고(`position_m`·`size_m`·`yaw_deg`·`segments`), 우리 취향으로 개명하면
 * 사이드카 로그·오프라인 도구와 대조가 안 되며 좌표계 규약이 두 벌이 된다.
 */

export interface VehicleBoxRecord {
  detectId: number;
  cameraId: string;
  capturedAt: string;
  ptz: PtzRaw | null;
  model: string | null;
  latencyMs: number | null;
  count: number;
  detections: unknown[];
  /** **반드시 함께 읽는다** — 무엇을 기준으로 잰 값인지가 곧 값의 의미다. */
  calibration: unknown;
}

export interface SaveDetectionInput {
  capturedAt: string;
  ptz: PtzRaw | null;
  model: string | null;
  latencyMs: number | null;
  detections: unknown[];
  calibration: unknown;
}

export class VehicleBoxStore {
  constructor(private readonly db: DatabaseSync, readonly cameraId: string) {}

  save(input: SaveDetectionInput): number | null {
    const camId = this.camId();
    // 등록되지 않은 기기의 검출은 **버린다**(카메라 줄을 지어내지 않는다). 검출 자체는
    // 이미 성공했으므로 던지지도 않는다 — 저장 실패가 측정 결과를 삼키면 안 된다.
    if (camId === null) return null;
    const info = this.db
      .prepare(`
        INSERT INTO vehicle_box (cam_id, captured_at, ptz_pan, ptz_tilt, ptz_zoom, model, latency_ms, box_count, detections, calibration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        camId,
        input.capturedAt,
        input.ptz?.pan ?? null,
        input.ptz?.tilt ?? null,
        input.ptz?.zoom ?? null,
        input.model,
        input.latencyMs,
        input.detections.length,
        JSON.stringify(input.detections),
        input.calibration === undefined || input.calibration === null ? null : JSON.stringify(input.calibration),
      );
    return Number(info.lastInsertRowid);
  }

  /** 최근 것부터. 화면이 "지난번엔 뭐가 보였나"를 되짚는 데 쓴다. */
  list(limit = 20): VehicleBoxRecord[] {
    const camId = this.camId();
    if (camId === null) return [];
    const rows = this.db
      .prepare('SELECT * FROM vehicle_box WHERE cam_id = ? ORDER BY detect_id DESC LIMIT ?')
      .all(camId, Math.min(Math.max(Math.round(limit), 1), 200)) as unknown as VehicleBoxRow[];
    return rows.map((row) => this.toRecord(row));
  }

  private camId(): number | null {
    const row = this.db.prepare('SELECT cam_id FROM camera_info WHERE cam_uuid = ?').get(this.cameraId) as { cam_id: number } | undefined;
    return row ? Number(row.cam_id) : null;
  }

  private toRecord(row: VehicleBoxRow): VehicleBoxRecord {
    return {
      detectId: row.detect_id,
      cameraId: this.cameraId,
      capturedAt: row.captured_at,
      ptz: row.ptz_pan === null ? null : { pan: row.ptz_pan, tilt: row.ptz_tilt ?? 0, zoom: row.ptz_zoom ?? 0 },
      model: row.model,
      latencyMs: row.latency_ms,
      count: row.box_count,
      detections: parseJson(row.detections, []) as unknown[],
      calibration: parseJson(row.calibration, null),
    };
  }
}

interface VehicleBoxRow {
  detect_id: number;
  cam_id: number;
  captured_at: string;
  ptz_pan: number | null;
  ptz_tilt: number | null;
  ptz_zoom: number | null;
  model: string | null;
  latency_ms: number | null;
  box_count: number;
  detections: string;
  calibration: string | null;
}

/** 깨진 JSON 은 빈 값으로 읽는다 — 이력 한 줄 때문에 목록 전체가 500 이 되면 안 된다. */
function parseJson(raw: string | null, fallback: unknown): unknown {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}
