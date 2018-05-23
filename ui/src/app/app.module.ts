import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { NgxChartsModule } from '@swimlane/ngx-charts';

import { AppComponent } from './app.component';

import { WebSocketService } from './websocket.service';
import { BackoffService } from './backoff.service';
import { FiskService } from './fisk.service';
import { ConfigComponent } from './config/config.component';

const appRoutes: Routes = [
    { path: 'config', component: ConfigComponent },
    { path: 'chart', component: ChartComponent },
    { path: '',
      redirectTo: '/chart',
      pathMatch: 'full'
    }
];

@NgModule({
    declarations: [
        AppComponent,
        ConfigComponent
    ],
    imports: [
        BrowserModule,
        BrowserAnimationsModule,
        NgxChartsModule,
        RouterModule.forRoot(appRoutes)
    ],
    providers: [WebSocketService, BackoffService, FiskService],
    bootstrap: [AppComponent]
})
export class AppModule { }
