# 有序数据清单 Merkle 包含证明服务

一个本地运行的有序数据清单完整性实验后端：保存由 UTF-8 文本记录组成的有序清单，
生成 Merkle 根摘要，导出指定位置的包含证明，并在只给定根与证明的情况下独立验证。
仅做清单完整性实验，不涉及区块链、货币、签名账户或分布式共识。

技术栈：TypeScript + Node.js（内置 `node:crypto` / `node:sqlite` / `node:http`），
除开发依赖 `typescript` 外无第三方运行时依赖，不需要 Docker / WSL / 外部服务。

## 摘要字节格式（格式版本 `sha256-merkle-v1`）

- 叶子：`SHA256(0x00 || 内容原始字节)`，内容按 UTF-8 原始字节处理，不做规范化。
- 父节点：`SHA256(0x01 || 左子摘要 || 右子摘要)`，摘要一律为 32 字节二进制。
- 空清单根：`SHA256(0x02)`。
- 某层节点数为奇数时，**复制最后一个摘要**再两两配对。
- 重复内容保留为不同位置，不去重、不排序。
- 十六进制文本仅用于展示与 JSON 传输；哈希计算永远使用原始字节，
  绝不能把十六进制字符串的 ASCII 字节当作摘要参与计算。

## 包含证明格式

```json
{
  "version": "sha256-merkle-v1",
  "index": 1,
  "count": 3,
  "siblings": [
    { "hash": "<64 位十六进制>", "position": "left" },
    { "hash": "<64 位十六进制>", "position": "right" }
  ]
}
```

验证时核对：格式版本、`index`/`count` 范围、路径层数（由 `count` 逐层 `ceil(n/2)`
推导）、每层方向与索引奇偶一致、奇数层末尾节点的补齐兄弟必须等于节点自身、
兄弟摘要必须是 32 字节十六进制，最后比较计算根与提供的根。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 编译并运行全部测试
npm start         # 启动 HTTP API（默认端口 0 = 自动选择空闲端口）
npm run demo      # 运行 3 条 / 5 条记录演示（含篡改拒绝）
```

数据保存在项目内 `data/` 目录（默认 `data/merkle.db`，可用 `--db` 覆盖）。

## CLI 示例

```powershell
node dist/src/cli.js new 我的清单
node dist/src/cli.js import 1 alpha beta gamma        # 生成版本 1
node dist/src/cli.js import 1 alpha beta gamma beta epsilon  # 生成版本 2
node dist/src/cli.js versions 1                       # 查看各版本根
node dist/src/cli.js levels 2                         # 查看版本 2 各层摘要
node dist/src/cli.js proof 2 4 --out proof.json       # 导出 index=4 的证明
node dist/src/cli.js verify proof.json                # 独立验证（不读数据库）
node dist/src/cli.js compare 1 2                      # 比较两个版本
node dist/src/cli.js serve --port 8080                # 指定端口启动 API
```

导出的 `proof.json` 包含 `root`、`content`、`proof` 三部分，脱离数据库与完整清单即可验证。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/lists` | 新建清单，body `{name, records?}` |
| GET | `/lists` | 列出清单 |
| POST | `/lists/:id/versions` | 批量导入为新版本 `{records:[...]}`，任一记录非法整体回滚 |
| GET | `/lists/:id/versions` | 列出版本（旧根持续可查） |
| GET | `/versions/:id` | 版本信息（根、总数、格式版本） |
| GET | `/versions/:id/records` | 查看记录（含原始字节十六进制） |
| GET | `/versions/:id/levels` | 查看各层摘要与根 |
| GET | `/versions/:id/proof?index=N` | 导出根 + 内容 + 包含证明 |
| POST | `/verify` | 独立验证 `{root, content, proof}` |
| POST | `/compare` | 比较两个版本 `{versionA, versionB}` |

错误统一返回 `{"error": {"code", "message"}}`，错误码包括
`INVALID_ARGUMENT`、`NOT_FOUND`、`IMPORT_FAILED`、`INTERNAL`。

## 重要说明与限制

- 验证的语义是：**给定内容和位置相对于调用者所提供的根**的包含关系。
  根本身的可信来源由调用者决定；本地算出的哈希不构成任何第三方认证。
- 奇数层"复制最后节点"的规则意味着如 `[a,b,c]` 与 `[a,b,c,c]` 会得到相同的根；
  证明中的 `count` 用于区分清单长度，验证时会按其推导层数与补齐位置。
- 不做增量超大树、不做一致性（append-only）证明；树在导入时整体构建，适合实验规模。
- `node:sqlite` 在 Node 25 中仍为实验特性，启动时会打印 ExperimentalWarning，不影响功能。
