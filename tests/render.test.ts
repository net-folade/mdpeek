import { describe, expect, it, vi } from 'vitest';
import { toSafeHtml, enhance } from '../src/render';

function render(source: string) {
  const root = document.createElement('article');
  root.innerHTML = toSafeHtml(source);
  return root;
}

describe('Markdown rendering', () => {
  it('renders headings, tables, tasks and highlighted fenced code', () => {
    const root = render('# Hello\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n```js\nconst x = 1;\n```');
    expect(root.querySelector('h1')?.id).toBe('hello');
    expect(root.querySelectorAll('td')).toHaveLength(2);
    expect(root.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    expect(root.querySelector('pre code .hljs-keyword')?.textContent).toBe('const');
  });

  it('strips frontmatter and resets duplicate heading IDs for every document', () => {
    const md = '---\ntitle: hidden\n---\n# Same\n# Same';
    for (let i = 0; i < 2; i++) {
      const root = render(md);
      expect(root.textContent).not.toContain('hidden');
      expect([...root.querySelectorAll('h1')].map(h => h.id)).toEqual(['same', 'same-1']);
    }
  });

  it('removes executable HTML and unsafe URLs while keeping ordinary links', () => {
    const root = render('<script>alert(1)</script><img src="x" onerror="alert(1)"><span onclick="alert(1)">sanitized text</span><iframe src="https://evil.test"></iframe><form><input></form>\n\n[bad](javascript:alert%281%29) [good](https://example.com)');
    expect(root.querySelector('script, iframe, form, [onerror], [onclick]')).toBeNull();
    expect(root.querySelector('span')?.textContent).toBe('sanitized text');
    expect(root.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(root.querySelector('a[href="https://example.com"]')).not.toBeNull();
  });

  it('preserves diagram arrows and keeps math syntax inside code literal', async () => {
    const root = render('```mermaid\ngraph TD; A --> B\n```\n\n```text\n$x$\n```');
    expect(root.querySelector('.peek-src')?.textContent).toBe('graph TD; A --> B');
    expect(root.querySelector('.math')).toBeNull();
    const code = render('```text\n$x$\n```');
    await enhance(code);
    expect(code.querySelector('code')?.textContent).toBe('$x$');
    expect(code.querySelectorAll('.copy-btn')).toHaveLength(1);
  });
});


describe('rendering enhancements', () => {
  it('renders inline and display math without treating currency or inline code as math', async () => {
    const root = render('Costs $5 and $10. `literal $x$`\n\n$x^2$\n\n$$\nx + y\n$$');
    expect(root.querySelectorAll('.math')).toHaveLength(2);
    expect(root.querySelector('code')?.textContent).toBe('literal $x$');
    await enhance(root);
    expect(root.querySelectorAll('.katex')).toHaveLength(2);
    expect(root.querySelector('.katex-display')).not.toBeNull();
    expect(root.textContent).toContain('Costs $5 and $10.');
  });

  it('escapes unknown fenced languages and copies the original code', async () => {
    const root = render('```unknown\n<script>alert(1)</script>\n```');
    expect(root.querySelector('script')).toBeNull();
    await enhance(root);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      root.querySelector<HTMLButtonElement>('.copy-btn')!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('<script>alert(1)</script>'));
      expect(root.querySelector('.copy-btn')?.textContent).toBe('copied');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
