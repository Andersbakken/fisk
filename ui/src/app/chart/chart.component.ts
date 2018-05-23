import { Component, OnInit, NgZone } from '@angular/core';
import { NgxChartsModule } from '@swimlane/ngx-charts';
import { FiskService } from '../fisk.service';
import { ConfigService } from '../config.service';

@Component({
  selector: 'app-chart',
  templateUrl: './chart.component.html',
  styleUrls: ['./chart.component.css']
})
export class ChartComponent implements OnInit {
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

    constructor(private fisk: FiskService, private ngZone: NgZone, private config: ConfigService) {
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
        this.config.onChange((key: string) => {
            switch (key) {
            case "host":
            case "port":
                this.reconnect(this.config.get("host", "localhost"), this.config.get("port", 8097));
                break;
            }
        });
        const host = this.config.get("host");
        if (host !== undefined) {
            this.reconnect(host, this.config.get("port", 8097));
        }
    }

    private reconnect(host: string, port: number) {
        this.fisk.close();
        this.fisk.open(host, port);
    }

    onSelect(event) {
        console.log(event);
    }

    ngOnInit() {
    }
}
