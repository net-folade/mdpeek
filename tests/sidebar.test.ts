import { describe, expect, it, vi } from 'vitest';
import { flatten, filterEntries, renderTree, markActive } from '../src/sidebar';

const entries = [
  { name: 'README.md', path: '/docs/README.md', dir: '' },
  { name: 'setup.md', path: '/docs/guide/setup.md', dir: 'guide' },
  { name: 'usage.md', path: '/docs/guide/usage.md', dir: 'guide' },
];

describe('file navigation', () => {
  it('flattens nested folders while preserving relative paths and order', () => {
    expect(flatten({ name: 'docs', path: '/docs', isDir: true, children: [
      { name: 'README.md', path: entries[0].path, isDir: false, children: [] },
      { name: 'guide', path: '/docs/guide', isDir: true, children: entries.slice(1).map(e => ({ ...e, isDir: false, children: [] })) },
    ] })).toEqual(entries);
  });

  it('filters by filename or directory and excludes nonmatches', () => {
    expect(filterEntries(entries, 'SETUP')).toEqual([entries[1]]);
    expect(filterEntries(entries, 'guide')).toEqual(entries.slice(1));
    expect(filterEntries(entries, 'zzzz')).toEqual([]);
    expect(filterEntries(entries, '  ')).toEqual(entries);
  });

  it('renders selectable files, groups folders, and moves the active marker', () => {
    const nav = document.createElement('nav');
    const pick = vi.fn();
    renderTree(nav, entries, entries[0].path, pick);
    expect(nav.querySelectorAll('.tree-dir')).toHaveLength(1);
    const buttons = nav.querySelectorAll('button');
    buttons[1].click();
    expect(pick).toHaveBeenCalledWith(entries[1].path);
    buttons[1].scrollIntoView = vi.fn();
    markActive(nav, entries[1].path);
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(buttons[1].getAttribute('aria-current')).toBe('true');
  });

  it('shows directory context for filtered results without repeated headings', () => {
    const nav = document.createElement('nav');
    renderTree(nav, entries.slice(1), null, vi.fn(), false);
    expect(nav.querySelectorAll('.tree-dir')).toHaveLength(0);
    expect(nav.querySelectorAll('.tree-where')).toHaveLength(2);
    renderTree(nav, [], null, vi.fn());
    expect(nav.textContent).toBe('no markdown files');
  });
});
