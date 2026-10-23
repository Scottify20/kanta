import { DOCUMENT } from '@angular/common';
import { Injectable, NgZone, inject, signal } from '@angular/core';

type TauriWindow = {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
};

/**
 * Single source of truth for fullscreen. The real window/document state is the only thing
 * that flips `active`, so shortcut, button, Esc and OS gestures can never disagree.
 */
@Injectable({ providedIn: 'root' })
export class FullscreenService {
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private readonly isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  private tauriWindow: TauriWindow | null = null;
  private busy = false;

  readonly active = signal(false);

  constructor() {
    const view = this.document.defaultView;
    if (!view) return;
    this.zone.runOutsideAngular(() => {
      this.document.addEventListener('fullscreenchange', () => this.sync());
      view.addEventListener('resize', () => this.sync());
      this.document.addEventListener('keydown', (event) => this.onShortcut(event));
    });
  }

  // Global so fullscreen survives (and can be toggled from) every page, not just now-playing.
  private onShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing =
      !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const plainF =
      event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing;
    if ((event.key !== 'F11' && !plainF) || event.repeat) return;
    event.preventDefault();
    void this.toggle();
  }

  async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.set(!(await this.read()));
    } catch (error) {
      console.error('Error toggling fullscreen:', error);
    } finally {
      this.busy = false;
      await this.sync();
    }
  }

  async exit(): Promise<void> {
    if (this.busy || !(await this.read())) return;
    this.busy = true;
    try {
      await this.set(false);
    } catch (error) {
      console.error('Error exiting fullscreen:', error);
    } finally {
      this.busy = false;
      await this.sync();
    }
  }

  private async set(on: boolean): Promise<void> {
    const tauri = await this.getTauriWindow();
    if (tauri) {
      await tauri.setFullscreen(on);
    } else if (on) {
      await this.document.documentElement.requestFullscreen();
    } else if (this.document.fullscreenElement) {
      await this.document.exitFullscreen();
    }
  }

  private async read(): Promise<boolean> {
    const tauri = await this.getTauriWindow();
    if (tauri) return tauri.isFullscreen();
    const view = this.document.defaultView;
    // F11 browser fullscreen does not set fullscreenElement, so also compare window and screen size.
    return (
      !!this.document.fullscreenElement ||
      (!!view && view.innerHeight === view.screen.height && view.innerWidth === view.screen.width)
    );
  }

  private async sync(): Promise<void> {
    const next = await this.read();
    if (next !== this.active()) this.zone.run(() => this.active.set(next));
  }

  private async getTauriWindow(): Promise<TauriWindow | null> {
    if (!this.isTauri) return null;
    if (!this.tauriWindow) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        this.tauriWindow = getCurrentWindow();
      } catch {
        return null;
      }
    }
    return this.tauriWindow;
  }
}
