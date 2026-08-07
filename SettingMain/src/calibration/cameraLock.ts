import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.js';
import type { PtzRaw } from '../domain/ptz.js';

/**
 * 유언장 — **카메라를 어디로 되돌려야 하는지를 디스크에 먼저 남긴다.**
 *
 * 근거: baro_calory `apps/backend-core/src/camera-lock.mjs`.
 *
 * ## 왜 메모리로는 안 되는가
 *
 * 스윕은 20분간 카메라를 통째로 점유하고 고배율로 돌린다. 그 사이에 `pm2 restart`·배포·OOM 이
 * 들어오면 잡의 `finally` 에 있는 홈 복귀도 **같이 죽는다.** 그러면 카메라는 20배 줌으로 하늘을
 * 본 채 남고, 아무도 원래 어디를 보고 있었는지 모른다.
 *
 * 그래서 순서가 이렇다: **홈 자세를 파일로 남긴다 → 스윕한다 → 복귀에 성공했을 때만 찢는다.**
 * 복귀에 실패하면 락을 **남겨** 다음 기동이 대신 되돌린다.
 */

export interface CameraLock {
  cameraId: string;
  job: string;
  home: PtzRaw;
  heldAt: string;
}

export interface CameraLockStoreOptions {
  dir?: string;
  now?: () => string;
}

export class CameraLockStore {
  private readonly dir: string;
  private readonly now: () => string;

  constructor(options: CameraLockStoreOptions = {}) {
    this.dir = options.dir ?? join(CONFIG_DIR, 'camera-locks');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 스윕 **시작 전에** 부른다. 이 파일이 없으면 복귀 보장도 없다. */
  async hold(cameraId: string, job: string, home: PtzRaw): Promise<CameraLock> {
    const lock: CameraLock = { cameraId, job, home, heldAt: this.now() };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.fileOf(cameraId), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    return lock;
  }

  /** **복귀에 성공했을 때만** 부른다. 실패했는데 찢으면 다음 기동이 되돌릴 근거를 잃는다. */
  async release(cameraId: string): Promise<void> {
    await rm(this.fileOf(cameraId), { force: true });
  }

  async read(cameraId: string): Promise<CameraLock | null> {
    try {
      return JSON.parse(await readFile(this.fileOf(cameraId), 'utf8')) as CameraLock;
    } catch {
      return null;
    }
  }

  /**
   * 남아 있는 유언장 전부 — **기동 시 이것을 읽어 되돌린다.**
   * 비어 있는 것이 정상이다. 하나라도 있으면 지난번에 무언가 비정상 종료했다는 뜻이다.
   */
  async pending(): Promise<CameraLock[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const locks: CameraLock[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        locks.push(JSON.parse(await readFile(join(this.dir, name), 'utf8')) as CameraLock);
      } catch {
        // 깨진 유언장은 되돌릴 근거가 못 된다. 조용히 건너뛴다 — 이것 때문에 기동이 막히면 안 된다.
      }
    }
    return locks;
  }

  private fileOf(cameraId: string): string {
    return join(this.dir, `${cameraId.replace(/[^\w.-]/g, '_')}.json`);
  }
}
