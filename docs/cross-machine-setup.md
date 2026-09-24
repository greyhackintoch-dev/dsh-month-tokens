# 跨机部署：让「我这把 key」的总数合并到一处

本文是**操作手册**。原理、事实依据与边界见 [`DESIGN.md`](../DESIGN.md)。

## 这套东西在做什么

你的 key 在几台机器上用，账本要把它们合成一个数字：

```
Mac（本机）                              这个数字 = Σ 各实例按同一指纹上报的绝对快照
  dsh web ──┐
  opencode ─┤                            · 只传「计数 + 密钥指纹」，永不传密钥本身
            ├─► 本机聚合器 :3939 ◄──────  · 每个实例反复上报"当前总值"，不是增量
Windows     │      （bearer token）          → 重发、乱序、重启都不会重复计数
  dsh ──────┘
```

**为什么必须另起一个端口**：本机 `dsh web` 是 `networkExposure: loopback`（实测确认），
把 GUI 暴露到局域网会连带公开所有路由。聚合器因此自带一个只提供三个路由的独立监听。

**覆盖范围（务必先接受这条）**：只覆盖**在本机留下真实用量记录**的调用方 —— 装了本插件的 DSH（web / desktop / 多机）、opencode、Pen、WorkBuddy。判据是「有没有本地真实记录」，不是「是不是 DSH」。
同一把 key 若还用在 Cursor、脚本、别家客户端上，**本方案看不见它们**，所以面板上的数字是**下界**，不是总量。
公司账号共用余额，因此连"差额"也无法测量 —— 面板只会声明边界，不会编造差额。

---

## 第一步：本机（Mac）当聚合器

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，给已有的 token-ledger 插入项加上 `config`：

```yaml
- insert:
    - id: token-ledger
      name: /Users/caiqiyang/Documents/XF/dsh-token-ledger/lib/index.js
      config:
        role: both                    # 本机既当聚合器，也上报自己的用量
        collectorHost: 0.0.0.0        # 要让局域网里的 Windows 连进来
        collectorPort: 3939
        collectorToken: !!js process.env.DSH_TOKEN_LEDGER_TOKEN
        instanceLabel: mac-book
        staleAfterHours: 24
        trackKeys:
          - ref: DEEPSEEK_API_KEY
            providers: [deepseek-official]
            providerPatterns: ['deepseek']
```

`deepseek-official` 是官方适配器注册的路由；`providerPatterns` 用**宽匹配**兜住插件自建的路由。
实测出现过四个家族：`deepseek-official`、`vision-toolkit-deepseek-official`、
`vision-toolkit-deepseek-official-vision`、`modlens-deepseek` —— 窄白名单会漏掉后两个，
实测漏掉合计 **1,564,298 token**。宽匹配是安全的，因为最终分桶靠**密钥指纹**而不是路由名；
而且**漏掉的路由会以 `uncovered` 出现在面板上**，不会沉默。

**生成 token 并让它常驻**（写进 `~/.zshrc`，别写进仓库）：

```sh
echo 'export DSH_TOKEN_LEDGER_TOKEN="'$(openssl rand -hex 24)'"' >> ~/.zshrc
source ~/.zshrc && echo "token 已设置，长度 ${#DSH_TOKEN_LEDGER_TOKEN}"
```

> ⚠️ **token 绝不能提交进仓库。** 本插件的 git remote 是公开仓库；把 token 写进
> `design`/`docs`/示例配置再 push，等于把它公开。本机的实际 token 只存在于
> `~/.dsh/profiles/web/cordis.patch.yml`（仓库之外）。
>
> 若按上面的 `config:` 写法**直接把 token 字面量写进 profile patch**（本机就是这么做的，好处是
> 不依赖 `dsh web` 是从哪个 shell 启动的），记得顺手收紧权限：
>
> ```sh
> chmod 600 ~/.dsh/profiles/web/cordis.patch.yml
> ```
>
> 注意该文件默认是 `644`，且**沙箱内的写入授权不覆盖 chmod**——本机部署时 chmod 被拒，这一步留给你手工执行。

**改完必须重启 `dsh web` 才会生效**：profile patch 可以热重组，但 host 模块是普通 ESM import，
会留在模块缓存里；浏览器半边刷新页面即可。

重启 `dsh web` 后自检 —— **一条命令跑完全部断言**：

```sh
node tools/verify-deployment.mjs --lan 192.168.1.244
```

它不只打印 JSON，而是断言那些"看起来正常但其实错了"才违反的关系：key 的按日明细是否等于它自己的本月数、
实例行是否等于它们所属 key 的本月数、未授权读取是否真的被拒、两个周期（本月/累计）有没有被互换、
本机有没有作为实例出现在自己的 store 里。输出形如：

```
  ok   the host module carries the tracked section
  ok   64134cfa (DEEPSEEK_API_KEY): the month is the sum of its days  — month 505,311,333 vs days 505,311,333
  ok   an unauthenticated /aggregate is refused  — HTTP 401
  ok   the collector is reachable on the LAN (192.168.1.244)
16/16 checks passed.
```

若它报 `the host module carries the tracked section — restart dsh web`，说明进程里还是旧模块，配置尚未激活。

也可以只看原始数据：

```sh
curl -s http://127.0.0.1:3939/health          # → {"ok":true,"service":"dsh-month-tokens"}
curl -s http://127.0.0.1:3080/token-ledger/summary | python3 -m json.tool | head -40
```

## 第二步：确认局域网可达

collector 绑 `0.0.0.0` 后，从**本机用局域网 IP** 再测一次（这一步能提前暴露绑定或防火墙问题）：

```sh
curl -s http://192.168.1.244:3939/health
```

本机实测环境：`en0 = 192.168.1.244`，macOS 应用防火墙 **已关闭**（不会有弹窗拦截）。
若你的 IP 变了（DHCP），用 `ipconfig getifaddr en0` 重新确认，或在路由器上做个地址保留 ——
因为 Windows 端要写死这个地址。

> 只绑本机时（`collectorHost: 127.0.0.1`）第二步必然失败，这是预期的：单机使用不需要跨机。

## 第三步：Windows 端当上报方

### 3.0 先确认：那个数字是谁渲染的

Windows 侧栏里已经有一个 token 计数，但**未必是这个插件**（插件市场里有 `dsh-tokenledger`、
`dsh-cost-meter` 等多个同类）。搞错了就会改到别的插件头上、白忙一场。先在 Windows 的
PowerShell 里确认：

```powershell
# 1) 这个插件是怎么挂上去的？按路径 insert 还是包安装？
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Recurse -Filter cordis.patch.yml |
  Select-String -Pattern "token" -Context 2,4

# 2) 如果是包安装的，看 profile 依赖里有没有它
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"

# 3) 桌面 profile 是否存在（官方 Electron 壳会拒绝 dsh plugin --profile desktop）
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop"
```

判读：

| 看到什么 | 含义 |
|---|---|
| patch 里有 `id: token-ledger` 且指向本插件 | 就是它，直接加 `config` 即可 |
| patch 里是别的 id（如 `dsh-cost-meter`） | **那个数字不是本插件**；本插件在该机还没装，先装（见下） |
| `desktop` profile 存在、且客户端是官方 Electron 壳 | 本插件前端半边在 `file://` 下无法工作（README 有说明）。应改用「嵌入 web profile 的第三方壳」，或直接用浏览器开该机 `http://127.0.0.1:3080` |

> 若 Windows 上还没装：按与 Mac 相同的方式挂载（`dsh plugin --profile web add <路径或包名>`，
> 或在该机 profile 的 `cordis.patch.yml` 里按绝对路径 insert），**先确认侧栏出现同一行计数**，
> 再加 `config` 配成上报方。

### 3.1 配置为上报方

挂载方式不变，只加 `config`：

```yaml
- insert:
    - id: token-ledger
      name: <Windows 上该插件的路径或包名>
      config:
        role: reporter                # 只上报，不监听端口
        aggregatorUrl: http://192.168.1.244:3939
        collectorToken: !!js process.env.DSH_TOKEN_LEDGER_TOKEN
        instanceLabel: win-vm
        trackKeys:                    # 与 Mac 完全一致
          - ref: DEEPSEEK_API_KEY
            providers: [deepseek-official]
            providerPatterns: ['deepseek']
```

在 Windows 的 PowerShell 里设置同一个 token（**必须与 Mac 完全相同**）：

```powershell
[Environment]::SetEnvironmentVariable('DSH_TOKEN_LEDGER_TOKEN','<粘贴 Mac 上那个 token>','User')
```

重启 Windows 上的 DSH 后验证。**先用同一套自检工具**（它不依赖平台，在 Windows 上照样跑，
token 也会自动从该机的 profile patch 里读，且永不打印）：

```powershell
node <本插件目录>\tools\verify-deployment.mjs
```

在**上报方**机器上，通过的样子与聚合器不同，这是预期的：

```
  ok   the host module carries the tracked section
  ok   a tracking target is configured  — 1 key(s)
  ok   <short> (DEEPSEEK_API_KEY): the month is the sum of its days
  ok   <short> (DEEPSEEK_API_KEY): the instance list is not empty
  ok   the role matches what is running  — role reporter, collector off
```

注意**上报方没有 collector 那几项检查**（它不监听），末尾会打印 `reporter {"state":"ok",...}` ——
`ok` 才是成功；`noUrl` 说明 `aggregatorUrl` 没配对，`error` 说明对端不可达或 token 不一致。

再手工确认两件事：

```powershell
# 1) 能连到聚合器（不带 token 也应答；带 token 才给数据）
Invoke-RestMethod http://192.168.1.244:3939/health

# 2) 本机已是上报方且送达成功
(Invoke-RestMethod http://127.0.0.1:3080/token-ledger/summary).tracked.reporter
```

Mac 上应当看到对端出现：

```sh
curl -s http://127.0.0.1:3080/token-ledger/summary \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('tracked',{}).get('collector'),indent=2)); [print(k['short'], k['total'], [i['label'] for i in k['instances']]) for k in d.get('tracked',{}).get('keys',[])]"
```

**成功的样子**：Mac 上 `tracked.keys[0].instances` 里同时出现 `mac-book` 与 `win-vm`，
`instances` 各项 `total` 之和等于该 key 的 `month`，且侧栏 headline 显示的就是这个数。

本机已经用**两个真实插件实例**把这条链路完整跑通并固化成回归测试
（`test/host.test.mjs` 的 two-machine 用例：真实上报、真实 loopback 监听、两个身份、
`520,486,127 + 550 = 520,486,677` 精确对账），所以剩下的风险只在 Windows 环境本身，
而不在这条代码路径。

---

## 排错

| 现象 | 原因与处理 |
|---|---|
| `/health` 从本机通、从 Windows 不通 | 绑的是 `127.0.0.1` 而非 `0.0.0.0`；或 IP 变了；或不在同一网段 |
| `/health` 通但上报被拒（401） | 两端 token 不一致。注意 `!!js process.env...` 只在**进程启动时**求值，改完环境变量必须重启 DSH |
| 聚合器里看不到对端 | Windows 端 `role` 不是 `reporter`/`both`，或 `aggregatorUrl` 写成 `127.0.0.1`（那是它自己） |
| 数字明显偏小 | 面板上的 `uncovered` 会列出"出现过但没人认领的 provider" —— 把它加进 `providers` 或写个 `providerPatterns` |
| 数字是 0 | 本机该 key 确实没用过，或 `ref` 名字不对（`DEEPSEEK_API_KEY` 必须与凭证库里的引用名一致） |
| 对端标记 stale | 那台超过 `staleAfterHours` 没上报（关机/没开 DSH）。数字会**保留**并明示，不会被悄悄丢掉 |

## 安全

- 出机器的只有：实例名、key 的 **sha256 指纹**、各项计数、时间戳。**没有密钥、没有提示词、没有会话内容。**
- 指纹仍是密钥派生值，所以聚合器日志里只记前 8 位。
- 监听默认 loopback；跨机才显式改绑。**不要**为了这个功能去开 `networkExposure`。
- 无 token 时聚合器**拒绝启动**（不是裸奔监听）。
- 想更安全：把 `collectorToken` 换成一次性长随机串，并在路由器/防火墙上只放行 Windows 那台的 IP。
