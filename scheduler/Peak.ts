import { PeakData } from "./PeakData";
import assert from "assert";

export class Peak {
    readonly interval: number;
    readonly name: string;
    peakActiveJobs: number;
    peakActiveJobsTime: number;
    peakUtilization: number;
    peakUtilizationTime: number;
    actives?: Array<[number, number]>;
    utilizations?: Array<[number, number]>;

    constructor(interval: number, name: string) {
        this.interval = interval;
        this.name = name;
        this.peakActiveJobs = 0;
        this.peakActiveJobsTime = Date.now();
        this.peakUtilization = 0;
        this.peakUtilizationTime = Date.now();
        if (interval) {
            this.actives = [];
            this.utilizations = [];
        }
    }

    record(now: number, activeJobs: number, utilization: number): boolean {
        let ret = false;
        if (!this.interval) {
            if (activeJobs > this.peakActiveJobs) {
                this.peakActiveJobs = activeJobs;
                this.peakActiveJobsTime = now;
                ret = true;
            }
            if (utilization > this.peakUtilization) {
                this.peakUtilization = utilization;
                this.peakUtilizationTime = now;
                ret = true;
            }
        } else {
            const cutoff = now - this.interval;
            let idx = 0;
            assert(this.actives);
            while (idx < this.actives.length) {
                if (this.actives[idx][0] > cutoff && this.actives[idx][1] > activeJobs) {
                    break;
                }
                ++idx;
            }
            if (idx === this.actives.length) {
                ret = true;
                this.peakActiveJobs = activeJobs;
                this.peakActiveJobsTime = now;
                this.actives = [];
            } else if (idx) {
                assert(this.actives, "Must have actives");
                this.actives.splice(0, idx);
            }
            this.actives.push([now, activeJobs]);
            idx = 0;
            assert(this.utilizations);
            while (idx < this.utilizations.length) {
                if (this.utilizations[idx][0] > cutoff && this.utilizations[idx][1] > utilization) {
                    break;
                }
                ++idx;
            }
            if (idx === this.utilizations.length) {
                ret = true;
                this.peakUtilization = utilization;
                this.peakUtilizationTime = now;
                this.utilizations = [];
            } else if (idx) {
                this.utilizations.splice(0, idx);
            }
            this.utilizations.push([now, utilization]);
        }
        return ret;
    }

    toObject(): PeakData {
        if (this.interval) {
            const cutoff = Date.now() - this.interval;
            let peakActiveJobs = 0;
            let splice = 0;
            assert(this.actives);
            for (let idx = 0; idx < this.actives.length; ++idx) {
                if (this.actives[idx][0] < cutoff) {
                    splice = idx + 1;
                } else {
                    peakActiveJobs = Math.max(peakActiveJobs, this.actives[idx][1]);
                }
            }
            if (splice) {
                this.actives.splice(0, splice);
            }
            let peakUtilization = 0;
            splice = 0;
            assert(this.utilizations, "Must have utilizations");
            for (let idx = 0; idx < this.utilizations.length; ++idx) {
                if (this.utilizations[idx][0] < cutoff) {
                    splice = idx + 1;
                } else {
                    peakUtilization = Math.max(peakUtilization, this.utilizations[idx][1]);
                }
            }
            if (splice) {
                this.utilizations.splice(0, splice);
            }
            return { activeJobs: peakActiveJobs, utilization: peakUtilization };
        }

        return {
            activeJobs: this.peakActiveJobs,
            utilization: this.peakUtilization
        };
    }
}
