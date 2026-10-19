import unittest

from nonebot_plugin_rework.beatmap import parse_beatmap
from nonebot_plugin_rework.malody import convert_mc


def make_chart(*, mode: int = 0, keys: int = 5) -> dict:
    return {
        "meta": {
            "mode": mode,
            "mode_ext": {"column": keys},
            "song": {"title": "Five Key", "artist": "Test", "file": "audio.ogg"},
            "creator": "Test",
            "version": "5K fixture",
        },
        "time": [{"beat": [0, 0, 1], "bpm": 120, "signature": 4}],
        "note": [
            {"beat": [0, 0, 1], "column": 0},
            {"beat": [0, 1, 4], "column": 4, "endbeat": [0, 2, 4]},
        ],
    }


class MalodyKeyConversionTests(unittest.TestCase):
    def test_five_key_key_chart_converts_and_remains_card_eligible(self):
        chart = convert_mc(make_chart())

        self.assertTrue(chart.ok, chart.error)
        self.assertEqual(chart.key, 5)
        self.assertIn("CircleSize:5", chart.osu_text)
        self.assertIn("51,192,0,1,0,0:0:0:0:", chart.osu_text)
        self.assertIn("461,192,125,128,0,250:0:0:0:0:", chart.osu_text)

        info = parse_beatmap(chart.osu_text)
        self.assertTrue(info.ok, info.error)
        self.assertEqual(info.column_count, 5)

    def test_key_count_above_osu_mania_limit_is_rejected(self):
        chart = convert_mc(make_chart(keys=19))

        self.assertFalse(chart.ok)
        self.assertIn("最多支持 18K", chart.error)

    def test_non_key_malody_modes_remain_outside_key_conversion(self):
        chart = convert_mc(make_chart(mode=3))

        self.assertFalse(chart.ok)
        self.assertIn("不是 Malody 键模式", chart.error)


if __name__ == "__main__":
    unittest.main()
