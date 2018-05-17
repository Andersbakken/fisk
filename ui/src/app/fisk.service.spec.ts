import { TestBed, inject } from '@angular/core/testing';

import { FiskService } from './fisk.service';

describe('FiskService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [FiskService]
    });
  });

  it('should be created', inject([FiskService], (service: FiskService) => {
    expect(service).toBeTruthy();
  }));
});
