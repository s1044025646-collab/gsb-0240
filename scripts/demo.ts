
/**
 * 端到端演示：
 *  1. 三条 / 五条记录建树；
 *  2. 导出中间与末尾记录证明；
 *  3. 分别篡改内容、位置、总数、兄弟摘要，观察独立验证拒绝；
 *  4. 追加记录产生新版本并比较差异。
 * 运行：npm run demo
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MerkleStore } from '../src/store.js';
import { makeProof, rootOf, toHex, verifyProof, FORMAT_VERSION, type MerkleProof } from '../src/merkle.js';

function line(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function showVerify(label: string, rootHex: string, proof: MerkleProof, content: string): void {
  const r = verifyProof({ rootHex, proof, content });
  console.log(`- ${label}: ${r.valid ? '通过 ✅' : `拒绝 ❌（${r.reason}）`}`);
}

const dir = mkdtempSync(join(tmpdir(), 'merkle-demo-'));
const store = new MerkleStore(join(dir, 'demo.db'));

console.log(`格式版本：${FORMAT_VERSION}`);
console.log(`空清单根 H(0x02) = ${toHex(rootOf([]))}`);

line('三条记录的树');
const three = ['alpha', 'beta', 'gamma'];
store.createList('three', three);
const t3 = store.getVersion('three', 1);
t3.layers.forEach((layer, i) => console.log(`层 ${i}（${layer.length} 节点）: ${layer.join('  ')}`));
const threeMiddle = store.getProof('three', 1, 1);
const threeLast = store.getProof('three', 1, 2);
console.log('中间证明:', JSON.stringify(threeMiddle.proof));
console.log('末尾证明:', JSON.stringify(threeLast.proof));
showVerify('三条-中间-原样', threeMiddle.rootHex, threeMiddle.proof, 'beta');

line('五条记录的树（两层奇数补齐）');
const five = ['一', '二', '三', '四', '五'];
store.createList('five', five);
const v5 = store.getVersion('five', 1);
v5.layers.forEach((layer, i) => console.log(`层 ${i}（${layer.length} 节点）: ${layer.join('  ')}`));
const fiveMiddle = makeProof(five, 2);
const fiveLast = makeProof(five, 4);
showVerify('五条-中间-原样', fiveMiddle.rootHex, fiveMiddle.proof, '三');
showVerify('五条-末尾-原样', fiveLast.rootHex, fiveLast.proof, '五');

line('篡改实验（均应被拒绝）');

// 1) 改动内容
showVerify('改动内容 beta->BETA', threeMiddle.rootHex, threeMiddle.proof, 'BETA');

// 2) 改动位置
showVerify('改动位置 index 1->0', threeMiddle.rootHex, { ...threeMiddle.proof, index: 0 }, 'beta');

// 3) 改动总数（5->4 改变了树高层数）
showVerify('改动总数 5->4', fiveMiddle.rootHex, { ...fiveMiddle.proof, total: 4 }, '三');
showVerify('改动总数 3->5（树高不符）', threeMiddle.rootHex, { ...threeMiddle.proof, total: 5 }, 'beta');

// 4) 改动兄弟摘要
const tamperedSibling: MerkleProof = {
  ...threeLast.proof,
  path: threeLast.proof.path.map((s, i) =>
    i === threeLast.proof.path.length - 1 ? { ...s, siblingHex: '00'.repeat(32) } : s,
  ),
};
showVerify('改动末尾证明的顶层兄弟摘要', threeLast.rootHex, tamperedSibling, 'gamma');

// 5) 缺失/多余路径项
showVerify('缺失路径项', fiveMiddle.rootHex, { ...fiveMiddle.proof, path: fiveMiddle.proof.path.slice(0, 1) }, '三');
showVerify(
  '多余路径项',
  fiveMiddle.rootHex,
  { ...fiveMiddle.proof, path: [...fiveMiddle.proof.path, { side: 'L', siblingHex: '11'.repeat(32) }] },
  '三',
);

// 6) 非法摘要
showVerify(
  '非法兄弟摘要',
  fiveMiddle.rootHex,
  { ...fiveMiddle.proof, path: fiveMiddle.proof.path.map((s, i) => (i === 0 ? { ...s, siblingHex: 'zzzz' } : s)) },
  '三',
);

line('新版本与版本比较（旧根/旧证明仍可查询）');
store.appendVersion('three', ['delta'], '追加 delta');
const versions = store.listVersions('three');
console.log('版本列表:', versions.map((v) => ({ v: v.version, total: v.total, root: v.rootHex.slice(0, 16) + '…' })));
console.log('版本比较 v1 -> v2:', JSON.stringify(store.compareVersions('three', 1, 2), null, 2));
const oldProof = store.getProof('three', 1, 0);
showVerify('旧版本 v1 的证明在新版本产生后仍有效', oldProof.rootHex, oldProof.proof, 'alpha');

line('导出证明脱离数据库验证');
const bundle = {
  format: FORMAT_VERSION,
  root: fiveLast.rootHex,
  proof: fiveLast.proof,
};
console.log('导出包（可拷贝到任何机器）:', JSON.stringify(bundle, null, 2));
console.log('仅凭 root + proof + 内容验证:', verifyProof({ rootHex: bundle.root, proof: bundle.proof, content: '五' }));

store.close();
console.log(`\n演示数据库（临时目录）：${dir}`);
console.log('\n说明：验证只确认“给定内容在给定位置相对于所提供根”的关系；');
console.log('根是否可信取决于调用者获取根的渠道，本地哈希结果不构成第三方认证。');
