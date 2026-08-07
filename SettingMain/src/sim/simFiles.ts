import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SERVICE_ROOT } from '../paths.js';
import { fileToRpc, rpcToFile, vec3, type Vec3 } from './simCoords.js';

/**
 * 시뮬레이터 저장 파일 저장소 — `SettingMain/save/3D/{Preset,CarPos,CameraPos}`.
 *
 * ## 왜 이것이 필요한가
 *
 * 시뮬레이터의 `preset.list` 는 **RPC 가 만든 것만** 보여 준다 — 위젯(시뮬 UI)이 그린
 * 주차면은 거기 안 보이고, 그래서 실제 배치는 빈 목록으로 나온다(실측). 사람이 만든
 * 배치의 실체는 **저장 파일**에 있다.
 *
 * 그리고 이 폴더 목록이 곧 「열기」의 파일 목록이다 — 언리얼에 `file.list` 를 신설하지
 * 않아도 된다.
 *
 * ## 좌표를 여기서 바꾼다
 *
 * 파일은 Unity(Y-up), RPC 는 언리얼(Z-up)이다(`simCoords.ts`). 파일을 읽어 주는 이 자리에서
 * **RPC 좌표로 바꿔서** 내보낸다 — 화면이 두 좌표계를 동시에 들고 있으면 반드시 섞인다.
 *
 * ## 읽기만 한다
 *
 * 저장은 시뮬레이터가 자기 디스크에 한다(`preset.save`·`car.save`). 이 폴더는 그 사본이며,
 * 여기에 쓰기를 열면 **정본이 둘**이 된다. 필요해지면 그때 방향을 정한다.
 */

export const SAVE_ROOT = resolve(SERVICE_ROOT, 'save', '3D');

/** 저장 종류 → 폴더. 이름은 시뮬레이터가 쓰는 것 그대로다. */
export const SAVE_KINDS = {
  preset: 'Preset',
  car: 'CarPos',
  camera: 'CameraPos',
} as const;

export type SaveKind = keyof typeof SAVE_KINDS;

export function isSaveKind(value: string): value is SaveKind {
  return Object.hasOwn(SAVE_KINDS, value);
}

export class SimFileError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'SimFileError';
  }
}

export interface SimFileEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

/** 그 종류의 저장 파일 목록. 폴더가 없으면 **빈 목록**이다 — 오류가 아니다. */
export async function listSimFiles(kind: SaveKind, root = SAVE_ROOT): Promise<SimFileEntry[]> {
  const dir = join(root, SAVE_KINDS[kind]);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: SimFileEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    try {
      const info = await stat(join(dir, name));
      entries.push({ name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
    } catch {
      // 목록 도중 사라진 파일은 건너뛴다 — 나머지를 못 보여 줄 이유는 아니다.
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** 주차면 프리셋 1건 — **RPC 좌표**로 옮겨진 상태다. */
export interface PresetGroup {
  idx: number;
  presetName: string;
  faceCount: number;
  /** RPC(언리얼 Z-up) 좌표. 파일의 Unity 좌표에서 변환된 값이다. */
  offset: Vec3;
  faceRot: number;
  groupRot: number;
  xSize: number;
  zSize: number;
  dirType: number;
  useBaseWidth: boolean;
  camIdx: number;
}

/**
 * 주차면 프리셋 파일을 읽는다.
 *
 * 실측 형식(`001_Preset_office.json`):
 * ```json
 * {"datas":[{"idx":1,"presetName":"Preset 1","faceCount":12,
 *            "offsetPos":{"x":1.059,"y":0.0,"z":-19.371},
 *            "faceRot":0,"groupRot":0,"xSize":2.5,"zSize":5,
 *            "dirType":0,"useBaseWidth":true,"camIdx":1}, …]}
 * ```
 *
 * **`idx` 는 연속이 아니다** — 실측 파일이 1,2,3,4,5,**7** 이다. 배열 위치로 번호를 매기면
 * 7번이 6번이 되어 시뮬레이터에 밀어 넣을 때 다른 프리셋을 덮는다.
 */
export async function readPresetFile(name: string, root = SAVE_ROOT): Promise<PresetGroup[]> {
  return parsePresets(await readJson(name, 'preset', root), name);
}

/**
 * 해석은 **읽기와 분리돼 있다.** 사람이 PC 에서 연 파일도 저장 폴더의 파일과 **같은
 * 해석기·같은 좌표 변환**을 타야 한다 — 브라우저에서 따로 해석하면 축 규약이 두 벌이 되고,
 * 그 실패는 화면에 오류로 뜨지 않는다(좌표가 그럴듯하게 틀린다).
 */
export function parsePresets(parsed: unknown, name = '(업로드)'): PresetGroup[] {
  const rows = (parsed as { datas?: unknown } | null)?.datas;
  if (!Array.isArray(rows)) throw new SimFileError(`${name} 에 datas 배열이 없습니다`, 422);

  return rows.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const idx = Number(row.idx);
    return {
      // 번호가 없으면 **위치로 지어내지 않고** 그 사실이 드러나게 0 을 준다 —
      // 밀어 넣을 때 화면이 걸러낼 수 있어야 한다.
      idx: Number.isFinite(idx) ? idx : 0,
      presetName: typeof row.presetName === 'string' ? row.presetName : `Preset ${index + 1}`,
      faceCount: numberOr(row.faceCount, 0),
      offset: fileToRpc(vec3(row.offsetPos)),
      faceRot: numberOr(row.faceRot, 0),
      groupRot: numberOr(row.groupRot, 0),
      xSize: numberOr(row.xSize, 2.5),
      zSize: numberOr(row.zSize, 5),
      dirType: numberOr(row.dirType, 0),
      useBaseWidth: row.useBaseWidth !== false,
      camIdx: numberOr(row.camIdx, 1),
    };
  });
}

/** 차량 1대 — **RPC 좌표**로 옮겨진 상태다. */
export interface CarPlacement {
  id: string;
  type: number;
  presetId: number;
  slotId: number;
  prefabId: number;
  pos: Vec3;
  rotY: number;
  isFront: boolean;
}

/**
 * 차량 배치 파일.
 *
 * 실측 형식(`CarPos_office.json`, 65대):
 * ```json
 * {"datas":[{"id":"0-13.50.46","type":0,"presetId":1,"slotId":2,"prefabId":1,
 *            "pos":{"x":-8.167922,"y":0.0220000744,"z":14.76307},
 *            "rotY":180.0,"isFront":true}, …]}
 * ```
 */
export async function readCarFile(name: string, root = SAVE_ROOT): Promise<CarPlacement[]> {
  return parseCars(await readJson(name, 'car', root), name);
}

export function parseCars(parsed: unknown, name = '(업로드)'): CarPlacement[] {
  const rows = (parsed as { datas?: unknown } | null)?.datas;
  if (!Array.isArray(rows)) throw new SimFileError(`${name} 에 datas 배열이 없습니다`, 422);

  return rows.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    return {
      id: String(row.id ?? ''),
      type: numberOr(row.type, 0),
      presetId: numberOr(row.presetId, 0),
      slotId: numberOr(row.slotId, 0),
      prefabId: numberOr(row.prefabId, 0),
      pos: fileToRpc(vec3(row.pos)),
      rotY: numberOr(row.rotY, 0),
      isFront: row.isFront !== false,
    };
  });
}

/** 카메라 1대와 그 PTZ 프리셋들 — **RPC 좌표**. */
export interface CameraPlacement {
  idx: number;
  name: string;
  camId: number;
  presetId: number;
  pos: Vec3;
  pan: number;
  tilt: number;
  zoom: number;
  /** 화면 슬라이더 범위의 출처. 시뮬레이터에 저장되는 값이 아니다. */
  limits?: { pan: [number, number]; tilt: [number, number]; zoom: [number, number] };
}

/**
 * 카메라 위치 파일.
 *
 * 실측 형식(`CamPos_office.json`) — **`datas` 가 두 겹이다**: 바깥이 카메라, 안이 그
 * 카메라의 PTZ 프리셋들. 안쪽 행 하나가 `{idx, sname, cam_id, preset_id, pos, rot,
 * pan, tilt, zoom, ptzmin, ptzmax}` 다.
 */
export async function readCameraFile(name: string, root = SAVE_ROOT): Promise<CameraPlacement[]> {
  return parseCameras(await readJson(name, 'camera', root), name);
}

export function parseCameras(parsed: unknown, name = '(업로드)'): CameraPlacement[] {
  const outer = (parsed as { datas?: unknown } | null)?.datas;
  if (!Array.isArray(outer)) throw new SimFileError(`${name} 에 datas 배열이 없습니다`, 422);

  const out: CameraPlacement[] = [];
  for (const group of outer) {
    const inner = ((group ?? {}) as { datas?: unknown }).datas;
    // 바깥 행이 곧 카메라 하나이고 안쪽이 그 프리셋들이다. 안쪽이 없으면 바깥을 한 건으로 본다.
    for (const raw of Array.isArray(inner) ? inner : [group]) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const min = (row.ptzmin ?? {}) as Record<string, unknown>;
      const max = (row.ptzmax ?? {}) as Record<string, unknown>;
      out.push({
        idx: numberOr(row.idx, 0),
        name: String(row.sname ?? ''),
        camId: numberOr(row.cam_id, 0),
        presetId: numberOr(row.preset_id, 0),
        pos: fileToRpc(vec3(row.pos)),
        pan: numberOr(row.pan, 0),
        tilt: numberOr(row.tilt, 0),
        zoom: numberOr(row.zoom, 1),
        ...(row.ptzmin && row.ptzmax
          ? {
            limits: {
              pan: [numberOr(min.p, -180), numberOr(max.p, 180)] as [number, number],
              tilt: [numberOr(min.t, -90), numberOr(max.t, 90)] as [number, number],
              zoom: [numberOr(min.z, 1), numberOr(max.z, 36)] as [number, number],
            },
          }
          : {}),
      });
    }
  }
  return out;
}

/**
 * 주차면 프리셋을 **파일 모양으로 되돌린다** — 저장용.
 *
 * 좌표를 Unity 계로 되돌리고 키 이름도 파일 것(`offsetPos`)으로 쓴다. 여기서 하는 이유는
 * 읽기와 **같은 자리**에 두기 위해서다 — 축 규약이 읽기/쓰기로 갈리면 열었다 저장한 것만으로
 * 배치가 틀어지고, 그 실패는 오류로 뜨지 않는다.
 *
 * 왕복(읽기→쓰기)이 원본과 같아야 한다: `rpcToFile(fileToRpc(v)) === v`(테스트가 지킨다).
 */
export function serializePresets(presets: PresetGroup[]): { datas: unknown[] } {
  return {
    datas: presets.map((preset) => ({
      idx: preset.idx,
      presetName: preset.presetName,
      faceCount: preset.faceCount,
      offsetPos: rpcToFile(preset.offset),
      faceRot: preset.faceRot,
      groupRot: preset.groupRot,
      xSize: preset.xSize,
      zSize: preset.zSize,
      dirType: preset.dirType,
      useBaseWidth: preset.useBaseWidth,
      camIdx: preset.camIdx,
    })),
  };
}

/** 종류 하나에 해석기 하나. 라우트가 `if (kind === …)` 를 세 번 쓰지 않게 한다. */
export const PARSERS = {
  preset: parsePresets,
  car: parseCars,
  camera: parseCameras,
} as const satisfies Record<SaveKind, (parsed: unknown, name?: string) => unknown>;

/** 해석 결과를 담는 키 이름. 저장 폴더 응답과 업로드 응답이 같은 모양이어야 한다. */
export const RESULT_KEY = { preset: 'presets', car: 'cars', camera: 'cameras' } as const satisfies Record<SaveKind, string>;

// --- 내부 ---------------------------------------------------------------------

/**
 * 파일 하나를 읽어 JSON 으로 판다.
 *
 * **경로 조각을 그대로 이어 붙이지 않는다.** `..` 이나 인코딩된 슬래시 하나로 저장소 밖이
 * 열린다 — 이름을 검사하고, 조립한 뒤 다시 그 폴더 안인지 확인한다(두 겹).
 */
async function readJson(name: string, kind: SaveKind, root: string): Promise<unknown> {
  if (!/^[\w.\-가-힣 ()]+\.json$/i.test(name)) {
    throw new SimFileError(`파일명에 쓸 수 없는 문자가 있습니다: ${name}`, 403);
  }
  const dir = join(root, SAVE_KINDS[kind]);
  const target = resolve(dir, name);
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new SimFileError(`저장 폴더 밖입니다: ${name}`, 403);
  }

  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    throw new SimFileError(`${name} 을(를) 읽지 못했습니다`, 404);
  }
  try {
    // BOM 이 붙어 오는 파일이 있다. 그대로 파싱하면 첫 글자에서 터진다.
    return JSON.parse(raw.replace(/^﻿/, '')) as unknown;
  } catch (error) {
    throw new SimFileError(`${name} 이(가) JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)}`, 422);
  }
}

function numberOr(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
