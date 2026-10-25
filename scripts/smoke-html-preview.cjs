// Used by: npm run smoke -- <app root or app.asar> --html-preview
// Exercises the production iframe/protocol/IPC in an isolated fixture.
const { mkdirSync, writeFileSync, readFileSync, symlinkSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');

const path = '.iris/report/preview.html';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=', 'base64');

function page(remote = '') {
  return `<!doctype html><html><head><title>HTML smoke</title>
<meta name="iris:status" content="Active"></head><body>
<h1>Preview fixture</h1><img id="local" src="./preview.assets/pixel.png">
${remote ? `<img id="remote" src="${remote}">` : ''}
<script>
document.body.dataset.script = 'ran';
document.body.dataset.bridge = typeof window.api;
try { void parent.document.body; document.body.dataset.parent = 'accessible'; }
catch { document.body.dataset.parent = 'blocked'; }
</script></body></html>`;
}

exports.prepare = (profile) => {
  const root = join(profile, 'project');
  const assets = join(root, '.iris/report/preview.assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'pixel.png'), png);
  writeFileSync(join(root, path), page());
  const outside = join(profile, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside project');
  symlinkSync(outside, join(dirname(assets), 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  return { kind: 'html', path, root };
};

async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (error) { last = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

exports.verify = async (contents, expected) => {
  await waitFor(() => contents.executeJavaScript(`(() => {
    const button = document.querySelector('button[aria-label="${path}"]');
    if (!document.querySelector('iframe') && button) button.click();
    return Boolean(document.querySelector('iframe'));
  })()`), Boolean, 'HTML preview did not mount');

  const frame = () => contents.mainFrame.framesInSubtree.find((item) => item.url.startsWith('iris-doc:'));
  const inspect = () => frame()?.executeJavaScript(`({
    script: document.body?.dataset.script,
    bridge: document.body?.dataset.bridge,
    parent: document.body?.dataset.parent,
    local: document.querySelector('#local')?.naturalWidth,
    remote: document.querySelector('#remote')?.naturalWidth ?? 0,
    title: document.title
  })`);
  const initial = await waitFor(inspect,
    (value) => value?.script === 'ran' && value.local === 1, 'Inline script or local image failed');
  assert.equal(initial.bridge, 'undefined');
  assert.equal(initial.parent, 'blocked');
  const sourceUrl = frame().url;
  const update = (behavior) => contents.executeJavaScript(
    `window.api.invoke('settings:update', ${JSON.stringify({ behavior })})`,
  );

  await update({ htmlPreviewScripts: false });
  // Chromium also refuses WebFrameMain.executeJavaScript in a sandbox whose
  // allow-scripts flag is absent. Assert that rejection, then re-enable scripts
  // so the remaining probes can inspect their DOM through the main process.
  await waitFor(async () => {
    const current = frame();
    if (!current) return false;
    try { await current.executeJavaScript('document.body.dataset.script'); }
    catch (error) { return String(error).includes('Script not run'); }
    return false;
  }, Boolean, 'Script-free sandbox still permitted JavaScript execution');
  await update({ htmlPreviewScripts: true });
  await waitFor(inspect, (value) => value?.script === 'ran' && value.local === 1, 'Scripts did not resume');

  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(png);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const remote = `http://127.0.0.1:${server.address().port}/pixel.png`;
    writeFileSync(join(expected.root, path), page(remote));
    await waitFor(() => frame()?.executeJavaScript('Boolean(document.querySelector("#remote"))'),
      Boolean, 'External file change did not refresh the preview');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(requests, 0, 'Offline preview requested a remote resource');
    await update({ htmlPreviewNetwork: true });
    await waitFor(inspect, (value) => value?.remote === 1, 'Enabled network did not load an image');
    await update({ htmlPreviewNetwork: false, htmlPreviewScripts: true });
    await waitFor(inspect, (value) => value?.script === 'ran' && value.remote === 0,
      'Policy change did not recreate the frame');

    // Header changes operate on the entire page without changing its body.
    const before = readFileSync(join(expected.root, path), 'utf8');
    await contents.executeJavaScript(`(async () => {
      const input = [...document.querySelectorAll('input')].find((item) => item.value === 'HTML smoke');
      if (!input) throw new Error('Title input missing');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Updated HTML');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A hidden BrowserWindow has no OS focus, so native blur need not emit
      // focusout. Deliver the delegated event explicitly after React updates.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    })()`);
    await waitFor(() => readFileSync(join(expected.root, path), 'utf8'),
      (value) => value === before.replace('<title>HTML smoke</title>', '<title>Updated HTML</title>'),
      'Header title was not persisted surgically');
    await waitFor(inspect, (value) => value?.title === 'Updated HTML', 'Saved title did not refresh');

    // Validate request boundaries through the real Electron protocol handler.
    const { net } = require('electron');
    assert.equal((await net.fetch(sourceUrl.replace('/.iris/', '/%2e%2e/'))).status, 404);
    assert.equal((await net.fetch(sourceUrl.replace('preview.html', 'missing.html'))).status, 404);
    assert.equal((await net.fetch(sourceUrl.replace('preview.html', 'outside/secret.txt'))).status, 404);
    assert.equal((await net.fetch(sourceUrl)).status, 200);
    const otherRoot = join(expected.root, '..', 'other-project');
    mkdirSync(otherRoot);
    await contents.executeJavaScript(`(async () => {
      const { activeScope } = await window.api.invoke('window:bootstrap');
      await window.api.invoke('project:open', {
        root: ${JSON.stringify(otherRoot)}, expectedScope: activeScope,
      });
    })()`);
    assert.equal((await net.fetch(sourceUrl)).status, 404, 'Old project token stayed valid');
    return { scripts: 'on/off', network: 'on/off', localImage: true, opaqueOrigin: true,
      externalRefresh: true, headerSave: true, pathBoundary: true, scopeRevocation: true };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
