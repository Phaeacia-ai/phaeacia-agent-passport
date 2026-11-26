/* Screenshot a page, optionally after driving it, with no dependency beyond a
   Chrome on the machine and Node's own WebSocket.

   This exists because the parts of this site that are worth looking at only
   appear after something happens: the success screen after a publish, the
   status panel after a token, the owner-review stop after a refusal. A static
   screenshot of the markup proves nothing about any of them.

     node tools/shoot.mjs <url> <out.png> [--width=N] [--height=N] [--full]
                          [--eval="js"] [--eval-file=path] [--wait=selector]
                          [--pause=ms]

   --eval runs in the page and may await; --eval-file is the same thing read
   from disk, for scripts with quotes and newlines in them, which is most of
   them. --wait polls for a selector to be visible. All of them may be given
   more than once and run in the order written. */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223 + Math.floor(process.uptime() % 40);

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  console.error('usage: node tools/shoot.mjs <url> <out.png> [flags]');
  process.exit(1);
}

const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const width = Number(flag('width', 1280));
const height = Number(flag('height', 900));
const full = args.includes('--full');
const steps = args.filter(a => a.startsWith('--eval=') || a.startsWith('--eval-file=') ||
                              a.startsWith('--wait=') || a.startsWith('--pause='));

const profile = `/tmp/shoot-profile-${PORT}`;
await rm(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('chrome never opened its debugging port');
}

const ws = new WebSocket(await endpoint());
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });

let nextId = 1;
const pending = new Map();
const events = [];
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, no } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
};

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((ok, no) => {
    pending.set(id, { ok, no });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); no(new Error(method + ' timed out')); }
    }, 30000);
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const call = (m, p) => send(m, p, sessionId);

await call('Page.enable');
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 2, mobile: width < 500
});

const problems = [];
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    problems.push(msg.params.exceptionDetails.text + ' ' +
      (msg.params.exceptionDetails.exception?.description || ''));
  }
});

await call('Page.navigate', { url });
await sleep(1200);

async function evaluate(expression) {
  const r = await call('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' +
    (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

for (const step of steps) {
  if (step.startsWith('--eval-file=')) {
    const code = await readFile(step.slice(12), 'utf8');
    const v = await evaluate(`(async () => { ${code} })()`);
    if (v !== undefined && v !== null) console.log('  eval: ' + JSON.stringify(v));
    await sleep(400);
  } else if (step.startsWith('--eval=')) {
    const v = await evaluate(`(async () => { ${step.slice(7)} })()`);
    if (v !== undefined && v !== null) console.log('  eval: ' + JSON.stringify(v));
    await sleep(400);
  } else if (step.startsWith('--wait=')) {
    const sel = step.slice(7);
    let seen = false;
    for (let i = 0; i < 60; i++) {
      seen = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
        return !!(e && !e.hidden && e.offsetParent !== null); })()`);
      if (seen) break;
      await sleep(200);
    }
    if (!seen) throw new Error(`waited for ${sel} and it never appeared`);
    await sleep(300);
  } else {
    await sleep(Number(step.slice(8)));
  }
}

if (full) {
  const m = await call('Page.getLayoutMetrics');
  const h = Math.min(Math.ceil(m.cssContentSize.height), 16000);
  await call('Emulation.setDeviceMetricsOverride', {
    width, height: h, deviceScaleFactor: 2, mobile: width < 500
  });
  await sleep(500);
}

const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(shot.data, 'base64'));

if (problems.length) {
  console.log('  page errors: ' + problems.join(' | '));
}
console.log(`  wrote ${out}`);

ws.close();
chrome.kill();
/* Chrome is still writing into its profile as it dies, so removing the
   directory races it. The screenshot is already on disk by here; a leftover
   temp profile is not worth a non-zero exit. */
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
