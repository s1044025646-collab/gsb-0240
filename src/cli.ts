#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { Store, ApiError } from "./db";
import { buildTree, generateProof, verifyProof } from "./merkle";
import { startServer } from "./server";

const DATA_DIR = path.join(__dirname, "..", "data");
const DEFAULT_DB = path.join(DATA_DIR, "merkle.db");

function parseArgs(argv: string[]) {
  const args: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    } else {
      args.push(argv[i]);
    }
  }
  return { args, opts };
}

function fail(e: unknown): never {
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(`错误 ${(e as Error).message}`);
  }
  process.exit(1);
}

const USAGE = `用法: node dist/src/cli.js <命令> [参数]
命令:
  serve [--db 路径] [--port 端口]        启动 HTTP API（默认端口 0=自动选空闲端口）
  new <名称> [--db 路径]                 新建清单
  import <清单ID> <记录...> [--db 路径]  批量导入为新版本（也可用 --file JSON数组文件）
  lists                                  列出清单
  versions <清单ID>                      列出版本
  records <版本ID>                       查看记录
  levels <版本ID>                        查看各层摘要与根
  proof <版本ID> <索引> [--out 文件]     导出包含证明 JSON（含根与内容）
  verify <证明文件>                      独立验证证明（不依赖数据库）
  compare <版本A> <版本B>                比较两个版本
  demo                                   运行 3/5 条记录演示
`;

async function main() {
  const { args, opts } = parseArgs(process.argv.slice(2));
  const cmd = args[0];
  const dbPath = opts.db ? path.resolve(opts.db) : DEFAULT_DB;

  if (!cmd || cmd === "help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "serve") {
    const port = opts.port ? Number(opts.port) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      fail(new ApiError("INVALID_ARGUMENT", "端口必须是 0-65535 的整数"));
    }
    await startServer(dbPath, port);
    return;
  }
  if (cmd === "demo") {
    const { runDemo } = await import("./demo");
    await runDemo(path.join(DATA_DIR, "demo.db"));
    return;
  }

  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "new": {
        if (!args[1]) throw new ApiError("INVALID_ARGUMENT", "缺少清单名称");
        console.log(JSON.stringify({ listId: store.createList(args[1]) }));
        break;
      }
      case "import": {
        const listId = Number(args[1]);
        let records: string[];
        if (opts.file) {
          records = JSON.parse(fs.readFileSync(opts.file, "utf8"));
        } else {
          records = args.slice(2);
        }
        console.log(JSON.stringify(store.addVersion(listId, records), null, 2));
        break;
      }
      case "lists":
        console.log(JSON.stringify(store.listLists(), null, 2));
        break;
      case "versions":
        console.log(JSON.stringify(store.listVersions(Number(args[1])), null, 2));
        break;
      case "records": {
        const items = store.getRecords(Number(args[1]));
        items.forEach((b, i) => console.log(`${i}: ${b.toString("utf8")}`));
        break;
      }
      case "levels": {
        const { levels, root } = buildTree(store.getRecords(Number(args[1])));
        console.log(`root: ${root.toString("hex")}`);
        levels.forEach((l, i) =>
          console.log(`level ${i}: ${l.map((d) => d.toString("hex")).join("  ")}`)
        );
        break;
      }
      case "proof": {
        const vid = Number(args[1]);
        const idx = Number(args[2]);
        const items = store.getRecords(vid);
        if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
          throw new ApiError("INVALID_ARGUMENT", `index 必须是 [0, ${items.length}) 的整数`);
        }
        const out = {
          root: buildTree(items).root.toString("hex"),
          content: items[idx].toString("utf8"),
          proof: generateProof(items, idx),
        };
        const json = JSON.stringify(out, null, 2);
        if (opts.out) {
          fs.writeFileSync(opts.out, json, "utf8");
          console.log(`证明已导出: ${opts.out}`);
        } else {
          console.log(json);
        }
        break;
      }
      case "verify": {
        if (!args[1]) throw new ApiError("INVALID_ARGUMENT", "缺少证明文件路径");
        const data = JSON.parse(fs.readFileSync(args[1], "utf8"));
        const result = verifyProof(
          data.root,
          Buffer.from(data.content, "utf8"),
          data.proof
        );
        console.log(JSON.stringify(result));
        if (!result.valid) process.exit(2);
        break;
      }
      case "compare":
        console.log(
          JSON.stringify(store.compareVersions(Number(args[1]), Number(args[2])), null, 2)
        );
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } catch (e) {
    fail(e);
  } finally {
    store.close();
  }
}

main();
