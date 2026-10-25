#!/usr/bin/env node
// Exercise the production entry, preload bridge and rendered UI in a hidden
// window with isolated settings. Optionally pass an unpacked app's app.asar.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(process.argv[2] ?? projectRoot);
if (!existsSync(appRoot.endsWith('.asar') ? appRoot : join(appRoot, 'out/main/index.js'))) {
  throw new Error('Production application missing — run npm run build first.');
}
const tempRoot = resolve(tmpdir());
const profile = mkdtempSync(join(tempRoot, 'iris-smoke-'));
// Optional third argument: verify a document using the real production editor.
// Copy it and its internal assets into an isolated project; never open the source
// workspace in the smoke instance or write to the user's document/settings.
let documentCheck = null;
const htmlCheck = process.argv[3] === '--html-preview';
const htmlProbePath = join(projectRoot, 'scripts/smoke-html-preview.cjs');
if (htmlCheck) {
  documentCheck = require(htmlProbePath).prepare(profile);
} else if (process.argv[3]) {
  const { remark } = await import('remark');
  const { default: gfm } = await import('remark-gfm');
  const { default: matter } = await import('gray-matter');
  const sourcePath = resolve(process.argv[3]);
  const fixtureRoot = join(profile, 'project');
  const fixturePath = join(fixtureRoot, '.iris', 'issue', basename(sourcePath));
  mkdirSync(dirname(fixturePath), { recursive: true });
  cpSync(sourcePath, fixturePath);
  const assets = sourcePath.replace(/\.md$/i, '.assets');
  if (existsSync(assets)) cpSync(assets, fixturePath.replace(/\.md$/i, '.assets'), { recursive: true });
  const expected = { spans: [], links: [], lists: 0, images: 0 };
  const walk = (node) => {
    if (node.type === 'text' || node.type === 'inlineCode') expected.spans.push(node.value);
    if (node.type === 'listItem') expected.lists += 1;
    if (node.type === 'image') expected.images += 1;
    if (node.type === 'link') expected.links.push(node.url);
    node.children?.forEach(walk);
  };
  walk(remark().use(gfm).parse(matter(readFileSync(sourcePath, 'utf8')).content));
  documentCheck = { ...expected, path: `.iris/issue/${basename(sourcePath)}` };
}
if (documentCheck) {
  const fixtureRoot = join(profile, 'project');
  // A development Electron executable uses .iris-dev even for app.asar.
  for (const namespace of ['.iris', '.iris-dev']) {
    mkdirSync(join(profile, namespace), { recursive: true });
    writeFileSync(join(profile, namespace, 'settings.json'), JSON.stringify({
      version: 1,
      behavior: { restoreProjectsOnStartup: true },
      project: { openRoots: [fixtureRoot] },
    }));
  }
}
const verifyDocument = async (expected) => {
  const deadline = Date.now() + 20000;
  let lastFailure = 'document navigation is not ready';
  let opened = false;
  while (Date.now() < deadline) {
    const button = document.querySelector(`button[aria-label="${CSS.escape(expected.path)}"]`);
    if (!opened && button) { button.click(); opened = true; }
    const editor = document.querySelector('.crepe-host .ProseMirror');
    if (editor) {
      const text = editor.innerText;
      const missing = expected.spans.filter((span) => !text.includes(span));
      const lists = editor.querySelectorAll('.milkdown-list-item-block').length;
      const links = [...editor.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
      const images = [...editor.querySelectorAll('img')];
      const hidden = [...editor.querySelectorAll('.milkdown-list-item-block')].some((item) =>
        !item.getClientRects().length || getComputedStyle(item).visibility === 'hidden');
      if (!missing.length && lists === expected.lists && !hidden &&
          expected.links.every((url) => links.includes(url)) &&
          images.length >= expected.images && images.every((img) => img.complete && img.naturalWidth > 0)) {
        return { textSpans: expected.spans.length, lists, links: expected.links.length, images: images.length };
      }
      lastFailure = JSON.stringify({ missing: missing.slice(0, 3), lists, expectedLists: expected.lists,
        hidden, loadedImages: images.filter((img) => img.naturalWidth > 0).length });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Document rendering verification failed: ' + lastFailure);
};
const launcher = join(profile, 'launch.cjs');
writeFileSync(launcher, `
const { app, BrowserWindow } = require('electron');
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdirSync, readFileSync } = require('node:fs');
const profile = process.env.IRIS_SMOKE_PROFILE;
const appRoot = process.env.IRIS_SMOKE_APP_ROOT;
// App settings and context hooks use os.homedir(), independently of userData.
os.homedir = () => profile;
syncBuiltinESMExports();
for (const name of ['home', 'appData', 'userData', 'sessionData']) {
  const path = join(profile, name);
  mkdirSync(path, { recursive: true });
  app.setPath(name, path);
}
// The temporary launcher is not the application's package entry.
app.getAppPath = () => appRoot;
app.getVersion = () => JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version;
let finished = false;
function finish(code, message) {
  if (finished) return;
  finished = true;
  console.log('[smoke] ' + (code === 0 ? 'PASS' : 'FAIL') + ' — ' + message);
  app.exit(code);
}
process.on('uncaughtException', error => finish(1, error.stack));
process.on('unhandledRejection', error => finish(1, String(error)));
app.on('child-process-gone', (_event, details) => finish(1, JSON.stringify(details)));
// Hide only the test window; production window code is left unchanged.
BrowserWindow.prototype.show = function () {};
app.on('browser-window-created', (_event, win) => {
  const contents = win.webContents;
  contents.on('preload-error', (_event, _path, error) => finish(1, error.stack));
  contents.on('render-process-gone', (_event, details) => finish(1, JSON.stringify(details)));
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) finish(1, 'load failed ' + code + ': ' + description);
  });
  contents.on('console-message', details => {
    // The HTML probe deliberately triggers CSP and sandbox violations.
    if (${htmlCheck} && /Content Security Policy|sandboxed|Not allowed to load local resource/.test(details.message)) return;
    if (details.level === 'error') finish(1, details.message);
  });
  contents.once('did-finish-load', () => {
    console.log('[smoke] renderer loaded; observing for 5 seconds');
    setTimeout(async () => {
      try {
        const ready = await contents.executeJavaScript(
          'Boolean(window.api && document.getElementById("root")?.children.length)'
        );
        if (!ready) return finish(1, 'preload bridge or rendered UI missing');
        const documentCheck = ${JSON.stringify(documentCheck)};
        if (documentCheck) {
          const result = ${htmlCheck}
            ? await require(${JSON.stringify(htmlProbePath)}).verify(contents, documentCheck)
            : await contents.executeJavaScript(
            '(' + ${JSON.stringify(verifyDocument.toString())} + ')(' + JSON.stringify(documentCheck) + ')'
          );
          console.log('[smoke] document rendering verified ' + JSON.stringify(result));
        }
        finish(0, 'production renderer and preload ready; survived 5 seconds');
      } catch (error) { finish(1, String(error)); }
    }, 5000);
  });
});
setTimeout(() => finish(1, 'startup/rendering exceeded its deadline'), ${documentCheck ? 60000 : 30000});
import(pathToFileURL(join(appRoot, 'out/main/index.js')).href).catch(error => finish(1, error.stack));
`);

const env = { ...process.env, IRIS_SMOKE_PROFILE: profile, IRIS_SMOKE_APP_ROOT: appRoot };
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'IRIS_DEVTOOLS', 'PORTABLE_EXECUTABLE_DIR']) {
  delete env[key];
}
try {
  const child = spawn(require('electron'), [launcher, '--disable-gpu', '--no-sandbox'], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let passed = false;
  let timedOut = false;
  let output = '';
  const inspect = chunk => {
    const text = chunk.toString();
    process.stdout.write(text);
    output += text;
    passed = output.includes('[smoke] PASS');
  };
  child.stdout.on('data', inspect);
  child.stderr.on('data', inspect);
  const timeout = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
    } else child.kill('SIGKILL');
  }, documentCheck ? 70000 : 40000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    if (timedOut || code !== 0 || !passed) throw new Error('Production smoke test failed.');
  } finally { clearTimeout(timeout); }
} finally {
  const rel = relative(tempRoot, profile);
  if (!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('iris-smoke-')) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
