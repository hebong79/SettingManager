import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';

/**
 * 주차 상태·이벤트 저장소 (문서 6·7번).
 *
 * 문서가 *"셋팅에이전트 완성후 카메라 제어 Agent 에서 사용예정"* 이라 적어 둔 표다.
 * **읽고 쓰는 최소 표면만 만든다** — 아직 소비자가 없으므로 조회 조건이나 집계를 미리
 * 지어내지 않는다. 필요해지는 쪽이 무엇을 묻는지 보고 그때 늘린다.
 *
 * 두 표의 관계가 이 파일의 요점이다. `parking_slot` 은 **지금**(슬롯당 한 줄, 덮어쓴다),
 * `parking_evnt` 는 **언제 무엇이 있었나**(쌓는다). 상태만 두면 이력이 사라지고,
 * 이력만 두면 "지금 몇 대 있나"에 매번 전체를 훑어야 한다.
 */

export interface ParkingState {
  slot_id: number;
  /** 1 = 주차, 0 = 없음. */
  is_occupy: number;
  update_time: string;
  plate_num: string | null;
  /** 차량 이미지의 상대 경로. */
  img1: string | null;
  /** 번호판 크롭 이미지의 상대 경로. */
  img2: string | null;
}

export interface ParkingEvent extends ParkingState {
  event_id: number;
}

export interface ParkingUpdate {
  slot_id: number;
  is_occupy: boolean;
  plate_num?: string | null;
  img1?: string | null;
  img2?: string | null;
}

export interface ParkingRepositoryOptions {
  now?: () => string;
}

export class ParkingRepository {
  private readonly now: () => string;

  constructor(private readonly db: DatabaseSync, options: ParkingRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listStates(): ParkingState[] {
    return this.db.prepare('SELECT * FROM parking_slot ORDER BY slot_id').all() as unknown as ParkingState[];
  }

  getState(slotId: number): ParkingState | null {
    return (this.db.prepare('SELECT * FROM parking_slot WHERE slot_id = ?').get(slotId) as unknown as ParkingState) ?? null;
  }

  /**
   * 상태를 갱신하고 **같은 트랜잭션에서** 이력을 남긴다.
   *
   * 둘을 따로 부르게 두지 않는 이유: 하나만 성공하면 "지금은 비었는데 나간 기록이 없는"
   * 상태가 되고, 그 불일치는 나중에 어느 쪽이 맞는지 판단할 방법이 없다.
   */
  record(update: ParkingUpdate): { state: ParkingState; event: ParkingEvent } {
    return transaction(this.db, () => {
      const at = this.now();
      const occupy = update.is_occupy ? 1 : 0;
      const values = [occupy, at, update.plate_num ?? null, update.img1 ?? null, update.img2 ?? null] as const;

      this.db.prepare(`
        INSERT INTO parking_slot (slot_id, is_occupy, update_time, plate_num, img1, img2)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot_id) DO UPDATE SET
          is_occupy = excluded.is_occupy, update_time = excluded.update_time,
          plate_num = excluded.plate_num, img1 = excluded.img1, img2 = excluded.img2
      `).run(update.slot_id, ...values);

      this.db.prepare(`
        INSERT INTO parking_evnt (slot_id, is_occupy, update_time, plate_num, img1, img2)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(update.slot_id, ...values);

      const state = this.getState(update.slot_id);
      const event = this.db.prepare('SELECT * FROM parking_evnt WHERE slot_id = ? ORDER BY event_id DESC LIMIT 1')
        .get(update.slot_id) as unknown as ParkingEvent;
      return { state: state!, event };
    });
  }

  /** 한 슬롯의 이력. 최신이 먼저다. */
  listEvents(slotId: number, limit = 100): ParkingEvent[] {
    return this.db.prepare('SELECT * FROM parking_evnt WHERE slot_id = ? ORDER BY event_id DESC LIMIT ?')
      .all(slotId, limit) as unknown as ParkingEvent[];
  }

  /** 점유 집계. 화면이 "몇 면 중 몇 대"를 물을 때의 근거다. */
  occupancy(): { total: number; occupied: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_occupy), 0) AS occupied FROM parking_slot')
      .get() as { total: number; occupied: number };
    return { total: Number(row.total), occupied: Number(row.occupied) };
  }
}
