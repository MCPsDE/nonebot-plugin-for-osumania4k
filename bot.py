"""NoneBot2 启动入口。

    python bot.py
"""

from __future__ import annotations

import nonebot
from nonebot.adapters.onebot.v11 import Adapter


def main() -> None:
    nonebot.init()
    nonebot.get_driver().register_adapter(Adapter)
    nonebot.load_plugin("nonebot_plugin_rework")
    nonebot.run()


if __name__ == "__main__":
    main()
