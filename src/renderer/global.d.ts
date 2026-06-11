/**
 * Renderer-global type declarations: the preload bridge surface.
 * Keep in sync with src/preload/index.ts.
 */
export {};

declare global {
  interface Window {
    api: {
      invoke<P, R>(channel: string, payload?: P): Promise<R>;
      on<P>(channel: string, handler: (payload: P) => void): () => void;
    };
  }
}
