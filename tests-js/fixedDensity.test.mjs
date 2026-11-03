import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    calculateFixedDensity, fixedDensityRcLabel, fixedDensityLnLabel,
} from "../nonebot_plugin_rework/tosu_plugin/js/fixedDensity/index.js";
import { OsuFileParser } from "../nonebot_plugin_rework/tosu_plugin/js/parser/osuFileParser.js";
import { makeManiaBeatmap } from "./fixtures/maniaBeatmap.mjs";

const { cases } = JSON.parse(await readFile(
    new URL("./fixtures/fixedDensity-beta_1.0.7.json", import.meta.url), "utf8",
));

test("Fixed Density matches frozen upstream beta_1.0.7 values", () => {
    for (const expected of cases) {
        const { pattern, rate, cvtFlag, keys = 4 } = expected;
        const actual = calculateFixedDensity(makeManiaBeatmap({ pattern, keys }), rate, { cvtFlag });
        const context = `${keys}K ${pattern} ${rate}x ${cvtFlag || "NM"}`;
        assert.ok(Math.abs(actual.rcValue - expected.rcValue) < 1e-10, `RC ${context}`);
        assert.ok(Math.abs(actual.lnValue - expected.lnValue) < 1e-10, `LN ${context}`);
    }
});

test("6K/7K values use upstream dan names for both channels", () => {
    assert.equal(fixedDensityRcLabel(12, 6), "Mystery");
    assert.equal(fixedDensityLnLabel(12, 6), "Mystery");
    assert.equal(fixedDensityRcLabel(12, 7), "Azimuth");
    assert.equal(fixedDensityLnLabel(12, 7), "Azimuth");
});

test("conversion leaves the shared parser unchanged and exports finite, ordered chart samples", () => {
    const parser = new OsuFileParser(makeManiaBeatmap());
    parser.process();
    const before = structuredClone(parser.getParsedData());
    for (const cvtFlag of [null, "IN", "HO", "INHO"]) {
        const result = calculateFixedDensity(parser, 1.2, { cvtFlag });
        assert.deepEqual(parser.getParsedData(), before);
        for (const sequence of [result.rcSequence, result.lnSequence]) {
            // HO strips every hold; upstream returns an empty LN sequence.
            assert.ok(sequence === result.lnSequence && cvtFlag?.includes("HO")
                ? sequence.times.length === 0 : sequence.times.length >= 2);
            assert.equal(sequence.times.length, sequence.raw.length);
            assert.equal(sequence.times.length, sequence.value.length);
            assert.ok(sequence.times.every((time, index) =>
                Number.isFinite(time) && (index === 0 || time > sequence.times[index - 1])));
            assert.ok(sequence.raw.every(Number.isFinite));
            assert.ok(sequence.value.every(Number.isFinite));
            assert.equal(sequence.smoothed, true);
        }
        assert.equal(result.rcAnchor.value, result.rcValue);
        assert.equal(result.lnAnchor.value, result.lnValue);
    }
});
