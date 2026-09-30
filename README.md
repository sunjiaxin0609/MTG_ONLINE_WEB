# MTG Online

万智牌（Magic: The Gathering）网页对战游戏 —— 标准赛规则，单人 vs 电脑 AI。自研 TypeScript 规则引擎，卡牌数据来自 Scryfall，前后端分离。

## 特性

- **自研规则引擎**（纯 TS、无副作用、可单测）：回合与阶段机、法术力、堆叠与优先权、战斗与关键字、状态检查与胜负判定
- **真实卡牌数据**：从 Scryfall 抓取标准赛合法卡，解析为结构化「能力指令」，只保留引擎可执行的卡
- **启发式 AI 对手**：自动下地、施法、攻击、阻挡，能独立打完整局
- **实时对战 UI**：React 牌桌，点击即操作，WebSocket 双向同步，卡图悬停大图
- **脱敏视图**：对手手牌与双方牌库只下发数量，防止信息泄露

## 里程碑进度

| # | 里程碑 | 状态 |
|---|---|---|
| M1 | 项目脚手架 + 共享引擎骨架 | 完成 |
| M2 | 回合与阶段机 | 完成 |
| M3 | 核心数据层（Scryfall 抓取 + 建模） | 完成 |
| M4 | 法术力 + 手牌 + 基本操作 | 完成 |
| M5 | 堆叠与优先权 | 完成 |
| M6 | 战斗系统 | 完成 |
| M7 | 状态检查 + 胜负判定 | 完成 |
| M8 | AI 玩家 | 完成 |
| M9 | 后端对局会话 + WebSocket | 完成 |
| M10 | 前端对战 UI | 完成 |
| M11 | 端到端联调 + 验收 | 完成 |

设计与计划文档见 [`docs/superpowers/`](docs/superpowers/)。

## 环境要求

- **Node.js ≥ 22.5**（服务端使用内置 `node:sqlite`，22.5 起可用；开发环境验证于 Node 24）
- **pnpm**（`packageManager` 锁定为 pnpm@10）

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2.（可选）抓取标准赛卡池到本地 SQLite（约 1–2 分钟）
#    未抓取时，对局会自动回退到引擎内置的 60 张演示牌组
pnpm --filter @mtg/server fetch:cards

# 3. 启动后端（HTTP + WebSocket，默认 :3000）
pnpm --filter @mtg/server build
pnpm --filter @mtg/server start

# 4. 启动前端（默认 :5173，已把 /api 与 /ws 代理到 :3000）
pnpm --filter @mtg/web dev
```

打开 <http://localhost:5173> 即可开始对局。

### 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `PORT` | 后端监听端口 | `3000` |
| `MTG_DB` | 卡池数据库路径 | `apps/server/data/mtg.db` |
| `MTG_API` | 前端 dev 代理的后端地址 | `http://localhost:3000` |

## 常用命令

```bash
pnpm test          # 全仓单测（引擎 95 项 + 服务端 14 项）
pnpm typecheck     # 全仓类型检查
pnpm build         # 全仓构建
pnpm dev           # 并行启动所有 workspace 的 dev

pnpm --filter @mtg/engine test        # 只跑引擎单测
pnpm --filter @mtg/engine build       # 引擎需先构建，服务端才可引用最新 dist
pnpm --filter @mtg/server fetch:cards # 抓取卡池
```

## 目录结构

```
packages/engine/      @mtg/engine —— 纯 TS 规则引擎（服务端专用，不依赖 UI）
  src/types.ts        卡牌 / 永久物 / 玩家 / 视图类型
  src/turn.ts         回合与阶段机（12 步顺序、优先权指针）
  src/engine.ts       引擎外壳：统一 playAction 入口、区域、战斗、判负
  src/mana.ts         法术力：费用解析、法术力池、支付
  src/stack.ts        堆叠（LIFO）
  src/combat.ts       战斗判定：先攻/连击/飞行/延势/威吓/死触/守军/敏捷
  src/sba.ts          状态检查：致命伤害、死触、判负条件
  src/ai.ts           启发式 AI 决策与对局驱动
  src/cardParser.ts   Scryfall 文本 → 结构化能力指令
  src/deck.ts         内置演示牌组（60 张）

apps/server/          @mtg/server —— 对局会话 + HTTP/WebSocket
  src/server.ts       服务装配（createGameServer，便于端到端测试）
  src/index.ts        启动入口
  src/session/        对局会话（GameSession：牌组、起手、AI 响应、事件流）
  src/data/           SQLite 存取（db / store / query / deck 构建）
  scripts/fetch-cards.ts  卡池抓取脚本

apps/web/             @mtg/web —— React 对战 UI
  src/App.tsx         牌桌：敌方区 / 中栏 / 己方区 / 操作栏
  src/useGameSocket.ts  WebSocket 通道（视图、事件、战斗态势、堆叠）
  src/types.ts        前端类型与阶段/步骤中文标签
```

## 对局协议（WebSocket `/ws`）

每条消息均为 JSON。

**客户端 → 服务端**

```jsonc
// 提交动作
{ "type": "play_action", "action": { "type": "PASS" } }
// 再来一局（新建会话并广播初始状态）
{ "type": "restart" }
```

`action` 的取值：

| type | 字段 | 说明 |
|---|---|---|
| `PASS` | — | 让过优先权（无优先权窗口的步骤则直接推进） |
| `PLAY_LAND` | `handIndex` | 下地（每回合 1 张） |
| `ACTIVATE_MANA` | `permanentId` | 横置产费地，注入法术力池 |
| `CAST` | `handIndex` | 施放咒语（入堆叠） |
| `DECLARE_ATTACKERS` | `attackerIds` | 宣告攻击者 |
| `DECLARE_BLOCKERS` | `blocks[{blockerId, attackerId}]` | 宣告阻挡者 |

**服务端 → 客户端**

| type | 内容 |
|---|---|
| `game_start` | `you`、`view`、增量 `events`、战斗态势、堆叠 |
| `game_event` | 同上（每次动作后的增量广播） |
| `error` | `message`（非法动作，不改变状态） |

`view` 为脱敏后的完整对局视图：阶段/步骤、优先权、双方生命/战场/墓地/法术力池、手牌与牌库**数量**（自己的手牌为完整内容）。

HTTP `/api/health` 返回引擎信息与卡池统计。

## 卡池与数据

抓取脚本用 Scryfall `cards/search` 的 `f:s` 查询（`unique=cards` 按名称去重）拉取标准赛合法卡，逐张解析后只写入引擎可执行的卡：

```
拉取标准赛卡牌       5164
可执行并写入 SQLite   675
被过滤（不支持）      4489
过滤原因 Top5：creature×1451, legendary×895, artifact×516, instant×465, sorcery×439
```

写入的 675 张按类别分布：

| 类别 | 数量 |
|---|---|
| 生物 | 497 |
| 瞬间 | 109 |
| 法术 | 58 |
| 灵气 | 6 |
| 地 | 5（仅五色基本地） |

全部卡牌均带 Scryfall 卡图（`image_uris`）。

> **注意**：非基本地大多带有复杂异能（横置产多色、牺牲找地、进场触发等），当前能力模型无法解析，因此卡池中的「地」只有五色基本地。`buildStandardDeck` 的 20 张地即五色基本地循环取用。

## 规则覆盖

**已实现**

- 回合结构：开始（重置/维持/抽牌）→ 主阶段一 → 战斗（开始战斗/宣告攻击者/宣告阻挡者/战斗伤害/结束战斗）→ 主阶段二 → 结束（结束/清理）
- 法术力：费用解析（通用 + 指定颜色）、地横置产费（含按副类别补齐的基本地）、法术力池支付、回合末清空
- 堆叠与优先权：咒语入栈、后进先出结算、全员让过后结算栈顶 / 推进步骤
- 战斗：宣告攻击（横置、召唤病、守军）、宣告阻挡（飞行/延势/威吓限制）、伤害分配（致命伤害、践踏溢出、多阻挡者顺序）
- 关键字：飞行、践踏、连击、警戒、先攻、威吓、延势、敏捷、守军、死触
- 状态检查：致命伤害与死触死亡、生命 ≤ 0 判负、牌库抽空判负
- 法术/瞬间效果：伤害、抓牌、加血、消灭目标

**已知简化**

- 非基本地基本不可用（见上）
- 灵气未建模「结附」关系（进场即作为永久物存在）
- 持续 P/T 修改（`+N/+N`）虽已解析但未生效
- SBA 未覆盖传奇法则、灵气无对象
- 不做法术力预留（AI 不刻意留费）
- 引擎未区分法术/瞬间的时机限制（会话层按主阶段约束）
- 断线重连 / 会话恢复未实现

不支持的卡（含鹏洛客、双面牌、保护/辟邪/不灭、`{X}` 费用等）在卡池构建阶段被过滤，不会进入对局。

## 测试与验收

```bash
pnpm test
```

- `packages/engine/test/`：7 个文件、95 项，覆盖回合机、能力解析、法术力、堆叠与优先权、战斗、状态检查、AI
- `apps/server/test/`：3 个文件、14 项，覆盖 SQLite 往返、对局会话（AI 自动响应、事件增量）、**WebSocket 协议端到端**（含"打完整局 + 再来一局"验收用例）

### 实测结果（真实卡池）

| 环节 | 结果 |
|---|---|
| 起手 | 双方 7 张，全部来自真实卡池、带卡图 |
| 牌组 | 60 张（20 地 + 16 生物 + 24 法术/瞬间） |
| 下地 / 产费 | 手牌 8→7、战场 +1、法力池「白1」、地横置 |
| AI 自主作战 | 自动下地、施法、进攻，第 36 回合以生命归零取胜（我 -6 / 对手 20） |
| 胜负结算 | 浮层「💀 你输了」+ 回合数 + 双方生命 |
| 再来一局 | 回到第 1 回合、生命 20/20、手牌 7、战场清空 |
| 脱敏 | 对手手牌与双方牌库只下发数量 |
| 控制台 | 无报错 |

## 排错

**对局用的是内置演示牌组，不是真实卡？**
说明卡池未抓取或路径不对。执行 `pnpm --filter @mtg/server fetch:cards`，并用 `/api/health` 确认 `cardPool.total` 不是 0。抓取脚本与服务的数据库路径默认都是 `apps/server/data/mtg.db`，可用 `MTG_DB` 覆盖。

**抓取脚本很慢或像是卡住了？**
脚本逐页请求 Scryfall 并输出进度（`第 N 页：累计 ...`）。单次请求有 30 秒超时、超时与 429 最多重试 5 次；若持续失败会抛出明确错误而不是永久挂起。网络不佳时可重跑。

**为什么很多牌不能用于对战？**
引擎采用「能力指令模型」，只有完全解析成功且落在首版支持范围内的卡才可执行；其余（鹏洛客、双面牌、保护/辟邪/不灭等硬机制、含 `{X}` 费用等）在卡池构建阶段被过滤。

**端口被占用？**
后端用 `PORT`，前端用 `--port`（例如 `pnpm --filter @mtg/web dev --port 5180 --strictPort`），并可用 `MTG_API` 指向非默认后端。

## 许可

未指定。
