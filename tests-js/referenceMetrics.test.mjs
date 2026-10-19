import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
    new URL("../nonebot_plugin_rework/tosu_plugin/js/app/referenceMetrics.js", import.meta.url),
    "utf8",
);
const pureSource = source.slice(source.indexOf("function parseMetric"), source.indexOf("export async function fetchReferenceMetrics"));
const sourceUrl = `data:text/javascript;base64,${Buffer.from(pureSource).toString("base64")}`;
const { normalizeReferenceMetrics } = await import(sourceUrl);

test("missing sibling metrics stay unavailable instead of becoming zero", () => {
    assert.deepEqual(normalizeReferenceMetrics({
        sunnyRework: null,
        sunnyEstDiff: null,
        osuSr: null,
    }), {
        sunnyRework: null,
        sunnyEstDiff: null,
        osuSr: null,
    });
});

test("numeric sibling metrics and tier text are preserved", () => {
    assert.deepEqual(normalizeReferenceMetrics({
        sunnyRework: 7.03,
        sunnyEstDiff: "Cloverwisp Delta",
        osuSr: 6.59,
    }), {
        sunnyRework: 7.03,
        sunnyEstDiff: "Cloverwisp Delta",
        osuSr: 6.59,
    });
});
