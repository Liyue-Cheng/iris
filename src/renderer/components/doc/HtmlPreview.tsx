/**
 * Sandboxed preview of an HTML document (issue 2026-10-25-支持HTML).
 *
 * Renders the SAVED file through main's `iris-doc://<token>/` protocol in an
 * `<iframe sandbox>` that never gets allow-same-origin: the page runs with an
 * opaque origin, cannot reach Iris or window.api, and is subject to the CSP
 * main attaches from the HTML preview settings. Relative resources
 * (`./name.assets/…`) resolve against the document's real path.
 *
 * The frame reloads whenever the saved bytes or the preview policy change —
 * that is the "live" part: agent writes and our own saves both land here.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, TriangleAlert } from 'lucide-react';
import { CHANNELS } from '@shared/protocol';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';
import { useSettings } from '@renderer/stores/settings-store';

const baseUrls = new Map<string, Promise<string>>();

function previewBaseUrl(): Promise<string> {
  const scope = projectScopeState.get();
  if (!scope) return Promise.reject(new Error('no active project scope'));
  const key = `${scope.generation}:${scope.root}`;
  const cached = baseUrls.get(key);
  if (cached) return cached;
  const request = window.api
    .invoke<{ expectedScope: typeof scope }, { baseUrl: string }>(CHANNELS.DOC_PREVIEW_BASE, {
      expectedScope: scope,
    })
    .then(({ baseUrl }) => {
      if (!sameProjectScope(scope, projectScopeState.get())) throw new Error('stale project scope');
      return baseUrl;
    });
  // A failed grant is retried on the next mount instead of being cached.
  void request.catch(() => baseUrls.delete(key));
  baseUrls.set(key, request);
  return request;
}

/** Cheap content fingerprint (FNV-1a) so the frame reloads only on change. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}-${(hash >>> 0).toString(36)}`;
}

export function previewUrlFor(baseUrl: string, path: string): string {
  return baseUrl + path.split('/').map(encodeURIComponent).join('/');
}

export function HtmlPreview({ path, savedText }: { path: string; savedText: string }): JSX.Element {
  const { t } = useTranslation();
  const behavior = useSettings()?.behavior;
  const scripts = behavior?.htmlPreviewScripts ?? true;
  const network = behavior?.htmlPreviewNetwork ?? false;
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useMemo(() => fingerprint(savedText), [savedText]);

  useEffect(() => {
    let alive = true;
    setError(null);
    void previewBaseUrl()
      .then((url) => {
        if (alive) setBaseUrl(url);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-destructive">
        <TriangleAlert className="size-4 shrink-0" />
        {t('editor.htmlPreviewUnavailable', { error })}
      </div>
    );
  }
  if (!baseUrl) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <iframe
      // Remount (not just navigate) on content/policy change: a fresh frame
      // picks up the new CSP and drops any state the old page built up.
      key={`${version}:${scripts ? 's' : ''}${network ? 'n' : ''}`}
      aria-label={t('editor.htmlPreviewTitle')}
      src={previewUrlFor(baseUrl, path)}
      // Never add allow-same-origin: with allow-scripts it would let the page
      // remove its own sandbox. allow-popups routes target=_blank links to
      // the window-open handler, which opens http(s) in the system browser.
      sandbox={scripts ? 'allow-scripts allow-popups' : 'allow-popups'}
      referrerPolicy="no-referrer"
      className="block h-full w-full border-0 bg-white"
    />
  );
}
