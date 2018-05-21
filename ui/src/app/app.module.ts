import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { NgModule } from '@angular/core';
import { NgxChartsModule } from '@swimlane/ngx-charts';

import { AppComponent } from './app.component';

import { WebSocketService } from './websocket.service';
import { BackoffService } from './backoff.service';
import { FiskService } from './fisk.service';
import { ConfigComponent } from './config/config.component';

@NgModule({
    declarations: [
        AppComponent,
        ConfigComponent
    ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        NgxChartsModule,
    ],
    providers: [WebSocketService, BackoffService, FiskService],
    bootstrap: [AppComponent]
})
export class AppModule { }
