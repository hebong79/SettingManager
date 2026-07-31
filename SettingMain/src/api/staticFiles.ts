import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import { SERVICE_ROOT } from '../config/configStore.js';

export const WEB_ROOT = resolve(SERVICE_ROOT, 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 정적 파일 서빙. web/ 밖으로 나가는 경로는 거부한다. */
export async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(WEB_ROOT, normalize(relative));
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return false;

  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return false;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    // no-cache 가 아니라 no-store 다. 서버를 고치고 재기동했는데 브라우저가 옛 화면을 들고 있으면
    // 그 화면이 낡은 필드명·낡은 값으로 설정을 되돌린다(실제로 겪은 결함).
    'cache-control': 'no-store',
  });
  res.end(body);
  return true;
}
