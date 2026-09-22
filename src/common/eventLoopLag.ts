import type { Options } from "@jhanssen/options";

// A stalled event loop stops calling accept(), the listen backlog fills and the
// kernel then silently drops SYNs, which clients see as a connect timeout rather
// than a refusal. It leaves no trace by the time anyone runs ss(8), so record it
// here with timestamps that can be correlated against client-side timeouts.
export function monitorEventLoopLag(option: Options, name: string): void {
    const intervalMs = option.int("event-loop-lag-interval", 100);
    const thresholdMs = option.int("event-loop-lag-threshold", 250);
    const summaryIntervalMs = option.int("event-loop-lag-summary-interval", 60000);

    if (intervalMs <= 0) {
        return;
    }

    let maxLag = 0;
    let stalls = 0;
    let expected = Date.now() + intervalMs;

    const tick = (): void => {
        const now = Date.now();
        const lag = now - expected;
        if (lag > maxLag) {
            maxLag = lag;
        }
        if (lag >= thresholdMs) {
            ++stalls;
            console.log(`${name} event-loop-lag stall ${lag}ms at ${new Date(now).toISOString()}`);
        }
        // Schedule off "now" rather than accumulating on expected, otherwise a
        // single long stall reports as a stall on every subsequent tick.
        expected = now + intervalMs;
        setTimeout(tick, intervalMs).unref();
    };
    setTimeout(tick, intervalMs).unref();

    if (summaryIntervalMs > 0) {
        setInterval(() => {
            console.log(
                `${name} event-loop-lag summary max=${maxLag}ms stalls=${stalls} over last ${summaryIntervalMs}ms (threshold ${thresholdMs}ms)`
            );
            maxLag = 0;
            stalls = 0;
        }, summaryIntervalMs).unref();
    }
}
