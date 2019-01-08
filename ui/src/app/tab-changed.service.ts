import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})

export class TabChangedService {
    private _index: number = undefined;
    private _name: string = undefined;
    private _changeListeners: { (index: number, name: string): void; } [];

    constructor() {
        this._changeListeners = [];
    }

    get index(): number { return this._index; }
    get name(): string { return this._name; }

    notify(index: number, name: string) {
        this._index = index;
        this._name = name;

        for (let i = 0; i < this._changeListeners.length; ++i) {
            this._changeListeners[i](index, name);
        }
    }

    onChanged(on: { (index: number, name: string): void; }) {
        this._changeListeners.push(on);
    }
}
