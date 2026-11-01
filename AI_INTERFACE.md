# 铁海 1942 — AI 接口规范 (AI_INTERFACE)

> 本文件是 [ARCHITECTURE.md](ARCHITECTURE.md) §5 的完整展开，也是外部智能体/LLM 的**绑定契约**。
> 实现位于 `server/serve.mjs`（中继/代理）、`src/ai/bridge.js`（宿主侧可插拔后端）、`src/ai/nl.js`（命令归一化与提示词）。
> 版本：协议 v1（`server: iron-seas-1942 / 1.0.0`）。

---

## 0. 拓扑与角色

```
   ┌──────────────┐   role=sim（浏览器=仿真宿主）   ┌────────────────────┐
   │  浏览器 UI    │ ─── state / heartbeat ───────▶ │  server/serve.mjs  │
   │  index.html  │ ◀── commands / chat ────────── │  中继 + LLM 代理    │
   └──────────────┘                                └────────────────────┘
                                                      ▲   │
                            role=agent：state（该方可见） │   │ commands / chat
                                                      │   ▼
                                              ┌────────────────────┐
                                              │ 外部智能体（任意语言）│
                                              │  Python / Node / LLM │
                                              └────────────────────┘
```

| 角色 | 谁 | 职责 |
| --- | --- | --- |
| `sim` | 浏览器（`src/ui/app.js`） | **仿真宿主**：跑 `World` 主循环，向上推 `state`，接收下行 `commands` 注入世界 |
| `agent` | 外部智能体 | 只收到**本方可见**的 `state`（航迹带误差与延迟），回 `commands` / `chat` |
| `llm` | LLM 后端 | 同 `agent`，但决策由服务器 `POST /api/llm/chat` 代理到 OpenAI 兼容端点；也可由宿主进程内调用 |

服务器**只做中继**（不做任何决策），房间按 `side` 隔离：AXIS 的客户端收不到 ALLIED 的 `state`。

---

## 1. 传输与端点

| 项 | 值 |
| --- | --- |
| 默认地址 | `http://127.0.0.1:8787`（`HOST`/`PORT` 或 `config.json` 可改） |
| WebSocket | `ws://127.0.0.1:8787/ws?role=agent&side=AXIS&name=py-agent` |
| SSE（只读） | `GET /api/stream?role=agent&side=AXIS` |
| 命令注入（HTTP） | `POST /api/orders` |
| LLM 代理 | `POST /api/llm/chat` |
| 其它 | `GET /api/health | /api/agents | /api/scenarios | /api/config | /api/replay`，`POST /api/replay` |
| 鉴权 | 仅当 `config.json` 含 `token` 或 `SERVER_TOKEN` 非空：WS/SSE/HTTP 需 `?token=`；WS 握手失败返回 401 |
| 限制 | 单帧 ≤ 8 MiB；HTTP body ≤ 16 MiB（回放 32 MiB） |
| 服务器心跳 | 每 30 s 发 ping，90 s 无 pong 断开（1001） |

CORS：所有响应带 `Access-Control-Allow-Origin: *`，`OPTIONS` 预检返回 204。

---

## 2. WebSocket 协议

### 2.1 握手

连接建立后服务器立即发 `hello`；客户端应发一次 `hello`/`register`，服务器回 `welcome`（含协议能力）：

```json
// 服务器 → 客户端（连接即发）
{ "type": "hello", "id": "C1", "server": "iron-seas-1942", "version": "1.0.0",
  "role": "agent", "side": "AXIS", "tokenRequired": false, "t": 1730000000000 }

// 客户端 → 服务器（注册，可选但推荐）
{ "type": "hello", "role": "agent", "side": "AXIS", "name": "py-agent" }

// 服务器 → 客户端
{ "type": "welcome", "id": "C1", "server": "iron-seas-1942", "version": "1.0.0",
  "role": "agent", "side": "AXIS", "t": 1730000000000,
  "peers": { "sim": 1, "agents": { "ALLIED": 0, "AXIS": 1 }, "sse": 0 },
  "protocol": { "upstream": ["state","request_decision","heartbeat"],
                "downstream": ["commands","chat","heartbeat","welcome"] } }
```

### 2.2 消息总表

| 类型 | 方向 | 载荷 | 服务器行为 |
| --- | --- | --- | --- |
| `state` | sim → server | `{side, t, backend?, seq?, payload}` | 缓存为 `lastState[side]`，广播给**同方** agent 与全部 sim 与同方 SSE |
| `request_decision` | sim → server | `{side, t, backend?, state?}` | 转发给同方 agent/SSE；无 agent 时回 `notice NO_AGENT` |
| `commands` / `orders` / `decision` | agent → server | `{side, commands | orders | decision.commands, chat?, reasoning?, source?}` | 转发给全部 sim；回 `ack` |
| `chat` | 双向 | `{side, text, from?}` | 中继给全部 sim 与同方 agent |
| `heartbeat` / `ping` | 双向 | `{seq?, t?}` | 回 `{type:'pong', t, echo, t_sim}` |
| `pong` | 双向 | — | 刷新活跃时间（服务器 90 s 超时） |
| `fallback` | sim → server | `{side, reason}` | 计数并触发宿主回调 |
| `replay` | sim → server | `{replay | payload}` | 落盘到 `replays/` 并入列表 |
| `bye` | 双向 | — | 正常关闭（1000） |
| `error` | server → 客户端 | `{code, message}` | 见 §10 |
| `notice` | server → 客户端 | `{code:'NO_AGENT', message}` | 提示宿主应回落 LOCAL |
| `ack` | server → agent | `{id, side, accepted, delivered}` | 命令已被转发给几台 sim |

### 2.3 `state.payload` 逐字段（= `world.visibleStateFor(side)`）

**只包含该方可见的信息**；敌方以航迹（track）呈现，带误差、置信度与龄期。

```json
{
  "t": 1234.5,                          // 仿真时间（s）
  "side": "AXIS",
  "scenario": { "id": "savo_island_1942", "nameZh": "萨沃岛海战", "mission": "夜袭击破盟军巡洋舰分队…" },

  "ownShips": [{
    "id": "chokai", "name": "鸟海", "side": "AXIS", "type": "CA", "class": "Takao",
    "pos": { "x": 0, "y": 0 },          // 世界坐标，米；x=东，y=北；原点 = 剧本 start.lat/lon
    "heading": 150, "speed": 26, "rudder": 0,
    "list": 0, "trim": 0, "draft": 6.3, // 横倾/纵倾(度)、吃水(m)
    "isAfloat": true, "sinking": false, "capsized": false,
    "floodedM3": 0, "floodedPct": 0,    // 进水量(m^3)与占储备浮力百分比
    "fires": 0, "crew": 1100, "crewPct": 1,
    "batteries":  [{ "id":"bat0","label":"No.1","role":"main","destroyed":false,"health":1,"ammo":{"AP":60,"HE":60} }],
    "subsystems": [{ "kind":"BOILER","name":"锅炉 #1","health":1,"destroyed":false }],
    "directors":  [{ "id":"dir0","label":"九四式…","destroyed":false,"health":1,"target":"t7" }],
    "sensors":    [{ "id":"radar0","label":"22号電探","kind":"RADAR","on":true,"destroyed":false,"health":1 }],
    "speedCapKn": 35.5,
    "commanded":  { "heading":150, "speed":26, "firing":true, "targetTrackId":"t7" },
    "torpedoes":  [{ "id":"torp0","label":"…","loaded":4,"reloads":8,"destroyed":false }],
    "dc": { "priority":"flooding", "parties":12, "pumpCapacity_m3_min":183.3 },
    "effectiveGM": 1.6
  }],

  "tracks": [{
    "id": "t7",
    "pos": { "x": -9000, "y": 12000 },   // 估计位置（米）
    "courseDeg": 290, "speedKn": 12.0,   // 估计航向航速
    "classifiedAs": "CA",                // UNKNOWN|DD|CL|CA|BC|BB|CV
    "confidence": 0.72,                  // 0..1，失跟衰减
    "ageS": 3.4,                         // 距最近观测的时间（s）
    "errM": 420, "errDeg": 1.8,          // 位置/方位不确定度（1σ）
    "sources": ["RADAR","VISUAL"],       // 数据来源
    "rangeM": 15000, "bearingDeg": 327,  // 相对本舰的距离与真方位
    "idConfidence": 0.55, "hostile": true
  }],

  "environment": {
    "seaState": 2.0, "windDirDeg": 160, "windKn": 4.0,
    "visibilityNm": 6.0, "lightLevel": 0.01,     // 0=漆黑 1=正午
    "sunriseH": 6.15, "sunsetH": 17.75, "moonIllum": 0.42, "timeOfDayH": 4.65
  },

  "recentEvents": [{ "t": 1180.2, "type": "gun.hit", "data": { "ship":"chokai", "target":"t7", "rangeM":14980, "result":"penetration" } }],
  "timeScale": 1
}
```

说明：

- `ownShips[].commanded` 是**已下达但可能尚未生效**的目标值（受 C2 延迟影响，见 §2.5）。
- `tracks` 是同方融合视图；非本舰观测要等报告延迟（舰内 ~5 s、超地平线中继 +9 s）才出现。
- `recentEvents` 只含**该方可见**的事件摘要（末 40 条），可用于情报推断与聊天。
- `environment.lightLevel` < 0.02 表示夜战：光学测距与观测水柱基本失效，需要探照灯/照明弹。

### 2.4 `commands` 逐字段

发给服务器的 `commands` 数组元素 = 一条**命令意图**（未加延迟与 side）：

```json
{
  "shipId": "chokai",          // 可选；省略 = 编队级，由宿主展开为逐舰（nl.expandFleetCommands）
  "shipIds": ["chokai","aoba"],// 可选：多舰同令（与 shipId 二选一）
  "scope": "FLEET",            // 可选：'FLEET' 额外 +5s C2 延迟；缺省 'SHIP'
  "kind": "SET_COURSE",        // 必填，见下表
  "params": { "heading": 240 },// 必填（可为 {}）
  "note": "转向占位"            // 可选，仅作日志
}
```

宿主侧会先过 `nl.normalizeCommand()`（kind 别名、数值强制与钳位、非法值丢弃），再过 `expandFleetCommands()`，最后经 `world.issueCommand()` 施加 `side.orderDelay_s` 延迟。因此：

- 未知 `kind` 被**丢弃**（不会让仿真崩溃），并计入 `status.commandsRejected`。
- 数值越界被钳位（如 `kn` 钳到 0..45、`deg` 钳到 ±40、`heading` 归一化到 0..359）。
- 未提供 `shipId` 的编队级命令会**先展开**为每舰一条，再各自计时。

命令 kind 全表（ARCHITECTURE §3）：

| kind | params | 说明 |
| --- | --- | --- |
| `SET_COURSE` | `{heading:0..359}` | 设定航向，清空舵角命令 |
| `SET_SPEED` | `{kn:0..speedMax}` | 主机转速/航速指令 |
| `SET_RUDDER` | `{deg:-max..+max}` | 直接舵角（右正左负） |
| `FIRE` | `{trackId?, ammo:'AP'|'HE'|'SAP'|'STAR'|'ILLUM', salvoes?, battery?}` | 对指定航迹开火；`salvoes` 省略/null = 持续射击 |
| `CEASE_FIRE` | `{}` | 停火 |
| `LAUNCH_TORPEDO` | `{trackId?, bearing?, spreadDeg, tubes, speedIdx?}` | 鱼雷扇面齐射；`spreadDeg` ≤20，`tubes` 1..10 |
| `SMOKE` | `{on:bool}` | 施放烟幕 |
| `SEARCHLIGHT` | `{on:bool, bearing?}` | 探照灯（会暴露自己） |
| `RADAR` | `{on:bool}` | 雷达开关（1942 年开机即可能被无线电测向发现） |
| `SONAR` | `{on:bool}` | 声呐开关 |
| `STAR_SHELL` | `{bearing, range}` | 照明弹 |
| `DC_PRIORITY` | `{mode:'flooding'|'fire'|'magazine'|'mobility'}` | 损管优先级 |
| `DAMAGE_CONTROL` | `{action, compartment}` | 分舱损管指令 |
| `FORMATION` | `{station:{bearingDeg,rangeM}}` | 编队站位 |
| `WITHDRAW` | `{}` | 脱离交战 |
| `ASSIGN_TARGET` | `{shipId, trackId, ammo?}` | 舰队级指定目标 |
| `SET_SCREEN` | `{ships:[...]}` | 舰队级屏护分配 |
| `PLOT_COURSE` | `{heading}` | 舰队级统一航线 |
| `LAUNCH_AIRCRAFT` | `{}` | CV（本模拟不含航空兵交战，保留接口） |
| `CHAT` | `{text}` | 文本口令（进聊天日志与 `ai.chat` 事件） |

### 2.5 指挥延迟（C2 delay）不是可选项

`world.issueCommand()` 计算 `t_effective = t_issue + side.orderDelay_s + 舰队级 5 s + 超无线电地平线中继 9 s`。**智能体无法伪造 `t_effective`**，也无法绕过。后果：编队级转向会比单舰命令慢；远离旗舰的舰（超出 `4.12√(h1+h2)`）命令更慢。智能体应按 8～30 s 的决策周期规划，而不是逐帧微操。

---

## 3. SSE + `POST /api/orders`（零依赖接入路径）

不想实现 WebSocket 的智能体（例如只用 Python 标准库）可以走 SSE：

- 订阅：`GET /api/stream?role=agent&side=AXIS`
  - 连接即发 `retry: 3000` 与 `event: hello`；
  - 每次收到该方 state 转发 `event: state`，`data` 为 `{type:'state', side, t, payload}`；
  - 宿主请求决策时发 `event: request_decision`；
  - 每 15 s 发送注释行 `: ping …` 保活。
- 下发：`POST /api/orders`

```json
// 请求
{ "side": "AXIS",
  "commands": [ { "shipId":"chokai", "kind":"SET_COURSE", "params":{ "heading":150 } } ],
  "chat": "第 8 舰队，保持航向，准备雷击。",
  "reasoning": "敌巡洋舰分队在左前方 15 km，抢占 T 字。",
  "source": "AI_REMOTE" }

// 响应
{ "ok": true, "side": "AXIS", "accepted": 1, "delivered": 1, "id": "ord1a2b3c4d", "sims": 1 }
```

也可发单条：`{"side":"AXIS","command":{...}}`。`delivered` 为 0 表示当前没有 `role=sim` 宿主在跑（命令被丢弃），智能体应等待下次 state。

---

## 4. 其它 HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务器版本、客户端统计、`lastState[side]` 的 t/age、LLM 是否配置、回放数 |
| GET | `/api/agents` | 全部 sim/agent/SSE 连接（角色、side、最后活跃、收发计数） |
| GET | `/api/scenarios` | `data/scenarios.json` 的剧本列表（含 `source` 路径） |
| GET | `/api/config` | 非敏感配置与协议参数（`stateHz:'1-2', fallbackAfterS:12`） |
| GET | `/api/stream` | SSE（§3） |
| POST | `/api/orders` | 命令注入（§3） |
| POST | `/api/llm/chat` | OpenAI 兼容代理（§7） |
| GET/POST | `/api/replay` | GET 列表或 `?id=` 下载；POST 保存回放（`{action:'list'}` 也可） |

---

## 5. 掉线回落语义（宿主侧 `AICommander`）

真实感要求：**外部智能体掉线不能让仿真停摆**。实现见 `src/ai/bridge.js`：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `intervalS` | 8 s（仿真时间） | 决策周期：每 8 s 向智能体请求一次决策 |
| `stateIntervalS` | 0.6 s（≈1.7 Hz） | 状态推送间隔（1–2 Hz 契约） |
| `maxStateHzWall` | 4 Hz（墙上时钟） | 高倍时间压缩下的推送护栏，避免打爆服务器 |
| `heartbeatS` | 5 s | 心跳周期 |
| `timeoutS` | 20 s（墙上） | 单次决策超时 → `ai.error DECISION_TIMEOUT`（不立即回落，等下次周期重问） |
| `fallbackAfterS` | **12 s**（墙上） | 完全静默超过该值 → 回落 LOCAL 并 emit `ai.fallback` |
| `connectGraceS` | 10 s | 从未接入（IDLE）超时 → 回落 LOCAL（reason=no-agent） |
| `minDecisionIntervalS` | 1.5 s（仿真） | 决策注入最小间隔，防命令风暴（`status.rateLimited++`） |
| `maxCommandsPerDecision` | 240 | 单次决策命令数上限 |

状态机：`IDLE → CONNECTED →（静默/断开）FALLBACK →（任一消息/心跳）CONNECTED`。

- 掉线后**立即**由 LOCAL 接管（`detachTransport()` 不再等超时），仿真继续跑。
- 回落期间宿主仍按 `intervalS` 尝试恢复；智能体重连后 `ai.connected` 事件带 `recovered:true` 与 `reconnects` 计数。
- 所有回落/重连/错误都 emit 事件：`ai.connected ai.disconnected ai.fallback ai.error ai.decision ai.chat`（回放与 AAR 可复盘）。
- 服务器侧另有 `notice NO_AGENT` 提示「该方无外部智能体，应回落 LOCAL」。

**智能体侧的软要求**：state 到齐后应在 `timeoutS` 内回一次 `commands`（即使 `commands:[]` 也代表「本周期无变化」），并周期性发 `heartbeat`/`ping`。

---

## 6. Python 最小智能体（标准库，SSE + POST /api/orders）

零第三方依赖；策略：选最近航迹 → 抢占 T 字 → 进入 30 km 开火、16 km 内雷击。

```python
#!/usr/bin/env python3
# iron_agent.py —— 铁海 1942 最小智能体（Python 标准库，SSE 只读 + POST 命令）
import json, math, time, urllib.request

BASE = "http://127.0.0.1:8787"
SIDE = "AXIS"          # 或 "ALLIED"
TOKEN = ""             # 服务器配置了 token 时填写
NAME = "py-agent"

def _url(path):
    return BASE + path + (("&token=" + TOKEN) if TOKEN else "")

def post(path, obj):
    body = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(_url(path), data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))

def norm(d):            # 归一化到 0..360
    return d % 360.0

def decide(state):
    ships = state.get("ownShips") or []
    tracks = [t for t in (state.get("tracks") or []) if t.get("hostile", True)]
    cmds = []
    if not ships or not tracks:
        return {"commands": [], "reasoning": "无敌情，保持搜索"}
    flag = next((s for s in ships if s.get("isAfloat")), ships[0])

    # 1) 选最近目标
    tgt = min(tracks, key=lambda t: t.get("rangeM", 1e9))
    rng = tgt.get("rangeM", 30000.0)
    brg = tgt.get("bearingDeg", 0.0)

    # 2) 抢占 T 字：把自己摆在敌航向的侧面（简单拦截几何）
    lead = 20.0 if rng > 20000 else 0.0
    want = norm(tgt.get("courseDeg", 0.0) + 90.0 + lead)
    if abs(((want - flag.get("heading", 0) + 540) % 360) - 180) > 8:
        cmds.append({"shipId": flag["id"], "kind": "SET_COURSE", "params": {"heading": round(want, 1)}})

    # 3) 30 km 内开火
    if rng < 30000 and not flag.get("commanded", {}).get("firing"):
        cmds.append({"shipId": flag["id"], "kind": "FIRE",
                     "params": {"trackId": tgt["id"], "ammo": "AP", "salvoes": None}})

    # 4) 16 km 内雷击（扇面 4 度，4 管）
    if 1500 < rng < 16000:
        cmds.append({"shipId": flag["id"], "kind": "LAUNCH_TORPEDO",
                     "params": {"trackId": tgt["id"], "spreadDeg": 4, "tubes": 4}})

    return {"commands": cmds,
            "reasoning": "目标 %s，距离 %.0f m，方位 %.0f 度" % (tgt["id"], rng, brg)}

def main():
    print("连接 " + _url("/api/stream?role=agent&side=" + SIDE))
    req = urllib.request.Request(_url("/api/stream?role=agent&side=" + SIDE),
                                 headers={"Accept": "text/event-stream"})
    with urllib.request.urlopen(req) as resp:
        event = None
        for raw in resp:
            line = raw.decode("utf-8").rstrip()
            if not line:
                event = None
                continue
            if line.startswith("event:"):
                event = line[6:].strip()
                continue
            if not line.startswith("data:"):
                continue
            msg = json.loads(line[5:].strip())
            if event == "state" or msg.get("type") == "state":
                dec = decide(msg.get("payload") or {})
                try:
                    r = post("/api/orders", {"side": SIDE, "commands": dec["commands"],
                                             "reasoning": dec["reasoning"], "source": "AI_REMOTE"})
                    print("t=%.1fs 命令 %d 条 delivered=%d | %s"
                          % (msg.get("t", 0), len(dec["commands"]), r.get("delivered", 0), dec["reasoning"]))
                except Exception as e:
                    print("下发失败：", e)
                time.sleep(1.0)   # 决策节流（勿逐帧轰炸）

if __name__ == "__main__":
    while True:
        try:
            main()
        except Exception as e:
            print("SSE 断开，3 s 后重连：", e)
            time.sleep(3)
```

## 7. Node 最小智能体

Node 18+ 有全局 `fetch`（SSE 流），Node 22+ 还有全局 `WebSocket`。下面用 `fetch` 实现零依赖智能体：

```js
// iron_agent.mjs —— node iron_agent.mjs
const BASE = "http://127.0.0.1:8787";
const SIDE = "AXIS";
const norm = (d) => ((d % 360) + 360) % 360;

async function post(path, obj) {
  const r = await fetch(BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj),
  });
  return r.json();
}

function decide(state) {
  const ships = state.ownShips || [];
  const tracks = (state.tracks || []).filter((t) => t.hostile !== false);
  if (!ships.length || !tracks.length) return { commands: [], reasoning: "搜索中" };
  const flag = ships.find((s) => s.isAfloat) || ships[0];
  const tgt = tracks.reduce((a, b) => (a.rangeM <= b.rangeM ? a : b));
  const cmds = [];
  const want = norm(tgt.courseDeg + 90);
  if (Math.abs(((want - flag.heading + 540) % 360) - 180) > 8) {
    cmds.push({ shipId: flag.id, kind: "SET_COURSE", params: { heading: +want.toFixed(1) } });
  }
  if (tgt.rangeM < 30000 && !flag.commanded.firing) {
    cmds.push({ shipId: flag.id, kind: "FIRE", params: { trackId: tgt.id, ammo: "AP", salvoes: null } });
  }
  if (tgt.rangeM > 1500 && tgt.rangeM < 16000) {
    cmds.push({ shipId: flag.id, kind: "LAUNCH_TORPEDO", params: { trackId: tgt.id, spreadDeg: 4, tubes: 4 } });
  }
  return { commands: cmds, reasoning: "最近目标 " + tgt.id + " " + Math.round(tgt.rangeM) + " m" };
}

const res = await fetch(BASE + "/api/stream?role=agent&side=" + SIDE);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let ev = null;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.type !== "state") continue;
        const d = decide(msg.payload || {});
        const ack = await post("/api/orders", { side: SIDE, commands: d.commands, reasoning: d.reasoning });
        console.log("t=" + msg.t + "s 命令 " + ack.accepted + " 条 delivered=" + ack.delivered + " | " + d.reasoning);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    ev = null;
  }
}
```

WebSocket 版本（Node 22+）：`new WebSocket("ws://127.0.0.1:8787/ws?role=agent&side=AXIS")`，`onopen` 发 `{"type":"hello","role":"agent","side":"AXIS"}`，收 `state` 后回 `{"type":"commands","side":"AXIS","commands":[...]}`。宿主侧代码可直接复用 `new AICommander('AXIS', world, { backend:'REMOTE' }).connectWebSocket(url)`（见 `src/ai/bridge.js`）。

---

## 8. LLM 智能体

### 8.1 配置

| 项 | 位置 | 默认 |
| --- | --- | --- |
| 密钥 | `LLM_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `config.json {llm.apiKey}` | 空 = 未配置（503） |
| 端点 | `LLM_BASE_URL` / `config.json {llm.baseUrl}` | https://api.deepseek.com/v1 |
| 模型 | `LLM_MODEL` / `config.json {llm.model}` | deepseek-chat |
| 超时 | `LLM_TIMEOUT_MS` | 60000 |
| 离线模拟 | `LLM_MOCK=1` | 返回确定性 OpenAI 形状响应（演示/CI） |

调用方式：

- 外部进程：`POST /api/llm/chat`，body 为 OpenAI `chat/completions` 子集 `{messages, model?, temperature?, max_tokens?, top_p?, stop?, response_format?}`；密钥由服务器注入，浏览器与外部智能体都拿不到。
- 宿主进程内：`AICommander.connectLLM(baseUrl, {model, temperature, maxTokens})`（会通过服务器代理，不直连上游）。

### 8.2 提示词模板（与 `nl.buildLLMPrompt()` 一致）

**system**：

```text
你是 1942 年太平洋战场的舰队指挥官参谋。只输出 JSON，不要解释，不要 Markdown 代码块。
输出格式：{"reasoning":"简短中文推演","chat":"可选的简短中文口令","commands":[{"kind":"...","params":{...},"shipId":"可选舰id"}]}
可用 kind 与参数：SET_COURSE {heading:0-359}；SET_SPEED {kn:0-40}；SET_RUDDER {deg:-35..35}；FIRE {trackId, ammo:"AP"|"HE"|"SAP", salvoes:数字或null表示持续}；CEASE_FIRE {}；LAUNCH_TORPEDO {trackId|null, bearing, spreadDeg, tubes}；SMOKE {on:bool}；SEARCHLIGHT {on:bool,bearing}；RADAR {on:bool}；SONAR {on:bool}；STAR_SHELL {bearing,range}；DC_PRIORITY {mode:"flooding"|"fire"|"magazine"|"mobility"}；WITHDRAW {}；ASSIGN_TARGET {trackId,ammo}；FORMATION {station:{bearingDeg,rangeM}}；CHAT {text}。
红线：1942 年没有导弹、直升机、卫星、GPS、现代数据链；只能用舰炮、鱼雷、烟幕、探照灯、雷达(早期)、光学测距与灯光/旗语。
只能依据给出的"可见态势"行动，不得假设未探测到的敌舰位置。舰队级命令省略 shipId。
```

**user**：

```text
【可见态势】
（此处填入 world.visibleStateFor(side) 的紧凑文本：本舰状态、航迹、环境、近期事件）

【指挥官指令】
（此处填入玩家中文口令，或"请依据态势下达本周期指令"）

请输出 JSON。
```

### 8.3 输出契约与容错

期望输出：

```json
{ "reasoning": "敌重巡在右前方 15 km，我舰应保持 T 字优势并压制其前导舰。",
  "chat": "各舰注意，右舷 015 距离 15000，准备齐射。",
  "commands": [
    { "shipId": "chokai", "kind": "SET_COURSE", "params": { "heading": 240 } },
    { "shipId": "chokai", "kind": "FIRE", "params": { "trackId": "t7", "ammo": "AP", "salvoes": null } }
  ] }
```

宿主用 `nl.parseDecisionJSON()` 容错解析：剥离 Markdown 代码围栏、提取首个平衡花括号对象、接受 `kind/type/command/action` 别名与中文别名（航向/开火/鱼雷/烟幕/损管…）、数值字符串转数字、越界钳位、未知 kind 丢弃。**LLM 返回任何东西都不会让仿真崩溃**：解析失败 emit `ai.error LLM_PARSE` 并以 LOCAL 兜底。

建议：

- `temperature` 0.2～0.4；`max_tokens` ≤ 800；决策周期 ≥ 8 s（不必每帧调用）。
- 在提示词中显式给出本舰 `id` 与可用 `trackId`，避免模型编造。
- 对 `commands` 做二次校验（本方可用的 shipId/trackId）可显著降低无效命令率。

---

## 9. 无头批量对战

`server/headless.mjs` 在 Node 内跑完整 `World` 主循环（双方 LOCAL AI），不依赖浏览器：

```sh
node server/headless.mjs --list
node server/headless.mjs --scenario savo_island_1942 --seconds 3600 --seed 1      --out r_savo_1.json --replay r_savo_1.replay.json
node server/headless.mjs --scenario java_sea_1942 --seconds 7200 --json > out.json
node server/headless.mjs --builtin --seconds 600        # 完全不读 data/，CI 确定性
```

参数：`--scenario/-s`、`--seconds/-t`、`--dt`、`--seed`、`--out/-o`、`--replay`、`--root`、`--builtin`、`--json`、`--verbose/-v`、`--list`、`--help`。

输出 JSON 关键字段：`scenario{id,nameZh,source}`、`seed/dt/simSeconds/steps/wallMs/speedup`、`over/winner/resultText`、`database{source,shipsLoaded,shipsWanted}`、`ships[]`（终态：在役/进水/横倾/火灾/命中/被弹/鱼雷/弹药）、`counts{...}`、`events`（按类型计数）、`timeline`（大事记）、`digest`（状态摘要哈希，用于回归比对）。

批量示例（同一剧本 20 个种子）：

```sh
for s in 1 2 3 4 5 6 7 8 9 10; do
  node server/headless.mjs --scenario denmark_strait_1941 --seconds 3600 --seed $s        --out results/denmark_$s.json --json > /dev/null
done
```

外部智能体接入的批量对战：启动 `node server/serve.mjs` 与一个浏览器宿主（或自建 sim 客户端）后，把同一份剧本跑多轮，智能体只需按 §2/§3 收发消息；回放可用 `POST /api/replay` 入库，随时用海图播放器复盘。

---

## 10. 错误码与校验规则

| code | 场景 | 处理建议 |
| --- | --- | --- |
| `BAD_JSON` | 消息/请求体不是合法 JSON | 修正序列化 |
| `BAD_SIDE` | 缺少或非法的 side | 只能 `ALLIED`/`AXIS` |
| `BAD_TYPE` | 未知 `type` | 对照 §2.2 |
| `NO_AGENT` | sim 请求决策但该方无 agent | 宿主回落 LOCAL（正常路径） |
| `NO_LINK` | 后端已选但无可用通道/无出站通道 | 检查 WS/SSE 连接 |
| `BAD_BACKEND` | 非法后端名 | `LOCAL`/`REMOTE`/`LLM`（别名见 `normalizeBackendName`） |
| `DECISION_TIMEOUT` | 决策超时（REMOTE 20 s；LLM 120-150 s，推理模型需要更长墙上时间） | 智能体应加速或减少单次命令数 |
| `LLM_PARSE` / `LLM_FAIL` | LLM 输出不可解析 / 调用失败 | 收紧提示词；检查密钥与网络 |
| `CMD_FAIL` / `STATE_FAIL` / `CHAT_FAIL` / `SEND_FAIL` | 内部异常 | 查看服务器日志 |
| `EMPTY_DECISION` | `submitDecision(null)` | 至少回 `{commands:[]}` |
| `NO_API_KEY` (503) | LLM 未配置 | 设密钥或 `LLM_MOCK=1` |
| `BAD_REQUEST` (400) | `messages` 非空数组等 | 修正请求体 |
| `UPSTREAM_ERROR` (502) | 上游 LLM 失败 | 重试/降级 LOCAL |

---

## 11. 版本与兼容

- 协议版本随 `/api/health` 与 `welcome` 的 `version` 下发；破坏性变更会在 ARCHITECTURE.md 广播并升版本号。
- 客户端应忽略未知 `type` 与未知字段（前向兼容）；服务器对未知 type 回 `error BAD_TYPE`。
- 智能体不得依赖仿真时间与墙上时间的固定比例（时间压缩 1x～64x），只按 `state.t` 与自身决策周期工作。

---

## 12. AI 上下文层（"真正的上下文"，v1.1 新增）

> 位置：`src/ai/context.js`（`AIContext`）。**所有后端共享同一套上下文**：
> LLM 后端把它渲染成对话消息（system + 历史回顾 + 本周期简报）；REMOTE/SSE 智能体在每次 `state` 里直接收到结构化 `context` 字段。
> 设计目的：让 AI 记得"这场仗打过什么、我下过什么令、目标怎么动、上周期意图是什么"，而不是每周期只看一张快照。

### 12.1 `state.context` 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `decisions` | int | 本阵营已完成的决策轮数 |
| `lastIntent` | string | 上一轮作战意图（模型未给 intent 时取 reasoning 前 120 字） |
| `turns[]` | array | 最近 6 轮：`{t, intent, commands:[{kind,shipId,params}]}` —— 你的历史决策 |
| `events[]` | array | 自上次决策以来**该方可见**的战况：`{t, text}`（命中/进水/起火/殉爆/沉没/探测/命令生效…），最多 40 条 |
| `orders[]` | array | 你下达过的命令（最近 20 条）：`{t_issue,t_effective,kind,shipId,params,accepted}` —— 注意 `t_effective` 体现指挥延迟 |
| `trackMemory[]` | array | 每个目标的记忆：`{id,firstSeenS,lastRangeM,lastCourseDeg,lastConfidence}` |
| `briefing` | string | 渲染好的中文态势简报（含距离变化率、是否转向、判型改善等），可直接喂给任意 LLM |
| `doctrine` | string | 完整系统提示词（角色/任务/命令表/条令/输出格式）。**只在连接后的第一次 state 中下发**，之后省略 |

简报里的每条航迹形如：

~~~text
T9 判型UNKNOWN 距离8.4nm 方位39° 航速未知(未解算) 航向未知 置信0.8 误差±2412m/±6° 来源RADAR
   最后更新6s前 首次发现150s前 | 变化:距离-2.9km/150s(≈接近38.2kn) 已转向 判型改善
~~~

`变化:` 以**上次决策时刻**为基线（不是两次状态推送之间），因此"接近 38.2kn"这类判断是可用的。

### 12.2 上下文规模与节流

- 单次 `state` 约 20 KB（含 40 条战况 + 20 条命令 + 简报）；首次额外约 1.9 KB 条令。
- `briefing` 按 5 秒重建；事件与命令列表按需追加并截断。
- LLM 后端的对话消息数：`2 + 历史轮次`（system + 历史回顾 + 上一轮回复 + 本周期简报），历史保留 8 轮并可压缩。

### 12.3 最小智能体（带上下文）

~~~python
import json, websockets, asyncio

async def main():
    async with websockets.connect("ws://127.0.0.1:8787/ws?role=agent&side=AXIS") as ws:
        while True:
            m = json.loads(await ws.recv())
            if m.get("type") != "state": continue
            st = m["payload"]; ctx = st["context"]
            # 1) 它记得自己上轮干了什么
            intent = ctx["lastIntent"]
            # 2) 它知道目标在接近还是脱离、有没有转向
            closing = [t for t in st["tracks"] if "接近" in (ctx["briefing"] or "")]
            # 3) 它知道自己哪些命令还没生效（指挥延迟）
            pending = [o for o in ctx["orders"] if o["t_effective"] > st["t"]]
            # 4) 直接把 briefing 交给你的 LLM，把返回的 JSON 回传即可
            #    （也可以用 GET 状态里的 doctrine 作为 system prompt）
            cmds = plan(st, ctx, intent, pending)
            await ws.send(json.dumps({"type": "commands", "commands": cmds}))
~~~

### 12.4 LLM 后端配置（含 OpenCode Go）

密钥只放在 `config.json`（静态服务对 `config.json` 返回 403，绝不进前端）。字段：

~~~json
{
  "llm": {
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "model": "deepseek-v4.1-flash",
    "apiKey": "oc_sk_...",
    "timeoutMs": 60000,
    "userAgent": "iron-seas-1942/1.0",
    "headers": { "x-opencode-session": "iron-seas-1942-<stable-id>" }
  }
}
~~~

要点（实测）：

- **OpenCode Go 要求**：客户端用自己的 User-Agent 标识、每个会话带稳定的 `x-opencode-session`（官方文档规定）。
- `deepseek-v4.1-flash` 是**推理模型**：内容可能落在 `reasoning_content`，且思维链长度不定 —— 必须给足 `max_tokens`（实测 6000-12000 才稳定拿到 JSON；1600 会全部烧在推理上，`finish_reason=length` 且 `content` 为空）。
- 单次决策墙上耗时 18-50 秒，因此 LLM 后端超时设为 120-150 秒（REMOTE 仍为 20 秒）；推理期间本地规则 AI 继续兜底机动。
- 决策周期建议 ≥20 仿真秒（`AICommander.intervalS`），避免推理还没回来就发起下一次请求。
- 上游错误会原样透传（`FreeTierError`、`MissingSessionID` 等），便于定位配置问题。

### 12.5 验证脚本

~~~sh
# 上下文累积 + 两轮真实 LLM 决策（需要服务器在跑）
node probes/lead.llm_context.mjs
# 外部智能体收到的 state/context 体积与结构
node probes/lead.agent_state.mjs
# LLM 指挥官端到端（生成简报→调用→解析→命令回灌仿真）
node probes/lead.llm_e2e.mjs
~~~

