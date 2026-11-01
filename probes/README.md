# probes/ —— 历史诊断探针归档

本目录的 82 个脚本是「铁海 1942」在 A–E 波次开发与标定期间写的一次性诊断/复现脚本：先放在
`test/`（命名为 `lead.*.mjs`，由当时的项目 Lead 逐波追加），标定完成后统一归档到 `probes/`。
它们的共同特征是"为回答某一个具体问题而写"——命中率为什么低、航迹为什么飘、AI 为什么不开火、
哪一段仿真变慢、哪个模型能在 10 秒内给出可解析的命令——问题一旦定位，脚本就失去维护价值，
因此**不保证长期可运行，也不保证与当前 `src/` 接口同步**。

> **门禁说明**：CI 门禁是 `node test/run-all.mjs`，本目录绝大部分脚本**不参与**门禁。
> 例外（仍被 `test/run-all.mjs` 作为子步骤调用，改动 `src/` 后必须保持通过）：
> `lead.smoke.mjs`、`lead.gunnery_probe.mjs 8000`、`lead.integration.mjs <剧本> <时长>`（×2）、`lead.uiboot.mjs`。

## 运行前提

- 一律在**仓库根目录**执行：`node probes/<file>.mjs`（许多脚本用相对路径直接读 `data/*.json`，
  在其它目录执行会 ENOENT）。脚本里的 `../src/...` 相对导入与原先在 `test/` 时等价。
- 带 **参数** 的脚本见"备注"列：多为 `剧本 id` / `时长(s)` / `种子局数` / `模型名`。
- 带 **server** 的脚本（LLM 组）需要先起本地服务（`node server/serve.mjs`，默认 8787，
  暴露 `POST /api/llm/chat`）并配好上游模型；无网络/无 key 时这些脚本只会打印 ERR。
- 多数脚本要跑满 1200–4700 仿真秒，**单次可能需要数分钟到数十分钟**，不适合日常回归。
- 少数脚本把结果追加到 `/tmp/*.log`（`lead.den_probe`、`lead.perf3`、`lead.savo_prof`），终端里不会打印。
- 8787 代理可用 `node server/serve.mjs --mock` 起 mock 模式做离线冒烟（不调真实模型）。

## 一、冒烟 / 集成 / 浸泡

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.smoke.mjs` | 不读 `data/`，用内联舰船数据验证定步长、航速、位移、事件与 AI 桩，最后打印一行 JSON 指标 | 无参数；**在门禁内**（run-all 第 1 步） |
| `lead.integration.mjs` | 真实数据 + 指定剧本 + 双本地 AI 跑完整交战，打印装载、墙钟/实时倍率、沉没受损、事件统计、命中率 | `<剧本id> [时长s=1800]`；门禁用 `denmark_strait_1941 900` 与 `savo_island_1942 600` |
| `lead.soak.mjs` | 逐个剧本跑满并每 50s 检查不变量（NaN/越界/倾覆），汇总 ❌ 问题清单 | `<剧本id...>`；`DUR` 环境变量控时长（默认 900） |
| `lead.probe2.mjs` | 自建 1v1 内联剧本（胡德 8km 对俾斯麦连射 9999 齐射），逐段打印弹丸/水柱/事件数，最后 dump 弹丸字段与全部事件类型 | 无参数；验证弹道事件管线 |
| `lead.sandbox_repro.mjs` | 复现用户那份 AAR（sandbox / seed 19420604）：双方是否真在打、是否 25% 就翻；列一炮未发的舰 | `[时长s=4700]`；单次数分钟 |

## 二、火控 / 命中率 / 弹道

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.gunnery_probe.mjs` | 受控条件（固定距离、可选移动目标）测落点分布，判断命中率低的根因是系统偏差/散布/解算错误，输出 JSON | `[距离m=8000] [move]`；**在门禁内**（固定 8000） |
| `lead.hitrate.mjs` | 光学测距误差随 6/8/12/16/20km 的分布；三个剧本各 1200s 的命中率与距离分档 | 无参数 |
| `lead.firedist.mjs` | 三个剧本各跑 1200s，统计开火距离分布（<6km…>22km）与命中率 | 无参数 |
| `lead.impact_error.mjs` | 弹着沿射向/垂直射向误差的均值·中位·p90·σ，并按 230×30m 舰体投影反推"应命中率" | 无参数（萨沃岛 seed 20261018） |
| `lead.dispersion_split.mjs` | 用 `w.salvoes` 把散布拆成"齐射内 σ"与"齐射间瞄准跳动"，估算总散布 σ 与飞行时间 | 无参数（萨沃岛） |
| `lead.shell_count.mjs` | 对账各 `gun.*` 事件计数与 `stats.shotsFired/hits`，判断统计口径是否一致；列全部弹道事件类型 | 无参数 |
| `lead.fc_quality.mjs` | 开火时目标航迹的航向/航速可用性分档统计，另计提前量比例与单发齐射数 | 无参数（萨沃岛） |
| `lead.fc_dbg.mjs` | 300s 后对首条可见航迹手动调一次 `fireGate`，打印返回值或异常栈 | 无参数 |
| `lead.fc_bias.mjs` | 取轴心主力目标，逐指挥仪调用 `computeSolution` 并打印各解算值 | 无参数（seed 2000） |
| `lead.axis_diag9.mjs` | 监听 `fc.solution`（只取轴心舰），打印字段名、最近 12 条解算与用到的航迹/指挥仪 | 无参数（丹麦海峡 seed 1003） |
| `lead.range_diag.mjs` | 每 200s 打印胡德↔俾斯麦距离、开火均距、发/中数；末尾 dump LocalAI 常量与条令关键字 | 无参数 |

## 三、齐射散布 / 落点分解

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.axis_diag5.mjs` | 监听 `gun.miss`，按阵营统计落点沿射向/垂直向的均值、中位与 \|p90\| | 无参数（seed 1003） |
| `lead.axis_diag7.mjs` | 同上的落水点分解，额外给出沿射向 σ，并打印 `gun.miss` 字段清单 | 无参数；与 diag5 是同一指标的迭代版 |
| `lead.axis_diag8.mjs` | 按齐射分组，统计齐射内横向 σ 与齐射间均值 σ | 无参数 |
| `lead.axis_disp2.mjs` | 换 seed 2000 复跑齐射内/间散布，同时累计双方命中数 | 无参数 |

## 四、航迹 / 观测 / 探测质量

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.track_probe.mjs` | 猴子补丁 `TrackManager._associate`，统计关联调用/命中/无航迹/超龄/超门限、d÷gate 比值、航迹寿命 | 无参数（sandbox） |
| `lead.track_quality.mjs` | "修复后"同一套航迹指标，对照用户 replay（误差中位 2284m、errDeg 23.75°、839 条、3.0%） | `[时长s=4700]` |
| `lead.track_truth.mjs` | 分开统计 bearing-only 与有定位航迹的真实位置误差，并看 `errM` 自报不确定性是否在撒谎 | 无参数 |
| `lead.obs_paths.mjs` | 统计观测路径：来源类别、pos 是否与观察者同点、rangeM 是否为空、平均报告距离 | 无参数 |
| `lead.obs_src.mjs` | 读每部指挥仪的 `st.obs`，按阵营统计观测来源分布与平均 σ，并 dump 双方测距仪基线/状态 | 无参数（seed 2000） |
| `lead.err_decomp.mjs` | 只取 RADAR 观测，把位置误差拆成距离项/方位项，找出 >8km 的"幽灵接触"并给样例 | 无参数（sandbox seed 19420604） |
| `lead.vis_dbg.mjs` | 在 6/8km 固定距离调 `visualDetection`，打印 detected/contrast0/阈值/目标对比度等中间量 | 无参数 |
| `lead.rf_dbg.mjs` | 打印胡德测距仪清单，逐距离调 `opticalRangefind` 看 valid/errM/errDeg/detected，并 dump 环境光照能见度 | 无参数 |

## 五、损伤 / 殉爆 / 损管

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.dc_depth.mjs` | A：同一条 203mm 命中，比较"损管正常 vs 归零"的进水时间曲线；B：抽查剧本水深场与浅滩搁浅/鱼雷触底 | 无参数；A 段手工步进 9000×0.1s |
| `lead.det_rate.mjs` | 丹麦海峡 12 局，统计殉爆次数与胡德被击沉次数（殉爆率是否过高） | 无参数；12×1200s |
| `lead.mag_blast.mjs` | 受控 40 次：反复对弹药库施加穿透命中直到殉爆/爆燃，记录当量、半径、阵亡、存活船员、邻舰冲击 | 无参数 |
| `lead.mag_energy.mjs` | 12 局跑满，统计满库殉爆/近空库爆燃/邻舰受冲击次数与殉爆当量 | 无参数 |
| `lead.hit_realism.mjs` | 命中部位分布与穿透率、炮塔受损/击毁、弹药库命中与殉爆，并给出双方战后状态 | 无参数（seed 1001） |

## 六、陆地 / 地形 / 小岛

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.land_check.mjs` | 四个剧本检查开局舰位是否落在陆地上、陆地环数量 | 无参数 |
| `lead.islet_check.mjs` | 找出 <0.2km²/<0.02km² 的小岛环，验证点判定命中与小岛挡视线的精确兜底 | 无参数 |
| `lead.failrings.mjs` | 扫描 `land.json` 全部小环，找出"环内取点却判为海"的失败环并按面积分桶 | 无参数；早期版本硬编码本机绝对路径，现已改为相对路径 |

## 七、轴心 AI 行为诊断

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.ai_baseline.mjs` | 丹麦海峡 5 个种子跑满，逐局打印俾斯麦/欧根状态、双方在航数与胜负，作为改 AI 前的基线 | 无参数；先打印剧本 objectives/victory 字段 |
| `lead.ai_iq.mjs` | A：各舰主炮 AP 哑弹率；B：萨沃岛 1200s 的命中率、照明弹数、集火分布、沉没名单 | 无参数 |
| `lead.german10.mjs` | 先打印 t=0 双方航向航速与胡德↔俾斯麦距离/接近速度，再跑 N 局统计轴心胜率 | `[局数=10]` |
| `lead.axis_diag.mjs` | 轴心 `objectiveTargetIds` 与可见航迹的 targetId 字段；逐段打印俾斯麦速度上限/主炮/指挥仪/进水 | 无参数（seed 1003） |
| `lead.axis_diag2.mjs` | 每 50s 打印俾斯麦速度上限、实际航速、撤离记忆与距最近敌舰距离，查"挨打后不动/打不着" | 无参数 |
| `lead.axis_diag3.mjs` | 700s 后打印轴心视角航迹（分类/目标 id/距离）、各舰目标与开火、焦点航迹与阶段、`isObjectiveTarget` 判定 | 无参数 |
| `lead.axis_diag4.mjs` | 按阵营/受害舰统计命中分布，并检查任务目标识别与胡德/PoW 状态 | 无参数 |
| `lead.axis_diag6.mjs` | 改用 `e.targetShipId` 统计命中分布并打印 `gun.hit` 字段样例，定位字段不一致 | 无参数 |
| `lead.axis_targets.mjs` | 两局（seed 2000/2001）每 100s 记录轴心目标选择，打印目标日志、命中分布、盟军航向航速 | 无参数 |
| `lead.axis_torp.mjs` | 3 局统计双方鱼雷发射/命中、欧根鱼雷管状态与胡德战损 | 无参数 |
| `lead.spectate_ai.mjs` | 观战模式（`playerSide=null`）下给双方分别设预设/后端/模型，验证两阵营配置互不影响 | 无参数 |

## 八、命令下达 / 执行官 / 自然语言

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.nl_probe.mjs` | 用 20+ 条中文口令实测 `parseChineseOrder` 的解析成功率，逐条打印失败项 | 无参数 |
| `lead.nl_verify.mjs` | A：t=0 下达的转向是否被 AI 覆盖（看 `_directiveSim`）；B：规则未命中时 LLM 兜底 `parseOrderSmart` 是否接手 | B 段需本地 8787 代理 |
| `lead.nl_e2e.mjs` | DOM 垫片下真跑 `bootApp`，向输入框打字并点"发送命令"，验证 world 收到命令、生效事件与 40s 后指令航向 | 依赖 `src/ui/app.js` 与 index.html；无需服务器 |
| `lead.order_conflict.mjs` | 玩家在沙盒下转向令后，观察 40s 内是否有本地 AI 命令覆盖，逐条打印命令来源 | 无参数 |
| `lead.order_trace.mjs` | 复刻 UI `sendChat` 的展开逻辑，逐段追踪指令航向/舵角/`_directiveSim` 与 AI_LOCAL 命令数 | 无参数 |
| `lead.exec_diag.mjs` | 用 stub `llmCall` 接上远端 AI，打印 backend/linkState/pending/决策数/错误与命令来源分布 | 无参数；不需要真 LLM |
| `lead.exec_diag2.mjs` | 检查 `normalizeCommand` 结果、`ai.decision` 事件的 commands/rejected/reasoning、白名单字段与节流常量 | 无参数 |
| `lead.exec_diag3.mjs` | 统计 stub `llmCall` 调用次数、pending、decisions/命令/拒绝计数与 AI_REMOTE 命令数 | 无参数 |
| `lead.executive.mjs` | 模拟"慢 LLM"下一条转向令，检查本地执行官是否用 SET_COURSE 覆盖外部指挥官的命令 | 无参数；期望"不覆盖" |
| `lead.executive2.mjs` | 加严版：验证保持窗内本地 AI 对该舰新增转向 0 条，而损管等实时事务仍在跑 | 无参数 |

## 九、外部 LLM 指挥官（全部需要本地 8787 代理）

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.llm_probe.mjs` | 同一提示词对比 max_tokens=6000 与再加 `response_format:json_object`，看 finish、content/reasoning 长度与可解析性 | 需 8787 |
| `lead.llm_probe2.mjs` | 参数变体（温度/格式）对照，打印 HTTP 状态、finish、长度与解析出的命令 | 需 8787 |
| `lead.llm_bench.mjs` | 用真实态势提示词逐个测候选模型延迟与是否给出可解析命令，按时延排序 | `<model...>`；需 8787 |
| `lead.llm_bench2.mjs` | 精简提示词（"快速模式"）下多模型对照，打印耗时/finish/content/思考长度 | 需 8787；模型名写死在文件里 |
| `lead.llm_speed.mjs` | 完整 vs 精简上下文的提示词体积与单模型延迟对照 | 需 8787 |
| `lead.llm_speed2.mjs` | "关思考"参数试验（mimo-v2.6-flash）与候选模型在精简上下文/700token 下的延迟 | 需 8787 |
| `lead.llm_speed3.mjs` | minimax-m3 的 max_tokens 预算扫描 + 对照，找"够用且最快"的预算 | 需 8787 |
| `lead.llm_speed4.mjs` | 手写 ultra/short 两套超短提示词，按输入字符数比较延迟与可解析性 | 需 8787 |
| `lead.llm_context.mjs` | 连跑两轮决策，检查第二轮是否带上一轮记忆（轮次/战况事件/我的命令/航迹记忆），并打印简报节选 | 需 8787 |
| `lead.llm_e2e.mjs` | 端到端：真实 LLM 当一方指挥官 → 解析 → 灌回 world，验证命令被接受 | `PROXY` 环境变量；需 8787 |
| `lead.llm_nonthink.mjs` | 多模型比较是否产生思考内容与可用性，筛"非思考且快"的模型 | `<model...>`；需 8787 |
| `lead.llm_nonthink2.mjs` | 按 JSON 用例数组（模型/max_tokens/温度）批量试非思考输出 | `'<json>'`；需 8787 |
| `lead.agent_state.mjs` | 打印推给外部指挥官的 state 顶层字段、context 字段与体积，验证 doctrine 只在首推出现、简报内容 | 无参数（stub 远端） |

## 十、性能 / 慢窗口剖析

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.perf.mjs` | 萨沃岛 60s 段对比：全开 / 关 AI 自动指挥 / 无陆地 / 无水深 / 两者都无，输出 ms/仿真秒 | 无参数 |
| `lead.perf2.mjs` | 按 60/120/300/…/1800s 分段计时，打印每段耗时、事件、鱼雷、照明弹，找慢窗口 | 无参数 |
| `lead.perf3.mjs` | 40 段 × 50s 逐段计时写入 `/tmp/perf2.log`，单段 >60s 自动停 | 结果在 /tmp |
| `lead.perf4.mjs` | 先跑到 1340s 记鱼雷数，再单独测 25s 段耗时，验证"鱼雷多时变慢" | 无参数 |
| `lead.perf5.mjs` | 在 t≈1365 对比 全开/无水深/无陆地 的 25s 段耗时（perf4 的对照版） | 无参数 |
| `lead.perf6.mjs` | 到 1300s 后连测 10 个 +5s 段，打印每段耗时与鱼雷数 | 无参数 |
| `lead.den_probe.mjs` | 丹麦海峡每 20s 一段计时写入 `/tmp/den2.log`，单段 >30s 自动停 | 结果在 /tmp |
| `lead.den_prof.mjs` | 先跑到 160s，再单独给 3s 仿真窗口计时，量化"慢窗口" | 无参数 |
| `lead.savo_prof.mjs` | 萨沃岛每 20s 计时找最慢窗口，结束打印慢窗口起点 | 无参数 |

## 十一、UI / 渲染 / 特效

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.uiboot.mjs` | DOM/Canvas 垫片下真跑 `bootApp()`，验证数据加载、剧本启动、600 帧主循环、面板渲染与交互路径无运行时异常 | 无参数；**在门禁内** |
| `lead.boom_visual.mjs` | 垫片页面里触发 `addBoom`，检查特效入队半径并统计 canvas `arc` 调用，判断冲击环/火球是否绘制 | 无参数 |

## 十二、鱼雷

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `lead.torp_features.mjs` | A：按目标舷侧选发射管；B：定深/管数/扇面/档位是否被采纳；C：AI 是否错开同目标批次；末尾统计命中/哑弹/触底 | 无参数；萨沃岛跑 1500s |

---

## 已知过时 / 仍有价值的几条

- **已过时**：`lead.axis_diag6`/`lead.axis_diag7` 依赖当时的事件字段口径（`e.ship` vs `e.targetShipId`），
  字段定稿后其诊断前提已不成立；`lead.llm_bench2`/`lead.llm_speed2`/`lead.llm_speed3` 把模型名与
  max_tokens 预算写死在文件里，上游模型下线后只剩 ERR。
- **仍有价值**：`lead.gunnery_probe.mjs`（受控命中率标定，门禁里就是它）、`lead.track_quality.mjs`
  （航迹质量的统一口径，可直接与历史 replay 对比）、`lead.llm_speed4.mjs`（提示词预算与延迟的实测方法），
  以及 `lead.perf5.mjs`（把变慢归因到水深/陆地场是否开启）。
- 新增探针若只想查一次就跑一次，建议仍放本目录并在表里登记，避免再散落到 `test/`。
