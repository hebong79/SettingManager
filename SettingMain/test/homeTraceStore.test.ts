import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HomeTraceError, HomeTraceStore, isSafeSegment, type HomeStep } from '../src/homing/homeTraceStore.js';

let dir = '';
let store: HomeTraceStore;

const step = (n: number, hasFrame = true): HomeStep =>
  ({ step: n, zoom: 8000 + n * 1500, found: true, boxes: [[10, 10, 50, 30]], pick: [10, 10, 50, 30], hasFrame });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trace-'));
  store = new HomeTraceStore({ dir });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('호밍 과정 저장소', () => {
  it('프레임과 스텝 기록을 저장하고 다시 읽는다', async () => {
    await store.begin('cam-1', 'p-1', 'pt-1');
    expect(await store.putFrame('cam-1', 'p-1', 'pt-1', 1, Buffer.from('jpeg-1'))).toBe(true);
    await store.commit('cam-1', 'p-1', 'pt-1', [step(1)], '1번');

    const trace = await store.read('cam-1', 'p-1', 'pt-1');
    expect(trace?.name).toBe('1번');
    expect(trace?.steps).toHaveLength(1);
    expect((await store.frame('cam-1', 'p-1', 'pt-1', 1))?.toString()).toBe('jpeg-1');
  });

  /** 화면이 경로를 조립하면 서버의 검증과 어긋난다 — URL 은 저장소만 만든다. */
  it('프레임이 있는 스텝에만 frameUrl 을 붙인다', async () => {
    await store.begin('cam-1', 'p-1', 'pt-1');
    await store.commit('cam-1', 'p-1', 'pt-1', [step(1, true), step(2, false)]);
    const trace = await store.read('cam-1', 'p-1', 'pt-1');
    expect(trace!.steps[0]!.frameUrl).toBe('/api/core/home-frame/cam-1/p-1/pt-1/1');
    expect(trace!.steps[1]!.frameUrl).toBeUndefined();
  });

  /**
   * 6스텝 위에 3스텝을 얹으면 4~6번 프레임이 남아, 이번에 보지도 않은 그림이
   * 이번 결과의 근거처럼 보인다.
   */
  it('재호밍은 옛 프레임을 덮지 않고 지운다', async () => {
    await store.begin('cam-1', 'p-1', 'pt-1');
    await store.putFrame('cam-1', 'p-1', 'pt-1', 6, Buffer.from('old'));
    await store.begin('cam-1', 'p-1', 'pt-1');
    expect(await store.frame('cam-1', 'p-1', 'pt-1', 6)).toBeNull();
  });

  /** 점 id 는 프리셋 안에서만 1부터다 — 카메라를 빼면 B 의 호밍이 A 의 프레임을 지운다. */
  it('카메라가 다르면 같은 p-1/pt-1 이라도 서로를 지우지 않는다', async () => {
    await store.begin('cam-A', 'p-1', 'pt-1');
    await store.putFrame('cam-A', 'p-1', 'pt-1', 1, Buffer.from('A'));
    await store.begin('cam-B', 'p-1', 'pt-1');
    expect((await store.frame('cam-A', 'p-1', 'pt-1', 1))?.toString()).toBe('A');
  });

  it('기록이 없으면 null — 오류가 아니다', async () => {
    expect(await store.read('cam-1', 'p-9', 'pt-9')).toBeNull();
    expect(await store.frame('cam-1', 'p-9', 'pt-9', 1)).toBeNull();
  });

  it('프레임 저장 실패는 잡을 멈추지 않는다 — false 를 돌려준다', async () => {
    // begin 없이 쓰면 디렉터리가 없다.
    expect(await store.putFrame('cam-1', 'p-2', 'pt-2', 1, Buffer.from('x'))).toBe(false);
  });

  describe('경로 조작 방어', () => {
    it('`..` 가 든 조각을 거절한다 — 하나로 저장소 밖이 열린다', async () => {
      await expect(store.read('..', 'p-1', 'pt-1')).rejects.toThrow(HomeTraceError);
      await expect(store.read('cam-1', '../../etc', 'pt-1')).rejects.toThrow(HomeTraceError);
      await expect(store.frame('cam-1', 'p-1', 'pt/1', 1)).rejects.toThrow(HomeTraceError);
    });

    it('스텝 번호가 정수 범위 밖이면 거절한다', async () => {
      await expect(store.frame('cam-1', 'p-1', 'pt-1', 0)).rejects.toThrow(HomeTraceError);
      await expect(store.frame('cam-1', 'p-1', 'pt-1', 1.5)).rejects.toThrow(HomeTraceError);
    });

    it.each([
      ['cam-1', true], ['p-1', true], ['pt-12', true], ['a.b', true],
      ['..', false], ['.', false], ['a/b', false], ['a\\b', false], ['', false], ['a b', false],
    ])('isSafeSegment(%s) = %s', (value, expected) => {
      expect(isSafeSegment(value)).toBe(expected);
    });
  });
});
