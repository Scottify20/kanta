// Cross-platform helpers for the Python backend sidecar.
//   node scripts/backend.mjs build   -> PyInstaller one-file build copied into src-tauri/binaries
//   node scripts/backend.mjs fetch   -> download models + ffmpeg into the Kanta data dir
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(root, '..', 'backend');
const win = process.platform === 'win32';
const venvBin = join(backend, 'venv', win ? 'Scripts' : 'bin');
const exe = (name) => {
  const local = join(venvBin, win ? `${name}.exe` : name);
  return existsSync(local) ? local : name;
};

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd: backend,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function hostTriple() {
  const out = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout ?? '';
  const match = out.match(/host: (\S+)/);
  if (!match) {
    console.error('rustc not found; install Rust to determine the target triple.');
    process.exit(1);
  }
  return match[1];
}

const command = process.argv[2];
if (command === 'build') {
  run(exe('pyinstaller'), ['kanta-backend.spec', '--noconfirm'], { KANTA_ONEFILE: '1' });
  const triple = hostTriple();
  const built = join(backend, 'dist', win ? 'kanta-backend.exe' : 'kanta-backend');
  const target = join(root, 'src-tauri', 'binaries', `kanta-backend-${triple}${win ? '.exe' : ''}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(built, target);
  console.log(`Sidecar ready: ${target}`);
} else if (command === 'fetch') {
  run(exe(win ? 'python' : 'python3'), ['scripts/fetch_assets.py', ...process.argv.slice(3)]);
} else {
  console.error('Usage: backend.mjs <build|fetch> [models|ffmpeg]');
  process.exit(1);
}
