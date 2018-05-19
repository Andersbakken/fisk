import { BrowserModule } from '@angular/platform-browser';
import { NgModule } from '@angular/core';

import { AppComponent } from './app.component';

import { FiskService } from './fisk.service';
import { BackoffService } from './backoff.service';

@NgModule({
    declarations: [
        AppComponent
    ],
    imports: [
        BrowserModule
    ],
    providers: [FiskService, BackoffService],
    bootstrap: [AppComponent]
})
export class AppModule { }
