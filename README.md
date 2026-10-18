# nonebot-plugin-rework

一个 **NoneBot2 + OneBot v11** 插件：在 QQ 里发送 `/rework2`，即可得到一张
**ManiaMapAnalyser by Leo_Black（tosu 插件）风格**的 osu!mania 4K 谱面分析卡片。

本项目由 `fixed-density` 仓库的 `qqbot` 分支改造而来，只保留 `/rework2` 指令的功能，
并把通信层从自建 OneBot 客户端迁移到 NoneBot2。仓库内自带渲染所需的
ManiaMapAnalyser 前端插件，无需另外准备 tosu 环境即可独立运行。

---

## 1. 功能

| 用法 | 说明 |
| --- | --- |
| `/rework2 <谱面ID>` | 分析单张谱面，返回一张卡片图片 |
| `/rework2 bid<谱面ID>` / `b<ID>` | 同上（`bid`、`b` 与数字之间可省略空格，写 `bid 123` 亦可） |
| `/rework2 sid<谱包ID>` / `s<ID>` | 分析整个谱包，以**合并转发（聊天记录）**形式发送多张图片 |
| `/rework2 <osu! 链接>` | 支持 `osu.ppy.sh/beatmapsets/...`、`/beatmaps/...`、`/b/...`、`/s/...` |
| 回复谱面文件并发送 `/rework2` | 支持 `.osu` / `.osz` / `.mc` / `.mcz`，以及任意 `.zip`（可嵌套） |

**容器读取**：`.osz` / `.mcz` / `.zip` 统一按 zip 处理，递归遍历包内所有目录，
收集 `.osu`、`.mc`，并对嵌套压缩包继续展开（最多 4 层，含条目数与解压体积上限）。
同一包内重复的谱面会按内容去重。

**Malody 支持**：`.mc` / `.mcz` 会先按 **模式 + 轨道数** 校验，再转换为一份临时
`.osu`（物件时间戳保留浮点毫秒）后交给渲染器。

**容错行为**：轨道数不是 4、或不是 osu!mania 谱面时，该张谱面的卡片会被替换为
错误提示图片；其余谱面照常输出。单张渲染失败也只会替换那一张，不会中断整包。

---

## 2. 目录结构

```text
nonebot-plugin-rework/
├─ bot.py                       # NoneBot2 启动入口
├─ pyproject.toml               # 项目元数据、依赖、NoneBot 配置
├─ .env.example                 # 配置模板
├─ README.md
└─ nonebot_plugin_rework/
   ├─ __init__.py               # 插件元信息
   ├─ handler.py                # /rework2 指令与服务生命周期
   ├─ service.py                # 指令解析、下载、渲染、发送
   ├─ config.py                 # 插件配置与运行时配置
   ├─ beatmap.py                # .osu 解析与 4K mania 校验
   ├─ archive.py                # .osz/.mcz/.zip 递归扫描
   ├─ malody.py                 # .mc 解析与转换为 .osu
   ├─ osu_source.py             # 镜像下载 / 链接解析
   ├─ cache.py                  # 按内容哈希的谱面图片库
   ├─ renderer.py               # 本地静态服务 + 无头浏览器截图
   ├─ errorcard.py              # 错误提示图片
   └─ tosu_plugin/              # 自带的 ManiaMapAnalyser 前端插件
```

运行时会在工作目录下生成：

```text
data/
├─ charts/                      # <哈希>.osu / <哈希>.png / <哈希>.bg / <哈希>.json
└─ temp/                        # REWORK_KEEP_FILES=true 时的临时图片
```

---

## 3. 环境准备

需要 **Python ≥ 3.10** 与一个可用的 Chromium 内核浏览器。

```powershell
cd "g:\modding list\4kcalc\nonebot-plugin-rework"
python -m pip install -e .
```

浏览器二选一：

- **推荐**：使用系统已安装的 Edge，无需额外下载。保持 `.env` 中
  `REWORK_BROWSER_CHANNEL=msedge` 即可。
- 或安装 Playwright 自带 Chromium，并把 `REWORK_BROWSER_CHANNEL` 设为空：

```powershell
python -m playwright install chromium
# .env: REWORK_BROWSER_CHANNEL=
```

---

## 4. 配置

复制模板并填写：

```powershell
Copy-Item .env.example .env
```

### 4.1 OneBot v11 连接

以 Windows 上常用的 **NapCatQQ** 为例（Lagrange.Core / go-cqhttp 同理）：

1. 准备一个 QQ 小号，按 NapCat Releases 的说明启动并扫码登录。
2. 打开 NapCat WebUI，进入 **网络配置 → 添加 → WebSocket 服务器（正向 WS）**：
   - 主机：`127.0.0.1`
   - 端口：`3001`
   - Token：与 `.env` 的 `ONEBOT_ACCESS_TOKEN` 完全一致（留空表示不鉴权）
   - 消息格式：`array`
3. 保存并启用。

`.env` 中对应：

```dotenv
DRIVER=~websockets
ONEBOT_WS_URLS=["ws://127.0.0.1:3001"]
ONEBOT_ACCESS_TOKEN=你设置的Token
```

> OneBot v11 的正向 WebSocket 是机器人主动连接 NapCat，因此必须使用支持
> WebSocket 客户端的驱动（`~websockets`）。使用 `~fastapi` 会提示
> `does not support websocket client connections`，无法连接。

### 4.2 指令前缀

`/rework2` 是 NoneBot 的指令名，前缀由 `COMMAND_START` 控制：

```dotenv
COMMAND_START=["/"]
```

如需全角斜杠，可写成 `COMMAND_START=["/", "／"]`。

### 4.3 全部配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REWORK_PLUGIN_DIR` | 空 | 渲染插件目录；留空使用自带的 `nonebot_plugin_rework/tosu_plugin` |
| `REWORK_RENDER_HOST` | `127.0.0.1` | 本地静态服务监听地址 |
| `REWORK_RENDER_PORT` | `24750` | 本地静态服务端口，**不要与 tosu 的 24050 相同** |
| `REWORK_BROWSER_CHANNEL` | `msedge` | `msedge` 用系统 Edge；留空用 Playwright Chromium |
| `REWORK_HEADLESS` | `true` | 是否无头运行浏览器 |
| `REWORK_DEVICE_SCALE_FACTOR` | `2` | 截图倍率，2 = 二倍图 |
| `REWORK_PAGE_TIMEOUT_MS` | `180000` | 页面加载 / 分析超时 |
| `REWORK_SETTLE_MS` | `1500` | 分析完成后等待动画结束的时间 |
| `REWORK_BEATMAP_URL` | `https://osu.direct/api/osu/{id}` | 谱面下载地址模板 |
| `REWORK_BEATMAPSET_URL` | `https://osu.direct/api/d/{id}` | 谱包下载地址模板 |
| `REWORK_USER_AGENT` | `nonebot-plugin-rework/1.0` | 下载请求 UA |
| `REWORK_HTTP_TIMEOUT_SEC` | `60` | 下载超时 |
| `REWORK_MAX_BEATMAPS_PER_PACK` | `40` | 单次最多处理多少张谱面 |
| `REWORK_INCLUDE_BACKGROUND` | `true` | 是否使用谱面包内的背景图 |
| `REWORK_DATA_DIR` | `data` | 谱面库目录（相对工作目录） |
| `REWORK_TEMP_DIR` | 空 | 临时图片目录；留空为 `<数据目录>/temp` |
| `REWORK_KEEP_FILES` | `false` | 是否把生成图片落到临时目录 |
| `REWORK_CACHE_ENABLED` | `true` | 是否启用内容哈希缓存 |
| `REWORK_SEND_AS_FORWARD` | `true` | 多张谱面时是否使用合并转发 |
| `REWORK_FORWARD_NAME` | `Rework 谱面分析` | 合并转发标题 |
| `REWORK_FORWARD_UIN` | `10000` | 合并转发节点显示的 QQ 号 |
| `REWORK_ALLOW_GROUP` | `true` | 是否允许群聊触发 |
| `REWORK_ALLOW_PRIVATE` | `true` | 是否允许私聊触发 |
| `REWORK_GROUP_ALLOWLIST` | `[]` | 群白名单，留空不限制 |
| `REWORK_USER_DENYLIST` | `[]` | 用户黑名单 |

**谱面镜像**：默认使用 `osu.direct`。若不可用，可换成其他镜像，例如：

```dotenv
REWORK_BEATMAP_URL=https://catboy.best/osu/{id}
REWORK_BEATMAPSET_URL=https://catboy.best/d/{id}
```

> `/rework2 <ID>` 需要机器人所在机器能访问外网镜像；回复文件的方式完全离线可用。

---

## 5. 启动

```powershell
cd "g:\modding list\4kcalc\nonebot-plugin-rework"
python bot.py
```

看到 NoneBot 启动日志、OneBot 连接成功后，在 QQ 里私聊机器人，或在群里发送
`/rework2 129891` 试一下。

调试时可在 `.env` 中调高日志级别：

```dotenv
LOG_LEVEL=DEBUG
```

---

## 6. 工作原理

ManiaMapAnalyser 是 tosu 的前端插件：页面加载后会直接向
`http://<socketHost>/files/beatmap/file` 取 `.osu` 原文并分析、渲染，
tosu 的 WebSocket 断连只会在后台重试。因此本项目：

1. 用本地 HTTP 服务把 `tosu_plugin/` 当作站点根目录托管；
2. 拦截 `/files/beatmap/file` 返回目标谱面文本，`/files/beatmap/background`
   返回谱面背景图；
3. 拦截 `/settings.json`，**在内存中**注入固定的插件设置（不修改磁盘文件）；
4. 用无头浏览器打开 `index.html`，等卡片渲染完成后对 `.main-card` 截图。

注入的设置项：

| 插件设置 | 值 |
| --- | --- |
| Card Body Content | `Pattern` |
| Top-left Capsule Text | `Fixed Density v1` |
| Top-right Content | `Difficulty` |
| Map Tag Capsule / osu!Lazer 主题 / osu! 字体 / 浮动三角 / 封面背景 | 开 |
| Custom Background Color | `#000000` |
| Rainbow Bars / Reverse Card Extension / Extended Estimation Range | 关 |
| Metadata Marquee / Numeric Difficulty / LN Star Rating / Show 6K Constant Rating | 开 |
| Card Visibility / Card Opacity / Content Background Blur / Card Radius | `Always` / `95%` / `4px` / `Medium` |
| Pause Detection / Vibro Detection | 开 |
| SV Detection | 关 |
| Improve Sunny LN Estimation / Analyze LN Parts | 开 |
| Pause Detection Threshold | `500` |
| Estimator Algorithm / Global Etterna Version / Companella Etterna Version | `Mixed` / `0.72.3` / `0.74.0` |

另有离屏渲染专用改动：关闭 `Enable Update Check` 与 `Anonymous Usage Statistics`，
避免联网阻塞。想改显示效果，编辑
[renderer.py](nonebot_plugin_rework/renderer.py) 里的 `PRESET_OVERRIDES`。

### 6.1 Malody 转换

插件只认 `.osu`，所以 Malody 谱面先在本地转换成临时 `.osu`：

| Malody | osu! |
| --- | --- |
| `meta.mode`（0 = Key） / `meta.mode_ext.column` | `Mode: 3` / `CircleSize` |
| `beat: [小节, snap索引, snap大小]` | 拍位 `a + b/c`，再按 `time[].bpm` 逐段积分为毫秒 |
| `note[].endbeat` | `type 128`（长按）+ `endTime` |
| `effect[].scroll > 0` | 绿线（`uninherited=0`，`beatLength = -100/scroll`） |
| 无 `column` 且 `type==1` 的条目 | BGM 事件，其 `offset` → `AudioLeadIn` |
| `column` | `x = round((column*2+1)/(key*2) * 512)` |

- 时间戳保留浮点毫秒，避免转换引入系统性偏差。
- OD 固定写 `8`。
- 转换结果会作为谱面文本存进 `data/charts/<哈希>.osu`，可直接打开核对。
- 旧版 Malody 的数组式音符格式暂不支持，会给出明确提示。

### 6.2 谱面库缓存

每次查询都会把**最终用于分析的 `.osu` 文本**做 SHA-256 作为键，落盘到
`data/charts/`。再次查询到同一谱面时（包括来自不同谱包、改了文件名的同一份内容）
直接复用已有图片，不再渲染。想强制重算，删除对应文件即可。

---

## 7. 本地自测

插件自带完整的渲染链路，可以先不接 QQ，直接用脚本验证环境：

```powershell
python scripts\render_local.py "..\benchmark\ln\L4.8TS.osu" --out sample.png
```

也可以传 `.osz` / `.mc` / `.mcz` / `.zip`，多张谱面会输出到目录：

```powershell
python scripts\render_local.py .\pack.osz --out .\temp
```

脚本只会使用默认配置与仓库自带的渲染插件，不读取 `.env`。

接好 QQ 后，可以直接发送：

```text
/rework2 129891
/rework2 bid129891
/rework2 s123456
/rework2 https://osu.ppy.sh/beatmapsets/123456#mania/129891
```

---

## 8. 常见问题

- **`无法启动无头浏览器`**：执行 `python -m playwright install chromium`，或把
  `REWORK_BROWSER_CHANNEL` 设为 `"msedge"`。
- **端口被占用**：修改 `REWORK_RENDER_PORT`（避开 tosu 的 24050）。
- **截图里是别的谱面**：确认没有另一个实例占用同一 `REWORK_RENDER_PORT`。
- **`/rework2 <ID>` 报「镜像站返回的不是谱面文件」**：镜像限流或 ID 不存在，
  换镜像或改用回复文件。
- **谱包很大时很久**：谱面逐张串行渲染，可用 `REWORK_MAX_BEATMAPS_PER_PACK` 限制。
- **改了插件设置后图片没变**：这是哈希缓存的正常行为，删除 `data/charts/` 下
  对应文件即可重算。
- **插件的状态行出现 `[Error]`**：说明插件内部某个分析子模块报错，此时会按当前
  画面直接出图，并在日志中给出 WARNING。

---

## 9. 与 qqbot 分支的差异

- 通信层使用 **NoneBot2 + nonebot-adapter-onebot**，不再自带 OneBot 客户端。
- 仅保留 `/rework2` 指令，移除了 `/report` 反馈与发送消息索引。
- 配置从 `config.json` 改为 `.env` 中的 `REWORK_*` 变量。
- 仓库内自带 ManiaMapAnalyser 前端插件，克隆后即可运行。
- 谱面解析、Malody 转换、缓存、渲染与截图逻辑保持一致。

---

## 10. 致谢

- 分析卡片与前端渲染逻辑来自 **ManiaMapAnalyser by Leo_Black**（tosu 插件）。
- 本项目由 `fixed-density` 仓库 `qqbot` 分支改造而来。
