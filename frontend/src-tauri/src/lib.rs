use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

struct Backend(Mutex<Option<CommandChild>>);
struct BackendPort(Mutex<Result<Option<u16>, String>>);

#[tauri::command]
fn backend_port(state: tauri::State<'_, BackendPort>) -> Result<Option<u16>, String> {
  state.0.lock().map_err(|error| error.to_string())?.clone()
}

// Release builds ship the FastAPI backend as a sidecar; in dev it is started manually.
fn start_backend(app: &tauri::AppHandle) {
  // The CUDA build ships the backend as a resource folder (see tauri.bundle.windows-cuda.conf.json).
  let folder_exe = app
    .path()
    .resource_dir()
    .ok()
    .map(|dir| dir.join("backend").join(if cfg!(windows) { "kanta-backend.exe" } else { "kanta-backend" }))
    .filter(|path| path.is_file());
  let command = match folder_exe {
    Some(path) => app.shell().command(path),
    None => match app.shell().sidecar("kanta-backend") {
      Ok(command) => command,
      Err(_) => {
        log::warn!("kanta-backend is not bundled");
        *app.state::<BackendPort>().0.lock().unwrap() = Err("Backend is not bundled.".into());
        return;
      }
    },
  };
  match command.env("KANTA_PARENT_PID", std::process::id().to_string())
    .env("KANTA_DESKTOP_PORT_DISCOVERY", "1")
    .env("KANTA_HOST", "127.0.0.1").spawn() {
    Ok((mut rx, child)) => {
      *app.state::<Backend>().0.lock().unwrap() = Some(child);
      let handle = app.clone();
      tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
          match event {
            CommandEvent::Stdout(line) => {
              let line = String::from_utf8_lossy(&line);
              if let Some(value) = line.trim().strip_prefix("KANTA_BACKEND_PORT=") {
                match value.parse::<u16>() {
                  Ok(port) if port != 0 => *handle.state::<BackendPort>().0.lock().unwrap() = Ok(Some(port)),
                  _ => *handle.state::<BackendPort>().0.lock().unwrap() = Err("Backend returned an invalid port.".into()),
                }
              }
            }
            CommandEvent::Error(error) => {
              *handle.state::<BackendPort>().0.lock().unwrap() = Err(format!("Backend process error: {error}"));
            }
            CommandEvent::Terminated(status) => {
              *handle.state::<BackendPort>().0.lock().unwrap() = Err(format!("Backend exited: {status:?}"));
              break;
            }
            _ => {}
          }
        }
      });
    }
    Err(error) => {
      *app.state::<BackendPort>().0.lock().unwrap() = Err(format!("Failed to start backend: {error}"));
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(Backend(Mutex::new(None)))
    .manage(BackendPort(Mutex::new(if cfg!(debug_assertions) { Ok(Some(8004)) } else { Ok(None) })))
    .invoke_handler(tauri::generate_handler![backend_port])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      } else {
        start_backend(app.handle());
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|handle, event| {
    if let RunEvent::Exit = event {
      if let Some(child) = handle.state::<Backend>().0.lock().unwrap().take() {
        let _ = child.kill();
      }
    }
  });
}
