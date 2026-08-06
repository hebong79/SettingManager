import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/api/server.js';
import { openDatabase } from '../src/db/database.js';
import { ConfigStore } from '../src/config/configStore.js';
import { PresetStore } from '../src/store/presetStore.js';
import { SlotStore } from '../src/store/slotStore.js';
import { DevicePresetRegistryStore } from '../src/store/devicePresetRegistryStore.js';
import { SetupRepository, type CameraRow } from '../src/db/setupRepository.js';
import { toCameraConfig, toCameraRow } from '../src/db/configCameras.js';
import { normalizeCamera } from '../src/config/normalize.js';
import { createDriver } from '../src/devices/driverFactory.js';
import { IdisCameraClient } from '../src/devices/idis/index.js';
import type { AppConfig, CameraConfig } from '../src/config/types.js';

/**
 * **`insecureTls` 배선 전 구간.** 계획 §7 에는 케이스가 없다 — 사용자 결정으로 계획 **이후에**
 * 생긴 값이라 설계 단계의 케이스 목록이 이것을 모른다. 그래서 검증자가 경계면 교차 비교로 세운다.
 *
 * 잇는 고리는 여덟이고, 어느 한 자리만 끊겨도 **기능이 조용히 무력화된다** — 화면의 체크는
 * 켜져 있는데 TLS 검증은 그대로라 연결이 계속 실패하고, 사용자는 자기가 켠 스위치를 의심하지
 * 않는다. 그래서 각 고리를 따로 못박고 마지막에 **실제 자체서명 TLS 서버**로 끝을 확인한다.
 *
 *   web/optionsDb.js 체크박스 → draft() → PUT /api/db/cameras → camera_info.insecure_tls
 *     → setupRepository → toCameraConfig → createDriver → idisTransport 의 rejectUnauthorized
 */

// ---------------------------------------------------------------------------
// 1) 화면 — 체크박스와 draft()
// ---------------------------------------------------------------------------

describe('고리 1·2 — 화면 체크박스와 draft()', () => {
  const readWeb = (name: string): Promise<string> => readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');

  it('`options.html` 에 체크박스가 있고 id 가 `camInsecureTls` 다', async () => {
    const html = await readWeb('options.html');
    expect(html).toContain('id="camInsecureTls"');
    expect(html).toContain('type="checkbox"');
  });

  it('`draft()` 가 **snake_case `insecure_tls`** 로 보낸다 — 서버의 `merged()` 가 읽는 이름과 같아야 한다', async () => {
    const js = await readWeb('optionsDb.js');
    expect(js).toContain("insecure_tls: $('camInsecureTls').checked");
  });

  it('`renderEditor()` 가 DB 의 0/1 을 체크 상태로 되돌린다', async () => {
    const js = await readWeb('optionsDb.js');
    expect(js).toContain("$('camInsecureTls').checked = Boolean(camera.insecure_tls)");
    // 선택된 기기가 없을 때 이전 기기의 체크가 남지 않는다.
    expect(js).toContain("$('camInsecureTls').checked = false");
  });

  it('체크를 바꾸면 dirty 가 된다 — 「이 기기 적용」 버튼이 살아나지 않으면 저장할 방법이 없다', async () => {
    const js = await readWeb('optionsDb.js');
    const listeners = /for \(const elementId of \[([^\]]*)\]\) \{\s*\$\(elementId\)\.addEventListener\('input', \(\) => setDirty\(true\)\);/.exec(js);
    expect(listeners, 'dirty 리스너 목록을 찾지 못했습니다').not.toBeNull();
    expect(listeners![1]).toContain("'camInsecureTls'");
    // `change` 도 걸려 있어야 한다 — 체크박스는 `input` 만으로 충분하지 않은 브라우저가 있다.
    expect(js).toMatch(/\$\(elementId\)\.addEventListener\('change', \(\) => setDirty\(true\)\)/);
  });

  it('kind 드롭다운 두 곳 모두에 `idis` 가 있다 (T-UI1)', async () => {
    const html = await readWeb('options.html');
    expect(html.match(/<option value="idis">idis<\/option>/g) ?? []).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2) 순수 변환 — 키가 새지 않는가
// ---------------------------------------------------------------------------

describe('고리 5·6 — `normalizeCamera` / `toCameraConfig` 의 키 생성 규칙', () => {
  const base = {
    id: 'x', label: 'x', controlUrl: 'http://10.0.0.1:80', username: 'a', password: 'b',
    streamUrl: '', timeoutMs: 2000,
  };

  it('`kind:idis` + `true` 일 때만 `insecureTls` 키가 생긴다', () => {
    expect(normalizeCamera({ ...base, kind: 'idis', insecureTls: true })).toHaveProperty('insecureTls', true);
  });

  it('**다른 kind 에는 값이 참이어도 키가 생기지 않는다** — 공개 응답의 키 집합을 넓히지 않는다', () => {
    for (const kind of ['hucoms', 'backend-core', 'park3d-rpc']) {
      const camera = normalizeCamera({ ...base, kind, insecureTls: true })!;
      expect(camera, kind).not.toHaveProperty('insecureTls');
    }
  });

  it('`kind:idis` 라도 값이 거짓·미지정이면 키가 없다 — 기본은 검증 켬이다', () => {
    for (const value of [false, undefined, 0, 'true', null]) {
      const camera = normalizeCamera({ ...base, kind: 'idis', insecureTls: value })!;
      expect(camera, String(value)).not.toHaveProperty('insecureTls');
    }
  });

  it('`toCameraConfig` 도 같은 규칙이다 — 두 경로가 갈리면 파일과 DB 가 다르게 굴러간다', () => {
    const row = (over: Partial<CameraRow>): CameraRow => ({
      cam_id: 1, cam_name: 'x', cam_uuid: 'x', url: 'http://10.0.0.1:80', user_id: 'a', password: 'b',
      rtsp_url: '', cam_type: 'ptz', place_id: 1, timeout_ms: 2000, kind: 'idis',
      park3d_cam_id: null, insecure_tls: 0, intrinsics: null, ...over,
    });
    expect(toCameraConfig(row({ kind: 'idis', insecure_tls: 1 }))).toHaveProperty('insecureTls', true);
    expect(toCameraConfig(row({ kind: 'idis', insecure_tls: 0 }))).not.toHaveProperty('insecureTls');
    // **kind 가 다르면 열에 1 이 남아 있어도 키가 안 생긴다.** idis 였다가 종류를 바꾼 기기의 모습이다.
    expect(toCameraConfig(row({ kind: 'hucoms', insecure_tls: 1 }))).not.toHaveProperty('insecureTls');
    expect(toCameraConfig(row({ kind: 'park3d-rpc', insecure_tls: 1 }))).not.toHaveProperty('insecureTls');
  });

  it('`toCameraRow` 는 반대 방향에서 boolean 을 0/1 로 좁힌다 — SQLite 에 boolean 이 없다', () => {
    const camera = (over: Partial<CameraConfig>): CameraConfig => ({
      id: 'x', label: 'x', kind: 'idis', controlUrl: 'http://10.0.0.1:80', username: '', password: '',
      streamUrl: '', timeoutMs: 2000, ...over,
    });
    expect(toCameraRow(camera({ insecureTls: true })).insecure_tls).toBe(1);
    expect(toCameraRow(camera({ insecureTls: false })).insecure_tls).toBe(0);
    expect(toCameraRow(camera({})).insecure_tls).toBe(0);
    // 타입이 number 다 — boolean 을 그대로 넣으면 SQLite 바인딩에서 터진다.
    expect(typeof toCameraRow(camera({ insecureTls: true })).insecure_tls).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 3) DB 왕복 — boolean 이 정수와 오가며 깨지지 않는가
// ---------------------------------------------------------------------------

describe('고리 4 — DB 왕복(저장 → 읽기)에서 값이 깨지지 않는다', () => {
  it('1 로 저장하면 1 로 읽히고, 생략하면 **기존 값이 유지된다**', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const repo = new SetupRepository(db);
      const saved = repo.upsertCamera({
        cam_name: 'IDIS', cam_uuid: 'idis-1', url: 'https://10.0.0.9:443', user_id: 'admin', password: 'pw',
        rtsp_url: '', cam_type: 'ptz', place_id: 1, kind: 'idis', insecure_tls: 1,
      });
      expect(saved.insecure_tls).toBe(1);
      expect(repo.listCameras()[0]!.insecure_tls).toBe(1);

      // 이름만 고치는 저장 — insecure_tls 를 안 보냈다고 꺼지면 안 된다.
      repo.upsertCamera({ cam_id: saved.cam_id, cam_name: '이름만', cam_uuid: 'idis-1', url: 'https://10.0.0.9:443', user_id: 'admin', password: 'pw', rtsp_url: '', cam_type: 'ptz', place_id: 1 });
      expect(repo.listCameras()[0]!.insecure_tls).toBe(1);

      // 0 을 **명시로** 보내면 꺼진다(`??` 라 0 이 살아남는지가 여기서 갈린다).
      repo.upsertCamera({ cam_id: saved.cam_id, cam_name: '이름만', cam_uuid: 'idis-1', url: 'https://10.0.0.9:443', user_id: 'admin', password: 'pw', rtsp_url: '', cam_type: 'ptz', place_id: 1, insecure_tls: 0 });
      expect(repo.listCameras()[0]!.insecure_tls).toBe(0);
    } finally {
      db.close();
    }
  });

  it('저장소가 0/1 로 좁혀 넣는다 — 옛 파일에는 CHECK 가 없어 저장소가 제약을 대신한다', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const repo = new SetupRepository(db);
      const saved = repo.upsertCamera({
        cam_name: 'IDIS', cam_uuid: 'idis-1', url: 'https://10.0.0.9:443', user_id: '', password: '',
        rtsp_url: '', cam_type: 'ptz', place_id: 1, kind: 'idis',
        insecure_tls: 7 as unknown as number,
      });
      expect(saved.insecure_tls).toBe(1);   // 7 이 그대로 들어가지 않는다
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4) 서버 경계 — PUT 왕복과 공개 응답
// ---------------------------------------------------------------------------

describe('고리 3 — PUT /api/db/cameras 왕복과 공개 응답', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let db: ReturnType<typeof openDatabase>;

  async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  const put = (camId: number, patch: Record<string, unknown>): Promise<{ status: number; body: any }> =>
    api(`/api/db/cameras/${camId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });

  /** cam_uuid 로 DB 행을 찾는다 — cam_id 는 등록 순서라 하드코딩하면 순서 바뀔 때 조용히 어긋난다. */
  const rowOf = async (uuid: string): Promise<any> =>
    (await api('/api/db/cameras')).body.cameras.find((c: any) => c.cam_uuid === uuid);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'settingmanager-idis-tls-'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      server: { host: '127.0.0.1', port: 0 },
      simulator: { baseUrl: 'http://127.0.0.1:8080' },
      activeCameraId: 'idis-1',
      cameras: [
        // idis 카메라는 `config.json` → DB 1회 이관 경로도 함께 지나간다.
        { id: 'idis-1', label: 'IDIS 1', kind: 'idis', controlUrl: 'https://192.168.0.30:443', username: 'admin', password: 'secret-not-real', streamUrl: 'rtsp://192.168.0.30:554/trackID=1', timeoutMs: 2000 },
        { id: 'cam-a', label: '리얼 1', kind: 'hucoms', controlUrl: 'http://10.0.0.1:80', username: 'admin', password: 'secret', streamUrl: 'rtsp://10.0.0.1:554/stream1', timeoutMs: 2000 },
      ],
    }));

    db = openDatabase({ path: ':memory:' });
    const configStore = new ConfigStore(join(dir, 'config.json'), db);
    await configStore.load();
    const presetStore = new PresetStore(db);
    const slotStore = new SlotStore(join(dir, 'slots.json'));
    await slotStore.load();
    const devicePresetRegistryStore = new DevicePresetRegistryStore(join(dir, 'device-preset-registry.json'), () => '2026-08-06T00:00:00.000Z');
    await devicePresetRegistryStore.load();

    server = createServer({ configStore, presetStore, slotStore, devicePresetRegistryStore, db, settleOptions: { sleep: async () => {} } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('[전제] 기본은 꺼짐이다 — 아무도 켜지 않은 기기의 열은 0 이다', async () => {
    expect((await rowOf('idis-1')).insecure_tls).toBe(0);
  });

  it('체크박스의 `true` 가 열의 1 이 된다 — boolean → SQLite 정수 경계', async () => {
    const camId = (await rowOf('idis-1')).cam_id;
    const { status } = await put(camId, { insecure_tls: true });
    expect(status).toBe(200);
    expect((await rowOf('idis-1')).insecure_tls).toBe(1);
  });

  it('`false` 로 되돌리면 0 이 된다 — 켜고 나서 끌 수 없으면 반쪽이다', async () => {
    const camId = (await rowOf('idis-1')).cam_id;
    await put(camId, { insecure_tls: true });
    await put(camId, { insecure_tls: false });
    expect((await rowOf('idis-1')).insecure_tls).toBe(0);
  });

  it('보내지 않은 저장에서는 **기존 값이 유지된다** — 이름만 고치다 검증이 되살아나면 연결이 끊긴다', async () => {
    const camId = (await rowOf('idis-1')).cam_id;
    await put(camId, { insecure_tls: true });
    await put(camId, { cam_name: '이름만 바꿈' });
    const row = await rowOf('idis-1');
    expect(row.cam_name).toBe('이름만 바꿈');
    expect(row.insecure_tls).toBe(1);
  });

  it('`GET /api/settings` 의 idis 카메라에 `insecureTls:true` 가 실린다 (고리 6 까지 살아 있다)', async () => {
    const camId = (await rowOf('idis-1')).cam_id;
    await put(camId, { insecure_tls: true });
    const { body } = await api('/api/settings');
    const idis = body.cameras.find((c: any) => c.id === 'idis-1');
    expect(idis.kind).toBe('idis');
    expect(idis.insecureTls).toBe(true);
    expect(idis).not.toHaveProperty('password');
  });

  it('**다른 kind 의 공개 응답에는 키가 새지 않는다**', async () => {
    const hucomsId = (await rowOf('cam-a')).cam_id;
    // hucoms 기기의 열에 1 을 심어도(예: 종류를 바꾼 기기) 공개 응답에는 나오지 않아야 한다.
    await put(hucomsId, { insecure_tls: true });
    expect((await rowOf('cam-a')).insecure_tls).toBe(1);

    const { body } = await api('/api/settings');
    const hucoms = body.cameras.find((c: any) => c.id === 'cam-a');
    expect(hucoms).not.toHaveProperty('insecureTls');
    expect(Object.keys(hucoms).sort())
      .toEqual(['controlUrl', 'hasPassword', 'id', 'kind', 'label', 'place_id', 'streamUrl', 'timeoutMs', 'username']);
  });

  it('끄면 공개 응답에서 키가 **사라진다** — false 로 남지 않는다', async () => {
    const camId = (await rowOf('idis-1')).cam_id;
    await put(camId, { insecure_tls: true });
    await put(camId, { insecure_tls: false });
    const { body } = await api('/api/settings');
    expect(body.cameras.find((c: any) => c.id === 'idis-1')).not.toHaveProperty('insecureTls');
  });

  it('종류를 idis 에서 hucoms 로 바꾸면 키가 사라진다 — 열 값은 남아 있어도 뜻을 잃는다', async () => {
    const camId = (await rowOf('idis-1')).cam_id;
    await put(camId, { insecure_tls: true });
    await put(camId, { kind: 'hucoms' });
    const { body } = await api('/api/settings');
    const camera = body.cameras.find((c: any) => c.id === 'idis-1');
    expect(camera.kind).toBe('hucoms');
    expect(camera).not.toHaveProperty('insecureTls');
  });

  it('`kind:idis` 자체가 PUT 으로 저장된다 — `KINDS` 목록에 idis 가 없으면 조용히 되돌아간다', async () => {
    const camId = (await rowOf('cam-a')).cam_id;
    await put(camId, { kind: 'idis' });
    expect((await rowOf('cam-a')).kind).toBe('idis');
  });

  /**
   * **POST 와 PUT 이 같은 값을 다른 이름으로 읽는다(검증 중 발견).**
   *
   * `PUT` 은 `merged()` 가 `patch.insecure_tls`(snake)를 읽고, `POST` 는
   * `normalizeCamera({...body, id})` 가 `r.insecureTls`(camel)를 읽는다. 그래서 같은 본문을
   * 두 경로에 보내면 결과가 갈린다.
   *
   * 지금은 사고가 나지 않는다 — 화면의 「+ 기기 추가」는 `{cam_uuid, kind, label}` 만 보내고
   * 나머지는 전부 PUT 으로 채우기 때문이다. 그래서 **현재 동작을 사실대로 고정만** 해 둔다.
   * 넓히거나 좁히는 것은 계약 판단이라 검증자가 정하지 않는다.
   */
  it('[기록] POST 로 `insecure_tls` 를 보내면 무시된다 — PUT 과 이름이 갈린다', async () => {
    const { status, body } = await api('/api/db/cameras', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cam_uuid: 'idis-2', kind: 'idis', label: 'IDIS 2', insecure_tls: true }),
    });
    expect(status).toBe(200);
    expect(body.camera.kind).toBe('idis');
    expect(body.camera.insecure_tls).toBe(0);          // ← snake 이름은 POST 경로가 읽지 않는다
    // camelCase 로 보내면 읽힌다 — 갈린 이름이 원인임을 못박는다.
    const camel = await api('/api/db/cameras', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cam_uuid: 'idis-3', kind: 'idis', label: 'IDIS 3', insecureTls: true }),
    });
    expect(camel.body.camera.insecure_tls).toBe(1);
    // 그리고 화면의 「+ 기기 추가」는 애초에 이 값을 보내지 않는다(그래서 사고가 안 난다).
    const js = await readFile(new URL('../web/optionsDb.js', import.meta.url), 'utf8');
    expect(js).toContain("api.dbAddCamera({ cam_uuid: id, kind: $('camNewKind').value, label: id })");
  });
});

// ---------------------------------------------------------------------------
// 5) 마지막 고리 — 값이 정말 전송의 rejectUnauthorized 에 닿는가
// ---------------------------------------------------------------------------

/**
 * 자체서명 인증서(CN=127.0.0.1, SAN IP:127.0.0.1, 2126년까지). `openssl req -x509` 로 만든
 * **테스트 전용** 키다 — 실제 기기·서비스 어디에도 쓰이지 않는다. 값을 고정해 둔 이유는
 * 실행 환경에 openssl 이 있는지에 시험이 매달리지 않게 하기 위해서다.
 */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUH9lTi+fNr7SmYXmzZCXdzG/FxuowDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDgwNjEyNTMwOVoYDzIxMjYw
NzEzMTI1MzA5WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDGmA9sSPo/Q3bYnKiS7uMCzlk24+KCvAzVqJ73Cwdw
JHJ5vykqxxjH2iYiSx0d6GiuMIUXLLeDxkSrRjNUpRfp97P4uwxBlKREDgpbSQgD
qFPgACasrHC1B6Ld2qzYJqgvpwoPZ0tn8ioBpF9lg9VuUR04jILyl5zJcRo0FopC
5cHpPLlTiz7WFBEwgLYTX7Bi6jTHYsKwEd7zWkwDG38UkydrzkUWSVKLgEDBHrTb
Vyj5hmcPpZSAS7V7UsJeBifPVtPfVEl91oJfo2ybjqmTF4wKc58so2Qh+HS0h/Jb
by+XS9nNcBwS8hhgnH0jxAPKqYD0eCrv3XkGYBZlicHpAgMBAAGjZDBiMB0GA1Ud
DgQWBBSy9d1VTuGcDonurkomGf4mVhg7PTAfBgNVHSMEGDAWgBSy9d1VTuGcDonu
rkomGf4mVhg7PTAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBABiBPEVIfKwQTFYISu4La+14X17w1msKIXeOSSpF4k7v
Mw4AQqHwDItQWTDAWv5ZJAO0bYcM67MeZOR2fhrwaKojhdXbulL/DyMX123JiKbu
HrrfblT7rrFX3eEQWF5CqlF9r/DV8gIL7GB5UTk3g8+vuQ4kTt+kHcX2q2eFv4pw
luAYz5OT3KeaJ1geLcXitCdvw2P9W4ihhT447GqX9HvCjrxpL3ClPZ+Fzq4mQD2v
BOUjGwo/FzsYNH5qaD+u3+K//ivfvlQlExkwiZF1CmQdCdgAUs3g2ElJOm7wd0px
kl8Xn1hER8qH5VezxV8+mnBqhO6GNCLCiShjRcTQ2vY=
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDGmA9sSPo/Q3bY
nKiS7uMCzlk24+KCvAzVqJ73CwdwJHJ5vykqxxjH2iYiSx0d6GiuMIUXLLeDxkSr
RjNUpRfp97P4uwxBlKREDgpbSQgDqFPgACasrHC1B6Ld2qzYJqgvpwoPZ0tn8ioB
pF9lg9VuUR04jILyl5zJcRo0FopC5cHpPLlTiz7WFBEwgLYTX7Bi6jTHYsKwEd7z
WkwDG38UkydrzkUWSVKLgEDBHrTbVyj5hmcPpZSAS7V7UsJeBifPVtPfVEl91oJf
o2ybjqmTF4wKc58so2Qh+HS0h/Jbby+XS9nNcBwS8hhgnH0jxAPKqYD0eCrv3XkG
YBZlicHpAgMBAAECggEAAZhpLE6lEv/Hq0HaUVOoGqaxEDtLrFu87MHF/ouCqWlJ
8aKVXs2tzDVoJirTqEc5dKfFxyJBwNlfH3/PS83OBIzfIvkDf9ER8j/pUzzBx5mK
zFmxj3EzSeMBytw11GbLTFaAT4NRPeInD/xDup9drJbFrP8xxWeuJHvUyohHuOj9
tTSmSsMUkwD34ziBqUe9nTSzJn+q7qH3yXiFet84J+DQtPRtxYgZ0mgZ4aWeLDJj
I29F6x1c0eBuq1Bugb61bfh9pti0Hie67/PjPHYyeNH8LZDwoPmopmBfxpu3UT+U
VvE09Sav4wTVfnKL0WC7yJ+WfmFrmz4u912Bk8Ax0QKBgQD3Sj5Hw6uOlRVWpTXF
yBF7C00VfshJ6Xcmrsf0IFILgxqu1x8J6jk79bsWbkeWnt+LmqSFYXSJSKNh3kQf
H2pshp8c6jVKFanpbJAaqgsDyAIrqtul3am39JaakHbbTdi/GZNhcrUx+CTeAgOv
pHNsntfGbz+JzI1KarUbwZApEQKBgQDNlrx1z6KMgoVv5cA1EaWp6TDtimiwVHsU
WGgco6KZN7K1AyTRjYuuCXmbf/ohhf77iPZBCmHYyTp77PK3b3gdIM+HuWT8oYp1
xwVeu3BZ8Qg5YzICUjPmurMwX86O5S58ATec+j98LBPvYt5aj0y4HIc9DuWbrF5W
97qdpCvLWQKBgQC9rPiwWulP6BIB756bIaYm1rg9cI14A9ccmJtOKSxFID5rNR3d
oQZdc1IZFmVapmmYzvi6RdH5KvoGq1Fc/d/Hdkq9Bvfw50T4ggjWKu9f6x2fGOJ5
CtiO/NA3pe9EryU9DwT4jd9lgIvmrWzeYCkYe43N6q61p2wIVGit7X4BwQKBgQDG
biHyd/kFM4lFanStBB5os9l0vG21G6U8CuRaGBp9VgQXsDQeSkcyMJT+YHR1XNax
ww0j07iDPB5FtHrEUEOXoa6M6oUtTWHNsc1eFP4o4Xq1oSeIk/ziSvteymodA9ls
+OPLkMIrwINxP3Ur5ToAThC9/x3gtmrL+AlX1Dgs6QKBgQCf7PCzkQ9WZxEDXauG
1sG1liT3NWV9+PYJC0aAdtZCA/UGQXYKiWQ0eC42G+CPl++jNwQkzMdRFwGXFYwx
P4yFJqXd44OluffdDPGBQ6Wo158UNWajIqv7+7mawqVPObMyny9lt0fkmWITytTU
QHjApkr1ax6iVGo9oLYk7wXIXw==
-----END PRIVATE KEY-----
`;

describe('고리 7·8 — 값이 정말 `rejectUnauthorized` 에 닿는가 (실제 자체서명 TLS)', () => {
  let tls: HttpsServer | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    tls = createHttpsServer({ cert: TEST_CERT, key: TEST_KEY }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('returnCode=0&absPan=18000&absTilt=8850&absZoom=3000');
    });
    const port = await new Promise<number>((resolve) => {
      tls!.listen(0, '127.0.0.1', () => {
        const address = tls!.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    baseUrl = `https://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (tls) await new Promise<void>((resolve) => tls!.close(() => resolve()));
    tls = undefined;
  });

  const driverFor = (insecureTls: boolean): IdisCameraClient => new IdisCameraClient({
    cameraId: 'idis-1', baseUrl, username: 'admin', password: 'secret-not-real', timeoutMs: 3000, insecureTls,
  });

  it('[전제] 기본(검증 켬)에서는 자체서명 인증서에 **실패한다** — 실패하지 않으면 아래 시험이 아무것도 증명하지 않는다', async () => {
    const error = await driverFor(false).getPtz().catch((e: unknown) => e) as { transport?: boolean; message: string };
    expect(error.transport).toBe(true);
    // 무엇을 해야 하는지까지 말해 준다.
    expect(error.message).toContain('insecure_tls');
  });

  it('`insecureTls:true` 면 같은 서버에서 **성공한다** — 값이 전송까지 끊기지 않고 닿았다는 증거', async () => {
    expect(await driverFor(true).getPtz()).toEqual({ pan: 18000, tilt: 150, zoom: 3000 });
  });

  it('옵션을 주지 않으면 검증을 켠다 — 기본은 안전한 쪽이다', async () => {
    const camera = new IdisCameraClient({
      cameraId: 'idis-1', baseUrl, username: 'admin', password: 'secret-not-real', timeoutMs: 3000,
    });
    await expect(camera.getPtz()).rejects.toMatchObject({ transport: true });
  });

  it('**`createDriver` 가 만든 드라이버**로도 같다 — 설정 → 팩토리 → 전송의 마지막 이음매', async () => {
    const config = { streaming: {} } as unknown as AppConfig;
    const camera = (insecureTls: boolean): CameraConfig => ({
      id: 'idis-1', label: 'IDIS 1', kind: 'idis', controlUrl: baseUrl,
      username: 'admin', password: 'secret-not-real', streamUrl: '', timeoutMs: 3000,
      ...(insecureTls ? { insecureTls: true } : {}),
    });

    const strict = createDriver(camera(false), config);
    await expect(strict.getPtz()).rejects.toMatchObject({ transport: true });

    const lenient = createDriver(camera(true), config);
    expect(await lenient.getPtz()).toEqual({ pan: 18000, tilt: 150, zoom: 3000 });
  });

  it('**DB 행에서 출발해도 끝까지 닿는다** — `camera_info` → `toCameraConfig` → `createDriver` → TLS', async () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const repo = new SetupRepository(db);
      const row = repo.upsertCamera({
        cam_name: 'IDIS 1', cam_uuid: 'idis-1', url: baseUrl, user_id: 'admin', password: 'secret-not-real',
        rtsp_url: '', cam_type: 'ptz', place_id: 1, kind: 'idis', timeout_ms: 3000, insecure_tls: 1,
      });
      const driver = createDriver(toCameraConfig(row), { streaming: {} } as unknown as AppConfig);
      expect(await driver.getPtz()).toEqual({ pan: 18000, tilt: 150, zoom: 3000 });
    } finally {
      db.close();
    }
  });

  it('`insecureTls` 는 **그 기기 하나에만** 걸린다 — 프로세스 전역 검증을 끄지 않는다', async () => {
    // 느슨한 기기로 한 번 성공시킨 **뒤에도** 엄격한 기기는 여전히 실패해야 한다.
    expect(await driverFor(true).getPtz()).toEqual({ pan: 18000, tilt: 150, zoom: 3000 });
    await expect(driverFor(false).getPtz()).rejects.toMatchObject({ transport: true });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });
});
