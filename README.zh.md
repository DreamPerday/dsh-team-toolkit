# dsh-team-toolkit

四个**增量式**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）
Agent Teams 插件。都不修改官方安装包；第一个加工具，后两个完全不改变模型可见的输入。

| 包 | 作用 | 对模型的影响 |
|---|---|---|
| [`packages/team-compact`](packages/team-compact/README.md) | 团队手动上下文压缩：Lead 与每个队友按成员 scope 获得 `compact_context` 工具，另有 `/compact-agent` 命令 | 增加 1 个工具 + 1 个命令 |
| [`packages/team-ext`](packages/team-ext/README.md) | 纯观测审计：把每请求缓存用量与所有前缀重写事件（压缩、裁剪、序列重置）落成 JSONL，并带分析脚本 | 不加工具、不加 prompt 段 |
| [`packages/team-panel`](packages/team-panel/README.md) | Web GUI 团队面板：成员名册（每人一条上下文占用条）、基于 Workspace 归档的移除/恢复、共享任务依赖图 | 不加工具、不加 prompt 段 |
| [`packages/team-effort`](packages/team-effort/README.md) | 让切换 provider/model 的委派保留指定推理强度；官方运行时会把它重置为目标模型默认强度 | 不加工具、不加 prompt 段 |

三个包都是 Cordis bundle（声明 `dsh.bundle`），装进 DSH profile，不碰应用安装包。

## 安装

前提：DSH Desktop 可用 Agent Teams。0.2.2 起它就在基础包里：一个团队等于某个根会话的
subagent 树，开关是模型菜单里的「启用智能体团队协作」（或在 `agent-team` 行设
`defaultEnabled: true`）。

本地 clone 安装（包尚未进 registry 时推荐）：

```powershell
git clone https://github.com/DreamPerday/dsh-team-toolkit.git
# 在 DSH 里调用插件管理器，target 指向子包的绝对路径
plugin_manager action=install_bundle target="<clone>\packages\team-compact"
plugin_manager action=install_bundle target="<clone>\packages\team-ext"
plugin_manager action=install_bundle target="<clone>\packages\team-panel"
plugin_manager action=install_bundle target="<clone>\packages\team-effort"
```

两个包以 `link` 方式安装，clone 目录不能移动。首次安装后如果 profile 不能热加载插件模块
（Host 进程会缓存模块代码；配置改动可热加载，模块改动需要重启），重启一次 DSH Desktop。

卸载：

```text
plugin_manager action=remove_bundle target="dsh-team-compact"
plugin_manager action=remove_bundle target="dsh-team-ext"
plugin_manager action=remove_bundle target="dsh-team-panel"
plugin_manager action=remove_bundle target="dsh-team-effort"
```

## 为什么做这两个插件

在 DSH 0.2.1 上跑真实多智能体负载时，队友的每一次压缩都以 `400` 失败：不带显式 reasoning
effort 的辅助 LLM 调用在 OpenAI 兼容的推理模型上退化成了 `reasoning.effort: "none"`。
审计插件用来让这类故障可见（逐请求缓存字段 + 前缀重写事件）；压缩插件则是因为官方压缩接口
只能压缩"整段可压缩历史"，当某个 agent 的上下文已经很大时，需要一个可指定目标的手动入口。

## 补丁（不是插件）

[`patches/team-model-selection`](patches/team-model-selection/README.md) —— 针对 DSH Desktop
0.2.1-rc.2 的就地补丁，给 `spawn_teammate` 增加可选的 `provider` / `model` / `reasoning_effort`，
让 Lead 可以把每个队友钉到不同的 LLM 路由。

[`patches/team-member-remove`](patches/team-member-remove/README.md) —— 增加终态成员阶段
`removed` 和 Lead 专用的 `remove_teammate` 工具：中断并释放该队友、从 `list_agents` 隐藏、释放
名字和成员名额，会话文件保留在磁盘。名册是日志投影且为包内私有，所以同样只能就地补丁。

两个补丁都版本绑定、锚点不匹配即失败，DSH 升级后需要重打。

## 兼容性

基于 DSH `0.2.1-rc.2` 的 Host 服务编写（`agents`、`commands`、`agentTeams`、`tokenMeter`、
`compaction`、`toolResultPruner`）。实验性 Agent Teams 包上游明确不稳定，具体依赖见两个子包
README。

## 许可

MIT
