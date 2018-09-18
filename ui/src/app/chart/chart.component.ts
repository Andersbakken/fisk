import { Component, AfterViewInit, NgZone } from '@angular/core';
import { FiskService } from '../fisk.service';
import { ConfigService } from '../config.service';
import { MessageService } from '../message.service';
import * as d3 from 'd3';

@Component({
  selector: 'app-chart',
  templateUrl: './chart.component.html',
  styleUrls: ['./chart.component.css']
})
export class ChartComponent implements AfterViewInit {
    private host: string;
    private port: number;

    title = 'app';
    data: any = undefined;

    view: any = { width: 0, height: 0 };
    slaves: any = {};
    clients: any = {};
    jobs: any = {};
    svg: any = undefined;
    slaveTimer: any = undefined;

    constructor(private fisk: FiskService, private ngZone: NgZone,
                private config: ConfigService, private message: MessageService) {
        this.fisk.on("data", (data: any) => {
            // console.log("hello", data);
            // this.ngZone.run(() => {
            switch (data.type) {
            case "slaveAdded":
                this._slaveAdded(data);
                break;
            case "slaveRemove":
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
            // });
        });
        this.fisk.on("open", () => {
            this.message.showMessage("connected to " + this.host + ":" + this.port);
        });
        this.config.onChange((key: string) => {
            switch (key) {
            case "host":
            case "port":
                this.reconnect(this.config.get("host", location.hostname), this.config.get("port", location.port || 80));
                break;
            }
        });
        const host = this.config.get("host");
        if (host !== undefined) {
            this.reconnect(host, this.config.get("port", 8097));
        }

        window.addEventListener("resize", () => {
            //console.log(window.innerWidth, window.innerHeight);
            this.ngZone.run(() => {
                const div = document.getElementById("chart");
                const rect: any = div.getBoundingClientRect();
                this.view.width = window.innerWidth - ((rect.x * 2) + 50);
                this.view.height = window.innerHeight - rect.y - 50;

                this.svg
                    .attr("width", this.view.width)
                    .attr("height", this.view.height);

                this._rearrangeSlaves();
            });
        });
    }

    private reconnect(host: string, port: number) {
        this.host = host;
        this.port = port;

        this.fisk.close();
        this.fisk.open(host, port);
    }

    onSelect(event) {
        console.log(event);
    }

    ngAfterViewInit() {
        const div = document.getElementById("chart");
        const rect: any = div.getBoundingClientRect();
        this.view.width = window.innerWidth - ((rect.x * 2) + 50);
        this.view.height = window.innerHeight - rect.y - 50;

        this.svg = d3.select("#chart")
            .append("svg")
            .attr("width", this.view.width)
            .attr("height", this.view.height);
        this.clients.g = this.svg.append("g");
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

        const random = Alea(key);
        var h = rand(1, 360, random);
        var s = rand(0, 100, random);
        var l = Math.max(rand(0, 100, random), 45);

        if (invert) {
            s = 100 - s;
        }

        return 'hsl(' + h + ',' + s + '%,' + l + '%)';
    }

    _slaveAdded(slave) {
        const key = slave.ip + ":" + slave.port;
        if (key in this.slaves) {
            console.error("slave already exists", slave);
            return;
        }
        const halo = this.svg.append("ellipse").attr("fill", this._color(key, true)).attr("stroke": "black").attr("stroke-width": 2);
        const ellipse = this.svg.append("ellipse").attr("fill", this._color(key, false));
        const text = this.svg.append("text").text(() => { return key; });
        this.slaves[key] = { slave: slave, ellipse: ellipse, halo: halo, text: text, jobs: 0 };
        if (this.slaveTimer)
            clearTimeout(this.slaveTimer);
        this.slaveTimer = setTimeout(() => { this._rearrangeSlaves(); }, 250);
    }

    _slaveRemoved(slave) {
        const key = slave.ip + ":" + slave.port;
        if (!(key in this.slaves)) {
            console.error("slave does not exist", slave);
            return;
        }
        delete this.slaves[key];
        if (this.slaveTimer)
            clearTimeout(this.slaveTimer);
        this.slaveTimer = setTimeout(() => { this._rearrangeSlaves(); }, 250);
    }

    _ellipseX(slave, grow) {
        return (50 + (slave.jobs * (grow ? 4 : 0))) * Math.SQRT2;
    }

    _ellipseY(slave, grow) {
        return (25 + (slave.jobs * (grow ? 4 : 0))) * Math.SQRT2;
    }

    _adjustSlave(slave) {
        slave.halo
            .transition()
            .attr("rx", this._ellipseX(slave, true) + 1)
            .attr("ry", this._ellipseY(slave, true) + 1)
            .duration(200);
    }

    _jobStarted(job) {
        if (job.id in this.jobs) {
            console.error("job already exists", job);
            return;
        }
        const slaveKey = job.slave.ip + ":" + job.slave.port;
        const clientKey = job.client.ip;
        const clientName = job.client.name;
        if (!(clientKey in this.clients)) {
            const rect = this.clients.g.append("rect")
                .attr("y", this.view.height - 30)
                .attr("height", 30)
                .attr("fill", this._color(clientKey, false));
            const text = this.svg.append("text")
                .attr("y", this.view.height - 12)
                .text(() => { return clientName; });
            this.clients[clientKey] = { client: job.client, rect: rect, text: text, jobs: 1 };
        } else {
            ++this.clients[clientKey].jobs;
        }
        const slave = this.slaves[slaveKey];
        if (!slave) {
            console.error("can't find slave", job);
            return;
        }
        this.jobs[job.id] = { slave: slaveKey, client: clientKey };
        ++slave.jobs;

        this._adjustSlave(slave);
        this._adjustClients();
    }

    _jobFinished(job) {
        if (!(job.id in this.jobs)) {
            console.error("no such job", job);
            return;
        }
        const jobData = this.jobs[job.id];
        delete this.jobs[job.id];
        const slave = this.slaves[jobData.slave];
        const client = this.clients[jobData.client];
        if (client) {
            if (!--client.jobs) {
                client.rect.remove();
                client.text.remove();
                delete this.clients[jobData.client];
            }
            this._adjustClients();
        }
        if (!slave) {
            console.error("can't find slave", job, jobData.slave);
            return;
        }
        if (!slave.jobs) {
            console.error("slave jobs already at 0", job, slave);
            return;
        }
        --slave.jobs;

        this._adjustSlave(slave);
    }

    _adjustClients() {
        let total = 0;
        for (let k in this.clients) {
            if (k === "g")
                continue;
            total += this.clients[k].jobs;
        }
        let x = 0;
        for (let k in this.clients) {
            if (k === "g")
                continue;
            const client = this.clients[k];
            const width = (client.jobs / total) * this.view.width;
            client.rect
                .transition()
                .attr("x", x)
                .attr("width", width)
                .duration(100);
            client.text
                .transition()
                .attr("x", x + 5)
                .duration(100);
            x += width;
        }
    }

    _rearrangeSlaves() {
        const count = Object.keys(this.slaves).length;
        const nodesPerRing = 20;
        const ringCount = Math.floor(count / nodesPerRing) + 1;
        const radiusFactor = 2.8;
        const width = this.view.width;
        const height = this.view.height;
        const xRadius = Math.round(width / radiusFactor);
        const yRadius = Math.round(height / radiusFactor);
        const step = 2 * Math.PI / count;
        let angle = 0;
        let i = 0;

        for (let key in this.slaves) {
            const slave = this.slaves[key];
            // console.log("rearranging slave", key, slave.ellipse);

            const factor = 1 - (1 / (ringCount + 1)) * (i % ringCount);
            const xr = xRadius * factor;
            const yr = yRadius * factor;

            slave.ellipse
                .attr("cx", width / 2 + Math.cos(angle) * xr)
                .attr("cy", height / 2 + Math.sin(angle) * yr)
                .attr("rx", this._ellipseX(slave, false))
                .attr("ry", this._ellipseY(slave, false));
            slave.halo
                .attr("cx", width / 2 + Math.cos(angle) * xr)
                .attr("cy", height / 2 + Math.sin(angle) * yr)
                .attr("rx", this._ellipseX(slave, true) + 1)
                .attr("ry", this._ellipseY(slave, true) + 1);
            slave.text
                .attr("x", (width / 2 + Math.cos(angle) * xr) - (45 * Math.SQRT2))
                .attr("y", (height / 2 + Math.sin(angle) * yr) + (3 * Math.SQRT2));
            angle += step;
            ++i;
        }
    }
}
