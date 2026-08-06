import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/api/server.js';
import { ConfigStore } from '../src/config/configStore.js';
import { PresetStore } from '../src/store/presetStore.js';
import { SlotStore } from '../src/store/slotStore.js';
import { DevicePresetRegistryStore } from '../src/store/devicePresetRegistryStore.js';
import { openDatabase } from '../src/db/database.js';
import { SetupRepository } from '../src/db/setupRepository.js';

/**
 * 옵션의 DB 탭과 테이블 뷰어가 쓰는 라우트.
 *
 * 여기서 지키는 것은 넷이다.
 *   ① config 의 `place_id` 가 카메라를 DB 에 심을 때 따라간다
 *   ② **카메라의 정본은 DB 다** — 고치면 메모리의 config.cameras 도 함께 갱신된다(reloadCameras)
 *   ③ 뷰어 질의는 **화이트리스트 밖 이름을 절대 SQL 에 붙이지 않는다**
 *   ④ 지우면 사라지는 것을 미리 말한다(장소는 막고, 프리셋은 개수를 답한다)
 */

let dir: string;
let server: Server;
let base: string;
let db: DatabaseSync;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'settingmanager-dbroutes-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    server: { host: '127.0.0.1', port: 0 },
    simulator: { baseUrl: 'http://127.0.0.1:8080' },
    activeCameraId: 'cam-a',
    cameras: [
      { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/s1', timeoutMs: 2000, place_id: 7 },
      { id: 'sim-1', label: '시뮬 1', kind: 'park3d-rpc', controlUrl: 'http://10.0.0.2:13510', username: '', password: '', streamUrl: '', timeoutMs: 2000, camId: 1 },
    ],
  }));

  db = openDatabase({ path: ':memory:' });
  const configStore = new ConfigStore(join(dir, 'config.json'), db);
  await configStore.load();
  const presetStore = new PresetStore(join(dir, 'presets.json'));
  await presetStore.load();
  const slotStore = new SlotStore(join(dir, 'slots.json'));
  await slotStore.load();
  const registry = new DevicePresetRegistryStore(join(dir, 'r.json'));
  await registry.load();

  server = createServer({ configStore, presetStore, slotStore, devicePresetRegistryStore: registry, db });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('config → DB 1회 이관 · DB 가 정본', () => {
  it('config 의 place_id 가 따라가고, 없으면 1 이다', async () => {
    const { body } = await api('/api/db/cameras');
    expect(body.cameras.map((c: any) => [c.cam_uuid, c.place_id])).toEqual([['cam-a', 7], ['sim-1', 1]]);
  });

  it('config 에만 있던 장소를 만들어 둔다 — 없는 장소를 가리키면 카메라가 아예 못 들어간다', async () => {
    const { body } = await api('/api/db/places');
    expect(body.places.map((p: any) => p.place_id).sort()).toEqual([1, 7]);
  });

  it('비밀번호는 DB 응답에도 실리지 않는다', async () => {
    const { body } = await api('/api/db/cameras');
    expect(body.cameras[0]).not.toHaveProperty('password');
    expect(body.cameras[0].hasPassword).toBe(true);
  });

  it('config 의 cameras 는 이관 뒤 파일에서 사라진다 — 정본이 둘이 되지 않는다', async () => {
    const raw = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('cameras');
    // 되돌릴 자리가 남아 있어야 한다 — config.json 은 git 에 없다.
    const backup = JSON.parse(await readFile(join(dir, 'config.json.bak-cameras'), 'utf8')) as { cameras: unknown[] };
    expect(backup.cameras).toHaveLength(2);
  });

  it('접속 정보까지 DB 가 주인이다 — 카메라를 고치면 다음 요청이 새 주소로 간다', async () => {
    const camId = (await api('/api/db/cameras')).body.cameras[0].cam_id;
    await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ url: 'http://10.9.9.9:80' }) });

    // 메모리의 config.cameras 가 함께 갱신돼야 한다(reloadCameras). 안 되면 옛 주소로 나간다.
    const { body } = await api('/api/cameras');
    expect(body.cameras.find((c: any) => c.id === 'cam-a').controlUrl).toBe('http://10.9.9.9:80');
  });

  it('비밀번호를 비워 보내면 기존 값이 유지된다', async () => {
    const camId = (await api('/api/db/cameras')).body.cameras[0].cam_id;
    await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ password: '', cam_name: '이름만' }) });
    const after = (await api('/api/db/cameras')).body.cameras.find((c: any) => c.cam_id === camId);
    expect(after).toMatchObject({ cam_name: '이름만', hasPassword: true });
  });

  it('kind·timeout_ms·park3d_cam_id·intrinsics 도 DB 가 들고 있다', async () => {
    const sim = (await api('/api/db/cameras')).body.cameras.find((c: any) => c.cam_uuid === 'sim-1');
    expect(sim).toMatchObject({ kind: 'park3d-rpc', timeout_ms: 2000, park3d_cam_id: 1 });
  });

  it('분류는 고쳐도 남는다 — 다시 로드해도 되돌아가지 않는다', async () => {
    const camId = (await api('/api/db/cameras')).body.cameras[0].cam_id;
    await api('/api/db/places', { method: 'POST', body: JSON.stringify({ place_id: 9, place_name: '별관' }) });
    await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ place_id: 9, cam_type: 'static' }) });

    // 기동을 한 번 더 한 셈. config 에는 이미 카메라가 없으므로 이관도 돌지 않는다.
    const reloaded = new ConfigStore(join(dir, 'config.json'), db);
    await reloaded.load();

    const after = (await api('/api/db/cameras')).body.cameras.find((c: any) => c.cam_id === camId);
    expect(after).toMatchObject({ place_id: 9, cam_type: 'static' });
  });

  /**
   * v4 — 제조사(`cam_company`)를 열째 지웠다(마스터 결정 2026-08-06). 공개 응답의 **키 집합이
   * 줄었다**는 계약을 여기서 못박는다. `publicCamera()` 는 `{ password, ...rest }` 라 스스로
   * 따라가지만, 누가 라우트에서 그 키를 되살려도 `toMatchObject` 계열 단언은 잡지 못한다 —
   * 여분 키를 문제 삼지 않기 때문이다. 그래서 `not.toHaveProperty` 로 본다.
   */
  it('공개 응답에 cam_company 키가 없다 — GET·PUT 양쪽', async () => {
    const { body } = await api('/api/db/cameras');
    expect(body.cameras).toHaveLength(2);
    for (const row of body.cameras as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('cam_company');
    }

    const camId = body.cameras[0].cam_id;
    const put = await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ cam_name: '이름만' }) });
    expect(put.status).toBe(200);
    expect(put.body.camera).not.toHaveProperty('cam_company');
  });

  it('POST 본문에 cam_company 가 와도 조용히 무시한다 — 400 이 아니다(계획 확인필요 B)', async () => {
    const { status, body } = await api('/api/db/cameras', {
      method: 'POST',
      body: JSON.stringify({ cam_uuid: 'cam-new', label: '새 기기', kind: 'hucoms', controlUrl: 'http://10.0.0.5:80', cam_company: '아이디스' }),
    });
    expect(status).toBe(200);
    expect(body.camera).toMatchObject({ cam_uuid: 'cam-new', kind: 'hucoms' });
    expect(body.camera).not.toHaveProperty('cam_company');
    // DB 에도 남지 않는다 — 라우트가 무시했을 뿐 어딘가에 실려 들어가지 않았다.
    expect(new SetupRepository(db).getCameraByUuid('cam-new')).not.toHaveProperty('cam_company');
  });
});

describe('DB 탭 CRUD', () => {
  it('장소를 추가·이름변경·삭제한다', async () => {
    expect((await api('/api/db/places', { method: 'POST', body: JSON.stringify({ place_id: 3, place_name: '지하' }) })).status).toBe(200);
    await api('/api/db/places/3', { method: 'PUT', body: JSON.stringify({ place_name: '지하 1층' }) });
    expect((await api('/api/db/places')).body.places.find((p: any) => p.place_id === 3).place_name).toBe('지하 1층');
    expect((await api('/api/db/places/3', { method: 'DELETE' })).status).toBe(200);
  });

  it('쓰는 카메라가 있는 장소는 409 로 막고 누가 쓰는지 말한다', async () => {
    const { status, body } = await api('/api/db/places/7', { method: 'DELETE' });
    expect(status).toBe(409);
    expect(body.error).toMatch(/cam-a/);
  });

  it('프리셋을 추가하면 preset_id 가 카메라 안에서 1부터 붙는다', async () => {
    const first = await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '입구', pos: { pan: 4200, tilt: 900, zoom: 3000 } }) });
    expect(first.body.preset).toMatchObject({ cam_id: 1, preset_id: 1, preset_name: '입구', pos_pan: 4200 });
    const second = await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '출구', pos: { pan: 0, tilt: 0, zoom: 0 } }) });
    expect(second.body.preset.preset_id).toBe(2);
    // 다른 카메라는 다시 1부터다.
    const other = await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 2, preset_name: '시뮬', pos: { pan: 0, tilt: 0, zoom: 0 } }) });
    expect(other.body.preset.preset_id).toBe(1);
  });

  it('프리셋 삭제는 함께 사라질 주차면 개수를 답한다', async () => {
    await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '입구', pos: { pan: 0, tilt: 0, zoom: 0 } }) });
    const repo = new SetupRepository(db);
    repo.upsertSlot({ slot_id: 1, cam_id: 1, preset_id: 1, preset_slotidx: 1 });
    repo.upsertSlot({ slot_id: 2, cam_id: 1, preset_id: 1, preset_slotidx: 2 });

    const { body } = await api('/api/db/presets/1/1', { method: 'DELETE' });
    expect(body).toMatchObject({ removedSlots: 2, changed: true });
    expect(repo.listSlots()).toEqual([]);
  });

  /**
   * 비밀번호의 세 갈래. "안 건드림"과 "지움"이 갈라져 있어야 하는 이유가 여기 다 있다 —
   * 빈 문자열 하나로 둘을 겸하면 이름만 고친 저장이 자격증명을 지운다.
   */
  describe('비밀번호는 지울 수 있다', () => {
    const camId = 1;
    const hasPassword = async (): Promise<boolean> =>
      (await api('/api/db/cameras')).body.cameras.find((c: any) => c.cam_id === camId).hasPassword;

    it('null 을 명시로 보내면 지워진다', async () => {
      expect(await hasPassword()).toBe(true);
      const { status } = await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ password: null }) });
      expect(status).toBe(200);
      expect(await hasPassword()).toBe(false);
      // DB 에도 빈 값으로 남는다 — NOT NULL 이라 NULL 이 아니라 ''.
      expect(new SetupRepository(db).listCameras().find((c) => c.cam_id === camId)!.password).toBe('');
    });

    it('빈 문자열·미전송은 여전히 기존 값을 지킨다', async () => {
      await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ password: '' }) });
      expect(await hasPassword()).toBe(true);
      await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ cam_name: '이름만 변경' }) });
      expect(await hasPassword()).toBe(true);
    });

    it('지운 뒤 다시 넣을 수 있다', async () => {
      await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ password: null }) });
      await api(`/api/db/cameras/${camId}`, { method: 'PUT', body: JSON.stringify({ password: 'new-secret' }) });
      expect(await hasPassword()).toBe(true);
      expect(new SetupRepository(db).listCameras().find((c) => c.cam_id === camId)!.password).toBe('new-secret');
    });
  });

  /** 프리셋의 열쇠를 옮기는 일. 주차면이 `(cam_id, preset_id)` 로 이 줄을 가리키므로 함께 간다. */
  describe('프리셋의 preset_id·cam_id 를 고칠 수 있다', () => {
    let repo: SetupRepository;

    beforeEach(async () => {
      repo = new SetupRepository(db);
      await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '입구', pos: { pan: 10, tilt: 20, zoom: 30 } }) });
      repo.upsertSlot({ slot_id: 1, cam_id: 1, preset_id: 1, preset_slotidx: 1, marked: { x: 100, y: 200 } });
      repo.upsertSlot({ slot_id: 2, cam_id: 1, preset_id: 1, preset_slotidx: 2 });
    });

    it('preset_id 를 바꾸면 주차면도 함께 옮겨진다', async () => {
      const { status, body } = await api('/api/db/presets/1/1', { method: 'PUT', body: JSON.stringify({ preset_id: 5 }) });
      expect(status).toBe(200);
      expect(body).toMatchObject({ movedSlots: 2 });
      expect(body.preset).toMatchObject({ cam_id: 1, preset_id: 5, preset_name: '입구', pos_pan: 10 });
      expect(repo.getPreset(1, 1)).toBeNull();
      expect(repo.listSlots().map((s) => [s.slot_id, s.cam_id, s.preset_id])).toEqual([[1, 1, 5], [2, 1, 5]]);
      // 옮긴 것이지 새로 만든 것이 아니다 — 측정값이 그대로 남아 있다.
      expect(repo.getSlot(1)).toMatchObject({ marked_x: 100, marked_y: 200 });
    });

    it('cam_id 를 바꾸면 다른 카메라로 옮겨진다', async () => {
      const { body } = await api('/api/db/presets/1/1', { method: 'PUT', body: JSON.stringify({ cam_id: 2 }) });
      expect(body.preset).toMatchObject({ cam_id: 2, preset_id: 1 });
      expect(repo.listSlots().every((s) => s.cam_id === 2)).toBe(true);
    });

    it('열쇠와 이름을 한 번에 고칠 수 있다', async () => {
      const { body } = await api('/api/db/presets/1/1', { method: 'PUT', body: JSON.stringify({ cam_id: 2, preset_id: 3, preset_name: '옮긴 프리셋' }) });
      expect(body.preset).toMatchObject({ cam_id: 2, preset_id: 3, preset_name: '옮긴 프리셋', pos_pan: 10 });
      expect(repo.listSlots().map((s) => [s.cam_id, s.preset_id])).toEqual([[2, 3], [2, 3]]);
    });

    it('이미 쓰는 번호로는 옮길 수 없다 — 409, 그리고 아무것도 바뀌지 않는다', async () => {
      await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '출구', pos: { pan: 0, tilt: 0, zoom: 0 } }) });
      const { status, body } = await api('/api/db/presets/1/1', { method: 'PUT', body: JSON.stringify({ preset_id: 2, preset_name: '바뀌면 안 됨' }) });
      expect(status).toBe(409);
      expect(body.error).toMatch(/이미 있는 프리셋/);
      expect(repo.getPreset(1, 1)).toMatchObject({ preset_name: '입구' });
      expect(repo.getPreset(1, 2)).toMatchObject({ preset_name: '출구' });
      expect(repo.listSlots().every((s) => s.preset_id === 1)).toBe(true);
    });

    it('없는 카메라로는 옮길 수 없다 — 400', async () => {
      const { status, body } = await api('/api/db/presets/1/1', { method: 'PUT', body: JSON.stringify({ cam_id: 99 }) });
      expect(status).toBe(400);
      expect(body.error).toMatch(/등록되지 않은 카메라/);
      expect(repo.getPreset(1, 1)).not.toBeNull();
    });

    it('같은 번호를 다시 보내면 이동이 아니다 — 이름만 바뀐다', async () => {
      const { body } = await api('/api/db/presets/1/1', { method: 'PUT', body: JSON.stringify({ cam_id: 1, preset_id: 1, preset_name: '제자리' }) });
      expect(body).toMatchObject({ movedSlots: 0 });
      expect(body.preset).toMatchObject({ preset_name: '제자리' });
    });
  });

  it('없는 프리셋·카메라 수정은 404 다', async () => {
    expect((await api('/api/db/presets/1/99', { method: 'PUT', body: JSON.stringify({ preset_name: 'x' }) })).status).toBe(404);
    expect((await api('/api/db/cameras/99', { method: 'PUT', body: JSON.stringify({ cam_name: 'x' }) })).status).toBe(404);
  });

  it('pos 에 숫자가 아닌 값을 주면 400 이다', async () => {
    const { status } = await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: 'x', pos: { pan: 'abc', tilt: 0, zoom: 0 } }) });
    expect(status).toBe(400);
  });
});

describe('테이블 뷰어', () => {
  beforeEach(async () => {
    await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '입구 와이드', pos: { pan: 4200, tilt: 900, zoom: 3000 } }) });
    await api('/api/db/presets', { method: 'POST', body: JSON.stringify({ cam_id: 1, preset_name: '출구', pos: { pan: 100, tilt: 0, zoom: 12000 } }) });
  });

  it('테이블 목록과 열은 SQLite 가 답한 것이다 — 화면이 지어내지 않는다', async () => {
    const { body } = await api('/api/db/tables');
    expect(body.tables.map((t: any) => t.name)).toEqual([
      'place_info', 'camera_info', 'preset_info', 'slot_setup', 'floor_ROI', 'parking_slot', 'parking_evnt',
    ]);
    const preset = body.tables.find((t: any) => t.name === 'preset_info');
    expect(preset.columns).toContain('preset_name');
    expect(preset.timeColumn).toBeNull();     // 시간 열이 없다 → 기간 검색 불가
    expect(preset.readOnly).toBe(false);
    expect(body.tables.find((t: any) => t.name === 'floor_ROI').readOnly).toBe(true);
  });

  it('텍스트는 모든 열을 훑고 부분 일치다', async () => {
    const { body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', text: '와이드' }) });
    expect(body.total).toBe(1);
    expect(body.rows[0].preset_name).toBe('입구 와이드');
  });

  it('숫자 열도 텍스트로 훑는다 — 사람은 열 종류를 생각하지 않는다', async () => {
    const { body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', text: '12000' }) });
    expect(body.rows.map((r: any) => r.preset_name)).toEqual(['출구']);
  });

  it('열을 지정하면 그 열만 본다', async () => {
    const { body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', text: '12000', textColumn: 'preset_name' }) });
    expect(body.total).toBe(0);
  });

  it('조건 검색이 된다', async () => {
    const { body } = await api('/api/db/query', {
      method: 'POST',
      body: JSON.stringify({ table: 'preset_info', conditions: [{ column: 'pos_zoom', op: '>=', value: 10000 }] }),
    });
    expect(body.rows.map((r: any) => r.preset_name)).toEqual(['출구']);
  });

  it('IS NULL 은 값 없이 쓴다', async () => {
    const repo = new SetupRepository(db);
    repo.upsertSlot({ slot_id: 1, cam_id: 1, preset_id: 1, preset_slotidx: 1 });
    repo.upsertSlot({ slot_id: 2, cam_id: 1, preset_id: 1, preset_slotidx: 2, ptz: { pan: 1, tilt: 2, zoom: 3 } });
    const { body } = await api('/api/db/query', {
      method: 'POST',
      body: JSON.stringify({ table: 'slot_setup', conditions: [{ column: 'ptz_pan', op: 'IS NULL' }] }),
    });
    expect(body.rows.map((r: any) => r.slot_id)).toEqual([1]);
  });

  it('기간 검색은 시간 열이 있는 테이블에서만 된다', async () => {
    const repo = new SetupRepository(db, { now: () => '2026-08-05T10:00:00.000Z' });
    repo.upsertSlot({ slot_id: 1, cam_id: 1, preset_id: 1, preset_slotidx: 1 });

    const hit = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'slot_setup', from: '2026-08-05', to: '2026-08-05' }) });
    expect(hit.body.total).toBe(1);   // 날짜만 줘도 그날 전체가 잡힌다

    const miss = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'slot_setup', from: '2026-08-06' }) });
    expect(miss.body.total).toBe(0);

    const bad = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', from: '2026-08-01' }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/시간 열이 없어/);
  });

  it('페이지가 나뉘고 전체 개수를 함께 답한다', async () => {
    const { body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', limit: 1, offset: 1 }) });
    expect(body).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(body.rows).toHaveLength(1);
  });

  /** 뷰어도 비밀번호를 내보내지 않는다 — `/api/db/cameras` 와 같은 규칙이어야 구멍이 안 생긴다. */
  describe('camera_info.password 는 가려서 나간다', () => {
    it('값이 있으면 *** 로, 없으면 빈 값 그대로', async () => {
      const { body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'camera_info' }) });
      expect(body.columns).toContain('password');            // 열은 사라지지 않는다
      const rows = body.rows as Array<Record<string, unknown>>;
      expect(rows.map((r) => [r.cam_uuid, r.password])).toEqual([['cam-a', '***'], ['sim-1', '']]);
      expect(JSON.stringify(body)).not.toContain('secret');
    });

    it('자유 텍스트가 비밀번호를 훑지 않는다 — 훑으면 한 글자씩 되물어 알아낼 수 있다', async () => {
      const { body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'camera_info', text: 'secret' }) });
      expect(body.total).toBe(0);
    });

    it('가려진 열은 조건·정렬·열 지정에도 쓸 수 없다', async () => {
      for (const query of [
        { table: 'camera_info', text: 's', textColumn: 'password' },
        { table: 'camera_info', conditions: [{ column: 'password', op: 'LIKE', value: 's%' }] },
        { table: 'camera_info', orderBy: 'password' },
      ]) {
        const { status, body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify(query) });
        expect(status).toBe(400);
        expect(body.error).toMatch(/가려진 열/);
      }
    });
  });

  /** 식별자는 바인딩할 수 없다 — 화이트리스트 말고는 막을 방법이 없으므로 여기서 못 박는다. */
  describe('화이트리스트 밖 이름은 SQL 에 닿지 않는다', () => {
    it('테이블 이름', async () => {
      const { status, body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'sqlite_master' }) });
      expect(status).toBe(400);
      expect(body.error).toMatch(/볼 수 없는 테이블/);
    });

    it('주입 시도 테이블 이름', async () => {
      const { status } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info; DROP TABLE preset_info' }) });
      expect(status).toBe(400);
      // 표가 멀쩡히 남아 있다.
      expect((await api('/api/db/presets')).body.presets).toHaveLength(2);
    });

    it('열 이름', async () => {
      const { status, body } = await api('/api/db/query', {
        method: 'POST',
        body: JSON.stringify({ table: 'preset_info', conditions: [{ column: 'pos_zoom = 0 OR 1', op: '=', value: 1 }] }),
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/없는 열/);
    });

    it('비교 연산자', async () => {
      const { status, body } = await api('/api/db/query', {
        method: 'POST',
        body: JSON.stringify({ table: 'preset_info', conditions: [{ column: 'pos_zoom', op: '= 0 OR 1=1 --', value: 1 }] }),
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/쓸 수 없는 비교/);
    });

    it('정렬 열', async () => {
      expect((await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', orderBy: 'rowid; DROP TABLE x' }) })).status).toBe(400);
    });

    it('값에 든 따옴표는 그냥 값이다 — 바인딩으로 나간다', async () => {
      const { status, body } = await api('/api/db/query', { method: 'POST', body: JSON.stringify({ table: 'preset_info', text: "'; DROP TABLE preset_info; --" }) });
      expect(status).toBe(200);
      expect(body.total).toBe(0);
      expect((await api('/api/db/presets')).body.presets).toHaveLength(2);
    });
  });
});
