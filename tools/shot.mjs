/**
 * Dev-only visual check: drive headless Chrome over CDP so the viewport can be
 * emulated at a real phone width (Chrome's --window-size has a ~500px floor).
 *
 *   node tools/shot.mjs <url> <out.png> <width> <height> [waitMs]
 *
 * It also reports any element wider than the viewport, which is how horizontal
 * overflow gets caught instead of eyeballed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , url, out, widthArg = '390', heightArg = '900', waitArg = '1500'] = process.argv;
const width = Number(widthArg);
const height = Number(heightArg);
const waitMs = Number(waitArg);
const port = 9333 + (process.pid % 500);

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/dsh-shot-${process.pid}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: true },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}

const ws = new WebSocket(await targetUrl());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  await send('Page.enable');
  await send('Runtime.enable');
  // A cached stylesheet or module graph hides CSS changes; always reload fresh.
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  await send('Page.navigate', { url });
  await sleep(waitMs);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const vw = document.documentElement.clientWidth;
      const overflows = document.documentElement.scrollWidth > vw + 0.5;
      const wide = [];
      if (overflows) {
        // Only meaningful when the document itself scrolls sideways. Fixed
        // elements parked off-screen (a closed drawer) are not a defect.
        document.querySelectorAll('body *').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (getComputedStyle(el).visibility === 'hidden') return;
          if (r.width > vw + 0.5 || r.right > vw + 0.5) {
            wide.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] +
              ' w=' + Math.round(r.width) + ' right=' + Math.round(r.right));
          }
        });
      }
      return JSON.stringify({
        vw,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        horizontalOverflow: overflows,
        overflow: wide.slice(0, 8),
        rows: document.querySelectorAll('.row[data-task]').length,
      });
    })()`,
  });
  console.log('PROBE', probe.result.value);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('WROTE', out, `${width}x${height}`);
} finally {
  ws.close();
  try {
    process.kill(-chrome.pid);
  } catch {
    chrome.kill('SIGKILL');
  }
}
