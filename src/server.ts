import * as http from "node:http";
import { Store, ApiError } from "./db";
import { buildTree, generateProof, verifyProof } from "./merkle";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("INVALID_ARGUMENT", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body =
        method === "POST" || method === "PUT" ? await readBody(req) : {};

      // POST /lists {name, records?}
      if (method === "POST" && parts.length === 1 && parts[0] === "lists") {
        const id = store.createList(body.name);
        let version = null;
        if (body.records !== undefined) {
          version = store.addVersion(id, body.records);
        }
        return send(res, 201, { listId: id, version });
      }
      // GET /lists
      if (method === "GET" && parts.length === 1 && parts[0] === "lists") {
        return send(res, 200, { lists: store.listLists() });
      }
      // POST /lists/:id/versions {records}
      if (
        method === "POST" &&
        parts.length === 3 &&
        parts[0] === "lists" &&
        parts[2] === "versions"
      ) {
        const v = store.addVersion(Number(parts[1]), body.records);
        return send(res, 201, { version: v });
      }
      // GET /lists/:id/versions
      if (
        method === "GET" &&
        parts.length === 3 &&
        parts[0] === "lists" &&
        parts[2] === "versions"
      ) {
        return send(res, 200, { versions: store.listVersions(Number(parts[1])) });
      }
      // /versions/:id/...
      if (parts.length >= 2 && parts[0] === "versions") {
        const vid = Number(parts[1]);
        if (parts.length === 2 && method === "GET") {
          return send(res, 200, { version: store.getVersion(vid) });
        }
        if (parts[2] === "records" && method === "GET") {
          const items = store.getRecords(vid);
          return send(res, 200, {
            records: items.map((b, i) => ({ index: i, text: b.toString("utf8"), bytesHex: b.toString("hex") })),
          });
        }
        if (parts[2] === "levels" && method === "GET") {
          const { levels, root } = buildTree(store.getRecords(vid));
          return send(res, 200, {
            root: root.toString("hex"),
            levels: levels.map((l, i) => ({ level: i, digests: l.map((d) => d.toString("hex")) })),
          });
        }
        if (parts[2] === "proof" && method === "GET") {
          const idx = Number(url.searchParams.get("index"));
          const items = store.getRecords(vid);
          if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
            throw new ApiError("INVALID_ARGUMENT", `index 必须是 [0, ${items.length}) 的整数`);
          }
          const proof = generateProof(items, idx);
          return send(res, 200, {
            root: buildTree(items).root.toString("hex"),
            content: items[idx].toString("utf8"),
            proof,
          });
        }
      }
      // POST /verify {root, content, proof}
      if (method === "POST" && parts[0] === "verify") {
        if (typeof body.root !== "string" || typeof body.content !== "string" || !body.proof) {
          throw new ApiError("INVALID_ARGUMENT", "需要 root(string)、content(string)、proof(object)");
        }
        const result = verifyProof(body.root, Buffer.from(body.content, "utf8"), body.proof);
        return send(res, 200, result);
      }
      // POST /compare {versionA, versionB}
      if (method === "POST" && parts[0] === "compare") {
        return send(res, 200, store.compareVersions(Number(body.versionA), Number(body.versionB)));
      }
      throw new ApiError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: (e as Error).message } });
    }
  });
}

export function startServer(dbPath: string, port: number): Promise<http.Server> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`Merkle 清单服务已启动: http://127.0.0.1:${actual} (数据: ${dbPath})`);
      resolve(server);
    });
  });
}
