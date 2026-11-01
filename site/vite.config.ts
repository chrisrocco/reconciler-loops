import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The site imports the reconciler straight from ../src, so let the dev server read it.
// `base: './'` keeps the build relocatable: it can be served from any path.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5174, fs: { allow: ['..'] } },
});
