import { defineConfig } from 'astro/config';

// BlackIT Flow — static, client-state prototype.
// No adapter: the whole app is a single prerendered page plus one hydrated island.
export default defineConfig({
  site: 'https://flow.theblackit.com',
  output: 'static',
  // Astro refuses `outDir: './'`, and Hostinger's Git deploy serves the
  // repository root. `npm run build:deploy` therefore builds to `dist/` as
  // usual and promotes the output one level up.
  server: {
    host: true,
    port: 4321,
  },
  devToolbar: {
    enabled: false,
  },
});
