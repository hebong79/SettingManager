import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCamera, ConfigError, mergeSettings, normalizeConfig, removeCamera } from './normalize.js';
import type { AppConfig, CameraConfig, SettingsPatch } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/config/ → 서비스 루트(SettingMain) */
export const SERVICE_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_CONFIG_PATH = resolve(SERVICE_ROOT, 'config', 'config.json');

/**
 * config.json 을 읽고 쓰는 단일 지점.
 * 메모리에 캐시한 값이 정본이고, 저장은 임시파일 → rename 으로 원자적으로 한다
 * (쓰다 죽어도 반쯤 쓰인 설정이 남지 않는다).
 */
export class ConfigStore {
  private cached: AppConfig | null = null;

  constructor(readonly path: string = DEFAULT_CONFIG_PATH) {}

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
    this.cached = normalizeConfig(parsed);
    return this.cached;
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

  async addCamera(input: Partial<CameraConfig> & { id: string }): Promise<{ config: AppConfig; camera: CameraConfig }> {
    const result = addCamera(this.get(), input);
    await this.write(result.config);
    this.cached = result.config;
    return result;
  }

  async removeCamera(id: string): Promise<{ config: AppConfig; removed: CameraConfig }> {
    const result = removeCamera(this.get(), id);
    await this.write(result.config);
    this.cached = result.config;
    return result;
  }

  private async write(config: AppConfig): Promise<void> {
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(temp, this.path);
  }
}
