
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  FORMAT_VERSION,
  buildLayers,
  emptyRoot,
  hashLeaf,
  hashNode,
  makeProof,
  rootOf,
  toHex,
  verifyProof,
} from '../src/merkle.js';

function raw(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

test('空清单根为 H(0x02)（手工独立计算核对）', () => {
  const expected = raw(Uint8Array.from([0x02]));
  assert.equal(toHex(rootOf([])), toHex(expected));
  assert.equal(toHex(emptyRoot()), 'dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986');
  assert.deepEqual(buildLayers([]), []);
});

test('单项清单：根就是叶子 H(0x00||"a")，证明路径为空', () => {
  const expectedLeaf = raw(Uint8Array.from([0x00]), new TextEncoder().encode('a'));
  assert.equal(toHex(rootOf(['a'])), toHex(expectedLeaf));
  assert.equal(toHex(rootOf(['a'])), '022a6979e6dab7aa5ae4c3e5e45f7e977112a7e63593820dbec1ec738a24f93c');
  const { proof } = makeProof(['a'], 0);
  assert.deepEqual(proof.path, []);
  assert.equal(verifyProof({ rootHex: toHex(rootOf(['a'])), proof, content: 'a' }).valid, true);
});

test('两条记录手工核对根：H(0x01||H(00||a)||H(00||b))', () => {
  const la = hashLeaf(new TextEncoder().encode('a'));
  const lb = hashLeaf(new TextEncoder().encode('b'));
  const expected = toHex(hashNode(la, lb));
  assert.equal(expected, 'b137985ff484fb600db93107c77b0365c80d78f5b429ded0fd97361d077999eb');
  assert.equal(toHex(rootOf(['a', 'b'])), expected);
});

test('三条记录奇数层：最后叶子与自己配对（独立手工组合摘要）', () => {
  const la = hashLeaf(new TextEncoder().encode('a'));
  const lb = hashLeaf(new TextEncoder().encode('b'));
  const lc = hashLeaf(new TextEncoder().encode('c'));
  const leftParent = hashNode(la, lb);
  const duplicatedRight = hashNode(lc, lc);
  const expected = toHex(hashNode(leftParent, duplicatedRight));
  assert.equal(toHex(hashNode(lc, lc)), 'f823659f40f78b119777f292c62ef577fab1c07ebc9df7115a726ee9fc94e7fb');
  assert.equal(expected, 'e9636069c740c9ff51625b01a0b040396d265a9b920cc6febdfa5ecc9f58ecce');
  assert.equal(toHex(rootOf(['a', 'b', 'c'])), expected);
});

test('重复内容保留为不同位置：["x","x"] 与 ["x"] 根不同，顺序敏感', () => {
  assert.notEqual(toHex(rootOf(['x', 'x'])), toHex(rootOf(['x'])));
  assert.notEqual(toHex(rootOf(['a', 'b'])), toHex(rootOf(['b', 'a'])));
  const { proof } = makeProof(['x', 'x'], 1);
  assert.equal(proof.index, 1);
  assert.equal(verifyProof({ rootHex: toHex(rootOf(['x', 'x'])), proof, content: 'x' }).valid, true);
  assert.equal(verifyProof({ rootHex: toHex(rootOf(['x', 'x'])), proof: { ...proof, index: 0 }, content: 'x' }).valid, false);
});

test('五项清单：中间与末尾证明均可验证，奇数层补齐自摘要', () => {
  const records = ['一', '二', '三', '四', '五'];
  const root = toHex(rootOf(records));
  for (const index of [0, 2, 4]) {
    const { rootHex, proof } = makeProof(records, index);
    assert.equal(rootHex, root);
    assert.equal(proof.path.length, 3, '5 项树高为 ceil(log2(5))=3');
    assert.equal(verifyProof({ rootHex, proof, content: records[index]! }).valid, true);
  }
});

test('篡改内容：证明被拒绝', () => {
  const records = ['alpha', 'beta', 'gamma'];
  const { rootHex, proof } = makeProof(records, 1);
  const r = verifyProof({ rootHex, proof, content: 'BETA' });
  assert.equal(r.valid, false);
  assert.match(r.reason ?? '', /不一致/);
});

test('篡改位置：index 改动导致方向矛盾或根不一致', () => {
  const records = ['alpha', 'beta', 'gamma'];
  const { rootHex, proof } = makeProof(records, 1);
  const moved = { ...proof, index: 0 };
  const r = verifyProof({ rootHex, proof: moved, content: 'beta' });
  assert.equal(r.valid, false);
});

test('篡改总数：路径层数校验拒绝', () => {
  const records = ['a', 'b', 'c', 'd', 'e'];
  const { rootHex, proof } = makeProof(records, 0);
  assert.equal(proof.path.length, 3);
  const badTotal = { ...proof, total: 4 };
  const r = verifyProof({ rootHex, proof: badTotal, content: 'alpha' });
  assert.equal(r.valid, false);
  assert.match(r.reason ?? '', /路径层数/);
});

test('篡改兄弟摘要：奇数层补齐规则与根校验拒绝', () => {
  const records = ['a', 'b', 'c'];
  const { rootHex, proof } = makeProof(records, 2);
  const lastStep = proof.path[proof.path.length - 1]!;
  assert.equal(proof.path[0]!.side, 'R', '叶子 c 位于偶数位且是该层最后一个节点，复制自身后兄弟在右');
  assert.equal(lastStep.side, 'L', '第 1 层宽度为 2，目标父节点位于右侧，兄弟在左');
  const tampered = {
    ...proof,
    path: proof.path.map((step, i) => (i === 0 ? { ...step, siblingHex: '00'.repeat(32) } : step)),
  };
  const r = verifyProof({ rootHex, proof: tampered, content: 'c' });
  assert.equal(r.valid, false);
  assert.match(r.reason ?? '', /奇数层补齐|不一致/);
});

test('缺失/多余路径项一律拒绝', () => {
  const records = ['a', 'b', 'c', 'd'];
  const { rootHex, proof } = makeProof(records, 0);
  assert.equal(verifyProof({ rootHex, proof: { ...proof, path: proof.path.slice(0, 1) }, content: 'a' }).valid, false);
  assert.equal(
    verifyProof({
      rootHex,
      proof: { ...proof, path: [...proof.path, { side: 'L', siblingHex: '00'.repeat(32) }] },
      content: 'a',
    }).valid,
    false,
  );
});

test('非法摘要与非法格式版本拒绝', () => {
  const records = ['a', 'b'];
  const { rootHex, proof } = makeProof(records, 0);
  const badHex = { ...proof, path: [{ side: 'R', siblingHex: 'zzz' }] };
  assert.equal(verifyProof({ rootHex, proof: badHex, content: 'a' }).valid, false);
  assert.equal(verifyProof({ rootHex: 'not-a-hex-root', proof, content: 'a' }).valid, false);
  assert.equal(verifyProof({ rootHex, proof: { ...proof, format: 'other-v9' }, content: 'a' }).valid, false);
  assert.equal(
    verifyProof({ rootHex, proof: { ...proof, path: [{ side: 'X', siblingHex: proof.path[0]!.siblingHex }] }, content: 'a' }).valid,
    false,
  );
});

test('空清单不能生成叶子证明；total=0 的伪证明被拒绝', () => {
  assert.throws(() => makeProof([], 0), /空清单/);
  const r = verifyProof({
    rootHex: toHex(emptyRoot()),
    proof: { format: FORMAT_VERSION, index: 0, total: 0, path: [] },
    content: 'a',
  });
  assert.equal(r.valid, false);
});

test('UTF-8 多字节内容按字节处理，非文本等长不同编码可区分', () => {
  const rootZh = toHex(rootOf(['你好']));
  const expected = raw(Uint8Array.from([0x00]), new TextEncoder().encode('你好'));
  assert.equal(rootZh, toHex(expected));
  const { proof } = makeProof(['你好'], 0);
  assert.equal(verifyProof({ rootHex: rootZh, proof, content: '你好' }).valid, true);
  assert.equal(verifyProof({ rootHex: rootZh, proof, content: '妳好' }).valid, false);
});
