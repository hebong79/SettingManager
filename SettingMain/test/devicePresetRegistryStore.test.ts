import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevicePresetRegistryStore } from '../src/store/devicePresetRegistryStore.js';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function store(): Promise<DevicePresetRegistryStore> {
  directory = await mkdtemp(join(tmpdir(), 'device-preset-registry-'));
  const result = new DevicePresetRegistryStore(join(directory, 'device-preset-registry.json'), () => '2026-08-02T00:00:00.000Z');
  await result.load();
  return result;
}

describe('DevicePresetRegistryStore', () => {
  it('real-camera-2 seed와 generic fallback을 분리하며 학습은 원자 JSON으로 남긴다', async () => {
    const registry = await store();
    expect(registry.list('real-camera-2', 10).slice(0, 2)).toMatchObject([
      { number: 1, name: 'EV1', flags: ['seeded', 'unlearned'] },
      { number: 2, name: 'EV2', flags: ['seeded', 'unlearned'] },
    ]);
    expect(registry.list('other', 10)).toHaveLength(10);
    await registry.learn('other', 3, { pan: 100, tilt: 200, zoom: 300 });
    const saved = JSON.parse(await readFile(registry.path, 'utf8'));
    expect(saved.cameras['real-camera-2'].slice(0, 2)).toMatchObject([{ number: 1, name: 'EV1' }, { number: 2, name: 'EV2' }]);
    expect(saved.cameras.other).toEqual([{ number: 3, name: null, seeded: false, ptz: { pan: 100, tilt: 200, zoom: 300 }, learnedAt: '2026-08-02T00:00:00.000Z' }]);
    expect(await readFile(`${registry.path}.tmp`, 'utf8').catch(() => '')).toBe('');
  });

  it('손상 레지스트리를 빈 값으로 조용히 덮어쓰지 않는다', async () => {
    const registry = await store();
    await writeFile(registry.path, '{not-json', 'utf8');
    const reload = new DevicePresetRegistryStore(registry.path);
    await expect(reload.load()).rejects.toThrow(/레지스트리/);
  });
});
