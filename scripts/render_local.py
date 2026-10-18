"""离线渲染脚本（不启动 QQ 机器人）。

    python scripts/render_local.py ..\\benchmark\\ln\\L4.8TS.osu --out sample.png
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# 直接运行 scripts/ 下的文件时，把仓库根目录加入导入路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 插件包的 __init__ 会注册 /rework2 处理器，需要先初始化 NoneBot
import nonebot

nonebot.init()

from nonebot_plugin_rework.beatmap import parse_beatmap
from nonebot_plugin_rework.config import AppConfig, Config, build_runtime_config
from nonebot_plugin_rework.errorcard import render_error_card
from nonebot_plugin_rework.osu_source import read_local_beatmap
from nonebot_plugin_rework.renderer import Renderer


async def render(source: str, out: str, cfg: AppConfig) -> int:
    beatmaps = read_local_beatmap(source)
    out_path = Path(out)

    renderer = Renderer(cfg.render)
    await renderer.start()
    exit_code = 0
    try:
        for index, beatmap in enumerate(beatmaps, 1):
            name = beatmap.display_name
            if beatmap.error:
                print(f"[{index}/{len(beatmaps)}] {name}: {beatmap.error}")
                png = render_error_card(beatmap.error, subtitle=name)
                exit_code = 2
            else:
                info = parse_beatmap(beatmap.text)
                name = info.display_name if (info.title or info.artist) else name
                if not info.ok:
                    print(f"[{index}/{len(beatmaps)}] {name}: {info.error}")
                    png = render_error_card(info.error or "无法分析该谱面。", subtitle=name)
                    exit_code = 2
                else:
                    print(f"[{index}/{len(beatmaps)}] 正在渲染 {name} …")
                    png = await renderer.render(beatmap.text, beatmap.background)

            if len(beatmaps) == 1 and out_path.suffix.lower() == ".png":
                destination = out_path
            else:
                destination = out_path / f"{Path(beatmap.filename).stem}.png"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(png)
            print(f"[{index}/{len(beatmaps)}] 已保存：{destination}")
    finally:
        await renderer.close()
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description="离线渲染 Rework 分析卡片")
    parser.add_argument("source", help=".osu / .osz / .mc / .mcz / .zip")
    parser.add_argument("--out", default="sample.png", help="输出 PNG 或目录")
    parser.add_argument("--port", type=int, help="覆盖本地静态服务端口")
    parser.add_argument("--browser-channel", help="覆盖浏览器 channel（如 msedge，留空用内置 Chromium）")
    args = parser.parse_args()

    config = Config()
    if args.port:
        config.rework_render_port = args.port
    if args.browser_channel is not None:
        config.rework_browser_channel = args.browser_channel
    cfg = build_runtime_config(config)
    return asyncio.run(render(args.source, args.out, cfg))


if __name__ == "__main__":
    sys.exit(main())
