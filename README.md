
# 有序数据清单 Merkle 包含证明后端（TypeScript + Node.js + SQLite）

本地运行的**有序数据清单完整性实验**服务：保存 UTF-8 文本记录列表，自行构造二叉 Merkle 树，
导出某个位置的包含证明，并在**只给定根与证明**（无数据库、无完整清单）时独立验证。

仅做清单完整性：不涉及区块链、加密货币、签名账户或分布式共识。

---

## 1. 字节格式（格式版本 `merkle-v1`）

所有哈希使用 **SHA-256**，一切哈希输入与输出都是**原始字节**（`Uint8Array`）。
十六进制字符串仅用于展示和 JSON 持久化，**绝不直接参与哈希运算**。

| 对象 | 计算方式 |
| --- | --- |
| 叶子 | `H(0x00 || 内容的 UTF-8 原始字节)` |
| 父节点 | `H(0x01 || 左子摘要 32 字节 || 右子摘要 32 字节)` |
| 空清单根 | `H(0x02)`（固定值 `dbc1b4c9…d986`） |

`0x00/0x01/0x02` 是**域分隔前缀**，保证叶子、内部节点、空根三类输入互不混淆。

### 奇数层规则

自底向上逐层配对。某层节点数为奇数时，**复制最后一个摘要与自己配对**后计算上一层：

```
3 个叶子 [A,B,C]
  层0:    A        B        C
  层1:   H(01‖A‖B)   H(01‖C‖C)   ← C 被复制（仅用于哈希，不新增实际节点）
  层2:        H(01 ‖ H(AB) ‖ H(CC))
```

### 有序、可重复、不去重

* 记录按给定顺序排列，**不排序**；
* 重复内容保留为不同位置（`["x","x"]` 与 `["x"]` 根不同）；
* 每条记录按**明确的 UTF-8 原始字节**处理（`"你好"` 按 6 个字节参与哈希）。

### 证明格式

```json
{
  "format": "merkle-v1",
  "index": 2,
  "total": 3,
  "path": [
    { "side": "R", "siblingHex": "....(64 位十六进制)" },
    { "side": "L", "siblingHex": "...." }
  ]
}
```

* `index`：叶子位置（从 0 开始）；`total`：清单记录总数；
* `path`：从叶子到根每一层的兄弟摘要；`side` 是兄弟相对目标的方向：
  `L` = 兄弟在左侧（计算 `H(01‖兄弟‖当前)`），`R` = 兄弟在右侧（计算 `H(01‖当前‖兄弟)`）；
* 路径层数必须恰好为 `ceil(log2(total))`，单项清单路径为 `[]`。

验证时会严格核对：格式版本、`index < total`、路径层数、每步方向与索引在该层奇偶位置一致、
兄弟摘要为 64 位十六进制、奇数层末尾兄弟必须等于当前节点摘要（补齐规则），最后重算根逐字节比较。
**任何一串能凑出同格式哈希的数据都不会被当作合法证明。**

### 验证语义与信任边界

验证回答的唯一问题是：**“给定内容是否在给定位置、相对于所提供的根”**。
根本身是否可信，取决于调用者获取根的渠道（带外核对、可信对方发布等）。
本地算出哈希**不构成任何第三方认证**，也不证明内容的真实世界含义。

---

## 2. 环境与构建

* Windows 本地运行，无需 Docker / WSL / 付费服务 / 外部在线 API；
* 需要 Node.js ≥ 22.5（内置 `node:sqlite`；本项目在 Node v25 上实际验证）；
* 无任何第三方运行时依赖，SQLite 使用 Node 内置模块。

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # tsc 编译到 dist/
npm test           # 编译并运行 node --test（22 个测试）
npm run demo       # 三条/五条树、证明导出与四类篡改拒绝的完整演示
npm start          # 启动 HTTP API（默认让操作系统分配空闲端口）
```

环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `0`（自动选空闲端口） | 固定监听端口，例如 `$env:PORT=8080` |
| `HOST` | `127.0.0.1` | 绑定地址，默认仅本机回环 |
| `DB_PATH` | `项目内 data/merkle.db` | SQLite 数据文件路径 |

---

## 3. 完整 CLI 示例

CLI 编译后入口为 `dist/src/cli.js`（也可 `npm link` 后用 `merkledb`）。

```powershell
# 新建清单（内联 JSON 数组，按 UTF-8 文本处理）
node dist/src/cli.js init fruits '["apple","banana","cherry"]' --note="第一批"

# 从 JSON 文件批量导入（文件是 ["字符串", ...]；失败整体拒绝，见第 6 节）
node dist/src/cli.js import fruits --file=data/records.sample.json --note="再导一批"

# 从文件整体替换生成新版本
node dist/src/cli.js import fruits --file=data/records.sample.json --replace

# 列出全部清单 / 某清单的所有版本
node dist/src/cli.js list
node dist/src/cli.js list fruits

# 查看某版本的记录与各层摘要（不传版本即 latest）
node dist/src/cli.js show fruits 1

# 生成指定位置证明并导出为独立 JSON 文件（旧版本仍可证明）
node dist/src/cli.js proof fruits 2 1 --out=data/proof-fruits-v1-2.json

# 独立验证：只需根、内容、证明文件 —— 不需要数据库，也不需要完整清单
node dist/src/cli.js verify `
  --root=<把 show 输出的 rootHex 粘这里> `
  --content=cherry `
  --proof-file=data/proof-fruits-v1-2.json
# 验证通过退出码 0；证明无效退出码 2；参数错误退出码 1

# 比较两个版本（根是否变化 + 逐位置增删记录）
node dist/src/cli.js compare fruits 1 2

node dist/src/cli.js help
```

新增或调整记录总是产生**不可变新版本**；旧根、旧分层摘要与旧证明永久可查。

---

## 4. HTTP API

所有请求/响应均为 JSON（UTF-8）。错误响应统一为
`{ "error": { "code": "...", "message": "..." } }`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET  /api/health` | 健康检查与格式版本 |
| `GET  /api/lists` | 列出全部清单及最新根 |
| `POST /api/lists` | 新建清单，body：`{name, records:string[], note?}` |
| `GET  /api/lists/:name/versions` | 列出某清单全部版本 |
| `POST /api/lists/:name/versions` | 追加（`mode:"append"`，默认）或 `mode:"replace"` 生成新版本 |
| `GET  /api/lists/:name/versions/:version` | 版本详情：记录 + 各层摘要（`:version` 为正整数或 `latest`） |
| `GET  /api/lists/:name/versions/:version/proof/:index` | 生成某位置包含证明 |
| `POST /api/lists/:name/compare` | body：`{from, to}`，比较两版本 |
| `POST /api/verify` | **独立验证**，body：`{root, proof, content}` |

```powershell
# PowerShell 示例
$base = 'http://127.0.0.1:8080'   # 启动时控制台会打印实际端口
Invoke-RestMethod "$base/api/lists" -Method Post -ContentType 'application/json' `
  -Body '{"name":"demo","records":["a","b","c","d","e"]}'
$p = Invoke-RestMethod "$base/api/lists/demo/versions/1/proof/4"
Invoke-RestMethod "$base/api/verify" -Method Post -ContentType 'application/json' `
  -Body (@{ root = $p.rootHex; proof = $p.proof; content = 'e' } | ConvertTo-Json -Depth 6)
```

### 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `BAD_PARAM` | 400 | 参数缺失/类型错误、JSON 非法、请求体过大（10 MB） |
| `BAD_DIGEST` | 400 | 根或兄弟摘要不是 64 位十六进制 |
| `INDEX_OUT_OF_RANGE` | 400 | 证明索引不在 `0..total-1` |
| `EMPTY_LIST` | 400 | 对空清单版本请求叶子证明 |
| `BATCH_FAILED` / `INVALID_FILE` | 400 | 批量导入预校验失败 / 导入文件非法 |
| `NOT_FOUND` | 404 | 清单或版本不存在、路由不存在 |
| `CONFLICT` | 409 | 同名清单已存在 |

---

## 5. SQLite 存储

数据库文件默认在项目内 `data/merkle.db`（自动开启 WAL）。表：

* `lists(id, name 唯一, created_at)`
* `versions(id, list_id, version, root_hex, format_version, total, parent_version_id, change_note, created_at)`，`(list_id, version)` 唯一
* `records(version_id, position, content)` —— 保存**原记录与顺序**
* `layers(version_id, level, position, digest_hex)` —— 保存每一层结果摘要

每个版本在一个事务中整体写入，快照不可变。

## 6. 批量导入失败处理

导入前逐项预校验（必须为字符串数组）。任何一项不合法都返回 `BATCH_FAILED`
（附带每项 `line` 位置与 `reason`），**不产生半成品版本、不改动旧数据**。
空字符串记录允许但会在校验报告中提示。

## 7. 演示与测试覆盖

`npm run demo` 演示：3 条与 5 条树的各层摘要；中间与末尾证明导出；
分别篡改**内容、位置、总数、兄弟摘要**以及缺失/多余路径项、非法摘要，观察拒绝原因；
追加新版本并比较；导出证明脱离数据库验证。

测试（`test/merkle.test.ts`、`test/store.test.ts`，共 22 项）覆盖：
独立手工组合摘要核对根与路径、空清单、单项、重复内容、奇数节点复制、
缺失/多余路径项、非法摘要/非法方向/错误格式版本、篡改内容/位置/总数/兄弟、
UTF-8 多字节、批量持久化与**关闭进程后重开数据库复查**旧根旧证明。

## 8. 限制

* 面向清单完整性实验，不做增量超大树、一致性证明（consistency proof）或内存优化；
  每次生成版本/证明都完整建树。
* 仅本机回环默认监听，不含鉴权、TLS、多用户账户——按要求不做账户体系。
* `node:sqlite` 在当前 Node 版本仍带 Experimental 警告，API 可能随 Node 版本演进。
* 服务只验证“内容+位置 ↔ 所提供根”的密码学关系；根的可信来源由调用者决定。
