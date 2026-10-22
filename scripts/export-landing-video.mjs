// Capture the real landing-page walkthrough, not a second implementation of its animation.
// Start the static landing server and an agent-browser session first; see the landing README.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';

const [cdpUrl, output = 'richtfest-os/apps/web/public/optimization-preview-v1.mp4'] = process.argv.slice(2);
if (!cdpUrl) throw new Error('Usage: node scripts/export-landing-video.mjs <browser CDP URL> [output.mp4]');
const endpoint = new URL(cdpUrl);
const targets = await fetch(`http://${endpoint.host}/json/list`).then(r => r.json());
const target = targets.find(t => t.type === 'page' && /^https?:/.test(t.url));
if (!target) throw new Error('Open the local landing page in the capture browser first.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await once(ws, 'open');
let id = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

// Advance animation time by hand so software WebGL renders every output frame.
// This affects only this export session; the source page remains unchanged.
const clock = `(() => {
  let now = 0, id = 0;
  const timers = new Map(), frames = new Map();
  performance.now = () => now;
  window.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.setTimeout = (fn, ms = 0, ...args) => { timers.set(++id, { at: now + Number(ms), fn: () => fn(...args) }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.__advance = async ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
      await Promise.resolve();
    }
    now = end;
    const callbacks = [...frames.values()]; frames.clear();
    for (const fn of callbacks) fn(now);
    await Promise.resolve();
  };
  // Render the model at delivery resolution; keep the surrounding typography at 2×.
  document.addEventListener('load', event => {
    if (!event.target.src?.endsWith('/three.min.js')) return;
    const Renderer = THREE.WebGLRenderer;
    THREE.WebGLRenderer = class extends Renderer {
      constructor(...args) { super(...args); const setRatio = this.setPixelRatio.bind(this); this.setPixelRatio = () => setRatio(1); }
    };
  }, true);
  localStorage.setItem('rf-lang', 'en');
})();`;

const layout = `(() => {
  const style = document.createElement('style');
  style.textContent = \`
    html { scroll-behavior: auto !important; }
    body { background: #0a0b0b; overflow: hidden; }
    body > :not(main):not(.nav):not(style):not(script):not(svg):not(.export-copy) { display: none !important; }
    main > :not(#try), #try .split-head, .nav-links, .nav-cta { display: none !important; }
    .nav { position: absolute; top: 0; background: none !important; backdrop-filter: none !important; }
    .nav .wrap { padding: 0 36px; height: 84px; max-width: none; }
    .logo { font-size: 26px; }
    #try { padding: 0; background: none; }
    #try .wrap { padding: 0; max-width: none; }
    .demo { display: block; margin: 0; }
    .viewer { position: absolute; left: 390px; top: 92px; width: 774px; height: 480px; border-radius: 28px; box-shadow: none; }
    .v-hint, .v-cta, .v-mob, .d-panel > :not(.d-cost) { display: none !important; }
    .d-panel { position: absolute; left: 36px; top: 428px; width: 330px; height: auto; padding: 0; background: none; border: 0; box-shadow: none; }
    .d-cost { padding: 0; background: none; border-radius: 0; gap: 10px; }
    .d-cost .k { font-size: 11px; }
    .d-cost .big { font-size: 44px; }
    .d-cost .delta { width: 100%; font-size: 17px; }
    .v-hud { font-size: 10px; left: 12px; right: 12px; }
    .pin span { display: none; }
    .export-copy { color: #fff; }
    .export-copy h1 { position: absolute; left: 36px; top: 100px; width: 330px; font-size: 41px; line-height: 1.08; }
    .export-copy h1 em { color: #f3cf4a; font-style: normal; }
    .export-steps { position: absolute; left: 36px; top: 268px; width: 330px; display: grid; gap: 18px; }
    .export-step { display: flex; align-items: center; gap: 12px; color: #9ea3a0; font-size: 17px; }
    .export-step b { display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid #565956; border-radius: 50%; font: 12px var(--mono); }
    .export-step.active { color: #fff; }
    .export-step.active b { background: #f3cf4a; border-color: #f3cf4a; color: #0a0b0b; }
    .export-footer { position: absolute; bottom: 22px; left: 36px; right: 36px; display: flex; justify-content: space-between; font: 11px var(--mono); color: #9ea3a0; }
  \`;
  document.head.append(style);
  const copy = document.createElement('div'); copy.className = 'export-copy';
  copy.innerHTML = '<h1>Press optimize.<br>Watch the<br><em>savings appear.</em></h1><div class="export-steps"><div class="export-step"><b>1</b>Smarter fire-brigade access</div><div class="export-step"><b>2</b>One less staircase</div><div class="export-step"><b>3</b>Four shafts become two</div></div><div class="export-footer"><span>Illustrative example · Planner approval required</span><span>richtfest.ai</span></div>';
  document.body.append(copy);
  window.scrollTo(0, 0);
  window.__updateExport = () => document.querySelectorAll('.export-step').forEach((el, i) => el.classList.toggle('active', document.getElementById('pin' + (i + 1)).classList.contains('on')));
})();`;

let encoder;
let clockId;
try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 2, mobile: false });
  clockId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: clock })).identifier;
  await send('Page.navigate', { url: target.url });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(`!!document.querySelector('#viewer canvas') && !!window.__advance`)) break;
    if (attempt === 119) throw new Error('Landing WebGL scene did not initialize.');
    await new Promise(r => setTimeout(r, 500));
  }
  await evaluate('document.fonts.ready.then(() => true)');
  await evaluate(layout);
  await evaluate('__advance(0)');
  await new Promise(r => setTimeout(r, 500)); // Allow ResizeObserver to resize the WebGL canvas.
  const destination = resolve(output);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  encoder = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '24', '-i', '-', '-vf', 'scale=1200:630:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', destination], { stdio: ['pipe', 'inherit', 'inherit'] });
  const encoded = once(encoder, 'close');
  let doneFrames = 0;
  let completed = false;
  for (let frame = 0; frame < 1200; frame++) {
    if (frame === 24) await evaluate(`document.getElementById('dGo').click()`);
    await evaluate('__advance(2000 / 24).then(() => __updateExport())');
    const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94 });
    if (!encoder.stdin.write(Buffer.from(data, 'base64'))) await once(encoder.stdin, 'drain');
    const done = await evaluate(`document.getElementById('viewer').classList.contains('done')`);
    if (done && ++doneFrames === 72) { completed = true; break; }
    if (frame % 120 === 0) console.log(`Captured ${(frame / 24).toFixed(0)} seconds`);
  }
  encoder.stdin.end();
  const [code] = await encoded;
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  if (!completed) throw new Error('Walkthrough did not reach its completed state.');
  const final = await evaluate(`({cost: document.getElementById('dCost').textContent, savings: document.getElementById('dDelta').textContent, findings: document.querySelectorAll('#dLog .found').length})`);
  if (final.cost !== '€1,838,000' || final.findings !== 3) throw new Error(`Unexpected demo result: ${JSON.stringify(final)}`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-1', '-i', destination, '-frames:v', '1', '-update', '1', destination.replace(/\.mp4$/, '-poster.jpg')]);
  console.log(JSON.stringify({ output: destination, ...final }));
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill();
  if (clockId) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clockId });
    await send('Page.navigate', { url: target.url });
  }
  ws.close();
}
