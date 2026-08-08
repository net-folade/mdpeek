//! Filesystem access.
//!
//! These are hand-written commands rather than the `fs` plugin on purpose: the
//! plugin's scope configuration is fiddly and easy to leave too permissive. Here
//! the reachable surface is exactly what these three functions allow — Markdown
//! files, read-only, with an extension guard and a size cap.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MD_EXTS: [&str; 4] = ["md", "markdown", "mdx", "mdown"];
const SKIP_DIRS: [&str; 9] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "venv",
    ".venv",
    "__pycache__",
    "vendor",
    "Pods",
];
const MAX_DEPTH: usize = 8;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 5_000;

fn is_md(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| MD_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn as_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    pub name: String,
    pub line: usize,
    pub text: String,
}

#[tauri::command]
pub fn read_md(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);

    if !is_md(&target) {
        return Err("not a markdown file".into());
    }

    let meta = fs::metadata(&target).map_err(|e| format!("{}: {}", path, e))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("too large ({} MB)", meta.len() / 1_048_576));
    }

    // from_utf8_lossy rather than read_to_string: a stray invalid byte should show
    // as a replacement character, not refuse to open the document.
    let bytes = fs::read(&target).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn list_tree(path: String) -> Result<TreeNode, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("not a folder".into());
    }
    let mut budget = MAX_FILES;
    Ok(walk(&root, 0, &mut budget))
}

fn walk(dir: &Path, depth: usize, budget: &mut usize) -> TreeNode {
    let mut files: Vec<TreeNode> = Vec::new();
    let mut dirs: Vec<TreeNode> = Vec::new();

    if depth < MAX_DEPTH {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }

                // file_type() does not follow symlinks, so a symlinked directory is
                // neither is_dir() nor is_file() here — which is what stops cycles.
                let Ok(kind) = entry.file_type() else { continue };
                let path = entry.path();

                if kind.is_dir() {
                    let node = walk(&path, depth + 1, budget);
                    if !node.children.is_empty() {
                        dirs.push(node);
                    }
                } else if kind.is_file() && is_md(&path) {
                    if *budget == 0 {
                        continue;
                    }
                    *budget -= 1;
                    files.push(TreeNode {
                        name,
                        path: as_string(&path),
                        is_dir: false,
                        children: Vec::new(),
                    });
                }
            }
        }
    }

    let by_name = |a: &TreeNode, b: &TreeNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    files.sort_by(by_name);
    dirs.sort_by(by_name);

    // Files before subdirectories at each level: the sidebar groups by directory
    // heading, so a level's own files should appear under its own heading first.
    files.extend(dirs);

    TreeNode {
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| as_string(dir)),
        path: as_string(dir),
        is_dir: true,
        children: files,
    }
}

#[tauri::command]
pub fn search_folder(path: String, query: String, limit: usize) -> Result<Vec<Hit>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("not a folder".into());
    }

    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let mut budget = MAX_FILES;
    let tree = walk(&root, 0, &mut budget);
    let mut paths: Vec<String> = Vec::new();
    collect(&tree, &mut paths);

    let cap = limit.clamp(1, 200);
    let mut hits = Vec::new();

    for file in paths {
        if hits.len() >= cap {
            break;
        }
        let Ok(bytes) = fs::read(&file) else { continue };
        if bytes.len() as u64 > MAX_BYTES {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);

        // One hit per file. The palette is a jump list, not a grep report — showing
        // every match in a long document would bury the other files.
        if let Some((index, line)) = text
            .lines()
            .enumerate()
            .find(|(_, line)| line.to_lowercase().contains(&needle))
        {
            let path = PathBuf::from(&file);
            hits.push(Hit {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| file.clone()),
                path: file,
                line: index + 1,
                text: line.chars().take(160).collect(),
            });
        }
    }

    Ok(hits)
}

fn collect(node: &TreeNode, out: &mut Vec<String>) {
    for child in &node.children {
        if child.is_dir {
            collect(child, out);
        } else {
            out.push(child.path.clone());
        }
    }
}
