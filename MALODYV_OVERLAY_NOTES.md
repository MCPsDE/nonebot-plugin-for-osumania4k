# MalodyV Overlay 技术记录

本文记录当前卡片模式、MalodyV 选谱接口、BepInEx 安装器与独立 overlay 的实现及踩坑。
`E:\UnityProjects\Emiria` 仅作只读参考，没有修改游戏源码。

## 当前卡片模式行为

- `.osu` 的 standard、taiko、catch、任意键数 mania 都可进入卡片渲染。
- Fixed Density RC/LN 只对 4K mania 计算；其他模式或键数显示 `-`。
- 非 4K mania 与非 mania 的右上段位估计取同目录参考插件提供的 Sunny 段位文本；若参考算法不支持该模式，结果自然显示 `-`。
- 聊天插件的 `.mc` 转换器接受 Malody Key 模式 1–18K，不接受旧版数组式音符格式或非 Key 模式。5K 转成 `.osu` 后仍是 card-only：RC/LN 显示 `-`，右上段位尝试使用 Sunny 参考结果。

## MalodyV 选谱来源

只读参考源码位于 `E:\UnityProjects\Emiria`，本轮没有修改该目录。

- `Assets/Malody/Scripts/Scene/Item/ItemChart.cs` 在选择谱面时发送 `Notification.Type.ChangeChart`，数据是 `MaChart`。
- `Assets/Malody/Scripts/Scene/SceneChart.cs` 收到该通知后将谱面写入 `PlayInfo.Local.Chart`。
- `Assets/Malody/Scripts/Play/PlayInfo.cs` 提供静态 `PlayInfo.Local`。
- `Assets/Malody/Scripts/Framework/Chart/ChartData/Chart.cs` 暴露 `MaChart.FilePath` 与 `MaChart.IndexInFile`。

独立插件通过 Harmony postfix 监听 `ItemChart.OnPointerClick` 和 `ItemChart.SetSelected`，从选中项的 `Chart` 读取 `FilePath`、`IndexInFile`、`DisplayVersion`；`SceneChart.OnClose` 清除选择。启动时只读一次当前状态，之后仅由选谱、Mod/Turbo 面板关闭、联机配置和场景状态 Harmony 事件触发。没有 `Update()`、协程轮询或逐帧读取；IPC 只在谱面或分析签名改变时发送。重分析在伴侣进程异步执行，不占用游戏帧。

当前插件读取 `PlayInfo.Local.Mod`、`customJudge.audioSpeed`、`playMode` 和 `RandomSeed`。对活动 Mod 调用游戏自身的 `PlayUtil.CanPlayMod`，排除当前模式不能使用的位；Mod/Turbo 面板关闭以及联机房间配置更新时主动重发，且有效 Mod、速度、模式和随机种子纳入选择签名，所以同图切换配置会更新分析。普通 Rush/Dash/Slow 分别按游戏 `PlayInfo.PlaySpeed` 语义使用 1.5/1.2/0.8；Turbo 使用 `audioSpeed`，Holds 与速率 Mod 同时启用时按游戏 `Validate()` 的优先级取速率 Mod。此 Mod 过滤入口只在首次配置事件反射解析并缓存，不做持续扫描。

宿主在 `.osu` 输入上应用与 Key/Cube processor 对应的内容变化：Flip/Invert/Luck 轨道映射、Less 按起始拍的约分分母过滤、Thumb 按列数种子和活跃长条处理、Taps 把长条转单击、Holds 按同轨下一音符和 1/4 拍规则将单击转成长条。Fixed Density 曲线、RC/LN 数值和 Sunny/官方星数均使用转换后的谱面；速率传入各自的时间尺度计算。非 Key 的内容变化不擅自套用 mania 转换。

## 格式与解析边界

- `FilePath` 是文件路径，不保证文件本身只包含当前这一张难度。`IndexInFile` 对 SM/TJA 等多难度文件尤其重要，不能只按路径缓存或分析。
- `.osu` 可直接交给当前前端 parser。非 mania 模式允许生成卡片，但 mania 专属 RC/LN 和 Sunny 估算并不因此变成适用于所有模式的算法。
- 聊天插件的 `.mc` 转换使用 `meta.mode`、`meta.mode_ext.column` 和 `note[]` 转成临时 `.osu`，接受 Key 1–18K；非 Key 和旧版数组式音符格式仍拒绝。独立 Overlay 自带 C# 转换器，可将 Malody Key/Catch/Taiko 及其他模式映射为卡片输入。所有非 4K mania 的 RC/LN 固定密度值保持 `-`，不把 4K 算法套到其他键数。
- 5K 曾有两个独立阻断点：`.mc` 转换器硬编码只接受 4K；即使 `.osu` 5K 成功分析，离屏渲染器又把左上数值 `-` 误判为分析未完成。现已放宽转换到 1–18K，并以页面 `status.ok` 判定渲染完成；`-` 是非 4K 的预期 RC/LN 显示，不再阻止卡片生成。
- 若某种格式含多难度，解析器必须先根据 `IndexInFile` 选中对应难度，再生成输入文本。不能将同一文件中的所有难度音符混成一张卡片。
- 未验证 BMS、TJA、SM、Quaver 等格式能否无损转成当前 renderer 所需的 `.osu` 结构；不得仅凭 `FilePath` 扩展名推断它们可以使用 mania 算法。

## 本机运行时检查

检查目标目录为 `E:\Program Files (x86)\Steam\steamapps\common\MalodyV`。本机文件元数据与配置显示：BepInEx `6.0.0-be.785`、Doorstop `4.5.0`、Unity `2022.3.62f2c1`；目标是 64 位 IL2CPP。Doorstop 加载 `BepInEx\core\BepInEx.Unity.IL2CPP.dll`，配置中的 CoreCLR 路径是 `dotnet\coreclr.dll`，核心库目录是 `dotnet`，并包含 `BepInEx\interop\Assembly-CSharp.dll`。这表明该环境是 IL2CPP 插件环境，不能按 Mono BepInEx 的引用方式构建。

独立插件已对照目标安装目录中的 BepInEx core、interop 和 Unity interop 程序集构建。运行时重装器将 `BepInEx\plugins` 作为保留目录，尤其不能删除其中已有的主题插件；当前安装目录已存在 `MalodyVThemeLoader` 插件。

## 独立安装器与 Overlay

- BepInEx 安装器工程：只读参考仓库 `E:/Desktop/MalodyVThemeLoader`；当前发布为 `malodyv_tools/release/MalodyV-BepInEx-Installer-1.0.3.exe`（自包含、离线 payload）。
- 安装器会在安装/修复前整体暂存旧 `BepInEx`，删除旧运行时、配置、缓存和 Doorstop 文件，即使它们由其他安装器安装；只复制回原有 `BepInEx/plugins`，然后安装固定版本 `6.0.0-be.785`。旧根目录 `winhttp.dll`、`doorstop_config.ini` 和 `.doorstop_version` 会被新 payload 替换，失败时回滚。目标目录或 `BepInEx/plugins` 为 reparse point 时拒绝操作。
- 新安装器没有覆盖本机真实游戏目录；已在隔离假游戏目录完成首次安装、清理旧运行时、保留 plugins、替换 Doorstop、卸载和再次安装测试。
- 2026-10-20 收到实际安装错误 `Access to the path ...\\MalodyV\\BepInEx is denied`。原因是 Steam 默认游戏路径位于 `Program Files (x86)`，但 `1.0.3` 没有声明 UAC 管理员执行级别，普通权限移动旧 `BepInEx` 时被 Windows 拒绝。`1.0.4` 已嵌入 `requireAdministrator` 应用清单，启动时由 Windows 请求提升；从 PE 资源确认清单存在，并用隔离目录对安装/修复/卸载流程回归通过。该版本仍未在真实游戏目录执行。
- Overlay 发布目录：`malodyv_tools/overlay/release/MalodyVReworkOverlay`；BepInEx 插件 DLL 必须放在 `BepInEx\plugins` 根目录，伴侣程序与 Bot 目录放在 `BepInEx\plugins\MalodyVReworkOverlay` 子目录。此前把 DLL 和伴侣程序全部放进子目录时，目标 BepInEx 日志出现 `0 assemblies discovered`，因此发布脚本现在按该布局输出。
- 游戏内插件以 .NET 6 编译，运行于 BepInEx IL2CPP；独立 WPF/WebView2 伴侣使用 self-contained .NET 8，提供管理窗口和透明置顶卡片，不依赖目标机器预装 .NET Desktop Runtime。卡片 HTML/CSS/JS、字体、WASM、ONNX、portable Python、NumPy 与参考算法源码一起打包，页面由本地 HTTP 服务供 WebView2 加载。
- Overlay 关闭 WebSocket、联网更新和遥测；本地服务提供谱面文本、设置、背景图、参考难度与分析选项端点。页面复用当前卡片实现，不另画一套 UI。
- `ItemChart.OnPointerClick` 覆盖鼠标选择，`ItemChart.SetSelected` 覆盖列表键盘选择，`SceneChart.OnClose` 清除卡片。IPC 使用本地命名管道 `MalodyV.ReworkOverlay.Selection`。游戏侧只在 `FilePath + IndexInFile + DisplayVersion` 变化时发送更新，伴侣在新选择到达时重载分析。
- `.mcz` 本质上是包含多张谱面及多个模式的 ZIP。同一容器路径可能对应不同难度；不能按 ZIP 首项或仅按路径选图。Overlay 先用游戏提供的 `DisplayVersion` 对照内部 `.mc`/`.osu` 的难度名，`IndexInFile` 作为版本信息缺失时的回退索引。
- Overlay 转换 `.mc` 为页面所需的 `.osu` 输入；Key 模式保持 mania，Catch/Taiko 使用相应 osu! mode，其余 Malody 模式降级为可渲染的通用卡片输入。`.osu`、`.mc` 以及包含这些文件的 `.mcz`/`.zip`/`.osz` 已实现；独立 `.tja`、BMS 等尚未无损转换。
- SunnyRework/OsuSR 由随包 toolkit 计算，随包 portable Python 3.10 和 NumPy 2.2.6 提供运行环境；管理窗口不再暴露 Python 或算法目录路径，安装使用不依赖用户系统 Python。分析仅在选谱或 Mod/Turbo 状态改变后于伴侣进程启动一次；异常或超时时返回空参考值，不阻塞游戏线程。
- WebView2 Evergreen Runtime 是伴侣窗口依赖。安装器会自动补装缺失运行时；若用户跳过本安装器单独部署插件，则需要自行安装 WebView2 Runtime。

## Bot 插件目录与自动同步

- BepInEx 发布目录完整保留 `nonebot_plugin_rework/`，包括 Python 插件源码和 `tosu_plugin/` 前端。卡片 HTTP 服务只从 `nonebot_plugin_rework/tosu_plugin` 读取，不回退到旧的 `Card` 副本，避免游戏卡片和 Bot 卡片各自漂移。
- `malodyv_tools/overlay/Build-Release.ps1` 在 Bot 仓库工作树中执行时，会先调用 `scripts/Sync-BotPlugin.ps1`，将当前 `nonebot_plugin_rework/` 镜像到 BepInEx 子仓库；独立克隆没有上级 Bot 目录时，则使用子仓库内随版本控制提交的副本。镜像只排除运行时生成的 `__pycache__` 和 `.pyc`。
- Bot 仓库根目录的 `bepinex-bot-manifest.json` 由 `scripts/Update-BepInExBotManifest.ps1` 生成。目录哈希使用相对路径（UTF-8、斜杠分隔）与文件字节组成，按 Ordinal 路径排序，忽略 `__pycache__` 与 `.pyc`；发布脚本、同步器必须使用相同算法。
- 管理程序启动后先比较本地 Bot 目录哈希与 manifest。哈希不同时，只从固定的 `MCPsDE/nonebot-plugin-for-osumania4k` GitHub HTTPS 归档下载；会检查重定向主机、压缩与展开大小、条目数量、路径穿越和符号链接，再验证提取目录哈希。校验通过后在同一目录卷暂存并替换，失败保留旧目录；同步只操作 `nonebot_plugin_rework/`，不触碰 BepInEx 的其他插件。GitHub Raw TLS 不可用时会尝试可信镜像；所有远程清单都不可达时，只要随包目录哈希正确，就离线使用随包 Bot，不把 SSL 故障显示成阻断错误。
- BepInEx 游戏插件自身计算其程序集 SHA-256，并读取独立仓库 `manifest.json` 对照版本与哈希；不一致时通过本地管道通知管理窗口显示可关闭提示。伴侣程序另行检查自身 EXE 哈希。提示不阻止游戏或卡片继续使用。
- HTTPS 与 SHA-256 可发现传输损坏及归档/manifest 不一致，但 manifest 和归档来自同一 GitHub 账号，并非数字签名。如果仓库或账号被接管，攻击者可以同时替换内容与哈希；因此自动同步应限定信任固定个人仓库，并审阅提交。远程卡片 JavaScript 会在 WebView 中执行，这是卡片渲染本身所需的信任边界。
- 发布前运行 `scripts/Update-BepInExBotManifest.ps1` 更新 Bot 仓库 manifest；然后从 Bot 仓库构建 `malodyv_tools/overlay/Build-Release.ps1`，提交 overlay 仓库内随包的原始插件目录、插件 DLL 哈希 manifest 和宿主代码。不要用 `git pull` 替换运行目录，也不要删除 `BepInEx/plugins`。
- `BepInEx` 的生成缓存 `cache/chainloader_typeloader.dat` 可能保留旧扫描结果；更新插件后若日志仍显示 `0 assemblies discovered`，先把该生成文件移到备份名再启动，让 Chainloader 重建缓存，不要删除其他插件。

## 验证边界

- 安装器、伴侣窗口和 IL2CPP 插件源码均已本机编译；安装器 EXE、framework-dependent 伴侣程序与插件 DLL 随发布生成。
- 当前部署保留了旧 Overlay 子目录和生成缓存的带时间戳备份，新的 DLL 位于 `BepInEx/plugins/MalodyV.ReworkOverlay.Plugin.dll`，伴侣程序位于 `BepInEx/plugins/MalodyVReworkOverlay`；部署前后未改变现有 `MalodyVThemeLoader` 文件。当前 BepInEx `6.0.0-be.785` 未被安装器覆盖。
- 2026-10-20 构建游戏插件、self-contained 伴侣、BepInEx 安装器工程均通过，0 warning / 0 error；8 项 Node 测试及 8 项 Python 测试（另 7 个子测试）通过。portable Python 3.10.20 + NumPy 2.2.6 对真实 `.osu` 谱面完成 SunnyRework/OsuSR 冒烟（自定义 1.2x 速度）；冒烟首次发现 toolkit parser 依赖 `nonebot.log`，现由 `ReferenceMetrics.py` 提供无操作 logger shim，算法不依赖用户安装 NoneBot。发布 DLL、Host 与 `manifest.json` 哈希一致；当前发布包随包 Bot 目录 SHA-256 为 `97C9B017...1D97`。
- 同日仅在隔离测试目录运行 `MalodyV-BepInEx-Installer-1.0.3.exe`，没有替换真实 BepInEx；测试确认旧运行时和 Doorstop 被清理、现有 `BepInEx/plugins` 文件哈希保持不变。测试脚本曾把安装器成功文本和退出码混入函数返回值，误报首次安装失败，现已只返回进程退出码；Doorstop 断言也改为检查旧内容被替换而不是路径消失。
- 未为本轮回归启动游戏，避免节奏游玩期间产生额外 CPU/IO 负担；因此 IL2CPP 运行时 Hook、Mod/Turbo 切换与结算显隐仍待下次正常进入大厅/房间时观察。游戏侧只在选谱、Mod/Turbo 面板关闭、房间配置和场景事件时处理，不做逐帧/定时轮询；伴侣分析在独立进程执行。

## 2026-10-20 Mod/Turbo 与窗口回归

- 旧版本通过“第一个浮点字段”猜 Turbo 速度，在 IL2CPP 混淆类型下可能读到无关值，日志曾出现 `14.27x`；游戏源码中的 `CustomJudgeProfile.audioSpeed` 合法范围是 `0.5–2.0`。现改为按 `audioSpeed` 名称读取字段或属性，并拒绝超范围值，避免异常值污染后续谱面分析。
- 预览状态必须读取 `PlayInfo.Local.Mod`。`ModForPlay` 只在进入游玩时经过 `Validate()`，并会移除 Rush/Dash/Slow；若用它做大厅预览，Mod 切换会落后一拍或丢失倍速。面板关闭与房间配置事件在状态提交后通过一次延迟主线程刷新触发，不使用轮询。
- 分析签名现在包含有效 Mod、倍速、模式、随机种子和 Turbo 标量字段；关闭 Mod/Turbo 后从原始谱面重新加载，缓存不会继续复用已转换谱面。读取状态不可靠时清理旧卡片，不能把旧结果当成当前结果。
- 卡片 WebView 之前有 `18px` body padding、主卡片半透明白边和右下三斜线握把，导致拖动/缩放区域跑到可见卡片外。现已移除 padding、主卡片外层 border/伪元素边框和握把；窗口边缘 `12px` 优先进行八方向缩放，其余区域按住拖动。
- 管理窗口改为半透明渐变玻璃层、透明控件面和高对比文字；玻璃效果只作用于背景/边框，不对文字施加模糊，避免设置窗口难以阅读。
- 本轮启动验证确认插件 `1.3.2`、伴侣窗口和 BepInEx 加载正常。仍需在大厅和联机房间实际切换一次 Turbo/Mod，检查日志中的 `speed=` 与卡片签名随状态变化；不能在游玩中做部署或高负载诊断。

## 2026-10-20 启动同步与 Turbo 读取故障

- 伴侣启动曾等待 GitHub 清单/归档同步后才启动本地卡片 HTTP 服务和命名管道；远程请求慢或失败会延迟游戏选谱消息接收。现调整为先用随包卡片启动本地服务，再做远程同步；仅当随包卡片入口缺失时才等待远程恢复。
- 当前远程 Bot 清单请求返回 HTTP 200，随包 `nonebot_plugin_rework` 哈希与清单 `D072B4778817635C4091CBEFD3000C404F5C5AADA619844720436FB2C6A2D6D1` 一致，故同步失败不是本地卡片目录内容不一致。伴侣运行期间仍需观察其具体网络异常消息。
- 当前 BepInEx 日志证明大厅选谱 Hook 已调用，但 Turbo 倍速成员读取失败后原逻辑清空了卡片。倍速读取现在优先使用游戏 `PlayInfo.PlaySpeed`，其次只读命名为 `audioSpeed` 的成员；严禁将 `catchSpeed`（下落流速）当成音频倍速。两者皆不可用时只以中性 `1.0x` 继续显示，并记录一次运行时成员诊断，不清空当前谱面。
- 当前游戏及伴侣进程仍运行中；源码可以编译验证，但部署 DLL/伴侣文件必须等两进程退出后再做，避免运行时文件覆盖或额外风险。
- 实际启动确认远程清单请求成功但归档校验报 SHA-256 不匹配：清单为 `D072...`，GitHub ZIP 内目录为 `97C9...`。160 个路径完全一致，差异来自 Windows 工作副本的混合换行与 GitHub ZIP 的 LF 文本换行。目录哈希现对 `.css/.html/.js/.json/.mjs/.py/.txt` 规范为 LF，二进制仍按原字节校验；Bot 与 overlay 两个清单生成脚本需同步使用同一算法。

## 维护约束

- `Emiria` 仅作只读参考。
- overlay 在谱面身份或 `PlayInfo.Local` 的有效分析 Mod/Turbo 状态事件变化时重算；禁止逐帧或定时轮询游戏状态。
- 管理窗口与游戏顶层卡片窗口由 companion 程序提供；继续复用现有 HTML/CSS/JS 页面。
- 若需支持 `.tja`、BMS 等额外格式，必须先按 `IndexInFile` 解析对应难度并转换，不能把不同模式的 notes 合并。

## 2026-10-20 远程 Bot 同步哈希排序故障

- 部署 `1.3.11` 后，管理窗实际启动仍提示 `Remote bot card archive failed SHA-256 verification`。远程清单、GitHub ZIP 和已部署目录的规范哈希均为 `97C9B017...`，但伴侣程序算出的 Windows 本地哈希为 `8A3F1DD8...`。
- 根因是同步器先按 Windows 原生反斜杠路径排序，再把路径改为 `/` 后参与哈希；manifest 生成器则先统一成 `/` 再排序，顺序不同会造成同一批文件哈希不一致。修复为排序前先统一相对路径分隔符；验证后 Windows、本地、ZIP 与 manifest 均得到 `97C9B017...`。
- 这类错误会使每次启动都尝试下载归档并误报同步失败，即使文件内容完全相同；以后目录哈希实现必须对排序键和哈希路径使用同一种规范化路径。
- `1.3.12` 部署后独立启动管理窗，状态显示“Bot 卡片目录与远程版本一致”；远程 overlay manifest 的 host/plugin SHA-256 与部署文件一致。验证时游戏保持关闭。

## 2026-10-20 Turbo 与编辑器实时预览

- Turbo 面板的 `OnDisable` 会先把新配置写入 Intent，再由调用方提交到 `PlayInfo.Local`。Postfix 立即读取会有时序竞态；现在通过 Unity `Invoke` 延迟 150ms 后读取，不做 Update/协程轮询。启用 Turbo 时只取 `customJudge.audioSpeed`，范围外回退中性 `1.0x`，不得覆盖成 Rush/Dash/Slow；Turbo 不存在时才按 Rush `1.5x`、Dash `1.2x`、Slow `0.8x` 处理，且绝不读取 Catch 的 `catchSpeed`。
- 编辑器当前谱面不能从磁盘源文件获得，因为未保存的改动只在 `EditChartManager` 中。`EditChartManager.Save()` 会覆盖谱文件并写回数据库元信息，禁止为了分析调用；预览改为从 manager 当前 notes/timing 构建内存 `.mc` JSON，经 IPC 交给 companion 转换分析，不写临时谱文件。
- `EditChartManager` 与 `CommandManager` 所在程序集/类型在游戏启动阶段尚未加载；不要在 BepInEx `Load()` 中提前解析它们。应先 Hook 已加载的 `SceneEditor.Start`，从该场景实例取得 chart/command manager 后再安装 `CommandManager.JustDoIt(CommandBase,bool)` Hook。
- 编辑器变更 Hook 限定 `CommandBaseNote` 子类及音符命令类型，可覆盖新增、删除、修改以及撤销/重做；时间线、音效等非音符命令不触发更新。高频音符命令由 Unity 主线程一次性延迟 250ms 合并，避免逐操作启动分析，也不轮询。
- 插件项目使用 C# 10，不能使用 C# 11 list pattern 查找 Hook 签名；反射查找参数需要显式检查数量和类型。编辑器 manager 创建时只做一次初始预览，之后只在音符命令事件更新，退出编辑器后回退到当前选谱状态。
- Turbo 音乐速度修改需要在大厅和联机房间均验证：观察面板关闭后 `speed=` 与卡片分析签名更新，并确认没有将流速误读为音乐速度。编辑器验证需检查未保存的增删、移动、长条修改和撤销/重做都能更新，而纯 UI/时间轴操作不会触发分析。

## 2026-10-20 调度、Turbo 与缩放故障修复

- 运行日志证实 `RefreshScheduler.ScheduleChartRefresh()` 在 `UnityEngine.MonoBehaviour.CancelInvoke(String)` 触发 IL2CPP `NullReferenceException`，导致 Mod/Turbo Harmony 回调中断。移除注入的 MonoBehaviour 调度器；改用可重置的一次性 `System.Threading.Timer` 做事件合并，再通过捕获的 Unity `SynchronizationContext.Post` 回主线程读取游戏状态。Timer 线程不访问 Unity 对象，主线程没有逐帧或固定间隔的谱面/Mod 轮询。
- Turbo 错读根因是只扫描 PlayInfo 属性并用“含 audioSpeed 成员”模糊挑选，运行时误选到 `Malody.Chart.iqy`，真正的 `customJudge` 是 PlayInfo 字段。现在优先按 `CustomJudgeProfile` 类型解析字段/属性并缓存其 `audioSpeed` 成员；Turbo 优先于 Rush/Dash/Slow，严格不读取 Catch 的 `catchSpeed`。`PanelJudge.OnDisable` 后仍延迟 150ms 读取，使面板结果有时间提交给 `PlayInfo.Local`。
- 编辑器 Hook 失败根因是从 manager 实例模糊枚举方法，并在取不到命令管理器时错误回退到 chart manager。现在通过 `SceneEditor.GetCommandManager()` 或其 `commandManager` 字段取得真实实例，并从已加载游戏程序集精确定位 `Malody.Edit.Command.CommandManager.JustDoIt(CommandBase, bool)`。初始快照和音符命令（含撤销/重做）使用一次性去抖；时间轴/界面操作不触发，分析读取编辑器内存数据，不调用 `Save()`。
- Overlay 边缘与角落缩放统一锁定卡片 `515:610` 比例：横边/竖边都会联动调整宽高，角落按拖动较明显的轴决定尺度；对边/角作为锚点。WebView 内固定基准布局整体 CSS 等比缩放，避免只改变容器后内容重排。管理窗使用明确的 Segoe UI 字体、较大的辅助字号和提高后的青色系文字对比。
- 当前实现构建版本为 `1.3.5`；部署后的游戏日志仍需检查精确 Hook 安装、Mod/Turbo 实际切换和编辑器音符变更。游戏实际游玩期间不进行诊断性轮询或高负载检查。

## 2026-10-21 算法边界与难度曲线修复

- `sunnyAlgorithm.js` 在丢弃首个音符后，对单音符/极短谱面、空有效区间、非有限 `DAll`、零权重、零分母等路径增加有限零结果保护；真正的解析失败仍返回原有错误码。图形输出同步保证时间和值数组不含 `NaN` 或 `Infinity`。
- Fixed Density LN 图之前只把固定 100ms 采样点和全谱首尾放入时间轴，倍速后部分长条释放点落在采样点之间，导致活动 LN 分数看起来像累计量。现在时间轴保留每个音符的起止事件，并用统一的浮点时间键匹配事件；LN 曲线会在释放后回落，显示局部瞬时值。
- RC/LN 图左侧由单个最高值标签改为五级动态刻度，同时增加对应的网格线；刻度根据当前图表最高值更新，不增加分析开销。
- Bot 版本更新为 `1.1.2`，Overlay 更新为 `1.3.14`。本轮 Node 测试共 12 项全部通过；当前环境没有安装 `pytest`，Python 测试可用 `python -m unittest discover -s tests -p "test*.py"` 执行。
- 新 Overlay 发布包的 Bot 目录 SHA-256 为 `41F1F954...2BC54B1`；发布 DLL 与宿主哈希已写入 `malodyv_tools/overlay/manifest.json`，发布脚本校验随包目录和源码目录一致。
- 后续发现 LN 曲线在高密度长条图中仍会因离散按住/松手事件出现高频尖峰，视觉上变成厚带并遮挡 RC。现在直接复用 RC 的 `180ms` 局部平均窗口平滑 LN 序列，并将 LN SVG 线宽降为 `1.5`，保留局部趋势但避免反复抖动形成实心区域。该修复发布为 Bot `1.1.3`、Overlay `1.3.15`。

## 2026-10-21 非 4K Sunny 曲线与平滑窗口

- RC/LN Fixed Density 曲线的局部平均窗口从 `180ms` 调整为 `260ms`，RC 包络和 LN 线使用同一窗口，进一步压低短时间内的上下抖动，同时保留较长难度峰值。
- 仅对 `Mode:3` 且 `CircleSize != 4` 的谱面启用 SunnyRework 分支。卡片继续使用统一的封面背景规则，左上双值框改为 `SunnyRework` 和 `OsuSR`，数值来自当前速率下的 SunnyRework 与官方 mania SR 参考计算；4K 仍使用 RC/LN Fixed Density，其他游戏模式仍遵循原有非 mania 显示逻辑。
- 非 4K mania 的曲线直接来自 SunnyRework 的 `graph.times`/`graph.values`，不会把 Sunny 曲线误当成 RC/LN，也不会显示 LN 包络填充。图例会切换为单独的 `SunnyRework`，4K 返回时恢复 `RC`/`LN`。
- 缓存键升级为 `profile-caption-v4-sunny-profile`，避免旧缓存把 4K RC/LN 或旧的空曲线复用到 5K 等谱面。
- Bot 更新为 `1.1.4`，Overlay 更新为 `1.3.16`；发布前应重新生成 Bot 目录清单和 Overlay manifest，并运行全部 Node 回归测试。
