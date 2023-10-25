import { options } from "./options";

export function parallelize<T>(max: number, promiseCreators: Array<() => Promise<T>>): Promise<T[]> {
    const opts = options();
    opts.verbose("parallelize called with", promiseCreators.length, "jobs");
    return new Promise<T[]>((resolve, reject) => {
        let idx = 0;
        const results: T[] = [];
        let active = 0;
        let rejected = false;
        const fill = () => {
            opts.verbose(`Fill called with idx: ${idx}/${promiseCreators.length} active: ${active}`);
            while (active < max && idx < promiseCreators.length) {
                const promise = promiseCreators[idx]();
                const then = (idx: number, result: T) => {
                    if (rejected) {
                        return;
                    }
                    results[idx] = result;
                    --active;
                    fill();
                };
                ++active;
                promise.then(then.bind(undefined, idx), (err: Error) => {
                    if (!rejected) {
                        rejected = true;
                        reject(err);
                    }
                });
                ++idx;
            }
            if (!active) {
                resolve(results);
            }
        };
        fill();
    });
}
