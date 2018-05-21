import { Component, ChangeDetectorRef } from '@angular/core';
import { NgxChartsModule } from '@swimlane/ngx-charts';
import { FiskService } from './fisk.service';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css']
})
export class AppComponent {
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

    constructor(private fisk: FiskService, private ref: ChangeDetectorRef) {
        fisk.open("192.168.1.46", 8097);
        fisk.on("data", (data: any) => {
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

            this.ref.detectChanges();
        });
    }

    connect(host: string, port: number) {
    }

    onSelect(event) {
        console.log(event);
    }
}
