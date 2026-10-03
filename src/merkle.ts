import { createHash } from "node:crypto";

export const FORMAT_VERSION = "sha256-merkle-v1";
export const DIGEST_BYTES = 32;

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const EMPTY_PREFIX = Buffer.from([0x02]);

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function leafHash(content: Buffer): Buffer {
  return sha256(Buffer.concat([LEAF_PREFIX, content]));
}

export function parentHash(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([NODE_PREFIX, left, right]));
}

export function emptyRoot(): Buffer {
  return sha256(EMPTY_PREFIX);
}

export interface MerkleTree {
  root: Buffer;
  // levels[0] = 叶子摘要层，levels[levels.length-1] = 根（单元素）
  levels: Buffer[][];
}

// 由有序内容字节列表构造 Merkle 树。保留重复项，不排序、不去重。
export function buildTree(items: Buffer[]): MerkleTree {
  if (items.length === 0) {
    return { root: emptyRoot(), levels: [] };
  }
  const levels: Buffer[][] = [items.map(leafHash)];
  let current = levels[0];
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      // 奇数个节点时复制最后一个摘要后配对
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(parentHash(left, right));
    }
    levels.push(next);
    current = next;
  }
  return { root: current[0], levels };
}

export interface ProofStep {
  hash: string; // 兄弟摘要，32 字节的十六进制
  position: "left" | "right"; // 兄弟在父节点中的位置
}

export interface InclusionProof {
  version: string; // 格式版本
  index: number; // 叶子索引（0 起）
  count: number; // 清单记录总数
  siblings: ProofStep[]; // 自叶向根各层兄弟摘要
}

export function generateProof(items: Buffer[], index: number): InclusionProof {
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`索引越界: index=${index}, count=${items.length}`);
  }
  const { levels } = buildTree(items);
  const siblings: ProofStep[] = [];
  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    if (idx % 2 === 0) {
      const sib = idx + 1 < nodes.length ? nodes[idx + 1] : nodes[idx]; // 奇数层补齐
      siblings.push({ hash: sib.toString("hex"), position: "right" });
    } else {
      siblings.push({ hash: nodes[idx - 1].toString("hex"), position: "left" });
    }
    idx = Math.floor(idx / 2);
  }
  return { version: FORMAT_VERSION, index, count: items.length, siblings };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

const HEX32 = /^[0-9a-f]{64}$/;

// 独立验证：只依赖根、内容字节与证明本身，不访问数据库或完整清单。
export function verifyProof(
  rootHex: string,
  content: Buffer,
  proof: InclusionProof
): VerifyResult {
  if (proof.version !== FORMAT_VERSION) {
    return { valid: false, reason: `不支持的格式版本: ${proof.version}` };
  }
  if (!HEX32.test(rootHex)) {
    return { valid: false, reason: "根摘要必须是 32 字节十六进制" };
  }
  const { index, count, siblings } = proof;
  if (!Number.isInteger(count) || count < 1) {
    return { valid: false, reason: "count 必须为 >= 1 的整数" };
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    return { valid: false, reason: `索引越界: index=${index}, count=${count}` };
  }
  // 期望层数：从 count 逐层 ceil(n/2) 直到 1
  let expectedLevels = 0;
  for (let n = count; n > 1; n = Math.ceil(n / 2)) expectedLevels++;
  if (siblings.length !== expectedLevels) {
    return {
      valid: false,
      reason: `路径层数不符: 期望 ${expectedLevels}, 实际 ${siblings.length}`,
    };
  }
  let node = leafHash(content);
  let idx = index;
  let levelSize = count;
  for (let level = 0; level < siblings.length; level++) {
    const step = siblings[level];
    if (step.position !== "left" && step.position !== "right") {
      return { valid: false, reason: `第 ${level} 层方向非法: ${step.position}` };
    }
    if (!HEX32.test(step.hash)) {
      return { valid: false, reason: `第 ${level} 层兄弟摘要不是 32 字节十六进制` };
    }
    // 核对方向与本层索引一致
    const expectPos = idx % 2 === 0 ? "right" : "left";
    if (step.position !== expectPos) {
      return {
        valid: false,
        reason: `第 ${level} 层方向与索引矛盾: 期望 ${expectPos}, 实际 ${step.position}`,
      };
    }
    // 奇数层补齐：最后一个节点（偶数索引且无右兄弟）的兄弟必须是其自身
    if (idx % 2 === 0 && idx === levelSize - 1 && levelSize % 2 === 1) {
      if (step.hash !== node.toString("hex")) {
        return { valid: false, reason: `第 ${level} 层奇数补齐兄弟应等于节点自身` };
      }
    }
    const sib = Buffer.from(step.hash, "hex");
    node = step.position === "left" ? parentHash(sib, node) : parentHash(node, sib);
    idx = Math.floor(idx / 2);
    levelSize = Math.ceil(levelSize / 2);
  }
  if (!node.equals(Buffer.from(rootHex, "hex"))) {
    return { valid: false, reason: "计算根与提供的根不一致" };
  }
  return { valid: true };
}
