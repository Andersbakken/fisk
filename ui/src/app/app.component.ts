import { Component } from '@angular/core';
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

    constructor(private fisk: FiskService) {
        fisk.open("localhost", 8999);
        fisk.on("data", (data: any) => {
            console.log("got data from fisk", data);
            this.data = data;
        });
    }

    connect(host: string, port: number) {
    }

    onSelect(event) {
        console.log(event);
    }
}
