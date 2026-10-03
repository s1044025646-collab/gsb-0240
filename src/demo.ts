import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./db";
import { buildTree, generateProof, verifyProof, InclusionProof } from "./merkle";

function showTree(label: string, items: Buffer[]) {
  const { levels, root } = buildTree(items);
  console.log(`\n== ${label} (${items.length} 条) ==`);
  items.forEach((b, i) => console.log(`  记录 ${i}: "${b.toString("utf8")}"`));
  levels.forEach((l, i) =>
    console.log(`  level ${i}: ${l.map((d) => d.toString("hex").slice(0, 12) + "…").join(" ")}`)
  );
  console.log(`  root: ${root.toString("hex")}`);
  return root.toString("hex");
}

function tryVerify(label: string, root: string, content: string, proof: InclusionProof) {
  const r = verifyProof(root, Buffer.from(content, "utf8"), proof);
  console.log(`  ${label}: ${r.valid ? "接受" : `拒绝 (${r.reason})`}`);
}

export async function runDemo(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* 忽略 */ }
  }
  const store = new Store(dbPath);

  const listId = store.createList("演示清单");
  const three = ["alpha", "beta", "gamma"];
  const five = ["alpha", "beta", "gamma", "beta", "epsilon"];
  const v1 = store.addVersion(listId, three);
  const v2 = store.addVersion(listId, five);

  const items3 = three.map((s) => Buffer.from(s, "utf8"));
  const items5 = five.map((s) => Buffer.from(s, "utf8"));
  const root3 = showTree("三条记录树", items3);
  const root5 = showTree("五条记录树（含重复 beta）", items5);

  console.log("\n== 导出证明：中间记录与末尾记录 ==");
  const pMid = generateProof(items3, 1); // beta
  const pEnd = generateProof(items5, 4); // epsilon
  console.log("  三条树 index=1 证明:", JSON.stringify(pMid));
  console.log("  五条树 index=4 证明:", JSON.stringify(pEnd));

  console.log("\n== 正常验证 ==");
  tryVerify("三条树 beta@1", root3, "beta", pMid);
  tryVerify("五条树 epsilon@4", root5, "epsilon", pEnd);

  console.log("\n== 篡改后应被拒绝 ==");
  tryVerify("改动内容 beta->BETA", root3, "BETA", pMid);
  tryVerify("改动位置 index 1->2", root3, "beta", { ...pMid, index: 2 });
  tryVerify("改动总数 count 3->5", root3, "beta", { ...pMid, count: 5 });
  const badSib: InclusionProof = {
    ...pMid,
    siblings: pMid.siblings.map((s, i) =>
      i === 0 ? { ...s, hash: "00".repeat(32) } : s
    ),
  };
  tryVerify("改动兄弟摘要", root3, "beta", badSib);
  const extra: InclusionProof = {
    ...pMid,
    siblings: [...pMid.siblings, { hash: "11".repeat(32), position: "right" }],
  };
  tryVerify("多余路径项", root3, "beta", extra);
  const missing: InclusionProof = { ...pMid, siblings: pMid.siblings.slice(0, -1) };
  tryVerify("缺失路径项", root3, "beta", missing);

  console.log("\n== 版本比较（v1 -> v2）==");
  console.log(JSON.stringify(store.compareVersions(v1.versionId, v2.versionId), null, 2));

  console.log(`\n旧版本根仍可查询: v1.root=${v1.root}`);
  store.close();
}
