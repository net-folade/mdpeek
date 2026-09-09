import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

import { toSafeHtml, enhance, resetThemedRenderers } from './render';
import {
  flatten,
  filterEntries,
  renderTree,
  markActive,
  type FileEntry,
  type TreeNode,
} from './sidebar';

const MD_FILTER = { name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'mdown'] };

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const app = $('app');
const sidebar = $('sidebar');
const sidebarButton = $<HTMLButtonElement>('btn-sidebar');
const content = $<HTMLElement>('content');
const reader = $('reader');
const emptyState = $('empty');
const crumb = $('crumb');
const tree = $('tree');
const filterInput = $<HTMLInputElement>('filter');
const folderName = $('folder-name');
const toastEl = $('toast');

const palette = $('palette');
const paletteInput = $<HTMLInputElement>('palette-input');
const paletteList = $<HTMLUListElement>('palette-list');

const findBar = $('find');
const findInput = $<HTMLInputElement>('find-input');
const findCount = $('find-count');

interface State {
  filePath: string | null;
  fileSource: string;
  folderPath: string | null;
  entries: FileEntry[];
}

const state: State = { filePath: null, fileSource: '', folderPath: null, entries: [] };

function setSidebarVisible(visible: boolean): void {
  if (!visible && sidebar.contains(document.activeElement)) sidebarButton.focus();
  app.dataset.sidebar = visible ? 'shown' : 'hidden';
  sidebar.inert = !visible;
  sidebarButton.setAttribute('aria-expanded', String(visible));
  sidebarButton.textContent = visible ? 'hide files' : 'show files';
  sidebarButton.title = `${visible ? 'Hide' : 'Show'} files — ⌘B`;
}

function toggleSidebar(): void {
  setSidebarVisible(app.dataset.sidebar !== 'shown');
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;
const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';

let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2200);
}

/* ── opening files ─────────────────────────────────────────────────────────── */

async function openFile(path: string, opts: { keepScroll?: boolean } = {}): Promise<void> {
  let source: string;
  try {
    source = await invoke<string>('read_md', { path });
  } catch (err) {
    toast(String(err));
    return;
  }

  const scrollTop = opts.keepScroll ? content.scrollTop : 0;
  const isSameFile = state.filePath === path;

  state.filePath = path;
  state.fileSource = source;

  closeFind();
  content.innerHTML = toSafeHtml(source);
  resolveAssets(dirname(path));
  content.scrollTop = opts.keepScroll && isSameFile ? scrollTop : 0;

  emptyState.hidden = true;
  updateCrumb(path);
  markActive(tree, path);
  document.title = basename(path);

  // Watch after render so a slow first paint isn't held up by the IPC round trip.
  void invoke('watch_file', { path }).catch(() => {
    /* watching is a nicety; a failure here shouldn't surface to the user */
  });

  await enhance(content);
}

/**
 * Point `<img src>` at something the webview can actually fetch.
 *
 * A relative `![](diagram.png)` would otherwise resolve against the frontend
 * origin (tauri://localhost) and 404 — every screenshot in every README shows as
 * a broken image. convertFileSrc maps an absolute path onto the asset protocol;
 * read_md has already added the document's directory to that protocol's scope.
 */
function resolveAssets(baseDir: string): void {
  for (const img of content.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src');
    // Absolute URLs and inline data are already loadable; leave them be.
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) continue;
    img.src = convertFileSrc(
      src.startsWith('/') ? decodeURIComponent(src) : resolveRelative(baseDir, src),
    );
  }
}

async function openFolder(path: string): Promise<void> {
  let root: TreeNode;
  try {
    root = await invoke<TreeNode>('list_tree', { path });
  } catch (err) {
    toast(String(err));
    return;
  }

  state.folderPath = path;
  state.entries = flatten(root);
  folderName.textContent = basename(path);
  folderName.title = path;
  filterInput.value = '';
  renderTree(tree, state.entries, state.filePath, (p) => void openFile(p));
  setSidebarVisible(true);

  if (!state.filePath) {
    const readme = state.entries.find((e) => /^readme\.mdx?$/i.test(e.name)) ?? state.entries[0];
    if (readme) await openFile(readme.path);
  }
}

function updateCrumb(path: string): void {
  crumb.textContent = '';
  const dir = dirname(path);
  const rel = state.folderPath && path.startsWith(state.folderPath)
    ? dir.slice(state.folderPath.length).replace(/^\//, '')
    : shortenHome(dir);

  if (rel) crumb.append(document.createTextNode(`${rel}/`));
  const name = document.createElement('b');
  name.textContent = basename(path);
  crumb.append(name);
  crumb.title = path;
}

/** Home directory inferred from the open file's path, or null when it isn't under one. */
const homeGuess = (): string | null => {
  const m = /^(\/Users\/[^/]+)/.exec(state.filePath ?? '');
  return m ? m[1] : null;
};

/* `/Users/you/notes` becomes `~/notes`. This used to build a RegExp and use a NUL
   byte as the "no home found" sentinel. A NUL makes git classify main.ts as binary,
   which costs reviewable diffs and makes plain grep skip the file. A prefix check
   needs neither a sentinel nor regex escaping. */
const shortenHome = (dir: string): string => {
  const home = homeGuess();
  return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
};

async function pickFile(): Promise<void> {
  const picked = await openDialog({ multiple: false, directory: false, filters: [MD_FILTER] });
  if (typeof picked === 'string') await openFile(picked);
}

async function pickFolder(): Promise<void> {
  const picked = await openDialog({ multiple: false, directory: true });
  if (typeof picked === 'string') await openFolder(picked);
}

/* ── links ─────────────────────────────────────────────────────────────────── */

content.addEventListener('click', (ev) => {
  const anchor = (ev.target as HTMLElement | null)?.closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href) return;

  ev.preventDefault();

  if (href.startsWith('#')) {
    const target = content.querySelector(`#${CSS.escape(href.slice(1))}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Anything with a scheme — http(s), mailto:, and the rest — is the system's job.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    void openUrl(href).catch(() => toast('could not open link'));
    return;
  }

  // Relative path — resolve against the current file.
  if (!state.filePath) return;
  const [rel] = href.split('#');
  if (!rel) return;
  const target = resolveRelative(dirname(state.filePath), rel);

  // Markdown opens in place; that is the whole point of the app.
  if (isMd(target)) {
    void openFile(target);
    return;
  }

  // Any other local file gets revealed in Finder rather than launched. Handing an
  // arbitrary path from an untrusted document to the system opener would let a
  // document choose what executes; revealing only ever opens Finder.
  void revealItemInDir(target).catch(() => toast(`can't open ${basename(target)}`));
});

function resolveRelative(base: string, rel: string): string {
  const stack = base.split('/');
  for (const part of decodeURIComponent(rel).split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/') || '/';
}

reader.addEventListener(
  'scroll',
  () => {
    reader.dataset.scrolled = content.scrollTop > 4 ? 'true' : 'false';
  },
  true,
);

/* ── in-document find ──────────────────────────────────────────────────────── */

let marks: HTMLElement[] = [];
let markIndex = 0;

function clearMarks(): void {
  for (const mark of Array.from(content.querySelectorAll('mark[data-find]'))) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
  }
  content.normalize();
  marks = [];
  markIndex = 0;
}

function runFind(query: string): void {
  clearMarks();
  const q = query.trim();
  if (q.length < 1) {
    findCount.textContent = '';
    return;
  }

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      // Leave rendered math and diagrams alone — splitting their nodes breaks them.
      // .copy-btn is chrome, not document text: without it, searching "copy" lights
      // up the button on every code block.
      const parent = (node.parentElement as HTMLElement | null)?.closest(
        '.katex, svg, .mermaid-block, .copy-btn',
      );
      return parent ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

  const needle = q.toLowerCase();
  for (const node of targets) {
    let text = node.nodeValue ?? '';
    let cursor = node;
    let at = text.toLowerCase().indexOf(needle);
    while (at !== -1) {
      const after = cursor.splitText(at);
      const rest = after.splitText(needle.length);
      const mark = document.createElement('mark');
      mark.dataset.find = '1';
      mark.textContent = after.nodeValue;
      after.replaceWith(mark);
      marks.push(mark);
      cursor = rest;
      text = rest.nodeValue ?? '';
      at = text.toLowerCase().indexOf(needle);
    }
  }

  markIndex = 0;
  focusMark(0);
}

function focusMark(index: number): void {
  if (marks.length === 0) {
    findCount.textContent = '0/0';
    return;
  }
  markIndex = (index + marks.length) % marks.length;
  marks.forEach((m, i) => m.classList.toggle('on', i === markIndex));
  marks[markIndex].scrollIntoView({ block: 'center' });
  findCount.textContent = `${markIndex + 1}/${marks.length}`;
}

function openFind(): void {
  findBar.hidden = false;
  findInput.select();
  findInput.focus();
}

function closeFind(): void {
  findBar.hidden = true;
  clearMarks();
  findCount.textContent = '';
}

findInput.addEventListener('input', () => runFind(findInput.value));
findInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    focusMark(markIndex + (ev.shiftKey ? -1 : 1));
  } else if (ev.key === 'Escape') {
    closeFind();
    content.focus();
  }
});
$('find-next').addEventListener('click', () => focusMark(markIndex + 1));
$('find-prev').addEventListener('click', () => focusMark(markIndex - 1));
$('find-close').addEventListener('click', closeFind);

/* ── quick switcher ────────────────────────────────────────────────────────── */

interface Hit {
  path: string;
  name: string;
  line: number;
  text: string;
}

type PaletteRow = { path: string; primary: string; secondary: string; line?: number };

let paletteRows: PaletteRow[] = [];
let paletteIndex = 0;
let searchTimer: number | undefined;

function openPalette(): void {
  if (!state.folderPath) {
    toast('open a folder first — ⇧⌘O');
    return;
  }
  palette.hidden = false;
  paletteInput.value = '';
  paletteInput.focus();
  refreshPalette();
}

function closePalette(): void {
  palette.hidden = true;
  window.clearTimeout(searchTimer);
  content.focus();
}

function refreshPalette(): void {
  const raw = paletteInput.value;
  window.clearTimeout(searchTimer);

  if (raw.startsWith('>')) {
    const query = raw.slice(1).trim();
    if (query.length < 2) {
      drawPalette([], 'type at least 2 characters');
      return;
    }
    // Debounced: this greps every file in the folder on the Rust side.
    searchTimer = window.setTimeout(() => void runContentSearch(query), 130);
    return;
  }

  paletteRows = filterEntries(state.entries, raw)
    .slice(0, 60)
    .map((e) => ({ path: e.path, primary: e.name, secondary: e.dir }));
  drawPalette(paletteRows, 'no matching file');
}

async function runContentSearch(query: string): Promise<void> {
  if (!state.folderPath) return;
  try {
    const hits = await invoke<Hit[]>('search_folder', {
      path: state.folderPath,
      query,
      limit: 60,
    });
    paletteRows = hits.map((h) => ({
      path: h.path,
      primary: h.name,
      secondary: h.text.trim().slice(0, 90),
      line: h.line,
    }));
    drawPalette(paletteRows, 'nothing found');
  } catch (err) {
    drawPalette([], String(err));
  }
}

function drawPalette(rows: PaletteRow[], emptyMsg: string): void {
  paletteRows = rows;
  paletteIndex = 0;
  paletteList.textContent = '';

  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'pl-empty';
    li.textContent = emptyMsg;
    paletteList.appendChild(li);
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    if (i === 0) li.setAttribute('aria-selected', 'true');

    const name = document.createElement('span');
    name.className = 'pl-hit';
    name.textContent = row.primary;
    li.append(name);

    if (row.secondary) {
      const sub = document.createElement('span');
      sub.className = row.line ? 'pl-snip' : 'pl-dir';
      sub.textContent = `  ${row.secondary}`;
      li.append(sub);
    }

    li.addEventListener('click', () => choosePalette(i));
    frag.appendChild(li);
  });
  paletteList.appendChild(frag);
}

function movePalette(delta: number): void {
  const items = paletteList.querySelectorAll('li');
  if (paletteRows.length === 0) return;
  paletteIndex = (paletteIndex + delta + paletteRows.length) % paletteRows.length;
  items.forEach((li, i) => {
    if (i === paletteIndex) {
      li.setAttribute('aria-selected', 'true');
      li.scrollIntoView({ block: 'nearest' });
    } else {
      li.removeAttribute('aria-selected');
    }
  });
}

async function choosePalette(index: number): Promise<void> {
  const row = paletteRows[index];
  if (!row) return;
  closePalette();
  await openFile(row.path);
  if (row.line) scrollToLine(row.line);
}

/** Approximate: jump to the block element whose text matches the hit line. */
function scrollToLine(line: number): void {
  const sourceLine = state.fileSource.split('\n')[line - 1]?.trim();
  if (!sourceLine) return;
  const probe = sourceLine.replace(/[#*_`>\-\s]+/g, ' ').trim().slice(0, 40);
  if (probe.length < 4) return;
  for (const el of content.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, pre, td')) {
    if (el.textContent?.includes(probe)) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
  }
}

paletteInput.addEventListener('input', refreshPalette);
paletteInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' || (ev.key === 'n' && ev.ctrlKey)) {
    ev.preventDefault();
    movePalette(1);
  } else if (ev.key === 'ArrowUp' || (ev.key === 'p' && ev.ctrlKey)) {
    ev.preventDefault();
    movePalette(-1);
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    void choosePalette(paletteIndex);
  } else if (ev.key === 'Escape') {
    closePalette();
  }
});
palette.addEventListener('mousedown', (ev) => {
  if (ev.target === palette) closePalette();
});

/* ── sidebar filter ────────────────────────────────────────────────────────── */

filterInput.addEventListener('input', () => {
  const query = filterInput.value.trim();
  renderTree(
    tree,
    filterEntries(state.entries, query),
    state.filePath,
    (p) => void openFile(p),
    query === '',
  );
});

/* ── keyboard ──────────────────────────────────────────────────────────────── */

const isTyping = (): boolean => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
};

let fontScale = 1;
function setFontScale(next: number): void {
  fontScale = Math.min(1.8, Math.max(0.75, next));
  document.documentElement.style.setProperty('--size', `${13.5 * fontScale}px`);
}

document.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey;

  if (mod && ev.key.toLowerCase() === 'o') {
    ev.preventDefault();
    void (ev.shiftKey ? pickFolder() : pickFile());
    return;
  }
  if (mod && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    openPalette();
    return;
  }
  if (mod && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    openFind();
    return;
  }
  if (mod && ev.key.toLowerCase() === 'b') {
    ev.preventDefault();
    toggleSidebar();
    return;
  }
  if (mod && (ev.key === '=' || ev.key === '+')) {
    ev.preventDefault();
    setFontScale(fontScale + 0.1);
    return;
  }
  if (mod && ev.key === '-') {
    ev.preventDefault();
    setFontScale(fontScale - 0.1);
    return;
  }
  if (mod && ev.key === '0') {
    ev.preventDefault();
    setFontScale(1);
    return;
  }
  if (ev.key === 'Escape') {
    if (!palette.hidden) closePalette();
    else if (!findBar.hidden) closeFind();
    return;
  }

  if (isTyping()) return;

  // Reader-style navigation, only when nothing is focused for typing.
  const step = content.clientHeight * 0.9;
  switch (ev.key) {
    case 'j':
      content.scrollBy({ top: 60 });
      break;
    case 'k':
      content.scrollBy({ top: -60 });
      break;
    case ' ':
      ev.preventDefault();
      content.scrollBy({ top: ev.shiftKey ? -step : step, behavior: 'smooth' });
      break;
    case 'g':
      content.scrollTo({ top: 0 });
      break;
    case 'G':
      content.scrollTo({ top: content.scrollHeight });
      break;
    case 'n':
      if (marks.length) focusMark(markIndex + 1);
      break;
    case 'N':
      if (marks.length) focusMark(markIndex - 1);
      break;
  }
});

$('btn-file').addEventListener('click', () => void pickFile());
sidebarButton.addEventListener('click', toggleSidebar);
$('btn-folder').addEventListener('click', () => void pickFolder());

/* ── host integration ──────────────────────────────────────────────────────── */

const isMd = (p: string): boolean => /\.(md|markdown|mdx|mdown)$/i.test(p);

async function boot(): Promise<void> {
  // Fires when the app is already running and a file is double-clicked in Finder.
  await listen<string>('open-path', (ev) => {
    if (ev.payload !== state.filePath) void openFile(ev.payload);
  });

  // The watcher lets peekmd act as a live preview beside any editor.
  await listen<string>('file-changed', (ev) => {
    if (ev.payload === state.filePath) void openFile(ev.payload, { keepScroll: true });
  });

  await getCurrentWebview().onDragDropEvent((ev) => {
    if (ev.payload.type !== 'drop') return;
    const dropped = ev.payload.paths;
    const file = dropped.find(isMd);
    if (file) void openFile(file);
    else if (dropped[0]) void openFolder(dropped[0]);
  });

  // Cold start: macOS may deliver the opened file before this webview existed, so
  // Rust stashes it and we collect it here. Also covers `peekmd file.md` from a shell.
  const startup = await invoke<string | null>('get_startup_path');
  if (startup) {
    if (isMd(startup)) await openFile(startup);
    else await openFolder(startup);
  }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  resetThemedRenderers();
  if (state.filePath) void openFile(state.filePath, { keepScroll: true });
});

void boot().catch((err) => toast(`startup: ${String(err)}`));
