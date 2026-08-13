# MijiaFlow / 米家流

简体中文 | [English](README.md)

MijiaFlow 是一个非官方、局域网优先的 **MCP 服务器**，用于查看与控制米家中枢
网关「极客版」自动化。它适用于任何 MCP 客户端——Claude Desktop、Claude Code、
Cursor、Cline、Windsurf、VS Code、Codex CLI、Gemini CLI 等。

- **受审计的读取：** 仅通过白名单网关调用读取自动化、设备、变量、日志和备份
  记录。
- **受保护的写入：** 每次非备份变更都必须经过计划、已校验备份、基线复查、
  完全一致的一次性用户确认、回读验证和保留的回滚路径。
- **可校验备份：** 导出本地备份并校验摘要；可选的云备份会依次创建、轮询、
  下载和校验。
- **回环配对与工作台：** 网关登录码只能在一次性 `127.0.0.1` 页面输入，该页面
  随后作为只读进度工作台保持打开。登录码不会出现在对话、工具参数或日志中。

MijiaFlow 不复制小米前端代码，也不接入受限的 Xiaomi Home Assistant 云接口；
它只与当前局域网内可达的米家中枢网关直接通信。

> **非官方项目：** MijiaFlow 与小米、米家和 Xiaomi Home 没有从属、授权或支持
> 关系。项目中的产品名称仅用于描述互操作性。

## 兼容范围

支持写入的组合是极客版前端 `v1.6.1` 与协议头 `2.0.0`。只有准确匹配的组合才
开放经过事务保护的写入；其他或未知组合一律降级为**只读**，不会猜测协议或
对象结构。

只读模式仍可导出并校验本地备份，但不能请求云备份，因为该请求会写入网关状态。

连接其他版本前请查看[兼容性矩阵](docs/compatibility.md)。

## 环境要求

- 一个支持 stdio 传输的 MCP 客户端
- Node.js 22 或更高版本（`npx` 随 npm 提供）
- 能访问米家中枢网关私有地址/局域网地址
- 用于本机回环配对步骤的网关登录码

## 安装

MijiaFlow 已发布到 npm，包名为 [`mijiaflow`](https://www.npmjs.com/package/mijiaflow)。
大多数客户端使用同一段配置：

```json
{
  "mcpServers": {
    "mijiaflow": {
      "command": "npx",
      "args": ["-y", "mijiaflow"]
    }
  }
}
```

配置文件位置：

- **Claude Desktop：** `claude_desktop_config.json`
  （Windows 在 `%APPDATA%\Claude\`，macOS 在 `~/Library/Application Support/Claude/`）。
- **Claude Code：** `claude mcp add mijiaflow -- npx -y mijiaflow`
- **Cursor：** 项目内 `.cursor/mcp.json`，或全局 `~/.cursor/mcp.json`。
- **Cline：** MCP 服务器设置文件，使用同样的 `mcpServers` 结构。
- **Windsurf：** `~/.codeium/windsurf/mcp_config.json`。
- **Gemini CLI：** `~/.gemini/settings.json`。
- **VS Code：** `.vscode/mcp.json`，外层键名为 `servers`：
  `{ "servers": { "mijiaflow": { "command": "npx", "args": ["-y", "mijiaflow"] } } }`。
- **Codex CLI：** `~/.codex/config.toml`：

```toml
[mcp_servers.mijiaflow]
command = "npx"
args = ["-y", "mijiaflow"]
```

在 Windows 上，如果客户端无法直接启动 `npx`，改用
`"command": "cmd", "args": ["/c", "npx", "-y", "mijiaflow"]`。

若要从源码仓库运行，先构建一次，再让客户端指向产物：
`"command": "node", "args": ["<仓库路径>/mcp/dist/server.js"]`。

## 安全上手

1. 让助手用 `mijia_probe` 探测网关 URL。
2. 确认返回的前端版本、协议版本和能力模式。
3. 用 `mijia_begin_session` 创建待配对会话并打开一次性回环地址；此时尚未连接
   网关 WebSocket。
4. 只在本机 MijiaFlow 数字键盘输入六位网关登录码；提交后才开始连接和认证。
5. 保持该页面打开：它会变成只读工作台，在整个会话期间显示连接与操作进度。
   助手会轮询 `mijia_session_status` 直到会话进入 `ready`。
6. 先用 `mijia_read` 审计现状，再规划任何变更。
7. 操作结束后调用 `mijia_end_session` 清除连接和认证材料。

示例请求（请将 `GATEWAY_IP` 替换为你自己的米家中枢局域网地址）：

```text
使用 MijiaFlow 探测 http://GATEWAY_IP/，并以只读方式列出自动化。

为我的米家网关创建一个经过校验的本地备份。

规划启用或停用自动化 <id>，显示准确差异，然后等待我确认。
```

## 写入保护

MijiaFlow 不会把自然语言猜测直接转换成本地 API 写入。API 路径只接受包含
`{ id, nodes, cfg }` 的完整原始图。

每次非备份变更都必须完成由 MCP 服务强制执行的受保护事务：

1. 读取对象基线并计算摘要。
2. 导出备份并校验其摘要。
3. 再次读取基线，检测并发变化。
4. 显示差异，并要求用户输入完全一致的一次性确认短语。
5. 执行唯一一项已审阅操作。
6. 回读并验证结果。
7. 保留对象级回滚数据；验证失败时恢复基线。

备份创建使用独立工具，不提供通用 RPC 逃逸入口，也没有 `callAPI` 工具。详见
[写入事务指南](docs/write-transaction.md)。

## 工具

| 工具 | 用途 |
| --- | --- |
| `mijia_probe(baseUrl)` | 探测前端/协议版本和安全能力。 |
| `mijia_begin_session(baseUrl)` | 创建待配对内存会话和一次性六位数字页面；提交后才打开 WebSocket。 |
| `mijia_end_session()` | 关闭连接并清除认证材料。 |
| `mijia_session_status()` | 查询会话状态：无会话、等待登录码、认证中、就绪或失败。 |
| `mijia_workbench_status()` | 读取回环工作台显示的脱敏会话和最近操作快照。 |
| `mijia_read(resource, filters)` | 读取自动化、设备、变量、日志或备份。 |
| `mijia_plan_change(operation, payload)` | 生成绑定基线的差异和一次性确认短语。 |
| `mijia_create_backup(fileName, outputDir?, cloud)` | 创建并校验本地备份（默认目录 `~/.mijiaflow/backups`）；可选创建、轮询、定位、下载并校验网关云备份。 |
| `mijia_apply_change(planToken, backupReceipt, confirmation)` | 重新检查后执行并验证白名单变更。 |
| `mijia_rollback(changeId, confirmation)` | 恢复对象基线并验证恢复结果。 |

状态类工具返回机器可读的 `structuredContent`；错误结果带有稳定的 `error`
代码和可执行的 `hint` 提示。

## 提示词与资源

服务器内置 MCP 原生指引，任何客户端无需外部文档即可发现安全工作流：

- **Prompts：** `mijia_audit`（只读审计）、`mijia_guarded_change`（完整受保护
  写入）、`mijia_backup`（可校验备份）。
- **Resources：** `mijiaflow://guide/tool-workflows`、
  `mijiaflow://guide/write-transaction`、`mijiaflow://guide/browser-workflow`、
  `mijiaflow://guide/security`。
- **Instructions：** 服务器在 `initialize` 结果中概括完整流程：探测 → 配对 →
  读取 → 计划 → 备份 → 确认 → 执行 → 回滚。

更多信息请查看[接口参考](docs/api-reference.md)、[协议说明](docs/protocol.md)、
[调研依据](docs/research.md)、[安全模型](docs/security.md)和[故障排查](docs/troubleshooting.md)。

## 开发验证

```powershell
npm ci
npm run verify   # 类型检查 + 构建 + 测试
```

常规测试通过本地假网关覆盖协议、JSON-RPC、超时、参数校验、备份、并发变化和
回滚流程，并用 stdio 冒烟测试启动已提交的构建产物；测试套件不会修改真实网关。
`mcp/dist/server.js` 是提交进仓库的构建产物，修改 `mcp/src` 后必须运行
`npm run build` 重新生成。

## 许可证

[MIT](LICENSE)
