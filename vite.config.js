import { defineConfig } from 'vite';

// Relative asset URLs let the same build serve from `/` locally and `/black-hole/` on GitHub Pages.
export default defineConfig({
  base: './',
});
