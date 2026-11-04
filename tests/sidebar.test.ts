import { describe, expect, it, vi } from 'vitest';
import { flatten, filterEntries, renderTree, renderResults, markActive } from '../src/sidebar';

const entries = [
  { name: 'README.md', path: '/docs/README.md', dir: '' },
  { name: 'setup.md', path: '/docs/guide/setup.md', dir: 'guide' },
  { name: 'usage.md', path: '/docs/guide/usage.md', dir: 'guide' },
];

const root = { name: 'docs', path: '/docs', isDir: true, children: [
  { name: 'README.md', path: entries[0].path, isDir: false, children: [] },
  { name: 'guide', path: '/docs/guide', isDir: true, children: entries.slice(1).map(e => ({ name: e.name, path: e.path, isDir: false, children: [] })) },
] };

describe('file navigation', () => {
  it('flattens nested folders while preserving relative paths and order', () => {
    expect(flatten(root)).toEqual(entries);
  });

  it('filters by filename or directory and excludes nonmatches', () => {
    expect(filterEntries(entries, 'SETUP')).toEqual([entries[1]]);
    expect(filterEntries(entries, 'guide')).toEqual(entries.slice(1));
    expect(filterEntries(entries, 'zzzz')).toEqual([]);
    expect(filterEntries(entries, '  ')).toEqual(entries);
  });

  it('renders folders as a collapsible tree and moves the active marker', () => {
    const nav = document.createElement('nav');
    const pick = vi.fn();
    renderTree(nav, root, entries[0].path, pick);
    const folder = nav.querySelector('details')!;
    expect(folder.querySelector('summary')!.textContent).toBe('guide');
    expect(folder.open).toBe(false);
    expect(folder.querySelectorAll('.tree-item')).toHaveLength(2);
    const buttons = nav.querySelectorAll<HTMLButtonElement>('.tree-item');
    buttons[1].click();
    expect(pick).toHaveBeenCalledWith(entries[1].path);
    buttons[1].scrollIntoView = vi.fn();
    markActive(nav, entries[1].path);
    expect(folder.open).toBe(true);
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(buttons[1].getAttribute('aria-current')).toBe('true');
  });

  it('opens folders that contain the active file', () => {
    const nav = document.createElement('nav');
    renderTree(nav, root, entries[2].path, vi.fn());
    expect(nav.querySelector('details')!.open).toBe(true);
    renderTree(nav, { ...root, children: [] }, null, vi.fn());
    expect(nav.textContent).toBe('no markdown files');
  });

  it('shows directory context for filtered results without folders', () => {
    const nav = document.createElement('nav');
    renderResults(nav, entries.slice(1), null, vi.fn());
    expect(nav.querySelectorAll('details')).toHaveLength(0);
    expect(nav.querySelectorAll('.tree-where')).toHaveLength(2);
    renderResults(nav, [], null, vi.fn());
    expect(nav.textContent).toBe('no markdown files');
  });
});
