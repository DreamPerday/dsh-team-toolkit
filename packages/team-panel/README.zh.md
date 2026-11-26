# dsh-team-panel

DSH Web GUI 的增强版智能体团队面板。它不替换任何东西：在页头已有的 subagent 控件旁
增加一个入口，右侧滑出一个浮层，显示**谁在团队里、各自上下文用了多少、共享任务之间
怎么依赖**，并支持逐个成员的移除/恢复。

[English](README.md) | 中文

## 它提供什么

| 位置 | 内容 |
|---|---|
| 页头入口 `团队面板` | 成员数与未完成任务数 |
| 浮层 · 成员 | 每个队友一行：运行/空闲状态点、名字、上下文占用条（`已用 / 窗口`）、`打开` / `移除` |
| 浮层 · 已移除 | 会话已归档的成员，每行提供 `恢复` |
| 浮层 · 任务依赖 | 共享任务板画成分层图：每个任务一个节点，`blockedBy` 一条折线，按状态着色 |

"移除"走的是官方 Workspace 归档：会话被持久归档、运行中的工作被停止，归档闸门会拒绝
该会话之后的一切模型调用，直到恢复。历史保留 —— 0.2.2 没有删除会话的 API，归档是当前
受支持的最强"移除"。

## 安装

```powershell
# 从本仓库检出的目录安装
dsh plugin install D:\path\to\dsh-team-toolkit\packages\team-panel
```

或用插件管理器工具：

```
plugin_manager action=install_bundle target="D:\path\to\...\packages\team-panel"
```

包内声明了 `dsh.bundle.patch`（Loader 行）与 `dsh.client.platform: web` 加 `./client`
导出，所以安装即同时装好两半。安装后**刷新 GUI 页面**——客户端 bundle 随页面加载，不随
Host 重载。

卸载：`plugin_manager action=remove_bundle target="dsh-team-panel"`，然后刷新页面。

## 数据来源（不新增任何模型输入）

全部走官方接口：

- `useSessions` —— 会话列表快照，里面带着每个会话的全部投影；面板从它读出
  `subagentCatalog`（根会话的直接子级及名字）、`agentTeam`（共享任务板的
  `tasks[].blockedBy`、`status`、`ownerName`）、每个成员的 `contextPressure` 与
  `running` 标记。`shell.overlay` 是 root 作用域，拿不到 `sessionId` 也拿不到
  `useProjection`，所以这是那里唯一可用的 hook。
- `useProjection` 不可用（见上）
- `useWorkspaces` —— 注册表全局的 `archivedSessionIds` 集合
- `ctx.get('uiWorkspace')` —— `archiveSession(id, { stopActivity: true })`、`unarchiveSession(id)`、`openSession(id)`

插件不注册工具、不加提示段落、不写会话事件，因此带它的会话与不带它的会话发出完全相同的
模型请求（缓存前缀不受影响）。

## 0.1.1：浮层在 root 作用域也能渲染

`shell.overlay` 是 root 作用域，既没有 `sessionId` 也没有 `useProjection`。0.1.0 两者都用，导致每次
渲染都抛 `useProjection is not a function`，把整个会话页头一起带崩。0.1.1 全部改用 `useSessions`
读投影，要操作的会话改为从页头入口写入的 store 取，面板不再有任何会话作用域依赖。
`verify.mjs` 现在只用 root 作用域 props 渲染浮层，并断言源码里不出现 `useProjection`。

## 验证

```powershell
node verify.mjs
```

40 项离线检查（用桩浏览器运行时）：Slot 注册与排序、中英字典键一致、面板关闭时空渲染、
成员行数、在役/已移除分组、占用条的颜色分级、依赖图节点与边数、已删除任务排除、阻塞标记、
入口计数、降级输入，以及"移除必须先确认"的保证。

## 文件

- `lib/client.js` —— 浏览器半边（面板、入口、依赖图、样式）
- `lib/index.js` —— Host 半边（空实现：这一行存在只为让客户端 bundle 被发现）
- `cordis.patch.yml` —— Loader 行
- `verify.mjs` —— 离线测试

## 已知限制

- 名册取自根会话的 **catalog**：若成员在面板之外被归档，它仍会列出，直到 catalog 被重新读取。
- 从未在本浏览器打开过的成员没有 `contextPressure`（该投影被排除在摘要之外，只有会话被 retain
  后才到达），所以那一行显示「上下文未打开」而不是占用条。打开一次该成员，下一次渲染就有条了。
- 不做重命名、不做按成员切换模型：那些属于会话本身，不属于面板。
- 归档不等于删除。真要删历史，需要不受支持地改会话目录。
