/**
 * Serializes async Crepe create/destroy work per root DOM node.
 *
 * React StrictMode intentionally runs effect setup/cleanup/setup in dev.
 * Crepe create() and destroy() are both async, so without a queue two editor
 * instances can briefly operate on the same root. Keep the whole mounted
 * lifetime in the queue: the next instance may start only after the previous
 * one has been stopped and destroyed.
 */
interface AsyncCrepeLike {
  create(): Promise<unknown>;
  destroy(): Promise<unknown>;
}

export interface CrepeLifecycle {
  stop(): void;
}

const rootQueues = new WeakMap<HTMLElement, Promise<void>>();

function reportCrepeLifecycleError(label: string, err: unknown): void {
  console.error(`[Crepe lifecycle] ${label}`, err);
}

export function mountCrepeSerially(opts: {
  root: HTMLElement;
  crepe: AsyncCrepeLike;
  onCreated?: () => void;
  label?: string;
}): CrepeLifecycle {
  const { root, crepe, onCreated, label = 'editor' } = opts;
  let stopped = false;
  let releaseStop: () => void = () => {};
  const stoppedPromise = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });

  const previous = rootQueues.get(root) ?? Promise.resolve();
  const lifecycle = previous
    .catch((err) => reportCrepeLifecycleError(`${label}: previous lifecycle failed`, err))
    .then(async () => {
      if (stopped) return;
      let created = false;
      try {
        await crepe.create();
        created = true;
        if (!stopped) {
          onCreated?.();
          await stoppedPromise;
        }
      } catch (err) {
        reportCrepeLifecycleError(`${label}: create failed`, err);
      } finally {
        if (created) {
          try {
            await crepe.destroy();
          } catch (err) {
            reportCrepeLifecycleError(`${label}: destroy failed`, err);
          }
        }
      }
    });

  const tracked = lifecycle.finally(() => {
    if (rootQueues.get(root) === tracked) rootQueues.delete(root);
  });
  rootQueues.set(root, tracked);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      releaseStop();
    },
  };
}
