# dsh-team-effort

让派生子代理保留指定的推理强度。

[English](README.md) | 中文

## 它修复的问题

DSH 在委派时一旦切换模型路线，就会丢掉父级的推理强度。
`resolveChildAgentOptions` 是刻意这么做的：

```js
const routeChanged = resolved.provider !== parentProvider || resolved.model !== parentModel
if (routeChanged && requested?.reasoningEffort === undefined)
  delete resolved.reasoningEffort
```

因此任何只指定 `provider` 和 `model` 的调用方，最终都会落到目标模型的**默认**强度。
`workflow` 工具正是这种调用方：它的 `agent()` 选项是封闭列表
`label, phase, schema, provider, model`，`effort` 被直接拒绝 ——

```
agent() option "effort" is deferred and not supported by this engine
(supported: label, phase, schema, provider, model)
```

所以在脚本里无法要求 `xhigh`，强度只能在 GUI 模型选择器里选。本插件补上缺失的这一半。

## 它做什么

包裹所有委派共用的那个接缝 —— `ctx.subagents.startActivation()` —— 并且**只在**
spec 带有 provider/model 对、却没有 effort 时，把配置的强度写进
`spec.agentOptions.reasoningEffort`。官方运行时随即会保留它，因为
`requested.reasoningEffort !== undefined` 那条分支不再触发。

写入前会先用目标模型自己的推理元数据校验，因此本插件不可能把适配器会拒绝的强度塞给子代理：

| 情况 | 行为 |
|---|---|
| 配置的强度在模型声明范围内 | 写入 |
| 配置的强度不在声明范围内 | 回退到模型的 `defaultEffort`（可用 `fallbackToDefault: false` 关闭） |
| 模型没有声明推理元数据 | 不改动 spec |
| `llm` 服务不可用或元数据查询失败 | 不改动 spec |
| spec 已带 `reasoningEffort` | 不改动 —— 调用方已经表过态 |
| spec 没有 `agentOptions` | 不改动 —— 运行时本就会继承父级强度 |

## 安装

```powershell
plugin_manager action=install_bundle target="D:\path\to\dsh-team-toolkit\packages\team-effort"
```

**需要重启 DSH 一次**：这是 Host 模块，运行中的进程会缓存已加载模块。仅改配置行会热重载。

卸载：`plugin_manager action=remove_bundle target="dsh-team-effort"`，然后重启。

## 配置

```yaml
- id: team-effort
  name: 'dsh-team-effort'
  config:
    enabled: true
    effort: xhigh
    fallbackToDefault: true
    trustWithoutValidation: false
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 不卸载也能关闭桥接 |
| `effort` | `xhigh` | 要在换路线的子代理上保留的推理强度 id |
| `fallbackToDefault` | `true` | 配置的 id 未被声明时，改用模型的 `defaultEffort` |
| `trustWithoutValidation` | `false` | 不查元数据直接写入（逃生口；不支持的 id 会让子代理首个请求失败） |

## 对模型的影响

**没有。** 插件不注册工具、不加提示段、不写会话事件。带它的会话与不带它的会话发出完全相同的
请求，直到某次委派真的指定了模型路线 —— 那时子代理自己的请求才带上此前被丢掉的强度。

## 验证

```powershell
node verify.mjs
```

36 项离线检查，使用假的 Cordis Context、带原型 `startActivation` 的假 `subagents` 服务、
假 `llm`：配置校验、强度选择（保留 / 回退 / 不动三条路径）、spec 改写从不修改调用方对象且
从不覆盖显式指定的强度、桥接的端到端行为、同一路线只记一行诊断、拒绝叠加第二层桥接、
以及释放后恢复原型方法。

## 文件

- `index.js` —— 插件本体（配置校验、强度选择、桥接）
- `cordis.patch.yml` —— Loader 行与默认配置
- `verify.mjs` —— 离线测试

## 已知限制

- 桥接是挂在活的 service 对象上的自有属性；若某组合在该对象激活后将其整体替换，桥接会失效。
- 当子代理**不**切换路线时，强度继承仍是官方运行时的职责，本插件刻意不介入。
- `trustWithoutValidation: true` 可能产生首个请求就失败的子代理；默认行为会先校验。
