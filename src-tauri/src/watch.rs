//! Live reload for the open document, so mdpeek works as a preview pane beside
//! whatever editor you actually write in.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Holds the single active watcher. Assigning a new one drops the old, which is
/// how the previous file gets unwatched.
#[derive(Default)]
pub struct FileWatcher(pub Mutex<Option<RecommendedWatcher>>);

const DEBOUNCE: Duration = Duration::from_millis(120);

#[tauri::command]
pub fn watch_file(app: AppHandle, path: String, state: State<FileWatcher>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "file has no parent directory".to_string())?
        .to_path_buf();

    let file_name = target.file_name().map(|n| n.to_os_string());
    let last_fired = Arc::new(Mutex::new(Instant::now() - DEBOUNCE));
    let emit_path = path.clone();

    // Watch the *directory*, not the file. Most editors save atomically — write a
    // temp file, then rename over the target — which destroys the original inode.
    // A watch on the file itself goes deaf after the first such save.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };

        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Any
        ) {
            return;
        }

        let touched = event
            .paths
            .iter()
            .any(|p| p.file_name().map(|n| n.to_os_string()) == file_name);
        if !touched {
            return;
        }

        let mut last = match last_fired.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if last.elapsed() < DEBOUNCE {
            return;
        }
        *last = Instant::now();

        let _ = app.emit("file-changed", emit_path.clone());
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}
