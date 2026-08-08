/* The file list. Deliberately flat-and-grouped rather than an expandable tree:
 * with ⌘K as the primary way to move around, collapsible folders would be extra
 * state and extra clicks for no real gain. */

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

export interface FileEntry {
  /** file name including extension */
  name: string;
  /** absolute path */
  path: string;
  /** directory path relative to the opened root, '' for root-level files */
  dir: string;
}

/** Depth-first flatten, directories dropped, order preserved from Rust. */
export function flatten(root: TreeNode): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (node: TreeNode, rel: string): void => {
    for (const child of node.children) {
      if (child.isDir) {
        walk(child, rel ? `${rel}/${child.name}` : child.name);
      } else {
        out.push({ name: child.name, path: child.path, dir: rel });
      }
    }
  };
  walk(root, '');
  return out;
}

/** Subsequence match with a light bias toward contiguous runs and name hits. */
export function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();

  const direct = h.indexOf(n);
  if (direct !== -1) return 1000 - direct;

  let score = 0;
  let run = 0;
  let hi = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found === -1) return -1;
    run = found === hi ? run + 1 : 0;
    score += 10 + run * 5 - Math.min(found - hi, 20);
    hi = found + 1;
  }
  return score;
}

export function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
  const q = query.trim();
  if (!q) return entries;
  return entries
    .map((e) => ({ e, s: Math.max(fuzzyScore(q, e.name) + 200, fuzzyScore(q, `${e.dir}/${e.name}`)) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.e);
}

/**
 * Render the list into `nav`.
 *
 * `grouped` must be false whenever the list has been filtered. Filtered results
 * come back in score order, not directory order, so the running "emit a heading
 * when the directory changes" logic would repeat headings and file items under
 * the wrong one. In that mode each row carries its own directory instead.
 */
export function renderTree(
  nav: HTMLElement,
  entries: FileEntry[],
  activePath: string | null,
  onPick: (path: string) => void,
  grouped = true,
): void {
  nav.textContent = '';

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-dir';
    empty.textContent = 'no markdown files';
    nav.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  let lastDir: string | null = null;

  for (const entry of entries) {
    if (grouped && entry.dir !== lastDir) {
      lastDir = entry.dir;
      if (entry.dir) {
        const label = document.createElement('div');
        label.className = 'tree-dir';
        label.textContent = entry.dir;
        label.title = entry.dir;
        frag.appendChild(label);
      }
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-item';
    btn.title = entry.path;

    const name = document.createElement('span');
    name.textContent = entry.name.replace(/\.(md|markdown|mdx|mdown)$/i, '');
    btn.appendChild(name);

    if (!grouped && entry.dir) {
      const where = document.createElement('span');
      where.className = 'tree-where';
      where.textContent = `  ${entry.dir}`;
      btn.appendChild(where);
    }

    if (entry.path === activePath) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => onPick(entry.path));
    frag.appendChild(btn);
  }

  nav.appendChild(frag);
}

/** Move the aria-current flag without rebuilding the list. */
export function markActive(nav: HTMLElement, activePath: string | null): void {
  for (const el of nav.querySelectorAll<HTMLElement>('.tree-item')) {
    if (el.title === activePath) {
      el.setAttribute('aria-current', 'true');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.removeAttribute('aria-current');
    }
  }
}
