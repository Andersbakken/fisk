// Sliding-window maximum. Values are kept strictly decreasing from the front, so
// the front is always the peak and every sample is pushed and popped at most once.
export class WindowMax {
    private times: number[];
    private values: number[];
    private head: number;

    constructor() {
        this.times = [];
        this.values = [];
        this.head = 0;
    }

    // Returns true if nothing in the window is larger than value.
    push(now: number, cutoff: number, value: number): boolean {
        this.expire(cutoff);
        const isPeak = this.head === this.values.length || this.values[this.head] <= value;
        while (this.values.length > this.head && this.values[this.values.length - 1] <= value) {
            this.values.pop();
            this.times.pop();
        }
        this.values.push(value);
        this.times.push(now);
        return isPeak;
    }

    max(cutoff: number): number {
        this.expire(cutoff);
        return this.head < this.values.length ? this.values[this.head] : 0;
    }

    private expire(cutoff: number): void {
        while (this.head < this.times.length && this.times[this.head] <= cutoff) {
            ++this.head;
        }
        if (this.head === this.times.length) {
            this.times = [];
            this.values = [];
            this.head = 0;
        } else if (this.head > 1024 && this.head * 2 > this.times.length) {
            this.times = this.times.slice(this.head);
            this.values = this.values.slice(this.head);
            this.head = 0;
        }
    }
}
