import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { invoke, open, openUrl, revealItemInDir, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(), open: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn(),
  listeners: new Map<string, (event: { payload: string }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, callback) => { listeners.set(name, callback); return () => {}; }) }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl, revealItemInDir }));

let documentEvents: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  listeners.clear();
  openUrl.mockResolvedValue(undefined);
  revealItemInDir.mockResolvedValue(undefined);
  documentEvents = vi.spyOn(document, 'addEventListener');
  document.documentElement.innerHTML = readFileSync(`${import.meta.dirname}/../index.html`, 'utf8');
  vi.stubGlobal('matchMedia', () => ({ addEventListener: vi.fn() }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  invoke.mockImplementation(async (command: string) => {
    if (command === 'list_tree') return { name: 'docs', path: '/docs', isDir: true, children: [
      { name: 'README.md', path: '/docs/README.md', isDir: false, children: [] },
    ] };
    if (command === 'read_md') return '# Welcome\n\nHello reader';
    return null;
  });
  await import('../src/main');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('get_startup_path'));
});

afterEach(() => {
  for (const [type, listener, options] of documentEvents.mock.calls) {
    document.removeEventListener(type, listener, options);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openDocs() {
  open.mockResolvedValue('/docs');
  document.getElementById('btn-folder')!.click();
  await vi.waitFor(() => expect(document.querySelector('#content h1')?.textContent).toBe('Welcome'));
}

it('opens a directory, collapses and reopens its file list with button and keyboard', async () => {
  const button = document.getElementById('btn-sidebar')!;
  const sidebar = document.getElementById('sidebar')!;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  open.mockResolvedValue('/docs');
  document.getElementById('btn-folder')!.click();
  await vi.waitFor(() => expect(document.querySelector('#content h1')?.textContent).toBe('Welcome'));
  expect(button.getAttribute('aria-expanded')).toBe('true');
  button.click();
  expect(document.getElementById('app')!.dataset.sidebar).toBe('hidden');
  expect(sidebar.inert).toBe(true);
  button.click();
  expect(sidebar.inert).toBe(false);
  const filter = document.getElementById('filter')!;
  filter.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true }));
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('#tree button')).toHaveLength(1);
});

it('shows read errors without replacing the currently open document', async () => {
  await openDocs();
  invoke.mockRejectedValueOnce(new Error('cannot read file'));
  open.mockResolvedValue('/docs/missing.md');
  document.getElementById('btn-file')!.click();
  await vi.waitFor(() => expect(document.getElementById('toast')!.textContent).toContain('cannot read file'));
  expect(document.querySelector('#content h1')?.textContent).toBe('Welcome');
});


it('leaves the reader unchanged when the file dialog is cancelled', async () => {
  await openDocs();
  invoke.mockClear();
  open.mockResolvedValue(null);
  document.getElementById('btn-file')!.click();
  await vi.waitFor(() => expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ directory: false })));
  expect(invoke).not.toHaveBeenCalled();
  expect(document.querySelector('#content h1')?.textContent).toBe('Welcome');
});

it('switches visibly between editing and preview and saves changes', async () => {
  await openDocs();
  const edit = document.getElementById('btn-edit') as HTMLButtonElement;
  const save = document.getElementById('btn-save') as HTMLButtonElement;
  const editor = document.getElementById('editor') as HTMLTextAreaElement;

  expect(edit.hidden).toBe(false);
  expect(edit.textContent).toBe('edit');
  edit.click();
  expect(edit.textContent).toBe('preview');
  expect(editor.hidden).toBe(false);
  expect(editor.value).toContain('# Welcome');

  editor.value = '# Draft';
  editor.dispatchEvent(new Event('input'));
  expect(save.disabled).toBe(false);
  expect(document.getElementById('save-status')!.textContent).toBe('unsaved');

  edit.click();
  await vi.waitFor(() => expect(document.querySelector('#content h1')?.textContent).toBe('Draft'));
  invoke.mockClear();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('write_md', {
    path: '/docs/README.md', source: '# Draft', expectedSource: '# Welcome\n\nHello reader',
  }));
  expect(save.disabled).toBe(true);
  expect(document.getElementById('save-status')!.textContent).toBe('');
});

it('keeps newer edits dirty and serializes saves while a write is pending', async () => {
  await openDocs();
  document.getElementById('btn-edit')!.click();
  const editor = document.getElementById('editor') as HTMLTextAreaElement;
  const save = document.getElementById('btn-save') as HTMLButtonElement;
  let finishWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
  invoke.mockImplementation((command: string) => command === 'write_md' ? pendingWrite : null);

  editor.value = '# First draft';
  editor.dispatchEvent(new Event('input'));
  save.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('write_md', {
    path: '/docs/README.md', source: '# First draft', expectedSource: '# Welcome\n\nHello reader',
  }));

  editor.value = '# Newer draft';
  editor.dispatchEvent(new Event('input'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
  expect(invoke.mock.calls.filter(([command]) => command === 'write_md')).toHaveLength(1);

  finishWrite();
  await vi.waitFor(() => expect(save.textContent).toBe('save'));
  expect(save.disabled).toBe(false);
  expect(document.getElementById('save-status')!.textContent).toBe('unsaved');
});

it('does not apply a completed save to a file opened while the write is pending', async () => {
  await openDocs();
  document.getElementById('btn-edit')!.click();
  const editor = document.getElementById('editor') as HTMLTextAreaElement;
  let finishWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
  invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === 'write_md') return pendingWrite;
    if (command === 'read_md' && args?.path === '/docs/other.md') return '# Other';
    return null;
  });

  editor.value = '# Draft';
  editor.dispatchEvent(new Event('input'));
  document.getElementById('btn-save')!.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('write_md', expect.anything()));

  vi.spyOn(window, 'confirm').mockReturnValue(true);
  open.mockResolvedValue('/docs/other.md');
  document.getElementById('btn-file')!.click();
  await vi.waitFor(() => expect(document.querySelector('#content h1')?.textContent).toBe('Other'));
  finishWrite();
  await vi.waitFor(() => expect(document.getElementById('btn-save')!.textContent).toBe('save'));

  document.getElementById('btn-edit')!.click();
  editor.dispatchEvent(new Event('input'));
  expect(editor.value).toBe('# Other');
  expect((document.getElementById('btn-save') as HTMLButtonElement).disabled).toBe(true);
});

it('allows an explicit confirmed reload of the current dirty file', async () => {
  await openDocs();
  document.getElementById('btn-edit')!.click();
  const editor = document.getElementById('editor') as HTMLTextAreaElement;
  editor.value = '# Unsaved';
  editor.dispatchEvent(new Event('input'));

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  open.mockResolvedValue('/docs/README.md');
  invoke.mockImplementation(async (command: string) => {
    if (command === 'read_md') return '# Reloaded';
    return null;
  });
  document.getElementById('btn-file')!.click();

  await vi.waitFor(() => expect(document.querySelector('#content h1')?.textContent).toBe('Reloaded'));
  expect(confirm).toHaveBeenCalledWith('discard unsaved changes?');
  expect(editor.value).toBe('# Reloaded');
});

it('keeps unsaved text when a watched file changes', async () => {
  await openDocs();
  document.getElementById('btn-edit')!.click();
  const editor = document.getElementById('editor') as HTMLTextAreaElement;
  editor.value = '# Unsaved';
  editor.dispatchEvent(new Event('input'));
  invoke.mockClear();

  listeners.get('file-changed')!({ payload: '/docs/README.md' });

  expect(invoke).not.toHaveBeenCalled();
  expect(editor.value).toBe('# Unsaved');
  expect(document.getElementById('toast')!.textContent).toContain('changed on disk');
});

it('finds text case-insensitively and clears highlights on Escape', async () => {
  await openDocs();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
  const input = document.getElementById('find-input') as HTMLInputElement;
  input.value = 'HELLO';
  input.dispatchEvent(new Event('input'));
  expect(document.querySelector('mark[data-find]')?.textContent).toBe('Hello');
  expect(document.getElementById('find-count')!.textContent).toBe('1/1');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(document.querySelector('mark[data-find]')).toBeNull();
  expect(document.getElementById('find')!.hidden).toBe(true);
  expect(document.querySelector('#content p')?.textContent).toBe('Hello reader');
});

it('reloads only the active file and preserves its scroll position', async () => {
  await openDocs();
  const content = document.getElementById('content')!;
  content.scrollTop = 120;
  invoke.mockClear();
  listeners.get('file-changed')!({ payload: '/docs/other.md' });
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce('# Updated');
  listeners.get('file-changed')!({ payload: '/docs/README.md' });
  await vi.waitFor(() => expect(content.querySelector('h1')?.textContent).toBe('Updated'));
  expect(content.scrollTop).toBe(120);
});

it('routes Markdown links to the reader, web links to the browser, and other files to Finder', async () => {
  await openDocs();
  const content = document.getElementById('content')!;
  content.innerHTML = '<a href="https://example.com">web</a><a href="../script.sh">local</a><a href="guide/next%20page.md">next</a>';
  const links = content.querySelectorAll('a');
  links[0].click();
  expect(openUrl).toHaveBeenCalledWith('https://example.com');
  links[1].click();
  expect(revealItemInDir).toHaveBeenCalledWith('/script.sh');
  links[2].click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('read_md', { path: '/docs/guide/next page.md' }));
});
