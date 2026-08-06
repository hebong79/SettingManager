import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR } from '../paths.js';
import { ConfigError, mergeSettings, normalizeConfig } from './normalize.js';
import { importCameras, readCameras } from '../db/configCameras.js';
import type { AppConfig, SettingsPatch } from './types.js';

export { SERVICE_ROOT } from '../paths.js';
export const DEFAULT_CONFIG_PATH = resolve(CONFIG_DIR, 'config.json');

/**
 * 설정을 읽고 쓰는 단일 지점.
 *
 * **카메라만은 이 파일이 아니라 DB(`camera_info`)가 정본이다.** `load()` 가 그 표를 읽어
 * `cameras` 를 채우므로, 읽는 쪽(`driverFactory`·라우트·화면)은 예전 그대로 `config.cameras` 를 본다.
 *
 * 그래서 규칙이 하나 생긴다 — **DB 의 카메라를 고쳤으면 `reloadCameras()` 를 불러야 한다.**
 * 안 부르면 메모리의 배열이 옛 값이라, 방금 바꾼 URL 이 아니라 이전 주소로 명령이 나간다.
 */
export class ConfigStore {
  private cached: AppConfig | null = null;
  private db: DatabaseSync | null = null;

  constructor(readonly path: string = DEFAULT_CONFIG_PATH, db?: DatabaseSync) {
    this.db = db ?? null;
  }

  /** 카메라 정본이 될 DB 를 붙인다. `load()` 전에 불러야 한다. */
  attachDatabase(db: DatabaseSync): void {
    this.db = db;
  }

  async load(): Promise<AppConfig> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (cause) {
      throw new ConfigError(`설정 파일을 읽을 수 없습니다: ${this.path}`, 400, { cause });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      // 파싱 실패를 빈 설정으로 흘리면 저장 한 번에 원본이 통째로 날아간다.
      throw new ConfigError(`설정 파일 JSON 파싱 실패 — 덮어쓰기를 거부합니다: ${this.path}`, 400, { cause });
    }
    const raw = parsed as Record<string, unknown>;
    const config = normalizeConfig(raw);

    if (this.db) {
      // 옛 설정에 카메라가 남아 있으면 **한 번만** 옮기고, 대조를 통과했을 때만 파일에서 지운다.
      if (Array.isArray(raw.cameras) && raw.cameras.length > 0) {
        await this.migrateCameras(raw);
      }
      config.cameras = readCameras(this.db);
    }
    config.activeCameraId = pickActive(config);

    this.cached = config;
    return this.cached;
  }

  /**
   * DB 의 카메라를 메모리로 다시 읽는다. **카메라를 쓰기한 라우트가 반드시 부른다.**
   * 이것이 이 설계의 유일한 함정이라 이름을 눈에 띄게 두었다.
   */
  reloadCameras(): AppConfig {
    const config = this.get();
    if (!this.db) return config;
    const next: AppConfig = { ...config, cameras: readCameras(this.db) };
    next.activeCameraId = pickActive(next);
    this.cached = next;
    return next;
  }

  /**
   * `config.json` → DB 1회 이관.
   *
   * 순서가 안전장치다: **백업 → 이관 → 대조 → 통과했을 때만 파일에서 제거.**
   * `config.json` 은 `.gitignore` 대상이라 실 IP·계정이 git 어디에도 없다 — 대조 없이 지우면
   * 되돌릴 곳이 사라진다. 대조가 어긋나면 **파일을 손대지 않고 그대로 둔다.**
   */
  private async migrateCameras(raw: Record<string, unknown>): Promise<void> {
    const backup = `${this.path}.bak-cameras`;
    await copyFile(this.path, backup);

    const result = importCameras(this.db!, raw.cameras as unknown[]);
    if (result.mismatches.length > 0) {
      throw new ConfigError(
        [
          `카메라를 DB 로 옮기는 중 값이 달라졌습니다 — config.json 을 그대로 두었습니다 (백업: ${backup})`,
          ...result.mismatches,
        ].join('\n'),
      );
    }

    const { cameras, ...rest } = raw;
    await this.writeRaw(rest);
    console.log(`카메라 ${result.imported.length}대를 DB 로 옮겼습니다 (건너뜀 ${result.skipped.length}대) — 백업: ${backup}`);
  }

  private async writeRaw(value: unknown): Promise<void> {
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, this.path);
  }

  get(): AppConfig {
    if (!this.cached) throw new ConfigError('설정이 아직 로드되지 않았습니다');
    return this.cached;
  }

  /** 부분 갱신 후 저장. 반환값은 갱신된 전체 설정이다. */
  async patch(patch: SettingsPatch): Promise<AppConfig> {
    const next = mergeSettings(this.get(), patch);
    await this.write(next);
    this.cached = next;
    return next;
  }

  /** 파일에는 **카메라를 쓰지 않는다** — 그 정본은 DB 다. */
  private async write(config: AppConfig): Promise<void> {
    const { cameras, ...rest } = config;
    await this.writeRaw(rest);
  }
}

/**
 * 활성 카메라를 고른다. 가리키는 기기가 없으면 첫 기기로 옮긴다 —
 * 활성이 유령 id 를 가리키면 그 카메라로 가는 모든 요청이 404 가 된다.
 */
function pickActive(config: AppConfig): string {
  if (config.cameras.some((camera) => camera.id === config.activeCameraId)) return config.activeCameraId;
  return config.cameras[0]?.id ?? '';
}
