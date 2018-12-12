import { Component, Input, AfterViewInit } from '@angular/core';
import { FiskService } from '../fisk.service';

@Component({
  selector: 'app-log',
  templateUrl: './log.component.html',
  styleUrls: ['./log.component.css']
})

export class LogComponent implements AfterViewInit {
    @Input() file: string;
    contents: string;

    constructor(private fisk: FiskService) {
        this.fisk.on("data", (data: any) => {
            switch (data.type) {
                case "logFile":
                    // this.contents = data.contents; //.replace(/(?:\r\n|\r|\n)/g, '<br>');
                    this.contents = "\n" + data.contents; //.replace(/(?:\r\n|\r|\n)/g, '<br>');
                    break;
            }
        });
    }

    ngAfterViewInit() {
        this.fisk.send({type: "logFile", file: this.file});
        console.log("after view init", this.file);
    }
}
