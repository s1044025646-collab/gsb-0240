
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerkleStore } from '../src/store.js';
import { rootOf, toHex } from '../src/merkle.js';

const dir = mkdtempSync(join(tmpdir(), 'merkle-store-'));
const dbPath = join(dir, 'test.db');

let store: MerkleStore;

before(() => {
  store = new MerkleStore(dbPath);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('新建清单并生成 v1，根与即时计算一致', () => {
  const row = store.createList('demo', ['a', 'b', 'c'], '初始');
  assert.equal(row.version, 1);
  assert.equal(row.total, 3);
  assert.equal(row.rootHex, toHex(rootOf(['a', 'b', 'c'])));
  assert.equal(row.formatVersion, 'merkle-v1');
});

test('追加记录产生 v2，旧版本与旧根仍可查询', () => {
  const v2 = store.appendVersion('demo', ['d'], '追加 d');
  assert.equal(v2.version, 2);
  assert.equal(v2.total, 4);
  const v1 = store.getVersion('demo', 1);
  assert.equal(v1.rootHex, toHex(rootOf(['a', 'b', 'c'])));
  assert.deepEqual(
    v1.records.map((r) => r.content),
    ['a', 'b', 'c'],
  );
  const latest = store.getVersion('demo', 'latest');
  assert.equal(latest.version, 2);
});

test('证明持久化版本可导出并对旧版本生效', () => {
  const bundle = store.getProof('demo', 1, 2);
  assert.equal(bundle.proof.index, 2);
  assert.equal(bundle.proof.total, 3);
  assert.equal(bundle.rootHex, toHex(rootOf(['a', 'b', 'c'])));
});

test('版本比较输出根变化与逐位置差异', () => {
  const diff = store.compareVersions('demo', 1, 2);
  assert.equal(diff.rootChanged, true);
  assert.deepEqual(diff.added, [{ position: 3, content: 'd' }]);
  assert.deepEqual(diff.removed, []);
});

test('各层摘要完整保存（含奇数层）', () => {
  const v = store.getVersion('demo', 1);
  assert.equal(v.layers.length, 3, '3 个叶子 -> 3 层（3 -> 2 -> 1），第 1 层发生奇数复制');
  assert.equal(v.layers[0]!.length, 3);
  assert.equal(v.layers[1]!.length, 2);
  assert.equal(v.layers[2]!.length, 1);
});

test('同名冲突与不存在清单返回明确错误码', () => {
  assert.throws(() => store.createList('demo', []), (err: Error & { code?: string }) => err.code === 'CONFLICT');
  assert.throws(() => store.getVersion('nope', 'latest'), (err: Error & { code?: string }) => err.code === 'NOT_FOUND');
  assert.throws(() => store.getProof('demo', 2, 99), (err: Error & { code?: string }) => err.code === 'INDEX_OUT_OF_RANGE');
});

test('空清单版本：根为 H(0x02)，不允许取证明', () => {
  store.createList('empty', []);
  const v = store.getVersion('empty', 1);
  assert.equal(v.total, 0);
  assert.equal(v.rootHex, toHex(rootOf([])));
  assert.throws(() => store.getProof('empty', 1, 0), (err: Error & { code?: string }) => err.code === 'EMPTY_LIST');
});

test('重启后复查：重新打开同一数据库，旧根与版本仍在', () => {
  store.close();
  assert.ok(existsSync(dbPath));
  const reopened = new MerkleStore(dbPath);
  const v1 = reopened.getVersion('demo', 1);
  assert.equal(v1.rootHex, toHex(rootOf(['a', 'b', 'c'])));
  const versions = reopened.listVersions('demo');
  assert.equal(versions.length, 2);
  const proof = reopened.getProof('demo', 1, 1);
  assert.equal(proof.proof.path.length, 2, '3 项树高 2 步（3 -> 2 -> 1）');
  reopened.close();
  store = new MerkleStore(dbPath);
});
