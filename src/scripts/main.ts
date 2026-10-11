/**
 * Client entry point. Astro bundles this and injects it into the page after
 * the static shell, so `DOMContentLoaded` has always already fired by the
 * time it executes — no load-event guard needed.
 */
import { BlackitFlowApp } from '../lib/app';

declare global {
  interface Window {
    blackitFlow?: BlackitFlowApp;
  }
}

const app = new BlackitFlowApp();
void app.start().catch((error: unknown) => {
  console.error('BlackIT Flow failed to start:', error);
});
window.blackitFlow = app;
