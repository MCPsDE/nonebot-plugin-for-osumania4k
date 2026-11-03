import test from "node:test";
import assert from "node:assert/strict";
import { runAnalysisPipeline } from "../nonebot_plugin_rework/tosu_plugin/js/pipeline/runAnalysisPipeline.js";
import { calculateFixedDensity } from "../nonebot_plugin_rework/tosu_plugin/js/fixedDensity/index.js";
import { createResultCache } from "../nonebot_plugin_rework/tosu_plugin/js/app/resultCache.js";
import { makeManiaBeatmap } from "./fixtures/maniaBeatmap.mjs";

function assertClose(actual, expected, path = "result") {
    if (typeof expected === "number") {
        // Upstream's Newton inverse warm-starts from the last call, with 1e-13 tolerance.
        assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), path);
    } else if (expected && typeof expected === "object") {
        assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
        for (const key of Object.keys(expected)) assertClose(actual[key], expected[key], `${path}.${key}`);
    } else {
        assert.equal(actual, expected, path);
    }
}

function makeBeatmap({ mode, keys = null, objects = null }) {
    const lines = [
        "osu file format v14",
        "[General]",
        `Mode:${mode}`,
        "[Metadata]",
        "Title:Mode fixture",
        "[Difficulty]",
    ];
    if (keys !== null) {
        lines.push(`CircleSize:${keys}`, "OverallDifficulty:8");
    }
    lines.push("[TimingPoints]", "0,500,4,2,1,50,1,0", "[HitObjects]");
    lines.push(...(objects || [
        "64,192,1000,1,0,0:0:0:0:",
        "192,192,1500,1,0,0:0:0:0:",
    ]));
    return lines.join("\n");
}

test("non-mania maps return card metadata without running mania estimators", async () => {
    const result = await runAnalysisPipeline({
        rawText: makeBeatmap({ mode: 0 }),
        estimatorAlgorithm: "Sunny",
        options: { withFixedDensity: true, withProfileGraph: true },
    });

    assert.equal(result.parsedSummary.gameMode, "0");
    assert.equal(result.parsedSummary.objectCount, 2);
    assert.equal(result.actualEstimatorAlgorithm, "Unsupported mode");
    assert.equal(result.profileGraph, null);
    assert.equal(Number.isFinite(result.fixedDensityValue), false);
    assert.deepEqual(result.errors, []);
});

test("5K mania maps use SunnyRework profile data without Fixed Density", async () => {
    const result = await runAnalysisPipeline({
        rawText: makeBeatmap({ mode: 3, keys: 5 }),
        estimatorAlgorithm: "Sunny",
        options: { withFixedDensity: true, withProfileGraph: true },
    });

    assert.equal(result.parsedSummary.gameMode, "3");
    assert.equal(result.parsedSummary.columnCount, 5);
    assert.equal(result.parsedSummary.objectCount, 2);
    assert.equal(result.profileGraph?.source, "SunnyRework");
    assert.ok(result.profileGraph.times.length >= 2);
    assert.equal(result.profileGraph.times.length, result.profileGraph.values.length);
    assert.ok(result.profileGraph.values.every(Number.isFinite));
    assert.equal(Number.isFinite(result.fixedDensityValue), false);
    assert.deepEqual(result.errors, []);
});

for (const keys of [4, 6, 7]) {
    test(`${keys}K charts and capsule values use upstream assignment data across rates and conversions`, async () => {
        const rawText = makeManiaBeatmap({ keys });
        for (const speedRate of [0.75, 1, 1.5]) {
            for (const cvtFlag of [null, "IN", "HO", "INHO"]) {
                const options = { withFixedDensity: true, withProfileGraph: true, speedRate, cvtFlag };
                const result = await runAnalysisPipeline({ rawText, estimatorAlgorithm: "Sunny", options });
                const upstream = calculateFixedDensity(rawText, speedRate, { cvtFlag });
                assertClose(result.fixedDensityValue, upstream.rcValue);
                assertClose(result.fixedDensityLnValue, upstream.lnValue);
                assertClose(result.profileGraph, {
                    source: "FixedDensity", keyCount: keys,
                    rc: upstream.rcSequence, ln: upstream.lnSequence,
                    rcTicks: upstream.rcTicks, lnTicks: upstream.lnTicks,
                    rcAnchor: Number.isFinite(upstream.rcAnchor?.raw) ? upstream.rcAnchor : null,
                    lnAnchor: Number.isFinite(upstream.lnAnchor?.raw) ? upstream.lnAnchor : null,
                });
                const cache = createResultCache();
                cache.put("fixture", result);
                assert.deepEqual(cache.get("fixture").profileGraph, result.profileGraph);
                assert.deepEqual(JSON.parse(JSON.stringify(result.profileGraph)), result.profileGraph);
            }
        }
    });
}

test("other key counts keep Sunny curves without Fixed Density values", async () => {
    for (const keys of [1, 2, 3, 5, 9, 10, 18]) {
        const result = await runAnalysisPipeline({
            rawText: makeManiaBeatmap({ keys, pattern: keys === 10 ? "rc" : "mixed" }),
            estimatorAlgorithm: "Sunny",
            options: { withFixedDensity: true, withProfileGraph: true },
        });
        assert.equal(result.profileGraph.source, "SunnyRework", `${keys}K`);
        assert.ok(result.profileGraph.values.every(Number.isFinite), `${keys}K`);
        assert.equal(Number.isNaN(result.fixedDensityValue), true);
        assert.equal(Number.isNaN(result.fixedDensityLnValue), true);
    }
});
