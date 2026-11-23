import { defineConfig } from 'vite';

/**
 * This project owns port 6912 (the size of a ZX Spectrum .scr in bytes, so it
 * will never collide with the default 5173 that every other Vite project wants).
 * `strictPort` makes a clash fail loudly instead of silently drifting to
 * another port.
 */
const PORT = 6912;

export default defineConfig({
  base: './',
  server: {
    port: PORT,
    strictPort: true,
  },
  preview: {
    port: PORT,
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
});
