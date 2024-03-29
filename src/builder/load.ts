import EventEmitter from "events";
import os from "os";

// some code taken from https://gist.github.com/bag-man/5570809

//Create function to get CPU information
function cpuAverage(): { idle: number; total: number } | undefined {
    //Initialise sum of idle and time of cores and fetch CPU info
    let totalIdle = 0,
        totalTick = 0;
    const cpus: os.CpuInfo[] = os.cpus();

    if (!(cpus instanceof Array)) {
        return undefined;
    }

    //Loop through CPU cores
    for (let i = 0, len = cpus.length; i < len; i++) {
        //Select CPU core
        const cpu = cpus[i];

        //Total up the time in the cores tick
        totalTick += cpu.times.user;
        totalTick += cpu.times.nice;
        totalTick += cpu.times.sys;
        totalTick += cpu.times.idle;
        totalTick += cpu.times.irq;

        //Total up the idle time of the core
        totalIdle += cpu.times.idle;
    }

    //Return the average Idle and Tick times
    return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
}

//Grab first CPU Measure
let startMeasure = cpuAverage();

function measure(): number | undefined {
    //Grab second Measure
    const endMeasure = cpuAverage();

    let percentageCPU;
    if (endMeasure && startMeasure) {
        //Calculate the difference in idle and total time between the measures
        const idleDifference = endMeasure.idle - startMeasure.idle;
        const totalDifference = endMeasure.total - startMeasure.total;
        //Calculate the average percentage CPU usage
        percentageCPU = 100 - ~~((100 * idleDifference) / totalDifference);
    }

    //Next measure will diff against this measure
    startMeasure = endMeasure;

    return percentageCPU ? percentageCPU / 100 : undefined;
}

class Load extends EventEmitter {
    private _interval?: NodeJS.Timeout;

    constructor() {
        super();
        this._interval = undefined;
    }

    get running(): boolean {
        return this._interval !== undefined;
    }

    start(interval: number): void {
        if (this._interval !== undefined) {
            throw new Error("Interval already running");
        }
        this._interval = setInterval(() => {
            const m = measure();
            if (m) {
                this.emit("data", m);
            }
        }, interval);
    }

    stop(): void {
        if (!this._interval) {
            throw new Error("No interval running");
        }
        clearInterval(this._interval);
        this._interval = undefined;
    }
}

export const load = new Load();
