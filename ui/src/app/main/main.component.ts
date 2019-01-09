import { Component, AfterViewInit, ViewChild } from '@angular/core';
import { TabChangedService } from '../tab-changed.service';

@Component({
    selector: 'app-main',
    templateUrl: './main.component.html',
    styleUrls: ['./main.component.css']
})

export class MainComponent implements AfterViewInit {
    @ViewChild('fiskTabGroup') tabGroup;
    currentTab: number = undefined;
    currentName: string = undefined;

    constructor(private tabChanged: TabChangedService) {
    }

    ngAfterViewInit() {
        try {
            const idx = this.tabGroup.selectedIndex;
            const tab = this.tabGroup._tabs._results[idx];

            this.currentTab = idx;
            this.currentName = tab.textLabel;

            this.tabChanged.notify(this.currentTab, this.currentName);
        } catch (e) {
        }
    }

    onTabChanged(event) {
        this.currentTab = event.index;
        this.currentName = event.tab.textLabel;
    }

    onAnimationDone() {
        this.tabChanged.notify(this.currentTab, this.currentName);
    }
}
