# MijiaFlow / 米家流

简体中文 | [English](README.md)

MijiaFlow 是一个非官方、局域网优先的 Codex 插件和 Skill，用于查看与控制
米家中枢网关「极客版」自动化。它刻意把两条控制路径分开：

- **浏览器路径：** 通过语义标签操作米家网页，完整查看、创建和编辑自动化图。
- **本地 API 路径：** 审计自动化、设备、变量、日志和备份；启停已有自动化；
  管理变量；创建备份；导入或导出完整原始图。

MijiaFlow 不复制小米前端代码，也不接入受限的 Xiaomi Home Assistant 云接口；
它只与当前局域网内可达的米家中枢网关直接通信。

> **非官方项目：** MijiaFlow 与小米、米家和 Xiaomi Home 没有从属、授权或支持
> 关系。项目中的产品名称仅用于描述互操作性。

## 兼容范围

首版以极客版前端 `v1.6.1` 和协议头 `2.0.0` 为目标。只有准确匹配的组合才
开放经过事务保护的写入；未知版本、版本信息不完整或组合未验证时一律降级为
**只读**，不会猜测协议或对象结构。

只读模式仍可导出并校验本地备份，但不能请求云备份，因为该请求会写入网关状态。

连接其他版本前请查看[兼容性矩阵](docs/compatibility.md)。

## 环境要求

- 支持插件和 MCP 的 Codex Desktop 或 Codex CLI
- Node.js 22 或更高版本
- 能访问米家中枢网关私有地址/局域网地址
- 用于交互式配对的网关密码

MCP 服务在本机运行。密码只能通过绑定 `127.0.0.1` 的一次性
**MijiaFlow / 米家流** 六位数字键盘输入；提交表单后才会打开网关 WebSocket。
页面只接受一次认证提交，成功或失败结果可刷新查看 60 秒，随后关闭监听端口。
密码只在认证握手期间保留于进程内存；工具参数、配置文件和日志都不会接收或
记录密码。

## 安装

把插件克隆到个人插件目录并构建：

```powershell
git clone https://github.com/xmx-emm/mijiaflow.git "$HOME/plugins/mijiaflow"
Set-Location "$HOME/plugins/mijiaflow"
npm ci
npm run typecheck
npm test
npm run build
```

在个人市场文件 `~/.agents/plugins/marketplace.json` 中登记这个本地目录。条目使用
本地来源 `./plugins/mijiaflow`、安装策略 `AVAILABLE`、认证策略 `ON_INSTALL`、
分类 `Productivity`。然后从个人市场安装：

```powershell
codex plugin add mijiaflow@personal
```

安装后重启 Codex 或新建任务，使 Skill 和 MCP 工具被重新发现。如果个人市场的
`name` 不是 `personal`，请在命令中使用实际名称。

## 只读开始

1. 先用 `mijia_probe` 探测网关 URL。
2. 确认返回的前端版本、协议版本和能力模式。
3. 用 `mijia_begin_session` 创建待配对会话并打开一次性回环地址；此时尚未连接
   网关 WebSocket。
4. 只在本地 MijiaFlow 数字键盘输入六位网关密码；提交后才开始连接和认证。
5. 先用 `mijia_read` 审计现状，再规划任何变更。
6. 操作结束后调用 `mijia_end_session` 清除连接和认证材料。

示例请求：

请将 `GATEWAY_IP` 替换为当前用户自己的米家中枢局域网地址。

```text
使用 MijiaFlow 探测 http://GATEWAY_IP/，并以只读方式列出自动化。

打开米家极客版网页，显示控制走廊灯的自动化图，不要修改。

规划启用或停用自动化 <id>，显示准确差异，然后等待我确认。
```

## 写入保护

MijiaFlow 不会把自然语言猜测直接转换成本地 API 写入。自然语言图编排在浏览器
中完成；API 路径只接受包含 `{ id, nodes, cfg }` 的完整原始图。

每次非备份写入都必须完成以下受保护事务。MCP 服务会对 API 写入强制执行；Skill 会在浏览器原生保存前执行同等流程：

1. 读取对象基线并计算摘要。
2. 导出备份并校验其摘要。
3. 再次读取基线，检测并发变化。
4. 显示差异，并要求用户输入完全一致的一次性确认短语。
5. 通过所选路径执行唯一一项已审阅操作。
6. 回读并验证结果。
7. 保留对象级回滚数据；验证失败时恢复基线。

备份创建使用独立工具。云备份会依次执行创建、轮询进度、等待新列表记录、下载
和校验。项目不会开放通用 RPC 入口，也没有 `callAPI` 工具。

## 公开工具

| 工具 | 用途 |
| --- | --- |
| `mijia_probe(baseUrl)` | 探测前端/协议版本和安全能力。 |
| `mijia_begin_session(baseUrl)` | 创建待配对内存会话和一次性六位数字页面；提交后才打开 WebSocket。 |
| `mijia_end_session()` | 关闭连接并清除认证材料。 |
| `mijia_read(resource, filters)` | 读取自动化、设备、变量、日志或备份。 |
| `mijia_plan_change(operation, payload)` | 生成绑定基线的差异和一次性确认短语。 |
| `mijia_create_backup(fileName, outputDir, cloud)` | 创建并校验本地备份；可选创建、轮询、定位、下载并校验网关云备份。 |
| `mijia_apply_change(planToken, backupReceipt, confirmation)` | 重新检查后执行并验证白名单变更。 |
| `mijia_rollback(changeId, confirmation)` | 恢复对象基线并验证恢复结果。 |

更多信息请查看[接口参考](docs/api-reference.md)、[协议说明](docs/protocol.md)、
[调研依据](docs/research.md)、[安全模型](docs/security.md)和[故障排查](docs/troubleshooting.md)。

## 开发验证

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

常规测试通过本地假网关覆盖协议、JSON-RPC、超时、参数校验、备份、并发变化和
回滚流程；测试套件不会修改真实网关。

## 许可证

[MIT](LICENSE)
