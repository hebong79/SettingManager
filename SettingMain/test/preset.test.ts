import { describe, expect, it } from 'vitest';
import { addPreset, listFor, PresetError, removePreset, updatePreset, type Preset } from '../src/domain/preset.js';

const NOW = '2026-07-31T00:00:00.000Z';

function seed(): Preset[] {
  return [
    { id: 'p-1', cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 100, tilt: 200, zoom: 300 }, updatedAt: NOW },
    { id: 'p-2', cameraId: 'cam-b', name: '정문 와이드', ptz: { pan: 1, tilt: 2, zoom: 3 }, updatedAt: NOW },
  ];
}

describe('listFor', () => {
  it('카메라별로 가른다 — 프리셋은 카메라마다 별개의 좌표계다', () => {
    expect(listFor(seed(), 'cam-a').map((p) => p.id)).toEqual(['p-1']);
  });
});

describe('addPreset', () => {
  it('현재 목록을 건드리지 않고 새 목록을 낸다', () => {
    const before = seed();
    const { presets, preset } = addPreset(before, { cameraId: 'cam-a', name: '후문', ptz: { pan: 5, tilt: 6, zoom: 7 } }, NOW, 'p-3');
    expect(before).toHaveLength(2);
    expect(presets).toHaveLength(3);
    expect(preset.id).toBe('p-3');
  });

  it('도달범위 밖 좌표는 저장 전에 자른다 — 못 가는 자리를 프리셋으로 남기지 않는다', () => {
    const { preset } = addPreset(seed(), { cameraId: 'cam-a', name: '한계', ptz: { pan: 36100, tilt: 12000, zoom: -1 } }, NOW, 'p-3');
    expect(preset.ptz).toEqual({ pan: 100, tilt: 9000, zoom: 0 });
  });

  it('같은 카메라 안에서 이름이 겹치면 409 로 막는다 — 콤보박스에서 구분이 안 되면 잘못 이동한다', () => {
    expect(() => addPreset(seed(), { cameraId: 'cam-a', name: '정문 와이드', ptz: { pan: 0, tilt: 0, zoom: 0 } }, NOW, 'p-3'))
      .toThrow(PresetError);
  });

  it('다른 카메라에서는 같은 이름을 허용한다', () => {
    const { presets } = addPreset(seed(), { cameraId: 'cam-c', name: '정문 와이드', ptz: { pan: 0, tilt: 0, zoom: 0 } }, NOW, 'p-3');
    expect(presets).toHaveLength(3);
  });

  it('빈 이름은 거부한다', () => {
    expect(() => addPreset(seed(), { cameraId: 'cam-a', name: '   ', ptz: { pan: 0, tilt: 0, zoom: 0 } }, NOW, 'p-3')).toThrow(/이름/);
  });
});

describe('updatePreset', () => {
  it('이름만 바꾼다', () => {
    const { preset } = updatePreset(seed(), 'p-1', { name: '정문 클로즈업' }, '2026-08-01T00:00:00.000Z');
    expect(preset.name).toBe('정문 클로즈업');
    expect(preset.ptz).toEqual({ pan: 100, tilt: 200, zoom: 300 });
    expect(preset.updatedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('PTZ 만 바꾼다', () => {
    const { preset } = updatePreset(seed(), 'p-1', { ptz: { pan: 9, tilt: 8, zoom: 7 } }, NOW);
    expect(preset.name).toBe('정문 와이드');
    expect(preset.ptz).toEqual({ pan: 9, tilt: 8, zoom: 7 });
  });

  it('자기 이름을 그대로 두는 것은 중복이 아니다', () => {
    expect(() => updatePreset(seed(), 'p-1', { name: '정문 와이드' }, NOW)).not.toThrow();
  });

  it('없는 id 는 404', () => {
    expect(() => updatePreset(seed(), 'ghost', { name: 'x' }, NOW)).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('removePreset', () => {
  it('해당 항목만 지운다', () => {
    const { presets, removed } = removePreset(seed(), 'p-1');
    expect(removed.id).toBe('p-1');
    expect(presets.map((p) => p.id)).toEqual(['p-2']);
  });

  it('없는 id 는 404', () => {
    expect(() => removePreset(seed(), 'ghost')).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});
