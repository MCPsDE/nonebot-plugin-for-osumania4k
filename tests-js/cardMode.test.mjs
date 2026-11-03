import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourcePath = new URL("../nonebot_plugin_rework/tosu_plugin/js/app/cardMode.js", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const sourceUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { isFourKeyMania, isFixedDensityMania, resolveDifficultyText } = await import(sourceUrl);

test("4K classification excludes other key counts and game modes", () => {
    assert.equal(isFourKeyMania({ gameMode: "3", columnCount: 4 }), true);
    assert.equal(isFourKeyMania({ gameMode: "3", columnCount: 7 }), false);
    assert.equal(isFourKeyMania({ gameMode: "0", columnCount: 4 }), false);
});

test("Fixed Density values support 4K/6K/7K mania", () => {
    for (const columnCount of [4, 6, 7]) {
        assert.equal(isFixedDensityMania({ gameMode: "3", columnCount }), true);
        assert.equal(isFixedDensityMania({ gameMode: "0", columnCount }), false);
    }
    for (const columnCount of [1, 5, 9, 10, 18]) {
        assert.equal(isFixedDensityMania({ gameMode: "3", columnCount }), false);
    }
});

test("other modes use the sibling Sunny tier fallback", () => {
    assert.equal(resolveDifficultyText({
        supportsFixedDensity: false,
        srText: "Fixed Density v1",
        resolvedEstDiff: "Current plugin estimate",
        sunnyEstDiff: "Sunny tier",
    }), "Sunny tier");
});

test("4K Fixed Density keeps its RC and LN estimate", () => {
    assert.equal(resolveDifficultyText({
        supportsFixedDensity: true,
        srText: "Fixed Density v1",
        fixedDensityDifficultyText: "RC label\nLN label",
        resolvedEstDiff: "Legacy estimate",
        sunnyEstDiff: "Sibling estimate",
    }), "RC label\nLN label");
});

test("4K mania keeps the existing high-tier cap", () => {
    assert.equal(resolveDifficultyText({
        supportsFixedDensity: true,
        srText: "ReworkSR",
        resolvedNumericDifficulty: 19,
        resolvedEstDiff: "Old tier || LN tier",
    }), "> Cloverwisp Theta high|| LN tier");
});
