import { Component, OnInit } from '@angular/core';
import { ConfigService } from '../config.service';

@Component({
    selector: 'app-config',
    templateUrl: './config.component.html',
    styleUrls: ['./config.component.css']
})
export class ConfigComponent implements OnInit {
    host: string;
    port: number;

    constructor(private config: ConfigService) {
        this.host = config.get("host", location.host);
        this.port = config.get("port", location.port || 80);

        this.config.onChange((key: string) => {
            switch (key) {
            case "host":
                this.host = config.get("host");
                break;
            case "port":
                this.port = config.get("port");
                break;
            }
        });
    }

    ngOnInit() {
    }

    update(key: string, data: string) {
        let ok = false;
        switch (key) {
        case "host":
            ok = true;
            this[key] = data;
            break;
        }
        if (ok) {
            this.config.set(key, data);
        }
    }

    updateInt(key: string, data: string) {
        let ok = false;
        let n: number;
        switch (key) {
        case "port":
            n = parseInt(data);
            if (!isNaN(n)) {
                ok = true;
                this[key] = n;
            }
            break;
        }
        if (ok) {
            this.config.set(key, n);
        }
    }
}
