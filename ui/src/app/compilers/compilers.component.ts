import { Component, Inject } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material';
import { FiskService } from '../fisk.service';
import { TabChangedService } from '../tab-changed.service';

@Component({
    selector: 'app-compilers',
    templateUrl: './compilers.component.html',
    styleUrls: ['./compilers.component.css']
})
export class CompilersComponent {
    public environments: any;
    private compatibilities: any;
    private links: any;

    constructor(private fisk: FiskService, private tabChanged: TabChangedService,
                private dialog: MatDialog) {
        this.fisk.on("data", (data: any) => {
            if (data.type === "listEnvironments") {
                let envs = [];
                console.log(data.environments);
                this.links = data.environments.links;
                for (const k in data.environments) {
                    const e = data.environments[k];
                    if (typeof e === "object" && "system" in e) {
                        if (!("hash" in e))
                            e.hash = k;
                        const info = { name: undefined, major: undefined, minor: undefined, patch: undefined, version: "" };
                        const infos = (e.info || "").split("\n");
                        const crx = /^(clang) version ([0-9]+)\.([0-9+])\.([0-9]+) /;
                        const grx = /^(gcc) version ([0-9]+)\.([0-9+])\.([0-9]+) /;
                        const lrx = /^(Apple LLVM) version ([0-9]+)\.([0-9+])\.([0-9]+) /;
                        const trx = /^Target: (.*)$/;
                        let t, m;
                        for (let i = 0; i < infos.length && (!t || !m); ++i) {
                            if (!m) {
                                m = crx.exec(infos[i]) || grx.exec(infos[i]) || lrx.exec(infos[i]);
                            }
                            if (!t) {
                                t = trx.exec(infos[i]);
                            }
                        }

                        if (m) {
                            info.name = m[1];
                            info.major = parseInt(m[2]);
                            info.minor = parseInt(m[3]);
                            info.patch = parseInt(m[4]);
                            info.version = `${info.major}.${info.minor}.${info.patch}`;
                        }
                        if (t) {
                            e.target = t[1];
                        }

                        e.compiler = info;
                        envs.push(e);
                    }
                }
                console.log(envs);
                this.environments = envs;
            }
            // srcHash targetHash arguments?
        });
        this.tabChanged.onChanged((index, name) => {
            if (name != "Compilers")
                return;
            this.fisk.send({ type: "listEnvironments" });
        });
    }

    onClicked(env) {
        //console.log(env);
        const dialogRef = this.dialog.open(CompilersComponentDialog, {
            data: { current: env, environments: this.environments, links: this.links[env.hash] }
        });
        dialogRef.afterClosed().subscribe(result => {
            //console.log("dialog closed", result);
            if (!result)
                return;
            for (let k in result.checked) {
                if (result.checked[k]) {
                    const args = result.args[k] && result.args[k].split(' ');
                    this.fisk.send({ type: "linkEnvironments", srcHash: env.hash, targetHash: k, arguments: args });
                }
            }
        });
    }
}

@Component({
    selector: 'app-compilers-dialog',
    templateUrl: 'compilers.component.dialog.html',
    styleUrls: ['./compilers.component.dialog.css']
})
export class CompilersComponentDialog {
    public others: any = [];
    public checked: any = {};
    public args: any = {};

    constructor(public dialogRef: MatDialogRef<CompilersComponentDialog>,
                @Inject(MAT_DIALOG_DATA) public data: any) {
        for (let i = 0; i < data.environments.length; ++i) {
            if (data.current != data.environments[i]) {
                this.others.push(data.environments[i]);
                this.checked[data.environments[i].hash] = false;
            }
        }
        if (data.links) {
            for (let k in data.links) {
                this.checked[k] = true;
            }
        }
    }

    onNoClick() {
        this.dialogRef.close();
    }
}
