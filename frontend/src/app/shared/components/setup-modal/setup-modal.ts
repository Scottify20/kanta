import { Component, computed, inject } from '@angular/core';
import { SetupService } from '../../services/setup.service';

@Component({
  selector: 'app-setup-modal',
  templateUrl: './setup-modal.html',
  styleUrl: './setup-modal.scss',
})
export class SetupModal {
  readonly setup = inject(SetupService);
  readonly job = computed(() => this.setup.status()?.job);
  readonly percent = computed(() => {
    const job = this.job();
    return job && job.total ? Math.round((job.done / job.total) * 100) : 0;
  });
}
