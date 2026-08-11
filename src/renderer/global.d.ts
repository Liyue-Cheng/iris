/**
 * Renderer-global type declarations: the preload bridge surface.
 * Keep in sync with src/preload/index.ts.
 */
export {};

declare global {
  interface Window {
    api: {
      invoke<P, R>(
        channel: string,
        payload?: P,
        context?: { correlationId?: string },
      ): Promise<R>;
      on<P>(channel: string, handler: (payload: P) => void): () => void;
      /** Resolve the absolute path of a File supplied by an OS drag event. */
      getPathForFile(file: File): string;
      /** Windows build number for xterm windowsPty; null off-Windows. */
      windowsBuild: number | null;
    };
  }
}
