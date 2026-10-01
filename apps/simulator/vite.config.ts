import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { host: process.env.VITE_HOST ?? 'localhost', port: 5174, strictPort: true },
});
