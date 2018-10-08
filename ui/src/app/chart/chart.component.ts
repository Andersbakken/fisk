import { Component, AfterViewInit, NgZone } from '@angular/core';
import { FiskService } from '../fisk.service';
import { ConfigService } from '../config.service';
import { MessageService } from '../message.service';
import * as PIXI from 'pixi.js/dist/pixi.js'

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
    slaveTimer: any = undefined;
    clientAdjustTimer: any = undefined;
    renderer: any = undefined;
    stage: any = undefined;
    step: number = undefined;

    constructor(private fisk: FiskService, private ngZone: NgZone,
                private config: ConfigService, private message: MessageService) {
        this.fisk.on("data", (data: any) => {
            this.ngZone.runOutsideAngular(() => {
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
        });
        this.fisk.on("open", () => {
            this.ngZone.runOutsideAngular(() => {
                this._clear();
            });
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
            this.ngZone.runOutsideAngular(() => {
                const div = document.getElementById("chart");
                const rect: any = div.getBoundingClientRect();
                this.view.width = window.innerWidth - ((rect.x * 2) + 50);
                this.view.height = window.innerHeight - rect.y - 50;

                // this.svg
                //     .attr("width", this.view.width)
                //     .attr("height", this.view.height);

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

    clicked(event) {
        console.log(event);
    }

    ngAfterViewInit() {
        this.ngZone.runOutsideAngular(() => {
            const div = document.getElementById("chart");
            const rect: any = div.getBoundingClientRect();
            this.view.width = window.innerWidth - ((rect.x * 2) + 50);
            this.view.height = window.innerHeight - rect.y - 50;

            const resolution = window.devicePixelRatio;
            this.renderer = PIXI.autoDetectRenderer(this.view.width, this.view.height,
                                                    { transparent: true, antialias: true,
                                                      resolution: resolution, autoResize: true });
            this.step = 0.5;// 1 / Math.max(3 - resolution, 1);
            console.log("fisk ui resolution", resolution, "step", this.step);
            this.stage = new PIXI.Container();
            div.appendChild(this.renderer.view);

            const step = (item, props, steps) => {
                if (!("step" in item))
                    return;
                let done = true;
                const step = item.step;
                for (let i = 0; i < props.length; ++i) {
                    const src = props[i];
                    const dst = "d" + props[i];
                    if (item[src] < item[dst]) {
                        item[src] = Math.min(item[src] + (step * steps), item[dst]);
                    } else if (item[src] > item[dst]) {
                        item[src] = Math.max(item[src] - (step * steps), item[dst]);
                    }
                    if (done && item[src] != item[dst])
                        done = false;
                }
                if (done) {
                    delete item.step;
                    for (let i = 0; i < props[length]; ++i) {
                        delete item["d" + props[i]];
                    }
                }
            };

            const framems = (1 / 60) * 1000;

            let last = 0;
            let animate = (ts) => {
                const steps = Math.ceil((ts - last) / framems);
                //console.log(steps, "steps since last", ts - last);
                last = ts;

                for (let sk in this.slaves) {
                    const slave = this.slaves[sk];

                    const ellipse = slave.ellipse;
                    ellipse.clear();
                    ellipse.beginFill(ellipse.color);
                    ellipse.drawEllipse(ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry);
                    ellipse.endFill();

                    const halo = slave.halo;
                    step(halo, ["rx", "ry"], steps);

                    halo.clear();
                    halo.beginFill(0);
                    halo.drawEllipse(halo.cx, halo.cy, halo.rx + halo.stroke, halo.ry + halo.stroke);
                    halo.endFill();
                    halo.beginFill(halo.color);
                    halo.drawEllipse(halo.cx, halo.cy, halo.rx, halo.ry);
                    halo.endFill();

                    const clip = slave.clip;
                    clip.clear();
                    clip.beginFill(0xffffff);
                    clip.drawEllipse(halo.cx, halo.cy, halo.rx + halo.stroke, halo.ry + halo.stroke);
                    clip.endFill();
                }

                for (let ck in this.clients) {
                    const client = this.clients[ck];

                    const rect = client.rect;

                    //step(rect, ["rx", "rwidth"], steps);

                    rect.clear();
                    rect.beginFill(rect.color);
                    rect.drawRect(rect.rx, rect.ry, rect.rwidth, rect.rheight);
                    rect.endFill();

                    const clip = client.clip;
                    clip.clear();
                    clip.beginFill(0xffffff);
                    clip.drawRect(rect.rx, rect.ry, rect.rwidth, rect.rheight);
                    clip.endFill();

                    //step(client.text, ["x"], steps);
                }

                this.renderer.render(this.stage);
                window.requestAnimationFrame(animate);
            };

            window.requestAnimationFrame(animate);
        });
    }

    _clear() {
        for (var k in this.slaves) {
            let slave = this.slaves[k];
            slave.ellipse.destroy();
            slave.halo.destroy();
            slave.text.destroy();
        }
        this.slaves = {};
        for (var k in this.clients) {
            let client = this.clients[k];
            client.rect.destroy();
            client.text.destroy();
        }
        this.clients = {};
        this.jobs = {};
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

        return (r * 255) << 16 | (g * 255) << 8 | (b * 255);
    }

    _slaveAdded(slave) {
        const key = slave.ip + ":" + slave.port;
        if (key in this.slaves) {
            console.error("slave already exists", slave);
            return;
        }
        const halo = new PIXI.Graphics();
        halo.color = this._color(key, true);
        halo.stroke = 2;
        this.stage.addChild(halo);
        const ellipse = new PIXI.Graphics();
        ellipse.color = this._color(key, false);
        this.stage.addChild(ellipse);
        const text = new PIXI.Text(key, { fontSize: 16 });
        const clip = new PIXI.Graphics();
        text.mask = clip;
        this.stage.addChild(text);
        this.slaves[key] = { slave: slave, ellipse: ellipse, halo: halo, text: text, clip: clip, jobs: 0 };
        if (this.slaveTimer)
            clearTimeout(this.slaveTimer);
        this.slaveTimer = setTimeout(() => { this.ngZone.runOutsideAngular(() => { this._rearrangeSlaves(); }); }, 250);
    }

    _slaveRemoved(slave) {
        const key = slave.ip + ":" + slave.port;
        if (!(key in this.slaves)) {
            console.error("slave does not exist", slave);
            return;
        }
        let slaveobj = this.slaves[key];
        slaveobj.ellipse.destroy();
        slaveobj.halo.destroy();
        slaveobj.text.destroy();
        delete this.slaves[key];
        if (this.slaveTimer)
            clearTimeout(this.slaveTimer);
        this.slaveTimer = setTimeout(() => { this.ngZone.runOutsideAngular(() => { this._rearrangeSlaves(); }); }, 250);
    }

    _ellipseX(slave, grow) {
        return (50 + (slave.jobs * (grow ? 4 : 0))) * Math.SQRT2;
    }

    _ellipseY(slave, grow) {
        return (25 + (slave.jobs * (grow ? 4 : 0))) * Math.SQRT2;
    }

    _adjustSlave(slave) {
        slave.halo.drx = this._ellipseX(slave, true) + 1;
        slave.halo.dry = this._ellipseY(slave, true) + 1;
        slave.halo.step = this.step;
    }

    _jobStarted(job) {
        if (job.id in this.jobs) {
            console.error("job already exists", job);
            return;
        }

        const name = (id, name) => {
            return id + name.replace(/-/g, "");
        };

        const slaveKey = job.slave.ip + ":" + job.slave.port;
        const clientKey = job.client.ip;
        if (!(clientKey in this.clients)) {
            const rectName = name("rect", job.client.name);
            const rect = new PIXI.Graphics();
            rect.ry = this.view.height - 30;
            rect.rheight = 30;
            rect.color = this._color(clientKey, false);
            this.stage.addChild(rect);
            let clientData: { client: any, rect: any, text: any, clip: undefined, jobs: number, name: string } = {
                client: job.client, rect: rect, text: undefined, clip: undefined, jobs: 1, name: job.client.name
            };
            const text = new PIXI.Text(`${clientData.name} (${clientData.jobs} jobs)`, { fontSize: 16 });
            text.y = this.view.height - 25;
            const clip = new PIXI.Graphics();
            text.mask = clip;
            this.stage.addChild(text);
            clientData.text = text;
            clientData.clip = clip;
            this.clients[clientKey] = clientData;
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
                client.rect.destroy();
                client.text.destroy();
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
        if (this.clientAdjustTimer)
            return;
        this.clientAdjustTimer = setTimeout(() => {
            this.clientAdjustTimer = undefined;
            this.ngZone.runOutsideAngular(() => {
                let total = 0;
                for (let k in this.clients) {
                    total += this.clients[k].jobs;
                }
                let x = 0;
                for (let k in this.clients) {
                    const client = this.clients[k];
                    const width = (client.jobs / total) * this.view.width;
                    // if (!("rx" in client.rect)) {
                        client.rect.rx = x;
                    // } else {
                    //     client.rect.drx = x;
                    //     client.rect.step = this.step;
                    // }
                    // if (!("rwidth" in client.rect)) {
                        client.rect.rwidth = width;
                    // } else {
                    //     client.rect.drwidth = width;
                    //     client.rect.step = this.step;
                    // }
                    client.text.text = `${client.name} (${client.jobs} jobs)`;
                    // if (!("x" in client.text)) {
                        client.text.x = x + 5;
                    // } else {
                    //     client.text.dx = x + 5;
                    //     client.text.step = this.step;
                    // }
                    x += width;
                }
            });
        }, 250);
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

            slave.ellipse.cx = width / 2 + Math.cos(angle) * xr;
            slave.ellipse.cy = height / 2 + Math.sin(angle) * yr;
            slave.ellipse.rx = this._ellipseX(slave, false);
            slave.ellipse.ry = this._ellipseY(slave, false);
            slave.halo.cx = width / 2 + Math.cos(angle) * xr;
            slave.halo.cy = height / 2 + Math.sin(angle) * yr;
            slave.halo.rx = this._ellipseX(slave, true) + 1;
            slave.halo.ry = this._ellipseY(slave, true) + 1;
            slave.text.position.x = (width / 2 + Math.cos(angle) * xr) - (45 * Math.SQRT2);
            slave.text.position.y = (height / 2 + Math.sin(angle) * yr) - (5 * Math.SQRT2);
            angle += step;
            ++i;
        }
    }
}
