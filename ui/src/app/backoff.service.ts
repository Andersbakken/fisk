import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})

export class BackoffService {
    private backoffs: { [key: string]: number } = {};
    private serials: { [key: string]: number } = {};

    constructor() { }

    backoff(id: string, next: { (next: number): number; }, run: { (): Promise<any>; }) {
        if (id in this.backoffs)
            return false;
        if (id in this.serials) {
            ++this.serials[id];
        } else {
            this.serials[id] = 0;
        }

        const serial = this.serials[id];
        this.backoffs[id] = -1;
        const go = (when) => {
            console.log("reconnecting", when);
            run().then((ok: boolean) => {
                if (serial === this.serials[id]) {
                    if (ok) {
                        delete this.backoffs[id];
                    } else {
                        const n = next(when);
                        this.backoffs[id] = setTimeout(() => { go(n); }, n);
                    }
                }
            }).catch(() => {
                if (serial === this.serials[id]) {
                    delete this.backoffs[id];
                }
            });
        };
        go(0);
        return true;
    }

    stop(id: string) {
        if (id in this.backoffs) {
            let t = this.backoffs[id];
            if (t !== -1) {
                clearTimeout(t);
            }
            delete this.backoffs[id];
        }
    }

    running(id: string): boolean {
        return id in this.backoffs;
    }
}
