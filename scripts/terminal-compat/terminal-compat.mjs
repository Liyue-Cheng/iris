#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import process from 'node:process';

const ESC = '\x1b';
const CSI = `${ESC}[`;
const BEL = '\x07';
const RESET = `${CSI}0m`;

function parseArgs(tokens) {
  const parsed = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function numberOption(options, name, fallback, { min = 0, integer = false } = {}) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function line(value = '') {
  process.stdout.write(`${value}\r\n`);
}

function title(value) {
  process.stdout.write(`${ESC}]0;${value}${BEL}`);
}

function environmentSummary() {
  return [
    `platform=${process.platform} ${process.arch}`,
    `node=${process.version}`,
    `tty(stdin/stdout)=${Boolean(process.stdin.isTTY)}/${Boolean(process.stdout.isTTY)}`,
    `size=${process.stdout.columns ?? '?'}x${process.stdout.rows ?? '?'}`,
    `TERM=${process.env.TERM ?? '(unset)'}`,
    `COLORTERM=${process.env.COLORTERM ?? '(unset)'}`,
    `WT_SESSION=${process.env.WT_SESSION ? '(set)' : '(unset)'}`,
  ].join(' | ');
}

async function runVisual() {
  title('IRIS-COMPAT visual');
  line('IRIS TERMINAL COMPATIBILITY - VISUAL PROBE');
  line(environmentSummary());
  line();
  line('1) Unicode and cell-width alignment');
  line('   Every closing | below should occupy the same column:');
  line('   ASCII     |1234567890|');
  line('   CJK       |中文终端测|');
  line('   combining |e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301|');
  line('   box       |+--------+|');
  line('   emoji     |😀🚀🌈💾⌛|');
  line('   multilingual: 简体中文 | 繁體中文 | 日本語 | 한국어 | العربية | עברית');
  line();

  line('2) SGR styles');
  line(
    `   normal | ${CSI}1mbold${RESET} | ${CSI}2mfaint${RESET} | ${CSI}3mitalic${RESET} | ` +
      `${CSI}4munderline${RESET} | ${CSI}7minverse${RESET} | ${CSI}9mstrike${RESET}`,
  );
  line('   ANSI 16 foreground colors:');
  process.stdout.write('   ');
  for (const code of [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97]) {
    process.stdout.write(`${CSI}${code}m ${String(code).padStart(2, '0')} ${RESET}`);
  }
  line();
  line('   ANSI 256 background palette (0-255):');
  for (let row = 0; row < 16; row += 1) {
    process.stdout.write('   ');
    for (let column = 0; column < 16; column += 1) {
      const color = row * 16 + column;
      process.stdout.write(`${CSI}48;5;${color}m${CSI}38;5;${color < 16 ? 15 : 0}m${color
        .toString(16)
        .padStart(2, '0')}${RESET} `);
    }
    line();
  }
  line('   Truecolor swatches:');
  line(
    `   ${CSI}48;2;220;38;38m red ${RESET} ${CSI}48;2;22;163;74m green ${RESET} ` +
      `${CSI}48;2;37;99;235m blue ${RESET} ${CSI}48;2;8;145;178m cyan ${RESET} ` +
      `${CSI}48;2;192;38;211m magenta ${RESET} ${CSI}48;2;234;179;8m yellow ${RESET}`,
  );
  line();

  line('3) Cursor, erase and wrapping');
  process.stdout.write('   carriage-return + erase: FAIL');
  await sleep(250);
  process.stdout.write(`\r${CSI}2K   carriage-return + erase: PASS\r\n`);
  const columns = Math.max(20, process.stdout.columns ?? 80);
  const wrapPayload = '0123456789'.repeat(Math.ceil((columns + 8) / 10)).slice(0, columns + 8);
  line(`   wrap>${wrapPayload}<END`);
  line('   Expected: <END appears on the next physical row without overwriting adjacent text.');
  line();

  line('4) OSC title and hyperlink');
  line('   The Iris terminal title should contain "IRIS-COMPAT visual".');
  line(`   ${ESC}]8;;https://example.com/iris-terminal-compat${BEL}OSC 8 hyperlink${ESC}]8;;${BEL}`);
  line('   A plain URL should also be clickable: https://example.com/iris-terminal-compat');
  line();
  line('VISUAL PROBE COMPLETE - keep this session for search/copy/replay checks.');
}

async function runProtocol(options) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('protocol mode requires an interactive TTY');
  }

  const timeoutMs = numberOption(options, 'timeout-ms', 3000, { min: 100, integer: true });
  const previousRaw = Boolean(process.stdin.isRaw);
  let received = '';
  const responses = new Map();
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });

  const inspect = () => {
    const pattern = /\x1b\](10|11);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    for (const match of received.matchAll(pattern)) responses.set(match[1], match[2]);
    if (responses.has('10') && responses.has('11')) finish();
  };
  const onData = (chunk) => {
    received = `${received}${chunk.toString('utf8')}`.slice(-8192);
    inspect();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  title('IRIS-COMPAT protocol');
  line('IRIS TERMINAL COMPATIBILITY - OSC 10/11 QUERY');
  line('Sending each query in delayed fragments to exercise cross-chunk parsing...');

  for (const fragment of [ESC, ']10;', '?', BEL]) {
    process.stdout.write(fragment);
    await sleep(30);
  }
  await sleep(100);
  for (const fragment of [`${ESC}]11;`, '?', ESC, '\\']) {
    process.stdout.write(fragment);
    await sleep(30);
  }

  await Promise.race([completed, sleep(timeoutMs)]);
  process.stdin.off('data', onData);
  process.stdin.setRawMode(previousRaw);
  process.stdin.pause();

  for (const id of ['10', '11']) {
    const value = responses.get(id);
    const valid = /^rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}$/i.test(value ?? '');
    line(`OSC ${id}: ${valid ? 'PASS' : 'FAIL'}${value ? ` (${value})` : ' (no reply)'}`);
  }
  if (!responses.has('10') || !responses.has('11')) process.exitCode = 1;
}

async function runStream(options) {
  const seconds = numberOption(options, 'seconds', 30, { min: 0.1 });
  const rate = numberOption(options, 'rate', 50, { min: 0 });
  const payloadBytes = numberOption(options, 'payload-bytes', 256, { min: 0, integer: true });
  const stderrEvery = numberOption(options, 'stderr-every', 0, { min: 0, integer: true });
  const explicitLines = options.lines === undefined
    ? null
    : numberOption(options, 'lines', 1, { min: 1, integer: true });
  if (rate === 0 && explicitLines === null) throw new Error('--rate 0 requires --lines');
  const totalLines = explicitLines ?? Math.max(1, Math.round(seconds * rate));
  const payload = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.repeat(
    Math.ceil(payloadBytes / 62),
  ).slice(0, payloadBytes);
  const digest = createHash('sha256');
  let bytes = 0;
  const started = performance.now();
  let nextWrite = started;

  title('IRIS-COMPAT stream');
  line(`IRIS_STREAM_BEGIN lines=${totalLines} rate=${rate || 'unlimited'} payload=${payloadBytes}`);
  for (let sequence = 1; sequence <= totalLines; sequence += 1) {
    const id = String(sequence).padStart(8, '0');
    const output = `SEQ ${id} | ${payload} | END ${id}\r\n`;
    const buffer = Buffer.from(output);
    digest.update(buffer);
    bytes += buffer.byteLength;
    if (!process.stdout.write(buffer)) await once(process.stdout, 'drain');
    if (stderrEvery > 0 && sequence % stderrEvery === 0) {
      process.stderr.write(`IRIS_STDERR_SENTINEL sequence=${id}\r\n`);
    }
    if (rate > 0) {
      nextWrite += 1000 / rate;
      const wait = nextWrite - performance.now();
      if (wait > 1) await sleep(wait);
    }
  }
  const elapsed = (performance.now() - started) / 1000;
  line(
    `IRIS_STREAM_END lines=${totalLines} bytes=${bytes} seconds=${elapsed.toFixed(2)} ` +
      `producer_sha256=${digest.digest('hex')}`,
  );
  line(`FINAL_SENTINEL sequence=${String(totalLines).padStart(8, '0')}`);
}

function fitAscii(value, width) {
  if (value.length > width) return value.slice(0, Math.max(0, width - 1)) + '>';
  return value.padEnd(width, ' ');
}

async function runTui() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('tui mode requires an interactive TTY');
  }
  const previousRaw = Boolean(process.stdin.isRaw);
  const state = {
    frames: 0,
    keys: 0,
    logs: 0,
    pastes: 0,
    lastInput: '(none)',
    accent: 36,
  };
  let inputWindow = '';
  let completed = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const render = () => {
    state.frames += 1;
    const columns = Math.max(40, Math.min(process.stdout.columns ?? 80, 120));
    const rows = process.stdout.rows ?? 24;
    const inner = columns - 4;
    const spinner = ['|', '/', '-', '\\'][state.frames % 4];
    const horizontal = '-'.repeat(columns - 2);
    const rowsToPrint = [
      `+${horizontal}+`,
      `| ${fitAscii('IRIS ALTERNATE-SCREEN TUI', inner)} |`,
      `+${horizontal}+`,
      `| ${fitAscii(`viewport=${columns}x${rows} frame=${state.frames} spinner=${spinner}`, inner)} |`,
      `| ${fitAscii(`keys=${state.keys} logs=${state.logs} bracketed-pastes=${state.pastes}`, inner)} |`,
      `| ${fitAscii(`last-input=${state.lastInput}`, inner)} |`,
      `| ${fitAscii('Keys: q/Ctrl+C quit | c color | l log | r redraw | arrows/IME/paste', inner)} |`,
      `| ${fitAscii('Resize the Iris terminal repeatedly; this border must remain intact.', inner)} |`,
      `+${horizontal}+`,
    ];
    process.stdout.write(`${CSI}H${CSI}2J${CSI}${state.accent}m${rowsToPrint.join('\r\n')}${RESET}`);
  };

  const finish = () => {
    if (completed) return;
    completed = true;
    resolveDone();
  };
  const onData = (chunk) => {
    state.keys += 1;
    state.lastInput = [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const text = chunk.toString('utf8');
    inputWindow = `${inputWindow}${text}`.slice(-8192);
    if (inputWindow.includes(`${ESC}[200~`) && inputWindow.includes(`${ESC}[201~`)) {
      state.pastes += 1;
      inputWindow = '';
    }
    if (chunk.includes(0x03) || text === 'q' || text === 'Q') finish();
    if (text === 'c' || text === 'C') state.accent = state.accent === 36 ? 35 : 36;
    if (text === 'l' || text === 'L') state.logs += 1;
    render();
  };
  const onResize = () => render();
  const onSignal = () => finish();
  const restore = () => {
    process.stdout.write(`${RESET}${CSI}?2004l${CSI}?25h${CSI}?1049l`);
    process.stdin.off('data', onData);
    process.stdout.off('resize', onResize);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.stdin.setRawMode(previousRaw);
    process.stdin.pause();
  };

  title('IRIS-COMPAT alternate-screen TUI');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', onResize);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}?2004h`);
  const timer = setInterval(render, 100);
  render();
  await done;
  clearInterval(timer);
  restore();
  line();
  line(`IRIS_TUI_END frames=${state.frames} keys=${state.keys} pastes=${state.pastes}`);
}

async function runInput(options) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('input mode requires an interactive TTY');
  }
  const bracketed = options.bracketed ?? 'off';
  if (bracketed !== 'on' && bracketed !== 'off') throw new Error('--bracketed must be on or off');
  const seconds = numberOption(options, 'seconds', 120, { min: 1 });
  const previousRaw = Boolean(process.stdin.isRaw);
  let chunks = 0;
  let bytes = 0;
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveDone();
  };
  const onData = (chunk) => {
    if (chunk.includes(0x03)) {
      finish();
      return;
    }
    chunks += 1;
    bytes += chunk.byteLength;
    const escaped = JSON.stringify(chunk.toString('utf8'));
    line(`IRIS_INPUT chunk=${chunks} bytes=${chunk.byteLength} data=${escaped.slice(0, 240)}`);
  };
  const onSignal = () => finish();

  title(`IRIS-COMPAT input bracketed=${bracketed}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.stdout.write(`${CSI}?2004${bracketed === 'on' ? 'h' : 'l'}`);
  line(`IRIS_INPUT_READY bracketed=${bracketed} timeout=${seconds}s`);
  line('Type, use IME, or paste fixtures. Press Ctrl+C to finish.');
  const timer = setTimeout(finish, seconds * 1000);
  await done;
  clearTimeout(timer);
  process.stdout.write(`${CSI}?2004l`);
  process.stdin.off('data', onData);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.stdin.setRawMode(previousRaw);
  process.stdin.pause();
  line(`IRIS_INPUT_END chunks=${chunks} bytes=${bytes}`);
}

async function runInline(options) {
  const seconds = numberOption(options, 'seconds', 60, { min: 1 });
  const frameMs = numberOption(options, 'frame-ms', 100, { min: 20, integer: true });
  const panelRows = 4;
  let frame = 0;
  let logs = 0;
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveDone();
  };
  const renderPanel = () => {
    const spinner = ['|', '/', '-', '\\'][frame % 4];
    const columns = process.stdout.columns ?? 80;
    const content = [
      `IRIS_INLINE_TUI frame=${frame} spinner=${spinner}`,
      `viewport=${columns}x${process.stdout.rows ?? '?'} durable-logs=${logs}`,
      `progress=${'='.repeat((frame % 30) + 1)}`,
      'Scroll up now. The visible history should freeze; End/input should resync.',
    ];
    for (const row of content) process.stdout.write(`\r${CSI}2K${row}\r\n`);
  };
  const onSignal = () => finish();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  title('IRIS-COMPAT inline TUI');
  line('IRIS_INLINE_BEGIN');
  process.stdout.write(`${CSI}?25l`);
  renderPanel();
  const timer = setInterval(() => {
    frame += 1;
    process.stdout.write(`${CSI}${panelRows}A`);
    if (frame % Math.max(1, Math.round(1000 / frameMs)) === 0) {
      logs += 1;
      process.stdout.write(`\r${CSI}2KIRIS_INLINE_LOG ${String(logs).padStart(4, '0')}\r\n`);
    }
    renderPanel();
    if (frame * frameMs >= seconds * 1000) finish();
  }, frameMs);
  await done;
  clearInterval(timer);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.stdout.write(`${RESET}${CSI}?25h`);
  line(`IRIS_INLINE_END frames=${frame} logs=${logs}`);
}

async function runExit(options) {
  const code = numberOption(options, 'code', 23, { min: 0, integer: true });
  const delayMs = numberOption(options, 'delay-ms', 500, { min: 0, integer: true });
  title(`IRIS-COMPAT exit ${code}`);
  line(`IRIS_EXIT_STDOUT code=${code}`);
  process.stderr.write(`IRIS_EXIT_STDERR code=${code}\r\n`);
  await sleep(delayMs);
  line(`IRIS_EXIT_FINAL_SENTINEL code=${code}`);
  process.exitCode = code;
}

function printHelp() {
  line('Iris terminal compatibility probe (Node.js 20+, no dependencies)');
  line();
  line('Usage: node scripts/terminal-compat/terminal-compat.mjs <mode> [options]');
  line();
  line('Modes:');
  line('  visual                         Unicode, colors, styles, wrapping, title, links');
  line('  protocol [--timeout-ms 3000]  Split-chunk OSC 10/11 query and reply check');
  line('  stream [options]               Sequenced sustained output and backpressure probe');
  line('    --seconds 30 --rate 50 --payload-bytes 256 --stderr-every 0');
  line('    --rate 0 --lines 50000       Unthrottled fixed-line run');
  line('  inline [--seconds 60]          Normal-buffer inline TUI and history-freeze probe');
  line('  tui                            Alternate-screen, resize, key, IME and paste probe');
  line('  input [--bracketed on|off]     Raw input, paste confirmation and IME receiver');
  line('  exit [--code 23]               Final output, stderr, title and exited-session probe');
}

const options = parseArgs(process.argv.slice(2));
const mode = options._[0] ?? 'help';

try {
  switch (mode) {
    case 'visual':
      await runVisual();
      break;
    case 'protocol':
      await runProtocol(options);
      break;
    case 'stream':
      await runStream(options);
      break;
    case 'tui':
      await runTui();
      break;
    case 'input':
      await runInput(options);
      break;
    case 'inline':
      await runInline(options);
      break;
    case 'exit':
      await runExit(options);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
} catch (error) {
  process.stderr.write(`IRIS_TERMINAL_COMPAT_ERROR: ${error instanceof Error ? error.message : String(error)}\r\n`);
  process.exitCode = 1;
}
