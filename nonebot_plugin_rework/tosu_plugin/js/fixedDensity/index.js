// js/fixedDensity/index.js
// Fixed Density beta_1.0.5（含 LN 参考难度）— osu!mania 难度计算。
//
// 本副本在 Fixed Density v1 基础上加入：
//   * no-chord 调参后的 RC 参数（E=0，映射曲线重新拟合）；
//   * 双手合并层 cross-hand 权重（γ=0，当前关闭）；
//   * 单手两轨左右不均时间衰减序列 + 弱侧门控；
//   * 12.5+ 映射段加点/移点；
//   * 其余 RC/LN 逻辑与 v1 相同。
//
// 关于「被参数取消的逻辑」（不实现）：
//   * soft_beta > 0 ⇒ 合并算子为 softmax 加权平均 w·a+(1−w)·b；
//     RC 通道的 Lp 范数分支与 merge_power / merge2_power / contrib_power 不参与。
//   * cross_lane_mix = 0 ⇒ 贡献间距仅取同轨间距，跨轨混合逻辑不参与。
//   * irr_local_gain = 0、irr_gain_pair = 0 ⇒ 全谱熵@贡献层、轨道对熵@配对合并层不参与。
//   * ln_gain = 0 ⇒ LN 通道（松手流 / 控手 / 按住占用）关闭，n_LN 不参与 n。
//   * 拟合模型 C（irr 系数）= 0、E（chord 系数）= 0；LN 倍率的 γ_cross = 0。
//
// DT/HT/可调变速：所有物件时间戳按 1/rate 缩放后再参与计算（rate=1.5 为 DT、0.75 为 HT，
// lazer 任意正速同理）。
//
// 模块约束：DOM-free / state-free，Node 与浏览器一致。

import { OsuFileParser } from "../parser/osuFileParser.js";
import { APP_CONFIG } from "../../config.js";

// 难度-进度图的全局标定（可在 config.js 的 fixedDensityCharts 中调整）
const CHART_CFG = (APP_CONFIG && APP_CONFIG.fixedDensityCharts) || {};
const CHART_ANCHOR_Q_RC = Number.isFinite(CHART_CFG.anchorQuantileRc) ? CHART_CFG.anchorQuantileRc : 0.75;
const CHART_ANCHOR_Q_LN = Number.isFinite(CHART_CFG.anchorQuantileLn) ? CHART_CFG.anchorQuantileLn : 0.88;
// 锚点标定模式：
// - "mean"（默认）：平滑曲线的加权均值对齐胶囊值，曲线围绕锚线，不会被窗口均值拉低；
// - "quantile"：旧行为，把逐物件 value 的 anchorQuantile* 分位平移到胶囊值。
const CHART_ANCHOR_MODE = CHART_CFG.anchorMode === "quantile" ? "quantile" : "mean";
// 曲线平滑：默认 400ms 平均窗口、每 100ms 采样（config.js → fixedDensityCharts 可调）
const CHART_SMOOTH_WINDOW_MS = Number.isFinite(CHART_CFG.smoothWindowMs) ? CHART_CFG.smoothWindowMs : 400;
const CHART_SMOOTH_STEP_MS = Number.isFinite(CHART_CFG.smoothStepMs) ? CHART_CFG.smoothStepMs : 100;
// LN 曲线单独用更大的窗口：LN 取样点稀疏、赋值本身波动大，400ms 时曲线起伏过陡；
// 默认 1000ms 窗口（步长仍 100ms），让 LN 曲线更接近「段落平均」而不是瞬时尖刺。
const CHART_LN_SMOOTH_WINDOW_MS = Number.isFinite(CHART_CFG.lnSmoothWindowMs) ? CHART_CFG.lnSmoothWindowMs : 1000;
const CHART_LN_SMOOTH_STEP_MS = Number.isFinite(CHART_CFG.lnSmoothStepMs) ? CHART_CFG.lnSmoothStepMs : CHART_SMOOTH_STEP_MS;

const TIME_EPS = 1e-6;
const INV_DIST_SCALE = 1000.0; // 相邻物件间距倒数缩放：1000 / dt
const OVERLAP_PENALTY = 20000.0; // 同轨同时间戳重叠物件的额外惩罚
const N_PRECISION = 1e-12; // n 值二分精度
const TYPE_HOLD = 1 << 7; // osu!mania 长条类型位

// ---- beta_1.0.5 冻结参数（weakgate_smallweight RC + beta_1.0.3 的 LN 重标定基线）----
const HALF_LIFE_MS = 306.625;
const QUANTILE = 0.94012709;
const EXTRA_RATE = 1.7044655999999996;
const EXTRA_B = 2.337995528948387;
const EXTRA_LOG_BASE = 4.012384;
const SOFT_BETA = 0.346887; // > 0 ⇒ softmax 加权平均（Lp 范数分支不参与）
const IRR_GAIN_LANE = 0.1; // 单轨局部熵 @ 贡献层
const IRR_GAIN_GLOBAL = -0.06; // 全谱局部熵 @ 最终合并层
const IRR_GAIN_CROSS = 0.0; // 当前全量调参关闭 cross-hand
const IRR_CROSS_SCALE = 1.0; // s = 1 − exp(−(c_bar−1)/scale)
const IRR_CROSS_ALPHA = 2.5; // c_eff = max(L,R) + α·min(L,R)
const IRR_CROSS_DENSITY = 2.48; // s *= (1 − f_bar)^density
const IRR_CROSS_WINDOW = 16; // 与 irr 同窗口

// 单手两轨左右不均时间衰减序列 + 弱侧门控
const HAND_IMB_ETA = 0.4;
const HAND_IMB_TAU_MS = 60.0;
const HAND_IMB_M0 = 1.875;
const HAND_IMB_NPS0 = 3.05;
const HAND_IMB_HALF_LIFE_MS = 5000.0; // weakgate_smallweight：4350 → 5000
const HAND_IMB_EPS = 1e-6;
const WEAK_GATE_Q0 = 1.5625;
const WEAK_GATE_IMB_B = 0.35;
const WEAK_GATE_IMB_S = 0.0825;

const LOG_BASE_DENOM = Math.log(EXTRA_LOG_BASE);
const HALF_BETA = 0.5 * SOFT_BETA;
const HAND_NORM_P = 2.0; // 6K 手内合并层：12/23 两条配对序列的 2-范数合并阶数
const HAND_NORM_SCALE = 1.0; // 6K 手内合并层幅值系数（全量调参项，初值 = 1）

// ---- 连续映射曲线（beta_1.0.5 = weakgate_smallweight：7.3 / 9.2 衔接点；末段归一化斜率 0.85）----
const MAP_KNOTS = [
    [0.3, 1.6], [2.45, 1.6], [3.85, 0.9], [4.5, 2.0],
    [7.3, 2.0], [9.2, 1.0], [12.05, 0.9], [12.6, 0.6], [14.2, 0.8], [15.6, 1.0],
];
const MAP_COEF = [
    2.409901630718964,
    0.2499999999999991,
    0.04,
    0.518,
    0.4187,
    0.04,
    0.04,
    0.0783,
    0.04,
    0.1567,
    0.2574,
    0.1596,
    -0.039566345789796765,
];
const MAP_LEAD = 1 + MAP_KNOTS.length + 1; // c + σ_0..σ_K 的个数
const FIT_E_CHORD = 0.0; // no-chord：E=0
const FIT_D_LNN = MAP_COEF[MAP_LEAD]; // ln N 系数（index 12）
// ---- RC v8 结构特征修正层（b1.0.6）----
// g = ln(n) - E*chord - D*lnN + C0 + Σ κ_i·f_i，rc = mapInvert(g)。
// f_i 全部由 lane 时间序列连续计算（无 clip / 无分段），对时长归一。
// 11 个基础特征 + 18 个交互项；κ 全为 0 时等于 b1.0.5.1 基线。
// 标定：RC benchmark 非 LN RMSE 0.597（b1.0.5.1 为 0.448）；
// 合成排列 Q1≈4.9 / Q7≈9.0 / Q8≈11.0，倍速 1.25/1.5/2.0 单调。
// 拟合：_analysis/tune_rc_v8e.py；快照：_analysis/_rc_v8e_wb1.0_wa3.0.json。
const RC_V8_C0 = 0.0;
const RC_V8_TERMS = [
    ["f_both", +1.430392], // 双手同时有键的行速率
    ["f_alt", +0.121555], // 相邻行活跃手切换速率
    ["f_osc", +0.855048], // 手内押数振荡（2121 型 > 0）
    ["f_lanealt", -0.004791], // 手内单键换轨速率
    ["f_jack", +0.418118], // 手内单键同轨（纵连）速率
    ["f_dbl", -0.304301], // 手内双押手行速率
    ["f_bal", -0.514058], // 手间平衡度 2·min/(sum)（单手=0）
    ["f_chord", +0.382890], // 平均每排押数
    ["f_notes", -0.146715], // 总音符速率
    ["f_handmax", -0.370800], // 较密那只手的音符速率
    ["f_bothrow", -0.197292], // 双手同押行占比
    ["ix_both_lanealt", -0.342213], // f_both·f_lanealt
    ["ix_both_bothrow", +1.231120], // f_both·f_bothrow
    ["ix_both_osc", -0.087058], // f_both·f_osc
    ["ix_both_bal", -1.494768], // f_both·f_bal
    ["ix_bal_notes", +0.448173], // f_bal·f_notes
    ["ix_jack_notes", -0.047902], // f_jack·f_notes
    ["ix_jack_hmax", -0.256083], // f_jack·f_handmax
    ["ix_dbl_hmax", +0.365751], // f_dbl·f_handmax
    ["ix_chord_notes", -0.152579], // f_chord·f_notes
    ["ix_hmax_chord", +0.001507], // f_handmax·f_chord
    ["ix_osc_notes", -0.226425], // f_osc·f_notes
    ["ix_lanealt_notes", +0.080601], // f_lanealt·f_notes
    ["ix_notes_bothrow", -0.319042], // f_notes·f_bothrow
    ["ix_jack_chord", -0.191479], // f_jack·f_chord
    ["ix_jack_osc", +1.313499], // f_jack·f_osc
    ["ix_lanealt_jack", -0.261515], // f_lanealt·f_jack
    ["ix_dbl_chord", +0.156590], // f_dbl·f_chord
    ["ix_both_notes", +0.091087], // f_both·f_notes
];
// ---- b1.0.5.1：6K RC 专用映射层（仅 kTotal===6 时启用；4K 仍使用上面的 MAP_KNOTS/MAP_COEF）----
// 与 4K 同构的连续斜率曲线 g(v) = c + Σ σ_j·w_j(v)，σ_j ≥ 0 ⇒ 单调。
// 参数按 44 首 6K RC 基准在 value 空间最小二乘拟合（留一档交叉验证选节点数）：
//   指数基线 M2 RMSE=0.7518 → 本映射层 RMSE=0.3735，R²=0.9860；留一档 CV RMSE=0.4930。
// 复现：_analysis6k/fit_rc_map.py；参数快照：_analysis6k/rc6_map_fit.json。
const MAP6_KNOTS = [
    [1.3, 0.9],
    [3.0, 0.9],
    [4.8, 0.9],
    [6.8, 0.9],
];
const MAP6_COEF = [
    2.5840038159493437,
    0.1679002721878934,
    0.3992381792027269,
    0.04000000000000001,
    0.10284031220804582,
    0.0878273291884741,
    -0.039566345789796765,
];

// ---- b1.0.6：7K RC 专用映射层（仅 kTotal===7；与 4K/6K 同构的连续斜率曲线）----
// 60 首 7K Dan RC 基准拟合：value 空间 RMSE=0.8954，R²=0.9571，留一档 CV RMSE={'layout': 'K3', 'loo_dan_rmse': 0.9603230202258823, 'candidates': [{'layout': 'K3', 'K': 3, 'rmse': 0.8953513876943069, 'cv': 0.9603230202258823, 'min_slope': 0.08627980559930505, 'coef': [2.7134457835966765, 0.252424344976386, 0.05174847111629122, 0.04000000000000001, 0.11396783657307301, -0.039566345789796765]}, {'layout': 'K4', 'K': 4, 'rmse': 0.889651421964562, 'cv': 0.9744665620168235, 'min_slope': 0.08704710562684582, 'coef': [2.70929319987703, 0.263086733280996, 0.04000000000000001, 0.13519944334793055, 0.04000000000000001, 0.11527273060705141, -0.039566345789796765]}, {'layout': 'K5', 'K': 5, 'rmse': 0.8843703762719594, 'cv': 0.9891810555581965, 'min_slope': 0.0739439411999284, 'coef': [2.7108475353074684, 0.2550457974796599, 0.04000000000000001, 0.2196950495157715, 0.04000000000000001, 0.04000000000000001, 0.11751850248117413, -0.039566345789796765]}, {'layout': 'K6', 'K': 6, 'rmse': 0.8806540421421409, 'cv': 0.9906357647634653, 'min_slope': 0.07564477193171282, 'coef': [2.6902440248818755, 0.30887424910871086, 0.04000000000000001, 0.04000000000000001, 0.23835371274909736, 0.04000000000000001, 0.04000000000000001, 0.1178696261405577, -0.039566345789796765]}, {'layout': 'K6n', 'K': 6, 'rmse': 0.8762140236944764, 'cv': 0.9938440086134521, 'min_slope': 0.06261091570011192, 'coef': [2.67222700460188, 0.3153424546266918, 0.04000000000000001, 0.04000000000000025, 0.24766169213519557, 0.04000000000000001, 0.04000000000000001, 0.11776128606828624, -0.039566345789796765]}, {'layout': 'K8', 'K': 8, 'rmse': 0.8771870811273467, 'cv': 1.031813421623775, 'min_slope': 0.07821419662823663, 'coef': [2.674244562852302, 0.3366374386764853, 0.04000000000000001, 0.04000000000000001, 0.26753059708611, 0.04000000000000001, 0.04000000000000001, 0.15659091978790815, 0.04000000000000001, 0.11878250917904475, -0.039566345789796765]}]}。
// 复现：_analysis7k/fit_rc_map.py（参数快照 _analysis7k/_rc7_map_v13.json）。
const MAP7_KNOTS = [
    [2.3, 0.8],
    [3.5, 0.8],
    [4.7, 0.8],
];
const MAP7_COEF = [
    2.7134457835966765,
    0.252424344976386,
    0.05174847111629122,
    0.04000000000000001,
    0.11396783657307301,
    -0.039566345789796765,
];

// 局部间隔多样性（irregularity）参数
const IRR_LOCAL_WINDOW = 16;
const IRR_LOCAL_STRIDE = 4;
const IRR_BANDWIDTH = 0.08;
const IRR_INV2H2 = 1.0 / (2.0 * IRR_BANDWIDTH * IRR_BANDWIDTH);
const IRR_LOG_DEN = Math.log(IRR_BANDWIDTH * Math.sqrt(2.0 * Math.PI));
const IRR_ENT_COEF = -0.5 * IRR_INV2H2;

// ---- ln 参考难度参数 ----
const LN_MULT_REL = 2.26321400; // γ_rel（v6d 光滑面缝折扣后全量调参）
const LN_MULT_JACK = 9.98250600; // γ_jack（v6d 全量调参）
const LN_MULT_CROSS = 1.88969303; // γ_cross（S_cross）
const LN_MULT_HOLD = 2.67786127; // γ_hold（S_hold）
const LN_MULT_ADJ = 0.54890200; // γ_adj（S_adj 头尾相邻性，v6d 全量调参）
const LN_MULT_EXP = 5.07395755;
const LN_MULT_RHO_C = 0.29415144;
const LN_MULT_RHO_LIN = 0.0; // 低 ρ 段线性 toe 权重
const LN_ABSORB_GAIN = 0.25; // 松手吸收折扣 λ
const ABSORB_DIST_SCALE = 0.5; // 吸收判定距离 = 该倍数 × 本地节拍
const LN_LEN_WEIGHT_GAIN = 1.0; // ln_len_weight_gain：长度权重增益
const LN_HOLD_REF_MS = 40.0; // ln_hold_ref_ms：长度因子 ℓ/(ℓ+ℓ₀) 的参考时长

// ---- LN 模型 v5：松手节奏均匀度折扣（均匀 LN 排列几乎不产生锁手/松手需求）----
// 逐轨取全部松手间隔的变异系数 CV = sd/mean；CV → 0（节拍完全均匀，如 Malody 转谱的
// 等间距面缝流）时需求整体保留 LN_UNI_FLOOR；CV ≥ LN_UNI_CV0 视为完全不均匀（不打折）。
// 折扣同时作用于 S_rel / S_jack / S_cross；S_hold（长条本身）不折扣。
const LN_UNI_CV0 = 0.45; // 视为“完全不均匀”的 CV 阈值
const LN_UNI_FLOOR = 0.08; // 完全均匀排列的保留比例
const LN_UNI_POWER = 0.7; // 折扣曲线指数
const LN_REL_W_MIN = 0.25; // 极短长条的长度权重下限（保留弱检出，避免 <ℓ_lo 直接归零）

// ---- LN 模型 v6：S_jack 50ms 归零门控 + S_adj 头尾相邻性 ----
// S_jack 响应：单一解析函数（无分段/无截断）
//   S_jack = w·h · sigmoid((G50 − g)/SLOPE)
// g = 同轨下一次按下 − 该松手（单位 ms）。g=G50 处为 0.5 的「半衰」参考点；g 越小越接近 1，
// 50ms 附近保留冗余量（≈0.1，不再硬归零），窄面缝（≤25ms）仍明显更高；函数 C∞ 连续、处处可导。
const LN_JACK_G50_MS = 28.0;
const LN_JACK_SLOPE_MS = 10.0;
// 面缝规整度折扣：松手→同轨下次按下的间隔接近 LN_SEAM_GAP_MS 的事件越多，整谱 LN 乘子越低（连续）
const LN_SEAM_DISCOUNT = 0.80;

// 光滑 ReLU / 光滑截断：softRelu(x)=0.5*(x+sqrt(x^2+eps))，softClip01(x)=softRelu(x)-softRelu(x-1)。
// 与 clip(x,0,1) 偏差 < 1e-2，但处处可导，避免分段。
const LN_SOFT_EPS = 1e-4;
function softRelu(x) {
    return 0.5 * (x + Math.sqrt(x * x + LN_SOFT_EPS));
}
function softClip01(x) {
    return softRelu(x) - softRelu(x - 1.0);
}
const LN_SEAM_GAP_MS = 50.0; // 高斯中心
const LN_SEAM_TOL_MS = 25.0; // 过渡宽度

// beta_1.0.5 对数标定（按 103 张 LN 基准重拟合；LN v5 口径 RMSE 0.8452，v4 口径 0.8440）
// v5 相对 v4：S_rel 由 L2 改为算术平均、长度因子 h 并入 w、新增均匀度折扣 → 重新标定 A/B。
// 指数映射：u = ln(1 + LN_B·k·n)；随后经 LN 连续斜率映射层（lnMapForward）映射到等级。
// v6e（2026-10-28）：指数映射后接与 RC 同构的连续斜率映射层（C¹、无 clip），取代幂次映射。
const LN_B = 0.016473560;
const LN_A = 1.0; // 兼容旧参数快照的占位常量；实际映射由 lnMapForward 承担
const LN_C = 1.0; // 兼容旧参数快照的占位常量；实际映射由 lnMapForward 承担

// ---- beta_1.0.5 LN 模型 v4：在临界间隙处锚定 + 无上限的二次/三次重叠曲线 ----
// 间隙 g = 「该长条起点之后的下一次同轨按下」 − 释手（允许 g<0，长条重叠）。
// 临界间隙 δ* = T_loc − W_od（可为负）；归一化坐标 x = (g − δ*)/W_od。
// g ≥ δ*（x ≥ 0）：S_jack = w·h·S_a/(1 + x)            —— 在 δ* 处锚定 S_jack = w·h·S_a
// g < δ*          ：u = −x
//                   S_jack = w·h·S_a·(1 + u + b2·u² + b3·u³)
// 两段在 x=0 处 C¹ 连续；负间隙为二次/三次多项式 → 无上限、无竖直渐近线，缓慢抬升。
// S_a 为可调参数（锚定值）：在 102 张 LN 基准上扫描，S_a=8.0 时变换后 RMSE 最小（0.8248）。
const LN_JACK_ANCHOR = 8.0; // 锚定值 S_a：临界间隙处的 S_jack = w·h·S_a
const LN_JACK_OVERLAP_B2 = 0.5; // 重叠段二次项系数（u²）
const LN_JACK_OVERLAP_B3 = 0.0; // 重叠段三次项系数（u³；0 = 纯二次）
const LN_AGG_QUANTILE = 0.75; // 四项 S 的聚合分位（与 RC 的 findNQuantile 同机制）
const LN_TLOC_B = 1.0; // 局部密度下界：exp(mean(ln(contrib+b))) − b 的 b
const LN_TLOC_WINDOW = 16; // 局部窗口内的 RC contribution 个数（与 irr 窗口一致）
const LN_TLOC_MIN_MS = 10.0;
const LN_TLOC_MAX_MS = 50.0; // T_loc 上界：50ms 以下（与 OD 判定窗同量级）
// 0 = 沿用 RC 的 n（标定口径）；1 = LN 通道用自家分位 n（实验：102 张基准 RMSE 会退化到 ~1.8）
const LN_OWN_N_MODE = 0;

// LN 头/尾判定窗与长度有效性门（OD 相关）
const LN_HEAD_WINDOW_A = 64.0; // 头判窗总宽 = A − B·OD（ms）
const LN_HEAD_WINDOW_B = 3.0;
const LN_TAIL_WINDOW_RATIO = 1.5; // 尾判窗宽 / 头判窗宽
const LN_MIN_HOLD_MS = 20.0; // 一次点击的物理最短时长补足
const LN_VALID_OD_GAIN = 0.4; // 有效性门 OD 项系数
const LN_VALID_RAMP = 1.3; // 有效性门过渡宽度系数

function lowerBound(arr, target) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function upperBound(arr, target) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

// 合并两个升序分组时间序列并去重，同时输出与并集时间对齐的两侧物件数。
function mergeGroupSizes(timesA, sizesA, timesB, sizesB) {
    const times = [];
    const countsA = [];
    const countsB = [];
    let i = 0;
    let j = 0;
    while (i < timesA.length && j < timesB.length) {
        const ta = timesA[i];
        const tb = timesB[j];
        if (ta < tb) {
            times.push(ta); countsA.push(sizesA[i]); countsB.push(0); i += 1;
        } else if (ta > tb) {
            times.push(tb); countsA.push(0); countsB.push(sizesB[j]); j += 1;
        } else {
            times.push(ta); countsA.push(sizesA[i]); countsB.push(sizesB[j]); i += 1; j += 1;
        }
    }
    while (i < timesA.length) { times.push(timesA[i]); countsA.push(sizesA[i]); countsB.push(0); i += 1; }
    while (j < timesB.length) { times.push(timesB[j]); countsA.push(0); countsB.push(sizesB[j]); j += 1; }
    return { times, countsA, countsB };
}

// 单轨按相同时间戳分组 → [{ t, size, prevDt, nextDt }]，按时间升序。
function groupLane(times) {
    const groups = [];
    let i = 0;
    while (i < times.length) {
        let j = i;
        while (j + 1 < times.length && Math.abs(times[j + 1] - times[i]) < TIME_EPS) {
            j += 1;
        }
        groups.push({ t: times[i], size: j - i + 1 });
        i = j + 1;
    }
    const result = [];
    for (let idx = 0; idx < groups.length; idx += 1) {
        const prevDt = idx > 0 ? groups[idx].t - groups[idx - 1].t : null;
        const nextDt = idx + 1 < groups.length ? groups[idx + 1].t - groups[idx].t : null;
        result.push({ t: groups[idx].t, size: groups[idx].size, prevDt, nextDt });
    }
    return result;
}

// 升序去重（容忍 TIME_EPS）。
function uniqueSorted(times) {
    const out = [];
    for (const t of times) {
        if (out.length === 0 || Math.abs(t - out[out.length - 1]) >= TIME_EPS) {
            out.push(t);
        }
    }
    return out;
}

// ---- RC v10 结构修正常数（连续核，全部无分段）----
const V11_EXTRA_SIGMA = 0.35;   // EXTRA 核宽度（相对局部间隔 a）
const V11_BOTH = 0.45;          // 双手同时活跃的协同加成（乘在 min(左,右) 上）
const V11_CHORD = 0.0;          // 合并行押数因子（0 = 关闭）
let RC11_KTOTAL = 4;
function v11Cfg(key, fallback) {
    const o = (typeof globalThis !== 'undefined') ? globalThis.__V11 : null;
    if (o && Number.isFinite(o[key])) return o[key];
    return fallback;
}

// 合并算子（soft_beta > 0）：softmax 加权平均（光滑的 max）。
//   w = ½(1+tanh(½β(a−b)))，M = w·a + (1−w)·b
function mergeOp(a, b) {
    const w = 0.5 * (1.0 + Math.tanh(HALF_BETA * (a - b)));
    return w * a + (1.0 - w) * b;
}

// 手内轨道布局：4K = 每手两轨；6K = 每手三轨（左手 0/1/2，右手 3/4/5）。
// 其它键数沿用 4K 的相邻配对规则（奇数键数时最后一手只有 1 轨）。
function handLayoutOf(kTotal) {
    if (kTotal === 6) {
        return [[0, 1, 2], [3, 4, 5]];
    }
    if (kTotal === 7) {
        return [[0, 1, 2], [3, 4, 5, 6]];
    }
    const hands = [];
    for (let s = 0; s < kTotal; s += 2) {
        hands.push(s + 1 < kTotal ? [s, s + 1] : [s]);
    }
    return hands;
}

// 每手内的“配对轨”下标（RC 邻域额外 contribution 的 mate）。
// 4K 为唯一同手轨道；6K 中轨/外轨都偏向内侧轨（rank0→rank1、rank1→rank0、rank2→rank1）。
function handMateOf(hand, rank) {
    if (hand.length < 2) {
        return hand[0];
    }
    if (rank === 1) {
        return hand[0];
    }
    if (rank === 0) {
        return hand[1];
    }
    return hand[hand.length - 2];
}

// 每轨“同手其它轨”的下标列表（4K 长度 1；6K 长度 2；奇数键数落单轨长度 0）。
function handOthersOf(kTotal) {
    const out = [];
    for (const hand of handLayoutOf(kTotal)) {
        for (const lane of hand) {
            out[lane] = hand.filter((j) => j !== lane);
        }
    }
    return out;
}

// LN 配对轨序列：把同手其它轨的音符合并成一条按时间升序的列（4K 即原来的相邻轨）。
function lnPartnerCol(lanes, mateLanes) {
    if (!mateLanes || mateLanes.length === 0) {
        return null;
    }
    const partner = [];
    for (const j of mateLanes) {
        for (const n of lanes[j]) {
            partner.push(n);
        }
    }
    partner.sort((a, b) => a.t - b.t);
    return partner;
}
// 逐组注入贡献：base = 单件 M(prev_inv, next_inv)；多件按“超限替代”累加；
// extra = Σ_{配对轨键, |x|∈[0,4a]} size·exp(−((log_base(x/a)+extra_b)²)/2)，a = 1000/base；
// contribution = base·(1 + extra_rate·extra)
function laneContribs(groups, mateTimes, mateSizes) {
    const n = groups.length;
    const contribs = new Float64Array(n);
    if (n === 0) {
        return contribs;
    }
    const penPen = mergeOp(OVERLAP_PENALTY, OVERLAP_PENALTY);
    for (let k = 0; k < n; k += 1) {
        const g = groups[k];
        const prevInv = (g.prevDt != null && g.prevDt > TIME_EPS) ? INV_DIST_SCALE / g.prevDt : 0.0;
        const nextInv = (g.nextDt != null && g.nextDt > TIME_EPS) ? INV_DIST_SCALE / g.nextDt : 0.0;
        let base = mergeOp(prevInv, nextInv);
        if (g.size > 1) {
            base = (g.size - 2) * penPen
                + mergeOp(prevInv, OVERLAP_PENALTY)
                + mergeOp(OVERLAP_PENALTY, nextInv);
        }

        let extra = 0.0;
        if (EXTRA_RATE !== 0.0 && base > 0.0 && mateTimes.length > 0) {
            const a = INV_DIST_SCALE / base;
            const lo = lowerBound(mateTimes, g.t - 4.0 * a);
            const hi = upperBound(mateTimes, g.t + 4.0 * a);
            if (hi > lo) {
                const constTerm = EXTRA_B - Math.log(a) / LOG_BASE_DENOM;
                let total = 0.0;
                for (let m = lo; m < hi; m += 1) {
                    const x = Math.abs(mateTimes[m] - g.t);
                    if (x <= TIME_EPS) {
                        continue;
                    }
                    const z = Math.log(x / a) / LOG_BASE_DENOM + EXTRA_B;
                    total += mateSizes[m] * Math.exp(-(z * z) * 0.5);
                }
                extra = total;
            }
        }
        contribs[k] = base * (1.0 + EXTRA_RATE * extra);
    }
    return contribs;
}

// 单轨衰减序列在 unionTimes 各时刻的取值（下标对齐）：value ← value·0.5^(dt/H) + contribution。
function laneCurve(groupTimes, contribs, unionTimes) {
    const out = new Float64Array(unionTimes.length);
    let value = 0.0;
    let gi = 0;
    let lastT = null;
    for (let ti = 0; ti < unionTimes.length; ti += 1) {
        const t = unionTimes[ti];
        if (lastT !== null) {
            value *= Math.pow(0.5, (t - lastT) / HALF_LIFE_MS);
        }
        while (gi < groupTimes.length && Math.abs(groupTimes[gi] - t) < TIME_EPS) {
            value += contribs[gi];
            gi += 1;
        }
        out[ti] = value;
        lastT = t;
    }
    return out;
}

// 把“赋值处有突变的时间衰减函数”在给定时刻采样（替换语义）。
function sampleDecay(seq, times) {
    const out = new Float64Array(times.length);
    let value = 0.0;
    let si = 0;
    let lastT = null;
    for (let ti = 0; ti < times.length; ti += 1) {
        const t = times[ti];
        if (lastT !== null) {
            value *= Math.pow(0.5, (t - lastT) / HALF_LIFE_MS);
        }
        while (si < seq.length && Math.abs(seq[si][0] - t) < TIME_EPS) {
            value = seq[si][1];
            si += 1;
        }
        out[ti] = value;
        lastT = t;
    }
    return out;
}

// 合并两条“赋值突变衰减”序列：时间戳并集上采样后逐时刻 softmax 合并。
function mergeDecaySequences(seqA, seqB) {
    if (seqA.length === 0) {
        return seqB;
    }
    if (seqB.length === 0) {
        return seqA;
    }
    const lenA = seqA.length;
    const lenB = seqB.length;
    const times = new Float64Array(lenA + lenB);
    const cntA = new Int32Array(lenA + lenB);
    const cntB = new Int32Array(lenA + lenB);
    let i = 0;
    let j = 0;
    let m = 0;
    while (i < lenA && j < lenB) {
        const ta = seqA[i][0];
        const tb = seqB[j][0];
        if (ta < tb) { times[m] = ta; cntA[m] = seqA[i][2]; i += 1; }
        else if (ta > tb) { times[m] = tb; cntB[m] = seqB[j][2]; j += 1; }
        else { times[m] = ta; cntA[m] = seqA[i][2]; cntB[m] = seqB[j][2]; i += 1; j += 1; }
        m += 1;
    }
    while (i < lenA) { times[m] = seqA[i][0]; cntA[m] = seqA[i][2]; i += 1; m += 1; }
    while (j < lenB) { times[m] = seqB[j][0]; cntB[m] = seqB[j][2]; j += 1; m += 1; }

    const unionTimes = times.subarray(0, m);
    const fa = sampleDecay(seqA, unionTimes);
    const fb = sampleDecay(seqB, unionTimes);
    const out = new Array(m);
    for (let k = 0; k < m; k += 1) {
        const c = cntA[k] + cntB[k];
        if (c <= 0) {
            continue;
        }
        const both = Math.min(fa[k], fb[k]);
        const bothOn = RC11_KTOTAL === 4 || RC11_KTOTAL === 6 || RC11_KTOTAL === 7;
        const bothW = bothOn ? v11Cfg("both", V11_BOTH) : 0.0;
        let value = mergeOp(fa[k], fb[k]) + bothW * both;
        const v11Chord = v11Cfg("chord", V11_CHORD);
        if (v11Chord !== 0.0 && c > 1) {
            value *= 1.0 + v11Chord * Math.log(c) / Math.LN2;
        }
        out[k] = [unionTimes[k], value, c];
    }
    return out;
}

// numpy 默认线性插值分位数。
function quantileLinear(sorted, q) {
    const n = sorted.length;
    if (n === 0) {
        return 0.0;
    }
    if (n === 1) {
        return sorted[0];
    }
    const pos = q * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) {
        return sorted[lo];
    }
    const frac = pos - lo;
    return sorted[lo] * (1.0 - frac) + sorted[hi] * frac;
}

// 加权均值（权重 <= 0 的哨兵物件不参与），用于把「平滑曲线均值」对齐到胶囊值。
function weightedMean(values, weights) {
    let sum = 0.0;
    let wsum = 0.0;
    for (let i = 0; i < values.length; i += 1) {
        const w = weights[i];
        if (Number.isFinite(values[i]) && Number.isFinite(w) && w > 0.0) {
            sum += values[i] * w;
            wsum += w;
        }
    }
    return wsum > 0.0 ? sum / wsum : Number.NaN;
}

// 纵轴上限提示：按未平滑的逐物件赋值取 p99.5 对应的 raw，再留 8% 余量，
// 避免平滑后峰值变矮导致锚线/刻度被挤出可视区域。
function sequenceYMaxHint(values, toRaw) {
    if (!values || values.length === 0 || typeof toRaw !== 'function') {
        return 0.0;
    }
    const sorted = Float64Array.from(values).sort();
    const q = quantileLinear(sorted, 0.995);
    const raw = toRaw(q);
    return Number.isFinite(raw) && raw > 0.0 ? raw * 1.08 : 0.0;
}

// 难度-进度曲线的平滑：在 [t−W/2, t+W/2) 窗口内对逐物件赋值做加权均值，
// 每 STEP 毫秒采样一次；窗口内没有合格物件时该采样点显示值直接为 0。
// 均值在「value 尺度」上计算，再经 toRaw 反算回原始值（y 轴仍是原始值）。
// windowMs/stepMs 可覆盖：RC 用默认 400ms，LN 用更大的 1000ms 窗口。
// toRaw 传 null 时只返回 times/value（用于先统计曲线分位、再决定锚点平移）。
function smoothAssignmentSequence(times, values, weights, tStart, tEnd, toRaw,
    windowMs = CHART_SMOOTH_WINDOW_MS, stepMs = CHART_SMOOTH_STEP_MS) {
    const n = times.length;
    const out = { times: [], value: [], raw: [], hasData: [] };
    if (n === 0) {
        return out;
    }
    const left = Math.max(tStart, times[0]);
    const right = Math.max(tEnd, times[n - 1]);
    const step = Math.max(stepMs, 1.0);
    const half = Math.max(windowMs, 0.0) * 0.5;
    const samples = Math.max(1, Math.floor((right - left) / step) + 1);
    const zeroRaw = toRaw ? toRaw(0.0) : 0.0;
    let lo = 0;
    let hi = 0;
    for (let s = 0; s < samples; s += 1) {
        const t = left + s * step;
        while (lo < n && times[lo] < t - half) {
            lo += 1;
        }
        while (hi < n && times[hi] <= t + half) {
            hi += 1;
        }
        let sum = 0.0;
        let wsum = 0.0;
        for (let i = lo; i < hi; i += 1) {
            const w = weights ? weights[i] : 1.0;
            if (!(w > 0.0)) {
                continue;
            }
            sum += values[i] * w;
            wsum += w;
        }
        const v = wsum > 0.0 ? sum / wsum : 0.0;
        out.times.push(t);
        out.value.push(v);
        out.hasData.push(wsum > 0.0);
        out.raw.push(toRaw ? (wsum > 0.0 ? toRaw(v) : zeroRaw) : 0.0);
    }
    return out;
}

// 求 n 使 mean(min(1, n/a_i)) == targetAvg（排序 + 1/a 前缀和 + 二分，分位数作上界初值）。
function findNQuantile(values, targetAvg) {
    const a = values instanceof Float64Array ? values : Float64Array.from(values);
    const n = a.length;
    if (n === 0) {
        throw new Error("赋值列表为空，无法计算 n");
    }
    if (targetAvg <= 0.0) {
        return 0.0;
    }
    a.sort();
    if (targetAvg >= 1.0) {
        return a[n - 1];
    }
    const prefixInv = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) {
        prefixInv[i + 1] = prefixInv[i] + (a[i] > 0.0 ? 1.0 / a[i] : 0.0);
    }
    const totalInv = prefixInv[n];
    const targetSum = targetAvg * n;
    const partialSum = (value) => {
        const k = upperBound(a, value);
        return k + value * (totalInv - prefixInv[k]);
    };
    let lo = 0.0;
    let hi = quantileLinear(a, targetAvg);
    if (!(hi > 0.0) || partialSum(hi) < targetSum) {
        hi = a[n - 1];
    }
    // 二分求解。注意：hi/lo 收敛到 1 ULP 后 (lo+hi)*0.5 会取整回端点而不再推进，
    // 此时 hi-lo ≈ ULP 可能仍大于绝对容差 N_PRECISION（大 n 值时 ULP ≈ 3.6e-12），
    // 仅按绝对容差判停会死循环（超高物量谱面即触发）。故加“无进展即停”保护 + 迭代上限。
    for (let iter = 0; iter < 200; iter += 1) {
        if (hi - lo <= N_PRECISION) {
            break;
        }
        const mid = (lo + hi) * 0.5;
        if (mid === lo || mid === hi) {
            break;
        }
        if (partialSum(mid) < targetSum) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) * 0.5;
}

function softplus(z) {
    if (z > 0.0) {
        return z + Math.log1p(Math.exp(-z));
    }
    return Math.log1p(Math.exp(z));
}

function sigmoid(z) {
    if (z > 0.0) {
        return 1.0 / (1.0 + Math.exp(-z));
    }
    const ez = Math.exp(z);
    return ez / (1.0 + ez);
}

// ---- 映射层 profile：4K 使用 beta_1.0.5 冻结曲线，6K 使用 b1.0.5.1 专用曲线 ----
// 结构相同：g(v) = c + Σ σ_j·w_j(v)，w 为 knots 处的 softplus 差分基，σ_j ≥ 0 时 g 单调递增。
// 缓冲随 profile 存放，避免每次调用新建数组；4K 的数值路径与此前逐位一致。
function makeMapProfile(knots, coef) {
    const K = knots.length;
    return {
        K,
        knots,
        coef,
        phi: new Float64Array(K),
        sig: new Float64Array(K),
        w: new Float64Array(K + 1),
        dw: new Float64Array(K + 1),
    };
}
const MAP_PROFILE_4K = makeMapProfile(MAP_KNOTS, MAP_COEF);
const MAP_PROFILE_6K = makeMapProfile(MAP6_KNOTS, MAP6_COEF);
const MAP_PROFILE_7K = makeMapProfile(MAP7_KNOTS, MAP7_COEF);
let MAP_ACTIVE = MAP_PROFILE_4K; // 每次 calculateFixedDensity 内按键数切换

// 一次遍历同时给出映射值与导数（g'(v)），供 Newton 求逆使用。
function mapForwardDeriv(v) {
    const P = MAP_ACTIVE;
    const K = P.K;
    for (let i = 0; i < K; i += 1) {
        const v0 = P.knots[i][0];
        const s = P.knots[i][1];
        const z = (v - v0) / s;
        if (z > 0.0) {
            P.phi[i] = s * (z + Math.log1p(Math.exp(-z)));
            P.sig[i] = 1.0 / (1.0 + Math.exp(-z));
        } else {
            P.phi[i] = s * Math.log1p(Math.exp(z));
            const ez = Math.exp(z);
            P.sig[i] = ez / (1.0 + ez);
        }
    }
    P.w[0] = v - P.phi[0];
    P.dw[0] = 1.0 - P.sig[0];
    for (let j = 1; j < K; j += 1) {
        P.w[j] = P.phi[j - 1] - P.phi[j];
        P.dw[j] = P.sig[j - 1] - P.sig[j];
    }
    P.w[K] = P.phi[K - 1];
    P.dw[K] = P.sig[K - 1];
    let sum = P.coef[0];
    let deriv = 0.0;
    for (let i = 0; i < P.w.length; i += 1) {
        sum += P.coef[i + 1] * P.w[i];
        deriv += P.coef[i + 1] * P.dw[i];
    }
    return [sum, deriv];
}

function mapBasis(v) {
    const P = MAP_ACTIVE;
    const K = P.K;
    const phi = new Array(K);
    for (let i = 0; i < K; i += 1) {
        const [v0, s] = P.knots[i];
        phi[i] = s * softplus((v - v0) / s);
    }
    const w = new Array(K + 1);
    w[0] = v - phi[0];
    for (let j = 1; j < K; j += 1) {
        w[j] = phi[j - 1] - phi[j];
    }
    w[K] = phi[K - 1];
    return w;
}

function mapForwardBase(v) {
    const P = MAP_ACTIVE;
    const w = mapBasis(v);
    let sum = P.coef[0];
    for (let i = 0; i < w.length; i += 1) {
        sum += P.coef[i + 1] * w[i];
    }
    return sum;
}

function mapForward(v) {
    return mapForwardBase(v);
}

// 解 g(v) = target（g 单调 → Newton，失败时退回二分）。序列求逆时相邻 target 连续，
// 用上一次解热启动可把典型迭代次数压到 1–2 次。
let MAP_INVERT_LAST = 0.0;
function mapInvert(target) {
    const scale = Math.max(1.0, Math.abs(target));
    const tol = 1e-13 * scale;
    let v = Number.isFinite(MAP_INVERT_LAST) ? MAP_INVERT_LAST : 0.0;
    let [g, dg] = mapForwardDeriv(v);
    for (let i = 0; i < 16; i += 1) {
        const diff = g - target;
        if (Math.abs(diff) <= tol) {
            MAP_INVERT_LAST = v;
            return v;
        }
        if (!(dg > 1e-9) || !Number.isFinite(dg)) {
            break;
        }
        let step = diff / dg;
        if (step > 10.0) {
            step = 10.0;
        } else if (step < -10.0) {
            step = -10.0;
        }
        v -= step;
        [g, dg] = mapForwardDeriv(v);
    }
    // 兜底：二分（慢但稳），保证与旧实现一致的精度。
    let lo = -60.0;
    let hi = 120.0;
    for (let i = 0; i < 60; i += 1) {
        const mid = (lo + hi) * 0.5;
        if (mapForwardBase(mid) < target) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    const out = (lo + hi) * 0.5;
    MAP_INVERT_LAST = out;
    return out;
}

// ---- LN 连续斜率映射层（与 RC 的 mapForward/mapInvert 同构）----
// u = ln(1 + LN_B·k·n)；slope(u) = LN_MAP_S0 + Σ Δ_i·σ((u − u_i)/β)，
// value(u) = LN_MAP_C + LN_MAP_S0·u + Σ Δ_i·β·softplus((u − u_i)/β)。
// 全式连续可导（softplus/sigmoid），无分段裁剪；Δ 可正可负，靠斜率下限约束保证单调。
const LN_MAP_BETA = 0.07;
const LN_MAP_S0 = 8.009100;
const LN_MAP_C = 0.471100;
const LN_MAP_KNOTS = [0.10, 0.25, 0.42, 0.60, 0.80, 1.02, 1.28, 1.60];
const LN_MAP_DELTA = [-0.8245,-0.9193,-0.8087,-0.3216,0.9749,3.3042,2.9582,-4.2032];

// 复用缓冲：K = LN_MAP_KNOTS.length 固定。
const LN_MAP_PHI = new Float64Array(LN_MAP_KNOTS.length);
const LN_MAP_SIG = new Float64Array(LN_MAP_KNOTS.length);
const LN_MAP_W = new Float64Array(LN_MAP_KNOTS.length + 1);
const LN_MAP_DW = new Float64Array(LN_MAP_KNOTS.length + 1);

// 一次遍历同时给出映射值与导数（供 Newton 求逆）。基函数与 RC 的 mapForwardDeriv 同构：
// w[0] = u − φ_0；w[j] = φ_{j−1} − φ_j；w[K] = φ_{K−1}，其中 φ_i = β·softplus((u−u_i)/β)。
// value = C + S0·u + Σ_{j=1..K} Δ_{j−1}·β·w[j]
function lnMapForwardDeriv(u) {
    const K = LN_MAP_KNOTS.length;
    for (let i = 0; i < K; i += 1) {
        const z = (u - LN_MAP_KNOTS[i]) / LN_MAP_BETA;
        LN_MAP_PHI[i] = LN_MAP_BETA * softplus(z);
        LN_MAP_SIG[i] = sigmoid(z);
    }
    LN_MAP_W[0] = u - LN_MAP_PHI[0];
    LN_MAP_DW[0] = 1.0 - LN_MAP_SIG[0];
    for (let j = 1; j < K; j += 1) {
        LN_MAP_W[j] = LN_MAP_PHI[j - 1] - LN_MAP_PHI[j];
        LN_MAP_DW[j] = LN_MAP_SIG[j - 1] - LN_MAP_SIG[j];
    }
    LN_MAP_W[K] = LN_MAP_PHI[K - 1];
    LN_MAP_DW[K] = LN_MAP_SIG[K - 1];
    let v = LN_MAP_C + LN_MAP_S0 * u;
    let d = LN_MAP_S0;
    for (let j = 1; j <= K; j += 1) {
        const coef = LN_MAP_DELTA[j - 1] * LN_MAP_BETA;
        v += coef * LN_MAP_W[j];
        d += coef * LN_MAP_DW[j];
    }
    return [v, d];
}

function lnMapForward(u) {
    return lnMapForwardDeriv(u)[0];
}

let LN_MAP_INVERT_LAST = 0.8;
function lnMapInvert(target) {
    const scale = Math.max(1.0, Math.abs(target));
    const tol = 1e-13 * scale;
    let u = Number.isFinite(LN_MAP_INVERT_LAST) ? LN_MAP_INVERT_LAST : 0.8;
    let [g, dg] = lnMapForwardDeriv(u);
    for (let i = 0; i < 20; i += 1) {
        const diff = g - target;
        if (Math.abs(diff) <= tol) {
            LN_MAP_INVERT_LAST = u;
            return u;
        }
        if (!(dg > 1e-9) || !Number.isFinite(dg)) {
            break;
        }
        let step = diff / dg;
        if (step > 10.0) {
            step = 10.0;
        } else if (step < -10.0) {
            step = -10.0;
        }
        u -= step;
        [g, dg] = lnMapForwardDeriv(u);
    }
    // 兜底：二分（u ∈ [−1, 6] 覆盖 LN 0–40 对应的全部 k·n 范围）。
    let lo = -1.0;
    let hi = 6.0;
    for (let i = 0; i < 90; i += 1) {
        const mid = (lo + hi) * 0.5;
        if (lnMapForward(mid) < target) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    const out = (lo + hi) * 0.5;
    LN_MAP_INVERT_LAST = out;
    return out;
}

// raw（= 逐事件/整谱的 k·n 或 raw·n）→ LN 等级；raw ≤ 0 视为无 LN 需求。
function lnFromRawMapped(raw, nForLn) {
    if (!(nForLn > 0.0) || !(raw > 0.0)) {
        return 0.0;
    }
    return lnMapForward(Math.log1p(LN_B * raw * nForLn));
}

// LN 等级 → raw（图表刻度/锚点反算）。
function lnRawFromValue(value, nForLn) {
    if (!(nForLn > 0.0) || !Number.isFinite(value)) {
        return Number.NaN;
    }
    return Math.expm1(lnMapInvert(value)) / (LN_B * nForLn);
}

// 滑窗 KDE 交叉熵：返回每窗熵与起始下标。
/**
 * RC v7 结构特征（与 _analysis/features_v13.js 完全一致，已验证 max|diff| = 0）。
 * 全部连续、无量纲、与总时长无关；只做线性扫描 + 两次排序（O(N log N)）。
 * 手 = 相邻两轨（4K：L=0/1，R=2/3；奇数键时最后一手为单轨）。
 */
const RC_V8_RATE_NORM = 8.0;
function rcV8Features(laneTimes, noteCount, onsetCount) {
    const K = laneTimes.length;
    const all = [];
    for (let k = 0; k < K; k += 1) {
        const lt = laneTimes[k];
        for (let i = 0; i < lt.length; i += 1) all.push(lt[i]);
    }
    all.sort((a, b) => a - b);
    const rows = [];
    for (let i = 0; i < all.length;) {
        let j = i + 1;
        while (j < all.length && Math.abs(all[j] - all[i]) < TIME_EPS) j += 1;
        rows.push([all[i], j - i]);
        i = j;
    }
    const M = rows.length;
    const t0 = M > 0 ? rows[0][0] : 0.0;
    const t1 = M > 0 ? rows[M - 1][0] : 0.0;
    const dsec = Math.max((t1 - t0) / 1000.0, 1e-3);

    const handIdx = [];
    for (let h = 0; h < K; h += 2) handIdx.push(h + 1 < K ? [h, h + 1] : [h]);
    const hands = [];
    for (let hi = 0; hi < handIdx.length; hi += 1) {
        const idx = handIdx[hi];
        const ev = [];
        for (let q = 0; q < idx.length; q += 1) {
            const lt = laneTimes[idx[q]];
            for (let i = 0; i < lt.length; i += 1) ev.push([lt[i], idx[q]]);
        }
        ev.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
        const hr = [];
        for (let i = 0; i < ev.length;) {
            let j = i + 1;
            while (j < ev.length && Math.abs(ev[j][0] - ev[i][0]) < TIME_EPS) j += 1;
            const lanesInRow = [];
            for (let q = i; q < j; q += 1) lanesInRow.push(ev[q][1]);
            lanesInRow.sort((a, b) => a - b);
            hr.push([ev[i][0], j - i, lanesInRow]);
            i = j;
        }
        hands.push(hr);
    }
    let nL = 0;
    let nR = 0;
    for (let q = 0; q < handIdx.length; q += 1) {
        let cnt = 0;
        for (let i = 0; i < handIdx[q].length; i += 1) cnt += laneTimes[handIdx[q][i]].length;
        if (q === 0) nL = cnt;
        else if (q === 1) nR = cnt;
    }

    const handSet = hands.map((hr) => {
        const s = new Set();
        for (let i = 0; i < hr.length; i += 1) s.add(hr[i][0]);
        return s;
    });
    let both = 0;
    let alt = 0;
    let prevAct = null;
    for (let i = 0; i < rows.length; i += 1) {
        const t = rows[i][0];
        const a0 = handSet.length > 0 ? handSet[0].has(t) : false;
        const a1 = handSet.length > 1 ? handSet[1].has(t) : false;
        const nAct = (a0 ? 1 : 0) + (a1 ? 1 : 0);
        if (nAct === 2) both += 1;
        if (prevAct !== null) {
            const pn = (prevAct[0] ? 1 : 0) + (prevAct[1] ? 1 : 0);
            if (pn === 1 && nAct === 1 && prevAct[0] !== a0) alt += 1;
        }
        prevAct = [a0, a1];
    }
    const fBoth = both / dsec / RC_V8_RATE_NORM;
    const fAlt = alt / dsec / RC_V8_RATE_NORM;

    const oscH = [];
    const laneAltH = [];
    const jackH = [];
    const dblH = [];
    for (let hi = 0; hi < hands.length; hi += 1) {
        const hr = hands[hi];
        if (hr.length === 0) {
            oscH.push(0.0); laneAltH.push(0.0); jackH.push(0.0); dblH.push(0.0);
            continue;
        }
        let cSum = 0;
        let diffSum = 0;
        let dblCnt = 0;
        let chg = 0;
        let same = 0;
        let prevSingle = null;
        for (let i = 0; i < hr.length; i += 1) {
            const c = hr[i][1];
            cSum += c;
            if (i > 0) diffSum += Math.abs(c - hr[i - 1][1]);
            if (c >= 2) dblCnt += 1;
            if (c === 1) {
                if (prevSingle !== null) {
                    const a = hr[i][2];
                    const b = prevSingle;
                    let isSame = a.length === b.length;
                    for (let q = 0; isSame && q < a.length; q += 1) if (a[q] !== b[q]) isSame = false;
                    if (isSame) same += 1; else chg += 1;
                }
                prevSingle = hr[i][2];
            }
        }
        const mc = cSum / hr.length;
        oscH.push(hr.length > 1 && mc > 0.0 ? diffSum / (hr.length - 1) / mc : 0.0);
        dblH.push(dblCnt / dsec / RC_V8_RATE_NORM);
        laneAltH.push(chg / dsec / RC_V8_RATE_NORM);
        jackH.push(same / dsec / RC_V8_RATE_NORM);
    }
    const meanOf = (a) => {
        if (a.length === 0) return 0.0;
        let s = 0.0;
        for (let i = 0; i < a.length; i += 1) s += a[i];
        return s / a.length;
    };
    const tot = nL + nR;
    return {
        f_both: fBoth,
        f_alt: fAlt,
        f_osc: meanOf(oscH),
        f_lanealt: meanOf(laneAltH),
        f_jack: meanOf(jackH),
        f_dbl: meanOf(dblH),
        f_bal: tot > 0.0 ? (2.0 * Math.min(nL, nR)) / tot : 0.0,
        f_chord: noteCount / Math.max(M, 1),
        f_notes: noteCount / dsec / RC_V8_RATE_NORM,
        f_handmax: Math.max(nL, nR) / dsec / RC_V8_RATE_NORM,
        f_bothrow: M > 0 ? both / M : 0.0,
    };
}

function windowEntropies(lg, window, stride) {
    const n = lg.length;
    if (n < window) {
        return { ents: new Float64Array(0), starts: new Int32Array(0) };
    }
    const startList = [];
    for (let s = 0; s + window <= n; s += stride) {
        startList.push(s);
    }
    const ents = new Float64Array(startList.length);
    const z = new Float64Array(window);
    for (let si = 0; si < startList.length; si += 1) {
        const s = startList[si];
        let lo = Infinity;
        let hi = -Infinity;
        for (let k = 0; k < window; k += 1) {
            const x = lg[s + k];
            if (x < lo) lo = x;
            if (x > hi) hi = x;
        }
        const rng = hi - lo;
        if (rng > 1e-12) {
            const inv = 1.0 / rng;
            for (let k = 0; k < window; k += 1) {
                z[k] = (lg[s + k] - lo) * inv;
            }
        } else {
            z.fill(0.0);
        }
        let sumLogQ = 0.0;
        for (let i = 0; i < window; i += 1) {
            const zi = z[i];
            let acc = 0.0;
            for (let j = 0; j < window; j += 1) {
                const d = zi - z[j];
                acc += Math.exp(IRR_ENT_COEF * (d * d));
            }
            sumLogQ += Math.log(acc / window);
        }
        ents[si] = IRR_LOG_DEN - sumLogQ / window;
    }
    return { ents, starts: Int32Array.from(startList) };
}

// 逐起音的局部邻域熵（窗口 16、步长 4，档间线性插值回逐键）。
function localIrregularity(onsets) {
    const size = onsets.length;
    const out = new Float64Array(size);
    if (size < 3) {
        return out;
    }
    const gaps = [];
    for (let i = 1; i < size; i += 1) {
        const d = onsets[i] - onsets[i - 1];
        if (d > TIME_EPS) {
            gaps.push(d);
        }
    }
    if (gaps.length < IRR_LOCAL_WINDOW) {
        return out;
    }
    const lg = Float64Array.from(gaps, (g) => Math.log2(g));
    const { ents, starts } = windowEntropies(lg, IRR_LOCAL_WINDOW, IRR_LOCAL_STRIDE);
    if (starts.length === 0) {
        return out;
    }
    const half = IRR_LOCAL_WINDOW >> 1;
    const centers = new Float64Array(starts.length);
    for (let i = 0; i < starts.length; i += 1) {
        centers[i] = starts[i] + half;
    }
    const last = centers.length - 1;
    for (let x = 0; x < size; x += 1) {
        if (x <= centers[0]) {
            out[x] = ents[0];
        } else if (x >= centers[last]) {
            out[x] = ents[last];
        } else {
            let lo = 0;
            let hi = last;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (centers[mid] <= x) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            const x0 = centers[lo];
            const x1 = centers[hi];
            const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0.0;
            out[x] = ents[lo] + (ents[hi] - ents[lo]) * t;
        }
    }
    return out;
}

// 在给定时刻上取逐键局部熵（精确命中，容忍 TIME_EPS；未命中取 0）。
function entropyAt(onsets, ent, times) {
    const out = new Float64Array(times.length);
    if (onsets.length === 0 || times.length === 0) {
        return out;
    }
    for (let i = 0; i < times.length; i += 1) {
        const t = times[i];
        const k0 = lowerBound(onsets, t);
        if (k0 < onsets.length && Math.abs(onsets[k0] - t) < TIME_EPS) {
            out[i] = ent[k0];
        }
    }
    return out;
}

// 沿起音序列做局部窗口平均（与 localIrregularity 同窗口/插值口径）。
function localWindowMean(values, window, stride) {
    const n = values.length;
    if (n === 0 || window <= 1) {
        return Float64Array.from(values);
    }
    window = Math.max(1, Math.floor(window));
    stride = Math.max(1, Math.floor(stride));
    if (n <= window) {
        const half = window >> 1;
        const out = new Float64Array(n);
        for (let i = 0; i < n; i += 1) {
            const lo = Math.max(0, i - half);
            const hi = Math.min(n, i + half + 1);
            let sum = 0.0;
            for (let j = lo; j < hi; j += 1) {
                sum += values[j];
            }
            out[i] = sum / (hi - lo);
        }
        return out;
    }
    const starts = [];
    for (let s = 0; s + window <= n; s += stride) {
        starts.push(s);
    }
    if (starts.length === 0) {
        return Float64Array.from(values);
    }
    const means = new Float64Array(starts.length);
    for (let si = 0; si < starts.length; si += 1) {
        let sum = 0.0;
        const s = starts[si];
        for (let j = 0; j < window; j += 1) {
            sum += values[s + j];
        }
        means[si] = sum / window;
    }
    const centers = new Float64Array(starts.length);
    for (let i = 0; i < starts.length; i += 1) {
        centers[i] = starts[i] + (window >> 1);
    }
    const out = new Float64Array(n);
    const last = centers.length - 1;
    for (let x = 0; x < n; x += 1) {
        if (x <= centers[0]) {
            out[x] = means[0];
        } else if (x >= centers[last]) {
            out[x] = means[last];
        } else {
            let lo = 0;
            let hi = last;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (centers[mid] <= x) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            const x0 = centers[lo];
            const x1 = centers[hi];
            const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0.0;
            out[x] = means[lo] + (means[hi] - means[lo]) * t;
        }
    }
    return out;
}

// 双手合并层：左右手同刻 chord/协调权重 s(t) ∈ [0,1]。
//   c_eff = max(L,R) + alpha·min(L,R)
//   c_bar = 局部窗口平均(c_eff)
//   s     = 1 − exp(−(c_bar−1)/scale)
//   s    *= (1 − f_bar)^density（f_bar = 局部窗口内 c_eff>1 的比例）
function crossHandWeight(lanes, onsets) {
    const n = onsets.length;
    const out = new Float64Array(n);
    if (n === 0) {
        return out;
    }
    const handCount = Math.max(1, Math.ceil(lanes.length / 2));
    const laneMaps = lanes.map((lane) => {
        const m = new Map();
        for (const note of lane) {
            m.set(note.t, (m.get(note.t) || 0) + 1);
        }
        return m;
    });
    const cEff = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
        const t = onsets[i];
        let total = 0;
        let maxCount = 0;
        for (let h = 0; h < handCount; h += 1) {
            let c = 0;
            const end = Math.min((h + 1) * 2, lanes.length);
            for (let l = h * 2; l < end; l += 1) {
                c += laneMaps[l].get(t) || 0;
            }
            total += c;
            if (c > maxCount) {
                maxCount = c;
            }
        }
        cEff[i] = maxCount + IRR_CROSS_ALPHA * (total - maxCount);
    }
    const cBar = localWindowMean(cEff, IRR_CROSS_WINDOW, IRR_LOCAL_STRIDE);
    const dense = IRR_CROSS_DENSITY > 0.0;
    const fBar = dense
        ? localWindowMean(Float64Array.from(cEff, (v) => (v > 1.0 ? 1.0 : 0.0)),
            IRR_CROSS_WINDOW, IRR_LOCAL_STRIDE)
        : null;
    for (let i = 0; i < n; i += 1) {
        let s = 1.0 - Math.exp(-(cBar[i] - 1.0) / IRR_CROSS_SCALE);
        if (dense) {
            s *= Math.pow(Math.max(0.0, Math.min(1.0, 1.0 - fBar[i])), IRR_CROSS_DENSITY);
        }
        out[i] = Math.max(0.0, Math.min(1.0, s));
    }
    return out;
}

// ---- LN 参考难度：OD 判定窗 / 长度有效性门 ----

// 该 OD 下 LN 头/尾判定的半宽 (W_head, W_tail)，单位 ms。
function lnOdWindows(od) {
    const wHead = Math.max((LN_HEAD_WINDOW_A - LN_HEAD_WINDOW_B * od) / 2.0, 0.0);
    return [wHead, wHead * LN_TAIL_WINDOW_RATIO];
}

// 长度有效性门的临界区间 (lo, hi)，单位 ms：ℓ ≤ lo 视为单键、ℓ ≥ hi 视为完整长条。
function lnValidBand(od) {
    const [wHead, wTail] = lnOdWindows(od);
    const lo = LN_MIN_HOLD_MS + LN_VALID_OD_GAIN * (wHead + wTail);
    return [lo, lo * LN_VALID_RAMP];
}

// 批量指数核和：times / queries 均升序，返回 K(q) = Σ exp(-|times[i] - q| / tau)。
// 只累加 |ti - q| ≤ 34·tau 的项（e^-34 < 2e-15，低于双精度有效位），每个查询点
// 从 hi 向两侧各扫一个固定半径窗口；原实现每个查询点都重扫全部 times（O(n·m)）。
// 不用「跨步乘衰减」的增量写法：间隔大时 1/decay 会放大舍入误差，实测会漂移到 1e-1 量级。
function kernelSumSeries(times, queries, tau) {
    const n = times.length;
    const m = queries.length;
    const out = new Float64Array(m);
    if (n === 0 || m === 0) {
        return out;
    }
    const invTau = 1.0 / tau;
    const reach = 34.0 * tau;
    let hi = 0;
    for (let q = 0; q < m; q += 1) {
        const t = queries[q];
        while (hi < n && times[hi] <= t) {
            hi += 1;
        }
        let sum = 0.0;
        for (let i = hi - 1; i >= 0; i -= 1) {
            const delta = t - times[i];
            if (delta > reach) {
                break;
            }
            sum += Math.exp(-delta * invTau);
        }
        for (let i = hi; i < n; i += 1) {
            const delta = times[i] - t;
            if (delta > reach) {
                break;
            }
            sum += Math.exp(-delta * invTau);
        }
        out[q] = sum;
    }
    return out;
}

// 单手两轨左右不均：signed kernel 差 → 软门控 → 时间衰减序列（返回 time → 累积权重 Map）。
function handImbalancePairSeq(leftTimes, rightTimes, allNoteTimes) {
    const leftCol = leftTimes || [];
    const rightCol = rightTimes || [];
    // 合并两个已升序的数组并去重（不用 Set/展开，减少分配）。
    const union = [];
    let leftIdx = 0;
    let rightIdx = 0;
    while (leftIdx < leftCol.length || rightIdx < rightCol.length) {
        const aTime = leftIdx < leftCol.length ? leftCol[leftIdx] : Infinity;
        const bTime = rightIdx < rightCol.length ? rightCol[rightIdx] : Infinity;
        if (aTime < bTime) {
            union.push(aTime);
            leftIdx += 1;
        } else if (bTime < aTime) {
            union.push(bTime);
            rightIdx += 1;
        } else {
            union.push(aTime);
            leftIdx += 1;
            rightIdx += 1;
        }
    }
    // 三个 kernel 和一次性批量算出（O(n+m)），避免每个查询点重扫。
    const leftK = kernelSumSeries(leftCol, union, HAND_IMB_TAU_MS);
    const rightK = kernelSumSeries(rightCol, union, HAND_IMB_TAU_MS);
    const allK = kernelSumSeries(allNoteTimes, union, HAND_IMB_TAU_MS);
    const seq = new Map();
    let s = 0.0;
    let prev = null;
    for (let u = 0; u < union.length; u += 1) {
        const t = union[u];
        const L = leftK[u];
        const R = rightK[u];
        const M = L + R;
        const D = L - R;
        const I = Math.sqrt(D * D + HAND_IMB_EPS * HAND_IMB_EPS) - HAND_IMB_EPS;
        const gate = 1.0 / (1.0 + Math.exp(-(M - 1.5) / 0.25));
        const G = allK[u];
        const dens = (M / (M + HAND_IMB_M0)) * (G / (G + HAND_IMB_NPS0));
        const raw = gate * I / (M + HAND_IMB_EPS) * dens;
        const weakMass = Math.min(L, R);
        const qWeak = weakMass / (weakMass + WEAK_GATE_Q0);
        const imb = I / (M + HAND_IMB_EPS);
        const weakGate = qWeak / (1.0 + Math.exp(-(imb - WEAK_GATE_IMB_B) / WEAK_GATE_IMB_S));
        if (prev !== null) {
            s *= Math.pow(0.5, (t - prev) / HAND_IMB_HALF_LIFE_MS);
        }
        s += raw * weakGate;
        seq.set(t, s);
        prev = t;
    }
    return seq;
}

// 单手不均权重：4K 每手两轨 = 单一配对（与原实现逐位一致）；
// 6K 每手三轨 = 12/23 两个重叠配对，单轨取包含它的各配对权重的算术平均。
function handImbalanceWeights(laneGroups, laneGroupTimes, allNoteTimes) {
    const weights = laneGroupTimes.map((tt) => new Float64Array(tt.length));
    for (const hand of handLayoutOf(laneGroups.length)) {
        if (hand.length < 2) {
            continue;
        }
        const pairSeqs = [];
        for (let r = 0; r + 1 < hand.length; r += 1) {
            pairSeqs.push(handImbalancePairSeq(
                laneGroupTimes[hand[r]] || [],
                laneGroupTimes[hand[r + 1]] || [],
                allNoteTimes,
            ));
        }
        for (let r = 0; r < hand.length; r += 1) {
            const lane = hand[r];
            const members = [];
            if (r - 1 >= 0) {
                members.push(pairSeqs[r - 1]);
            }
            if (r + 1 < hand.length) {
                members.push(pairSeqs[r]);
            }
            if (members.length === 0) {
                continue;
            }
            const tt = laneGroupTimes[lane];
            for (let k = 0; k < tt.length; k += 1) {
                let sum = 0.0;
                for (const seq of members) {
                    sum += seq.get(tt[k]) || 0.0;
                }
                weights[lane][k] = sum / members.length;
            }
        }
    }
    return weights;
}

function smoothstep(x, lo, hi) {
    if (hi - lo <= TIME_EPS) {
        return x >= hi ? 1.0 : 0.0;
    }
    let t = (x - lo) / (hi - lo);
    t = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
    return t * t * (3.0 - 2.0 * t);
}

function median(values) {
    const n = values.length;
    if (n === 0) {
        return 0.0;
    }
    const a = Float64Array.from(values);
    a.sort();
    const mid = n >> 1;
    return n % 2 === 1 ? a[mid] : (a[mid - 1] + a[mid]) * 0.5;
}

// 单根长条的长度权重 u = smoothstep(ℓ; lo, hi) ∈ [0,1]：过短视为单键、足够长视为完整长条。
function lnLengthWeight(lengthMs, od) {
    const [lo, hi] = lnValidBand(od);
    return smoothstep(lengthMs, lo, hi);
}

// 长度权重施加上增益：w = 1 − clip(gain)·(1 − u)；gain ≤ 0 时恒为 1。
function lnLenWeight(lengthMs, od) {
    if (LN_LEN_WEIGHT_GAIN <= 0.0) {
        return 1.0;
    }
    const gain = Math.min(Math.max(LN_LEN_WEIGHT_GAIN, 0.0), 1.0);
    return 1.0 - gain * (1.0 - lnLengthWeight(lengthMs, od));
}

// 全谱 LN 时长有效性 v = smoothstep(ℓ_med; lo, hi) ∈ [0,1]（无长条时为 0）：
// 长条短到判定上等同单键时整层结构量清零。
function lnHoldValidity(lanes, od) {
    const lens = [];
    for (const lane of lanes) {
        for (const n of lane) {
            if (n.len > 0) {
                lens.push(n.len);
            }
        }
    }
    if (lens.length === 0) {
        return 0.0;
    }
    const [lo, hi] = lnValidBand(od);
    return smoothstep(median(lens), lo, hi);
}

// ---- LN 参考难度：结构得分与 ln 倍率 ----
//
// 参与 k 的是 S_rel（同轨相邻松手间距倒数，按松手分组）、S_jack（松手→同轨下一次按下）、
// S_cross（保持期间配对轨超出本地基线的动作速率）与 S_hold（保持时长 / 本地物件平均间隔）。
// 逐灰长度权重 w/u 与长度因子 h 见 lnEventScores；整谱折扣 w(吸收) / v(有效性) 见 lnStructureScores。

function invGap(d) {
    return d > TIME_EPS ? INV_DIST_SCALE / d : 0.0;
}

// 局部密度下界 → 时间尺度 T_loc（ms）：窗口内 RC contribution 的几何均值
// （exp(mean(ln(c+b))) − b）作为“密度下界”，其倒数即局部间隔下界。
// 与 OD 判定窗相加得到 S_jack 的临界间隙，决定“大规模增益”何时开始。
function lnLocalDensityTime(tauScaled, density) {
    if (!density || !density.times || density.times.length === 0) {
        return 90.0;
    }
    const times = density.times;
    const values = density.values;
    const n = times.length;
    const half = LN_TLOC_WINDOW >> 1;
    const idx = lowerBound(times, tauScaled);
    const lo = Math.min(Math.max(idx - half, 0), Math.max(n - LN_TLOC_WINDOW, 0));
    const hi = Math.min(n, lo + LN_TLOC_WINDOW);
    let sumLn = 0.0;
    let cnt = 0;
    for (let i = lo; i < hi; i += 1) {
        const v = values[i] + LN_TLOC_B;
        if (v > 0.0) {
            sumLn += Math.log(v);
            cnt += 1;
        }
    }
    if (cnt === 0) {
        return LN_TLOC_MAX_MS;
    }
    const gm = Math.exp(sumLn / cnt) - LN_TLOC_B;
    if (!(gm > 1e-9)) {
        return LN_TLOC_MAX_MS;
    }
    return Math.min(Math.max(INV_DIST_SCALE / gm, LN_TLOC_MIN_MS), LN_TLOC_MAX_MS);
}

// 与 RC 通道同款的分位聚合（findNQuantile）：把逐事件结构量收成一个“n 尺度”的标量，
// 而不是算术平均；分位目标见 LN_AGG_QUANTILE。
function lnAggregate(values) {
    if (!values || values.length === 0) {
        return 0.0;
    }
    return findNQuantile(Float64Array.from(values), LN_AGG_QUANTILE);
}

// 单轨 LN 事件的三项结构量；该轨无 LN 时返回 null。
// 逐根长度权重 w = lnLenWeight(ℓ, od)；S_rel / S_jack 再乘长度因子 h = ℓ/(ℓ+ℓ₀)
// （恢复“有效长条中越长越难”的单调性），S_hold 只乘 w。
function lnEventScores(col, partnerCol, od, invRate = 1.0, density = null, otherPresses = null) {
    const holds = col.filter((n) => n.len > 0);
    if (holds.length === 0) {
        return null;
    }
    const tt = uniqueSorted(holds.map((n) => n.t + n.len).sort((a, b) => a - b));
    const presses = col.map((n) => n.t).sort((a, b) => a - b);

    // 每个松手时刻的平均长度 → (长度权重 w, 长度因子 h)
    const lenAcc = new Map();
    for (const n of holds) {
        const key = n.t + n.len;
        const e = lenAcc.get(key);
        if (e) {
            e[0] += n.len;
            e[1] += 1;
        } else {
            lenAcc.set(key, [n.len, 1]);
        }
    }
    const w = new Float64Array(tt.length);
    const h = new Float64Array(tt.length);
    for (let i = 0; i < tt.length; i += 1) {
        const e = lenAcc.get(tt[i]);
        const m = e ? e[0] / e[1] : 0.0;
        w[i] = lnLenWeight(m, od);
        h[i] = LN_HOLD_REF_MS <= 0.0 ? 1.0 : m / (m + LN_HOLD_REF_MS);
    }

    // 松手节奏均匀度折扣（LN v5）：完全均匀的等间距排列 → 几乎无锁手/松手需求。
    const uni = new Float64Array(tt.length);
    uni.fill(1.0);
    if (tt.length >= 3) {
        let meanGap = 0.0;
        for (let i = 1; i < tt.length; i += 1) {
            meanGap += tt[i] - tt[i - 1];
        }
        meanGap /= (tt.length - 1);
        let varSum = 0.0;
        for (let i = 1; i < tt.length; i += 1) {
            const d = (tt[i] - tt[i - 1]) - meanGap;
            varSum += d * d;
        }
        const sd = Math.sqrt(varSum / (tt.length - 1));
        const cv = meanGap > TIME_EPS ? sd / meanGap : 0.0;
        const t = Math.min(1.0, Math.max(0.0, cv / LN_UNI_CV0));
        uni.fill(LN_UNI_FLOOR + (1.0 - LN_UNI_FLOOR) * Math.pow(t, LN_UNI_POWER));
    }

    // S_rel：同轨相邻松手间距倒数的算术平均（v5：L2 → 均值，消除均匀流的 √2 双计）。
    const sRel = new Float64Array(tt.length);
    for (let i = 0; i < tt.length; i += 1) {
        const pd = i > 0 ? tt[i] - tt[i - 1] : -1.0;
        const nd = i + 1 < tt.length ? tt[i + 1] - tt[i] : -1.0;
        const wEff = Math.max(w[i], LN_REL_W_MIN);
        sRel[i] = 0.5 * (invGap(pd) + invGap(nd)) * wEff * uni[i];
    }

    // S_jack（v6）：50ms 面缝归零的连续门控（见 LN_JACK_ZERO_MS 注释）。
    const [jackWHead, jackWTail] = lnOdWindows(od);
    const wOd = jackWHead + jackWTail;
    const groupStarts = new Map();
    for (const n of holds) {
        const key = n.t + n.len;
        if (!groupStarts.has(key)) {
            groupStarts.set(key, []);
        }
        groupStarts.get(key).push(n.t);
    }
    const sJack = new Float64Array(tt.length);
    const gaps = new Float64Array(tt.length);
    gaps.fill(-1.0e9);
    for (let i = 0; i < tt.length; i += 1) {
        let gsum = 0.0;
        let gcnt = 0;
        for (const startT of groupStarts.get(tt[i])) {
            const k = upperBound(presses, startT);
            if (k < presses.length) {
                gsum += presses[k] - tt[i];
                gcnt += 1;
            }
        }
        if (gcnt === 0) {
            sJack[i] = 0.0;
            continue;
        }
        const g = gsum / gcnt;
        gaps[i] = g;
        const gate = 1.0 / (1.0 + Math.exp((g - LN_JACK_G50_MS) / LN_JACK_SLOPE_MS));
        sJack[i] = w[i] * h[i] * gate;
    }

    // S_adj（v6）：头尾相邻性。逐松手事件取「到其它轨最近按下」的距离 d，
    // adj = 1/(1+(2d/W_od)^4) × max(w, LN_REL_W_MIN)：松手与另一轨按下越贴（异步锁手/交接越多）越大；
    // 四轨同时按下/松开的整齐排列 d ≈ W_od → adj ≈ 0（整齐排列不额外加成）。
    const sAdj = new Float64Array(tt.length);
    if (otherPresses && otherPresses.length > 0) {
        const wDen = wOd > 1e-6 ? wOd : 1.0;
        for (let i = 0; i < tt.length; i += 1) {
            const te = tt[i];
            let lo = 0;
            let hi = otherPresses.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (otherPresses[mid] < te) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            let d = Number.POSITIVE_INFINITY;
            if (lo < otherPresses.length) {
                d = otherPresses[lo] - te;
            }
            if (lo > 0) {
                d = Math.min(d, te - otherPresses[lo - 1]);
            }
            if (!Number.isFinite(d)) {
                sAdj[i] = 0.0;
                continue;
            }
            const q = (2.0 * d) / wDen;
            const q2 = q * q;
            const close = softClip01(1.0 - d / wDen);
            sAdj[i] = close * Math.max(w[i], LN_REL_W_MIN);
        }
    }

    // S_hold：保持时长 / 该轨物件平均间隔（无量纲，一根长条跨越多少个本地节拍）× w
    const lens = holds.map((n) => n.len);
    let baseGap = 0.0;
    if (presses.length > 1) {
        let sum = 0.0;
        for (let i = 1; i < presses.length; i += 1) {
            sum += presses[i] - presses[i - 1];
        }
        baseGap = sum / (presses.length - 1);
    }
    const sHold = (baseGap > TIME_EPS && lens.length > 0)
        ? Float64Array.from(lens, (l) => (l / baseGap) * lnLenWeight(l, od))
        : new Float64Array(lens.length);

    // 逐事件的平均 S_hold（每个松手事件一个长条赋值，供难度-进度图序列使用）
    const holdGroup = new Float64Array(tt.length);
    if (baseGap > TIME_EPS && holds.length > 0) {
        const endIdx = new Map();
        for (let i = 0; i < tt.length; i += 1) {
            endIdx.set(tt[i], i);
        }
        const holdCnt = new Float64Array(tt.length);
        for (let j = 0; j < holds.length; j += 1) {
            const idx = endIdx.get(holds[j].t + holds[j].len);
            if (idx !== undefined) {
                holdGroup[idx] += sHold[j];
                holdCnt[idx] += 1.0;
            }
        }
        for (let i = 0; i < tt.length; i += 1) {
            if (holdCnt[i] > 0.0) {
                holdGroup[i] /= holdCnt[i];
            }
        }
    }

    // S_cross：保持期间配对轨动作数超出本地基线期望的部分，换算成速率。
    const sCross = new Float64Array(tt.length);
    if (partnerCol && partnerCol.length > 0) {
        const pacts = [];
        for (const n of partnerCol) {
            pacts.push(n.t);
            if (n.len > 0) {
                pacts.push(n.t + n.len);
            }
        }
        pacts.sort((a, b) => a - b);
        const hs = holds.map((n) => n.t);
        const he = holds.map((n) => n.t + n.len);
        const lnW = holds.map((n) => lnLenWeight(n.len, od));
        const endIndex = new Map();
        for (let i = 0; i < tt.length; i += 1) {
            endIndex.set(tt[i], i);
        }
        const sums = new Float64Array(tt.length);
        const counts = new Float64Array(tt.length);
        for (let j = 0; j < holds.length; j += 1) {
            const kb = upperBound(pacts, hs[j]) - 1;
            const ka = lowerBound(pacts, he[j]);
            const nEv = Math.max(ka - kb - 1, 0);
            const hasB = kb >= 0;
            const hasA = ka < pacts.length;
            const gapB = hasB ? hs[j] - pacts[kb] : 0.0;
            const gapA = hasA ? pacts[ka] - he[j] : 0.0;
            const goodB = hasB && gapB > TIME_EPS;
            const goodA = hasA && gapA > TIME_EPS;
            let rate = 0.0;
            if (goodB && goodA) {
                rate = 2.0 / (gapB + gapA);
            } else if (goodB) {
                rate = 1.0 / gapB;
            } else if (goodA) {
                rate = 1.0 / gapA;
            }
            const length = he[j] - hs[j];
            if (rate > 0.0 && length > TIME_EPS) {
                const cross = (INV_DIST_SCALE * Math.max(nEv - rate * length, 0.0)
                    / length) * lnW[j];
                const idx = endIndex.get(he[j]);
                if (idx !== undefined) {
                    sums[idx] += cross;
                    counts[idx] += 1.0;
                }
            }
        }
        for (let i = 0; i < tt.length; i += 1) {
            sCross[i] = counts[i] > 0.0 ? sums[i] / counts[i] : 0.0;
        }
    }

    return { sRel, sJack, sAdj, sCross, sHold, times: tt, holdGroup, w, gaps };
}

// 全谱 LN 事件上的分位聚合（RC 同款 findNQuantile），并施以整谱折扣：
// S_rel / S_jack × w(松手吸收) × v(时长有效性)，S_cross / S_hold × v。
function lnStructureScores(lanes, od, invRate = 1.0, density = null) {
    const rels = [];
    const jacks = [];
    const adjs = [];
    const crosses = [];
    const holdsArr = [];
    const seamSamples = [];
    const events = [];
    const handOthers = handOthersOf(lanes.length);
    for (let i = 0; i < lanes.length; i += 1) {
        const partner = lnPartnerCol(lanes, handOthers[i]);
        let otherPresses = null;
        if (lanes.length > 1) {
            otherPresses = [];
            for (let j = 0; j < lanes.length; j += 1) {
                if (j === i) {
                    continue;
                }
                for (const n of lanes[j]) {
                    otherPresses.push(n.t);
                }
            }
            otherPresses.sort((a, b) => a - b);
        }
        const got = lnEventScores(lanes[i], partner, od, invRate, density, otherPresses);
        if (got) {
            for (const v of got.sRel) {
                rels.push(v);
            }
            for (const v of got.sJack) {
                jacks.push(v);
            }
            for (const v of got.sAdj) {
                adjs.push(v);
            }
            for (const v of got.sCross) {
                crosses.push(v);
            }
            for (let j = 0; j < got.gaps.length; j += 1) {
                const gv = got.gaps[j];
                if (gv > -1.0e8) {
                    seamSamples.push(softClip01(1.0 - Math.abs(gv - LN_SEAM_GAP_MS) / LN_SEAM_TOL_MS));
                }
            }
            for (const v of got.sHold) {
                holdsArr.push(v);
            }
            for (let j = 0; j < got.times.length; j += 1) {
                events.push({
                    t: got.times[j],
                    rel: got.sRel[j],
                    jack: got.sJack[j],
                    adj: got.sAdj[j],
                    cross: got.sCross[j],
                    hold: got.holdGroup[j],
                    w: got.w[j],
                });
            }
        }
    }
    const absorb = lnReleaseAbsorb(lanes, LN_ABSORB_GAIN);
    const valid = lnHoldValidity(lanes, od);
    return {
        sRel: lnAggregate(rels) * absorb * valid,
        sJack: lnAggregate(jacks) * absorb * valid,
        sAdj: lnAggregate(adjs) * absorb * valid,
        sCross: lnAggregate(crosses) * valid,
        sHold: lnAggregate(holdsArr) * valid,
        seamReg: lnAggregate(seamSamples) * valid,
        events,
        absorb,
        valid,
    };
}

// LN 通道的“自家分位 n”（实验）：逐松手事件取 γ 加权结构量，再用 findNQuantile 收成 n。
// LN_OWN_N_MODE = 1 时替代 RC n；会破坏现有 A/B 标定（102 张基准 RMSE ~1.8），需重新拟合。
function lnOwnQuantileN(lanes, od, invRate = 1.0, density = null) {
    const vals = [];
    const handOthers = handOthersOf(lanes.length);
    for (let i = 0; i < lanes.length; i += 1) {
        const partner = lnPartnerCol(lanes, handOthers[i]);
        const got = lnEventScores(lanes[i], partner, od, invRate, density);
        if (!got) {
            continue;
        }
        for (let j = 0; j < got.sRel.length; j += 1) {
            vals.push(LN_MULT_REL * got.sRel[j] + LN_MULT_JACK * got.sJack[j]
                + LN_MULT_ADJ * got.sAdj[j] + LN_MULT_CROSS * got.sCross[j]);
        }
    }
    return vals.length === 0 ? 0.0 : findNQuantile(Float64Array.from(vals), LN_AGG_QUANTILE);
}

// 全谱松手吸收折扣 w = 1 − λ·ā ∈ [0,1]（λ ≤ 0 时恒为 1）。
// 单次松手吸收度 a = clip(1 − d/(0.5·g), 0, 1)：d 为松手时刻到最近“其它起音”的距离，
// g 为本地节拍（全谱正间隔中位数），ā 为全谱松手吸收度均值。
function lnReleaseAbsorb(lanes, gain) {
    if (gain <= 0.0) {
        return 1.0;
    }
    const onsetSet = new Set();
    for (const lane of lanes) {
        for (const n of lane) {
            onsetSet.add(n.t);
        }
    }
    const onsets = Array.from(onsetSet).sort((a, b) => a - b);
    if (onsets.length === 0) {
        return 1.0;
    }
    const diffs = [];
    for (let i = 1; i < onsets.length; i += 1) {
        const d = onsets[i] - onsets[i - 1];
        if (d > TIME_EPS) {
            diffs.push(d);
        }
    }
    if (diffs.length === 0) {
        return 1.0;
    }
    diffs.sort((a, b) => a - b);
    const mid = diffs.length >> 1;
    const gap = diffs.length % 2 === 1 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) * 0.5;
    if (gap <= TIME_EPS) {
        return 1.0;
    }
    const rels = [];
    for (const lane of lanes) {
        for (const n of lane) {
            if (n.len > 0) {
                rels.push(n.t + n.len);
            }
        }
    }
    if (rels.length === 0) {
        return 1.0;
    }
    const scale = ABSORB_DIST_SCALE * gap;
    let sum = 0.0;
    for (const r of rels) {
        const k0 = lowerBound(onsets, r);
        let d = Infinity;
        for (let sh = -1; sh <= 0; sh += 1) {
            const kk = Math.min(Math.max(k0 + sh, 0), onsets.length - 1);
            const dd = Math.abs(onsets[kk] - r);
            if (dd < d) {
                d = dd;
            }
        }
        sum += Math.min(Math.max(1.0 - d / scale, 0.0), 1.0);
    }
    const aBar = sum / rels.length;
    return 1.0 - Math.min(Math.max(gain, 0.0), 1.0) * aBar;
}

// ρ 饱和曲线 F(ρ) = lin·ρ + (1−lin)·(1+c^h)·ρ^h/(ρ^h+c^h)。
// 纯 Hill（lin=0）在 ρ≪c 段按 ρ^h 塌向 0；叠一条线性 toe（lin>0）后低 ρ 段近似线性，
// 少量长条的谱面不再被归零。仍满足 F(0)=0、F(1)=1、单调不减。
function lnRhoCurve(rho, h, c, lin) {
    if (rho <= 0.0) {
        return 0.0;
    }
    const k = Math.min(Math.max(lin, 0.0), 1.0);
    const rh = Math.pow(rho, h);
    const ch = Math.pow(c, h);
    const hill = (1.0 + ch) * rh / (rh + ch);
    return k * rho + (1.0 - k) * hill;
}

// 长条占比 ρ = Σ 长度权重 / 物件总数（无物件时为 0）。
function lnHoldRatio(lanes, od) {
    let total = 0;
    let holds = 0.0;
    for (const lane of lanes) {
        total += lane.length;
        for (const n of lane) {
            if (n.len > 0) {
                holds += lnLenWeight(n.len, od);
            }
        }
    }
    return total === 0 ? 0.0 : holds / total;
}

// ln 倍率 k = F(ρ)·(γ_rel·S_rel + γ_jack·S_jack + γ_cross·S_cross + γ_hold·S_hold)
// S_rel / S_jack 已含整谱折扣；rate > 1（DT）时这两项与物件时间同倍缩放 → 乘 rate。
// density 提供 RC 逐物件 contribution（时间/值），用于 S_jack 的局部密度下界 T_loc。
function lnMultiplier(lanes, od, rate, density = null) {
    const rho = lnHoldRatio(lanes, od);
    if (rho <= 0.0) {
        return { k: 0.0, events: [], factor: 0.0, absorb: 0.0, valid: 0.0 };
    }
    const invRate = 1.0 / rate;
    const structure = lnStructureScores(lanes, od, invRate, density);
    const { sRel, sJack, sAdj, sCross, sHold, events, absorb, valid } = structure;
    const total = LN_MULT_REL * (sRel * rate)
        + LN_MULT_JACK * (sJack * rate)
        + LN_MULT_ADJ * (sAdj * rate)
        + LN_MULT_CROSS * sCross
        + LN_MULT_HOLD * sHold;
    const factor = lnRhoCurve(rho, LN_MULT_EXP, LN_MULT_RHO_C, LN_MULT_RHO_LIN);
    const seamPenalty = 1.0 - LN_SEAM_DISCOUNT * structure.seamReg;
    const totalSeam = total * seamPenalty;
    return {
        k: totalSeam < 0.0 ? 0.0 : factor * totalSeam,
        events,
        factor,
        absorb,
        valid,
    };
}

function collectLanes(parsed) {
    const keyCount = Number(parsed?.columnCount) || 0;
    const columns = Array.isArray(parsed?.columns) ? parsed.columns : [];
    const starts = Array.isArray(parsed?.noteStarts) ? parsed.noteStarts : [];
    const ends = Array.isArray(parsed?.noteEnds) ? parsed.noteEnds : [];
    const types = Array.isArray(parsed?.noteTypes) ? parsed.noteTypes : [];
    const lanes = Array.from({ length: keyCount }, () => []);
    for (let i = 0; i < columns.length; i += 1) {
        const key = Number(columns[i]);
        const t = Number(starts[i]);
        if (!Number.isFinite(key) || key < 0 || key >= keyCount || !Number.isFinite(t)) {
            continue;
        }
        let len = 0;
        if ((Number(types[i]) & TYPE_HOLD) !== 0) {
            const end = Number(ends[i]);
            if (Number.isFinite(end) && end > t) {
                len = end - t;
            }
        }
        lanes[key].push({ t, len });
    }
    for (const lane of lanes) {
        lane.sort((a, b) => a.t - b.t);
    }
    return lanes;
}

function resolveParsed(source, cvtFlag = null) {
    const flag = String(cvtFlag || "").toUpperCase();
    const wantIN = flag.includes("IN");
    const wantHO = flag.includes("HO");
    const canConvert = wantIN || wantHO;

    let parsed = null;
    let osuText = null;
    if (source && typeof source === "object" && typeof source.getParsedData === "function") {
        if (typeof source.osuText === "string") {
            osuText = source.osuText;
        }
        parsed = source.getParsedData();
    } else if (typeof source === "string") {
        osuText = source;
    } else {
        throw new Error("Unsupported Fixed Density source.");
    }

    // lazer IN/HO：在独立 parser 上应用转换后再取解析数据，避免污染调用方共享 parser。
    // 转换失败（异常 / 0 物件）时回退未转换结果：图表与胶囊不应因 cvt 失败而整块变 NaN。
    if (canConvert) {
        if (typeof osuText !== "string") {
            console.warn("[FD] cvtFlag requires .osu text source; using unconverted parse.");
        } else {
            try {
                const converter = new OsuFileParser(osuText);
                converter.process();
                if (wantIN) converter.modIN();
                if (wantHO) converter.modHO();
                if (converter.columns.length > 0) {
                    return converter.getParsedData();
                }
                console.warn(`[FD] cvtFlag=${flag} produced 0 objects; falling back to unconverted parse.`);
            } catch (error) {
                console.warn(`[FD] cvtFlag=${flag} conversion failed: ${error?.message || error}; falling back.`);
            }
        }
    }

    if (parsed) {
        return parsed;
    }
    const parser = new OsuFileParser(osuText);
    parser.process();
    return parser.getParsedData();
}

function normalizeRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) {
        return 1.0;
    }
    return value;
}

/**
 * 计算 Fixed Density v1 的 rc_value 与 ln_value。
 *
 * @param {string|object} source .osu 文本 或 已 process() 的 OsuFileParser 实例
 * @param {number} [rate=1] 变速倍率（DT=1.5、HT=0.75、lazer 任意正速）；时间戳按 1/rate 缩放
 * @param {object} [options] 可选；`cvtFlag`（"IN"/"HO"，lazer Invert / Hold Off）会在
 *   独立 parser 上应用对应转换后再计算，语义与 lazer 一致。
 * @returns {{ rcValue: number, lnValue: number }} 无有效物件时两者均为 NaN
 */

// ---- RC v10：局部物理特征乘子（仅 kTotal===4，逐事件连续因子）----
// 7 个维度全部来自谱面自身（行内押数、双手同押行、换手、同轨纵连、手内不平衡、
// 行轨集重复、间隔不规则），沿时间 500ms 高斯核平滑后取 m = exp(clip(INTERCEPT + Σβz)).
// 不使用任何键型标签；6K/7K 不启用本层，保持 b1.0.5.1 行为。
const RC10_SMOOTH_MS = 500.0;
const RC10_JACK_MS = 250.0;
const RC10_EXP_CLIP = 2.0;
const RC10_INTERCEPT = -0.3170;
const RC10_BETA = [0.0000, 0.0000, 0.0000, -0.0375, 0.0000, 0.0000, 0.0000];
const RC10_FEAT_MEAN = [0.398, 0.281, 0.732, 0.833, 0.753, 0.142, 0.163];
const RC10_FEAT_SCALE = [0.144, 0.260, 0.216, 0.245, 0.224, 0.226, 0.210];

function rc10LocalFeatures(lanes, kTotal, mergedTimes) {
    const nOut = mergedTimes.length;
    if (!lanes || lanes.length === 0 || nOut === 0) return null;
    if (kTotal !== 4 && kTotal !== 6 && kTotal !== 7) return null;
    const onsets = [];
    for (let c = 0; c < kTotal; c += 1) {
        const lane = lanes[c];
        if (!lane) continue;
        for (let i = 0; i < lane.length; i += 1) onsets.push([lane[i].t, c]);
    }
    if (onsets.length < 2) return null;
    onsets.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const rowTimes = [];
    const rowCols = [];
    let curT = onsets[0][0];
    let curCols = [onsets[0][1]];
    for (let i = 1; i < onsets.length; i += 1) {
        const t = onsets[i][0];
        const c = onsets[i][1];
        if (Math.abs(t - curT) <= 1e-6) curCols.push(c);
        else { rowTimes.push(curT); rowCols.push(curCols); curT = t; curCols = [c]; }
    }
    rowTimes.push(curT);
    rowCols.push(curCols);
    const nRows = rowTimes.length;
    if (nRows < 2) return null;

    const leftCount = handLayoutOf(kTotal)[0].length;
    const lastLaneT = new Float64Array(kTotal).fill(-1e9);
    const raw = [];
    let prevMask = 0;
    let prevSet = null;
    for (let i = 0; i < nRows; i += 1) {
        const t = rowTimes[i];
        const cols = rowCols[i];
        const set = new Set(cols);
        let mask = 0;
        let left = 0;
        let right = 0;
        let jack = 0;
        for (const c of cols) {
            if (c < leftCount) { left += 1; mask |= 1; } else { right += 1; mask |= 2; }
            if (t - lastLaneT[c] <= RC10_JACK_MS) jack += 1;
        }
        for (const c of cols) lastLaneT[c] = t;
        const total = left + right;
        let inter = 0;
        if (prevSet) for (const c of set) if (prevSet.has(c)) inter += 1;
        const denom = Math.sqrt(total * (prevSet ? prevSet.size : 1));
        const f = new Array(7);
        f[0] = total / kTotal;
        f[1] = (mask === 3) ? 1.0 : 0.0;
        f[2] = (i > 0 && mask !== prevMask) ? 1.0 : 0.0;
        f[3] = total > 0 ? jack / total : 0.0;
        f[4] = total > 0 ? Math.abs(left - right) / total : 0.0;
        f[5] = (prevSet && denom > 0) ? inter / denom : 0.0;
        raw.push(f);
        prevMask = mask;
        prevSet = set;
    }
    const diffs = [];
    for (let i = 1; i < nRows; i += 1) diffs.push(rowTimes[i] - rowTimes[i - 1]);
    const sorted = diffs.slice().sort((a, b) => a - b);
    const med = sorted.length > 0 ? Math.max(sorted[Math.floor(sorted.length / 2)], 1e-3) : 1.0;
    for (let i = 0; i < nRows; i += 1) {
        if (i === 0) { raw[i][6] = 0.0; continue; }
        const d = Math.max(rowTimes[i] - rowTimes[i - 1], 1e-3);
        raw[i][6] = Math.min(1.0, Math.abs(Math.log(d / med)) / Math.log(4.0));
    }

    const sigma = v11Cfg("smooth", RC10_SMOOTH_MS);
    const reach = 3.0 * sigma;
    const smooth = [];
    for (let i = 0; i < nRows; i += 1) {
        const ti = rowTimes[i];
        const acc = new Array(7).fill(0.0);
        let wsum = 0.0;
        for (let j = i; j >= 0 && ti - rowTimes[j] <= reach; j -= 1) {
            const dt = ti - rowTimes[j];
            const w = Math.exp(-0.5 * (dt / sigma) * (dt / sigma));
            const fj = raw[j];
            for (let q = 0; q < 7; q += 1) acc[q] += w * fj[q];
            wsum += w;
        }
        for (let j = i + 1; j < nRows && rowTimes[j] - ti <= reach; j += 1) {
            const dt = rowTimes[j] - ti;
            const w = Math.exp(-0.5 * (dt / sigma) * (dt / sigma));
            const fj = raw[j];
            for (let q = 0; q < 7; q += 1) acc[q] += w * fj[q];
            wsum += w;
        }
        if (wsum > 0) for (let q = 0; q < 7; q += 1) acc[q] /= wsum;
        smooth.push(acc);
    }

    const out = [];
    for (let q = 0; q < 7; q += 1) out.push(new Float64Array(nOut));
    let ptr = 0;
    for (let k = 0; k < nOut; k += 1) {
        const t = mergedTimes[k];
        while (ptr + 1 < nRows && Math.abs(rowTimes[ptr + 1] - t) <= Math.abs(rowTimes[ptr] - t)) ptr += 1;
        const row = smooth[ptr];
        for (let q = 0; q < 7; q += 1) out[q][k] = row[q];
    }
    return out;
}

function rc10LocalMultiplier(feat) {
    if (!feat) return null;
    const n = feat[0].length;
    const m = new Float64Array(n);
    for (let k = 0; k < n; k += 1) {
        let z = v11Cfg("intercept", RC10_INTERCEPT);
        for (let q = 0; q < 7; q += 1) {
            if (RC10_BETA[q] !== 0.0) {
                const scale = Math.max(RC10_FEAT_SCALE[q], 1e-6);
                z += RC10_BETA[q] * (feat[q][k] - RC10_FEAT_MEAN[q]) / scale;
            }
        }
        const zc = Math.max(-RC10_EXP_CLIP, Math.min(RC10_EXP_CLIP, z));
        m[k] = Math.exp(zc);
    }
    return m;
}

// ---- RC v13：高密度轮换折叠（roll -> 对拍）----
// 物理背景：单键轮换（1234 循环）的行速率超过人手单点极限后，实际演奏会被
// 成对合并成同手双押（1234 的 (0,1)/(2,3) 对 = 对拍；1324 的 (0,2)/(1,3) 对 = 对切），
// 因此其难度应向「同音符数的对拍」收敛。本层只吃三个物理量：
//   1) 局部单键行速率（nps，40ms 级间隔 → 40+ nps 才饱和）；
//   2) 四轨轮换度（窗口内不同轨数，4 轨才满）；
//   3) 两种相位下的同手相邻对占比取大者（1234/1243/2134 = 1，1324 = 0，用于把对拍型和对切型分开）。
// 满足条件的行按 exp(-delta * score) 逐事件打折，等价于「这些键会被并排按下」。
// 不引用任何键型标签；仅 4K 启用，6K/7K 保持 b1.0.6 行为。
const RC_ROT_LO_NPS = 20.0;
const RC_ROT_HI_NPS = 40.0;
const RC_ROT_DELTA = 0.50;
const RC_ROT_REACH_MS = 180.0;

function rcRotSmoothstep(t) {
    const x = Math.max(0.0, Math.min(1.0, t));
    return x * x * (3.0 - 2.0 * x);
}

function rcRotDiscount(lanes, kTotal, mergedTimes) {
    if (kTotal !== 4 || !lanes || lanes.length === 0 || mergedTimes.length === 0) return null;
    const onsets = [];
    for (let c = 0; c < kTotal; c += 1) {
        const lane = lanes[c];
        if (!lane) continue;
        for (let i = 0; i < lane.length; i += 1) onsets.push([lane[i].t, c]);
    }
    if (onsets.length < 8) return null;
    onsets.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const rowTimes = [];
    const rowCols = [];
    let curT = onsets[0][0];
    let curCols = [onsets[0][1]];
    for (let i = 1; i < onsets.length; i += 1) {
        const t = onsets[i][0];
        const c = onsets[i][1];
        if (Math.abs(t - curT) <= 1e-6) curCols.push(c);
        else { rowTimes.push(curT); rowCols.push(curCols); curT = t; curCols = [c]; }
    }
    rowTimes.push(curT);
    rowCols.push(curCols);
    const singleIdx = [];
    for (let i = 0; i < rowTimes.length; i += 1) {
        if (rowCols[i].length === 1) singleIdx.push(i);
    }
    const nS = singleIdx.length;
    if (nS < 5) return null;
    const leftCount = handLayoutOf(kTotal)[0].length;
    const handOf = (c) => (c < leftCount ? 0 : 1);
    const loNps = v11Cfg("rotLo", RC_ROT_LO_NPS);
    const hiNps = v11Cfg("rotHi", RC_ROT_HI_NPS);
    const delta = v11Cfg("rotDelta", RC_ROT_DELTA);
    const reach = v11Cfg("rotReach", RC_ROT_REACH_MS);
    const raw = new Float64Array(nS);
    const WIN = 8;
    const wLen = Math.min(WIN, nS);
    for (let k = 0; k < nS; k += 1) {
        const w0 = Math.max(0, Math.min(nS - wLen, k - (wLen >> 1)));
        const ts = [];
        const ls = [];
        for (let q = 0; q < wLen; q += 1) {
            const ri = singleIdx[w0 + q];
            ts.push(rowTimes[ri]);
            ls.push(rowCols[ri][0]);
        }
        const span = ts[wLen - 1] - ts[0];
        if (!(span > 1e-6)) continue;
        const rate = (wLen - 1) / (span / 1000.0);
        const distinct = new Set(ls).size;
        // 成对相位：同一手相邻两轨的「对拍」配对占比（取两种相位中较大者）。
        let same0 = 0;
        let c0 = 0;
        for (let q = 0; q + 1 < wLen; q += 2) {
            c0 += 1;
            if (handOf(ls[q]) === handOf(ls[q + 1]) && Math.abs(ls[q] - ls[q + 1]) === 1) same0 += 1;
        }
        let same1 = 0;
        let c1 = 0;
        for (let q = 1; q + 1 < wLen; q += 2) {
            c1 += 1;
            if (handOf(ls[q]) === handOf(ls[q + 1]) && Math.abs(ls[q] - ls[q + 1]) === 1) same1 += 1;
        }
        const pairFrac = Math.max(c0 > 0 ? same0 / c0 : 0.0, c1 > 0 ? same1 / c1 : 0.0);
        const sRot = Math.max(0.0, Math.min(1.0, (distinct - 2) / 2.0));
        const sShape = Math.max(0.0, Math.min(1.0, (pairFrac - 0.34) / 0.66));
        const sRate = rcRotSmoothstep((rate - loNps) / Math.max(1e-6, hiNps - loNps));
        raw[k] = delta * sRate * sShape * sRot;
    }
    // 把单键行得分摊到合并行（同刻/邻刻加权，避免边界硬跳变）
    const out = new Float64Array(mergedTimes.length);
    let ptr = 0;
    for (let j = 0; j < mergedTimes.length; j += 1) {
        const t = mergedTimes[j];
        while (ptr + 1 < nS && Math.abs(rowTimes[singleIdx[ptr + 1]] - t) <= Math.abs(rowTimes[singleIdx[ptr]] - t)) ptr += 1;
        let wsum = 0.0;
        let acc = 0.0;
        for (let k = ptr; k >= 0; k -= 1) {
            const dt = t - rowTimes[singleIdx[k]];
            if (dt > reach) break;
            const w = Math.exp(-0.5 * (dt / reach) * (dt / reach));
            acc += w * raw[k];
            wsum += w;
        }
        for (let k = ptr + 1; k < nS; k += 1) {
            const dt = rowTimes[singleIdx[k]] - t;
            if (dt > reach) break;
            const w = Math.exp(-0.5 * (dt / reach) * (dt / reach));
            acc += w * raw[k];
            wsum += w;
        }
        out[j] = wsum > 0.0 ? Math.exp(-acc / wsum) : 1.0;
    }
    return out;
}

export function calculateFixedDensity(source, rate = 1.0, options = {}) {
    const parsed = resolveParsed(source, options?.cvtFlag ?? null);
    if (parsed?.status === "NotMania") {
        throw new Error("Beatmap mode is not mania");
    }
    if (parsed?.status === "Fail") {
        throw new Error("Beatmap parse failed");
    }

    const rawLanes = collectLanes(parsed);
    const kTotal = rawLanes.length;
    if (kTotal < 1) {
        return { rcValue: Number.NaN, lnValue: Number.NaN, rcSequence: null, lnSequence: null, rcTicks: [], lnTicks: [] };
    }

    // LN 长度门 / 判定窗依赖 OD；缺失（<0）时回退 8.0（与 benchmark 一致）。
    const odRaw = Number(parsed?.od);
    const od = (Number.isFinite(odRaw) && odRaw >= 0.0) ? odRaw : 8.0;

    // 变速：时间戳按 1/rate 缩放（rate=1 时不变）。
    const rateNorm = normalizeRate(rate);
    const invRate = 1.0 / rateNorm;
    const lanes = invRate === 1.0
        ? rawLanes
        : rawLanes.map((lane) => lane.map((n) => ({ t: n.t * invRate, len: n.len * invRate })));

    let noteCount = 0;
    const onsetSet = new Set();
    for (const lane of lanes) {
        noteCount += lane.length;
        for (const n of lane) {
            onsetSet.add(n.t);
        }
    }
    const allOnsets = Array.from(onsetSet).sort((a, b) => a - b);
    const onsetCount = allOnsets.length;
    const chord = noteCount / Math.max(onsetCount, 1);
    const lnN = Math.log(Math.max(noteCount, 1));

    const laneTimes = lanes.map((lane) => lane.map((n) => n.t));
    const laneGroups = laneTimes.map(groupLane);
    const laneGroupTimes = laneGroups.map((gs) => gs.map((g) => g.t));
    const laneGroupSizes = laneGroups.map((gs) => gs.map((g) => g.size));

    // 6K 手内轨道布局（4K = 每手两轨；6K = 每手三轨，含 12/23 重叠配对）
    const hands = handLayoutOf(kTotal);
    const handOfLane = new Array(kTotal).fill(null);
    for (const hand of hands) {
        for (let r = 0; r < hand.length; r += 1) {
            handOfLane[hand[r]] = { hand, rank: r };
        }
    }

    // RC 通道：逐轨贡献（softmax 合并 + 邻域额外 contribution）
    const laneContribsList = [];
    for (let i = 0; i < kTotal; i += 1) {
        const info = handOfLane[i];
        const mateIdx = info ? handMateOf(info.hand, info.rank) : i;
        laneContribsList.push(laneContribs(
            laneGroups[i],
            laneGroupTimes[mateIdx],
            laneGroupSizes[mateIdx],
        ));
    }

    // 单轨局部熵乘子（贡献层）：contribution *= exp(γ_lane · irr_lane(t))
    if (IRR_GAIN_LANE !== 0.0) {
        for (let i = 0; i < kTotal; i += 1) {
            const tt = laneGroupTimes[i];
            if (tt.length === 0) {
                continue;
            }
            const ent = localIrregularity(tt);
            const contribs = laneContribsList[i];
            for (let k = 0; k < tt.length; k += 1) {
                contribs[k] *= Math.exp(IRR_GAIN_LANE * ent[k]);
            }
        }
    }

    // 单手两轨左右不均：时间衰减序列乘子
    if (HAND_IMB_ETA !== 0.0) {
        const allNoteTimes = [];
        for (const lane of lanes) {
            for (const n of lane) {
                allNoteTimes.push(n.t);
            }
        }
        // kernelSumSeries 需要升序输入；allNoteTimes 按轨道拼接，全局未必有序。
        allNoteTimes.sort((a, b) => a - b);
        const handWeights = handImbalanceWeights(laneGroups, laneGroupTimes, allNoteTimes);
        for (let i = 0; i < kTotal; i += 1) {
            const contribs = laneContribsList[i];
            const w = handWeights[i];
            for (let k = 0; k < contribs.length; k += 1) {
                contribs[k] *= 1.0 + HAND_IMB_ETA * w[k] / (1.0 + w[k]);
            }
        }
    }

    // 第一级合并：手内相邻双轨配对（softmax 合并为一条赋值序列）
    //   4K：每手 1 对 → (0,1)、(2,3)
    //   6K：每手 2 对重叠窗口 → 12 = (0,1) / (3,4)，23 = (1,2) / (4,5)
    const pairBandSequence = (start, mate) => {
        const groupsA = laneGroups[start];
        const groupsB = laneGroups[mate];
        if (groupsA.length === 0 && groupsB.length === 0) {
            return [];
        }
        const timesA = laneGroupTimes[start];
        const sizesA = laneGroupSizes[start];

        let unionTimes;
        let counts;
        let curveA;
        let curveB;
        if (mate === start) {
            unionTimes = timesA;
            counts = sizesA;
            curveA = laneCurve(timesA, laneContribsList[start], unionTimes);
            curveB = curveA;
        } else {
            const merged = mergeGroupSizes(timesA, sizesA, laneGroupTimes[mate], laneGroupSizes[mate]);
            unionTimes = merged.times;
            counts = merged.countsA.map((v, idx) => v + merged.countsB[idx]);
            curveA = laneCurve(timesA, laneContribsList[start], unionTimes);
            curveB = laneCurve(laneGroupTimes[mate], laneContribsList[mate], unionTimes);
        }

        const seq = [];
        if (mate === start) {
            for (let k = 0; k < unionTimes.length; k += 1) {
                if (counts[k] > 0) {
                    seq.push([unionTimes[k], curveA[k], counts[k]]);
                }
            }
        } else {
            for (let k = 0; k < unionTimes.length; k += 1) {
                const c = counts[k];
                if (c <= 0) {
                    continue;
                }
                seq.push([unionTimes[k], mergeOp(curveA[k], curveB[k]), c]);
            }
        }
        return seq;
    };

    // 手内合并层（仅当一手 > 2 轨，即 6K）：把 12 与 23 两条配对序列按 2-范数合并。
    //   时刻取手内三轨并集（= 两条配对序列并集）；物件数取手内并集计数（中轨不重复计）。
    //   合并式：v = HAND_NORM_SCALE * (v12^p + v23^p)^(1/p)，p = HAND_NORM_P = 2。
    const mergeHandBands = (hand, bands) => {
        let handTimes = laneGroupTimes[hand[0]];
        let handSizes = laneGroupSizes[hand[0]];
        for (let r = 1; r < hand.length; r += 1) {
            const merged = mergeGroupSizes(handTimes, handSizes,
                laneGroupTimes[hand[r]], laneGroupSizes[hand[r]]);
            handTimes = merged.times;
            handSizes = merged.countsA.map((v, idx) => v + merged.countsB[idx]);
        }
        const queryTimes = Float64Array.from(handTimes);
        const bandValues = bands.map((seq) => sampleDecay(seq, queryTimes));
        const invP = 1.0 / HAND_NORM_P;
        const out = [];
        for (let k = 0; k < queryTimes.length; k += 1) {
            const c = handSizes[k];
            if (!(c > 0)) {
                continue;
            }
            let acc = 0.0;
            for (const vals of bandValues) {
                acc += Math.pow(vals[k], HAND_NORM_P);
            }
            out.push([queryTimes[k], HAND_NORM_SCALE * Math.pow(acc, invP), c]);
        }
        return out;
    };

    const handSequences = [];
    for (const hand of hands) {
        const bands = [];
        for (let r = 0; r + 1 < hand.length; r += 1) {
            const seq = pairBandSequence(hand[r], hand[r + 1]);
            if (seq.length > 0) {
                bands.push(seq);
            }
        }
        if (bands.length === 0) {
            continue;
        }
        if (bands.length === 1) {
            handSequences.push(bands[0]);
        } else {
            handSequences.push(mergeHandBands(hand, bands));
        }
    }

    // 第二级合并：双手序列视为赋值突变衰减函数，逐时刻 softmax 合并
    RC11_KTOTAL = kTotal;
    let mergedSeq = [];
    for (const seq of handSequences) {
        mergedSeq = mergeDecaySequences(mergedSeq, seq);
    }

    // 全谱局部熵乘子（最终合并层）：v(t) *= exp(γ_global · irr_global(t))
    if (IRR_GAIN_GLOBAL !== 0.0 && mergedSeq.length > 0) {
        const mergedTimes = Float64Array.from(mergedSeq, (row) => row[0]);
        const gEnt = localIrregularity(allOnsets);
        const e = entropyAt(allOnsets, gEnt, mergedTimes);
        for (let k = 0; k < mergedSeq.length; k += 1) {
            mergedSeq[k][1] *= Math.exp(IRR_GAIN_GLOBAL * e[k]);
        }
    }

    // 双手合并层：left/right 同刻 chord/协调权重（纯单键/stream 的 s=0）
    if (IRR_GAIN_CROSS !== 0.0 && mergedSeq.length > 0) {
        const mergedTimes = Float64Array.from(mergedSeq, (row) => row[0]);
        const crossW = crossHandWeight(lanes, allOnsets);
        const e = entropyAt(allOnsets, crossW, mergedTimes);
        for (let k = 0; k < mergedSeq.length; k += 1) {
            mergedSeq[k][1] *= Math.exp(IRR_GAIN_CROSS * e[k]);
        }
    }

    // RC v10：逐事件局部物理维度乘子（仅 4K）
    const rc10Feat = ((kTotal === 4 || kTotal === 6 || kTotal === 7) && mergedSeq.length > 0)
        ? rc10LocalFeatures(lanes, kTotal, Float64Array.from(mergedSeq, (row) => row[0]))
        : null;
    const rc10Mult = rc10LocalMultiplier(rc10Feat);
    // RC v13：高密度单键轮换折叠乘子（仅 4K；6K/7K 返回 null，行为不变）
    const rcRotMult = (kTotal === 4 && mergedSeq.length > 0)
        ? rcRotDiscount(lanes, kTotal, Float64Array.from(mergedSeq, (row) => row[0]))
        : null;

    let totalCount = 0;
    for (const row of mergedSeq) {
        totalCount += row[2];
    }
    if (totalCount === 0) {
        return { rcValue: Number.NaN, lnValue: Number.NaN, rcSequence: null, lnSequence: null, rcTicks: [], lnTicks: [] };
    }

    const mergedValues = new Float64Array(totalCount);
    let idx = 0;
    for (let rowIdx = 0; rowIdx < mergedSeq.length; rowIdx += 1) {
        const row = mergedSeq[rowIdx];
        const rowMul = (rc10Mult ? rc10Mult[rowIdx] : 1.0) * (rcRotMult ? rcRotMult[rowIdx] : 1.0);
        const v = row[1] * rowMul;
        const c = row[2];
        for (let k = 0; k < c; k += 1) {
            mergedValues[idx] = v;
            idx += 1;
        }
    }

    const n = findNQuantile(mergedValues, QUANTILE);
    if (!Number.isFinite(n) || n <= 0.0) {
        return { rcValue: Number.NaN, lnValue: Number.NaN, rcSequence: null, lnSequence: null, rcTicks: [], lnTicks: [] };
    }
    // LN 通道的密度尺度 n 不吸收 RC 专用的轮换折叠：roll 折扣只影响 RC 的感知
    // 难度，LN 基准（103 张）按 b1.0.6 口径标定，这里用「不含轮换折扣」的同一
    // 分位数，保证 LN 数值与 b1.0.6 逐位一致（6K/7K 无折扣，直接复用 n）。
    let nNoRot = n;
    if (rcRotMult) {
        const noRotValues = new Float64Array(totalCount);
        let nr = 0;
        for (let rowIdx = 0; rowIdx < mergedSeq.length; rowIdx += 1) {
            const row = mergedSeq[rowIdx];
            const v = row[1] * (rc10Mult ? rc10Mult[rowIdx] : 1.0);
            for (let k = 0; k < row[2]; k += 1) {
                noRotValues[nr] = v;
                nr += 1;
            }
        }
        const nQ = findNQuantile(noRotValues, QUANTILE);
        if (Number.isFinite(nQ) && nQ > 0.0) nNoRot = nQ;
    }

    // 6K：使用 b1.0.5.1 专用映射层；其余键数沿用 beta_1.0.5 的 4K 映射曲线
    MAP_ACTIVE = (kTotal === 6) ? MAP_PROFILE_6K
        : (kTotal === 7) ? MAP_PROFILE_7K
        : MAP_PROFILE_4K;
    // RC v8：结构特征修正层（连续、无量纲；κ 全 0 时与 beta_1.0.5 逐位一致）
    const rcFeat = rcV8Features(laneTimes, noteCount, onsetCount);
    // 交互项（连续、无量纲；与 _analysis/tune_rc_v8e.py 的 basis() 一致）
    rcFeat.ix_both_lanealt = rcFeat.f_both * rcFeat.f_lanealt;
    rcFeat.ix_both_bothrow = rcFeat.f_both * rcFeat.f_bothrow;
    rcFeat.ix_both_osc = rcFeat.f_both * rcFeat.f_osc;
    rcFeat.ix_both_bal = rcFeat.f_both * rcFeat.f_bal;
    rcFeat.ix_bal_notes = rcFeat.f_bal * rcFeat.f_notes;
    rcFeat.ix_jack_notes = rcFeat.f_jack * rcFeat.f_notes;
    rcFeat.ix_jack_hmax = rcFeat.f_jack * rcFeat.f_handmax;
    rcFeat.ix_dbl_hmax = rcFeat.f_dbl * rcFeat.f_handmax;
    rcFeat.ix_chord_notes = rcFeat.f_chord * rcFeat.f_notes;
    rcFeat.ix_hmax_chord = rcFeat.f_handmax * rcFeat.f_chord;
    rcFeat.ix_osc_notes = rcFeat.f_osc * rcFeat.f_notes;
    rcFeat.ix_lanealt_notes = rcFeat.f_lanealt * rcFeat.f_notes;
    rcFeat.ix_notes_bothrow = rcFeat.f_notes * rcFeat.f_bothrow;
    rcFeat.ix_jack_chord = rcFeat.f_jack * rcFeat.f_chord;
    rcFeat.ix_jack_osc = rcFeat.f_jack * rcFeat.f_osc;
    rcFeat.ix_lanealt_jack = rcFeat.f_lanealt * rcFeat.f_jack;
    rcFeat.ix_dbl_chord = rcFeat.f_dbl * rcFeat.f_chord;
    rcFeat.ix_both_notes = rcFeat.f_both * rcFeat.f_notes;
    // v10：废弃 29 项全局标量层（键型拟合产物），改由逐事件局部物理维度乘子承担。
    const rcFeatDelta = 0.0;
    const gPred = Math.log(n) - FIT_E_CHORD * chord - FIT_D_LNN * lnN + rcFeatDelta;
    if (typeof globalThis !== "undefined" && globalThis.__RC_DEBUG_MODE) {
        globalThis.__RC_DEBUG = {
            n, chord, lnN, noteCount, onsetCount, kTotal, laneTimes, rcFeat,
            gPred, rcFeatDelta,
            mergedTimes: Float64Array.from(mergedSeq, (row) => row[0]),
            mergedRaw: Float64Array.from(mergedSeq, (row) => row[1]),
            mergedCounts: Float64Array.from(mergedSeq, (row) => row[2]),
            rc10Feat,
            rcRotMult,
            mapInvertFn: mapInvert,
            mapForwardFn: mapForward,
            fitEChord: FIT_E_CHORD,
            fitDLnn: FIT_D_LNN,
            nQuantile: QUANTILE,
        };
    }
    // 映射层输出（rcRawValue）是 4K/6K/7K 各自的映射尺度；6K/7K 再经段位对齐
    // 折线换算成「段位 = 整数」的显示尺度（4K 已是该结构，identity）。
    const rcRawValue = mapInvert(gPred);
    const rcValue = fixedDensityDanAlign(rcRawValue, kTotal);
    const rcDanTier = fdDanTier(kTotal);

    // ---- 难度-进度图序列（RC / LN 逐物件赋值）----
    // RC：合并序列的逐物件贡献（时间/值）。每个物件映射到 value 尺度：
    //   value = mapInvert(ln(raw) − (E·chord + D·lnN))，与 rc_value 同一映射。
    const rcValueConst = FIT_E_CHORD * chord + FIT_D_LNN * lnN - rcFeatDelta;
    const rcSeqTimes = [];
    const rcSeqRaw = [];
    const rcSeqValue = [];
    const rcSeqWeights = [];
    for (let rowIdx = 0; rowIdx < mergedSeq.length; rowIdx += 1) {
        const row = mergedSeq[rowIdx];
        const rowMul = (rc10Mult ? rc10Mult[rowIdx] : 1.0) * (rcRotMult ? rcRotMult[rowIdx] : 1.0);
        const raw = row[1] * rowMul;
        const count = row[2];
        const val = raw > 0.0 ? mapInvert(Math.log(raw) - rcValueConst) : -60.0;
        const weight = raw > 0.0 ? 1.0 : 0.0;
        for (let k = 0; k < count; k += 1) {
            rcSeqTimes.push(row[0]);
            rcSeqRaw.push(raw);
            rcSeqValue.push(val);
            rcSeqWeights.push(weight);
        }
    }
    const rcTicks = [];
    const rcSeqValueSorted = Float64Array.from(rcSeqValue).sort();
    const rcP75 = rcSeqValueSorted.length > 0 ? quantileLinear(rcSeqValueSorted, CHART_ANCHOR_Q_RC) : rcValue;
    const rcMean = weightedMean(rcSeqValue, rcSeqWeights);
    // 先按未平移值算出 400ms 平滑曲线的采样值（只用 value），再决定锚点：
    // 默认把曲线自身的 rcCurveAnchorQuantile 分位（0.875）平移成整谱 rc_value，
    // 标线落在曲线 q90 附近，曲线整体被削减，仅顶部约 10% 的采样越过标线。
    const rcGridStart = rcSeqTimes.length > 0 ? rcSeqTimes[0] : 0.0;
    const rcGridEnd = rcSeqTimes.length > 0 ? rcSeqTimes[rcSeqTimes.length - 1] : 0.0;
    const rcCurveUnshifted = smoothAssignmentSequence(
        rcSeqTimes, rcSeqValue, rcSeqWeights, rcGridStart, rcGridEnd, null,
    );
    const rcCurveAnchorQ = Number.isFinite(CHART_CFG.rcCurveAnchorQuantile)
        ? Math.min(1.0, Math.max(0.0, CHART_CFG.rcCurveAnchorQuantile))
        : 0.875;
    const rcCurveSorted = Float64Array.from(rcCurveUnshifted.value).sort();
    const rcCurveQ = rcCurveSorted.length > 0 ? quantileLinear(rcCurveSorted, rcCurveAnchorQ) : Number.NaN;
    // 值对齐：默认把曲线分位平移成整谱 rc_value；也可在 config.js 把 anchorMode
    // 设为 "quantile" 退回旧分位对齐（逐物件分位）。
    const rcAnchorBase = CHART_ANCHOR_MODE === "mean" && Number.isFinite(rcCurveQ)
        ? rcCurveQ
        : (Number.isFinite(rcMean) ? rcMean : rcP75);
    const rcDelta = rcRawValue - rcAnchorBase;
    if (Number.isFinite(rcDelta)) {
        for (let i = 0; i < rcSeqValue.length; i += 1) {
            rcSeqValue[i] += rcDelta;
        }
    }
    if (rcDanTier) {
        // 6K/7K：刻度直接取整数段位 k，换算回映射层尺度再求 raw（与 4K 的
        // 整数 value 刻度同构；">Finish++" 等哨兵档不画刻度）。
        const tickMax = rcDanTier.names.length - 2;
        for (let k = 0; k <= tickMax; k += 1) {
            const raw = Math.exp(
                mapForward(fixedDensityDanUnalign(k, kTotal) - rcDelta) + rcValueConst,
            );
            if (Number.isFinite(raw) && raw > 0.0) {
                rcTicks.push({ value: k, raw });
            }
        }
    } else {
        for (let v = 0; v <= 34; v += 1) {
            // 平移后的 value 尺度：整数刻度 v 对应原始 value = v - rcDelta
            const raw = Math.exp(mapForward(v - rcDelta) + rcValueConst);
            if (Number.isFinite(raw) && raw > 0.0) {
                rcTicks.push({ value: v, raw });
            }
        }
    }
    const rcAnchor = {
        value: rcValue,
        raw: Number.isFinite(rcAnchorBase) ? Math.exp(mapForward(rcAnchorBase) + rcValueConst) : Number.NaN,
        label: fixedDensityRcLabel(rcValue, kTotal),
    };
    // 平滑：400ms 窗口内所有物件（等权）的加权均值，每 100ms 采样，空窗口 = 0。
    const rcToRaw = (v) => Math.exp(mapForward(v - rcDelta) + rcValueConst);
    const rcSmoothed = {
        times: rcCurveUnshifted.times,
        value: rcCurveUnshifted.value.map((v, i) => (rcCurveUnshifted.hasData[i] ? v + rcDelta : 0.0)),
        raw: rcCurveUnshifted.value.map((v, i) => (rcCurveUnshifted.hasData[i] ? rcToRaw(v + rcDelta) : rcToRaw(0.0))),
    };
    const rcYMaxHint = sequenceYMaxHint(rcSeqValue, rcToRaw);

    // LN 通道的局部密度输入：RC 合并序列的逐物件 contribution（时间/值）。
    // 时间轴与 RC 一致（已按 1/rate 缩放）；查询时用 释手时刻 × 1/rate。
    const lnDensityTimes = new Float64Array(totalCount);
    const lnDensityValues = new Float64Array(totalCount);
    let densityIdx = 0;
    for (const row of mergedSeq) {
        const c = row[2];
        for (let k = 0; k < c; k += 1) {
            lnDensityTimes[densityIdx] = row[0];
            lnDensityValues[densityIdx] = row[1];
            densityIdx += 1;
        }
    }
    const lnDensity = { times: lnDensityTimes, values: lnDensityValues };

    const lnMult = lnMultiplier(rawLanes, od, rateNorm, lnDensity);
    const k = lnMult.k;
    let nForLn = nNoRot;
    if (LN_OWN_N_MODE !== 0) {
        const nLn = lnOwnQuantileN(rawLanes, od, 1.0 / rateNorm, lnDensity);
        if (Number.isFinite(nLn) && nLn > 0.0) {
            nForLn = nLn;
        }
    }
    // LN 也与 RC 用同一段位对齐折线（6K/7K 无独立 LN 段位参考，两通道数值尺度接近），
    // 使 LN 胶囊的数字同样等于段位序号；4K 保持原 ln 尺度。
    const lnRawValue = lnFromRawMapped(k, nForLn);
    const lnValue = fixedDensityLnAlign(lnRawValue, kTotal);

    // LN 逐松手事件的赋值：γ 加权结构量 × F(ρ)（与 k 的组件一致），再映射到
    // ln_value 尺度：value = A·ln(1 + B·raw·n)，与图上整数 ln 标注线互为反函数。
    const lnSeqTimes = [];
    const lnSeqValue = [];
    const lnSeqWeights = [];
    if (lnMult.events.length > 0) {
        const factor = lnMult.factor;
        const absorb = lnMult.absorb;
        const valid = lnMult.valid;
        // 逐事件未缩放赋值 u_i 与整谱 k 的比值：把 u_i 缩放到「其聚合分位 = k」的尺度，
        // 使图上逐事件 value 的分位与 ln_value 对齐（否则逐事件求和普遍高于聚合值）。
        const uArr = new Float64Array(lnMult.events.length);
        for (let i = 0; i < lnMult.events.length; i += 1) {
            const ev = lnMult.events[i];
            uArr[i] = factor * (
                LN_MULT_REL * ev.rel * absorb * valid * rateNorm
                + LN_MULT_JACK * ev.jack * absorb * valid * rateNorm
                + LN_MULT_ADJ * ev.adj * absorb * valid * rateNorm
                + LN_MULT_CROSS * ev.cross * valid
                + LN_MULT_HOLD * ev.hold * valid
            );
        }
        const uAgg = lnAggregate(uArr);
        const scale = (k > 0.0 && uAgg > 0.0) ? k / uAgg : 1.0;
        for (let i = 0; i < lnMult.events.length; i += 1) {
            const raw = uArr[i] * scale;
            const val = lnFromRawMapped(raw, nForLn);
            lnSeqTimes.push(lnMult.events[i].t * invRate);
            lnSeqValue.push(val);
            lnSeqWeights.push(Number.isFinite(lnMult.events[i].w) && lnMult.events[i].w > 0.0 ? lnMult.events[i].w : 1.0);
        }
    }
    const lnTicks = [];
    const lnAnchor = { value: lnValue, raw: Number.NaN, label: fixedDensityLnLabel(lnValue, kTotal) };
    let lnDelta = 0.0;
    if (lnSeqValue.length > 0) {
        const lnSeqValueSorted = Float64Array.from(lnSeqValue).sort();
        const lnP75 = quantileLinear(lnSeqValueSorted, CHART_ANCHOR_Q_LN);
        const lnMean = weightedMean(lnSeqValue, lnSeqWeights);
        const lnAnchorBase = CHART_ANCHOR_MODE === "mean" && Number.isFinite(lnMean) ? lnMean : lnP75;
        lnDelta = lnRawValue - lnAnchorBase;
        if (Number.isFinite(lnDelta)) {
            for (let i = 0; i < lnSeqValue.length; i += 1) {
                lnSeqValue[i] += lnDelta;
            }
        }
        if (nForLn > 0.0 && Number.isFinite(lnAnchorBase)) {
            lnAnchor.raw = lnRawFromValue(lnAnchorBase, nForLn);
        }
        if (nForLn > 0.0) {
            if (rcDanTier) {
                // 6K/7K：刻度取整数段位，换算回 LN 映射尺度再求 raw。
                const tickMax = rcDanTier.names.length - 2;
                for (let k = 0; k <= tickMax; k += 1) {
                    const raw = lnRawFromValue(fixedDensityLnUnalign(k, kTotal) - lnDelta, nForLn);
                    if (Number.isFinite(raw) && raw > 0.0) {
                        lnTicks.push({ value: k, raw });
                    }
                }
            } else {
                for (let v = 0; v <= 40; v += 1) {
                    const raw = lnRawFromValue(v - lnDelta, nForLn);
                    if (Number.isFinite(raw) && raw > 0.0) {
                        lnTicks.push({ value: v, raw });
                    }
                }
            }
        }
    }

    // LN 曲线的平滑：窗口内只统计 LN 松手事件（按长度权重 w 加权），
    // 每 100ms 采样、400ms 窗口；窗口内没有 LN 事件时该点直接为 0。
    const lnEventCount = lnSeqTimes.length;
    const lnToRaw = nForLn > 0.0
        ? (v) => lnRawFromValue(v - lnDelta, nForLn)
        : null;
    const lnYMaxHint = sequenceYMaxHint(lnSeqValue, lnToRaw);
    const gridT0 = rcSeqTimes.length > 0 ? rcSeqTimes[0] : (lnSeqTimes.length > 0 ? lnSeqTimes[0] : 0.0);
    const gridT1 = rcSeqTimes.length > 0
        ? rcSeqTimes[rcSeqTimes.length - 1]
        : (lnSeqTimes.length > 0 ? lnSeqTimes[lnSeqTimes.length - 1] : 0.0);
    const lnSmoothed = (lnEventCount > 0 && lnToRaw)
        ? smoothAssignmentSequence(lnSeqTimes, lnSeqValue, lnSeqWeights, gridT0, gridT1, lnToRaw,
            CHART_LN_SMOOTH_WINDOW_MS, CHART_LN_SMOOTH_STEP_MS)
        : { times: [], value: [], raw: [] };

    const __debug = (options && options.debug)
        ? {
            keyCount: kTotal,
            hands,
            rcMapProfile: kTotal === 6 ? "6k" : (kTotal === 7 ? "7k" : "4k"),
            totalCount,
            n,
            chord,
            noteCount,
            lnN,
            gPred,
            k,
            nForLn,
            lnRaw1p: Math.log1p(LN_B * k * nForLn),
            rcValue,
            lnValue,
        }
        : null;
    return {
        ...(__debug ? { __debug } : {}),
        rcValue,
        lnValue,
        rcSequence: { times: rcSmoothed.times, raw: rcSmoothed.raw, value: rcSmoothed.value, yMax: rcYMaxHint, smoothed: true },
        lnSequence: { times: lnSmoothed.times, raw: lnSmoothed.raw, value: lnSmoothed.value, eventCount: lnEventCount, yMax: lnYMaxHint, smoothed: true },
        rcTicks,
        lnTicks,
        rcAnchor,
        lnAnchor,
    };
}

export default calculateFixedDensity;

// ---- 数字上方的文字说明：段位名 + 分段名 ----

// 希腊字母表小写：11→α、12→β … 34→ω
const FD_GREEK_LOWER = [
    "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ",
    "ν", "ξ", "ο", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω",
];

// 分段名：按小数部分以 .1/.3/.5/.7/.9 分段
// [.1,.3)→"+"、[.3,.5)→"++"、[.5,.7)→"--"、[.7,.9)→"-"、其余（[.9,1)∪[0,.1)）→""
function fixedDensitySegment(value) {
    const frac = value - Math.floor(value);
    if (frac < 0.1) {
        return "";
    }
    if (frac < 0.3) {
        return "+";
    }
    if (frac < 0.5) {
        return "++";
    }
    if (frac < 0.7) {
        return "--";
    }
    if (frac < 0.9) {
        return "-";
    }
    return "";
}

// 6K/7K 段位表：数字胶囊上方的注释显示真实段位名（4K 仍用 rf/希腊字母），
// 且数字本身就是段位序号（12 → Mystery / Azimuth），结构与 4K 一致：
//   段位 = Math.round(值)，段内后缀复用 4K 的 fixedDensitySegment 五段规则。
// alignX = benchmark-6krc / benchmark-7krc 各档参考谱 rc 中位数的逐档中位
// （第 i 档中位数 → 整数 i），alignY = 段位序号；fixedDensityDanAlign /
// fixedDensityDanUnalign 是这条分段折线的互逆映射（端部按端点斜率外推），
// 把映射层输出换算到「段位 = 整数」的尺度，刻度再换算回映射层尺度取 raw。
export const FD_DAN_TIERS = {
    6: {
        names: ["Start", "reg1", "reg2", "reg3", "reg4", "reg5", "reg6", "reg7", "reg8", "reg9",
            "Terra", "Celestial", "Mystery", "Nihility", "Finish", ">Finish++"],
        alignX: [0.52131, 1.32158, 2.13058, 3.43904, 4.25881, 5.20134, 6.38824, 6.99854, 8.08379,
            8.93621, 9.99773],
        alignY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        // LN 段位对齐：线性，锚点 = 零 LN 谱的映射下限（0.47022 → 0）与 14 档
        // LN 参考谱中位（15.298/16.381 → 14）。6K/7K 的 lnValue 与段位近似线性，
        // 逐档中位数在低档不单调（每档仅 4 首），故不用逐档折线。
        lnAlignA: 0.47022,
        lnAlignB: 1.05913,
    },
    7: {
        names: ["reg0", "reg1", "reg2", "reg3", "reg4", "reg5", "reg6", "reg7", "reg8", "reg9", "reg10",
            "Gamma", "Azimuth", "Zenith", "Stellium", ">Stellium++"],
        alignX: [0.16633, 0.87391, 2.30470, 3.38495, 3.93047, 5.19532, 6.46276, 6.76134, 8.24082,
            8.29002, 8.91378, 10.81547, 11.64099, 13.24058, 14.57033],
        alignY: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        lnAlignA: 0.47022,
        lnAlignB: 1.13648,
    },
};

function fdDanTier(keyCount) {
    return FD_DAN_TIERS[Number(keyCount)] || null;
}

// 分段线性：映射层尺度 → 段位尺度（第 i 档中位数恰好等于整数 i）。
export function fixedDensityDanAlign(value, keyCount) {
    const tier = fdDanTier(keyCount);
    if (!tier || !Number.isFinite(value)) {
        return value;
    }
    const xs = tier.alignX;
    const ys = tier.alignY;
    const n = Math.min(xs.length, ys.length);
    if (n < 2) {
        return value;
    }
    if (value <= xs[0]) {
        return ys[0] + (value - xs[0]) * ((ys[1] - ys[0]) / (xs[1] - xs[0]));
    }
    if (value >= xs[n - 1]) {
        return ys[n - 1] + (value - xs[n - 1]) * ((ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2]));
    }
    let i = 0;
    while (i < n - 2 && value >= xs[i + 1]) {
        i += 1;
    }
    const t = (value - xs[i]) / (xs[i + 1] - xs[i]);
    return ys[i] + t * (ys[i + 1] - ys[i]);
}

// 逆映射：段位尺度 → 映射层尺度（图表的整数段位刻度换算回 raw 时用）。
export function fixedDensityDanUnalign(value, keyCount) {
    const tier = fdDanTier(keyCount);
    if (!tier || !Number.isFinite(value)) {
        return value;
    }
    const xs = tier.alignX;
    const ys = tier.alignY;
    const n = Math.min(xs.length, ys.length);
    if (n < 2) {
        return value;
    }
    if (value <= ys[0]) {
        return xs[0] + (value - ys[0]) * ((xs[1] - xs[0]) / (ys[1] - ys[0]));
    }
    if (value >= ys[n - 1]) {
        return xs[n - 1] + (value - ys[n - 1]) * ((xs[n - 1] - xs[n - 2]) / (ys[n - 1] - ys[n - 2]));
    }
    let i = 0;
    while (i < n - 2 && value >= ys[i + 1]) {
        i += 1;
    }
    const t = (value - ys[i]) / (ys[i + 1] - ys[i]);
    return xs[i] + t * (xs[i + 1] - xs[i]);
}

// LN 的段位对齐：线性（ln ≈ a + b·段位），与 RC 的逐档折线各自独立标定。
// 映射层对「几乎无 LN」的谱会给 0~0.47 的下限值（与谱面 n 有关），对齐后可能略为负；
// LN 不存在「低于 Start」的真实含义，故下限截到 0（显示 0.00 / Start / reg0）。
export function fixedDensityLnAlign(value, keyCount) {
    const tier = fdDanTier(keyCount);
    if (!tier || !Number.isFinite(value) || !(tier.lnAlignB > 0)) {
        return value;
    }
    return Math.max(0, (value - tier.lnAlignA) / tier.lnAlignB);
}

export function fixedDensityLnUnalign(value, keyCount) {
    const tier = fdDanTier(keyCount);
    if (!tier || !Number.isFinite(value) || !(tier.lnAlignB > 0)) {
        return value;
    }
    return tier.lnAlignA + tier.lnAlignB * value;
}

// 段内后缀：与 4K 的 fixedDensitySegment 同义（按与最近整数的偏移给 +/++/--/-）。
function fixedDensityDanSuffix(offset) {
    const a = Math.abs(offset);
    if (!Number.isFinite(a) || a < 0.1) {
        return "";
    }
    if (a < 0.3) {
        return offset > 0 ? "+" : "-";
    }
    return offset > 0 ? "++" : "--";
}

// 段位序号：四舍五入到最近整数档；负值归首档，≥末档（">..." 档）直接返回末档。
function fixedDensityDanIndex(value, tier) {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded)) {
        return -1;
    }
    const last = tier.names.length - 1;
    if (rounded >= last) {
        return last;
    }
    return rounded < 0 ? 0 : rounded;
}

// 图表刻度只看段位名（4K 刻度的 rfN 同样不带后缀）；胶囊注释才带段内后缀。
export function fixedDensityDanTickLabel(value, keyCount) {
    const tier = fdDanTier(keyCount);
    if (!tier || !Number.isFinite(value)) {
        return "";
    }
    const i = fixedDensityDanIndex(value, tier);
    return i < 0 ? "" : tier.names[i];
}

function fixedDensityDanLabel(value, tier) {
    const last = tier.names.length - 1;
    const i = fixedDensityDanIndex(value, tier);
    if (i < 0) {
        return "";
    }
    if (i >= last) {
        return tier.names[last];
    }
    // 低于首档（负值）用 value 自身作偏移，其余用与最近整数的偏移。
    const offset = value < 0 ? value : value - Math.round(value);
    return tier.names[i] + fixedDensityDanSuffix(offset);
}

// rc 段位名：≤10 → "rf<k>"；≥11 → 希腊小写（11→α、14→δ …）；≥34.5 → 直接 ">ω++"。
export function fixedDensityRcLabel(value, keyCount) {
    if (!Number.isFinite(value)) {
        return "";
    }
    const danTier = FD_DAN_TIERS[Number(keyCount)];
    if (danTier) {
        return fixedDensityDanLabel(value, danTier);
    }
    const rounded = Math.round(value);
    if (value >= 34.5 || rounded - 11 >= FD_GREEK_LOWER.length) {
        return ">ω++";
    }
    const tier = rounded <= 10 ? `rf${rounded}` : FD_GREEK_LOWER[rounded - 11];
    return tier + fixedDensitySegment(value);
}

// ln 段位名："ln<k>"。
export function fixedDensityLnLabel(value, keyCount) {
    if (!Number.isFinite(value)) {
        return "";
    }
    const danTier = FD_DAN_TIERS[Number(keyCount)];
    if (danTier) {
        return fixedDensityDanLabel(value, danTier);
    }
    return `ln${Math.round(value)}${fixedDensitySegment(value)}`;
}
