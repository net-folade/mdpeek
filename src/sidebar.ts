/* The file list. Folders are collapsible <details> elements, so open/closed
 * state lives in the DOM and keyboard toggling comes for free. Filtering drops
 * the tree for a flat, ranked list. */

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
    .map((e) => {
      const nameScore = fuzzyScore(q, e.name);
      return { e, s: Math.max(nameScore < 0 ? -1 : nameScore + 200, fuzzyScore(q, `${e.dir}/${e.name}`)) };
    })
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.e);
}

/** Folders the user has expanded, kept across re-renders (e.g. clearing the filter). */
const openDirs = new Set<string>();

function emptyMessage(nav: HTMLElement): void {
  const empty = document.createElement('div');
  empty.className = 'tree-dir';
  empty.textContent = 'no markdown files';
  nav.appendChild(empty);
}

function fileButton(
  name: string,
  path: string,
  activePath: string | null,
  onPick: (path: string) => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tree-item';
  btn.title = path;

  const label = document.createElement('span');
  label.textContent = name.replace(/\.(md|markdown|mdx|mdown)$/i, '');
  btn.appendChild(label);

  if (path === activePath) btn.setAttribute('aria-current', 'true');
  btn.addEventListener('click', () => onPick(path));
  return btn;
}

/**
 * Render the folder as a collapsible tree. Folders start closed unless the user
 * opened them earlier or they contain the active file.
 */
export function renderTree(
  nav: HTMLElement,
  root: TreeNode,
  activePath: string | null,
  onPick: (path: string) => void,
): void {
  nav.textContent = '';
  if (root.children.length === 0) {
    emptyMessage(nav);
    return;
  }

  const build = (node: TreeNode, parent: Node): void => {
    for (const child of node.children) {
      if (!child.isDir) {
        parent.appendChild(fileButton(child.name, child.path, activePath, onPick));
        continue;
      }
      const details = document.createElement('details');
      details.className = 'tree-folder';
      details.open = openDirs.has(child.path) || Boolean(activePath?.startsWith(`${child.path}/`));
      details.addEventListener('toggle', () => {
        if (details.open) openDirs.add(child.path);
        else openDirs.delete(child.path);
      });

      const summary = document.createElement('summary');
      summary.className = 'tree-dir';
      summary.textContent = child.name;
      summary.title = child.path;
      details.appendChild(summary);

      const children = document.createElement('div');
      children.className = 'tree-children';
      build(child, children);
      details.appendChild(children);
      parent.appendChild(details);
    }
  };

  const frag = document.createDocumentFragment();
  build(root, frag);
  nav.appendChild(frag);
}

/**
 * Render filtered results as a flat list. They come back in score order, not
 * directory order, so each row carries its own directory instead of a tree.
 */
export function renderResults(
  nav: HTMLElement,
  entries: FileEntry[],
  activePath: string | null,
  onPick: (path: string) => void,
): void {
  nav.textContent = '';
  if (entries.length === 0) {
    emptyMessage(nav);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const btn = fileButton(entry.name, entry.path, activePath, onPick);
    if (entry.dir) {
      const where = document.createElement('span');
      where.className = 'tree-where';
      where.textContent = `  ${entry.dir}`;
      btn.appendChild(where);
    }
    frag.appendChild(btn);
  }
  nav.appendChild(frag);
}

/** Move the aria-current flag without rebuilding the list. */
export function markActive(nav: HTMLElement, activePath: string | null): void {
  for (const el of nav.querySelectorAll<HTMLElement>('.tree-item')) {
    if (el.title === activePath) {
      el.setAttribute('aria-current', 'true');
      // Expand collapsed parent folders so the active file is visible.
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
        d.open = true;
      }
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.removeAttribute('aria-current');
    }
  }
}
