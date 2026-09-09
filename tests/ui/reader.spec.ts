import { test, expect } from '@playwright/test';

const markdown = '# Layout check\n\n' + ('A long paragraph should use the available reading width as the window grows. '.repeat(20) + '\n\n').repeat(12);

test.beforeEach(async ({ page }, testInfo) => {
  // Exercise the real frontend and stylesheet; only the native IPC is replaced.
  await page.addInitScript(({ source }) => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: () => 1,
        invoke: async (command: string) => {
          if (command === 'get_startup_path') return '/docs';
          if (command === 'list_tree') return {
            name: 'docs', path: '/docs', isDir: true,
            children: [{ name: 'README.md', path: '/docs/README.md', isDir: false, children: [] }],
          };
          if (command === 'read_md') return source;
          return null;
        },
      },
    });
  }, { source: testInfo.title === 'renders lazy math and diagrams in WebKit'
    ? '$x^2$\n\n```mermaid\ngraph TD; A --> B\n```' : markdown });
});

test('long documents fill the reader, resize, scroll, and reclaim collapsed sidebar space', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 760 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#content h1')).toHaveText('Layout check');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 13, 15)');
  await expect(page.locator('#app')).toHaveCSS('display', 'grid');
  const paragraph = page.locator('#content p').first();
  await expect.poll(async () => (await paragraph.boundingBox())!.x).toBe(272);
  const initial = await paragraph.boundingBox();
  expect(initial!.width).toBeGreaterThan(600);
  expect(initial!.x).toBeGreaterThan(232);
  await page.setViewportSize({ width: 1440, height: 760 });
  await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeGreaterThan(initial!.width + 450);
  await page.getByRole('button', { name: 'hide files', exact: true }).click();
  await expect(page.locator('#btn-sidebar')).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await paragraph.boundingBox())!.x).toBeLessThan(50);
  await expect.poll(async () => (await paragraph.boundingBox())!.width).toBeGreaterThan(1300);
  expect(await page.locator('#content').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.locator('#content').evaluate(el => el.scrollTop = el.scrollHeight);
  expect(await page.locator('#content').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'show files', exact: true }).click();
  await expect(page.locator('#tree button')).toHaveCount(1);
});

test('the initial window is styled even when app JavaScript cannot load', async ({ page }) => {
  await page.route('**/src/main.ts', route => route.abort());
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toHaveCSS('display', 'grid');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 13, 15)');
  await expect(page.locator('#empty')).toHaveCSS('display', 'flex');
  const empty = await page.locator('#empty').boundingBox();
  expect(empty!.width).toBeGreaterThan(800);
});


test('renders lazy math and diagrams in WebKit', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.katex')).toHaveCount(1);
  await expect(page.locator('.mermaid-block svg')).toHaveCount(1);
  await expect(page.locator('.render-error')).toHaveCount(0);
});
