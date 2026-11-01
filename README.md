# 铁海 1942 (Iron Seas) — README

> 二战海战模拟器（原生 ESM、零第三方依赖）。**真实感 > 建模精度 > 画面。**
> 唯一接口契约见 [ARCHITECTURE.md](ARCHITECTURE.md)；对外 AI 协议见 [AI_INTERFACE.md](AI_INTERFACE.md)。

---

## 1. 定位

**是**：一个把「1940 年代舰炮火控与夜战有多难」作为第一设计目标的实时海战模拟器。舰炮射击要解目标运动、要测距、要校射夹叉；鱼雷要算提前角且会哑弹；雷达受地平线/海杂波/箔条限制；夜战要靠探照灯与照明弹；被打中后按**命中位置**产生进水/横倾/火灾/弹药库殉爆；倾覆与弃舰是可能的结局。

**不是**：不是街机式血条对射，不是「发射导弹锁定目标」，也不是全景实时战术游戏。玩家（或 AI）看到的只有 `world.visibleStateFor(side)` 给出的、带误差与延迟的航迹 —— 雾里看花，这本身就是玩法。

硬约束（全部满足）：

| 约束 | 落实 |
| --- | --- |
| 原生 ES Module、零第三方依赖 | 无构建步骤、无 npm 依赖；`package.json` 无 dependencies |
| `src/core/**` 与 `src/sim/**` 禁止 DOM | 内核可在 Node 无头运行（`server/headless.mjs`） |
| 随机数只走 `world.rng` | `src/core/rng.js` 的 mulberry32 + Box-Muller；无 `Math.random()` |
| 一切状态变化 emit 事件 | `src/core/events.js`；事件名见 ARCHITECTURE §4，回放/AAR 全部依赖它 |
| 二战设定 | 无导弹/直升机/卫星/GPS/数据链；全表见 §6 |

---

## 2. 快速开始

要求：Node.js **≥ 22**（开发用 v24.21.0；Node 20 下 `test/t5.ai.test.mjs` 的服务器中继用例会自动跳过而不是失败）。`./run.sh` 与 `tools/ci.sh` 会自动在 PATH、`~/.local/node/bin`、nvm/volta/homebrew 常见位置里找 node，都不在时用 `NODE_BIN=/path/to/node` 指定。

```sh
# 方式一：启动脚本（默认 http://127.0.0.1:8787）
./run.sh

# 方式二：直接启动（静态服务 + WebSocket 中继 + LLM 代理）
node server/serve.mjs
# 可选：node server/serve.mjs --port 8787 --host 127.0.0.1

# 启动后浏览器打开
open http://127.0.0.1:8787
```

界面入口 `index.html` → 调用 `src/ui/app.js` 的 `bootApp()`。首次进入选择剧本 → 选边（ALLIED/AXIS）→ 「开始」。

常用附加操作：

```sh
# 列出全部剧本（含 data/scenarios.json）
node server/headless.mjs --list

# 无头跑一个剧本 30 分钟仿真时长，输出 JSON 战报与回放
node server/headless.mjs --scenario sandbox --seconds 1800 --out report.json --replay replay.json

# 校验剧本数据（本任务 T8 交付）
node test/t8.scenarios.test.mjs

# UI 自检：自己拉起 headless Chrome，真实点击每一个控件并截图（需先启动服务器）
node tools/uicheck.mjs --suite --shots .shots

# 回放分析器：把 replays/*.json 变成战报（不启动仿真）
node tools/replay-analyzer.mjs replay.json
node tools/replay-analyzer.mjs replay.json --format=html --out report.html
node tools/replay-analyzer.mjs replay.json --check

# 其它测试（全量门禁：node test/run-all.mjs；历史诊断探针在 probes/）
node probes/lead.smoke.mjs
node probes/lead.integration.mjs
node test/t2.sensors.test.mjs
node test/t4.gunnery.test.mjs
```

配置（均为可选）：

| 用途 | 环境变量 / config.json | 说明 |
| --- | --- | --- |
| 监听地址/端口 | `HOST` / `PORT` / `config.json {host,port}` | 默认 127.0.0.1:8787 |
| LLM 密钥 | `LLM_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `config.json {llm.apiKey}` | 密钥只在服务器侧，绝不回传浏览器 |
| LLM 端点与模型 | `LLM_BASE_URL`（默认 https://api.deepseek.com/v1）、`LLM_MODEL`（默认 deepseek-chat） | 任意 OpenAI 兼容端点 |
| 离线模拟 LLM | `LLM_MOCK=1` | 无网络/无密钥时返回确定性响应，便于演示与测试 |
| 连接令牌 | `SERVER_TOKEN` / `config.json {token}` | 非空时 WS 需 `?token=`，健康检查不泄露令牌 |

---

## 3. 目录与职责

```
naval/
  index.html                  UI 外壳：海图 + 面板 + 命令条 + 回放/AAR
  ARCHITECTURE.md             唯一权威接口契约（签名不得更改）
  README.md  AI_INTERFACE.md  本文档与对外 AI 协议
  run.sh                      启动脚本（自动寻找 node）
  data/
    ships_axis.json           轴心舰船数据（44 条舰位 / 35 舰级，含主炮/装甲/传感器/鱼雷）【Lead】
    ships_allied.json         同盟舰船数据（42 条舰位 / 33 舰级）【Lead】
    scenarios.json            12 个历史战役剧本【T8 本文档作者】
  src/core/                   util / rng / geo / events（已冻结）
  src/sim/                    types data ship world env dynamics damage
                              sensors vision tracks gunnery ballistics spotting torpedo
  src/ai/                     local_ai（兜底规则 AI）/ nl（中文命令与 LLM 提示词）/ bridge（可插拔后端）
  src/render/chart.js         Canvas 战术海图（只画"已知的"世界）
  src/ui/                     app panels replay aar esc theme（主题 token/切换）icons（内联 SVG）fold（窗口收起）
  server/serve.mjs            静态服务 + WS 中继 + SSE + LLM 代理 + 回放入库
  server/headless.mjs         无头交战与战报
  tools/uicheck.mjs           无头 UI 验证器（CDP：真实点击/键盘/截图/页面错误）
  tools/replay-analyzer.mjs   回放分析器（离线 AAR：text / markdown / html / --check）
  tools/replay-analyzer.html  单文件网页版（拖入回放即可看战报；由 build 脚本生成）
  tools/build-replay-analyzer-html.mjs  把 core/svg/render 打包成单文件网页
  tools/analyzer/             分析核心（core.mjs 口径与发现、svg.mjs 图表、render.mjs 渲染）
  test/                       各模块测试 + *.scenarios.test.mjs 剧本校验 + run-all.mjs 全量门禁
  probes/                     A–E 波次期间的一次性诊断/复现脚本（82 个，已从 test/ 归档；索引见 probes/README.md）
```

模块所有权与接口冻结约定见 ARCHITECTURE §1/§4。仿真主循环固定顺序见 `src/sim/world.js` 的 `step(dt)`。

### 3.1 界面结构（v6）

一屏分四块，海图占最大面积、其余三块只做「贴边档案」，不再用卡片盒子：

| 区域 | 内容 | 收起方式 |
| --- | --- | --- |
| 左侧图标轨道（54px） | 舰况 / 火控 / 损管 / 情报 / AI；底部：沉浸、收起右栏 | 沉浸模式（H）整体隐藏 |
| 顶栏（46px） | 剧本、舰钟、海况、主题、命令面板、时间压缩、暂停、更多、阵营 | — |
| 通栏海图 | 任务（左上，纸色渐隐）、战况（上中）、动作条（底部）、日志一行（底部） | 任务卡可收起；日志点「全部日志」上滑 |
| 右侧档案（308px） | 舰名 + 三个大数字（航速/航向/舵）+ 页签面板 | 轨道「›」收起 |

底部**动作条**把原先 12 个挤在一起的控件收成 5 个主目标：`开火 / 鱼雷 / 机动 / 传感器 / 口令`，点开才出现参数层（再点收起）；`口令`层打开即自动聚焦输入框，也可以直接按 `/`。

快捷键新增：`H` 沉浸模式（只留海图）、`[` `]` 观战切换跟随目标、`/` 打开口令层、`Shift+T` 循环主题。

### 3.2 界面主题与设计 token（v5）

界面有 **五套主题**：顶栏右侧五段按钮一键切换（当前项高亮），也可以 `Shift+T` 循环；选择存在 `localStorage.ironseas_theme`。

| 主题 | `data-theme` | 语言 |
| --- | --- | --- |
| 纸面 | `paper` | 默认：米色纸 + 打字机等宽体 |
| 海图 | `chart` | 方案 A：图廓刻度、直角、宋体标题、硬墨线、等深线虚线 |
| 印刷 | `riso` | 方案 B：深褐 + 朱红双色油墨，粗墨线、零圆角、陆地朱红斜线 |
| 夜间 | `dark` | 原深海战术台 |
| 高对比 | `contrast` | 无障碍：纯黑底 + 纯白前景 + 高亮强调，焦点环加粗 |

- **可访问性**：rail / 顶栏 / 页签 / 动作条均带 aria 状态（aria-selected / aria-pressed / aria-expanded 由类同步），支持键盘焦点环与 `prefers-reduced-motion`，并有 ≤1024px / ≤820px 两条触控断点（命中区 ≥44px）。
- **唯一事实来源**：`index.html` 里 `:root[data-theme="paper"|"chart"|"riso"|"dark"|"contrast"]` 五组 CSS 变量。改配色只改这一处。
- **Canvas 跟随主题**：`src/ui/theme.js` 的 `chartPalette()` 把同一批 `--c-*` 变量读给 Canvas（按主题缓存，切换自动失效），`alpha(color, a)` 负责把实色转成带透明度的 `rgba()`。
  护栏：`grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' src/render/chart.js` 应当为空——这样"换皮"不需要动任何绘制代码。
- **版式尺度**：6 档字号 `--fs-1…--fs-6`、6 档圆角 `--r-lg/--r/--r-2/--r-s/--r-xs/--r-pill`，组件不再手写字号与圆角。
- **字族**：打字机等宽体优先（`--font-ui`：拉丁字母与数字走 Courier，中文回落苹方）。
- **窗口收起**：任务卡、战况条、指挥台、信号日志、侧栏，以及侧栏里的**每一张卡**都能收起。由 `src/ui/fold.js` 统一接管——已有收起控件的窗口只补持久化，没有的注入一个；状态存 `localStorage.ironseas_fold`，面板重建 / 换剧本后自动恢复。
- **结构差异也走 token**：圆角 `--r-*`、陆地斜线 `--c-hatch-a`、图廓 `--c-frame-a`、等深线虚线 `--c-depth-dash`、标注字族 `--c-label-font`——`chart.js` 里没有 `if(theme)`，换主题只改 CSS 变量。
- **新增主题**：在 `index.html` 复制一组 `:root[data-theme="xxx"]{…}`（必须含全部 `--c-*`），把名字加进 `theme.js` 的 `THEMES`，再给顶栏 `#segTheme` 添一个按钮即可（点击是事件委托，不需要额外接线）。

---

## 4. 玩法

### 4.1 三级指挥层级

界面上可随时切换指挥层级（指挥层级只影响命令的作用范围与延迟，不影响物理）：

| 层级 | 含义 | 效果 |
| --- | --- | --- |
| **FLEET 编队指挥官** | 全编队航线、编队、目标分配 | 命令 `scope:'FLEET'`，对全编队生效；`world.issueCommand` 额外 +5 s C2 延迟 |
| **CAPTAIN 舰长** | 单舰航向/航速/舵/开火/鱼雷 | 默认层级，命令带 `shipId` |
| **DEPARTMENT 部门** | CIC/损管/轮机：损管优先级、雷达/声呐/探照灯/烟幕 | 细粒度子系统命令（`DC_PRIORITY` `RADAR` `SONAR` `SEARCHLIGHT` `SMOKE`） |

**指挥延迟是真实感的一部分**：命令从 `t_issue` 到 `t_effective` 的延迟 = `side.orderDelay_s`（剧本 4～12 s）+ 舰队级 +5 s + 超无线电地平线中继 +9 s（`world.radioRelayPenaltyS`）。期间命令在 `world.pending` 中排队，`order.issue` / `order.effective` 两个事件记录全过程。

### 4.2 操作

界面是 **v4 版**（2026-10 重写）：底部常驻**指挥台**，顶栏是全局控制，右侧是细节面板，下方是信号日志。

- **指挥台（底部常驻，两行）**：第一行是选中舰摘要 + 航速 + 航向/舵 + 舰务（烟幕/雷达/探照灯/撤退）；第二行是武器（开火 AP / HE / 停火 / 雷击）+ 中文口令输入框。所有按钮都作用于**当前选中的舰**；没有选中时会自动落到旗舰并给出回执提示——不会静默失败。
- **中文口令**：`航向 240` `24 节` `左转 30 度` `向最近的敌舰开火` `鱼雷齐射` `放烟幕` `停火` `撤退`（`src/ai/nl.js` 解析；规则未命中且后端为「大模型」时交给模型理解）。
- **三级指挥层级**（顶栏切换）：舰长=只作用于选中舰；**编队指挥官=命令展开到本方全部在航舰**（并有 +5 s 中继延迟）；部门=直接干预损管优先级与雷达/探照灯等设备。
- **时间压缩** `1`~`4` 或按钮切换 **1x / 4x / 16x / 64x**；内部定步长 0.1 s（clamp ≤ 0.25 s），故压缩不改变物理结果与随机序列。
- **随机种子（可改）**：开局菜单可「手填 / 随机种子 / 改用默认」。传感器噪声、弹着、损伤判定都由种子驱动，因此**同种子 + 同样指挥 = 同一场战局**——记下日志里的「随机种子 N」填回去即可复盘或分享；改一个数字就是全新一局。战报页有「用此种子重开」，沙盒设置同样可改种子，深链 `?scen=denmark_strait_1941&seed=19420604` 可直达（截图/自动化用）。种子为无符号 32 位整数，非法输入会被拒绝而非静默改写。
- **海图**：拖拽平移、滚轮缩放、左键选舰/选航迹（未探测到的敌舰不可点选）、右键上下文命令菜单（转向/全速/停车/开火/雷击/烟幕/箔条/跟随）、点右下小地图跳转视野、`F` 自动取景。
- **面板**：舰况（编队列表 + 舰体与人员 + 待生效命令）、火控（炮座/指挥仪解算/雷达声呐/开火）、损管（总览/受损舱段/关键设备/损管优先级）、情报（航迹卡片：距离·方位·航向·航速·判型·误差·置信度，点一下即指定为射击目标；环境）、AI（后端/预设/模型/持久记忆/上下文预览/指令回执/对话）。
- **指挥延迟**：命令从 `t_issue` 到 `t_effective` 有 4~12 s 延迟（＋编队级 5 s＋超视距中继 9 s）；「指令回执」逐条显示谁下的令、什么令、给谁、还有几秒生效。
- **反馈**：每次下令都弹一条含生效倒计时的回执提示，海图上闪一下目标航向；只有沉没/殉爆/胜负等关键事件才弹提示条，避免刷屏。
- 结束时自动生成 **AAR 战后报告**（双方损失、逐舰弹药/命中/进水明细、关键事件时间线、事件统计、对照历史），可导出回放 JSON，并用海图播放器回放。

交互实现上的两条硬规则（旧版的「按钮点了没反应」就出在这里）：**① 侧栏面板只在「结构签名」变化时重建 DOM，高频数字走 `data-live` 文本补丁，指针按下或焦点在面板内时绝不重建**；**② 全应用只有一处点击委托（`document` 上的 click + `closest('[data-act]')`），节点怎么换都能命中**。此外：输入框里打字不会再触发全局数字快捷键；`prompt()` 弹窗换成了自绘模态框（回车确认 / Esc 取消）；仿真主循环任何一段抛异常都不会再打断 rAF 链。

### 4.3 观战（SPECTATE）

观战不进作战界面：动作条整体隐藏，换成底部**观战条**（镜头模式 / 上一艘 / 下一艘 / 沉浸 / 退出观战）。

- **导播**：按「最近 15 秒有没有开火或被命中」给分（旧版用累计开火数，打一会儿所有舰分数就趋同），选中后**平滑移动**镜头（`chart.centerOn` 走缓动），并按交战距离**自动推拉**：近距离 0.34、中距 0.22、远距 0.075，每帧只走 2% 避免抽搐。
- **自由 / 同盟 / 轴心**：自由视角，或锁定某一方旗舰。
- **跟随**：`[` `]` 或观战条按钮在双方所有在航舰之间循环，提示条会显示「跟随：舰名（阵营）」。
- **沉浸**：`H` 或观战条「沉浸」，只留海图，按 `H` 退出。

### 4.4 三种对手

| 后端 | 说明 |
| --- | --- |
| `LOCAL` | 进程内规则 AI，永远可用，是兜底与基准 |
| `REMOTE` | 外部智能体（Python/Node/任意语言）经 WS 或 SSE + `POST /api/orders` 接入，只拿到本方可见态势 |
| `LLM` | 服务器代理 OpenAI 兼容端点；提示词由 `buildLLMPrompt()` 生成，输出经白名单校验后转成命令 |

掉线与回落语义、完整协议与示例智能体见 [AI_INTERFACE.md](AI_INTERFACE.md)。

---

## 5. 剧本集（data/scenarios.json）

12 个剧本，逐一可玩；每个剧本含双方 OOB、初始经纬度/航向/航速、天气与海况、任务目标与胜负条件（`world._objectiveMet` 支持的 7 种 condition）。

| id | 名称 | 日期 | 地点 | 舰数(盟/轴) | 开局 UTC（括号内为当地平太阳时） | 风/能见度/海况 |
| --- | --- | --- | --- | --- | --- | --- |
| denmark_strait_1941 | 丹麦海峡海战 | 1941-05-24 | 格陵兰—冰岛之间 | 4/2 | 05:30（当地 03:21，史实拂晓交战） | 18kn / 8nmi / 4（浓雾与冰缘低能见度） |
| denmark_strait_1941_duel | 丹麦海峡海战（主力对决） | 1941-05-24 | 格陵兰—冰岛之间 | 2/2 | 05:30（当地 03:21，同原剧本） | 18kn / 8nmi / 4（同原剧本；移除北方两艘重巡） |
| river_plate_1939 | 拉普拉塔河口海战 | 1939-12-13 | 乌拉圭外海 | 3/1 | 09:36（当地 06:18，史实发现并开火） | 10kn / 18nmi / 3 |
| savo_island_1942 | 萨沃岛海战 | 1942-08-09 | 萨沃岛—瓜岛之间 | 9/8 | 14:50（当地 01:29，史实 01:30） | 4kn / 6nmi / 2（夜间） |
| first_guadalcanal_1942 | 第一次瓜达尔卡纳尔海战 | 1942-11-13 | Ironbottom Sound | 11/9 | 15:05（当地 01:44，史实 01:48） | 3kn / 4nmi / 2（暴雨飑、夜间） |
| surigao_strait_1944 | 苏里高海峡夜战 | 1944-10-25 | 棉兰老海北口 | 12/7 | 19:00（当地 03:21，夜战窗口 02:00–04:19 的战列线阶段） | 6kn / 7nmi / 3（夜间） |
| north_cape_1943 | 北角海战 | 1943-12-26 | 巴伦支海 | 9/4 | 14:36（当地 16:30，史实主炮交战开始） | 30kn / 6nmi / 6（极夜风暴） |
| java_sea_1942 | 爪哇海海战 | 1942-02-27 | 泗水以北 | 6/10 | 09:30（当地 17:00，史实 16:16 发现后接战） | 6kn / 14nmi / 2 |
| matapan_1941 | 马塔潘角海战 | 1941-03-28 | 马塔潘角以南 | 8/5 | 21:00（当地 22:26，史实夜战爆发） | 8kn / 5nmi / 3（无月黑夜） |
| komandorski_1943 | 科曼多尔群岛海战 | 1943-03-26 | 阿留申以西 | 6/8 | 21:15（25 日；当地 26 日 08:31，史实 08:30） | 15kn / 20nmi / 4 |
| casablanca_1942 | 卡萨布兰卡海战 | 1942-11-08 | 卡萨布兰卡港外 | 6/8 | 07:30（当地 07:00，当地日出 06:43） | 8kn / 12nmi / 3 |
| sandbox | 沙盒演习 | 1943-06-01 | 北大西洋中部 | 4/4 | 12:00（当地 09:20，任意选定） | 12kn / 15nmi / 4 |

每个剧本的 `historicalNote` 写明真实背景与结局；`ships[].note` 写明舰级替代；`_oobNote` 与 `_meta.substitutions` 汇总替换映射；`_timeNote` 记录本剧本开局所对应的**史实当地时刻**与依据。全部 `start.date` 均为 UTC；`env.js` 以当地平太阳时 `local = UTC + lon/15` 计算日照，故 `UTC = 史实当地时刻 − lon/15`，全部对齐到 ±4 min 内：5 个夜战剧本开局日高 −15.7°～−67.3°（开局即夜），白昼/黎明剧本亦落在史实日照条件上。§8 的 t8 校验会用真实 `Environment` 打印每个剧本的当地时间并与史实值比对（±30 min）。

数据约定：

- `ships[].class` 必须是 `data/ships_*.json` 里存在的 class 字符串（或 `id:<id>`），由 `ShipDatabase.resolve` 解析；当前 148 条舰位引用 **全部可解析**。
- `scenario.env` 为权威环境输入；`start.env` 是它的同值副本（`world.js` 从 `start.env` 构造 `Environment`）。
- `role` ∈ flagship/line/screen（旗舰用于无线电中继惩罚判定与 UI）；`crewQuality` ∈ 0.65/0.7/0.85/1.0/1.15，影响装填、损管、测距判读与校射。例：丹麦海峡 Hood=1.0、Prince of Wales=0.65（新舰新兵、炮塔故障史实）；萨沃岛日军全员 1.15、美军全员 0.7（夜战训练差距）。
- 胜负由 `objectives[].condition.type` 判定：SINK / SINK_ANY / DISABLE / SINK_COUNT / SURVIVE / EXIT / PROTECT；`EXIT` 的 `area{x,y,r}` 用世界米制坐标（原点 = `start.lat/lon`）。

---

## 6. 真实感清单（逐条对应实现）

| # | 真实感项 | 实现 | 关键模型/数值 |
| --- | --- | --- | --- |
| 1 | 目视发现受能见度、海况、夜色、烟幕、目标投影影响 | `src/sim/vision.js` | Koschmieder 定律 `R = ln(C0/Cth)/σ`，`σ = 3.912/V`；地平线 `4.12(√h_eye+√h_tgt) km` |
| 2 | 光学测距有基线微分误差 | `src/sim/vision.js` / `gunnery.js` | `dR = R²·dθ/B`，重合式 1.3″、立体式 2.0″；8 m 基线 @20 km → ±240 m |
| 3 | 雷达按雷达方程 + 地平线 + 海杂波 + 箔条 | `src/sim/sensors.js` | `Pr = PtG²λ²σ/((4π)³R⁴)·F⁴`；以数据表 `detectBB_nm` 标定；杂波基准 −35 dB @海况4；扫描周期与 Swerling-I 发现概率 |
| 4 | 火控需解目标运动，有解算误差与更新延迟 | `src/sim/gunnery.js` | 对过去 ~90 s 的 (R,β) 做加权最小二乘/常速 Kalman，解算需 30～90 s 稳定；误差随 TOF 外推放大 |
| 5 | 一次齐射有散布椭圆；夹叉/梯次校射 | `gunnery.js` + `ballistics.js` + `spotting.js` | 散布半宽 `dispersionHalfWidthMil`；RANGING→BRACKET→EFFECT 三阶段，步长 600 m 限幅、gain 0.8/0.4/0.5；观察延迟 1.5～4 s |
| 6 | 命中判定含落角与装甲等效穿深 | `src/sim/ballistics.js` | RK4 质点弹道 + 马赫阻力峰；德马尔式 `P = C·m·v/d^1.75`（C=27）；`t_eff = t/cos^1.15 θ`；跳弹 >58°、过穿 `t < 0.18P` |
| 7 | 鱼雷有射击诸元、双档、航迹差异、哑弹 | `src/sim/torpedo.js` | 提前角 `sinλ = (Vt/VT)sinβ` + 不动点迭代；九三式 48kn/20km 与 36kn/40km；氧气鱼雷航迹极淡；1942 美制鱼雷 dud 45%/deepRun 30%/prem 20% |
| 8 | 命中位置决定后果（进水/倾斜/火灾/殉爆） | `src/sim/damage.js` | 孔口出流 `Q = Cd·A·√(2gh)`（Cd 0.62）；AP 冲塞孔 ≈1.15 倍口径、鱼雷 `A ≈ 0.055W^0.6`；分舱室损管与注水 |
| 9 | 倾斜与进水影响航速、精度、稳性；可倾覆 | `src/sim/ship.js` + `damage.js` | `tanθ = 横倾力矩/(Δ·GM)`，GM 随干舷损失折减；|list|>62° 触发 `ship.capsize` |
| 10 | 海况影响航速（首浪失速）与横摇 | `src/sim/dynamics.js` + `env.js` | 风浪 Hs 由 P-M 谱 `0.0214U²·0.65`；Froude 附加阻力 `R_add = 0.64ρgB²h²/L`；横摇 RAO 单自由度 + 遭遇频率 |
| 11 | 主机响应、舵效、回转半径与低速舵效丧失 | `src/sim/dynamics.js` | Admiralty 关系 `v ∝ P^(1/3)`、η≈0.58；Nomoto 一阶 K∝V；低速舵效 `V²/(V²+V_ref²)`，V_ref≈1.6 kn |
| 12 | 早期雷达能力有限（型号差异） | `src/sim/sensors.js` + 数据表 | 每型雷达独立 `peakKW`/`gain`/`wavelength`/`detectBB_nm`；1941 意大利舰无雷达 |
| 13 | 无数据链：航迹共享有报告延迟与精度损失 | `src/sim/tracks.js` | 舰内 CIC +5 s；超地平线中继 +9 s；共享误差按报告龄期放大，置信度打折 |
| 14 | 指挥延迟与超视距中继惩罚 | `src/sim/world.js` | `orderDelay_s`（4～12 s）+ 舰队 +5 s + 中继 +9 s；`order.issue/effective` 事件 |
| 15 | 弹药库殉爆、探照灯暴露、照明弹、烟幕 | `damage.js` / `sensors.js` / `vision.js` | `dam.magazine` 事件；`SEARCHLIGHT`/`STAR_SHELL`/`SMOKE` 命令改变发现与被发现概率 |
| 16 | 时间压缩不改变物理结果 | `world.step/clamp` + `rng` | 固定步长 0.1 s，dt clamp ≤0.25 s；全部随机走可复现 RNG |
| 17 | 雾里看花：玩家与 AI 只能看到本方航迹 | `world.visibleStateFor` + `chart.js` | UI/协议只暴露 `visibleStateFor(side)`；敌舰以航迹 + 误差椭圆呈现 |

---

## 7. 局限与已知偏差（明确告知）

1. **航空兵不参与交战**：航母（Ranger、Formidable、翔鹤等）不出现在剧本 OOB 中或仅作背景说明；空投鱼雷、舰载机侦察与岸基航空兵均未建模 —— 因此马塔潘角的空投鱼雷命中以剧本注释说明，卡萨布兰卡的美军舰载机压制被省略。
2. **无岸炮与陆上目标**：卡萨布兰卡的 El Hank 炮台、登陆部队均未建模。
3. **无潜艇**：萨沃岛归航途中 Kako 被 S-44 击沉一类事件不在仿真内。
4. **地形/水深不参与弹道与航行**：海峡、浅滩不限制机动（苏里高海峡的狭窄水道仅由初始位置体现）。
5. **冻结舰级表的替代**：荷兰舰艇、维希法国巡洋舰等无独立数据，按就近舰级替代并在 `data/scenarios.json` 的 `ships[].note` 与 `_meta.substitutions` 中逐条标注；部分标准型战列舰（田纳西/加利福尼亚/宾夕法尼亚/新墨西哥）以 Colorado 级数据近似。意大利驱逐舰（Soldati 级）与德国 Z 驱（Type 1936A）已补入独立舰级数据。
6. **LOCAL AI 是规则型基准指挥官（已实现条令，但非最优）**：`src/ai/local_ai.js` 已包含阵位/屏护、抢占 T 字位、免疫区与决战距离控制、烟幕掩护、受损脱离与归队、损管优先级、协同雷击与雷击突击占位、弹药经济等条令；但它仍是"规则 + 启发式"，不做全局博弈搜索，也不擅长多舰协同的复杂机动，因此替换为 REMOTE/LLM 后端仍可获得更强对手。
7. **帆缆/信号/旗语、无线电测向干扰、夜间航空侦察**等未建模。
8. **剧本开局时刻按史实当地时刻对齐**（依据各剧本 `_timeNote`）：`UTC = 史实当地平太阳时 − lon/15`，与史实偏差 ≤ 4 min。个别剧本刻意取史实战斗窗口内的某一阶段作为开局（如苏里高取战列线阶段的 03:21，而非鱼雷攻击开始的 02:55），理由见 `_oobNote`。

---

## 8. 测试与验收

| 测试 | 覆盖 | 运行 |
| --- | --- | --- |
| `test/run-all.mjs` | **全量验收**：内核/单元/集成/剧本/无头/UI 启动，共 29 项 | `npm test` |
| `probes/lead.smoke.mjs` | 冻结内核冒烟（不依赖 data/） | `node probes/lead.smoke.mjs` |
| `probes/lead.integration.mjs` | 全链路集成（含陆地遮蔽 / 误击 / 条令） | `node probes/lead.integration.mjs` |
| `test/t2.sensors.test.mjs` | 传感器 / 光学 / 航迹 / 识别证据 | `node test/t2.sensors.test.mjs` |
| `test/t3.damage.test.mjs` | 损伤与损管 | `node test/t3.damage.test.mjs` |
| `test/t4.gunnery.test.mjs` | 火控 / 弹道 / 校射（标定带见 §8.2） | `node test/t4.gunnery.test.mjs` |
| `test/t6.tactics.test.mjs` | 战术 AI 与鱼雷 | `node test/t6.tactics.test.mjs` |
| `test/t8.scenarios.test.mjs` | **12 个剧本静态校验** | `node test/t8.scenarios.test.mjs` |
| `test/t9.stats.test.mjs` | 命中统计口径（被命中不双计、近失单列） | `node test/t9.stats.test.mjs` |
| `test/t10.magazine.test.mjs` | 殉爆语义（detonation 必沉、风险事件不沉） | `node test/t10.magazine.test.mjs` |
| `test/t11.report.test.mjs` | 长局事件不截断 / 战报大事记 / AAR 时间线 | `node test/t11.report.test.mjs` |
| `test/t12.ai.test.mjs` | LOCAL AI 命令节流后仍接战 | `node test/t12.ai.test.mjs` |
| `test/t13.terrain.test.mjs` | 陆地遮蔽视线与弹道（gun.terrain） | `node test/t13.terrain.test.mjs` |
| `test/t14.friendlyfire.test.mjs` | 敌我识别不确定与友军误伤 | `node test/t14.friendlyfire.test.mjs` |
| `test/t15.ai_doctrine.test.mjs` | AI 条令：协同雷击 / 受损脱离 | `node test/t15.ai_doctrine.test.mjs` |
| `test/t16.a11y.test.mjs` | 可访问性 / 高对比主题 / 触控断点 | `node test/t16.a11y.test.mjs` |
| `test/t17.triggers.test.mjs` | 剧本触发器（时间 / 条件 / 目标激活） | `node test/t17.triggers.test.mjs` |
| `test/t21.sandbox604.test.mjs` | 沙盒 3v3 @seed 604 回归：无友军鱼雷 / 后半场仍开火 / 航迹不爆炸 | `node test/t21.sandbox604.test.mjs` |
| `test/t23.replay_analyzer.test.mjs` | 回放分析器：统计口径 / 发现 / 检查规则 / 三种渲染 | `node test/t23.replay_analyzer.test.mjs` |
| `test/golden.seed.test.mjs` | 黄金种子回归：固定 seed 的胜方/沉没/命中不漂移 | `npm run test:golden` |
| `tools/uicheck.mjs` | **UI 端到端**：真实鼠标/键盘驱动 headless Chrome，含慢点击/打字/模态框回归 | `node tools/uicheck.mjs --suite` |

探测脚本（`probes/`）：A–E 波次开发与标定期间写的一次性诊断/复现脚本（共 82 个），已从 `test/` 归档；绝大多数不参与门禁，其中 4 个仍被 `test/run-all.mjs` 当门禁步骤（smoke / gunnery_probe / integration×2 / uiboot），改动 `src/` 后必须保持通过。索引见 `probes/README.md`。

`t8.scenarios.test.mjs` 校验内容：结构/字段完整性、id 唯一、经纬度合理、`class` 可被 `ShipDatabase.resolve` 解析、任意两舰间距 > 250 m、双方初始距离 > 2 km、objectives 的 `condition.type` 合法且 `shipIds` 存在且属于正确阵营、EXIT 区域开局不含本方舰船、`env` 五要素范围、`start.env` 与 `env` 一致、**开局当地平太阳时与史实对照**（调用真实 `Environment`，逐剧本打印「UTC／当地／史实值／Δmin／日高／光照／夜-昼」表并按 ±30 min 校验）、夜战剧本开局必须为夜间（`lightLevel < 0.15` 且日高 < 0）、以及用真实 `World` 装配沙盒剧本推进 60 s 的集成冒烟。数据文件缺失时输出 `PENDING DATA` 并以 0 退出（等待数据），不崩溃；数据齐全后仍有未解析 class 则判失败。

最近一次结果（2026-11-01）：**PASS 2061 / FAIL 0 / WARN 0**，12 剧本 / 148 舰位、舰级 0 个未解析；全量验收 `npm test` **29/29 项通过**。

### 8.2 标定带与已知偏差

`test/t4.gunnery.test.mjs` 的标定断言现已全部通过（60/0，2026-11-01 复核）。此前长期存在的两项（16 km 静止目标命中率 8.3% 超出 2–8% 带；「航迹位置错误使命中率下降」符号翻转）已由 2026-10-31 的校射隔离与射界修复消除，保留此条作为回归提醒：若再次出现，优先检查校射偏置是否被副炮落点污染，以及单次样本比较的统计量是否足够。

---

### 8.1 进水与沉没模型（v8 校准）

旧模型有三处口径错误，导致「怎么打都沉不了」：

1. 储备浮力取 (排水量/1.025)×1.35，而舱室体积之和恰好等于排水体积 → 「进水总量 > 0.95×储备浮力」这条沉没判据在数学上永远不成立；
2. 吃水增量用水线面 0.75·L·B（比实际 ∇/T 大约 50%）→ 甲板入水判据也几乎达不到；
3. 水下破口在「舱内水位高于舷外」时会让水倒流回海里，等于给所有破舱自动排水。

修正：储备浮力改为水线以上可浸体积 ∇×(hullDepth/draft−1)；水线面用 ∇/T；取消倒流；鱼雷爆炸把破口扩散到相邻 1–2 个舱室（按舰型缩放：主力舰 TDS 0.45、巡洋舰 0.75、驱逐舰 0.75 且只扩散相邻一舱）；渐进进水改为水头驱动（完整舱壁小渗漏、受冲击舱壁成倍）；稳性侧沿用原有标定（自由液面折减 0.28、倾覆门槛 GM<0.35 且 |横倾|>28°），未随进水口径一起放宽。

校准结果（900 s 内）：驱逐舰 1 条 610 mm 九三式 → 倾覆沉没（约 4 min），2 条 → 约 2.3 min；巡洋舰 1 条 → 仍浮航（进水 5%），3 条 → 沉没（约 7 min）；战列舰 2 条 → 仍浮航（4%），6 条 → 沉没（约 3 min）。剧本级：丹麦海峡俾斯麦沉没（旧模型 0.6% 进水、永不沉）、马塔潘角扎拉沉没、第一次瓜岛 40 分钟 3 沉（照月/库欣/斯特雷特）。注意 floodedPct 口径随之变化：现在 100% 即接近沉没阈值。

### 8.3 舰种损伤阈值与单发破坏范围（2026-10 修订）

两处会让「大和很脆」的建模问题：

1. **单发炮弹的破坏范围过大**：`damageSubsystems()` 对炮弹取 `nb=2`、半径 `rB=0.10`（大和 263 m → 26 m），一发穿透弹同时打坏两台锅炉；同一次命中的二次结算（命中舱 + 引信延迟舱）还会对同一设备重复扣血 → 2~3 发即丢 4 台锅炉、航速上限掉到 63%。现改为炮弹 `nb=1 / rB=0.055`（鱼雷保留大范围连带），并按设备去重（`hit._subsHit`）。实测大和单发 460 mm 命中机炉舱：航速上限 94.5%（旧 79%），只坏 1 个设备组。
2. **脱离阈值不分舰种**：旧条令对所有舰统一「进水 5% / 航速上限 72% 即判重伤撤退」，战列舰航速上限掉到 70% 就撤——玩家看到的是「最强战列舰挨两下就跑」。现按舰种分层（`DAMAGE_DOCTRINE.byType`）：BB 12% / 50%，BC 11% / 52%，CV 9% / 60%，DD/CL/CA 维持原值。实测大和 1v3 衣阿华：判退时刻由 t=188 s（5 发命中、进水 0%、主炮完好）推迟到 t=262 s（13 发、主炮损失 33%）。

另修一处 NaN 扩散：命令层（`Ship.applyOrder`）与 AI（`setCourse/setSpeed`）现在拒收非有限参数——此前一条 NaN 航向会经自动操舵污染 rudder/turnRate/heading/pos，再经编队形心在一个 tick 内扩散成全舰队坐标 NaN。

### 8.4 友军鱼雷走廊与命中部位判定（2026-10 修订，回应「大和很脆」）

用户回放 `sandbox_custom@604` 里大和 **83 秒** 就弹药库殉爆，定位出三条独立缺陷（均已复现并修复）：

1. **友军鱼雷误伤**：高雄向 265° 齐射 4 条九二式时，大和在扇面外 50°，旧 `corridorClear()` 只看发射瞬间方位便放行；大和 5 秒后接到「掉头朝西」的命令，正好横穿雷道，33 秒后 4 条鱼雷**全部命中自己的旗舰**。现在发射前叠加「纵向/横向 + 可达收缩」与相对运动 CPA 两条判据：按鱼雷到达友舰所在纵向位置的时间，估计它最多能把横向距离收多少，压进安全距离就拒绝发射。同场景复跑：友军鱼雷命中 4 → 0。
2. **水线命中绕过装甲**：旧 `resolveHitPart()` 对 `entry.z < 0.8` 一律给 `armorMM = 0` 并强制穿透+引爆，一发 203 mm HE 打在水线下 0.8 m 就能无视大和 410 mm 装甲带直入弹药库。现在按舱段装甲带厚度判定，只有低于装甲带下缘（`beltHeight_m/2 + 0.3`）才视为无装甲舰底。
3. **非炮塔命中按 x 位置重创炮塔/火控**：`damageSubsystems()` 不看命中部位，任何穿透弹只要落在炮塔站位 ±18 m 内就按 0.7 系数摧毁炮塔，落在 0.33~0.62 就伤指挥仪/雷达——舷侧装甲带的穿透弹也能 2 发毁一座 650 mm 炮塔、3 分钟打光全部火控，大和因此「既不还手又很快瘫」。现在炮塔只在 `hitPart=TURRET` 时重创（其余部位穿透仅 0.15 轻微波及），指挥仪/雷达只在命中上层建筑/舰桥/炮塔时波及。

修复后同场景（seed 604）：大和由「t≈83 s 殉爆沉没」变为「在航、进水 1%、主炮 3/3 完好、命中敌舰 23 发」（修复前：主炮 0/3、命中 7 发、被弹 72）。

### 8.5 按第三方 AAR（SBX-604）逐条修复

外部 AI 用回放重建的《沙盒演习战报 SBX-604》指出四类故障，均已修复并固化为回归：

1. **后半场 371 秒全队静默**（战报："轴心最后一炮 268.6 s，之后一炮未发"）。根因是"目标航迹消亡 → 停火死锁"：`world.tracks.byId(targetTrackId)` 返回 `null` 后 gunnery 不开火，但 `commanded.firing` 仍为 `true`，AI 侧看到 firing 为真就不再重发 FIRE，于是一直指着一个不存在的航迹 id。现在 `updateFireControl` 在航迹消亡时清空 `firing/targetTrackId`（emit `fc.update: TARGET_LOST`），AI 侧 `targetChanged` 也能打破"看起来正在射击"的状态。实测同场景：轴心 t>268 s 开火 0 → 366 发，最后一炮 165.9 s → 632.6 s。
2. **判型漂移与"追航母"**（战报："同盟对 T5 走完 BB→BC→CA→CL，轴心把 57,500 t 的衣阿华当航母追着打"）。根因不是滞回不足，而是**一条航迹同时对应三艘不同军舰**：被动水听航迹 `errM≈8 km` 使关联门限 `3·baseSigma` 放大到 24 km，把编队里相距 700 m 的 BB+CA+DD 全吸进同一条航迹，其 RCS/尺寸是三者混合，判型只能逐 tick 乱跳。现在四道防护：关联阶段拒绝"已绑定实舰 A 的航迹吸收实舰 B 的观测"、`rangeOnly` 雷达分支同样设防、`_observe` 末级兜底（冲突则另起新航迹）、合并要求双方 `_trueIds` 非空且有交集（+RCS 一致性）。判型滞回也统一为投票（UNKNOWN↔已判型 2 票、已判型改判 3 票），中间置信度分支不再逐 tick 直接覆盖。实测最终 6 舰沙盒：6 条航迹、每舰 1 条、多舰混合 0 条，判型全程稳定。
3. **碰撞零损伤**（战报："高雄与阳炎 75–101 s 相撞 6 次，无任何损伤结算"）。旧实现用标量速差 `|vA|-|vB|+2` 当相对速度，横越相撞也算成 2 kn。现改为速度矢量之差，相对速度 > 4 kn 时走与炮弹/鱼雷同一条 `damage.applyHit` 管线产生破口/进水/结构损伤（同一对舰 15 s 内只结算一次），且不计入"被命中"口径。
4. **战报层**：沙盒关闭胜负时显式输出「未分胜负（沙盒关闭胜负判定）」；**友军误伤置顶**为红色告警块（鱼雷/炮弹分列并给出前三例）；逐舰表新增「命中率」「弹药余/耗」两列。

顺带修掉一个命令风暴：`smoke()` 原先只比较 `flags.smokeOn`，而命令有 4–12 s 延迟，`react()` 的 1 s 回路会在延迟窗口里每 tick 重发——实测一局撤烟 133 条 / 施烟 41 条。现记住"最后一次下发的意图"，同场景 SMOKE 命令 174 → 14 条。

回归用例：`test/t20.friendly_torp.test.mjs`（友军鱼雷走廊几何 + 端到端）、`test/t21.sandbox604.test.mjs`（种子 604 沙盒：无友军雷 / 轴心后半场仍开火 / 最终航迹每舰一条且无融合幽灵）。

### 8.6 回放分析器（离线 AAR）

`tools/replay-analyzer.mjs` 把任意 `exportReplay()` 回放转成战报，**不启动仿真、不依赖浏览器**，可对玩家导出的回放做离线复盘：

```sh
node tools/replay-analyzer.mjs replay.json                      # 终端摘要
node tools/replay-analyzer.mjs replay.json --format=md          # Markdown
node tools/replay-analyzer.mjs replay.json --format=html --out report.html
node tools/replay-analyzer.mjs replay.json --check              # 回归检查（失败退出码 1）
```

**网页版（单文件）**：不想开终端就用 `tools/replay-analyzer.html`——浏览器直接打开，把 `*-replay.json` **拖进去**、**选择文件**、或直接 **Ctrl/⌘+V 粘贴** 即可（页面任意位置粘贴都行，几十 MB 的回放也吃得下）；可同时拖入/粘贴 `ships_allied.json` / `ships_axis.json` 补全吨位/乘员/主炮。页面含三张图、发现清单、以及和 `--check` 同款的 PASS/FAIL 标记，右上角可「下载 HTML 战报」。整页纯前端：不上传、不联网。

- 改了 core/svg/render 后重新构建：`npm run analyze:build`（或 `node tools/build-replay-analyzer-html.mjs`）
- 直接看演示：`tools/replay-analyzer.html?demo=1`（内置合成示例，故意复刻友军雷击局）
- 从 URL 载入（需 http 环境）：`tools/replay-analyzer.html?replay=/api/replay?id=xxx`

**回放从哪来**：① 游戏内菜单「界面 → 导出完整回放」得到 `<scenario>-replay.json`；② 无头运行 `node server/headless.mjs --scenario ... --replay replay.json`；③ 服务器回放入库目录 `replays/`（`GET /api/replay` 列表/下载）。三条路径产出的都是同一种 `exportReplay()` 格式（必须有 `events` 数组）。

**退出码**：`0` 成功 / 检查通过；`1` `--check` 未通过（可当 CI 门禁）；`2` 参数错误或回放读取失败。`--check=friendly-torpedo,no-long-silence` 可只跑子集；`--quiet` 只输出检查结论。

**性能**：20–50 MB 的回放（9,000–7,500 事件）解析 + 出 HTML 约 0.2–0.4 s，可在 CI 里对每份导出回放跑一遍。

口径全部可回溯到事件：射击 = `gun.fire`、命中 = `gun.hit`、鱼雷 = `torp.launch/hit`、阵亡 = `dam.casualties` + `dam.magazine.killed`、指令 = `order.issue`、判型漂移从 `ai.decision` 文本里的「集火XX(Tn)」抽取。发现（findings）覆盖：友军鱼雷/炮击误伤、唯一沉没来自友军、单方开火静默、**单舰在射程内长时间停火**、**FIRE 指令空转**、航迹判型漂移/换号、重复碰撞、弹药库殉爆、损管不可行（进水/泵比）、命中率过低、烟幕指令占比过高、鱼雷零命中、**鱼雷效率过低（大量射程耗尽）**、**事件序号缺口**、未分胜负。

HTML 输出内联三张 SVG（航迹 / 交战距离 / 中弹条带），单文件可直接分享；`--check` 默认三条规则——**无友军鱼雷命中、无 ≥120 s 开火静默、同一航迹判型改判 ≤2 次**——可以直接拿新回放做 CI 门禁。

实测口径：对 8.5 那局修复前回放（`sandbox_custom` seed 604）跑 `--check` 为 3 项 FAIL；用当前代码按同一阵位/种子重放出的回放则 3 项 PASS，并额外报出 1 次炮击误伤（`GUN_FRIENDLY_FIRE`）——可用来盯住 8.5 的回归。回归用例：`test/t23.replay_analyzer.test.mjs`。

### 8.7 炮塔未击穿命中与闪爆传火（丹麦海峡变体局）

回放 `denmark_strait_1941_duel`（种子 19420604）里，胡德被俾斯麦命中 56 发 380 mm、被欧根亲王命中 16 发 203 mm，却始终不殉爆，最后被进水淹了 28 分钟（史实 3 分钟殉爆）。排查结论：

1. **弹道落角本身正确**（8 km 4.5°、12 km 8.0°、15 km 11.2°、20 km 18.0°）。问题是 AI 把交战距离压到 5–8 km（晨昏微光把 BB 交战带砍到 8–11 km，再叠加"能穿甲就贴近"），平射落角只剩 2–4°，76 mm 甲板的等效厚度升到 1000 mm 以上——**所有甲板/弹药库命中都是"未击穿"**。
2. **未击穿分支直接 return**：炮塔被 380 mm 直击但未穿透时，既不伤炮塔也不传火——史实胡德的死法（炮塔内爆 → 火焰沿扬弹机窜入弹药库）在模型里根本不存在。

修复：未击穿分支新增「炮塔直击」处理——炮塔受损/卡死 + 人员伤亡，并按防闪爆门状态以每发 2%~7% 累积 `magRisk`（闪爆传火），累积到 1 即殉爆。实测同局胡德 4 次炮塔直击后 magRisk 累积到 0.30（本次未爆，属真实的小概率事件），通道已打通；俾斯麦同样会因炮塔直击累积。

同时记录一处已知局限：长航程鱼雷（48 kn、飞行可达 190 s）在复杂机动下仍可能误伤友舰 1 次（真实海战同样无法完全避免）。走廊判据已能消掉旧版的「4 条鱼雷全中自家旗舰」。

### 8.8 弹药选择与副炮（玩家反馈）

**① 穿不了也用穿甲弹**：旧 `pickAmmo()` 在"估算穿深 < 装甲带 ×1.15"时改用 HE——实测丹麦海峡变体局里威尔士亲王打俾斯麦 **533 发 HE、零穿透**，等于白打。现在装甲目标（装甲带 >25 mm）**一律首选 AP**：即使当前距离估算穿深不足，AP 仍有跳弹入要害、打进弹药库与动力舱的机会，而 HE 对装甲带几乎无效；只有软目标（装甲带 ≤25 mm，如驱逐舰/商船）才用 HE（AP 会过穿不引爆）。

**② 用副炮**：旧实现 `commanded.fireBattery` 是单值（`'main'|'secondary'`），主副炮互斥，副炮实际上永远闲置。现在：

- `Ship.commanded` 增加**独立的副炮命令通道**（`secFiring/secTargetTrackId/secAmmo/secSalvoes`），`applyOrder('FIRE')` 支持 `battery:'secondary'`；停火同时清两路。
- `gunnery.tryFire()` 参数化为主/副炮两条火力通道——各有独立的节流、齐射序列化与 `fc.salvos` 计数，副炮不会阻塞主炮的齐射节奏。
- 副炮用自己的局部解算（`buildLocalSolution` 按副炮口径求弹道仰角），只取 `role='secondary'` 的对海副炮，**不含高射炮**（高射炮对海无效，不应被当成副炮）。
- AI 在目标进入副炮射程（`maxRange×0.9`）时下发副炮 FIRE，60 s 节流、换靶立即重发；副炮对中小目标/近距离补刀尤其有效。
- 目标进入 **3 km** 内时，`gunnery.js` 的 `CLOSE_ALL_GUNS_M` 把所有非主炮（副炮 + 高射炮）压平对海，走独立的 `role='close'` 齐射通道；**弹药按目标类型与预计穿深自动选**：DD/CL/CV → HE，CA/BB/BC 则比较该口径在交战距离的 AP 预计穿深与舷侧装甲（≥90% 用 AP，否则 HE）。远距离仍按主/副炮通道分配。

实测（`denmark_strait_1941`，seed 19420604，420 s）：主炮齐射 27、**副炮 9**；AP 222 / HE 108；开火炮塔为主炮 1–4 + 副炮 1–6，无高射炮。900 s：主炮齐射 152、副炮 73。回归用例：`test/t24.secondary_ammo.test.mjs`。

### 8.9 火力门限与火控解算保持（全剧本健康度扫描）

对 11 个剧本做健康度扫描（开火/命中/命中率/交战距离/友军雷/沉没）时发现两个连锁缺陷，表现为"看得见、判得清、却打不出"：

1. **"估计打不中"就整队沉默**：`assignTargets` 里 `if (pHit < 0.012) continue;`——10~20 km 的驱逐舰、远距主力舰估计命中率只有 0.17%~0.67%，全被过滤，AI 一个目标都选不出来。实测苏里高轴心 900 s 打 1744 发仅 7 中（0.4%），因为大部分时间在"选不出目标"里空转。现改为 0.4% 下限，并把 `fireGate` 的"未建立解算"分支放宽为：**20 km 内即使 UNKNOWN 也先打校射建立解算**（旧逻辑要求 15 km 内且已识别）。
2. **航迹换号就丢火控解算**：`updateFireControl` 里 `if (st.trackId !== track.id) resetDirector(...)` 不分青红皂白重置——而目标航迹每 12~30 s 翻新一次，解算永远停在 quality 0.3 的 degraded 状态，而 **degraded 解算的散布是正常值的 4 倍**。现在若新旧航迹指向同一艘实舰（`st.lastTrueId === targetShip.id`）则保留解算，只更新 trackId。
3. 配套调整：全齐射门槛 0.32 → 0.24；未识别舰种但解算质量 ≥0.6 时允许齐射（远距编队里 UNKNOWN 是常态）。

扫描结果（seed 19420604，900 s）：开火数与命中数同步上升，苏里高轴心命中 7 → 20、盟军 7 → 27；友军鱼雷 1 → 0；各剧本不再出现"整队零开火"。

## 9. 数据来源与致谢

舰船数据（`data/ships_axis.json` / `data/ships_allied.json`）逐条附 `sources` 字段，来源为 Wikipedia、NavWeaps、combinedfleet 等公开资料；剧本的历史背景与结局为公开战史。本项目为工程与教学用途的模拟器，参数为公开资料的工程近似，不用于作战研究。

## 10. 质量门禁与 CI

| 入口 | 内容 | 命令 |
| --- | --- | --- |
| 全量验收 | 单元/集成/剧本/无头/UI 启动，共 29 项 | npm test（= node test/run-all.mjs） |
| 黄金种子 | 固定 seed 的胜方/沉没/命中/在航不漂移 | npm run test:golden |
| 基线重生成 | 物理改动确认后刷新基线 | npm run golden:update |
| UI 端到端 | 无头 Chrome 真实点击/键盘/截图 | npm run uicheck |

黄金种子说明：tools/golden.mjs 跑 2 个剧本 × 2 个 seed 各 900 s，把 winner / ship.sink / gun.hit / 在航数落盘到
test/golden/baseline.json；test/golden.seed.test.mjs 按容差（胜方严格、沉没 ±1、命中 ±35%、在航 ±1）比对。
任何物理/数值改动如果让基线漂移出容差，CI 会直接失败——这是给"进水/稳性/磨损"这类改动的护栏。

本轮（A–E Wave 1）新增测试：t13 陆地遮蔽、t14 敌我识别与友军误伤、t15 AI 条令、t16 可访问性、t17 剧本触发器。
