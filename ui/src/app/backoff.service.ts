import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})

export class BackoffService {
    private backoffs: { [key: string]: number } = {};

    constructor() { }

    backoff(id: string, next: { (next: number): number; }, run: { (): Promise<any>; }) {
        if (id in this.backoffs)
            return false;
        this.backoffs[id] = -1;
        const go = (when) => {
            console.log("reconnecting", when);
            run().then((ok: boolean) => {
                if (!ok) {
                    const n = next(when);
                    this.backoffs[id] = setTimeout(() => { go(n); }, n);
                } else {
                    delete this.backoffs[id];
                }
            }).catch(() => {
                delete this.backoffs[id];
            });
        };
        go(0);
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
