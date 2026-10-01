# 观察记忆 / Observational memory

把 `pi-observational-memory`（V3）移植到 DeepSeek Harness 的零依赖 host 插件。

长会话丢失思路的方式总是同一种：历史被压缩，压缩结果又被压缩，于是**决策的理由**最先消失 ——
为什么否决了方案 B、哪条约束是硬的、用户已经澄清过什么。这个插件把「观察记忆」搬到 Harness 上：

1. **观察账本**：后台 Observer / Reflector 把会话蒸馏成带时间戳、带来源的 observations 与持久
   reflections，按会话存进插件自己的持久文件。
2. **确定性压缩**：`compaction` 的 `summarize()` 钩子**零模型调用**地渲染这份账本。压缩从
   「总结事件」变成「渲染步骤」。投影为空时**回退到原生 LLM 总结器**，所以记忆永远不会用
   「空」去替换上下文。
3. **可溯源 recall**：每条观察都带 id 和它来自的原文，`recall` 工具按 id 取回。记忆是指向证据的
   索引，不是一句你必须相信的断言。

## 装进 profile

工作区包里没有依赖，靠 profile 的 bundle 声明挂载。

从 GitHub 装到另一台机器（推荐，不必手动拷贝目录）：

```bash
cd <DSH_HOME>/profiles/<profile>
pnpm add github:oldflag2333333/dsh-observational-memory
```

在本机改这个插件的源码、想即时生效时，则用 `link:` 指向本地目录。确认这三处：

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": {
    "@local/dsh-observational-memory": "link:/绝对路径/dsh-observational-memory"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "@local/dsh-observational-memory"
      ]
    }
  }
}
```

包内的 `cordis.patch.yml` 插入一行 Host 条目：

```yaml
- insert:
    - id: observational-memory
      name: '@local/dsh-observational-memory'
```

然后在 profile 目录 `pnpm install`，重启 Harness。启动日志里会出现：

```
observational-memory: active (observe ~10000, reflect ~20000 tokens)
```

## 配置

配置写在 profile 的 `cordis.patch.yml` 里该条目的 `config` 下。非法值被忽略并回落到默认值 ——
记忆插件不应该成为 profile 起不来的原因。

```yaml
- id: observational-memory
  config:
    observeAfterTokens: 10000
    reflectAfterTokens: 20000
    observationsPoolMaxTokens: 20000
    observerChunkMaxTokens: 12000
    maxTokens: 4096
    model: { provider: openrouter, model: google/gemma-4-31b-it }
    passive: false
    debugLog: false
    rootAgentsOnly: true
```

| 设置 | 默认 | 含义 |
|---|---|---|
| `observeAfterTokens` | `10000` | 未观察对话的估算 token 超过它就跑 Observer |
| `reflectAfterTokens` | `20000` | 活跃观察的估算 token 超过它就跑 Reflector |
| `observationsPoolMaxTokens` | `20000` | 超过它才允许 post-reflection 裁剪 |
| `observerChunkMaxTokens` | `12000` | 单次 Observer 请求最多序列化多少 token；超长积压按最旧优先分多次排空 |
| `maxTokens` | `4096` | 每次记忆 agent 运行的输出上限 |
| `model` | 会话模型 | 记忆 worker 的模型覆盖（建议用便宜/快的） |
| `passive` | `false` | 关掉全部后台记忆工作；已有账本仍然会被渲染 |
| `debugLog` | `false` | 每次记忆运行写一行 NDJSON 到 `storages/observational-memory/debug/` |
| `rootAgentsOnly` | `true` | 只观察根 agent，跳过子代理会话 |

token 全部是**估算值**，用 Harness 自己的固定密度启发式（4 字符/token），所以它和
`ctx.tokenMeter` 对同一段文本给出的数字是一个口径。

## 命令与工具

| 接口 | 作用 |
|---|---|
| `/om-status` | 计数、阈值、模型、passive 状态、活跃观察 token、已观察消息数 |
| `/om-view` | 渲染当前记忆（就是压缩时会注入的那段文本） |
| `/om-observe` | 立刻强制跑一次观察/反思/裁剪并报告结果 |
| `recall`（模型工具） | 按 12 位 id 取回一条观察的原文摘要，或展开一条 reflection 的支撑观察 |

命令名必须匹配 `dsh-commands` 的 `/^[a-z][a-z0-9_-]*$/u`，所以是 `om-status` 而不是 `om:status`
（Pi 用冒号，这个 host 不允许）。注册失败会被降级为一条警告，不会中断插件激活。

## 状态栏显示（Client 半）

`client.js` 在 **`conversation.composer.dock`** 里放一个小表，**就在 harness 自带的「上下文已用」
那个表旁边**（自带那个注册为 `id: "stats", order: 0`，这里是 `order: 400`）。

- **状态栏**：一个 14px 的环加百分比 —— **当前上下文占压缩阈值的比例**。几何尺寸照抄自带的
  `ContextMeter`（14px 视框、2px 描边），所以两个表看起来是一对。
- **点开**：三个进度条，就是记忆 agent 真正在等的三个时钟

  | 时钟 | 读数 | 上限 |
  |---|---|---|
  | 下一次**观察** | 未读积压 | `observeAfterTokens` |
  | 下一次**反思** | 活跃观察池 | `reflectAfterTokens` |
  | 下一次**压缩** | 当前上下文 | 引擎自己的阈值 |

  底部还有一行账本覆盖率和观察/反思条数。

两个实现选择值得说明：

- **数据走 Host 的 HTTP 路由，不走 client projection。** 自带的表用 `useProjection("contextPressure")`，
  而 projection 由声明它的包拥有 —— 手写的工作区 bundle 加不了，和 `dsh-session-removal` 用路由
  而不用 Host Remote 是同一个原因。所以这里每 2 秒轮询一次探针的 `usage` 动作。
- **压缩阈值是用活着的那个引擎自己的已解析策略现算的**，不是抄一份默认值。算法与
  `resolveCompactSpec` 一致：`floor(min(contextWindow * thresholdRatio, contextWindow - reserved - headroomTokens))`。
  抄默认值会在 profile 配了 `thresholdRatio` 之后静默漂移。
- **拿不到容量就不画。** 路由没报 `contextWindow` 时组件返回 `null`：一个不知道分母的百分比比没有百分比更糟
  （这条和自带表的「Renders nothing until a provider reports both pressure and a route capacity」一致）。

## 数据落在哪

记忆放在**会话自己的目录里**，和它的日志并排：

```
<DSH_HOME>/sessions/<工作区键>/<sessionId>/
  session.v4.jsonl.zstd              # 会话日志（harness 自己的）
  session.lock                       # harness 自己的
  observational-memory.json          # 账本：observations / reflections / dropped / observedCount
  observational-memory-debug.ndjson  # 仅在 debugLog: true 时
```

这不是随手选的位置，它**从结构上**解决了一个否则很难堵的漏洞：删除会话的逻辑
（`dsh-session-removal`）是 `rm(会话目录, { recursive: true })`。只要记忆在那个目录里，
删会话就自动删掉记忆 —— 不需要维护一份「哪些插件拥有 per-session 存储」的登记表，也不需要
清理孤儿文件的扫描，更不会出现「日志删了、记忆还在」的中间态。

反面教训是具体的：账本最初放在 `storages/observational-memory/sessions/<sessionId>.json`，
而 `dsh-session-removal` 只删日志目录、投影缓存和工作区登记三处，它根本不知道有这个 store。
结果是删掉会话后会留下一个**永远不可达**的孤儿文件（`sessionExists()` 四者皆空就判定会话不存在，
连启动清扫都扫不到它）。放到会话目录里之后这类问题不存在。

由此有两条实现约束：

- **目录是「发现」的不是「推导」的。** 会话目录的路径由后端的 project-key 编码和代际文件名
  （`session.v1…v4.jsonl[.zstd]`）决定，这些是内部且会演进的；插件扫描
  `sessions/*/<sessionId>/` 来定位，绝不复刻路径编码。定位结果按会话缓存，不做重复扫描。
- **写入绝不创建会话目录。** 目录不存在意味着会话还没落盘（或刚被删除）；此时创建它就会造出一个
  所有人都当作真实存在的幽灵会话 —— 包括删除逻辑。所以这种情况下写入被延后（`deferredWrites` 计数），
  进程内的账本照常服务，落盘等下一次。

写入本身是**原子**的（临时文件 + rename），并按会话串行化，所以写到一半崩溃不会截断账本。
账本损坏或缺失会当作空账本读取 —— 丢记忆绝不能让会话起不来。

## 记忆是怎么流动的

```
turn-stopping ──► scheduleMemoryPass（不 await，绝不占住回合）
                     │
                     ├─ Observer   未观察消息 ≥ observeAfterTokens？→ 记 observations
                     ├─ Reflector  活跃观察   ≥ reflectAfterTokens？→ 蒸馏 reflections
                     └─ Dropper    池超预算且本轮有 reflection？   → 墓碑掉部分观察

compaction.summarize
   ├─ 账本非空且渲染结果更小 → 返回渲染文本，llmStreamCall: false（不调模型）
   └─ 否则                   → 原生 LLM 总结器
```

三个行为细节：

- **Observer 最旧优先，每次一个分块**（`observerChunkMaxTokens`，默认 12k）。积压比一个分块大时，
  覆盖水位只推进实际读过的那一段，剩下的下个回合继续。对一个**已经有很长历史**的会话，记忆因此是
  逐回合追赶上的，不是立刻就有。要立刻补，反复调 `/om-observe` 或探针的 `observe`。
- **渲染的体积守卫用引擎同一个 `tokenMeter` 计价**，不是本地的序列化估算 —— 后者把 tool-call /
  tool-result 截断到 500 字符，会严重低估工具密集区域，从而放行一个引擎随后会拒绝的渲染
  （`summary is not smaller than the shadowed content`，是报错而不是回退）。
- **覆盖不变式：记忆只能替换它能描述的东西。** 账本记 `observedTokens`（Observer 累计读过的 token，
  单调递增）。压缩时若 `observedTokens < 被遮蔽区域`，渲染**被拒绝**并回退到原生总结器
  （`rendersSkippedUncovered` 计数）。

  没有这条不变式，一个只读了开头的账本会把整段长会话替换成「关于开头的那几条观察」—— 文本看起来
  像一份完整检查点，实际只描述了一个前缀，**比它替换掉的摘要更糟**。

  覆盖不全本身不是缺陷，它有三种正常来源：会话中途安装插件、Observer 某次输出不可解析而**故意不推进**
  覆盖留待重试、积压尚未排空。缺陷在于把这样的账本当作完整的来渲染。

  这条闸门在稳态下几乎不触发：新会话里 Observer 始终跑在压缩前面；压缩后表面变成
  `[检查点, 保留的近期消息]`，而 `observedTokens` 单调，下一轮压缩仍满足条件。它只在
  「插件中途上车」的追赶期内起作用。

## 两个刻意的偏离（都是被 host 逼的）

**账本不是 session event。** 仓库外插件的事件类型只通过持久化的
`SessionEvent.ignorable` 信封标记被支持，而 `session.append()` 不接受这个字段
（它只转发 `surfaceOp` / `sourceEventSeqs`），所以插件写不出自己的 log-only 事件类型。
账本因此是一个普通文件 —— 但放在**会话自己的目录里**（见上一节），而不是插件私有 store。

**代价：记忆是「每会话」的，不是 branch-local 的。** Pi 把 ledger 做成分支本地，
所以 `/tree` 上每条分支各有一份记忆。这里 fork 出来的会话拿到的是新目录、**空记忆** ——
不过因为 fork 会复制事件前缀，新会话的 Observer 会从头重新观察那段被继承的对话，
把记忆重新推导出来。所以最终状态大致正确，只是要等一次观察窗口，而不是立刻可用。

**压缩是包装而不是继承。** 工作区 bundle 没有 `node_modules`，`import` 任何
`@deepseek-ai/*`（包括 `dsh-compaction-basic` 以继承 `BasicCompactionEngine`）都会在激活时失败。
所以改为包装活着的那个 engine 实例：`summarize()` 是契约里写明的**唯一子类扩展点**，替换它一个
方法，dispose 时精确还原（原本在原型上就 `delete` 自有属性，原本是自有属性就放回去；如果之后
别人又包了一层，则不撤销不属于自己的工作）。包装体任何异常都回退到原生总结器，绝不让一次压缩失败。

如果要走「正道」（继承 `BasicCompactionEngine`），需要把插件发成带 peerDependencies 的 harness 包，
而不是工作区 bundle。

## 与 Pi 原版的差距

已移植：observations / reflections / drops 三层、时间戳与 relevance 分级、
Observer/Reflector/Dropper 三个后台 agent、覆盖水位、按 id 溯源、确定性压缩渲染、
空投影回退、原子持久化、调试日志。

未移植：

- **branch-local 账本**（见上，受 `session.append` 限制）。
- **覆盖档位 `none`/`partial`/`strong` 的精算**：这里只用「被 reflection 的 supportingIds 覆盖到」
  做二值证据，没有 Pi 的确定性分档。
- **向量检索 / 附件观察 / TUI 覆盖面板**：那是 `nik1t7n` 那个分支的特性，不属于 V3 主线。
- **visible vs full memory 的 drift**：Pi 有 `om.folded` 细节来区分「agent 看到的」和「账本真相」；
  这里压缩检查点本身就是唯一投影，没有 drift 概念。

## 诊断路由（也是验证手段）

后台记忆插件本身是不可见的：它的工作在压缩发生之前没有任何迹象，而「从没触发」和「触发了但失败了」
从外面看完全一样。所以插件注册一条**只允许本机回环**的 POST 路由（要求和 session-removal 同样的
自定义头，用来强制跨域预检）：

```bash
U=http://127.0.0.1:19387/observational-memory/probe
H='content-type: application/json'
K='x-dsh-observational-memory: 1'

# 激活分步结果 + 调度计数（哪个步骤失败、turn-stopping 见过几次、记忆运行成功/失败几次）
curl -sS -X POST $U -H "$H" -H "$K" -d '{"action":"status"}'

# 注册表里有没有这个会话的目录、账本落在哪、延迟写次数
curl -sS -X POST $U -H "$H" -H "$K" -d '{"action":"status","sessionId":"session-…"}'

# 原文、渲染结果
curl -sS -X POST $U -H "$H" -H "$K" -d '{"action":"ledger","sessionId":"session-…"}'
curl -sS -X POST $U -H "$H" -H "$K" -d '{"action":"render","sessionId":"session-…"}'

# 对一个活着的会话强制跑一次完整记忆流程，并报告产出（决定性的端到端验证）
curl -sS -X POST $U -H "$H" -H "$K" -d '{"action":"observe","sessionId":"session-…"}'

# 压缩钩子装在了哪个引擎上（见下）
curl -sS -X POST $U -H "$H" -H "$K" -d '{"action":"compaction-hook","sessionId":"session-…"}'
```

`status` 里的 `steps` 是每个激活步骤的独立结果。激活被拆成若干互不影响的步骤，任何一步失败只记录
自己那一项并降级（比如命令名冲突、工具注册被限制），**不会静默跳过后面所有步骤** ——
那正是最难从外面看出来的失败模式。

### 为什么压缩钩子必须用 `agentPresets.serviceFor`

`compaction` 挂在 **agent preset 的 `compaction` group 里**，而那个 group 是 agent 挂载点的
**子作用域**（base profile 给它加了 `isolate: { compaction: true }`）。这带来两个后果：

- **插件根上下文看不到它。** 顶层那个 `compaction-basic` 是 `disabled: true`，所以
  `ctx.inject(['compaction'], cb)` 的回调**永远不会触发**。第一版正是这么写的，而 `activationStep`
  照样把这一步记成 `ok` —— 一个从没装上的钩子藏了两轮实跑才被发现。现在这一步诚实地报告
  `per-agent (no agents yet)` / `root` / `unwrappable`。
- **`agent.ctx.get('compaction')` 也看不到它。** `ctx.get` 只向**上**遍历祖先链，而引擎在子 group
  里。`agentPresets.serviceFor(agent, name)` 做的才是正确的搜索：在 agent 挂载子树里向下找
  （`withinFiber(impl.fiber, mount.fiber)`）。

所以包装分三处，且幂等（`Symbol.for` 标记，同一实例重复可达不会叠第二层）：

1. **激活时**：包根引擎（有的 profile 挂顶层），并遍历当时已存在的 agent；
2. **`agent/created`**：包该 agent 的引擎；
3. **`agent/turn-stopping`**：再试一次 —— **重载后所有已存在的 agent 都不会触发
   `agent/created`**，而且激活那一刻 `agents.list()` 可能还是空的，这些引擎只能靠这条懒包装补上。

包装靠给引擎实例赋一个自有属性来遮蔽类方法。**如果实例被冻结 / sealed / 是 Proxy，赋值会失败**——
此时返回 `unwrappable` 并把原因写进 `lastError`，绝不静默：一个没包上的引擎在压缩时照旧调模型，
从外面看和正常工作的一模一样。

`compaction-hook` 会顺带执行一次包装（所以它同时是修复手段），然后报告 `root` / `viaAgentCtx` /
`resolved` 三条可达路径、各自是否已包、以及 `agentPresets` 是否可用。

### 服务访问规则（踩过的坑）

Cordis 的上下文是 Proxy：**访问一个没有写进 `inject` 的服务属性会直接抛错**
（`cannot get property "llm" without inject`）。第一次实跑就是这么死的 —— Observer 在第一步炸掉，
账本永远不出现，而从外面看和「从没触发」一模一样。

所以本插件只在 `inject` 里声明真正需要作用域隔离的服务（`tools`、`commands`、`webServer`），
其余（`llm`、`compaction`、`agents`）一律走 `ctx.get(name)`。测试用的假上下文刻意**不**把 `llm`
暴露成属性，就是为了让这个错误无法再溜过去。

## 已知风险

- **`agent/turn-stopping` 是否会真的每回合触发，尚未实证。** 下一次实跑要看的正是这一条：
  `status.turnStoppingSeen` 是否随回合增长。如果不能触发，就改走 `agent/status` 的 idle 路径。
- **代码改动必须重启 Harness 才生效。** 工作区 bundle 是 `link:` 依赖，ESM 按 URL 缓存模块；
  profile 里 disable/enable 一个 bundle 不会重新执行模块体，所以运行中的进程会一直用旧代码。
- **观察者错误会被加固**。和 Pi 一样，observations 会被提升为 reflections，再作为裁剪证据 ——
  一个被误读或从工具输出带进来的错误事实会变得持久且自信。`recall` 是对策（能回看原文），但依赖
  模型主动去核验。这是这套机制固有的风险，不是移植缺陷。
- **每回合一次后台模型调用**是真实成本。`observeAfterTokens` 默认 10k，短会话不会触发；但一个
  长会话会持续产生 worker 调用，建议给 `model` 配一个便宜的 worker。

## 测试

```bash
node --test test/om.test.mjs
```

53 项，用假 Cordis context + 临时 `DSH_HOME` 驱动真实模块，覆盖配置解析、id 确定性、
账本归一化与磁盘往返、**删掉会话目录记忆随之消失**、**写入绝不制造幽灵会话目录**、
目录按工作区键发现、原子写无残留、损坏账本降级、渲染排序与截断、消息序列化、
分块预算、JSON 容错解析、Observer 的覆盖推进语义（含不可解析时**不推进**、surface 缩小后重置）、
Reflector 过滤不存在的支撑 id、Dropper 的预算门槛与 id 白名单、recall 的四种结果、
工具/命令注册契约（含命令名合法性）、探针路由的准入与各 action、分步激活的降级行为、
以及压缩包装的渲染/回退/还原/异常兜底。
