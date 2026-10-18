"""nonebot-plugin-rework：osu!mania 4K Rework 谱面分析卡片。"""

from nonebot.plugin import PluginMetadata

from .config import Config

__version__ = "1.0.0"

__plugin_meta__ = PluginMetadata(
    name="Rework 谱面分析",
    description="发送 /rework，生成 ManiaMapAnalyser 风格的 4K mania 谱面分析卡片。",
    usage=(
        "/rework <谱面ID>\n"
        "/rework bid<谱面ID> / b<ID>\n"
        "/rework sid<谱包ID> / s<ID>\n"
        "/rework <osu! 谱面 / 谱包链接>\n"
        "回复 .osu / .osz / .mc / .mcz / .zip 后发送 /rework"
    ),
    type="application",
    config=Config,
    supported_adapters={"~onebot.v11"},
)

from . import handler as handler  # noqa: E402,F401
