# 铁海 1942 (Iron Seas) — 架构与接口契约 v1

> 本文件是**唯一权威接口契约**。所有并行开发必须遵守本文件；任何偏离必须先改本文件并在团队频道广播。
> 目标：极重真实感的二战海战模拟器。真实感 > 建模精度 > 画面。

## 0. 硬约束（会直接导致返工，务必先读）

1. `src/core/**` 与 `src/sim/**` **绝对禁止**引用 `window` / `document` / `canvas` / `fetch`。
   仿真内核必须能在 Node 里 headless 跑（用于测试与无头对战）。
2. 只使用原生 ES Module（`import ... from './x.js'`），**零第三方依赖**。
3. 单位一律：
   - 距离：米（m），海里换算 1 nmi = 1852 m
   - 速度：内部一律节（kn），1 kn = 0.514444 m/s
   - 角度：度（deg）。航向 0=正北，顺时针。相对角：右正左负。
   - 时间：秒（sim seconds）。
   - 质量 kg，装甲 mm，功率 shp，压强 直接用 m 水柱（mH2O）。
4. 世界坐标系：局部切平面，`x`=东（m），`y`=北（m），原点由剧本给出 lat/lon。`SeaPlane` 负责 lat/lon 换算。
5. 所有随机数必须走 `world.rng`（可复现）。禁止 `Math.random()`。
6. 所有状态变化必须 emit 事件（见 §4），回放与 AAR 依赖它。
7. **二战设定：没有导弹、没有直升机、没有卫星、没有 GPS、没有现代数据链。**
   雷达是 1940 年代早期货（多为测距、部分测向、易受箔条与杂波影响）；测距主力是光学测距仪。
8. 指挥延迟（C2 delay）是真实感的一部分：命令从下达至生效有 `side.orderDelay_s` 延迟（默认 4–12 s，舰队级更大）。

## 1. 目录与负责人（写作用域，互不重叠）

```
naval/
  index.html                     UI 外壳（Lead）
  ARCHITECTURE.md                本文件（Lead）
  README.md  AI_INTERFACE.md     文档（T6）
  run.sh                         启动脚本（Lead）
  data/ships_axis.json           轴心舰船数据（外包 subagent，已完成）
  data/ships_allied.json         同盟舰船数据（外包 subagent）
  data/scenarios.json            历史战役剧本（T6）
  src/core/util.js rng.js geo.js events.js        （Lead，已冻结）
  src/sim/types.js data.js ship.js world.js       （Lead，已冻结）
  src/sim/env.js dynamics.js                      （T1 环境与舰体运动）
  src/sim/damage.js                               （T3 损伤与损管）
  src/sim/sensors.js vision.js tracks.js          （T2 传感器/光学/航迹）
  src/sim/gunnery.js ballistics.js spotting.js    （T4 火控与弹道）
  src/sim/torpedo.js                              （T5 鱼雷）
  src/ai/local_ai.js nl.js bridge.js              （T5 AI 与桥接）
  src/render/chart.js                             （T6 渲染，颜色一律走 chartPalette()）
  src/ui/app.js panels.js replay.js aar.js        （T6 界面）
  src/ui/theme.js icons.js fold.js                （v5：主题 token / 内联 SVG 图标 / 窗口收起）
  server/serve.mjs                                （T5 静态服务 + AI 中继 + LLM 代理）
  server/headless.mjs                             （T5 无头对战跑分）
  tools/uicheck.mjs                               （UI 端到端验证器：CDP 真实点击/键盘/截图）
  test/*.test.mjs                                 （各自）
```

界面配色契约（v5）：`index.html` 的 `:root[data-theme="paper"|"chart"|"riso"|"dark"]`
四组变量是唯一事实来源；`src/ui/theme.js` 只负责切换/持久化，并把同一批 CSS 变量交给 Canvas
（`chartPalette()` + `alpha()`）。`src/render/**` 内不得出现颜色字面量。

## 2. 世界与主循环（已实现于 src/sim/world.js）

```js
world.step(dt)            // dt 建议 0.1s，内部 clamp 到 <=0.25s
```
固定顺序（不要改）：
1. `world.t += dt`; `env.step(dt)`
2. `applyDueCommands()`  —— 取出到达生效时间的命令
3. 每舰 `updateDamage(ship, world, dt)`（进水/火灾/损管 → 影响稳性与子系统）
4. 每舰 `updateKinematics(ship, world, dt)`（主机/舵/回转/耐波性）
5. 每舰 `updateSensors(ship, world, dt)` → `world.tracks.observe(obs)`
6. `world.tracks.update(dt)`
7. 每舰 `updateFireControl(ship, world, dt)`（解算+开火，内部调 ballistics.spawnProjectile）
8. `updateProjectiles(world, dt)`（命中→`applyHit`）
9. `updateTorpedoes(world, dt)`
10. 每舰 `updateSpotting(ship, world, dt)`
11. `world.aiTick(dt)`（各 AI 后端，非阻塞）
12. `checkVictory()`，事件收发

### 2.1 沙盒剧本约定（v7）

`scenario.sandbox === true` 且 `scenario.sandboxNoVictory === true` 时，`world.checkObjectives()` 直接返回：
不按「编队全灭」与战役目标自动终局（普通剧本行为不变）。沙盒运行时增舰用
`world.addShipById(classRef, spec)`（spec：id/name/side/x/y/heading/speed/role/crewQuality），
删舰直接 `world.ships.splice(i, 1)`。UI 顶栏「沙盒」按钮仅在 `scenario.sandbox` 时出现。

## 3. 关键对象

### Ship（src/sim/ship.js）
```
id, name, side('ALLIED'|'AXIS'), type('BB'|'BC'|'CA'|'CL'|'DD'|'CV'), data(原始数据对象)
pos{x,y} heading speed(kn) rudder(deg) commanded{heading,speedPct,rudder,firing}
roll pitch list trim draftM
compartments[]  见下
batteries[]     主/副炮塔状态
torpedoMounts[] 鱼雷发射管状态
subsystems[]    通用子系统
sensors[]       雷达/声呐/水听器实例
directors[]     射击指挥仪
dcParties[], crew, crewQuality(0.5~1.2), morale
isAfloat, capsizeRisk, speedCapKn, effectiveGMm
flags{smokeOn, searchlight{on,bearingDeg}, radarOn, starshellArmed, engaged}
```

**compartment**（按舰长自动生成 N 站，纵向从艏到艉）：
```js
{ i, x_frac, length_m, volume_m3, flood_m3, integrity:0..1, fire:0..1,
  belt_mm, deck_mm, isMagazine, isMachinery, isSteering, isBridge, crewHere, breached }
```

### 命令 schema（player / AI 统一）
```js
{ id, t_issue, t_effective, side, shipId|null, kind, params, source:'PLAYER'|'AI_REMOTE'|'AI_LOCAL'|'SCRIPT', issuer, note }
```
`kind` 取值：`SET_COURSE{heading}` `SET_SPEED{kn}` `SET_RUDDER{deg}` `FIRE{trackId,ammo,salvoes}`
`CEASE_FIRE{}` `LAUNCH_TORPEDO{trackId|null,bearing,spreadDeg,tubes}` `SMOKE{on}`
`SEARCHLIGHT{on,bearing}` `RADAR{on}` `SONAR{on}` `STAR_SHELL{bearing,range}`
`DC_PRIORITY{mode:'flooding'|'fire'|'magazine'|'mobility'}` `DAMAGE_CONTROL{action,compartment}`
`FORMATION{station:{bearingDeg,rangeM}}` `WITHDRAW{}` `LAUNCH_AIRCRAFT{}`（CV，可选）
舰队级：`ASSIGN_TARGET{shipId,trackId}` `SET_SCREEN{ships}` `PLOT_COURSE{heading}`

### 事件名（emit，回放/AAR/UI 依赖）
```
sim.start sim.end tick.major
ship.speed ship.course ship.collide ship.sink ship.capsize ship.launch
gun.fire gun.salvo.away gun.hit gun.miss gun.straddle gun.penetration gun.bounce gun.nearmiss
gun.terrain              // 炮弹落在陆地（不结算伤害）
gun.friendlyfire         // 误击本方（victim 与射手同阵营；真打真伤）
torp.launch torp.hit torp.miss torp.dud torp.wake
dam.flood dam.fire dam.fire.out dam.magazine dam.subsystem dam.dc dam.list dam.flood.control
sensor.detect sensor.lose sensor.radar.on sensor.radar.jam sensor.visual.spot sensor.smoke
sensor.visual.blocked    // 视线被陆地截断（blockedByLand:true）
sensor.identity          // 敌我识别状态变化（foeConfidence / misId）
fc.solution fc.update fc.ladder
order.issue order.effective order.reject
ai.decision ai.connected ai.disconnected ai.fallback ai.error ai.chat
scenario.trigger scenario.message   // 剧本触发器（见 §2.2）
env.change env.sunset env.squall
victory.achieved
```

### 2.2 剧本触发器（scenario.triggers，v7）

```js
scenario.triggers = [{
  id: 'ds_contact',            // 唯一 id（once 记账用）
  at: 60,                      // 或 when / whenAll / whenAny（条件复用 objectives.condition schema）
  once: true,                  // 默认 true
  action: { kind: 'MESSAGE' | 'ORDER' | 'SET_ENV' | 'ACTIVATE_OBJECTIVE', ... },
}]
```

- `ORDER`：`{ shipId? | side?, order, params, scope?, issuer? }`，以 `source:'SCRIPT'` 下达（受指挥延迟）。
- `SET_ENV`：`{ windKn?, windDirDeg?, visibilityNm?, seaState? }`（海况按风浪谱反查风速）。
- `ACTIVATE_OBJECTIVE`：`{ id? | index? }`，目标默认参与判定，`active:false` 的条目在激活前不参与。
- 评估时机：world.step 内、AI tick 之后、checkObjectives 之前；无 triggers 时零开销。
- 事件：`scenario.trigger`（每次触发）与 `scenario.message`（MESSAGE 动作）。

## 3.1 冻结：命中对象 Hit（ballistics.js / torpedo.js → damage.applyHit）

```js
applyHit(world, {
  t,                       // sim 时间
  targetShip,              // Ship 对象（必填）
  x_frac,                  // 0=舰艏 1=舰艉，命中纵向位置（必填）
  compartmentIndex,        // 可选，若不填由 x_frac 推
  sideBias,                // -1 命中左舷 +1 命中右舷（决定横倾方向），0 表示首尾/穿舱
  penetrates,              // 是否击穿主装甲
  armorMM,                 // 被击中的装甲厚度（用于事件与穿深记录）
  obliquityDeg,            // 落角/入射角（与装甲法线夹角）
  shellMassKg, caliberMM, velocityMps,   // AP/HE 弹参数
  energyMJ,                // 动能，鱼雷用 1/2*m*v^2
  warheadKg,               // 装药（鱼雷/炸弹）
  isTorpedo,               // true 时按水中弹道/舰体撕裂模型处理（命中位置=舷侧，必带 sideBias）
  isNearMiss,              // 近失弹：靠水柱与水中弹道造成舷侧变形与进水
  fuzeDelayS,              // 引信延迟（决定在舰内何处起爆）
  ammoKind,                // 'AP' | 'HE' | 'SAP' | 'STAR'
  killerShipId, killerSide, killerName,
})
```
> **实际实现（以 src/sim/ballistics.js 的 applyShipHit 为准）**：ballistics 发出的 hit 形如
> `{kind:'SHELL', side, attackerSide, attackerId, victimId, ship(受害者id), shipSide, name, ammo, caliberMM, massKg,
>   impact:{x,y,z,xFrac,hitPart,obliquityDeg,fallAngleDeg,velocityMps,localAlong,localAcross,localZ},
>   armorMM, effectiveArmorMM, penetrationMM, penetrated, bounced, shattered, partial, detonated, dud,
>   detonation:{xFrac,depthM}|null, explosiveKg, tntEquivalentKg, rangeM, timeOfFlightS, isNearMiss}`。
> 鱼雷命中会有独立的 shape，由 torpedo.js 提供。`x_frac` 在实弹里名为 `impact.xFrac`，装甲厚度名为 `armorMM`。
> damage.js 两种命名都要兼容（建议做一个 normalizeHit()）。

damage.js 必须 emit：`dam.flood dam.fire dam.fire.out dam.magazine dam.subsystem dam.casualties dam.list dam.flood.control dam.penetration dam.bounce`，事件至少带 `{t, ship, side, victimSide, killerShipId, killerSide, compartment, value}`。

## 4. 模块接口（必须精确匹配；实现者不得改签名）

```js
// src/sim/env.js
export class Environment {
  constructor(opts)                  // opts:{lat,lon,t0ISO,seed,seaState,windDirDeg,windKn,visibilityNm,...}
  step(dt)
  get lightLevel()                   // 0(漆黑)~1(正午)
  get seaState()                     // 0~9 道格拉斯
  swellHeightM                       // 有效浪高
  windDirDeg windKn
  visibilityNm                       // 当前水平能见度
  horizontalVisibilityNm(ship)       // 考虑烟幕/雨飑/夜间后的实际值
  smokeDensityAt(x,y)                // 0~1 烟幕遮蔽
  illuminationFactor(ship)           // 月光/照明弹/探照灯/火灾对目视的加成
}
export function seaStateFromWind(windKn)
export function dayNightInfo(lat, dayOfYear, tHours)   // {sunriseH,sunsetH,sunAltDeg,moonIllum}

// src/sim/dynamics.js
export function updateKinematics(ship, world, dt)

// src/sim/damage.js
export function updateDamage(ship, world, dt)
export function applyHit(world, hit)   // hit 见 ballistics.js 输出
export function floodingReport(ship)

// src/sim/sensors.js
export function updateSensors(ship, world, dt)
export function radarDetectRange(ship, radar, target, env)  // 米
// src/sim/vision.js
export function visualDetectRange(viewer, target, env)      // 米
export function opticalRangefind(viewer, target, env, rng)  // {rangeM, errM, bearingDeg, errDeg}
export function updateSpotting(ship, world, dt)
// src/sim/tracks.js
export class TrackManager {
  constructor(world)
  observe(obs)   // obs:{side,srcKind:'RADAR'|'VISUAL'|'SONAR'|'HFDF'|'AIS?',shipId,targetId?,pos,rangeM,bearingDeg,accuracyM,accuracyDeg,classifiedAs,confidence,t}
  update(dt)
  visibleFor(ship)   // 返回该舰当前可用的 track 数组（含不确定度）
  byId(id)
}

// src/sim/gunnery.js
export function updateFireControl(ship, world, dt)
export function computeSolution(ship, director, track, world)   // {bearingDeg,rangeM,deflectionMil,timeOfFlightS,spreadMil}
export function fireSalvo(ship, battery, solution, world, opts) // opts:{ammo,salvoes,pattern}
// src/sim/ballistics.js
export function spawnProjectile(world, spec)  // spec:{ship,battery,targetPos,targetShip,ammo,bearingDeg,elevDeg,dispersionMil,mv,shell}
export function updateProjectiles(world, dt)
export function penetrationMM(armorMM, obliquityDeg, shellMassKg, caliberMM, velocityMps)  // 等效穿深判定
// src/sim/torpedo.js
export function updateTorpedoes(world, dt)
export function launchTorpedo(world, ship, mount, sol, opts)   // sol:{bearingDeg,rangeM,spreadDeg,tubes,speedIdx}
// src/ai/local_ai.js
export class LocalAI { constructor(side, opts); tick(world, dt) }
// src/ai/bridge.js
export class AICommander { // 可插拔后端，见 AI_INTERFACE.md
  constructor(side, world, opts)
  tick(world, dt)
  setBackend(name)   // 'LOCAL' | 'REMOTE' | 'LLM'
  submitDecision(decision)
}
// src/render/chart.js
export class ChartRenderer { constructor(canvas, world, opts); resize(); draw(state) }
// src/ui/app.js
export function bootApp()    // index.html 只调用它
```

## 5. AI 协议（摘要，详见 AI_INTERFACE.md）

浏览器是**仿真宿主**，通过 WebSocket 连到 `server/serve.mjs`（`role=sim`）。
外部智能体也连同一台服务器（`role=agent&side=AXIS|ALLIED`），服务器做中继 + LLM 代理。
- 服务器 → 智能体：`{type:'state', t, side, payload}`（1–2 Hz，**只给该方可见的信息**）
- 智能体 → 服务器：`{type:'commands', commands:[...]}` 或 `{type:'chat', text}`
- 服务器 → 游戏：`{type:'commands', commands:[...]}`
- 兜底：智能体掉线 >10s → 自动回落 `LOCAL` 并 emit `ai.fallback`
- 支持 SSE 只读流 `GET /api/stream?role=agent&side=AXIS`，命令走 `POST /api/orders`

## 6. 真实感红线（验收标准）

- [ ] 目视发现与光学测距受能见度、海况、烟幕、夜色、探照灯/照明弹、目标舷侧投影面积影响
- [ ] 雷达按雷达方程 + 雷达地平线（**4.12·√h，h 以米计、结果单位 km**；换算成海里是 2.23·√h）+ 海杂波 + 箔条干扰；不同型号能力不同
- [ ] 火控解算需要目标航向航速解算（方位变化率+测距变化率），有解算误差与更新延迟
- [ ] 一次齐射有散布椭圆；用夹叉/梯次校射修正；命中判定含落角与装甲等效穿深
- [ ] 鱼雷有射击诸元、航程/航速档位、航迹可见性差异（九三式无航迹）、哑弹率
- [ ] 命中按**命中位置**决定后果：进水/倾斜/火灾/子系统降级/弹药库殉爆
- [ ] 倾斜与进水影响航速、射击精度、稳性；倾覆是可能的结局
- [ ] 海况影响航速（首浪失速）、横摇（影响测距与射击）、上浪与首部损伤
- [ ] 时间压缩 1x/4x/16x/64x 不改变物理结果（定步长）
