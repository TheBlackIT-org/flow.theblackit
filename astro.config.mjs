import { defineConfig } from 'astro/config';

// BlackIT Flow — static, client-state prototype.
// No adapter: the whole app is a single prerendered page plus one hydrated island.
export default defineConfig({
  site: 'https://flow.theblackit.com',
  output: 'static',
  server: {
    host: true,
    port: 4321,
  },
  devToolbar: {
    enabled: false,
  },
});
