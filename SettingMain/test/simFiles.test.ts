import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileToRpc, rpcToFile, vec3 } from '../src/sim/simCoords.js';
import {
  SAVE_KINDS, SimFileError, isSaveKind, listSimFiles,
  readCameraFile, readCarFile, readPresetFile,
} from '../src/sim/simFiles.js';

/**
 * 저장 파일 계약. 형식과 좌표 규약은 **2026-08-07 실측**에서 왔다
 * (`SettingMain/save/3D/` 의 실제 파일 + 같은 대상을 RPC 로 읽어 대조).
 */

let root = '';

const write = async (kind: keyof typeof SAVE_KINDS, name: string, body: unknown) => {
  const dir = join(root, SAVE_KINDS[kind]);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
};

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'simfiles-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// --- 좌표 -----------------------------------------------------------------------

describe('저장 파일 ↔ RPC 좌표', () => {
  /**
   * 같은 카메라를 양쪽에서 읽어 대조한 실측값이다.
   * 파일의 높이는 `y`(13.5), RPC 의 높이는 `z`(13.5) — `measure.cameraHeight` 와도 맞았다.
   */
  it('Camera-1 실측: 파일(x:-13.6, y:13.5, z:-36.3) → RPC(x:-36.3, y:-13.6, z:13.5)', () => {
    expect(fileToRpc({ x: -13.6, y: 13.5, z: -36.3 })).toEqual({ x: -36.3, y: -13.6, z: 13.5 });
  });

  it('차량 0-13.50.46 실측도 같은 규칙이다', () => {
    expect(fileToRpc({ x: -8.167922, y: 0.0220000744, z: 14.76307 }))
      .toEqual({ x: 14.76307, y: -8.167922, z: 0.0220000744 });
  });

  it('되돌리면 원래 값이다', () => {
    const file = { x: 1.059, y: 0, z: -19.371 };
    expect(rpcToFile(fileToRpc(file))).toEqual(file);
  });

  /** 없는 축을 `undefined` 로 흘리면 RPC 가 조용히 0 을 쓴다 — 여기서 0 으로 굳힌다. */
  it('숫자가 아닌 자리는 0 으로 본다', () => {
    expect(vec3({ x: '3', y: null })).toEqual({ x: 3, y: 0, z: 0 });
    expect(vec3(undefined)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// --- 목록 -----------------------------------------------------------------------

describe('저장 파일 목록', () => {
  it('세 종류를 안다', () => {
    for (const kind of ['preset', 'car', 'camera']) expect(isSaveKind(kind)).toBe(true);
    expect(isSaveKind('light')).toBe(false);
  });

  it('json 만 이름순으로 싣는다', async () => {
    await write('preset', 'b.json', { datas: [] });
    await write('preset', 'a.json', { datas: [] });
    await write('preset', 'readme.txt', 'x');
    const files = await listSimFiles('preset', root);
    expect(files.map((f) => f.name)).toEqual(['a.json', 'b.json']);
    expect(files[0]!.sizeBytes).toBeGreaterThan(0);
  });

  /** 아직 아무것도 저장하지 않은 상태는 **오류가 아니다.** */
  it('폴더가 없으면 빈 목록이다', async () => {
    expect(await listSimFiles('car', root)).toEqual([]);
  });
});

// --- 주차면 프리셋 ----------------------------------------------------------------

describe('주차면 프리셋 파일', () => {
  const sample = {
    datas: [
      { idx: 1, presetName: 'Preset 1', faceCount: 12, offsetPos: { x: 1.059, y: 0.0, z: -19.371 }, faceRot: 0, groupRot: 0, xSize: 2.5, zSize: 5, dirType: 0, useBaseWidth: true, camIdx: 1 },
      { idx: 7, presetName: 'Preset 6', faceCount: 12, offsetPos: { x: 1.078, y: 0.0, z: -13.728 }, faceRot: 0, groupRot: 0, xSize: 2.5, zSize: 5, dirType: 0, useBaseWidth: true, camIdx: 1 },
    ],
  };

  it('실측 형식을 읽고 좌표를 RPC 계로 바꾼다', async () => {
    await write('preset', 'p.json', sample);
    const presets = await readPresetFile('p.json', root);
    expect(presets).toHaveLength(2);
    // 파일(1.059, 0, -19.371) → RPC(-19.371, 1.059, 0). 주차면은 지면이라 RPC z(높이) = 0.
    expect(presets[0]!.offset).toEqual({ x: -19.371, y: 1.059, z: 0 });
    expect(presets[0]!.faceCount).toBe(12);
    expect(presets[0]!.useBaseWidth).toBe(true);
  });

  /**
   * 실측 파일의 idx 가 1,2,3,4,5,**7** 이다. 배열 위치로 번호를 매기면 7번이 6번이 되어
   * 시뮬레이터에 밀어 넣을 때 **다른 프리셋을 덮는다.**
   */
  it('idx 가 연속이 아니어도 파일의 번호를 그대로 쓴다', async () => {
    await write('preset', 'p.json', sample);
    expect((await readPresetFile('p.json', root)).map((p) => p.idx)).toEqual([1, 7]);
  });

  it('번호가 없으면 0 이다 — 위치로 지어내지 않는다', async () => {
    await write('preset', 'p.json', { datas: [{ presetName: 'x', faceCount: 3 }] });
    expect((await readPresetFile('p.json', root))[0]!.idx).toBe(0);
  });

  it('BOM 이 붙어 있어도 읽는다', async () => {
    await write('preset', 'p.json', `﻿${JSON.stringify(sample)}`);
    expect(await readPresetFile('p.json', root)).toHaveLength(2);
  });

  it('datas 가 없으면 422 + 사유', async () => {
    await write('preset', 'p.json', { wrong: [] });
    await expect(readPresetFile('p.json', root)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('없는 파일은 404', async () => {
    await expect(readPresetFile('nope.json', root)).rejects.toMatchObject({ statusCode: 404 });
  });
});

// --- 차량·카메라 ------------------------------------------------------------------

describe('차량 배치 파일', () => {
  it('실측 형식을 읽고 좌표를 바꾼다', async () => {
    await write('car', 'c.json', {
      datas: [{ id: '0-13.50.46', type: 0, presetId: 1, slotId: 2, prefabId: 1, pos: { x: -8.167922, y: 0.0220000744, z: 14.76307 }, rotY: 180, isFront: true }],
    });
    const [car] = await readCarFile('c.json', root);
    expect(car!.id).toBe('0-13.50.46');
    expect(car!.pos).toEqual({ x: 14.76307, y: -8.167922, z: 0.0220000744 });
    expect(car!.rotY).toBe(180);
    expect(car!.isFront).toBe(true);
  });
});

describe('카메라 위치 파일', () => {
  /** 실측 형식은 `datas` 가 **두 겹**이다 — 바깥이 카메라, 안이 그 카메라의 PTZ 프리셋들. */
  it('중첩된 datas 를 펼쳐 읽는다', async () => {
    await write('camera', 'k.json', {
      datas: [{
        datas: [
          { idx: 0, sname: 'Preset 1', cam_id: 1, preset_id: 1, pos: { x: -13.6, y: 13.5, z: -36.3 }, pan: 47.1, tilt: 30.4, zoom: 2.4, ptzmin: { p: -180, t: -90, z: 1 }, ptzmax: { p: 180, t: 90, z: 36 } },
          { idx: 1, sname: 'Preset 2', cam_id: 1, preset_id: 2, pos: { x: -13.6, y: 13.5, z: -36.3 }, pan: 57.8, tilt: 23.5, zoom: 6 },
        ],
      }],
    });
    const cameras = await readCameraFile('k.json', root);
    expect(cameras).toHaveLength(2);
    expect(cameras[0]!.pos).toEqual({ x: -36.3, y: -13.6, z: 13.5 });
    expect(cameras[0]!.pan).toBe(47.1);
    expect(cameras[0]!.limits?.zoom).toEqual([1, 36]);
    // ptzmin/max 가 없는 행에는 범위를 지어내지 않는다.
    expect(cameras[1]!.limits).toBeUndefined();
  });
});

// --- 경로 방어 --------------------------------------------------------------------

describe('저장 폴더 밖으로 나가지 않는다', () => {
  it.each([
    '../secret.json',
    '..\\secret.json',
    'sub/deep.json',
    '%2e%2e/x.json',
  ])('%s 는 거절한다', async (name) => {
    await expect(readPresetFile(name, root)).rejects.toBeInstanceOf(SimFileError);
  });

  it('한글·괄호가 든 정상 이름은 받는다', async () => {
    await write('preset', '001_주차장 (본관).json', { datas: [] });
    expect(await readPresetFile('001_주차장 (본관).json', root)).toEqual([]);
  });
});
