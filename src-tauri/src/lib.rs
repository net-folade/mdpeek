mod files;
mod watch;

use std::sync::Mutex;
use tauri::Manager;

/// A path handed to us before the webview could ask for it — from `mdpeek file.md`
/// on the command line, or from Finder on a cold start.
#[derive(Default)]
pub struct StartupPath(pub Mutex<Option<String>>);

/// Consumed exactly once, by the frontend on mount.
#[tauri::command]
fn get_startup_path(state: tauri::State<StartupPath>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(StartupPath::default())
        .manage(watch::FileWatcher::default())
        .invoke_handler(tauri::generate_handler![
            get_startup_path,
            files::read_md,
            files::list_tree,
            files::search_folder,
            watch::watch_file,
        ])
        .setup(|app| {
            // `mdpeek notes.md` from a shell. macOS also passes a `-psn_…` argument
            // when launching from Finder, hence the leading-dash filter.
            if let Some(arg) = std::env::args().skip(1).find(|a| !a.starts_with('-')) {
                if let Ok(mut slot) = app.state::<StartupPath>().0.lock() {
                    *slot = Some(arg);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build mdpeek");

    app.run(|_app_handle, _event| {
        // macOS delivers files opened from Finder here — both when the app is
        // already running and, before the webview exists, on a cold start. We do
        // both: emit for the running case, and stash for the cold-start race that
        // the frontend resolves via get_startup_path().
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            use tauri::Emitter;

            for url in urls {
                let Ok(path) = url.to_file_path() else { continue };
                let path = path.to_string_lossy().into_owned();

                if let Ok(mut slot) = _app_handle.state::<StartupPath>().0.lock() {
                    *slot = Some(path.clone());
                }
                let _ = _app_handle.emit("open-path", path);
            }
        }
    });
}
