export const APP_CONFIG = {
    endpoint: "http://localhost:24050/files/beatmap/file",
    socketHost: "localhost:24050",

    options: {
        contentBar: ["None", "Auto", "Pattern", "Etterna", "Graph", "ReworkPP", "Full"],
        srText: ["Auto", "ReworkSR", "MSD", "Pattern", "InterludeSR", "ReworkPP", "Fixed Density v1"],
        diffText: ["None", "Graph", "Difficulty", "MSD", "Pattern", "ReworkSR", "InterludeSR"],
        estimatorAlgorithm: ["Azusa", "Roxy", "Mixed", "Sunny", "Daniel", "Companella", "SunnyWindow"],
        etternaVersion: ["0.68.0-Unofficial", "0.70.0", "0.72.0", "0.72.3", "0.74.0"],
        companellaEtternaVersion: ["0.68.0-Unofficial", "0.70.0", "0.72.0", "0.72.3", "0.74.0"],
        cardOpacity: ["100%", "95%", "90%", "80%", "70%"],
        cardRadius: ["Small", "Medium", "Large"],
        cardBgBlur: ["Off", "4px", "8px", "12px", "16px", "20px"],
        reverseCardExtendDirection: [true, false],
        modeTag: ["RC", "LN", "HB", "Mix", "SV"],
    },

    starStops: {
        background: [
            [0.0, "#aaaaaa"],
            [0.9, "#4bb3fd"],
            [2.0, "#4fffd5"],
            [3.0, "#d3f557"],
            [4.0, "#fda265"],
            [5.0, "#f94d79"],
            [6.0, "#b64cc1"],
            [7.0, "#5654ca"],
            [8.0, "#14117d"],
            [9.0, "#000000"],
            [9999.9, "#000000"],
        ],
        text: [
            [0.0, "#000000"],
            [6.49, "#000000"],
            [6.5, "#ffd966"],
            [8.9, "#ffd966"],
            [9.0, "#f6f05c"],
            [10.0, "#ff7a69"],
            [11.0, "#e74a95"],
            [12.0, "#9a57ce"],
            [12.39, "#6563de"],
            [9999.9, "#6563de"],
        ],
    },

    etterna: {
        maxSkillValue: 45.0,
        vibroJackspeedRatioThreshold: 0.95,
    },

    // Fixed Density 难度-进度双图的全局标定（2026-10-27）
    // anchorMode："mean"（默认）= 把 RC 平滑曲线自身的 rcCurveAnchorQuantile 分位
    //   （默认 0.875 = 曲线 q87.5）对齐胶囊值，标线落在曲线 q87.5 附近、曲线整体被削减；
    //   "quantile" = 旧行为，把逐物件 value 的 anchorQuantile* 分位平移到胶囊值
    //   （平滑后均值天然低于该分位，曲线会整体偏低）。
    // anchorQuantile*：仅 anchorMode="quantile" 时生效。
    // rcCurveAnchorQuantile：RC 曲线锚点分位（0~1）；调大会进一步压低曲线。
    // ticksAbove/Below：锚线以上/以下各画多少条整数标注线。
    // smoothWindowMs/StepMs：曲线平滑窗口与采样步长（窗口内加权均值，空窗口=0）。
    // lnSmoothWindowMs/StepMs：LN 曲线单独配置；LN 取样点稀疏，默认用 1000ms 窗口压平起伏
    // （未配置时 lnSmoothStepMs 回退 smoothStepMs）。
    fixedDensityCharts: {
        anchorMode: "mean",
        anchorQuantileRc: 0.75,
        anchorQuantileLn: 0.88,
        rcCurveAnchorQuantile: 0.875,
        ticksAbove: 4,
        ticksBelow: 8,
        minTickLineGapPx: 4,
        minTickLabelGapPx: 7,
        maxTickLabels: 10,
        smoothWindowMs: 400,
        smoothStepMs: 100,
        lnSmoothWindowMs: 1000,
        lnSmoothStepMs: 100,
    },

    graph: {
        viewboxWidth: 260,
        viewboxHeight: 86,
        paddingX: 6,
        paddingTop: 8,
        paddingBottom: 6,
        resampleIntervalMs: 100,
        loadingSampleCount: 20,
        loadingWaveCycles: 2.5,
        loadingWaveAmplitude: 7,
        loadingBaseOffset: 22,
        pauseLineColor: "#FF3B3B",
        pauseLineWidth: 2,
    },

    timing: {
        songTimeJumpThresholdMs: 2000,
        noteEndMarginMs: 500,
        socketRecalcLazyDelayMs: 200,
        settingsCommandTimeoutMs: 1500,
        pauseDetectEpsilonMs: 0,
        pauseDetectionThresholdMs: 500,
    },

    defaults: {
        wsEndpoint: "localhost:24050",
        autoMode: false,
        useDanielAlgorithm: false,
        estimatorAlgorithm: "Mixed",
        azusaSunnyReferenceHo: true,
        etternaVersion: "0.72.3",
        companellaEtternaVersion: "0.74.0",
        pauseDetectionEnabled: true,
        pauseDetectionThresholdMs: 500,
        enableEtternaRainbowBars: false,
        enableStatusMarquee: true,
        vibroDetection: true,
        disableVibroDetection: false,
        useSvDetection: true,
        display6kLevel: true,
        extendedEstimationRange: false,
        showModeTagCapsule: true,
        enableNumericDifficulty: true,
        cardVisibility: "Always",
        cardOpacity: "95%",
        cardRadius: "Medium",
        cardBgBlur: "4px",
        enableUpdateCheck: true,
        enableResultCache: true,
        reverseCardExtendDirection: false,
        useOsuFont: true,
        enableOsuTheme: true,
        enableFloatingTriangles: true,
        enableCoverArt: true,
        customBackgroundColor: "#000000",
        contentBar: "Auto",
        srText: "ReworkSR",
        diffText: "Difficulty",
        debugUseAmount: false,
        forceSunnyWindow: true,
        enableLNDifficulty: false,
        enableAnalyzeLN: false,
        enableAlwaysShowLNDifficulty: false,
        enableTelemetry: true,
    },

    mods: {
        knownCodes: ["DA", "NC", "DT", "HT", "HR", "EZ", "DC", "IN", "HO", "MR", "CL", "SV2"],
        bitFlags: {
            EZ: 2,
            HR: 16,
            DT: 64,
            HT: 256,
            NC: 512,
            SV2: 536870912,
        },
    },
};
