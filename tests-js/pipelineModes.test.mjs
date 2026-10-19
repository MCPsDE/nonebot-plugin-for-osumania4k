import test from "node:test";
import assert from "node:assert/strict";
import { runAnalysisPipeline } from "../nonebot_plugin_rework/tosu_plugin/js/pipeline/runAnalysisPipeline.js";

function makeBeatmap({ mode, keys = null }) {
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
    lines.push(
        "[TimingPoints]",
        "0,500,4,2,1,50,1,0",
        "[HitObjects]",
        "64,192,1000,1,0,0:0:0:0:",
        "192,192,1500,1,0,0:0:0:0:",
    );
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

test("non-4K mania maps do not run Fixed Density calculations", async () => {
    const result = await runAnalysisPipeline({
        rawText: makeBeatmap({ mode: 3, keys: 5 }),
        estimatorAlgorithm: "Sunny",
        options: { withFixedDensity: true, withProfileGraph: true },
    });

    assert.equal(result.parsedSummary.gameMode, "3");
    assert.equal(result.parsedSummary.columnCount, 5);
    assert.equal(result.parsedSummary.objectCount, 2);
    assert.equal(result.profileGraph, null);
    assert.equal(Number.isFinite(result.fixedDensityValue), false);
    assert.deepEqual(result.errors, []);
});
