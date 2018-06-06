const EventEmitter = require("events");
const os = require("os");

// some code taken from https://gist.github.com/bag-man/5570809

//Create function to get CPU information
function cpuAverage() {

    //Initialise sum of idle and time of cores and fetch CPU info
    let totalIdle = 0, totalTick = 0;
    const cpus = os.cpus();

    //Loop through CPU cores
    for(let i = 0, len = cpus.length; i < len; i++) {

        //Select CPU core
        let cpu = cpus[i];

        //Total up the time in the cores tick
        for(let type in cpu.times) {
            totalTick += cpu.times[type];
        }

        //Total up the idle time of the core
        totalIdle += cpu.times.idle;
    }

    //Return the average Idle and Tick times
    return {idle: totalIdle / cpus.length,  total: totalTick / cpus.length};
}

//Grab first CPU Measure
let startMeasure = cpuAverage();

function measure() {
    //Grab second Measure
    const endMeasure = cpuAverage();

    //Calculate the difference in idle and total time between the measures
    const idleDifference = endMeasure.idle - startMeasure.idle;
    const totalDifference = endMeasure.total - startMeasure.total;

    //Next measure will diff against this measure
    startMeasure = endMeasure;

    //Calculate the average percentage CPU usage
    const percentageCPU = 100 - ~~(100 * idleDifference / totalDifference);

    return percentageCPU / 100;
};

class Load extends EventEmitter {
    constructor() {
        super();
        this._interval = undefined;
    }

    running() {
        return this._interval !== undefined;
    }

    start(interval) {
        if (this._interval !== undefined)
            throw new Error("Interval already running");
        this._interval = setInterval(() => {
            this.emit("data", measure());
        }, interval);
    }

    stop() {
        if (!this._interval)
            throw new Error("No interval running");
        clearInterval(this._interval);
        this._interval = undefined;
    }
}

module.exports = new Load();
