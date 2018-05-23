import { Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material';

@Injectable({
    providedIn: 'root'
})

export class MessageService {
    constructor(private snackBar: MatSnackBar) { }

    showMessage(msg: string, duration?: number) {
        this.snackBar.open(msg, null, {
            duration: duration || 3000,
        });
    }
}
