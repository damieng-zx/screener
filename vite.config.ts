import { defineConfig } from 'vite';

/**
 * This project owns port 6912 (the size of a ZX Spectrum .scr in bytes, so it
 * will never collide with the default 5173 that every other Vite project wants).
 * `strictPort` makes a clash fail loudly instead of silently drifting.
 */
const PORT = 6912;

export default defineConfig({
  // Relative asset URLs, so the build works at a domain root, at a GitHub Pages
  // project subpath like /screener/, or from a file:// dump without rebuilding.
  base: './',
  server: {
    port: PORT,
    strictPort: true,
  },
  preview: {
    port: PORT,
    strictPort: true,
  },
  publicDir: 'public',
  build: {
    target: 'es2022',
    // The sample pictures in public/ exist only for the dev harnesses:
    // nothing in the app references them, and they are 370 kB of the bundle.
    copyPublicDir: false,
  },
});
