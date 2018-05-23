import { Injectable } from '@angular/core';
import { WebSocketService } from './websocket.service';
import { BackoffService } from './backoff.service';

@Injectable({
    providedIn: 'root'
})
export class FiskService {
    private pendingConnect: Array<any> = [];
    private dataListeners: { (data: any): void; } [] = [];

    constructor(private ws: WebSocketService, private backoff: BackoffService) {
    }

    open(host: string, port: number) {
        this.ws.on("message", (data: any) => {
            this.emit(this.dataListeners, data);
        });
        this.ws.on("close", () => {
            // let's retry with an exponential backoff
            if (this.backoff.running("fisk")) {
                this.resolvePending(false);
                return;
            }
            const when = (next: number): number => {
                if (!next)
                    return 1000;
                return Math.min(30000, next * 2);
            };
            this.backoff.backoff("fisk", when, (): Promise<any> => {
                return new Promise<any>((resolve, reject) => {
                    this.pendingConnect.push({ resolve: resolve, reject: reject });
                    this.open(host, port);
                });
            });
        });
        this.ws.on("open", () => {
            this.resolvePending(true);
            console.log("ok");
        });
        this.ws.open(host, port);
    }

    close(code?: number, reason?: string) {
        this.backoff.stop("fisk");
        this.ws.close(code, reason);
    }

    on(name: string, on: { (data: any): void; }) {
        if (name == "data") {
            this.dataListeners.push(on);
        }
    }

    private resolvePending(ok: boolean) {
        if (this.pendingConnect.length > 0) {
            const pending = this.pendingConnect.shift();
            pending.resolve(ok);
        }
    }

    private emit(listeners: { (data: any): void; } [], data: any) {
        for (let i = 0; i < listeners.length; ++i) {
            listeners[i](data);
        }
    }
}
