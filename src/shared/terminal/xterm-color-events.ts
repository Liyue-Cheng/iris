/** The color events have no public headless API in xterm 6.1.0-beta.256. */
export type XtermColorEvent = Array<
  | { type: 0; index: number }
  | { type: 1; index: number; color: [number, number, number] }
  | { type: 2; index?: number }
>;

interface Disposable { dispose(): void }
interface ColorCore {
  _inputHandler: {
    onColor(listener: (event: XtermColorEvent) => void): Disposable;
    onRequestColorSchemeQuery(listener: () => void): Disposable;
  };
  coreService: { decPrivateModes: { colorSchemeUpdates: boolean } };
}

export function xtermColorCore(terminal: unknown): ColorCore {
  const core = (terminal as { _core?: ColorCore })._core;
  if (typeof core?._inputHandler?.onColor !== 'function' ||
      typeof core._inputHandler.onRequestColorSchemeQuery !== 'function' ||
      typeof core.coreService?.decPrivateModes?.colorSchemeUpdates !== 'boolean') {
    throw new Error('Unsupported xterm color protocol internals');
  }
  return core;
}
