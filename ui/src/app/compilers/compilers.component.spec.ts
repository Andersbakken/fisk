import { async, ComponentFixture, TestBed } from '@angular/core/testing';

import { CompilersComponent } from './compilers.component';

describe('CompilersComponent', () => {
  let component: CompilersComponent;
  let fixture: ComponentFixture<CompilersComponent>;

  beforeEach(async(() => {
    TestBed.configureTestingModule({
      declarations: [ CompilersComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(CompilersComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
