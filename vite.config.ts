import { defineConfig, type Plugin } from 'vite';

/**
 * KaTeX ships each font three times — woff2, woff and ttf — because it targets
 * browsers we will never run in. mdpeek only ever renders in the macOS WebKit
 * that Tauri embeds, which has supported woff2 since 2015. Dropping the other two
 * formats removes ~876KB from the app bundle and changes nothing on screen.
 */
function katexWoff2Only(): Plugin {
  return {
    name: 'katex-woff2-only',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset') continue;

        if (/KaTeX_.*\.(ttf|woff)$/.test(fileName)) {
          delete bundle[fileName];
          continue;
        }

        if (fileName.endsWith('.css') && typeof asset.source === 'string') {
          asset.source = asset.source.replace(
            /,\s*url\([^)]*\.(?:ttf|woff)\)\s*format\((?:"|')(?:truetype|woff)(?:"|')\)/g,
            '',
          );
        }
      }
    },
  };
}

// Tauri drives this dev server; the port is fixed so tauri.conf.json can point at it.
export default defineConfig({
  plugins: [katexWoff2Only()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust rebuilds are Cargo's job, not Vite's.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'esnext',
    // The whole point of the project: keep the eagerly-loaded bundle small and let
    // katex/mermaid land in their own chunks, fetched only when a document needs them.
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/mermaid')) return 'mermaid';
          if (id.includes('node_modules/katex')) return 'katex';
          return undefined;
        },
      },
    },
  },
});
