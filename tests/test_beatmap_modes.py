import unittest
import nonebot

nonebot.init()
from nonebot_plugin_rework.beatmap import parse_beatmap
from nonebot_plugin_rework.service import parse_arguments


def osu_text(mode: int, circle_size: int | None = None) -> str:
    difficulty = f"[Difficulty]\nCircleSize:{circle_size}\n" if circle_size is not None else ""
    return (
        "osu file format v14\n"
        "[General]\n"
        f"Mode:{mode}\n"
        "[Metadata]\nTitle:Mode fixture\nArtist:Test\nVersion:Basic\n"
        f"{difficulty}"
        "[HitObjects]\n"
        "64,192,1000,1,0,0:0:0:0:\n"
    )


class BeatmapModeTests(unittest.TestCase):
    def test_all_osu_modes_are_accepted_for_card_rendering(self):
        for mode in range(4):
            with self.subTest(mode=mode):
                info = parse_beatmap(osu_text(mode, 4 if mode == 3 else None))
                self.assertTrue(info.ok, info.error)

    def test_non_four_key_mania_is_accepted(self):
        for keys in (5, 7, 9):
            with self.subTest(keys=keys):
                info = parse_beatmap(osu_text(3, keys))
                self.assertTrue(info.ok, info.error)
                self.assertEqual(info.column_count, keys)

    def test_mania_still_requires_circle_size(self):
        info = parse_beatmap(osu_text(3))
        self.assertFalse(info.ok)
        self.assertIn("CircleSize", info.error)

    def test_cid_and_speed_modifiers_parse(self):
        command = parse_arguments("cid123 +dt")

        self.assertEqual(command.kind, "cid")
        self.assertEqual(command.value, 123)
        self.assertEqual(command.speed_rate, 1.5)
        self.assertEqual(command.mods, ("DT",))

        command = parse_arguments("c456 +ht")

        self.assertEqual(command.kind, "cid")
        self.assertEqual(command.value, 456)
        self.assertEqual(command.speed_rate, 0.75)
        self.assertEqual(command.mods, ("HT",))

    def test_attached_modifiers_and_custom_speed_parse(self):
        command = parse_arguments("cid123+dt *2.5")

        self.assertEqual(command.kind, "cid")
        self.assertEqual(command.speed_rate, 2.5)
        self.assertEqual(command.mods, ("DT",))


if __name__ == "__main__":
    unittest.main()
