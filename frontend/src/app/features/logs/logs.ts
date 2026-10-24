import { Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

import { API_URL } from '../../shared/services/settings.service';

interface LogEntry {
  id: number;
  ts: number;
  level: string;
  source: string;
  message: string;
}

const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
const MAX_ENTRIES = 5000;

@Component({
  selector: 'app-logs',
  imports: [FormsModule],
  templateUrl: './logs.html',
  styleUrl: './logs.scss',
})
export class Logs implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  private source: EventSource | null = null;
  private lastId = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  readonly levels = LEVELS;
  readonly entries = signal<LogEntry[]>([]);
  readonly minLevel = signal<(typeof LEVELS)[number]>('INFO');
  readonly search = signal('');
  readonly autoScroll = signal(true);
  readonly connected = signal(false);
  readonly copied = signal(false);

  readonly visible = computed(() => {
    const minIndex = LEVELS.indexOf(this.minLevel());
    const needle = this.search().trim().toLowerCase();
    return this.entries().filter((entry) => {
      const level = LEVELS.indexOf(entry.level as (typeof LEVELS)[number]);
      if (level >= 0 && level < minIndex) return false;
      return !needle || `${entry.source} ${entry.message}`.toLowerCase().includes(needle);
    });
  });

  constructor() {
    document.title = 'Kanta Developer Logs';
    this.connect();
  }

  ngOnDestroy(): void {
    this.source?.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  time(entry: LogEntry): string {
    const date = new Date(entry.ts * 1000);
    return `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  clear(): void {
    this.http.delete(`${API_URL}/api/logs`).subscribe({ error: () => undefined });
    this.entries.set([]);
  }

  async copy(): Promise<void> {
    const text = this.visible()
      .map((entry) => `${this.time(entry)} ${entry.level.padEnd(8)} ${entry.source}: ${entry.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  onScroll(): void {
    const element = this.list()?.nativeElement;
    if (!element) return;
    this.autoScroll.set(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
  }

  private connect(): void {
    this.source?.close();
    const source = new EventSource(`${API_URL}/api/logs/stream?after=${this.lastId}`);
    this.source = source;
    source.onopen = () => this.connected.set(true);
    source.onmessage = (event) => {
      const batch = JSON.parse(event.data) as LogEntry[];
      if (!batch.length) return;
      this.lastId = batch[batch.length - 1].id;
      this.entries.update((current) => [...current, ...batch].slice(-MAX_ENTRIES));
      if (this.autoScroll()) queueMicrotask(() => this.scrollToEnd());
    };
    source.onerror = () => {
      this.connected.set(false);
      source.close();
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };
  }

  private scrollToEnd(): void {
    const element = this.list()?.nativeElement;
    if (element) element.scrollTop = element.scrollHeight;
  }
}
