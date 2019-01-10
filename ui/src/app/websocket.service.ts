import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})

export class WebSocketService {
    private socket: WebSocket;
    private pending: Array<string>;
    private messageListeners: { (data: any): void; } [];
    private errorListeners: { (data: any): void; } [];
    private closeListeners: { (): void; } [];
    private openListeners: { (): void; } [];
    private isopen: boolean;
    private allListeners: Array<any>;

    constructor() {
        this.reset();
    }

    private addListener(name, listener) {
        this.socket.addEventListener(name, listener);
        this.allListeners.push([name, listener]);
    }

    private removeListeners() {
        for (let i = 0; i < this.allListeners.length; ++i) {
            const item = this.allListeners[i];
            this.socket.removeEventListener(item[0], item[1]);
        }
    }

    open(host: string, port: number) {
        if (this.isopen) {
            return;
        }
        try {
            this.socket = new WebSocket(`ws://${host}:${port}/monitor`);
        } catch (e) {
            console.error("websocket error", e.message);
            return;
        }

        this.addListener('open', event => {
            this.isopen = true;
            // send all the pending stuff
            if (this.pending !== undefined) {
                for (let i = 0; i < this.pending.length; ++i) {
                    this.socket.send(this.pending[i]);
                }
                this.pending = undefined;
            }

            for (let i = 0; i < this.openListeners.length; ++i) {
                this.openListeners[i]();
            }
        });
        this.addListener('message', event => {
            let data: any;
            try {
                data = JSON.parse(event.data);
            } catch (e) {
                console.error("unable to parse json", event.data);
                return;
            }
            for (let i = 0; i < this.messageListeners.length; ++i) {
                this.messageListeners[i](data);
            }
        });
        this.addListener('close', () => {
            for (let i = 0; i < this.closeListeners.length; ++i) {
                this.closeListeners[i]();
            }
            this.removeListeners();
            this.reset();
        });
        this.addListener('error', (err) => {
            for (let i = 0; i < this.errorListeners.length; ++i) {
                this.errorListeners[i](err);
            }
        });
    }

    on(name: string, on: { (data?: any): void; }) {
        if (name == "message") {
            this.messageListeners.push(on);
        } else if (name == "open") {
            this.openListeners.push(on);
        } else if (name == "close") {
            this.closeListeners.push(on);
        } else if (name == "error") {
            this.errorListeners.push(on);
        }
    }

    send(data: any) {
        if (this.isopen) {
            this.socket.send(JSON.stringify(data));
        } else {
            this.pending.push(JSON.stringify(data));
        }
    }

    close(code?: number, reason?: string) {
        if (this.isopen) {
            this.socket.close(code, reason);
            this.removeListeners();
            this.reset();
        }
    }

    private reset() {
        this.socket = undefined;
        this.pending = [];
        this.messageListeners = [];
        this.closeListeners = [];
        this.errorListeners = [];
        this.openListeners = [];
        this.isopen = false;
        this.allListeners = [];
    }
}
