# mdpeek

A simple, lightweight Markdown reader.

Open a file, read it, move on. No sync, plugins, or vaults.

Built with Tauri, mdpeek uses the WebKit already on your Mac — no bundled Chromium or Electron runtime.

### Run

```sh
npm install
npm run tauri dev
```

Build the macOS app:

```sh
npm run tauri build
open src-tauri/target/release/bundle/macos/
```

To use `.md` file associations, build the app and move `mdpeek.app` to `/Applications`.

Because the app isn’t notarized, macOS may block downloaded builds. Clear the quarantine flag first:

```sh
xattr -d com.apple.quarantine /Applications/mdpeek.app
```

### Shortcuts

| Key | Action |
| --- | --- |
| `⌘O` / `⇧⌘O` | Open file / folder |
| `⌘K` | Jump to a file (`>` searches contents) |
| `⌘F` | Find in document |
| `⌘B` | Toggle sidebar |
| `⌘=` `⌘-` `⌘0` | Text size |
| `j` `k` `space` `g` `G` | Scroll |

You can also drop a `.md` file or folder onto the window, or open one from the shell:

```sh
mdpeek notes.md
```

### Small by design

A plain Markdown document loads about **151KB of JavaScript**.

KaTeX and Mermaid are loaded only when needed. Syntax highlighting includes only 13 languages, and unused KaTeX font formats are removed at build time.

The frontend bundle is about **4MB**, with Mermaid accounting for most of it.

### Safe by default

Filesystem access is handled by three read-only Rust commands, guarded by file extensions and an 8MB limit.

Rendered Markdown is sanitized with DOMPurify before reaching the DOM. Mermaid runs with `securityLevel: 'strict'`.

### Coming in v2

**Editing.**

mdpeek will stay a lightweight Markdown viewer, with the option to make quick edits to the file you're reading — without turning into a full-blown editor.

### Structure

```text
src/
  main.ts       app wiring and keyboard controls
  render.ts     Markdown rendering
  sidebar.ts    file navigation
  style.css     styles

src-tauri/src/
  lib.rs        app setup
  files.rs      read-only filesystem access
  watch.rs      live reload
```

That's it. mdpeek reads Markdown.