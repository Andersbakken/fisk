export function align(commands: Array<string[]>): string[] {
    const cols: number[] = [];
    commands.forEach((x) => {
        while (cols.length < x.length) {
            cols.push(0);
        }
        x.forEach((y, idx) => {
            cols[idx] = Math.max(cols[idx], y.length);
        });
    });

    return commands.map((x) => x.map((y, idx) => y.padEnd(cols[idx])).join(" "));
}
