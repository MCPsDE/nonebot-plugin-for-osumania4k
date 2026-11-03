// 难度-进度图：把 RC / LN 通道的逐物件赋值序列画成「难度 vs 谱面进度」两张小图。
// - y 轴用赋值原始值（线性），上方数据稀疏、下方密集；
// - 折线每段颜色 = 该物件 value 在左侧 value 胶囊上的自动背景色；
// - 整数 value 水平标注线：只取上方稀疏区的一部分，左侧标注该 value 的段位名；
// - 游玩时叠加一根竖直线表示当前游戏进度（tosu 实时时间）。
import { APP_CONFIG, mainCardEl, state } from "./appContext.js";
import { starColorFor } from "./display.js";
import { fixedDensityRcLabel, fixedDensityLnLabel, fixedDensityDanTickLabel } from "../fixedDensity/index.js";
import { getInterpolatedPlaybackTime } from "./graph.js";

const VB_W = 492;
const VB_H = 104;
const PAD_L = 34;
const PAD_R = 4;
const PAD_T = 6;
const PAD_B = 8;
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;
const MAX_BUCKETS = 360;
const TICK_MIN_GAP_PX = 10;
const SVG_NS = "http://www.w3.org/2000/svg";

const CHART_CFG = APP_CONFIG.fixedDensityCharts || {};
const TICKS_ABOVE = Number.isFinite(CHART_CFG.ticksAbove) ? CHART_CFG.ticksAbove : 4;
const TICKS_BELOW = Number.isFinite(CHART_CFG.ticksBelow) ? CHART_CFG.ticksBelow : 8;
const TICK_LINE_GAP = Number.isFinite(CHART_CFG.minTickLineGapPx) ? CHART_CFG.minTickLineGapPx : 4;
const TICK_LABEL_GAP = Number.isFinite(CHART_CFG.minTickLabelGapPx) ? CHART_CFG.minTickLabelGapPx : 7;
const MAX_TICK_LABELS = Number.isFinite(CHART_CFG.maxTickLabels) ? CHART_CFG.maxTickLabels : 10;

const charts = { rc: null, ln: null };
let rafId = 0;
let gradientSeq = 0;

function valueColor(value) {
    const v = Number(value);
    const star = Number.isFinite(v) ? (v < 5 ? 1 : 1 + (v - 5) * 0.5) : 1;
    return starColorFor(star);
}

// 深色（高段位接近纯黑）的标注线/文字在深色背景上不可读：标签文字统一向白色提亮。
function lighten(hex, amount) {
    const h = String(hex).replace("#", "");
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const mix = (c) => Math.round(c + (255 - c) * amount);
    const toHex = (c) => c.toString(16).padStart(2, "0");
    return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            el.setAttribute(key, String(value));
        }
    }
    return el;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * Math.max(0, Math.min(1, p));
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function buildChartData(sequence, ticks, labelFn, width = VB_W, anchor = null) {
    if (!sequence || !Array.isArray(sequence.times) || sequence.times.length < 2) {
        return null;
    }
    const plotW = width - PAD_L - PAD_R;
    const times = sequence.times;
    const raws = sequence.raw;
    const values = sequence.value;
    const n = times.length;
    if (!Array.isArray(raws) || raws.length !== n) return null;

    const order = new Array(n);
    for (let i = 0; i < n; i += 1) order[i] = i;
    order.sort((a, b) => times[a] - times[b]);

    const t0 = times[order[0]];
    const t1 = times[order[n - 1]];
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 - t0 < 1e-6) {
        return null;
    }

    const rawSorted = new Float64Array(n);
    for (let i = 0; i < n; i += 1) rawSorted[i] = raws[i];
    rawSorted.sort();
    const p995 = percentile(rawSorted, 0.995);
    // 纵轴上限取三者最大值：平滑后曲线 p99.5、未平滑 p99.5 提示（保持轴稳定）、
    // 以及锚线以上 3%（避免平滑压低峰值后锚线被挤出画面）。
    const anchorValue = Number(anchor?.value);
    const anchorRaw = Number(anchor?.raw);
    const yMaxHint = Number(sequence.yMax);
    const yMax = Math.max(
        p995 > 0 ? p995 * 1.08 : 0,
        Number.isFinite(yMaxHint) && yMaxHint > 0 ? yMaxHint : 0,
        Number.isFinite(anchorRaw) && anchorRaw > 0 ? anchorRaw * 1.03 : 0,
        1e-6,
    );

    const timeSpan = t1 - t0;
    const buckets = Math.max(2, Math.min(MAX_BUCKETS, n));
    const isSmoothed = sequence.smoothed === true;
    const bucketRaw = new Float64Array(buckets).fill(-Infinity);
    const bucketSum = new Float64Array(buckets).fill(0);
    const bucketCnt = new Int32Array(buckets).fill(0);
    const bucketIdx = new Int32Array(buckets).fill(-1);
    for (let k = 0; k < n; k += 1) {
        const i = order[k];
        const raw = Number(raws[i]);
        if (!Number.isFinite(raw)) continue;
        const b = Math.min(buckets - 1, Math.max(0, Math.floor(((times[i] - t0) / timeSpan) * (buckets - 1))));
        if (isSmoothed) {
            // 已经平滑过的曲线：桶内取均值，避免峰值重新变尖
            bucketSum[b] += raw;
            bucketCnt[b] += 1;
        } else if (raw > bucketRaw[b]) {
            bucketRaw[b] = raw;
        }
        if (bucketIdx[b] < 0) bucketIdx[b] = i;
    }

    const xs = [];
    const ys = [];
    const rawOut = [];
    for (let b = 0; b < buckets; b += 1) {
        const i = bucketIdx[b];
        if (i < 0) continue;
        const raw = Math.max(0, isSmoothed
            ? (bucketCnt[b] > 0 ? bucketSum[b] / bucketCnt[b] : 0)
            : bucketRaw[b]);
        xs.push(PAD_L + ((times[i] - t0) / timeSpan) * plotW);
        ys.push(PAD_T + PLOT_H * (1 - Math.min(raw, yMax) / yMax));
        rawOut.push(raw);
    }
    if (xs.length < 2) return null;

    // 整谱 value 锚线（与左侧胶囊同值）：y 位置由序列的 75% 分位平移后的标定决定，
    // 使图上数值与胶囊值严格对应；整数刻度只画到锚线以下，避免出现远高于胶囊的数值。
    const hasAnchor = Number.isFinite(anchorValue) && Number.isFinite(anchorRaw)
        && anchorRaw > 0 && anchorRaw <= yMax;
    const anchorData = hasAnchor
        ? {
            raw: anchorRaw,
            y: PAD_T + PLOT_H * (1 - anchorRaw / yMax),
            label: String(anchor.label || ""),
            color: lighten(valueColor(anchorValue), 0.45),
            labelColor: lighten(valueColor(anchorValue), 0.75),
        }
        : null;

    // raw → value 的单调映射（用整数刻度 + 锚点，按 ln(raw) 分段线性），
    // 供「按线所在高度着色」使用：颜色只取决于 y，而不是线段末端取值。
    const mapPoints = [];
    for (const tick of ticks || []) {
        const tv = Number(tick.value);
        const tr = Number(tick.raw);
        if (Number.isFinite(tv) && Number.isFinite(tr) && tr > 0) {
            mapPoints.push({ v: tv, r: Math.log(tr) });
        }
    }
    if (hasAnchor) {
        mapPoints.push({ v: anchorValue, r: Math.log(anchorRaw) });
    }
    mapPoints.sort((a, b) => a.r - b.r);
    const valueAtRaw = (raw) => {
        if (!(raw > 0) || mapPoints.length === 0) return Number.NaN;
        const lr = Math.log(raw);
        if (mapPoints.length === 1) return mapPoints[0].v;
        if (lr <= mapPoints[0].r) {
            const a = mapPoints[0];
            const b = mapPoints[1];
            return a.v + ((lr - a.r) / (b.r - a.r || 1)) * (b.v - a.v);
        }
        const last = mapPoints.length - 1;
        if (lr >= mapPoints[last].r) {
            const a = mapPoints[last - 1];
            const b = mapPoints[last];
            return a.v + ((lr - a.r) / (b.r - a.r || 1)) * (b.v - a.v);
        }
        for (let i = 1; i < mapPoints.length; i += 1) {
            const a = mapPoints[i - 1];
            const b = mapPoints[i];
            if (lr <= b.r) {
                const t = (lr - a.r) / (b.r - a.r || 1);
                return a.v + t * (b.v - a.v);
            }
        }
        return mapPoints[last].v;
    };

    const segmentColors = [];
    for (let i = 1; i < rawOut.length; i += 1) {
        const midRaw = (rawOut[i - 1] + rawOut[i]) * 0.5;
        segmentColors.push(valueColor(valueAtRaw(midRaw)));
    }

    // 沿线颜色用「竖向线性渐变」实现：颜色只由 y（即 height→value）决定，
    // 因此折线在任意位置的色相随高度连续变化，陡峭突变处也不会被切成
    // 一段一段不同颜色的折线段（不再有颜色撕裂）。
    let gradientStops = null;
    if (mapPoints.length > 0) {
        gradientStops = [];
        const GRADIENT_STEPS = 64;
        for (let i = 0; i <= GRADIENT_STEPS; i += 1) {
            const t = i / GRADIENT_STEPS;
            const raw = Math.max(yMax * (1 - t), yMax * 0.0001);
            gradientStops.push({ offset: t, color: valueColor(valueAtRaw(raw)) });
        }
    }

    // 整数 value 标注线：锚线以下按高度自适应，尽量多画线；标签只给不重叠的一部分。
    const maxTickValue = Number.isFinite(anchorValue) ? Math.floor(anchorValue) + TICKS_ABOVE : Infinity;
    const minTickValue = Number.isFinite(anchorValue) ? Math.max(0, Math.floor(anchorValue) - TICKS_BELOW) : -Infinity;
    const tickAll = [];
    const seenTickLabels = new Set();
    const tickMinRaw = yMax * 0.01;
    for (const tick of ticks || []) {
        const tv = Number(tick.value);
        if (Number.isFinite(maxTickValue) && tv > maxTickValue) continue;
        if (Number.isFinite(minTickValue) && tv < minTickValue) continue;
        if (Number.isFinite(anchorValue) && tv === Math.round(anchorValue)) continue;
        const raw = Number(tick.raw);
        if (!Number.isFinite(raw) || raw <= 0 || raw > yMax || raw < tickMinRaw) continue;
        const y = PAD_T + PLOT_H * (1 - raw / yMax);
        const label = labelFn ? labelFn(tv) : "";
        if (!label) continue;
        // 段位名标签（6K/7K）是分档的：相邻刻度值可能落在同一段位，重复标签只保留最上面一个。
        if (seenTickLabels.has(label)) continue;
        seenTickLabels.add(label);
        const color = valueColor(tv);
        tickAll.push({ y, label, color: lighten(color, 0.35), labelColor: lighten(color, 0.6) });
    }
    tickAll.sort((a, b) => a.y - b.y);

    const tickLines = [];
    let lastLineY = -Infinity;
    for (const tick of tickAll) {
        if (tick.y < PAD_T + 1 || tick.y > PAD_T + PLOT_H - 1) continue;
        if (tick.y - lastLineY < TICK_LINE_GAP) continue;
        tickLines.push(tick);
        lastLineY = tick.y;
    }

    const tickLabels = [];
    let lastLabelY = -Infinity;
    for (const tick of tickLines) {
        if (tickLabels.length >= MAX_TICK_LABELS) break;
        if (tick.y - lastLabelY < TICK_LABEL_GAP) continue;
        if (anchorData && Math.abs(tick.y - anchorData.y) < 6) continue;
        tickLabels.push(tick);
        lastLabelY = tick.y;
    }

    return {
        t0,
        t1,
        xs,
        ys,
        segmentColors,
        gradientStops,
        tickLines,
        tickLabels,
        anchor: anchorData,
        width,
        plotW,
    };
}

function drawChart(svg, data) {
    if (!svg) return;
    const width = data.width || VB_W;
    svg.setAttribute("viewBox", `0 0 ${width} ${VB_H}`);
    while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
    }

    for (const tick of data.tickLines || []) {
        svg.appendChild(svgEl("line", {
            x1: PAD_L, x2: width - PAD_R, y1: tick.y, y2: tick.y,
            class: "fd-assign-tick", stroke: tick.color,
        }));
    }
    for (const tick of data.tickLabels || []) {
        const label = svgEl("text", {
            x: PAD_L - 2, y: tick.y + 2.2, class: "fd-assign-tick-label",
            fill: tick.labelColor || tick.color, "text-anchor": "end",
        });
        label.textContent = tick.label;
        svg.appendChild(label);
    }

    if (data.anchor) {
        svg.appendChild(svgEl("line", {
            x1: PAD_L, x2: width - PAD_R, y1: data.anchor.y, y2: data.anchor.y,
            class: "fd-assign-anchor", stroke: data.anchor.color,
        }));
        const anchorLabel = svgEl("text", {
            x: PAD_L - 2, y: data.anchor.y + 2.2, class: "fd-assign-anchor-label",
            fill: data.anchor.labelColor, "text-anchor": "end",
        });
        anchorLabel.textContent = data.anchor.label;
        svg.appendChild(anchorLabel);
    }

    // 折线路径：整条线一个 path，颜色交给竖向渐变，保证颜色随高度连续过渡。
    const pathParts = [];
    for (let i = 0; i < data.xs.length; i += 1) {
        pathParts.push(`${i === 0 ? "M" : "L"} ${data.xs[i].toFixed(2)} ${data.ys[i].toFixed(2)}`);
    }
    const linePath = pathParts.join(" ");

    // 先铺一层浅色描边（光晕），让深色 value（高段位，胶囊背景接近纯黑）也能看清
    const haloGroup = svgEl("g", { class: "fd-assign-halo" });
    haloGroup.appendChild(svgEl("path", { d: linePath }));
    svg.appendChild(haloGroup);

    if (Array.isArray(data.gradientStops) && data.gradientStops.length > 1) {
        const gradientId = `fd-assign-grad-${gradientSeq += 1}`;
        const defs = svgEl("defs", {});
        const gradient = svgEl("linearGradient", {
            id: gradientId,
            gradientUnits: "userSpaceOnUse",
            x1: 0,
            y1: PAD_T,
            x2: 0,
            y2: PAD_T + PLOT_H,
        });
        for (const stop of data.gradientStops) {
            gradient.appendChild(svgEl("stop", {
                offset: stop.offset.toFixed(4),
                "stop-color": stop.color,
            }));
        }
        defs.appendChild(gradient);
        svg.appendChild(defs);
        svg.appendChild(svgEl("path", {
            d: linePath,
            class: "fd-assign-seg",
            stroke: `url(#${gradientId})`,
        }));
    } else {
        const lineGroup = svgEl("g", {});
        for (let i = 1; i < data.xs.length; i += 1) {
            lineGroup.appendChild(svgEl("path", {
                d: `M ${data.xs[i - 1].toFixed(2)} ${data.ys[i - 1].toFixed(2)} L ${data.xs[i].toFixed(2)} ${data.ys[i].toFixed(2)}`,
                class: "fd-assign-seg",
                stroke: data.segmentColors[i - 1] || "#a6e0ff",
            }));
        }
        svg.appendChild(lineGroup);
    }

    const cursor = svgEl("line", {
        x1: 0, x2: 0, y1: PAD_T, y2: PAD_T + PLOT_H,
        class: "fd-assign-cursor",
    });
    cursor.style.display = "none";
    svg.appendChild(cursor);
    data.cursor = cursor;
}

export function updateAssignmentCursors() {
    const time = getInterpolatedPlaybackTime();
    const playing = state.isInPlayState && Number.isFinite(time);
    for (const key of ["rc", "ln"]) {
        const chart = charts[key];
        if (!chart || !chart.cursor) continue;
        if (!playing) {
            chart.cursor.style.display = "none";
            continue;
        }
        const t = Math.max(chart.t0, Math.min(time, chart.t1));
        const x = PAD_L + ((t - chart.t0) / (chart.t1 - chart.t0)) * (chart.plotW || PLOT_W);
        chart.cursor.setAttribute("x1", x.toFixed(2));
        chart.cursor.setAttribute("x2", x.toFixed(2));
        chart.cursor.style.display = "";
    }
}

function startAnimationLoop() {
    if (rafId) return;
    const tick = () => {
        updateAssignmentCursors();
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
}

function stopAnimationLoop() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }
}

export function hideAssignmentCharts() {
    const wrap = document.getElementById("fd-assign-charts");
    if (wrap) wrap.hidden = true;
    charts.rc = null;
    charts.ln = null;
    stopAnimationLoop();
    if (mainCardEl) mainCardEl.classList.remove("fd-charts");
}

export function renderAssignmentCharts(data) {
    const wrap = document.getElementById("fd-assign-charts");
    if (!wrap) return;
    if (!data) {
        hideAssignmentCharts();
        return;
    }
    const rcWrap = document.getElementById("fd-assign-rc");
    const lnWrap = document.getElementById("fd-assign-ln");
    const rcSvg = document.getElementById("fd-assign-rc-svg");
    const lnSvg = document.getElementById("fd-assign-ln-svg");

    const lnSeq = data.ln;
    // 序列里现在混有「非 LN 物件 = 0」的补点，因此用真实 LN 事件数判断是否显示 LN 图。
    const lnEventCount = Number(lnSeq?.eventCount);
    const lnSampleCount = Array.isArray(lnSeq?.times) ? lnSeq.times.length : 0;
    // 事件数够但难度本身≈0 的谱面（例如 18th Dan：LN% 0.5%、lnValue≈7e-8）
    // 画出来只会是一条贴着底部的 ln0 直线，白占一块卡片高度，直接隐藏。
    const lnAnchorValue = Number(data.lnAnchor?.value);
    const hasLnLevel = !Number.isFinite(lnAnchorValue) || lnAnchorValue >= 0.5;
    const hasLn = hasLnLevel && Boolean(lnSeq && (Number.isFinite(lnEventCount) ? lnEventCount : lnSampleCount) >= 8);
    const keyCount = Number(data.keyCount);
    const hasDanTier = Boolean(fixedDensityDanTickLabel(0, keyCount));
    const rcLabelFn = (v) => (hasDanTier ? fixedDensityDanTickLabel(v, keyCount) : fixedDensityRcLabel(v, keyCount));
    const rcData = buildChartData(data.rc, data.rcTicks, rcLabelFn, VB_W, data.rcAnchor);
    const lnLabelFn = (v) => (hasDanTier ? fixedDensityDanTickLabel(v, keyCount) : fixedDensityLnLabel(v, keyCount));
    const lnData = hasLn
        ? buildChartData(lnSeq, data.lnTicks, lnLabelFn, VB_W, data.lnAnchor)
        : null;
    if (!rcData && !lnData) {
        hideAssignmentCharts();
        return;
    }

    charts.rc = rcData;
    charts.ln = lnData;
    if (rcWrap) rcWrap.hidden = !rcData;
    if (lnWrap) lnWrap.hidden = !lnData;
    if (rcData) drawChart(rcSvg, rcData);
    if (lnData) drawChart(lnSvg, lnData);
    wrap.classList.toggle("single", !rcData || !lnData);
    wrap.hidden = false;
    if (mainCardEl) mainCardEl.classList.add("fd-charts");
    startAnimationLoop();
    updateAssignmentCursors();
}
