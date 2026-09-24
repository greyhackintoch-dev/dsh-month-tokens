# 按 API key 指纹跨端归集 —— 设计文档

> 状态：Phase 0（事实核验完成，架构定稿）。本文是这次改造的唯一事实来源，实现与测试都以它为准。

## 1. 需求

把账本的单位从**机器**换成**凭证**：

> 只要是用了同一把 key 的地方，无论是 web、客户端还是其他平台，统统汇总。

约束：公司账号，我用其中一把 key，应用在多个地方；**我只要我自己的 key 的消耗**。

后一条约束把方案收窄了，也简化了：

- 公司账号是**多人共用**的，所以 `GET /user/balance` 的余额**无法**用来隔离「我的」消耗 —— 余额路线的残余量（真实总量 − 已归属）永远是全体同事的混合，没有意义。**余额路线就此排除。**
- 于是只剩一条路：**按凭证指纹归集**。而指纹恰好就是隔离「我的 key」的唯一手段。

## 2. 已核验事实（含证据）

实现不得违背以下任何一条；若事实变了，先改本文再改代码。

| # | 事实 | 证据位置 |
|---|---|---|
| F1 | DeepSeek 官方仅有 `GET /user/balance`，**没有用量/ token 接口**；余额为账户级 | [官方文档](https://api-docs.deepseek.com/api/get-user-balance) |
| F2 | `tokenUsage` 投影**不含任何身份**：schema 被 `.strict()` 锁为 4 个桶 + `last{turn,step}`，连 model 都没有 | `@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js:40-47` |
| F3 | 会话日志**含身份与时间**：`request/context` 带 `{provider, model, contextWindow}`；`assistant/message` 带 `{turn, step, usage}` 与 `time` | 实测解出真实 v3 日志（1207 帧 / 8.6MB / 2076 事件） |
| F4 | 日志**不含凭证**：`request/header` 的 `header` 是 `{provider, model, reasoningEffort, temperature, maxTokens, stop}` | `@deepseek-ai/dsh-llm/lib/types/call-config.js` |
| F5 | 指纹有现成约定：`sha256(baseURL + "\0" + apiKey)` 已用于文件作用域 | `dsh-llm-deepseek/lib/index.js:714` `deepSeekFileScope` |
| F6 | 插件可解析凭证：`ctx.credentials.resolve(ref)`；已有插件依赖 `dsh-credentials` 的先例 | `dsh-llm-deepseek/lib/index.js:2038-2048`；市场缓存中 `@m1khal3v/dsh-llm-key-rotation` |
| F7 | `~/.dsh/.credentials.yaml` 存的是 **ref**（`refs.DEEPSEEK_API_KEY`），不是明文 | 结构核验（值已遮蔽） |
| F8 | opencode 侧密钥在 `~/.local/share/opencode/auth.json` 的 `deepseek.key`（35 字符 = `sk-`+32） | 结构核验（值已遮蔽） |
| F9 | 实例标识现成可用：`~/.dsh/.anonymous-user-id` 为 36 位 UUID | 实测 |
| F10 | 日志是**独立 zstd 帧拼接**，每帧一批 JSONL 行；可按帧边界增量读 | 实测：`zstdDecompressSync` 逐帧成功，流式解压会在第二帧报 `Unknown frame descriptor` |
| F11 | **provider 路由是开放集合，不是 `deepseek` 一个**。官方适配器注册 `deepseek-official`；实测日志里还出现 `vision-toolkit-deepseek-official`、`vision-toolkit-deepseek-official-vision` | 实测 12 个日志的 provider 分布：`deepseek-official`×7、`vision-toolkit-*`×4、`deepseek`×1；`dsh-llm-deepseek/lib/index.js:1840` |
| F12 | 插件会自建 provider 路由并**复用同一把 key**，因此**按名字精确匹配必然漏账** | F11 的 `vision-toolkit-*` 路由即出自一个视觉插件，现已从 profile 卸载 —— 路由集合随插件装卸而变 |
| F13 | 实测共有 **4 个**含 `deepseek` 的路由家族（另有 `modlens-deepseek`）；窄白名单实测漏掉 `deepseek` + `modlens-deepseek` 共 **1,564,298 token** | `tools/tracked-report.mjs` 在真实数据上跑宽/窄两种配置对比 |
| F14 | 同一会话目录可能同时有旧 `session.jsonl.zstd` 与新 `session.v3.jsonl.zstd`（实测 18/80 个目录）。两者 **usage 事件数完全相同**（131/131、5/5、28/28…），v3 只是压缩更好 —— 因此「每会话只读一个日志（优先 v3）」不会少算 | 实测 8 个双日志会话逐一比对；与 §9.2 的 79/80 逐会话精确对账互相印证 |
| F15 | **联网搜索绕过 tokenUsage**：`web/deepseek-search-llm-request` 直接请求 `api.deepseek.com/anthropic/v1/messages`，事件只记 `endpoint/apiVersion/body`，**没有任何 usage 字段**；该类型是全库唯一的 `web/*` 事件（实测 424 条，0 条带用量） | 实测全部会话日志；官方投影同样看不见 |

## 3. 覆盖边界（必须对用户明说）

本方案是**上报路线**：只覆盖参与上报的调用方。

**覆盖**：装了本插件的 DSH（web / desktop / 多机）+ 本机 opencode。
**不覆盖**：同一把 key 用在 Cursor、脚本、别家客户端等任何非 DSH 调用方。

因此侧栏数字是**下界（floor）**，不是总量。面板必须**标注覆盖范围**，而不是让数字看起来像总量。这延续本插件 "refuses to invent the difference" 的一贯立场：既然公司账号让差额不可测，就**不显示差额**，只声明边界。

## 4. 架构

```
   身份           归属                    传输                 聚合                展示
┌─────────┐   ┌──────────────┐   ┌────────────────┐   ┌────────────┐   ┌──────────┐
│provider │   │ 会话日志增量  │   │ POST /ingest   │   │ 每实例快照  │   │ headline │
│→cred ref│──▶│ request/     │──▶│ 只传指纹+计数  │──▶│ 按指纹求和  │──▶│ = 我的key│
│→sha256  │   │ context +    │   │ bearer token   │   │ 绝对量覆盖  │   │  本月合计│
│ 指纹    │   │ assistant/   │   │                │   │ 非增量      │   │          │
└─────────┘   │ message      │   └────────────────┘   └────────────┘   └──────────┘
              └──────────────┘
```

### 4.1 指纹（`lib/identity.js`）

```
fp = sha256("dsh-month-tokens/key/v1\0" + normalizeApiKey(rawKey)).hex
```

- **只哈希 key 本身**，不含 baseURL —— 与 F5 的 `deepSeekFileScope` 有意不同：文件作用域要区分端点，而「同一把 key」跨机器必须碰撞到同一个桶。
- `normalizeApiKey` 语义对齐 `@deepseek-ai/dsh-llm`：先 trim；空或含非 `[\x21-\x7E]` 字符则判定不可用并**报告**，绝不静默当作 0。
- 展示用 `fp.slice(0, 8)`；完整指纹只在内存与求和键中使用。
- **密钥永不落盘、永不外传、永不写日志**；日志与载荷里只出现短指纹与 ref 名。

provider → ref 的映射来源，按优先级：
1. 插件配置 `trackKeys: [{ ref, provider }]`（显式，默认推荐）；
2. `ctx.settings` 的 `llm-deepseek.apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）；
3. opencode 的 `auth.json`（仅用于把 opencode 用量归到同一指纹）。

### 4.2 归属（`lib/attribution.js`）

按 F3/F10 增量读会话日志：

- 路径 `<dshHome>/sessions/<encoded-cwd>/<sessionId>/session.v3.jsonl.zstd`（兼容无 `.v3` 的旧名）。
- 逐帧解压，**从上次记录的字节偏移继续**，偏移按会话持久化，避免重复解压历史。
- 折叠规则（**必须与官方投影一致，否则重试会重复计数**）：
  - `request/context` → 记下当前 `provider` / `model`；
  - `llm/retry-started` → 关闭同 `(turn, step)` 的替换槽；
  - `assistant/message` → 取 `data.usage`，同 `(turn, step)` 且未被 retry 关闭时**替换**而非累加。
- 归属到日：用事件 `time` 落到本地日历日。**这是相对现有实现的净增益** —— 现有 `split` 规则（跨月长会话）因无法按日切分而只能报 `unattributed`，日志归属天然解决它。

**provider 匹配规则（F11/F12 的直接后果）**：因为路由集合开放且插件会自建路由复用同一把 key，**禁止用「名字等于 deepseek」这类精确匹配**。每个跟踪目标改为：

```yaml
trackKeys:
  - ref: DEEPSEEK_API_KEY
    providers: [deepseek-official]        # 精确、必算的路由
    providerPatterns: ['deepseek']        # 宽匹配：实测出现过 4 个路由家族
```

**默认应当宽，而不是白名单。** 实测出现过的路由家族有四个，全部含 `deepseek`：
`deepseek-official`、`vision-toolkit-deepseek-official`、`vision-toolkit-deepseek-official-vision`、`modlens-deepseek`。
窄白名单会静默漏掉"下一个注册路由的插件"——实测中窄配置漏掉了 `deepseek` 与 `modlens-deepseek` 两条，
合计 **1,564,298 token**（当月 408,823,934 中的一部分）。宽匹配之所以安全，是因为**桶由密钥指纹决定，不由路由名决定**；
而且它是**可见的**：任何无人认领的路由都会进 `uncovered`。

配套的**必须**：把「日志里出现过、但不属于任何跟踪目标」的 provider 收集起来，作为 `uncoveredProviders` 随载荷与面板一起呈现。这样漏掉的不是账，而是一条**待添加的提示**；用户看到 `vision-toolkit-*` 出现就知道该加进去。宁可暴露边界，也不静默少算。

provider 不属于任何跟踪目标 → 计入 `unattributed`，绝不并入我的 key。

**已知偏差（必须写进面板）**：日志只有 provider，没有 key（F4）。所以「这次请求用了哪把 key」是由 `provider → ref → 指纹` 的**配置态**推导的。若在同一个月内换过 key，历史请求会按**当前**配置归属。实现只对**今后观察到的变更**做时间线记录，过去的属尽力而为。

### 4.2.1 opencode 的归属（与 DSH 不同的一条路）

opencode 与 DSH 的凭证存储方式**相反**：DSH 存 ref 再经凭证服务解析（F7），opencode 直接把**明文 key** 按 provider 存在 `~/.local/share/opencode/auth.json`（F8）。所以：

- **不能按 provider 名归属**。共享公司账号下，两台机器的 opencode 都可以写着 `deepseek`，但只有一台持有被跟踪的那把 key。判定必须落在指纹上（`matchOpencodeKey`）。
- **key 只用于哈希**，读完即丢，绝不落入 payload、日志或磁盘。
- 指纹不匹配 → `tracked.opencode.state = 'otherKey'`，其用量**排除在外**（它仍在机器级 opencode 那一行里可见，那才是它该待的地方）。
- 用量折进**同一套 day/model 桶**，并且：
  - 日期用 `date(time_created/1000,'unixepoch','localtime')` 在 SQL 里算，与 `dayKeyOf` 得到同一个本地日历日（用 UTC 会把晚上的调用记到第二天）；
  - `days`/`models` 是**本月**口径，`totals` 是**全时段**，与 `monthViewOf` 的契约逐字一致；
  - `month` 恒等于 `days` 之和（重算而非调整）——标题与自己的明细对不上，是六周后没人能调试的那类差异。
- **上报快照用的是同一份 view**（`attributedView`）。否则本机显示含 opencode、切换成 aggregator 后数字反而变小。
- 实测代价：分组查询 32ms、全时段 22ms（真实库 1078 行），所以全时段那份也照发，让面板的「该 key 历史累计」不多不少。

### 4.3 传输与聚合（`lib/collector.js`）

角色由配置决定：`role: 'local' | 'reporter' | 'aggregator' | 'both'`（默认 `local`，即保持现有单机行为）。

- **上报**：`POST http://<aggregator>:<port>/ingest`，`Authorization: Bearer <token>`。
  载荷 = `{ instance, label, fingerprint, month, days, models, seq, reportedAt }`，**只有计数**。
- **幂等**：每 `(instance, fingerprint)` 只保留**最新绝对快照**，不做增量相加。好处：重启、丢包、重复投递都不会重复计数，且天然自愈。
- **排序按 `(reportedAt, seq)`，不能只看 `seq`** —— 这条是承重的。`seq` 是进程内计数器，**机器重启或 DSH 重启后归零**；若只按 `seq` 排序，聚合器手里存的 `seq=57` 会让重启后的一连串 `seq=0..56` 全部被当成陈旧报告拒收，**那台机器的贡献被静默冻结**，两侧都不报错。按上报时间戳优先排序，重启后的上报立刻生效；真正迟到的旧包（时间戳更旧）仍被拒——这正是序号原本要提供的保护。
- 同 `(reportedAt, seq)` 且数字相同 → `duplicate`；数字相同但时间戳更新 → `refreshed`（只刷新存活时间，**不算变化**，否则每个安静实例每分钟都会重推 SSE、刷所有打开的面板）；同 revision 但数字不同 → 仍采纳（上报方有 bug 也不能少算）。
- **本机快照入库，与是否上报无关**。`reportTracked` 里有两件独立的事：把本机数字放进自己的 store（取决于**是否聚合**），以及把它发出去（取决于**是否上报**）。二者若一起挂在"上报"条件上，**一台没配 `aggregatorUrl` 的聚合器**（hub 的常规形态——hub 没有可 POST 的对象）就会得到空 store，于是它自己的面板会列出所有机器、唯独没有自己。实测症状：`reporter.state: noUrl` → `collector.instances: 0` → `/aggregate` 返回 `keys: []`。
- **实例行用本月口径，不是全时段**。`instances[].total` 取该实例 `days` 之和，与它所属 key 的 `month` 同口径，从而保证"明细之和 == 标题"。实测症状：实例行显示 521,962,694（全时段）而 headline 显示 497,468,111（本月）——今天两者接近看不出来，到了下个月就会把累计数当本月数展示。
- **聚合要按「读的是哪个月」过滤（跨月缺陷，已修）**。快照的 `days` 是带日期的、`models` 是不带日期的，因此 `aggregateOf` 现在接受 `month`：`days` 按日前缀过滤，`models` 按快照**自己声明的月份**过滤，实例行的 `total` 同样只算该月。
  症状（修前实测）：一台 9 月底关机、10 月未上线的机器，其 9 月的 `days` 会被当成 10 月的数——**上个月的花费顶着本月的标签**，而那台机器关着的这段时间，恰恰是没人会细看数字的时候。它的全时段 `totals` 照旧保留（这才是「陈旧但不遗忘」的含义）。
  不传 `month` 时保持原来的不过滤行为，因此这是一个纯增量改动。
- **求和**：聚合值 = Σ 各实例最新快照。实例超过 `staleAfterHours` 未上报 → 标记 `stale` 但**保留**数字并明示。
- **监听**：聚合器起**自己的 http 监听**（默认端口 3939，默认绑定 `127.0.0.1`，跨机时显式配局域网/Tailscale 地址）。
  **关键**：绝不依赖 GUI 的 `networkExposure` —— 那条路会把整个 GUI 暴露出去（README 安全节已警告）。本监听只提供两个路由，且都要 bearer。

### 4.4 展示（`client/client.js`）

- headline 改为**我这把 key 的本月合计**（跨实例求和）。
- **`trackedHere` 区分「我的 key」与「别人报给我的 key」**。聚合器的 `keys` 会包含对端上报、而本机并未配置的指纹（同事把 reporter 指到同一个聚合器，或同一账户的第二把 key）。这些数字是真的，但不是我的；把它们加进「我的 key」标题下，等于用"我花了多少"的标签回答"所有人花了多少"。所以 host 在每个 key 上发 `trackedHere`，前端只对本机自己的 key 求和，对端 key **另立一组、单独标注、数字照常展示**——不合并，也不隐藏（存在的数字不该凭空消失）。缺省视为本机，兼容旧 host。
- 面板：`本机已归属 / 各对端 / 合计`、按模型拆分、每实例上报新鲜度、以及一行**覆盖范围声明**（`仅 DSH + opencode · 下界`）。
- 保留 `exact` / `unattributed` 语义：`unattributed = 本机本月总量 − 本机已归属`，用于暴露「有 provider 未被跟踪」。

## 5. 迁移

现有单机行为降级为面板中的一行（`本机本月 · 全部 provider`），不再占据 headline。`monthSource` 的 `ledger/born/idle/split` 规则仅在无法读日志时作为回退路径保留。

## 6. 安全与威胁模型

- 出机器的只有：实例 UUID、短指纹、桶计数、时间戳。**没有密钥、没有提示词、没有模型输出、没有会话内容。**
- 指纹是密钥的 sha256：不可逆，但**仍是密钥派生值**，因此聚合器只以 `fp.slice(0,8)` 记日志。
- bearer token 走配置/env，不写进仓库。
- 默认绑定 loopback；跨机必须显式改绑。开启本功能**不需要**打开 GUI 的网络暴露。
- opencode 的 `auth.json` 只读、只取 key 用于哈希，**不写入任何载荷或日志**。

## 7. 明确不做

- 不轮询余额（见 §1）。
- 不猜测非 DSH 客户端的消耗（见 §3）。
- 不把 DSH home 或 `opencode.db` 放到网盘共享（SQLite 在云同步下会损坏）。
- **联网搜索的用量无法计入（F15，已验证）**。搜索路径自己直连 provider 的 Anthropic 兼容端点，事件里**根本没有 usage 字段**，所以官方投影看不见、日志折叠也看不见 —— 这是**共享盲点，不是本方案引入的**。
  - 能做的只有**计数**：`createScanState().uncountedWebSearch` 统计这类事件数，`tools/tracked-report.mjs` 会打印（本机 9 月实测 374 次；跨全部日志含旧格式副本为 424 次）。
  - **绝不估算**：没有 token 数字就不编一个。数字照旧是**下界**，而这一行让"下界"变得具体。
  - 注意 374 < 424 的原因：v1→v3 迁移对 usage 事件是完整的（F14），但少数插件自有事件只存在于旧文件里，因此这个计数本身也是下界。

## 8. 测试计划

沿用现有 hermetic 风格（零依赖、离线、指向不存在的路径）：

1. **指纹**：同 key 同指纹；不同 key 不同指纹；trim 后等价；空/非法字符被报告而非归零。
2. **跨机归并**：两个实例报同一指纹 → 求和；重复投递同一 `seq` → 不翻倍；旧 `seq` 乱序到达 → 不覆盖新值。
3. **日志归属**：构造帧序列，验证 retry 替换语义、按日切分、provider 不在跟踪列表时进 `unattributed`。
4. **增量**：二次扫描从偏移继续，结果与全量扫描一致。
5. **鉴权**：缺 bearer / 错 bearer → 拒绝。

已落地（`npm test`）：`test/identity.test.mjs`、`test/attribution.test.mjs`，与原有两个套件一并运行。

## 9. 实测验证与已知偏差

### 9.0 本机部署已验证（2026-09-24）

配置写入 `~/.dsh/profiles/web/cordis.patch.yml`（`role: both`、`0.0.0.0:3939`、bearer token、`trackKeys` 用宽匹配 `deepseek`），用**同一份配置**跑插件实测：

| 检查 | 结果 |
|---|---|
| 聚合器监听 | `{state: listening, host: 0.0.0.0, port: 3939}` |
| 局域网可达 | `curl http://192.168.1.244:3939/health` → `{"ok":true}` |
| bearer 鉴权 | 无 token / 错 token → 401；正确 token → 200 |
| 本机实例入库 | `instances: [{label: mac-book, total: 501,062,022, stale: false}]` |
| 周期对账 | 实例行之和 == key 的 `month` == 501,062,022；`totals`（累计）525,556,605 |
| opencode | `{state: ok, provider: deepseek}`，累计 39,587,689 |
| uncovered / failures | `[]` / `[]` |
| 独立工具互证 | `tools/tracked-report.mjs` 与 host 折叠同一指纹、同一量级（差 0.12%，因两次运行间隔仍在消耗） |

**尚未激活**：运行中的 `dsh web` 进程里仍是启动时加载的旧 host 模块，配置文件生效需要**重启**（浏览器半边刷新即可）。Windows 端的安装与验证步骤已写进 `docs/cross-machine-setup.md`，但**未在真机验证过**。

### 9.1 开发期抓到的三个真实缺陷（均由测试发现，非推测）

| 缺陷 | 后果 | 现状 |
|---|---|---|
| 帧偏移基准在循环内被自身推进 | 冷启动单趟多帧时，**每个会话只统计第一帧**，全库严重少算 | 已修：基准在循环外固定 |
| 截断帧**静默解压成功**（返回空 buffer 或半行文本，不抛错） | 推进偏移量 → **永久丢掉该帧事件** | 已修：以「解压文本以 `\n` 结尾」作为完整性判据 |
| 替换归零后桶对象残留 | 面板出现 `model: 0` 幽灵行 | 已修：归零即删桶 |

第二条的实测依据：`zstdDecompressSync` 与 `createZstdDecompress` 对截断帧**都不报错**；`zstdCompressSync` 的帧头 `fcsFlag=0`，**不声明内容长度**，因此头部校验不可用。换行判据在 20 个真实会话日志、7281 帧上验证：0 空帧、0 缺换行、0 解压失败。

### 9.2 与官方投影的对账

同一台机器、同一批数据、2026-09：

| 来源 | 本月合计 |
|---|---|
| 官方 `tokenUsage` 投影（现有路由 `local.month`） | 381,501,867 |
| 本方案日志归属 | **389,311,536** |
| 比值 | **1.0205** |

会话数一致（80），扫描 5927 帧 / 19MB / 428ms。

**逐会话对账已关闭该开放项**（join 键是日志首帧里的 `id`，不是目录名；缓存值是 `rows.tokenUsage.val.totals`，不是 `val` 本身）：

| 指标 | 结果 |
|---|---|
| 日志 ↔ 投影缓存 join | **80/80** |
| 逐会话完全吻合（delta = 0） | **79/80** |
| 唯一偏差会话 | +189,597（当前 live 会话，投影缓存滞后于已结算轮次） |
| 全会话累计：投影 vs 日志 | 391,278,847 vs 391,468,444 = **+0.048%** |

结论：**读取器无缺陷**（逐会话精确吻合）。§9.2 的 +2.05% 属于**月份归属规则**差异，不是丢数：本方案按事件 `time` 归属，现有实现按会话创建月归属（`born` 规则）。对「本月消耗了多少」这一问题，事件归属才是正确语义，因此后续以日志法为准。

**遗留待查（属现有实现的规则，不是读取器）**：ledger 载荷里 `local.total == local.month == 381,501,867`，比全部 80 个会话的投影总量 391,278,847 低约 9.8M —— 说明 `local.total` 并不真的是"全时段累计"。改造 headline 时会一并处理。
