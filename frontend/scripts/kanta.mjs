// Cross-platform dev/build helper (Windows, Linux, macOS). Run through the npm scripts in package.json.
//   setup [--cpu|--cuda]  create backend/venv and install Python deps (auto-detects an NVIDIA GPU)
//   backend               run the API (python run_server.py)
//   dev                   backend + `tauri dev` together
//   sidecar               PyInstaller build copied into src-tauri/binaries for this OS
//   bundle                sidecar + `tauri build` with this OS's installer config
//   fetch [models|ffmpeg] download runtime assets into the Kanta data dir
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(root, '..', 'backend');
const platform = process.platform;
const win = platform === 'win32';
const venvDir = join(backend, 'venv');
const venvBin = join(venvDir, win ? 'Scripts' : 'bin');
const venvPython = join(venvBin, win ? 'python.exe' : 'python');

const BUNDLE_CONFIG = {
  win32: 'tauri.bundle.conf.json',
  linux: 'tauri.bundle.linux.conf.json',
  darwin: 'tauri.bundle.macos.conf.json',
};

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: win && options.shell !== false, ...options });
  if (result.error) fail(`Could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : null;
}

function pythonLauncher() {
  if (existsSync(venvPython)) return [venvPython];
  const candidates = win
    ? [['py', '-3.12'], ['py', '-3.11'], ['py', '-3.13'], ['python']]
    : [['python3.12'], ['python3.11'], ['python3.13'], ['python3']];
  for (const [cmd, ...pre] of candidates) {
    const out = capture(cmd, [...pre, '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])']);
    const version = Number(out);
    if (version >= 310 && version <= 313) return [cmd, ...pre];
  }
  return fail('Python 3.10-3.13 was not found. Install Python 3.12 from python.org and try again.');
}

function venvTool(name) {
  const local = join(venvBin, win ? `${name}.exe` : name);
  return existsSync(local) ? local : name;
}

function hasNvidia() {
  return capture('nvidia-smi', ['-L']) !== null;
}

function setup(flags) {
  const [py, ...pre] = pythonLauncher();
  if (!existsSync(venvPython)) {
    console.log('Creating backend/venv ...');
    run(py, [...pre, '-m', 'venv', venvDir], { cwd: backend });
  }
  const pip = (args) => run(venvPython, ['-m', 'pip', ...args], { cwd: backend });
  pip(['install', '--upgrade', 'pip']);
  const wantCuda = flags.includes('--cuda') || (!flags.includes('--cpu') && platform !== 'darwin' && hasNvidia());
  if (platform === 'darwin') {
    pip(['install', 'torch']);
  } else if (wantCuda) {
    console.log('Installing PyTorch (CUDA) ...');
    pip(['install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cu121']);
  } else {
    console.log('Installing PyTorch (CPU only, much smaller) ...');
    pip(['install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu']);
  }
  pip(['install', '-r', 'requirements.txt']);
  console.log('\nBackend ready. Next: npm run dev (or npm run dev:backend and npm run tauri:dev in two terminals).');
}

function requireVenv() {
  if (!existsSync(venvPython)) fail('backend/venv is missing. Run `npm run setup` first.');
}

function startBackend() {
  requireVenv();
  return spawn(venvPython, ['run_server.py'], { cwd: backend, stdio: 'inherit' });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function dev() {
  const api = startBackend();
  const app = spawn('npx', ['tauri', 'dev'], { cwd: root, stdio: 'inherit', shell: win });
  const stop = () => { killTree(api); killTree(app); };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('exit', stop);
  api.on('exit', (code) => { if (code) console.error(`Backend exited with code ${code}`); stop(); process.exit(code ?? 0); });
  app.on('exit', (code) => { stop(); process.exit(code ?? 0); });
}

function hostTriple() {
  const out = capture('rustc', ['-vV']) ?? '';
  const match = out.match(/host: (\S+)/);
  return match ? match[1] : fail('rustc not found. Install Rust from https://rustup.rs and reopen your terminal.');
}

function sidecar() {
  requireVenv();
  run(venvTool('pyinstaller'), ['kanta-backend.spec', '--noconfirm'], {
    cwd: backend,
    shell: false,
    env: { ...process.env, KANTA_ONEFILE: '1' },
  });
  const built = join(backend, 'dist', win ? 'kanta-backend.exe' : 'kanta-backend');
  const target = join(root, 'src-tauri', 'binaries', `kanta-backend-${hostTriple()}${win ? '.exe' : ''}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(built, target);
  console.log(`Sidecar ready: ${target}`);
}

function bundle() {
  const config = BUNDLE_CONFIG[platform];
  if (!config) fail(`No bundle config for ${platform}.`);
  sidecar();
  run('npx', ['tauri', 'build', '--config', `src-tauri/${config}`], { cwd: root });
}

function fetchAssets(args) {
  requireVenv();
  run(venvPython, ['scripts/fetch_assets.py', ...args], { cwd: backend, shell: false });
}

const [command, ...rest] = process.argv.slice(2);
const commands = { setup: () => setup(rest), backend: () => { const api = startBackend(); api.on('exit', (code) => process.exit(code ?? 0)); }, dev, sidecar, bundle, fetch: () => fetchAssets(rest) };
if (!commands[command]) fail('Usage: kanta.mjs <setup|backend|dev|sidecar|bundle|fetch>');
commands[command]();
