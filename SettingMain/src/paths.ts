import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 서비스 루트 경로. **별도 모듈인 이유는 순환 import 때문이다** —
 * `config/configStore` 가 `db/*` 를 부르고, `db/database` 가 기본 DB 경로를 알아야 한다.
 * 둘 중 한쪽에 두면 모듈 초기화 순서에 따라 값이 `undefined` 로 읽힌다(실제로 겪었다).
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** `src/` → 서비스 루트(SettingMain) */
export const SERVICE_ROOT = resolve(HERE, '..');
export const CONFIG_DIR = resolve(SERVICE_ROOT, 'config');
