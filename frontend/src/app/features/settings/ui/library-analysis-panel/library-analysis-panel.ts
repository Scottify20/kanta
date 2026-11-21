import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { TitleCasePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { exhaustMap, Subscription, timer } from 'rxjs';
import { LibraryService } from '../../../../shared/services/library.service';
import {
  AnalysisTaskStatus,
  BatchSongAnalysisOptions,
  SongsService,
} from '../../../../shared/services/songs.service';
import { ToastService } from '../../../../shared/services/toast.service';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

@Component({
  selector: 'app-library-analysis-panel',
  imports: [TitleCasePipe],
  templateUrl: './library-analysis-panel.html',
  styleUrl: './library-analysis-panel.scss',
})
export class LibraryAnalysisPanel {
  private readonly songs = inject(SongsService);
  private readonly library = inject(LibraryService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private pollSubscription: Subscription | null = null;

  readonly options = signal<BatchSongAnalysisOptions>({
    vocal_range: true,
    musical_key: false,
    bpm: false,
    replaygain: false,
    missing_only: true,
  });
  readonly task = signal<AnalysisTaskStatus | null>(null);
  readonly starting = signal(false);
  readonly cancelling = signal(false);
  readonly error = signal('');
  readonly running = computed(() => {
    const status = this.task()?.status;
    return !!status && !TERMINAL_STATUSES.has(status);
  });
  readonly canStart = computed(() =>
    !this.starting() && !this.running()
      && (
        this.options().vocal_range
        || this.options().musical_key
        || this.options().bpm
        || this.options().replaygain
      ),
  );

  setOption(field: keyof BatchSongAnalysisOptions, value: boolean): void {
    this.options.update((options) => ({ ...options, [field]: value }));
  }

  start(): void {
    if (!this.canStart()) return;
    this.starting.set(true);
    this.error.set('');
    this.songs.startLibraryReanalysis(this.options()).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: ({ task_id, status }) => {
        this.task.set({ task_id, status, progress: 0, step: 'Preparing library re-analysis...' });
        this.starting.set(false);
        this.startPolling(task_id);
      },
      error: (error: unknown) => {
        this.starting.set(false);
        this.error.set(this.errorMessage(error));
      },
    });
  }

  cancel(): void {
    const taskId = this.task()?.task_id;
    if (!taskId || !this.running() || this.cancelling()) return;
    this.cancelling.set(true);
    this.songs.cancelAnalysisTask(taskId).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => this.cancelling.set(false),
      error: (error: unknown) => {
        this.cancelling.set(false);
        this.error.set(this.errorMessage(error));
      },
    });
  }

  private startPolling(taskId: string): void {
    this.stopPolling();
    this.pollSubscription = timer(0, 1000).pipe(
      exhaustMap(() => this.songs.getAnalysisTaskStatus(taskId)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (task) => {
        this.task.set(task);
        if (TERMINAL_STATUSES.has(task.status)) {
          this.stopPolling();
          if (task.status === 'failed') this.error.set(task.error || task.step || 'Library analysis failed.');
          void this.refreshLibrary();
        }
      },
      error: (error: unknown) => {
        this.stopPolling();
        this.error.set(this.errorMessage(error));
      },
    });
  }

  private stopPolling(): void {
    this.pollSubscription?.unsubscribe();
    this.pollSubscription = null;
  }

  private async refreshLibrary(): Promise<void> {
    try {
      await this.library.load(true);
    } catch (error: unknown) {
      this.toast.error('Analysis finished, but the library could not be refreshed.');
      console.error('Could not refresh the library after batch analysis:', error);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      return error.error?.detail || error.message || 'Library analysis could not be completed.';
    }
    return error instanceof Error ? error.message : 'Library analysis could not be completed.';
  }
}
