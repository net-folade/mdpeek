//! Filesystem access.
//!
//! These are hand-written commands rather than the `fs` plugin on purpose: the
//! plugin's scope configuration is fiddly and easy to leave too permissive. Here
//! the reachable surface is exactly what these three functions allow — Markdown
//! files, read-only, with an extension guard and a size cap.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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

/// Let the webview load images sitting next to a document.
///
/// The asset protocol starts with an empty scope and is widened only here, one
/// directory at a time, as documents are actually opened — rather than declaring
/// a broad static scope in tauri.conf.json and hoping. Failure is not fatal: the
/// document still renders, its images just stay broken.
fn allow_assets(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

#[tauri::command]
pub fn read_md(app: AppHandle, path: String) -> Result<String, String> {
    let source = read_source(Path::new(&path))?;
    if let Some(parent) = Path::new(&path).parent() {
        allow_assets(&app, parent);
    }
    Ok(source)
}

fn read_source(target: &Path) -> Result<String, String> {
    if !is_md(target) {
        return Err("not a markdown file".into());
    }

    let meta = fs::metadata(target).map_err(|e| format!("{}: {}", target.display(), e))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("too large ({} MB)", meta.len() / 1_048_576));
    }

    // from_utf8_lossy rather than read_to_string: a stray invalid byte should show
    // as a replacement character, not refuse to open the document.
    let bytes = fs::read(target).map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn list_tree(app: AppHandle, path: String) -> Result<TreeNode, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("not a folder".into());
    }

    // Covers the common docs layout where a page in docs/ points at ../assets/,
    // which the per-document grant above would miss.
    allow_assets(&app, &root);

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "mdpeek-tests-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, data: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, data).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn reads_supported_extensions_and_replaces_invalid_utf8() {
        let fixture = Fixture::new();
        for ext in ["md", "MD", "markdown", "mdx", "mdown"] {
            let path = fixture.write(&format!("note.{ext}"), b"hello\xff");
            assert_eq!(read_source(&path).unwrap(), "hello\u{fffd}");
        }
    }

    #[test]
    fn rejects_non_markdown_missing_directories_and_oversized_files() {
        let fixture = Fixture::new();
        assert!(read_source(&fixture.write("note.txt", b"text")).is_err());
        assert!(read_source(&fixture.0.join("missing.md")).is_err());
        let dir = fixture.0.join("directory.md");
        fs::create_dir(&dir).unwrap();
        assert_eq!(read_source(&dir).unwrap_err(), "not a file");
        let big = fixture.write("big.md", b"");
        fs::File::options().write(true).open(&big).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(read_source(&big).unwrap_err().contains("too large"));
    }

    #[test]
    fn tree_filters_sorts_and_respects_file_and_depth_limits() {
        let fixture = Fixture::new();
        for name in ["z.md", "A.md", "guide/help.md", ".hidden.md", "node_modules/no.md", "empty/file.txt"] {
            fixture.write(name, b"hello");
        }
        let mut budget = 20;
        let tree = walk(&fixture.0, 0, &mut budget);
        assert_eq!(tree.children.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), vec!["A.md", "z.md", "guide"]);
        let mut paths = vec![];
        collect(&tree, &mut paths);
        assert_eq!(paths.len(), 3);
        let mut budget = 1;
        paths.clear();
        collect(&walk(&fixture.0, 0, &mut budget), &mut paths);
        assert_eq!(paths.len(), 1);
        assert!(walk(&fixture.0, MAX_DEPTH, &mut 20).children.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn tree_does_not_follow_symlinks() {
        let fixture = Fixture::new();
        fixture.write("note.md", b"hello");
        std::os::unix::fs::symlink(&fixture.0, fixture.0.join("cycle")).unwrap();
        std::os::unix::fs::symlink(fixture.0.join("note.md"), fixture.0.join("alias.md")).unwrap();
        assert_eq!(walk(&fixture.0, 0, &mut 20).children.len(), 1);
    }

    #[test]
    fn search_is_case_insensitive_one_hit_per_file_and_capped() {
        let fixture = Fixture::new();
        fixture.write("a.md", b"first\nHELLO world\nhello again");
        fixture.write("b.md", b"hello second file");
        fixture.write("ignored.txt", b"hello");
        let path = as_string(&fixture.0);
        let hits = search_folder(path.clone(), "hello".into(), 200).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].text, "HELLO world");
        assert_eq!(search_folder(path.clone(), "HELLO".into(), 1).unwrap().len(), 1);
        assert!(search_folder(path.clone(), "".into(), 10).unwrap().is_empty());
        assert!(search_folder(path, "absent".into(), 10).unwrap().is_empty());
        assert!(search_folder(as_string(&fixture.0.join("missing")), "hello".into(), 10).is_err());
    }

    #[test]
    fn accepts_file_at_size_limit_and_search_skips_larger_files() {
        let fixture = Fixture::new();
        let path = fixture.write("boundary.md", b"needle");
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_len(MAX_BYTES).unwrap();
        assert_eq!(read_source(&path).unwrap().len() as u64, MAX_BYTES);
        assert_eq!(search_folder(as_string(&fixture.0), "needle".into(), 10).unwrap().len(), 1);
        file.set_len(MAX_BYTES + 1).unwrap();
        assert!(search_folder(as_string(&fixture.0), "needle".into(), 10).unwrap().is_empty());
    }

    #[test]
    fn search_clamps_limits_and_truncates_snippets_on_character_boundaries() {
        let fixture = Fixture::new();
        let text = "é".repeat(170);
        for index in 0..205 {
            fixture.write(&format!("note-{index:03}.md"), text.as_bytes());
        }
        let path = as_string(&fixture.0);
        let hits = search_folder(path.clone(), "É".into(), usize::MAX).unwrap();
        assert_eq!(hits.len(), 200);
        assert!(hits.iter().all(|hit| hit.text == "é".repeat(160)));
        assert_eq!(search_folder(path, "é".into(), 0).unwrap().len(), 1);
    }

}
