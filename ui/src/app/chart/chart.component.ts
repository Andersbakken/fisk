import { Component, OnInit, NgZone } from '@angular/core';
import { NgxChartsModule } from '@swimlane/ngx-charts';
import { FiskService } from '../fisk.service';
import { ConfigService } from '../config.service';
import { MessageService } from '../message.service';

@Component({
  selector: 'app-chart',
  templateUrl: './chart.component.html',
  styleUrls: ['./chart.component.css']
})
export class ChartComponent implements OnInit {
    private host: string;
    private port: number;

    title = 'app';
    data: any = undefined;

    view: any[] = [700, 400];
    colorScheme = {
        domain: ['#5AA454', '#A10A28', '#C7B42C', '#AAAAAA']
    };
    showXAxis = true;
    showYAxis = true;
    gradient = false;
    showLegend = true;
    showXAxisLabel = true;
    xAxisLabel = 'Country';
    showYAxisLabel = true;
    yAxisLabel = 'Population';

    constructor(private fisk: FiskService, private ngZone: NgZone,
                private config: ConfigService, private message: MessageService) {
        this.fisk.on("data", (data: any) => {
            this.ngZone.run(() => {
                switch (data.type) {
                case "slaves":
                    this.data = data.slaves.map(e => { return {
                        value: e.activeClients,
                        name: e.name
                    } });
                    break;
                case "slaveRemoved":
                    for (let i = 0; i < this.data.length; ++i) {
                        if (this.data[i].name == data.name) {
                            this.data.splice(i, 1);
                            break;
                        }
                    }
                    break;
                case "slave":
                    for (let i = 0; i < this.data.length; ++i) {
                        if (this.data[i].name == data.slave.name) {
                            this.data[i] = data.slave;
                            break;
                        }
                    }
                    break;
                }
                console.log("got data", this.data);
            });
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

    ngOnInit() {
    }
}
