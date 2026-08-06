import { createRequire } from 'node:module';

/**
 * `node:sqlite` 를 여는 **유일한 자리**.
 *
 * 왜 `import { DatabaseSync } from 'node:sqlite'` 를 직접 쓰지 않는가 —
 * 이 모듈은 Node 22.5 에 들어온 신규 내장이라 번들러(여기서는 vitest 가 쓰는 Vite)의
 * 내장 목록에 아직 없다. 정적 import 를 두면 해석 단계에서 `sqlite` 라는 npm 패키지를
 * 찾다가 실패한다(`Failed to load url sqlite`). 테스트가 아예 수집되지 않는다.
 *
 * `createRequire` 로 **런타임에** 부르면 번들러가 볼 명세자가 없어 그 경로를 타지 않는다.
 * 타입은 `import type` 으로 따로 가져오는데, 그쪽은 컴파일 때 지워지므로 안전하다.
 *
 * 이 우회는 번들러 사정이지 런타임 사정이 아니다 — Node 는 어느 쪽이든 같은 내장을 준다.
 */
const nodeRequire = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type SqliteModule = typeof import('node:sqlite');

export const { DatabaseSync } = nodeRequire('node:sqlite') as SqliteModule;
export type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
