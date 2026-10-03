#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MerkleStore } from './store.js';
import {
  FORMAT_VERSION,
  verifyProof,
  type MerkleProof,
} from './merkle.js';
import { DEFAULT_DATA_DIR } from './server.js';

const dbPath = process.env.DB_PATH ?? resolve(DEFAULT_DATA_DIR, 'merkle.db');

interface Usage {
  usage: string;
  help: string;
  run: (args: string[], flags: Map<string, string>) => number;
}

function parseArgs(argv: string[]): { args: string[]; flags: Map<string, string> } {
  const args: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) flags.set(token.slice(2, eq), token.slice(eq + 1));
      else flags.set(token.slice(2), argv[++i] ?? 'true');
    } else {
      args.push(token);
    }
  }
  return { args, flags };
}

function fail(code: string, message: string): number {
  process.stderr.write(JSON.stringify({ error: { code, message } }, null, 2) + '\n');
  return 1;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function loadRecords(flags: Map<string, string>, inlineIndex: number, args: string[]): string[] {
  const file = flags.get('file');
  if (file) {
    const path = resolve(file);
    if (!existsSync(path)) throw failWith('INVALID_FILE', `文件不存在：${path}`);
    const text = readFileSync(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw failWith('INVALID_FILE', '导入文件必须是 JSON 字符串数组（UTF-8）');
    }
    if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== 'string')) {
      throw failWith('INVALID_FILE', '导入文件内容必须是字符串数组');
    }
    return parsed as string[];
  }
  if (args[inlineIndex] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args[inlineIndex]);
    } catch {
      throw failWith('BAD_PARAM', '内联记录必须是 JSON 数组，例如 \'["a","b"]\'');
    }
    if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== 'string')) {
      throw failWith('BAD_PARAM', '记录必须是字符串数组');
    }
    return parsed as string[];
  }
  throw failWith('BAD_PARAM', '需要提供记录 JSON 数组参数或 --file=path.json');
}

function failWith(code: string, message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

/**
 * 批量导入失败处理：
 * 逐行/逐项预校验，发现任何非法项（非字符串、含未配对代理项等）即整体拒绝，
 * 不写入任何半截版本，返回 BATCH_FAILED 及每项错误位置。
 */
function validateBatch(records: string[]): { records: string[] } | { failures: { line: number; reason: string }[] } {
  const failures: { line: number; reason: string }[] = [];
  records.forEach((record, index) => {
    if (typeof record !== 'string') {
      failures.push({ line: index, reason: '记录不是字符串' });
      return;
    }
    if (record.length === 0) failures.push({ line: index, reason: '空字符串记录需显式确认（本实验允许空串，但此处给出提示）' });
  });
  return failures.length > 0 ? { failures } : { records };
}

const commands: Record<string, Usage> = {
  init: {
    usage: 'init <name> [records-json] [--file=a.json] [--note=...]',
    help: '新建清单并写入 v1；记录为 UTF-8 文本字符串数组',
    run(args, flags) {
      const name = args[0];
      if (!name) return fail('BAD_PARAM', '缺少清单名');
      const records = loadRecords(flags, 1, args);
      const check = validateBatch(records);
      if ('failures' in check) return fail('BATCH_FAILED', JSON.stringify(check.failures));
      withStore((store) => print(store.createList(name, records, flags.get('note') ?? '初始版本')));
      return 0;
    },
  },
  import: {
    usage: 'import <name> --file=records.json [--replace] [--note=...]',
    help: '从 JSON 文件导入；默认追加到最新版本形成新版本，--replace 整体替换',
    run(args, flags) {
      const name = args[0];
      if (!name) return fail('BAD_PARAM', '缺少清单名');
      const records = loadRecords(flags, 2, []);
      const check = validateBatch(records);
      if ('failures' in check) return fail('BATCH_FAILED', JSON.stringify(check.failures));
      withStore((store) =>
        print(store.appendVersion(name, records, flags.get('note') ?? null, flags.has('replace') ? 'replace' : 'append')),
      );
      return 0;
    },
  },
  list: {
    usage: 'list [name]',
    help: '列出全部清单，或列出某清单的全部版本',
    run(args) {
      withStore((store) => print(args[0] ? { name: args[0], versions: store.listVersions(args[0]) } : { lists: store.listAll() }));
      return 0;
    },
  },
  show: {
    usage: 'show <name> [version|latest]',
    help: '查看版本记录与各层摘要（十六进制展示，不参与哈希）',
    run(args) {
      if (!args[0]) return fail('BAD_PARAM', '缺少清单名');
      withStore((store) => print(store.getVersion(args[0]!, args[1] ? Number(args[1]) : 'latest')));
      return 0;
    },
  },
  proof: {
    usage: 'proof <name> <index> [version|latest] [--out=proof.json]',
    help: '生成指定位置的包含证明并可导出到文件（脱离数据库可独立验证）',
    run(args, flags) {
      const [name, indexRaw, versionRaw] = args;
      if (!name || indexRaw === undefined) return fail('BAD_PARAM', '用法：proof <name> <index> [version]');
      const index = Number(indexRaw);
      if (!Number.isInteger(index) || index < 0) return fail('BAD_PARAM', 'index 必须是非负整数');
      withStore((store) => {
        const result = store.getProof(name, versionRaw ? Number(versionRaw) : 'latest', index);
        const exportBundle = {
          format: FORMAT_VERSION,
          list: name,
          version: result.version.version,
          index,
          total: result.proof.total,
          root: result.rootHex,
          proof: result.proof,
        };
        const out = flags.get('out');
        if (out) writeFileSync(resolve(out), JSON.stringify(exportBundle, null, 2), 'utf8');
        print(exportBundle);
      });
      return 0;
    },
  },
  verify: {
    usage: 'verify --root=<hex> --content=<text> [--proof-file=proof.json] [--proof-json=\'...\']',
    help: '独立验证：只需根、内容与证明文件，不需要数据库或完整清单',
    run(_args, flags) {
      const root = flags.get('root');
      const content = flags.get('content');
      if (!root || content === undefined) return fail('BAD_PARAM', '需要 --root 与 --content');
      let proof: MerkleProof;
      try {
        if (flags.has('proof-file')) {
          const bundle = JSON.parse(readFileSync(resolve(flags.get('proof-file')!), 'utf8'));
          proof = bundle.proof ?? bundle;
        } else if (flags.has('proof-json')) {
          proof = JSON.parse(flags.get('proof-json')!);
        } else {
          return fail('BAD_PARAM', '需要 --proof-file 或 --proof-json');
        }
      } catch (err) {
        return fail('BAD_PARAM', `读取证明失败：${(err as Error).message}`);
      }
      const result = verifyProof({ rootHex: root, proof, content });
      print(result);
      return result.valid ? 0 : 2;
    },
  },
  compare: {
    usage: 'compare <name> <fromVersion> <toVersion>',
    help: '比较同一清单两个版本的根与逐位置记录差异',
    run(args) {
      const [name, from, to] = args;
      if (!name || from === undefined || to === undefined) return fail('BAD_PARAM', '用法：compare <name> <from> <to>');
      withStore((store) => print(store.compareVersions(name, Number(from), Number(to))));
      return 0;
    },
  },
};

function withStore(fn: (store: MerkleStore) => void): void {
  const store = new MerkleStore(dbPath);
  try {
    fn(store);
  } finally {
    store.close();
  }
}

function main(): number {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const commandName = args.shift();
  if (!commandName || commandName === 'help' || flags.has('help')) {
    process.stdout.write(`有序数据清单 Merkle 包含证明 CLI（格式 ${FORMAT_VERSION}）\n数据文件：${dbPath}\n\n命令：\n`);
    for (const [name, cmd] of Object.entries(commands)) {
      process.stdout.write(`  ${name.padEnd(10)} ${cmd.usage}\n      ${cmd.help}\n`);
    }
    return 0;
  }
  const command = commands[commandName];
  if (!command) return fail('BAD_PARAM', `未知命令：${commandName}（运行 help 查看用法）`);
  try {
    return command.run(args, flags);
  } catch (err) {
    return fail((err as Error & { code?: string }).code ?? 'INTERNAL', (err as Error).message);
  }
}

process.exit(main());
