import { Component } from '@angular/core';
import { ConfigService } from '../config.service';
import { TabChangedService } from '../tab-changed.service';

@Component({
    selector: 'app-config',
    templateUrl: './config.component.html',
    styleUrls: ['./config.component.css']
})
export class ConfigComponent {
    scheduler: string;
    port: number;
    chartLegendSpace: number;
    fgcolor: string;
    bgcolor: string;
    client: string;
    pieBuilding: boolean;
    noAnimate: boolean;
    minHeight: string = "";
    inited: boolean = false;

    constructor(private config: ConfigService, private tabChanged: TabChangedService) {
        this.scheduler = config.get("scheduler", location.hostname);
        this.port = config.get("port", location.port || 80);
        this.chartLegendSpace = config.get("chart-legend-space", 400);
        this.client = config.get("client", "");
        this.fgcolor = config.get("fgcolor", "#ffffff");
        this.bgcolor = config.get("bgcolor", "#ff0000");
        this.pieBuilding = config.get("pieBuilding", false);
        this.noAnimate = config.get("noAnimate", false);

        this.config.onChange((key: string) => {
            switch (key) {
            case "scheduler":
                this.scheduler = config.get("scheduler");
                break;
            case "port":
                this.port = config.get("port");
                break;
            case "chart-legend-space":
                this.chartLegendSpace = config.get("chart-legend-space");
                break;
            case "client":
                this.client = config.get("client");
                break;
            case "fgcolor":
                this.fgcolor = config.get("fgcolor");
                break;
            case "bgcolor":
                this.bgcolor = config.get("bgcolor");
                break;
            case "pieBuilding":
                this.pieBuilding = config.get("pieBuilding");
                break;
            case "noAnimate":
                this.noAnimate = config.get("noAnimate");
                break;
            }
        });

        this.tabChanged.onChanged((index, name) => {
            if (name != "Config" || this.inited) {
                return;
            }
            this.inited = true;

            const tab = document.getElementById("configTab");
            const rect: any = tab.getBoundingClientRect();

            this.minHeight = (window.innerHeight - rect.y - 50) + "px";
        });
    }

    update(key: string, data: string) {
        let ok = false;
        switch (key) {
        case "scheduler":
        case "client":
        case "fgcolor":
        case "bgcolor":
            ok = true;
            this[key] = data;
            break;
        }
        if (ok) {
            this.config.set(key, data);
        }
    }

    updateInt(key: string, data: string) {
        let ok = false;
        let n: number;
        let configName = key;
        switch (key) {
        case "chartLegendSpace":
            configName = "chart-legend-space";
            // fall through
        case "port":
            n = parseInt(data);
            if (!isNaN(n)) {
                ok = true;
                this[key] = n;
            }
            break;
        }
        if (ok) {
            this.config.set(configName, n);
        }
    }

    updateBool(key: string, data: any) {
        let ok = false;
        let val;
        if (typeof data === "boolean")
            val = data;
        else if (typeof data === "string" && data === "true")
            val = true;
        else
            val = false;
        switch (key) {
        case "pieBuilding":
        case "noAnimate":
            ok = true;
            this[key] = val;
            break;
        }
        if (ok) {
            this.config.set(key, val);
        }
    }
}
