import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})
export class ConfigService {
    private changeListeners: { (key: string): void; } [];
    private cache: { [key: string]: any };

    constructor() {
        this.changeListeners = [];
        this.cache = {};
    }

    set(key: string, value: any, trigger?: boolean) {
        this.cache[key] = value;
        localStorage.setItem(key, JSON.stringify(value));

        if (trigger !== undefined && !trigger)
            return;

        for (let i = 0; i < this.changeListeners.length; ++i) {
            this.changeListeners[i](key);
        }
    }

    get(key: string, def?: any) {
        if (key in this.cache) {
            return this.cache[key];
        }

        let r: any;
        const v = localStorage.getItem(key);
        if (v !== null) {
            try {
                r = JSON.parse(v);
                this.cache[key] = r;
            } catch (e) {
                r = def;
                if (def !== undefined) {
                    this.set(key, def, false);
                }
            }
        } else {
            r = def;
            if (def !== undefined) {
                this.set(key, def, false);
            }
        }

        return r;
    }

    onChange(on: { (key: string): void; }) {
        this.changeListeners.push(on);
    }
}
