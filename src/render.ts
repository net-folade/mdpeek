/* Markdown → sanitized HTML.
 *
 * Two rules govern this file:
 *   1. Nothing reaches the DOM without passing through DOMPurify. Inside a Tauri
 *      webview, injected script can reach the IPC bridge — this is a real risk.
 *   2. KaTeX and Mermaid are ~1MB together. They are dynamically imported, and only
 *      when a document actually contains math or a diagram. Most documents never
 *      pay for them.
 */

import { marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

/* A curated language set (~30KB) instead of the ~900KB full build. Add more here
   as you need them — the import list is the whole cost model. */
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import toml from 'highlight.js/lib/languages/ini';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('toml', toml);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['rs'], { languageName: 'rust' });

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Math and diagram sources ride through the sanitizer as hidden *text*, not as
 * data-attributes. DOMPurify's SAFE_FOR_XML guard (on by default) deletes any
 * attribute whose value contains `-->`, which is exactly Mermaid's arrow syntax —
 * so `A --> B` silently lost its source. Text nodes are not subject to that rule. */
const SRC = 'peek-src';

const carry = (tag: 'div' | 'span', cls: string, src: string, attrs = ''): string =>
  `<${tag} class="${cls}"${attrs}><${tag === 'div' ? 'pre' : 'span'} class="${SRC}">${escapeHtml(src)}</${tag === 'div' ? 'pre' : 'span'}></${tag}>`;

const readSource = (el: HTMLElement): string => el.querySelector(`.${SRC}`)?.textContent ?? '';

/* Math is handled as real marked extensions rather than a pre-pass regex. That
   matters: it means marked's own precedence rules apply, so a `$` inside a fenced
   code block is left alone instead of being eaten as math. */

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src: string) => src.indexOf('$$'),
  tokenizer(src: string) {
    const m = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer: (token) => carry('div', 'math', token.text, ' data-display="1"'),
};

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src: string) => src.indexOf('$'),
  tokenizer(src: string) {
    // Currency is the hazard here: "costs $5 and that costs $10, so neither `$`…"
    // must survive untouched. Hence — no space just inside either delimiter, no
    // digit right after the closer, and no backtick or newline in between.
    // The backtick exclusion matters because marked runs custom inline extensions
    // *before* its own codespan tokenizer, so without it math would happily reach
    // across into an inline code span and swallow the `$` inside it.
    const m = /^\$(?!\s)((?:\\.|[^$\\`\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
    return undefined;
  },
  renderer: (token) => carry('span', 'math', token.text),
};

const slugCounts = new Map<string, number>();
const slugify = (s: string): string => {
  const base =
    s
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
  const n = slugCounts.get(base) ?? 0;
  slugCounts.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
};

marked.use({
  gfm: true,
  breaks: false,
  extensions: [mathBlock, mathInline],
  renderer: {
    code(token: Tokens.Code): string {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase();

      // Deferred to enhance() — mermaid is the single heaviest dependency here.
      if (lang === 'mermaid') {
        return carry('div', 'mermaid-block', token.text);
      }

      const body =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(token.text, { language: lang, ignoreIllegals: true }).value
          : escapeHtml(token.text);

      return `<pre><code class="hljs${lang ? ` language-${lang}` : ''}">${body}</code></pre>\n`;
    },
    heading(token: Tokens.Heading): string {
      const text = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${slugify(token.text)}">${text}</h${token.depth}>\n`;
    },
  },
});

/* YAML frontmatter is metadata, not prose, and Markdown has no notion of it —
 * left in place, `---\ntitle: Notes\n---` parses as a thematic break followed by
 * a *setext* heading, so `title: Notes` becomes an <h1>. That is the first thing
 * you see in most Obsidian, Jekyll and Hugo files. Delimiters are matched the way
 * every other frontmatter reader matches them: `---` on line one, next `---` closes.
 * Stripping happens here rather than at read time so state.fileSource keeps the
 * original line numbers that search hits are reported against. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parse + sanitize. The returned string is safe to assign to innerHTML. */
export function toSafeHtml(md: string): string {
  slugCounts.clear();
  const raw = marked.parse(md.replace(FRONTMATTER, ''), { async: false });
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true, svg: false, mathMl: false },
    ADD_ATTR: ['id'],
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['srcset', 'formaction'],
  });
}

/* ── lazy heavyweights ─────────────────────────────────────────────────────── */

type Katex = typeof import('katex').default;

let katexMod: Katex | null = null;
async function getKatex(): Promise<Katex> {
  if (!katexMod) {
    const [mod] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
    katexMod = mod.default;
  }
  return katexMod;
}

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      const css = getComputedStyle(document.documentElement);
      const v = (name: string) => css.getPropertyValue(name).trim();
      mermaid.initialize({
        startOnLoad: false,
        // 'strict' makes mermaid escape label content — keep it.
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: v('--font'),
        themeVariables: {
          background: v('--bg-inset'),
          primaryColor: v('--bg-raised'),
          primaryTextColor: v('--text'),
          primaryBorderColor: v('--border'),
          secondaryColor: v('--bg-inset'),
          tertiaryColor: v('--bg'),
          lineColor: v('--text-faint'),
          textColor: v('--text'),
          mainBkg: v('--bg-raised'),
          nodeBorder: v('--accent-dim'),
          clusterBkg: v('--bg'),
          fontSize: '13px',
        },
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

/** Reset caches so diagrams re-render against a changed palette. */
export function resetThemedRenderers(): void {
  mermaidReady = null;
}

let diagramSeq = 0;

/**
 * Post-render pass over already-sanitized DOM: math, diagrams, copy buttons.
 * Split from toSafeHtml so the synchronous text paints immediately and the
 * expensive extras fill in after.
 */
export async function enhance(root: HTMLElement): Promise<void> {
  const mathEls = Array.from(root.querySelectorAll<HTMLElement>('.math'));
  const diagramEls = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-block'));

  addCopyButtons(root);

  await Promise.all([
    mathEls.length ? renderMath(mathEls) : Promise.resolve(),
    diagramEls.length ? renderDiagrams(diagramEls) : Promise.resolve(),
  ]);
}

async function renderMath(els: HTMLElement[]): Promise<void> {
  const katex = await getKatex();
  for (const el of els) {
    const src = readSource(el);
    try {
      // trust:false forbids \htmlClass/\url style escapes; throwOnError:false
      // degrades to a red inline message instead of blowing up the document.
      el.innerHTML = katex.renderToString(src, {
        displayMode: el.dataset.display === '1',
        throwOnError: false,
        trust: false,
        output: 'html',
      });
    } catch (err) {
      el.classList.add('render-error');
      el.textContent = `math error: ${String(err)}`;
    }
  }
}

async function renderDiagrams(els: HTMLElement[]): Promise<void> {
  const mermaid = await getMermaid();
  for (const el of els) {
    const src = readSource(el);
    try {
      const { svg } = await mermaid.render(`mmd-${diagramSeq++}`, src);
      el.innerHTML = svg;
    } catch (err) {
      el.classList.add('render-error');
      el.textContent = `diagram error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

function addCopyButtons(root: HTMLElement): void {
  // `pre.peek-src` holds a hidden diagram source, not a code block the user wants.
  for (const pre of root.querySelectorAll(`pre:not(.${SRC})`)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'copied';
      } catch {
        btn.textContent = 'failed';
      }
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    });
    pre.appendChild(btn);
  }
}
