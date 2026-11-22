import { app, BrowserWindow, ipcMain } from 'electron';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerContext, requireContext, type WindowContext } from '../../src/main/window-context';
import { wireRendererLifecycle, beginWindowShutdown } from '../../src/main/window-lifecycle';

const directory = __dirname;
mkdirSync(join(directory, 'profile'), { recursive: true });
app.setPath('userData', join(directory, 'profile'));
app.disableHardwareAcceleration();
const results: unknown[] = [];
let finished = false;
const deadline = setTimeout(() => finish(1, 'diagnostic timed out'), 25_000);
function finish(code: number, error?: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const result = { electron: process.versions.electron, results, ...(error ? { error } : {}) };
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(code);
}
process.on('uncaughtException', error => finish(1, error.stack));
process.on('unhandledRejection', error => finish(1, String(error)));

async function run(): Promise<void> {
  await app.whenReady();
  const preload = join(directory, 'preload.cjs');
  writeFileSync(preload, `
    const { contextBridge, ipcRenderer } = require('electron');
    const documentId = Math.random().toString(36);
    const initial = ipcRenderer.invoke('lifetime:probe', { documentId, preload: true });
    contextBridge.exposeInMainWorld('probe', () => ipcRenderer.invoke('lifetime:probe', { documentId }));
    contextBridge.exposeInMainWorld('initialProbe', () => initial);
    contextBridge.exposeInMainWorld('deferProbe', () => ipcRenderer.invoke('lifetime:deferred'));
  `);
  const fixture = join(directory, 'fixture.html');
  writeFileSync(fixture, '<!doctype html><title>lifecycle fixture</title><p>Original document</p>');
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload, sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } });
  const scope = { root: directory, generation: 1 };
  let ordinaryAttached = false;
  let agentAttached = false;
  let detachCount = 0;
  const ctx = {
    win, rendererEpoch: 0, closing: false, outputAttachment: null,
    terminalSessionManager: { detachAllOutputs: () => { ordinaryAttached = false; detachCount++; } },
    agentSessionManager: { detachAllTerminalOutputs: () => { agentAttached = false; } },
  } as unknown as WindowContext;
  registerContext(ctx);
  let blockNavigation = true;
  win.webContents.on('will-navigate', event => { if (blockNavigation) event.preventDefault(); });
  // Production event registration, rather than a second copy of its behavior.
  wireRendererLifecycle(ctx);
  let events: string[] = [];
  for (const name of ['did-start-navigation', 'will-navigate', 'did-navigate', 'did-navigate-in-page', 'did-fail-load', 'did-fail-provisional-load'] as const) {
    win.webContents.on(name, () => { events.push(name); });
  }
  ipcMain.handle('lifetime:probe', (event, payload) => {
    try {
      requireContext(event);
      if (payload.preload) {
        // A fresh renderer attaches immediately. A later cleanup event would
        // incorrectly revoke these consumers, so assert they survive too.
        ordinaryAttached = true;
        agentAttached = true;
        ctx.outputAttachment = { sessionId: 'ordinary', attachmentId: payload.documentId, scope };
      }
      return { accepted: true, epoch: ctx.rendererEpoch, documentId: payload.documentId };
    } catch (error) {
      return { accepted: false, code: (error as { code: string }).code };
    }
  });
  let releaseDeferred!: () => void;
  let deferredStarted!: () => void;
  let deferredResult: unknown;
  ipcMain.handle('lifetime:deferred', async event => {
    requireContext(event);
    const wait = new Promise<void>(resolve => { releaseDeferred = resolve; });
    deferredStarted();
    await wait;
    try { requireContext(event); deferredResult = { accepted: true }; }
    catch (error) { deferredResult = { accepted: false, code: (error as { code: string }).code }; }
    return deferredResult;
  });
  async function startDeferred(): Promise<void> {
    const started = new Promise<void>(resolve => { deferredStarted = resolve; });
    // The document may be replaced before this promise resolves. Main records
    // its decision independently of delivery to the old renderer.
    void win.webContents.executeJavaScript('window.deferProbe()').catch(() => undefined);
    await started;
  }
  async function check(name: string, epoch: number, documentId?: string): Promise<string> {
    const value = await win.webContents.executeJavaScript('window.probe()');
    assert.equal(value.accepted, true, name);
    assert.equal(value.epoch, epoch, name);
    if (documentId) assert.equal(value.documentId, documentId, name);
    assert.equal(ordinaryAttached, true, `${name}: ordinary output`);
    assert.equal(agentAttached, true, `${name}: Agent output`);
    assert.equal(ctx.outputAttachment?.attachmentId, value.documentId, `${name}: attachment`);
    assert.equal(detachCount, epoch, `${name}: cleanup count`);
    results.push({ name, value, events });
    events = [];
    return value.documentId;
  }
  await win.loadFile(fixture);
  const initial = await win.webContents.executeJavaScript('window.initialProbe()');
  assert.equal(initial.epoch, 1, 'commit precedes preload IPC');
  const firstDocument = await check('initial load and immediate preload IPC', 1);
  await startDeferred();
  await win.webContents.executeJavaScript('const a = document.createElement("a"); a.href = "https://example.invalid/blocked"; document.body.append(a); a.click();');
  // Drain another IPC after Chromium has processed the attempted navigation.
  await check('blocked main-frame link preserves both outputs', 1, firstDocument);
  releaseDeferred();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deferredResult, { accepted: true });
  await win.webContents.executeJavaScript('location.hash = "heading"');
  await check('same-document anchor', 1, firstDocument);
  await win.webContents.executeJavaScript('const f = document.createElement("iframe"); f.srcdoc = "subframe"; document.body.append(f);');
  await check('subframe navigation', 1, firstDocument);

  const server = createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.bin"' });
      response.end('fixture');
    } else if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/document' }); response.end();
    } else if (request.url === '/document') {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>committed</title>');
    }
    // /pending waits indefinitely for a response and is stopped before commit.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  blockNavigation = false;
  const download = new Promise<void>(resolve => win.webContents.session.once('will-download', event => { event.preventDefault(); resolve(); }));
  const downloadLoad = win.loadURL(origin + '/download').catch(() => undefined);
  await download;
  await downloadLoad;
  await check('download cancellation before commit', 1, firstDocument);
  const pendingRequest = new Promise<void>(resolve => server.once('request', () => resolve()));
  // Chromium can stop this provisional load without settling loadURL's promise.
  void win.loadURL(origin + '/pending').catch(() => undefined);
  await pendingRequest;
  // executeJavaScript itself waits for a pending main-frame load, so inspect
  // ownership here and probe the surviving document after stop settles it.
  assert.equal(ctx.rendererEpoch, 1);
  assert.equal(ordinaryAttached, true);
  assert.equal(agentAttached, true);
  win.webContents.stop();
  await check('stopped provisional navigation', 1, firstDocument);

  await startDeferred();
  await win.loadFile(fixture);
  releaseDeferred();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deferredResult, { accepted: false, code: 'RendererDocumentInactive' });
  const secondDocument = await check('committed reload rejects old requests; new outputs remain attached', 2);
  assert.notEqual(secondDocument, firstDocument);
  const secondInitial = await win.webContents.executeJavaScript('window.initialProbe()');
  assert.equal(secondInitial.epoch, 2, 'reload commit precedes new preload IPC');
  await win.loadURL(origin + '/redirect');
  await check('redirect commits exactly once', 3);
  beginWindowShutdown(ctx);
  assert.equal(ordinaryAttached, false);
  assert.equal(agentAttached, false);
  assert.equal(ctx.outputAttachment, null);
  assert.deepEqual(await win.webContents.executeJavaScript('window.probe()'), { accepted: false, code: 'WindowClosing' });
  results.push({ name: 'shutdown rejects new requests and releases both outputs', accepted: false });
  win.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  finish(0);
}
void run();
