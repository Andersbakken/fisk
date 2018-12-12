import { Component, AfterViewInit } from '@angular/core';
import { FiskService } from '../fisk.service';

@Component({
    selector: 'app-logs',
    templateUrl: './logs.component.html',
    styleUrls: ['./logs.component.css']
})
export class LogsComponent implements AfterViewInit {
    private files:any;
    private expanded:string = "";

    constructor(private fisk: FiskService) {
        this.fisk.on("data", (data: any) => {
            switch (data.type) {
                case "logFiles":
                    this.files = data.files;
                    break;
            }
        });
    }

    onClicked(file) {
        this.expanded = file;
        console.log("clicked", file);
    }

    ngAfterViewInit() {
        console.log("logs!");
        this.fisk.send({type: "logFiles"});
    }

}
