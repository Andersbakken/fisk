import { Component, ChangeDetectorRef } from '@angular/core';
import { FiskService } from '../fisk.service';
import { ConfigService } from '../config.service';
import { MessageService } from '../message.service';
import { TabChangedService } from '../tab-changed.service';

@Component({
    selector: 'app-pie-chart',
    templateUrl: './pie-chart.component.html',
    styleUrls: ['./pie-chart.component.css']
})

export class PieChartComponent {
    view: any = { width: 0, height: 0 };
    ctx: any;
    clientColor: any;
    maxJobs: number = 0;
    maxJobsData: any = {};
    currentJobs: number = 0;
    jobs = new Map();
    clientJobs = new Map();
    pieBuilding: boolean;
    inited: boolean = false;

    constructor(private fisk: FiskService, private config: ConfigService,
                private tabChanged: TabChangedService, private message: MessageService,
                private changeRef: ChangeDetectorRef) {
        this.fisk.on("data", (data: any) => {
            switch (data.type) {
            case "slaveAdded":
                this._slaveAdded(data);
                break;
            case "slaveRemoved":
                this._slaveRemoved(data);
                break;
            case "jobStarted":
                this._jobStarted(data);
                break;
            case "jobFinished":
            case "jobAborted":
                this._jobFinished(data);
                break;
            }
        });
        this.fisk.on("open", () => {
            this._reset();
            this.message.showMessage("connected to " + this.fisk.host + ":" + this.fisk.port);
        });

        window.addEventListener("resize", () => {
            //console.log(window.innerWidth, window.innerHeight);
            const canvas = document.getElementById("canvas-chart");

            const rect: any = canvas.getBoundingClientRect();
            this.view.width = window.innerWidth - (rect.x * 2);
            this.view.height = window.innerHeight - rect.y - 50;
        });

        this.config.onChange((key: string) => {
            if (key == "client" || key == "fgcolor" || key == "bgcolor") {
                this.clientColor = { name: this.config.get("client"), fgcolor: this.config.get("fgcolor"), bgcolor: this.config.get("bgcolor") };

                this.clientJobs.forEach(c => {
                    delete c.color;
                });
            } else if (key == "pieBuilding") {
                this.pieBuilding = this.config.get("pieBuilding");
            }
        });

        this.tabChanged.onChanged((index, name) => {
            if (name != "Pie Chart" || this.inited)
                return;

            const canvas = <HTMLCanvasElement> document.getElementById("canvas-chart");
            if (!canvas)
                return;

            this.inited = true;

            const rect: any = canvas.getBoundingClientRect();

            this.view.width = window.innerWidth - (rect.x * 2);
            this.view.height = window.innerHeight - rect.y - 50;
            //console.log("hey", this.view.width, this.view.height);

            this.changeRef.detectChanges();

            this.ctx = canvas.getContext("2d", { alpha: false });

            const Step = 0.25;

            const animateItem = (item, prop, animatedProp, steps) => {
                const d = item[prop];
                if (!(animatedProp in item)) {
                    item[animatedProp] = d;
                    return;
                }
                let a = item[animatedProp];
                if (a == d)
                    return;
                if (a < d) {
                    a = Math.min(a + (Step * steps), d);
                } else {
                    a = Math.max(a - (Step * steps), d);
                }
                item[animatedProp] = a;
            };

            this.clientColor = { name: this.config.get("client"), fgcolor: this.config.get("fgcolor"), bgcolor: this.config.get("bgcolor") };
            this.pieBuilding = this.config.get("pieBuilding");

            const frameMs = (1 / 60) * 1000;
            let last = 0;
            const animate = ts => {
                const legendSpace = this.config.get("chart-legend-space", 400);
                const legendX = this.view.width - legendSpace + 10;

                const max = Math.min(this.view.width - legendSpace, this.view.height) - 20;

                const steps = (ts - last) / frameMs;
                last = ts;

                const rad = deg => {
                    return deg / (180 / Math.PI);
                };

                const ctx = this.ctx;

                ctx.fillStyle = "white";
                ctx.beginPath();
                ctx.rect(0, 0, this.view.width, this.view.height);
                ctx.fill();

                const paddingSpace = 10;
                const xy = max/2 + paddingSpace;
                const radius = max/2 - (paddingSpace*2);

                ctx.fillStyle = "#ddd";
                ctx.beginPath();
                ctx.moveTo(xy, xy);
                ctx.arc(xy, xy, radius, 0, Math.PI * 2, false);
                ctx.fill();

                if (!this.maxJobs) {
                    this.clientJobs.forEach(c => {
                        c.start = c.animatedStart = rad(270);
                        c.jobs = c.animatedJobs = 0;
                    });
                    window.requestAnimationFrame(animate);
                    return;
                }

                ctx.font = "16px sans-serif";
                let cur = rad(270);
                let legendY = 40;

                ctx.fillStyle = "black";
                ctx.fillText(this.maxJobsData.text, legendX - this.maxJobsData.width - 75, legendY);

                const maxJobs = this.pieBuilding ? this.currentJobs : this.maxJobs;
                if (!maxJobs) {
                    window.requestAnimationFrame(animate);
                    return;
                }

                this.clientJobs.forEach(c => {
                    //console.log("puck", this.maxJobs, c);
                    c.start = cur;

                    animateItem(c, "start", "animatedStart", steps);
                    animateItem(c, "jobs", "animatedJobs", steps);

                    if (!c.color) {
                        if (this.clientColor.name && this.clientColor.fgcolor && this.clientColor.bgcolor) {
                            //console.log("determening", c.client);
                            if (this.clientColor.name == c.client.ip ||
                                this.clientColor.name == c.client.name ||
                                this.clientColor.name == c.client.hostname) {
                                c.color = this.clientColor.bgcolor;
                                c.fg = this.clientColor.fgcolor;
                            }
                        }
                        if (!c.color) {
                            c.color = this._color(c.client.ip, false);

                            const rgb = parseInt(c.color.substring(1), 16);   // convert rrggbb to decimal
                            const r = (rgb >> 16) & 0xff;  // extract red
                            const g = (rgb >>  8) & 0xff;  // extract green
                            const b = (rgb >>  0) & 0xff;  // extract blue

                            var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                            if (luma < 128) {
                                c.fg = "white";
                            } else {
                                c.fg = "black";
                            }
                        }
                    }

                    // pie arc
                    ctx.fillStyle = c.color;
                    ctx.beginPath();
                    ctx.moveTo(xy, xy);
                    ctx.arc(xy, xy, radius, c.animatedStart, c.animatedStart + (Math.PI * 2 * (c.animatedJobs / maxJobs)), false);
                    ctx.lineTo(xy, xy);
                    ctx.fill();

                    // legend name background
                    ctx.beginPath();
                    ctx.rect(legendX, legendY - 20, legendSpace, 30);
                    ctx.fill();

                    // legend name text
                    ctx.fillStyle = c.fg;
                    ctx.fillText(c.client.name, legendX, legendY);

                    // legend usage
                    const usage = c.jobs + " (" + Math.round(c.jobs / maxJobs * 1000) / 10 + "%)";
                    const metrics = ctx.measureText(usage);

                    // legend usage background
                    ctx.fillStyle = c.color;
                    ctx.beginPath();
                    ctx.rect(legendX + legendSpace - metrics.width - 15, legendY - 20, metrics.width + 15, 30);
                    ctx.fill();

                    // legend usage text
                    ctx.fillStyle = c.fg;
                    ctx.fillText(usage, legendX + legendSpace - metrics.width - 10, legendY);

                    cur += Math.PI * 2 * (c.animatedJobs / maxJobs);
                    legendY += 30;
                });

                window.requestAnimationFrame(animate);
            };
            window.requestAnimationFrame(animate);
        });
    }

    _reset() {
        this.maxJobs = 0;
        this.maxJobsData = {};
        this.currentJobs = 0;
        this.jobs = new Map();
        this.clientJobs = new Map();
    }

    _color(key, invert) {
        // taken from https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript
        function Alea(seed) {
            if(seed === undefined) {seed = +new Date() + Math.random();}
            function Mash() {
                var n = 4022871197;
                return function(r) {
                    var f;
                    for(var t, s, u = 0, e = 0.02519603282416938; u < r.length; u++)
                        s = r.charCodeAt(u), f = (e * (n += s) - (n*e|0)),
                    n = 4294967296 * ((t = f * (e*n|0)) - (t|0)) + (t|0);
                    return (n|0) * 2.3283064365386963e-10;
                }
            }
            return function() {
                var m = Mash(), a = m(" "), b = m(" "), c = m(" "), x = 1, y;
                seed = seed.toString(), a -= m(seed), b -= m(seed), c -= m(seed);
                a < 0 && a++, b < 0 && b++, c < 0 && c++;
                return function() {
                    var y = x * 2.3283064365386963e-10 + a * 2091639; a = b, b = c;
                    return c = y - (x = y|0);
                };
            }();
        }

        function rand(min, max, r) {
            return min + r() * (max - min);
        }

        function tohex(d) {
            return ("0"+(Number(d).toString(16))).slice(-2);
        }

        const random = Alea(key);
        var h = rand(1, 360, random);
        var s = rand(0, 100, random);
        var l = Math.max(rand(0, 100, random), 45);

        if (invert) {
            s = 100 - s;
        }

        h /= 360;
        s /= 100;
        l /= 100;

        var r, g, b;

        if(s == 0){
            r = g = b = l; // achromatic
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            }

            var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            var p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }

        return "#" + tohex(r * 255) + tohex(g * 255) + tohex(b * 255);
    }

    _adjustClients(job, inc, init) {
        if (!this.clientJobs.has(job.client.ip)) {
            this.clientJobs.set(job.client.ip, { client: job.client, jobs: init });
        } else {
            const c = this.clientJobs.get(job.client.ip);
            c.jobs += inc;
            if (!c.jobs) {
                this.clientJobs.delete(job.client.ip);
            }
        }
    }

    _slaveId(slave) {
        return slave.ip + ":" + slave.port;
    }

    _slaveAdded(slave) {
        this.maxJobs += slave.slots;
        this._updateMaxJobsData();
    }

    _slaveRemoved(slave) {
        this.maxJobs -= slave.slots;
        this._updateMaxJobsData();
        if (this.maxJobs < 0) {
            throw new Error("Negative jobs reached!");
        }

        // clear out the jobs for this slave
        // console.log("foff", this.jobs);
        const slaveid = this._slaveId(slave);
        this.jobs.forEach((job, id) => {
            if (slaveid == this._slaveId(job.slave)) {
                this.jobs.delete(id);
                if (!this.clientJobs.has(job.client.ip)) {
                    console.error("no client job for job", job);
                    return;
                }
                this._adjustClients(job, -1, 0);
            }
        });
    }

    _updateMaxJobsData() {
        this.maxJobsData.text = "Slots " + this.currentJobs + " / " + this.maxJobs;
        this.maxJobsData.width = this.ctx.measureText(this.maxJobsData.text).width;
    }

    _jobStarted(job) {
        //console.log("job start", job.client.ip);
        this.jobs.set(job.id, job);
        this._adjustClients(job, 1, 1);

        this.currentJobs += 1;
        this._updateMaxJobsData();
    }

    _jobFinished(job) {
        if (!this.jobs.has(job.id)) {
            console.error("No such job ", job);
            return;
        }
        this.currentJobs -= 1;
        this._updateMaxJobsData();

        const realjob = this.jobs.get(job.id);
        this.jobs.delete(job.id);
        if (!this.clientJobs.has(realjob.client.ip)) {
            console.error("No client job for job", realjob);
            return;
        }
        this._adjustClients(realjob, -1, 0);
    }
}
