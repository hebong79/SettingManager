import { readJsonBody, sendJson } from '../httpUtil.js';
import { SIM_CATALOG } from '../../sim/simCatalog.js';
import { loadCarCatalog } from '../../sim/carCatalog.js';
import {
  PARSERS, RESULT_KEY, SERIALIZERS, SimFileError, isSaveKind, listSimFiles,
  readCameraFile, readCarFile, readPresetFile,
} from '../../sim/simFiles.js';
import { rpcToFile, vec3 } from '../../sim/simCoords.js';
import { SimRpcClient, SimRpcError } from '../../sim/simRpcClient.js';
import type { RouteHandler } from './routeContext.js';

/**
 * 시뮬레이터 툴의 **유일한 창구**. `/api/sim/*` 밖으로 나가지 않는다.
 *
 * ## 왜 격리인가 (지시 7 — "시뮬레이터 툴은 완전 독립적으로 사용한다")
 *
 * 이 핸들러는 `ctx.driverFor()` 를 부르지 않는다. 카메라도, DB 도, 코어도 만지지 않는다.
 * 그래서 **카메라가 한 대도 등록돼 있지 않아도 시뮬레이터 툴은 돌고**, 반대로 시뮬레이터가
 * 꺼져 있어도 카메라 제어는 멀쩡하다. 그 경계를 `test/simIndependence.test.ts` 가 강제한다.
 *
 * ## 카탈로그 밖은 거절한다
 *
 * 아무 메서드나 통과시키면 이것은 **임의 요청 통로**가 된다. 그 순간 "이 서비스가
 * 시뮬레이터에 무엇을 할 수 있는가"에 답할 곳이 사라진다 — MCP 서버와 같은 판단이다.
 */
export const simRoutes: RouteHandler = async (ctx) => {
  const { req, res, deps, pathname, method } = ctx;
  if (!pathname.startsWith('/api/sim/')) return false;

  const config = deps.configStore.get();

  // 이 서비스가 시뮬레이터에 무엇을 할 수 있는가. **주소가 없어도 답한다** —
  // 화면이 "무엇이 가능한지"와 "지금 연결됐는지"를 따로 물을 수 있어야 한다.
  if (method === 'GET' && pathname === '/api/sim/catalog') {
    sendJson(res, 200, { rpcUrl: config.simTool.rpcUrl, methods: SIM_CATALOG });
    return true;
  }

  // 차량 프리팹 이름. **시뮬레이터가 주지 않는 것**이라 정본 파일에서 읽어 준다.
  if (method === 'GET' && pathname === '/api/sim/car-catalog') {
    sendJson(res, 200, await loadCarCatalog());
    return true;
  }

  // --- 저장 파일 (save/3D/{Preset,CarPos,CameraPos}) --------------------------
  //
  // 시뮬레이터의 `preset.list` 는 **RPC 가 만든 것만** 보여 준다(위젯이 그린 주차면은
  // 안 보인다 — 실측으로 빈 배열). 사람이 만든 배치의 실체는 저장 파일에 있다.
  // 이 폴더 목록이 곧 「열기」 목록이라 언리얼에 `file.list` 를 신설하지 않아도 된다.
  const files = /^\/api\/sim\/files\/([a-z]+)$/.exec(pathname);
  if (files && method === 'GET') {
    const kind = files[1]!;
    if (!isSaveKind(kind)) throw new SimFileError(`알 수 없는 저장 종류입니다: ${kind}`);
    sendJson(res, 200, { kind, files: await listSimFiles(kind) });
    return true;
  }

  // 사람이 **PC 에서 연 파일**. 브라우저가 내용을 보내고 해석은 여기서 한다 —
  // 저장 폴더의 파일과 **같은 해석기·같은 좌표 변환**을 타야 축 규약이 한 벌로 남는다.
  const upload = /^\/api\/sim\/files\/([a-z]+)\/parse$/.exec(pathname);
  if (upload && method === 'POST') {
    const kind = upload[1]!;
    if (!isSaveKind(kind)) throw new SimFileError(`알 수 없는 저장 종류입니다: ${kind}`);
    // 배치 파일은 커질 수 있다(실측 차량 65대 9.5KB) — 기본 256KB 보다 넉넉히 잡는다.
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name : '(업로드)';
    sendJson(res, 200, { kind, name, source: 'upload', [RESULT_KEY[kind]]: PARSERS[kind](body.data, name) });
    return true;
  }

  // 저장 — 화면이 들고 있는 목록을 **파일 모양(Unity 좌표)** 으로 되돌린다.
  // 읽기와 같은 자리에서 축을 바꾼다: 규약이 읽기/쓰기로 갈리면 열었다 저장한 것만으로
  // 배치가 틀어지고, 그 실패는 화면에 오류로 뜨지 않는다.
  const serialize = /^\/api\/sim\/files\/([a-z]+)\/serialize$/.exec(pathname);
  if (serialize && method === 'POST') {
    const kind = serialize[1]!;
    if (!isSaveKind(kind)) throw new SimFileError(`알 수 없는 저장 종류입니다: ${kind}`);
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    const rows = body[RESULT_KEY[kind]];
    if (!Array.isArray(rows)) throw new SimFileError(`${RESULT_KEY[kind]} 배열이 필요합니다`, 400);
    // 화면이 준 것을 그대로 믿지 않고 **해석기를 한 번 통과시킨다** — 모양이 어긋난 값이
    // 파일로 굳는 것을 여기서 막는다. 축을 되돌려 파일 모양으로 만든 뒤 해석기에 넣으면
    // 왕복해서 제자리로 오고, 그 과정에서 검사·기본값 채우기가 함께 일어난다.
    const checked = PARSERS[kind]({ datas: rows.map((row) => toFileRow(kind, row)) }, '(저장 요청)');
    sendJson(res, 200, { kind, file: (SERIALIZERS[kind] as (r: unknown[]) => unknown)(checked as unknown[]) });
    return true;
  }

  const file = /^\/api\/sim\/files\/([a-z]+)\/(.+)$/.exec(pathname);
  if (file && method === 'GET') {
    const kind = file[1]!;
    if (!isSaveKind(kind)) throw new SimFileError(`알 수 없는 저장 종류입니다: ${kind}`);
    const name = decodeURIComponent(file[2]!);
    // 좌표는 **읽어 주는 이 자리에서** RPC 계로 바꾼다(simCoords). 화면이 두 좌표계를
    // 동시에 들고 있으면 반드시 섞인다.
    if (kind === 'preset') { sendJson(res, 200, { kind, name, source: 'folder', presets: await readPresetFile(name) }); return true; }
    if (kind === 'car') { sendJson(res, 200, { kind, name, source: 'folder', cars: await readCarFile(name) }); return true; }
    sendJson(res, 200, { kind, name, source: 'folder', cameras: await readCameraFile(name) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/sim/rpc') {
    const body = await readJsonBody(req);
    const name = typeof body.method === 'string' ? body.method.trim() : '';
    if (!name) throw new SimRpcError('method 가 필요합니다', 400);
    const params = (body.params ?? {}) as Record<string, unknown>;

    const client = new SimRpcClient({ ...config.simTool, fetchImpl: deps.fetchImpl });
    sendJson(res, 200, { method: name, result: await client.call(name, params) });
    return true;
  }

  return false;
};

/**
 * 화면이 준 **RPC 좌표** 행을 해석기가 아는 **파일 행 모양**으로 되돌린다.
 *
 * 해석기를 한 번 더 태우기 위한 것이라 여기서는 **축과 키 이름만** 바꾸고 검사는 하지
 * 않는다 — 검사는 해석기가 한다. 축 규칙은 `simCoords.rpcToFile` 하나를 쓴다.
 */
function toFileRow(kind: 'preset' | 'car' | 'camera', raw: unknown): unknown {
  const row = (raw ?? {}) as Record<string, unknown>;
  if (kind === 'preset') return { ...row, offsetPos: rpcToFile(vec3(row.offset)) };
  if (kind === 'car') return { ...row, pos: rpcToFile(vec3(row.pos)) };
  // 카메라는 해석기가 두 겹 `datas` 를 받지만 안쪽이 없으면 바깥을 한 건으로 본다 —
  // 그래서 평평한 행을 그대로 넣어도 통과한다.
  const limits = (row.limits ?? {}) as Record<string, number[] | undefined>;
  return {
    ...row,
    sname: row.name,
    cam_id: row.camId,
    preset_id: row.presetId,
    pos: rpcToFile(vec3(row.pos)),
    ...(limits.pan && limits.tilt && limits.zoom
      ? {
        ptzmin: { p: limits.pan[0], t: limits.tilt[0], z: limits.zoom[0] },
        ptzmax: { p: limits.pan[1], t: limits.tilt[1], z: limits.zoom[1] },
      }
      : {}),
  };
}
