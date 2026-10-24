/**
 * The part of xterm's continuation state that SerializeAddon cannot express.
 *
 * Keep all private xterm access here. The headless and browser packages must be
 * upgraded together; the parser fingerprint and structural checks deliberately
 * fail closed when their internal contract changes. The ANSI screen is still
 * produced by SerializeAddon, and this state is applied only after its write
 * callback (and any replay framing), before resuming the original byte stream.
 */
const COMPATIBILITY = 'xterm-6.1.0-beta.256/1' as const;
const TRANSITION_FINGERPRINT = 3451417691;

type Charset = Record<string, string> | null;
type ModeValue = boolean | number | string | undefined;
interface AttributeState {
  fg: number;
  bg: number;
  extended: number;
  link?: { id?: string; uri: string };
}
interface BufferState {
  x: number;
  y: number;
  scrollTop: number;
  scrollBottom: number;
  tabs: Record<number, boolean>;
  savedX: number;
  // Relative to the source viewport, so omitted scrollback does not shift it.
  savedYOffset: number;
  savedAttrs: AttributeState;
  savedCharset: Charset;
  savedCharsets: Charset[];
  savedGlevel: number;
  savedOriginMode: boolean;
  savedWraparoundMode: boolean;
  screenRepair?: CellLineState[];
}

interface CellLineState {
  isWrapped: boolean;
  // Compact triples avoid hundreds of thousands of per-cell IPC objects in a
  // long retained history. Only combined strings and extended attrs are sparse.
  data: Uint32Array;
  combined: Record<number, string>;
  extended: Record<number, { value: number; link?: { id?: string; uri: string } }>;
}

export interface XtermSnapshotState {
  compatibility: typeof COMPATIBILITY;
  cols: number;
  rows: number;
  activeBuffer: 'normal' | 'alternate';
  normal: BufferState;
  alternate: BufferState;
  attrs: AttributeState;
  charsets: Charset[];
  glevel: number;
  modes: Record<string, ModeValue>;
  decPrivateModes: Record<string, ModeValue>;
  mouseProtocol: string;
  mouseEncoding: string;
  isCursorHidden: boolean;
  isCursorInitialized: boolean;
  precedingJoinState: number;
}

interface InternalExtendedAttrs {
  ext: number;
  urlId: number;
  clone(): InternalExtendedAttrs;
}
interface InternalAttrs {
  fg: number;
  bg: number;
  extended: InternalExtendedAttrs;
}
interface InternalCell extends InternalAttrs { content: number; combinedData: string }
interface InternalLine {
  length: number;
  isWrapped: boolean;
  getWidth(index: number): number;
  hasContent(index: number): number;
  loadCell(index: number, cell: InternalCell): InternalCell;
  setCell(index: number, cell: InternalCell): void;
}
interface InternalBuffer {
  x: number;
  y: number;
  ybase: number;
  ydisp: number;
  lines: { length: number; get(index: number): InternalLine | undefined; push(line: InternalLine): void };
  clearAllMarkers(): void;
  getBlankLine(attrs: InternalAttrs): InternalLine;
  scrollTop: number;
  scrollBottom: number;
  tabs: Record<number, boolean>;
  savedX: number;
  savedY: number;
  savedCurAttrData: InternalAttrs;
  savedCharset: Record<string, string> | undefined;
  savedCharsets: (Record<string, string> | undefined)[];
  savedGlevel: number;
  savedOriginMode: boolean;
  savedWraparoundMode: boolean;
}
interface XtermCore {
  buffer: InternalBuffer;
  _bufferService: { buffers: { normal: InternalBuffer; alt: InternalBuffer } };
  _inputHandler: {
    _curAttrData: InternalAttrs;
    _parser: { _transitions: { table: Uint16Array }; currentState: number; precedingJoinState: number };
  };
  _charsetService: {
    _charsets: (Record<string, string> | undefined)[];
    glevel: number;
    setgLevel(level: number): void;
  };
  _oscLinkService: {
    getLinkData(id: number): { id?: string; uri: string } | undefined;
    registerLink(data: { id?: string; uri: string }): number;
  };
  coreService: {
    modes: Record<string, ModeValue>;
    decPrivateModes: Record<string, ModeValue>;
    isCursorHidden: boolean;
    isCursorInitialized: boolean;
  };
  mouseStateService: { activeProtocol: string; activeEncoding: string };
}
interface XtermInstance {
  cols: number;
  rows: number;
  buffer: { active: { type: 'normal' | 'alternate' } };
  refresh?: (start: number, end: number) => void;
  _core: XtermCore;
}

const validated = new WeakSet<object>();

function compatible(terminal: unknown): XtermInstance {
  const instance = terminal as XtermInstance;
  if (validated.has(instance)) return instance;
  const core = instance?._core;
  const table = core?._inputHandler?._parser?._transitions?.table;
  let fingerprint = 2166136261;
  if (table instanceof Uint16Array) {
    for (const value of table) fingerprint = Math.imul(fingerprint ^ value, 16777619) >>> 0;
  }
  if (
    fingerprint !== TRANSITION_FINGERPRINT ||
    !core?._bufferService?.buffers?.normal || !core?._bufferService?.buffers?.alt ||
    !Array.isArray(core._bufferService.buffers.normal.savedCharsets) ||
    !Array.isArray(core._bufferService.buffers.alt.savedCharsets) ||
    !Array.isArray(core._charsetService?._charsets) ||
    typeof core._charsetService.setgLevel !== 'function' ||
    typeof core._oscLinkService?.registerLink !== 'function' ||
    typeof core._inputHandler._curAttrData?.extended?.ext !== 'number' ||
    typeof core._inputHandler._curAttrData?.extended?.clone !== 'function' ||
    typeof core._bufferService.buffers.normal.getBlankLine !== 'function' ||
    typeof core._bufferService.buffers.normal.lines.get(0)?.setCell !== 'function' ||
    typeof core.coreService?.decPrivateModes?.wraparound !== 'boolean' ||
    typeof core.mouseStateService?.activeEncoding !== 'string'
  ) {
    throw new Error(`Unsupported xterm snapshot internals; expected ${COMPATIBILITY}`);
  }
  validated.add(instance);
  return instance;
}

function copyCharsets(charsets: (Record<string, string> | undefined)[]): Charset[] {
  return charsets.map((charset) => charset ? { ...charset } : null);
}

function captureAttrs(attrs: InternalAttrs, core: XtermCore): AttributeState {
  const link = attrs.extended.urlId ? core._oscLinkService.getLinkData(attrs.extended.urlId) : undefined;
  return { fg: attrs.fg, bg: attrs.bg, extended: attrs.extended.ext, ...(link ? { link: { ...link } } : {}) };
}

function captureScreenRepair(buffer: InternalBuffer, core: XtermCore, rows: number, scrollback: number): CellLineState[] | undefined {
  const start = Math.max(0, buffer.lines.length - rows - scrollback);
  let needsRepair = false;
  for (let row = start; row < buffer.lines.length && !needsRepair; row++) {
    const line = buffer.lines.get(row)!;
    for (let col = 0; col < line.length; col++) {
      if (line.getWidth(col) === 0 && line.hasContent(col)) { needsRepair = true; break; }
    }
  }
  if (!needsRepair) return undefined;
  // SerializeAddon skips standalone combining cells. This also changes where
  // subsequent soft-wrapped rows land, so patching only the affected cell/row
  // is insufficient. Retain the bounded buffer only for this exceptional case.
  const result: CellLineState[] = [];
  for (let row = start; row < buffer.lines.length; row++) {
    const line = buffer.lines.get(row)!;
    const data = new Uint32Array(line.length * 3);
    const combined: CellLineState['combined'] = {};
    const attributes: CellLineState['extended'] = {};
    for (let col = 0; col < line.length; col++) {
      const extended = core._inputHandler._curAttrData.extended.clone();
      extended.ext = 0;
      extended.urlId = 0;
      const cell = line.loadCell(col, { content: 0, combinedData: '', fg: 0, bg: 0, extended });
      data.set([cell.content, cell.fg, cell.bg], col * 3);
      if (cell.combinedData) combined[col] = cell.combinedData;
      if (cell.extended.ext || cell.extended.urlId) {
        const attrs = captureAttrs(cell, core);
        attributes[col] = { value: attrs.extended, ...(attrs.link ? { link: attrs.link } : {}) };
      }
    }
    result.push({ isWrapped: line.isWrapped, data, combined, extended: attributes });
  }
  return result;
}

function captureBuffer(buffer: InternalBuffer, core: XtermCore, rows: number, scrollback: number): BufferState {
  const screenRepair = captureScreenRepair(buffer, core, rows, scrollback);
  return {
    x: buffer.x,
    y: buffer.y,
    scrollTop: buffer.scrollTop,
    scrollBottom: buffer.scrollBottom,
    tabs: { ...buffer.tabs },
    savedX: buffer.savedX,
    savedYOffset: buffer.savedY - buffer.ybase,
    savedAttrs: captureAttrs(buffer.savedCurAttrData, core),
    savedCharset: buffer.savedCharset ? { ...buffer.savedCharset } : null,
    savedCharsets: copyCharsets(buffer.savedCharsets),
    savedGlevel: buffer.savedGlevel,
    savedOriginMode: buffer.savedOriginMode,
    savedWraparoundMode: buffer.savedWraparoundMode,
    ...(screenRepair ? { screenRepair } : {}),
  };
}

export function captureXtermSnapshotState(terminal: unknown, scrollback = Number.POSITIVE_INFINITY): XtermSnapshotState {
  const instance = compatible(terminal);
  const core = instance._core;
  // Replay framing owns synchronized output, which is a temporary display lock.
  const { synchronizedOutput: _synchronizedOutput, ...decPrivateModes } = core.coreService.decPrivateModes;
  return {
    compatibility: COMPATIBILITY,
    cols: instance.cols,
    rows: instance.rows,
    activeBuffer: instance.buffer.active.type,
    normal: captureBuffer(core._bufferService.buffers.normal, core, instance.rows, scrollback),
    alternate: captureBuffer(core._bufferService.buffers.alt, core, instance.rows, 0),
    attrs: captureAttrs(core._inputHandler._curAttrData, core),
    charsets: copyCharsets(core._charsetService._charsets),
    glevel: core._charsetService.glevel,
    modes: { ...core.coreService.modes },
    decPrivateModes,
    mouseProtocol: core.mouseStateService.activeProtocol,
    mouseEncoding: core.mouseStateService.activeEncoding,
    isCursorHidden: core.coreService.isCursorHidden,
    isCursorInitialized: core.coreService.isCursorInitialized,
    precedingJoinState: core._inputHandler._parser.precedingJoinState,
  };
}

function restoreAttrs(attrs: InternalAttrs, state: AttributeState, core: XtermCore): void {
  attrs.fg = state.fg;
  attrs.bg = state.bg;
  attrs.extended.ext = state.extended;
  attrs.extended.urlId = state.link ? core._oscLinkService.registerLink(state.link) : 0;
}

function restoreScreenRepair(buffer: InternalBuffer, lines: CellLineState[], core: XtermCore, rows: number): void {
  buffer.clearAllMarkers();
  buffer.lines.length = 0;
  for (const _line of lines) buffer.lines.push(buffer.getBlankLine(core._inputHandler._curAttrData));
  buffer.ybase = Math.max(0, buffer.lines.length - rows);
  buffer.ydisp = buffer.ybase;
  for (let row = 0; row < lines.length; row++) {
    const source = lines[row]!;
    const target = buffer.lines.get(row)!;
    target.isWrapped = source.isWrapped;
    for (let col = 0; col < source.data.length / 3; col++) {
      const extended = source.extended[col];
      const cell = {
        content: source.data[col * 3]!,
        combinedData: source.combined[col] ?? '',
        fg: 0,
        bg: 0,
        extended: core._inputHandler._curAttrData.extended.clone(),
      };
      restoreAttrs(cell, {
        fg: source.data[col * 3 + 1]!,
        bg: source.data[col * 3 + 2]!,
        extended: extended?.value ?? 0,
        ...(extended?.link ? { link: extended.link } : {}),
      }, core);
      target.setCell(col, cell);
    }
  }
}

function restoreBuffer(buffer: InternalBuffer, state: BufferState, core: XtermCore, rows: number): void {
  buffer.x = state.x; // x === cols is xterm's pending-wrap state; do not clamp it.
  buffer.y = state.y;
  if (state.screenRepair) restoreScreenRepair(buffer, state.screenRepair, core, rows);
  buffer.scrollTop = state.scrollTop;
  buffer.scrollBottom = state.scrollBottom;
  buffer.tabs = { ...state.tabs };
  buffer.savedX = state.savedX;
  buffer.savedY = Math.max(0, buffer.ybase + state.savedYOffset);
  restoreAttrs(buffer.savedCurAttrData, state.savedAttrs, core);
  buffer.savedCharset = state.savedCharset ? { ...state.savedCharset } : undefined;
  // Preserve the array length: ESC 8 restores only the slots that ESC 7 saved.
  buffer.savedCharsets = state.savedCharsets.map((charset) => charset ? { ...charset } : undefined);
  buffer.savedGlevel = state.savedGlevel;
  buffer.savedOriginMode = state.savedOriginMode;
  buffer.savedWraparoundMode = state.savedWraparoundMode;
}

export function applyXtermSnapshotState(terminal: unknown, state: XtermSnapshotState): void {
  const instance = compatible(terminal);
  if (
    state.compatibility !== COMPATIBILITY || state.cols !== instance.cols || state.rows !== instance.rows ||
    state.activeBuffer !== instance.buffer.active.type
  ) {
    throw new Error('Xterm snapshot continuation does not match the restored screen');
  }
  const core = instance._core;
  restoreBuffer(core._bufferService.buffers.normal, state.normal, core, instance.rows);
  restoreBuffer(core._bufferService.buffers.alt, state.alternate, core, instance.rows);
  restoreAttrs(core._inputHandler._curAttrData, state.attrs, core);
  core._charsetService._charsets = state.charsets.map((charset) => charset ? { ...charset } : undefined);
  core._charsetService.setgLevel(state.glevel);
  Object.assign(core.coreService.modes, state.modes);
  Object.assign(core.coreService.decPrivateModes, state.decPrivateModes);
  core.coreService.isCursorHidden = state.isCursorHidden;
  core.coreService.isCursorInitialized = state.isCursorInitialized;
  core.mouseStateService.activeProtocol = state.mouseProtocol;
  core.mouseStateService.activeEncoding = state.mouseEncoding;
  core._inputHandler._parser.precedingJoinState = state.precedingJoinState;
  instance.refresh?.(0, instance.rows - 1);
}

export function xtermTransitionTable(terminal: unknown): Uint16Array {
  return compatible(terminal)._core._inputHandler._parser._transitions.table;
}

export function xtermParserState(terminal: unknown): number {
  return compatible(terminal)._core._inputHandler._parser.currentState;
}

/** ANSI-only callers get a correct visible cursor; exact continuation uses the state above. */
export function xtermSnapshotAnsiSuffix(terminal: unknown): string {
  const instance = compatible(terminal);
  const core = instance._core;
  const buffer = core.buffer;
  const origin = core.coreService.decPrivateModes.origin;
  const cursorRow = buffer.y - (origin ? buffer.scrollTop : 0) + 1;
  let ansi = '\x1b[?1006l\x1b[?1016l';
  if (core.mouseStateService.activeEncoding === 'SGR') ansi += '\x1b[?1006h';
  if (core.mouseStateService.activeEncoding === 'SGR_PIXELS') ansi += '\x1b[?1016h';
  ansi += core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h';
  // SerializeAddon emits DECSTBM after its own cursor movement. DECSTBM homes
  // the cursor, so restore it last, accounting for origin-relative addressing.
  ansi += `\x1b[${cursorRow};${Math.min(buffer.x, instance.cols - 1) + 1}H`;
  return ansi;
}
