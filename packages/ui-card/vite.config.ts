import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained HTML file: the MCP App resource ui://care-circle/today.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
