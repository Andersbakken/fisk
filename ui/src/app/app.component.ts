import { Component } from '@angular/core';
import { FiskService } from './fisk.service';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css']
})
export class AppComponent {
    title = 'app';

    constructor(private fisk: FiskService) {
        fisk.open("localhost", 8999);
        fisk.on("data", (data: any) => {
            console.log("got data from fisk", data);
        });
    }

    connect(host: string, port: number) {
    }
}
