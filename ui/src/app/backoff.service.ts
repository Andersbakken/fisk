import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})

export class BackoffService {
    private backoffs: { [key: string]: boolean } = {};

    constructor() { }

    backoff(id: string, next: { (next: number): number; }, run: { (): Promise<any>; }) {
        if (this.backoffs[id])
            return false;
        this.backoffs[id] = true;
        const go = (when) => {
            console.log("reconnecting", when);
            run().then((ok: boolean) => {
                if (!ok) {
                    const n = next(when);
                    setTimeout(() => { go(n); }, n);
                } else {
                    this.backoffs[id] = false;
                }
            }).catch(() => {
                this.backoffs[id] = false;
            });
        };
        go(0);
    }

    running(id: string): boolean {
        return id in this.backoffs && this.backoffs[id];
    }
}
