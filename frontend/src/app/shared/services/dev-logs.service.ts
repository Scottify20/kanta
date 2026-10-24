import { Injectable } from '@angular/core';

export const LOGS_PATH = '/logs';
const LOGS_WINDOW_LABEL = 'logs';

@Injectable({ providedIn: 'root' })
export class DevLogsService {
  // Opens the log viewer in its own window: a Tauri window in the desktop app, a browser tab otherwise.
  async openWindow(): Promise<void> {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const existing = await WebviewWindow.getByLabel(LOGS_WINDOW_LABEL);
        if (existing) {
          await existing.unminimize();
          await existing.setFocus();
          return;
        }
        const logsWindow = new WebviewWindow(LOGS_WINDOW_LABEL, {
          url: LOGS_PATH,
          title: 'Kanta Developer Logs',
          width: 1000,
          height: 650,
          minWidth: 500,
          minHeight: 300,
        });
        logsWindow.once('tauri://error', () => window.open(LOGS_PATH, '_blank'));
        return;
      } catch {
        // fall through to a plain browser window
      }
    }
    window.open(LOGS_PATH, 'kanta-logs', 'popup,width=1000,height=650');
  }
}
