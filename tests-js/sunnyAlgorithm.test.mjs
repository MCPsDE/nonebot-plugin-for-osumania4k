import test from "node:test";
import assert from "node:assert/strict";
import { calculate } from "../nonebot_plugin_rework/tosu_plugin/js/rework/sunnyAlgorithm.js";

const HEADER = [
    "osu file format v14",
    "[General]",
    "Mode:3",
    "[Difficulty]",
    "CircleSize:4",
    "OverallDifficulty:8",
    "[TimingPoints]",
    "0,500,4,2,1,50,1,0",
    "[HitObjects]",
];

function makeBeatmap(objects) {
    return [...HEADER, ...objects].join("\n");
}

function assertFiniteResult(result) {
    assert.equal(typeof result, "object");
    assert.ok(Number.isFinite(result.star));
    assert.ok(Number.isFinite(result.lnRatio));
    assert.ok(Number.isFinite(result.columnCount));
    assert.ok(result.graph.times.every(Number.isFinite));
    assert.ok(result.graph.values.every(Number.isFinite));
}

test("Sunny returns a finite zero result for a one-note map", () => {
    const result = calculate(
        makeBeatmap(["64,192,1000,1,0,0:0:0:0:"]),
        1,
        null,
        null,
        { withGraph: true },
    );

    assertFiniteResult(result);
    assert.equal(result.star, 0);
});

test("Sunny stays finite across short LN maps, speed rates, and conversions", () => {
    const map = makeBeatmap([
        "64,192,1000,128,0,1800:0:0:0:",
        "192,192,1500,1,0,0:0:0:0:",
        "320,192,2200,1,0,0:0:0:0:",
    ]);

    for (const speedRate of [0.8, 1, 1.2, 1.5, 2]) {
        for (const cvtFlag of [null, "IN", "HO", "INHO"]) {
            assertFiniteResult(calculate(map, speedRate, null, cvtFlag, { withGraph: true }));
        }
    }
});

test("Sunny returns finite graph values for same-time and sparse notes", () => {
    const map = makeBeatmap([
        "64,192,1000,1,0,0:0:0:0:",
        "192,192,1000,1,0,0:0:0:0:",
        "320,192,2600,1,0,0:0:0:0:",
    ]);

    assertFiniteResult(calculate(map, 1.2, null, null, { withGraph: true }));
});
