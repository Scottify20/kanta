use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct Backend(Mutex<Option<CommandChild>>);

// Release builds ship the FastAPI backend as a sidecar; in dev it is started manually.
fn start_backend(app: &tauri::AppHandle) {
  let Ok(command) = app.shell().sidecar("kanta-backend") else {
    log::warn!("kanta-backend sidecar is not bundled");
    return;
  };
  match command.env("KANTA_PARENT_PID", std::process::id().to_string()).spawn() {
    Ok((_rx, child)) => *app.state::<Backend>().0.lock().unwrap() = Some(child),
    Err(error) => log::error!("failed to start backend: {error}"),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(Backend(Mutex::new(None)))
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
