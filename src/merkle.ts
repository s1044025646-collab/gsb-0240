
import { createHash } from 'node:crypto';

/**
 * 有序数据清单 Merkle 树 —— 自行实现，不依赖第三方库。
 *
 * 字节格式（格式版本 merkle-v1）：
 *   叶子    H(0x00 || 原始内容 UTF-8 字节)
 *   父节点  H(0x01 || 左子摘要字节 || 右子摘要字节)
 *   空清单  H(0x02)
 * 奇数层规则：
 *   某层节点数为奇数时，复制最后一个摘要与自己配对后参与上一层计算
 *   （复制只用于哈希计算，不改变树中实际节点数与层数）。
 *
 * 注意：一切哈希输入/输出均为 Uint8Array 原始字节；
 * 十六进制字符串仅用于展示与持久化文本，绝不直接参与哈希。
 */

export const FORMAT_VERSION = 'merkle-v1';
export const DIGEST_HEX_LENGTH = 64;

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const EMPTY_PREFIX = 0x02;

function sha256(parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

/** 叶子摘要：H(0x00 || contentBytes) */
export function hashLeaf(contentBytes: Uint8Array): Uint8Array {
  return sha256([Uint8Array.from([LEAF_PREFIX]), contentBytes]);
}

/** 父节点摘要：H(0x01 || left || right) */
export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256([Uint8Array.from([NODE_PREFIX]), left, right]);
}

/** 空清单根：H(0x02) */
export function emptyRoot(): Uint8Array {
  return sha256([Uint8Array.from([EMPTY_PREFIX])]);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new MerkleError('BAD_DIGEST', `非法摘要：需要 64 位十六进制字符，实际收到 ${JSON.stringify(hex).slice(0, 80)}`);
  }
  return new Uint8Array(Buffer.from(hex.toLowerCase(), 'hex'));
}

/** 文本记录 -> 明确的 UTF-8 原始字节 */
export function encodeRecord(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/**
 * 构造完整树。
 * @returns layers[0] 为叶子层，最后一层为 [root]；空清单返回 []。
 */
export function buildLayers(records: string[]): Uint8Array[][] {
  const layers: Uint8Array[][] = [records.map((r) => hashLeaf(encodeRecord(r)))];
  if (records.length === 0) return [];
  let current = layers[0]!;
  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      // 奇数层：最后一个节点与自己的副本配对
      const right = i + 1 < current.length ? current[i + 1]! : left;
      next.push(hashNode(left, right));
    }
    layers.push(next);
    current = next;
  }
  return layers;
}

export function rootOf(records: string[]): Uint8Array {
  if (records.length === 0) return emptyRoot();
  const layers = buildLayers(records);
  return layers[layers.length - 1]![0]!;
}

/**
 * 包含证明（merkle-v1）。
 * - index: 叶子在清单中的位置（从 0 开始）
 * - total: 清单记录总数
 * - path:  从叶子到根的各层兄弟摘要；side 为该兄弟相对于目标节点的方向
 */
export interface ProofStep {
  side: 'L' | 'R';
  siblingHex: string;
}

export interface MerkleProof {
  format: string;
  index: number;
  total: number;
  path: ProofStep[];
}

export class MerkleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MerkleError';
    this.code = code;
  }
}

function assertInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MerkleError('BAD_PARAM', `${field} 必须是整数`);
  }
  if (value < min || value > max) {
    throw new MerkleError('BAD_PARAM', `${field} 超出允许范围 [${min}, ${max}]`);
  }
  return value;
}

/** 由已构造的层与索引生成证明 */
export function makeProof(records: string[], index: number): { rootHex: string; proof: MerkleProof } {
  const total = records.length;
  assertInt(index, 'index', 0, Math.max(0, total - 1));
  if (total === 0) throw new MerkleError('EMPTY_LIST', '空清单没有可证明的叶子');

  const layers = buildLayers(records);
  const path: ProofStep[] = [];
  let pos = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isLeft = pos % 2 === 0;
    let sibling: Uint8Array;
    if (isLeft) {
      // 目标在左，兄弟在右；奇数层末尾时兄弟就是其复制摘要
      sibling = pos + 1 < layer.length ? layer[pos + 1]! : layer[pos]!;
      path.push({ side: 'R', siblingHex: toHex(sibling) });
    } else {
      sibling = layer[pos - 1]!;
      path.push({ side: 'L', siblingHex: toHex(sibling) });
    }
    pos = Math.floor(pos / 2);
  }
  const rootHex = toHex(layers[layers.length - 1]![0]!);
  return { rootHex, proof: { format: FORMAT_VERSION, index, total, path } };
}

/** total 对应树高（根层之上需要的路径步数） */
export function expectedPathLength(total: number): number {
  if (total <= 1) return 0;
  return Math.ceil(Math.log2(total));
}

/**
 * 独立验证：只给定根、证明与被证明内容，即可在无数据库、
 * 无完整清单的情况下重算根并严格核对。
 *
 * 严格检查：
 *  1. 格式版本必须为 merkle-v1；
 *  2. index/total 为非负整数且 index < total（total=0 无叶子可证）；
 *  3. path 长度必须恰好等于该 total 对应树高 ceil(log2(total))，
 *     缺失或多余路径项一律拒绝；
 *  4. 每一步 side 只能是 'L'/'R'，兄弟摘要必须为 64 位十六进制；
 *  5. 奇数层末尾（目标为最后一个左孩子）时，兄弟摘要必须等于
 *     当前节点摘要（补齐规则），否则拒绝；
 *  6. 重算根必须与提供的根逐字节相等。
 */
export function verifyProof(params: {
  rootHex: string;
  proof: unknown;
  content: string;
}): { valid: boolean; computedRootHex: string; reason?: string } {
  const { rootHex, proof, content } = params;

  let claimedRoot: Uint8Array;
  try {
    claimedRoot = fromHex(rootHex);
  } catch (err) {
    return reject(err as Error);
  }

  if (proof === null || typeof proof !== 'object') {
    return { valid: false, computedRootHex: '', reason: '证明必须是对象' };
  }
  const p = proof as Record<string, unknown>;
  if (p.format !== FORMAT_VERSION) {
    return { valid: false, computedRootHex: '', reason: `格式版本不匹配：期望 ${FORMAT_VERSION}` };
  }

  let index: number, total: number;
  try {
    index = assertInt(p.index, 'index', 0, Number.MAX_SAFE_INTEGER);
    total = assertInt(p.total, 'total', 0, Number.MAX_SAFE_INTEGER);
  } catch (err) {
    return reject(err as Error);
  }
  if (total === 0) return { valid: false, computedRootHex: '', reason: 'total 为 0：空清单不存在叶子包含证明' };
  if (index >= total) return { valid: false, computedRootHex: '', reason: `index(${index}) 必须小于 total(${total})` };

  if (!Array.isArray(p.path)) return { valid: false, computedRootHex: '', reason: 'path 必须是数组' };
  const expectedLen = expectedPathLength(total);
  if (p.path.length !== expectedLen) {
    return { valid: false, computedRootHex: '', reason: `路径层数错误：期望 ${expectedLen} 项，实际 ${p.path.length} 项（缺失或多余路径项）` };
  }

  let node = hashLeaf(encodeRecord(content));
  let pos = index;
  let levelWidth = total;

  for (let level = 0; level < p.path.length; level++) {
    const step = p.path[level] as Record<string, unknown> | null;
    if (step === null || typeof step !== 'object') {
      return { valid: false, computedRootHex: '', reason: `路径第 ${level} 项不是对象` };
    }
    if (step.side !== 'L' && step.side !== 'R') {
      return { valid: false, computedRootHex: '', reason: `路径第 ${level} 项方向非法：只允许 'L' 或 'R'` };
    }
    let sibling: Uint8Array;
    try {
      sibling = fromHex(step.siblingHex as string);
    } catch (err) {
      return reject(err as Error);
    }

    const isLeft = pos % 2 === 0;
    const isLastOdd = isLeft && pos === levelWidth - 1;
    if (isLeft !== (step.side === 'R')) {
      return { valid: false, computedRootHex: '', reason: `路径第 ${level} 项方向与索引在该层的位置矛盾` };
    }
    if (isLastOdd) {
      if (toHex(sibling) !== toHex(node)) {
        return { valid: false, computedRootHex: '', reason: `路径第 ${level} 项违反奇数层补齐规则：末尾节点的兄弟必须是其自身摘要` };
      }
      sibling = node;
    }

    node = isLeft ? hashNode(node, sibling) : hashNode(sibling, node);
    pos = Math.floor(pos / 2);
    levelWidth = Math.ceil(levelWidth / 2);
  }

  const computedRootHex = toHex(node);
  if (computedRootHex !== toHex(claimedRoot)) {
    return { valid: false, computedRootHex, reason: '重算根与所提供根不一致：内容、位置、总数或兄弟摘要与证明不符' };
  }
  return { valid: true, computedRootHex };
}

function reject(err: Error): { valid: boolean; computedRootHex: string; reason: string } {
  return { valid: false, computedRootHex: '', reason: err.message };
}
