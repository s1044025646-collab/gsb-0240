
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { MerkleStore } from './store.js';
import { verifyProof, FORMAT_VERSION } from './merkle.js';
import { statusForCode } from './errors.js';

export const DEFAULT_DATA_DIR = resolve(process.cwd(), 'data');

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: unknown, store: MerkleStore) => unknown | Promise<unknown>;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: () => ({ ok: true, format: FORMAT_VERSION }) },
  { method: 'GET', pattern: /^\/api\/lists$/, handler: (_p, _b, store) => ({ lists: store.listAll() }) },
  { method: 'POST', pattern: /^\/api\/lists$/, handler: (_p, body, store) => {
    const { name, records, note } = asBody(body);
    return store.createList(reqStr(name, 'name'), asRecords(records), optStr(note));
  } },
  { method: 'GET', pattern: /^\/api\/lists\/(?<name>[^/]+)\/versions$/, handler: (p, _b, store) => ({
    name: p.name!, versions: store.listVersions(decodeName(p.name!)),
  }) },
  { method: 'POST', pattern: /^\/api\/lists\/(?<name>[^/]+)\/versions$/, handler: (p, body, store) => {
    const { records, note, mode } = asBody(body);
    return store.appendVersion(decodeName(p.name!), asRecords(records), optStr(note), mode === 'replace' ? 'replace' : 'append');
  } },
  { method: 'GET', pattern: /^\/api\/lists\/(?<name>[^/]+)\/versions\/(?<version>latest|\d+)$/, handler: (p, _b, store) =>
    store.getVersion(decodeName(p.name!), parseVersion(p.version!)),
  },
  { method: 'GET', pattern: /^\/api\/lists\/(?<name>[^/]+)\/versions\/(?<version>latest|\d+)\/proof\/(?<index>\d+)$/, handler: (p, _b, store) =>
    store.getProof(decodeName(p.name!), parseVersion(p.version!), Number(p.index)),
  },
  { method: 'POST', pattern: /^\/api\/lists\/(?<name>[^/]+)\/compare$/, handler: (p, body, store) => {
    const { from, to } = asBody(body);
    return store.compareVersions(decodeName(p.name!), reqInt(from, 'from'), reqInt(to, 'to'));
  } },
  { method: 'POST', pattern: /^\/api\/verify$/, handler: (_p, body, _store) => {
    const { root, proof, content } = asBody(body);
    return verifyProof({ rootHex: reqStr(root, 'root'), proof, content: reqStr(content, 'content') });
  } },
];

function decodeName(raw: string): string {
  return decodeURIComponent(raw);
}

function parseVersion(raw: string): number | 'latest' {
  if (raw === 'latest') return 'latest';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw httpError('BAD_PARAM', '版本号必须是正整数或 latest');
  return n;
}

function asBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') throw httpError('BAD_PARAM', '请求体必须是 JSON 对象');
  return body as Record<string, unknown>;
}

function reqStr(value: unknown, field: string): string {
  if (typeof value !== 'string') throw httpError('BAD_PARAM', `缺少字符串字段：${field}`);
  return value;
}

function optStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function reqInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw httpError('BAD_PARAM', `缺少整数字段：${field}`);
  return value;
}

function asRecords(value: unknown): string[] {
  if (!Array.isArray(value)) throw httpError('BAD_PARAM', 'records 必须是 UTF-8 文本字符串数组');
  if (value.some((r) => typeof r !== 'string')) {
    throw httpError('BAD_PARAM', 'records 中每一项都必须是字符串（按 UTF-8 原始字节处理）');
  }
  return value as string[];
}

function httpError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function readJson(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectPromise(httpError('BAD_PARAM', `请求体超过 ${maxBytes} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(httpError('BAD_PARAM', '请求体不是合法 JSON'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

export function createApp(store: MerkleStore): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        sendJson(res, 200, {
          service: 'ordered-merkle-proof-backend',
          format: FORMAT_VERSION,
          endpoints: [
            'GET  /api/health',
            'GET  /api/lists',
            'POST /api/lists',
            'GET  /api/lists/:name/versions',
            'POST /api/lists/:name/versions',
            'GET  /api/lists/:name/versions/:version',
            'GET  /api/lists/:name/versions/:version/proof/:index',
            'POST /api/lists/:name/compare',
            'POST /api/verify',
          ],
        });
        return;
      }
      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname),
      );
      if (!route) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${req.method} ${url.pathname}` } });
        return;
      }
      const body = req.method === 'POST' ? await readJson(req) : {};
      const match = url.pathname.match(route.pattern)!;
      const result = await route.handler(match.groups ?? {}, body, store);
      sendJson(res, 200, result);
    } catch (err) {
      const code = (err as Error & { code?: string }).code ?? 'INTERNAL';
      const status = statusForCode(code);
      sendJson(res, status, { error: { code, message: (err as Error).message } });
    }
  });
  return server;
}

/** 让操作系统分配空闲端口（port=0），也可用 PORT 环境变量固定。 */
export function listen(server: Server, port = Number(process.env.PORT ?? 0), host = process.env.HOST ?? '127.0.0.1'): Promise<{ port: number; host: string }> {
  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolvePromise({ port: address.port, host: address.address });
      } else {
        resolvePromise({ port, host });
      }
    });
  });
}

/** 列出局域网地址（仅展示，服务默认只绑定回环地址）。 */
export function describeLanAddresses(port: number): string[] {
  const out: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${port}`);
    }
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const dbPath = process.env.DB_PATH ?? resolve(DEFAULT_DATA_DIR, 'merkle.db');
  const store = new MerkleStore(dbPath);
  const server = createApp(store);
  listen(server).then(({ port, host }) => {
    console.log(JSON.stringify({
      message: '有序数据清单 Merkle 包含证明服务已启动',
      format: FORMAT_VERSION,
      baseUrl: `http://${host}:${port}`,
      lan: describeLanAddresses(port),
      dbPath,
    }, null, 2));
  });
}
