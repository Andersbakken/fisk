class Peak {
    constructor(interval, name)
    {
        this.interval = interval;
        this.name = name;
        this.peakActiveJobs = 0;
        this.peakActiveJobsTime = Date.now();
        this.peakUtilization = 0;
        this.peakUtilizationTime = Date.now();
    }

    record(now, activeJobs, utilization)
    {
        const cutoff = now - this.interval;
        let ret = false;
        if (activeJobs > this.peakActiveJobs || (this.interval && this.peakActiveJobsTime <= cutoff)) {
            this.peakActiveJobs = activeJobs;
            this.peakActiveJobsTime = now;
            ret = true;
        }

        if (utilization > this.peakUtilization || (this.interval && this.peakUtilizationTime <= cutoff)) {
            this.peakUtilization = utilization;
            this.peakUtilizationTime = now;
            ret = true;
        }
        return ret;
    }

    toObject()
    {
        const cutoff = this.interval ? Date.now() - this.interval : 0;
        return {
            activeJobs: (this.peakActiveJobsTime >= cutoff ? this.peakActiveJobs : 0),
            utilization: (this.peakUtilizationTime >= cutoff ? this.peakUtilization : 0)
        };
    }
};

module.exports = Peak;
