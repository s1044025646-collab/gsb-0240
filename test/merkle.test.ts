import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTree,
  generateProof,
  verifyProof,
  emptyRoot,
  FORMAT_VERSION,
} from "../src/merkle";
import { Store } from "../src/db";

// 独立手工组合摘要（不经过被测的树构造代码）
const H = (b: Buffer) => createHash("sha256").update(b).digest();
const leaf = (s: string) => H(Buffer.concat([Buffer.from([0]), Buffer.from(s, "utf8")]));
const node = (l: Buffer, r: Buffer) => H(Buffer.concat([Buffer.from([1]), l, r]));

test("空清单根为 H(0x02)", () => {
  const t = buildTree([]);
  assert.equal(t.levels.length, 0);
  assert.ok(t.root.equals(H(Buffer.from([2]))));
  assert.ok(t.root.equals(emptyRoot()));
});

test("单项清单根等于叶子摘要", () => {
  const t = buildTree([Buffer.from("only", "utf8")]);
  assert.ok(t.root.equals(leaf("only")));
  const p = generateProof([Buffer.from("only", "utf8")], 0);
  assert.equal(p.siblings.length, 0);
  assert.ok(verifyProof(t.root.toString("hex"), Buffer.from("only", "utf8"), p).valid);
});

test("重复内容保留为不同位置且根不同", () => {
  const dup = buildTree([Buffer.from("a"), Buffer.from("a")]);
  const single = buildTree([Buffer.from("a")]);
  assert.ok(dup.root.equals(node(leaf("a"), leaf("a"))));
  assert.ok(!dup.root.equals(single.root));
});

test("三条记录：奇数层复制最后节点，手工核对根", () => {
  const items = ["alpha", "beta", "gamma"].map((s) => Buffer.from(s, "utf8"));
  const t = buildTree(items);
  const l0 = leaf("alpha"), l1 = leaf("beta"), l2 = leaf("gamma");
  const expected = node(node(l0, l1), node(l2, l2)); // 奇数补齐
  assert.ok(t.root.equals(expected));
});

test("五条记录手工核对根与中间路径", () => {
  const s = ["a", "b", "c", "d", "e"];
  const items = s.map((x) => Buffer.from(x, "utf8"));
  const t = buildTree(items);
  const L = s.map(leaf);
  const n0 = node(L[0], L[1]), n1 = node(L[2], L[3]), n2 = node(L[4], L[4]);
  const m0 = node(n0, n1), m1 = node(n2, n2);
  assert.ok(t.root.equals(node(m0, m1)));
  // index 2 (c) 的路径
  const p = generateProof(items, 2);
  assert.equal(p.siblings.length, 3);
  assert.equal(p.siblings[0].hash, L[3].toString("hex"));
  assert.equal(p.siblings[0].position, "right");
  assert.equal(p.siblings[1].hash, n0.toString("hex"));
  assert.equal(p.siblings[1].position, "left");
  assert.equal(p.siblings[2].hash, m1.toString("hex"));
  assert.equal(p.siblings[2].position, "right");
  assert.ok(verifyProof(t.root.toString("hex"), Buffer.from("c", "utf8"), p).valid);
});

test("末尾记录（奇数层自配对）证明验证", () => {
  const items = ["a", "b", "c"].map((x) => Buffer.from(x, "utf8"));
  const t = buildTree(items);
  const p = generateProof(items, 2);
  // 第一层兄弟应为自身（奇数补齐）
  assert.equal(p.siblings[0].hash, leaf("c").toString("hex"));
  assert.ok(verifyProof(t.root.toString("hex"), Buffer.from("c", "utf8"), p).valid);
});

test("篡改内容/位置/总数/兄弟均被拒绝", () => {
  const items = ["a", "b", "c"].map((x) => Buffer.from(x, "utf8"));
  const t = buildTree(items);
  const root = t.root.toString("hex");
  const p = generateProof(items, 1);
  assert.ok(!verifyProof(root, Buffer.from("B", "utf8"), p).valid);
  assert.ok(!verifyProof(root, Buffer.from("b", "utf8"), { ...p, index: 2 }).valid);
  // count 改为 5 会改变期望层数，必须拒绝
  const rCount = verifyProof(root, Buffer.from("b", "utf8"), { ...p, count: 5 });
  assert.ok(!rCount.valid && rCount.reason!.includes("层数"));
  const bad = { ...p, siblings: p.siblings.map((s, i) => (i === 0 ? { ...s, hash: "00".repeat(32) } : s)) };
  assert.ok(!verifyProof(root, Buffer.from("b", "utf8"), bad).valid);
});

test("缺失或多余路径项被拒绝", () => {
  const items = ["a", "b", "c"].map((x) => Buffer.from(x, "utf8"));
  const root = buildTree(items).root.toString("hex");
  const p = generateProof(items, 1);
  const missing = { ...p, siblings: p.siblings.slice(0, -1) };
  const r1 = verifyProof(root, Buffer.from("b", "utf8"), missing);
  assert.ok(!r1.valid && r1.reason!.includes("层数"));
  const extra = { ...p, siblings: [...p.siblings, { hash: "11".repeat(32), position: "right" as const }] };
  assert.ok(!verifyProof(root, Buffer.from("b", "utf8"), extra).valid);
});

test("非法摘要与非法方向被拒绝", () => {
  const items = ["a", "b"].map((x) => Buffer.from(x, "utf8"));
  const root = buildTree(items).root.toString("hex");
  const p = generateProof(items, 0);
  const badHex = { ...p, siblings: [{ hash: "zz", position: "right" as const }] };
  assert.ok(!verifyProof(root, Buffer.from("a", "utf8"), badHex).valid);
  const badDir = { ...p, siblings: [{ hash: p.siblings[0].hash, position: "left" as const }] };
  const r = verifyProof(root, Buffer.from("a", "utf8"), badDir);
  assert.ok(!r.valid && r.reason!.includes("方向"));
  assert.ok(!verifyProof("abc", Buffer.from("a", "utf8"), p).valid);
  assert.ok(!verifyProof(root, Buffer.from("a", "utf8"), { ...p, version: "v0" }).valid);
});

test("奇数层补齐兄弟被伪造时拒绝", () => {
  const items = ["a", "b", "c"].map((x) => Buffer.from(x, "utf8"));
  const root = buildTree(items).root.toString("hex");
  const p = generateProof(items, 2);
  const forged = { ...p, siblings: [{ hash: "ff".repeat(32), position: "right" as const }, p.siblings[1]] };
  const r = verifyProof(root, Buffer.from("c", "utf8"), forged);
  assert.ok(!r.valid && r.reason!.includes("奇数补齐"));
});

test("持久化：重启后旧版本根与证明仍可查询", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merkle-"));
  const db = path.join(dir, "t.db");
  let store = new Store(db);
  const listId = store.createList("t");
  const v1 = store.addVersion(listId, ["x", "y"]);
  const v2 = store.addVersion(listId, ["x", "y", "z"]);
  store.close();

  store = new Store(db); // 模拟重启
  const again = store.getVersion(v1.versionId);
  assert.equal(again.root, v1.root);
  assert.notEqual(v1.root, v2.root);
  const items = store.getRecords(v1.versionId);
  const p = generateProof(items, 0);
  assert.ok(verifyProof(v1.root, Buffer.from("x", "utf8"), p).valid);
  assert.equal(store.listVersions(listId).length, 2);
  store.close();
});

test("批量导入失败整体回滚", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merkle-"));
  const store = new Store(path.join(dir, "t.db"));
  const listId = store.createList("t");
  assert.throws(
    () => store.addVersion(listId, ["ok", 123 as unknown as string]),
    /不是字符串/
  );
  assert.equal(store.listVersions(listId).length, 0);
  store.close();
});

test("格式版本写入证明", () => {
  const p = generateProof([Buffer.from("a")], 0);
  assert.equal(p.version, FORMAT_VERSION);
});
