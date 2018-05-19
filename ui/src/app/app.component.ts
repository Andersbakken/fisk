import { Component } from '@angular/core';
import { FiskService } from './fisk.service';
import { BackoffService } from './backoff.service';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css']
})
export class AppComponent {
    title = 'app';

    private pendingConnect: Array<any> = [];

    constructor(private fisk: FiskService, private backoff: BackoffService) {
        this.connect("localhost", 8999);
    }

    connect(host: string, port: number) {
        this.fisk.on("message", (data: any) => {
            console.log("hey", data);
            this.fisk.send({ ting: "tang" });
        });
        this.fisk.on("close", () => {
            // let's retry with an exponential backoff
            if (this.backoff.running("app")) {
                this.resolvePending(false);
                return;
            }
            const when = (next: number): number => {
                if (!next)
                    return 1000;
                return Math.min(30000, next * 2);
            };
            this.backoff.backoff("app", when, (): Promise<any> => {
                return new Promise<any>((resolve, reject) => {
                    this.pendingConnect.push({ resolve: resolve, reject: reject });
                    this.connect("localhost", 8999);
                });
            });
        });
        this.fisk.on("open", () => {
            this.resolvePending(true);
            console.log("ok");
        });
        this.fisk.on("error", () => {
        });
        this.fisk.open("localhost", 8999);
    }

    private resolvePending(ok: boolean) {
        if (this.pendingConnect.length > 0) {
            const pending = this.pendingConnect.shift();
            pending.resolve(ok);
        }
    }
}
