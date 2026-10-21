import test from "node:test";
import assert from "node:assert/strict";
import { runAnalysisPipeline } from "../nonebot_plugin_rework/tosu_plugin/js/pipeline/runAnalysisPipeline.js";

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

test("non-4K mania maps use SunnyRework profile data without Fixed Density", async () => {
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

test("4K mania maps keep the Fixed Density RC/LN profile", async () => {
    const result = await runAnalysisPipeline({
        rawText: makeBeatmap({
            mode: 3,
            keys: 4,
            objects: Array.from({ length: 20 }, (_, index) =>
                `${64 + (index % 4) * 128},192,${1000 + index * 500},1,0,0:0:0:0:`),
        }),
        estimatorAlgorithm: "Sunny",
        options: { withProfileGraph: true },
    });

    assert.equal(result.profileGraph?.source, undefined);
    assert.ok(Array.isArray(result.profileGraph?.rcCenterValues));
    assert.ok(Array.isArray(result.profileGraph?.lnValues));
});
