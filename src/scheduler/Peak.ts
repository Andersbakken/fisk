import { WindowMax } from "./WindowMax";
import type { PeakData } from "./PeakData";

// record() runs for every scheduled job. This used to keep one entry per job for
// up to 30 days and scan and splice that array, which got slow enough under load
// to stall the event loop.
export class Peak {
    private readonly actives?: WindowMax;
    private readonly utilizations?: WindowMax;
    peakActiveJobs: number;
    peakActiveJobsTime: number;
    peakUtilization: number;
    peakUtilizationTime: number;

    constructor(readonly interval: number, readonly name: string) {
        this.peakActiveJobs = 0;
        this.peakActiveJobsTime = Date.now();
        this.peakUtilization = 0;
        this.peakUtilizationTime = Date.now();
        if (interval) {
            this.actives = new WindowMax();
            this.utilizations = new WindowMax();
        }
    }

    record(now: number, activeJobs: number, utilization: number): boolean {
        let ret = false;
        if (!this.actives || !this.utilizations) {
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
            if (this.actives.push(now, cutoff, activeJobs)) {
                ret = true;
                this.peakActiveJobs = activeJobs;
                this.peakActiveJobsTime = now;
            }
            if (this.utilizations.push(now, cutoff, utilization)) {
                ret = true;
                this.peakUtilization = utilization;
                this.peakUtilizationTime = now;
            }
        }
        return ret;
    }

    toObject(): PeakData {
        if (this.actives && this.utilizations) {
            const cutoff = Date.now() - this.interval;
            return { activeJobs: this.actives.max(cutoff), utilization: this.utilizations.max(cutoff) };
        }

        return {
            activeJobs: this.peakActiveJobs,
            utilization: this.peakUtilization
        };
    }
}
