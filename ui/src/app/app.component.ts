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
        fisk.on("message", (data: any) => {
            console.log("hey", data);
            fisk.send({ ting: "tang" });
        });
    }
}
