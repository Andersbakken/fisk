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

    view: any = { width: 1000, height: 1000 };
    slaves: any = {};
    svg: any = undefined;
    slaveTimer: any = undefined;

    constructor(private fisk: FiskService, private ngZone: NgZone,
                private config: ConfigService, private message: MessageService) {
        this.fisk.on("data", (data: any) => {
            console.log("hello", data);
            // this.ngZone.run(() => {
            switch (data.type) {
            case "slaveAdded":
                this._addSlave(data);
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
        this.svg = d3.select("#chart")
            .append("svg")
            .attr("width", this.view.width)
            .attr("height", this.view.height);
    }

    _color(key) {
        var m_w = 123456789;
        var m_z = 987654321;
        var mask = 0xffffffff;

        function hashCode(s) {
            return s.split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
        }

        // Takes any integer
        function seed(i) {
            m_w = i;
            m_z = 987654321;
        }

        // Returns number between 0 (inclusive) and 1.0 (exclusive),
        // just like Math.random().
        function random()
        {
            m_z = (36969 * (m_z & 65535) + (m_z >> 16)) & mask;
            m_w = (18000 * (m_w & 65535) + (m_w >> 16)) & mask;
            var result = ((m_z << 16) + m_w) & mask;
            result /= 4294967296;
            return result + 0.5;
        }

        function rand(min, max) {
            return min + random() * (max - min);
        }

        seed(hashCode(key));

        var h = rand(1, 360);
        var s = rand(0, 100);
        var l = rand(0, 100);
        return 'hsl(' + h + ',' + s + '%,' + l + '%)';
    }

    _addSlave(slave) {
        const key = slave.ip + ":" + slave.port;
        if (key in this.slaves) {
            console.error("slave already exists", slave);
            return;
        }
        const ellipse = this.svg.append("ellipse");
        const text = this.svg.append("text").text(d => { return key; });
        this.slaves[key] = { slave: slave, ellipse: ellipse, text: text };
        if (this.slaveTimer)
            clearTimeout(this.slaveTimer);
        this.slaveTimer = setTimeout(() => { this._rearrangeSlaves(); }, 250);
    }

    _rearrangeSlaves() {
        const count = Object.keys(this.slaves).length;
        const nodesPerRing = 20;
        const ringCount = Math.floor(count / nodesPerRing) + 1;
        const radiusFactor = 2.5;
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
                .attr("rx", 50 * Math.SQRT2)
                .attr("ry", 25 * Math.SQRT2)
                .attr("fill", this._color(key));
            slave.text
                .attr("x", (width / 2 + Math.cos(angle) * xr) - (45 * Math.SQRT2))
                .attr("y", (height / 2 + Math.sin(angle) * yr) + (3 * Math.SQRT2));
            angle += step;
            ++i;
        }
    }
}
