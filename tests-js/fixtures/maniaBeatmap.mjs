export function makeManiaBeatmap({ keys = 4, pattern = "mixed", count = 240 } = {}) {
    const lines = [
        "osu file format v14", "[General]", "Mode:3", "[Metadata]",
        "Title:曲线回归测试", "Artist:Fixture", `Version:${keys}K ${pattern}`,
        "[Difficulty]", `CircleSize:${keys}`, "OverallDifficulty:8",
        "[TimingPoints]", "0,500,4,2,1,50,1,0", "[HitObjects]",
    ];
    let time = 1000;
    for (let index = 0; index < count; index += 1) {
        const rotation = pattern === "crosshand" ? [0, 2, 1, 3] : [0, 1, 2, 3];
        const lane = pattern === "roll" || pattern === "crosshand"
            ? rotation[index % 4] : index % keys;
        const x = Math.floor((lane + 0.5) * 512 / keys);
        const hold = pattern === "ln" || (pattern === "mixed" && index % 3 === 0);
        lines.push(hold
            ? `${x},192,${time},128,0,${time + 230}:0:0:0:`
            : `${x},192,${time},1,0,0:0:0:0:`);
        time += pattern === "roll" || pattern === "crosshand"
            ? 31.25 : [180, 110, 220, 80][Math.floor(index / 60) % 4];
    }
    return lines.join("\n");
}
