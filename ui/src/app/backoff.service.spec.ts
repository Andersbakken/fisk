import { TestBed, inject } from '@angular/core/testing';

import { BackoffService } from './backoff.service';

describe('BackoffService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [BackoffService]
    });
  });

  it('should be created', inject([BackoffService], (service: BackoffService) => {
    expect(service).toBeTruthy();
  }));
});
