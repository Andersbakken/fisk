import { TestBed } from '@angular/core/testing';

import { TabChangedService } from './tab-changed.service';

describe('TabChangedService', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('should be created', () => {
    const service: TabChangedService = TestBed.get(TabChangedService);
    expect(service).toBeTruthy();
  });
});
