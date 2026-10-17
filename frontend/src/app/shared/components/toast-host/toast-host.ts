import { Component, inject } from '@angular/core';
import { LucideCircleAlert, LucideCircleCheck, LucideInfo, LucideX } from '@lucide/angular';
import { ToastService } from '../../services/toast.service';
import { Tooltip } from '../../directives/tooltip';

@Component({
  selector: 'app-toast-host',
  imports: [LucideCircleAlert, LucideCircleCheck, LucideInfo, LucideX, Tooltip],
  templateUrl: './toast-host.html',
  styleUrl: './toast-host.scss',
})
export class ToastHost {
  readonly toastService = inject(ToastService);
}
