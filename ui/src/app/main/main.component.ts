import { Component, OnInit } from '@angular/core';
import { TabChangedService } from '../tab-changed.service';

@Component({
    selector: 'app-main',
    templateUrl: './main.component.html',
    styleUrls: ['./main.component.css']
})

export class MainComponent implements OnInit {
    currentTab: number = undefined;
    currentName: string = undefined;

    constructor(private tabChanged: TabChangedService) { }

    ngOnInit() {
    }

    onTabChanged(event) {
        this.currentTab = event.index;
        this.currentName = event.tab.textLabel;
    }

    onAnimationDone() {
        this.tabChanged.notify(this.currentTab, this.currentName);
    }
}
