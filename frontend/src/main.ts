import '@braccato/core/element';
import { bootstrapApplication } from '@angular/platform-browser';
import { invoke } from '@tauri-apps/api/core';
import { API_URL, appConfig, setApiPort } from './app/app.config';
import { App } from './app/app';


async function start(): Promise<void> {
  if ('__TAURI_INTERNALS__' in window) {
    const root = document.querySelector('app-root');
    if (root) root.textContent = 'Starting Kanta backend...';
    const deadline = Date.now() + 180_000;
    let port: number | null = null;
    while (port === null && Date.now() < deadline) {
      port = await invoke<number | null>('backend_port');
      if (port === null) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (port === null) throw new Error('Backend did not announce a port within 3 minutes.');
    setApiPort(port);
    let ready = false;
    while (Date.now() < deadline) {
      // Check process status as well as health, so an exited backend cannot be mistaken
      // for another service that later acquires its port.
      if (await invoke<number | null>('backend_port') !== port) throw new Error('Backend port changed during startup.');
      try {
        const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(2000) });
        const body = response.ok ? await response.json() : null;
        if (body?.app === 'Kanta Backend') {
          ready = true;
          break;
        }
      } catch {
        // The socket may be bound before the backend has finished initializing.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`Backend at ${API_URL} did not become ready within 3 minutes.`);
  }
  await bootstrapApplication(App, appConfig);
}

start().catch((err: unknown) => {
  console.error('Kanta startup failed:', err);
  const message = err instanceof Error ? err.message : String(err);
  document.body.textContent = `Kanta could not start its backend: ${message}. Check the backend logs and restart the app.`;
});
