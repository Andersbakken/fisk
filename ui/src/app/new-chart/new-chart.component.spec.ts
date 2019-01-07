import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { NewChartComponent } from './new-chart.component';

describe('NewChartComponent', () => {
  let component: NewChartComponent;
  let fixture: ComponentFixture<NewChartComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ NewChartComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(NewChartComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
