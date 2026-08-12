export type MarkdownLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'document'; path: string; fragment: string | null }
  | { kind: 'invalid' };

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decodeFragment(value: string): string | null {
  const decoded = decodePart(value);
  return decoded?.length ? decoded : null;
}

function normalizeProjectPath(currentPath: string, relativePath: string): string | null {
  const parts = currentPath.split('/');
  parts.pop();
  for (const part of relativePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** Resolve only the link forms Iris owns. Everything else must be prevented. */
export function resolveMarkdownLink(currentPath: string, href: string): MarkdownLinkTarget {
  const value = href.trim();
  if (!value || value.includes('\\')) return { kind: 'invalid' };

  if (value.startsWith('#')) {
    const fragment = decodeFragment(value.slice(1));
    return fragment
      ? { kind: 'document', path: currentPath, fragment }
      : { kind: 'invalid' };
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? { kind: 'external', url: url.href }
        : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }

  if (value.startsWith('/') || value.startsWith('//')) return { kind: 'invalid' };
  const hashAt = value.indexOf('#');
  const rawPath = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const rawFragment = hashAt >= 0 ? value.slice(hashAt + 1) : null;
  if (!rawPath || rawPath.includes('?')) return { kind: 'invalid' };

  const decodedPath = decodePart(rawPath);
  if (
    !decodedPath ||
    decodedPath.startsWith('/') ||
    decodedPath.includes('\\') ||
    !decodedPath.toLowerCase().endsWith('.md')
  ) {
    return { kind: 'invalid' };
  }

  const path = normalizeProjectPath(currentPath, decodedPath);
  if (!path) return { kind: 'invalid' };

  const fragment = rawFragment === null ? null : decodeFragment(rawFragment);
  if (rawFragment !== null && fragment === null) return { kind: 'invalid' };
  return { kind: 'document', path, fragment };
}

export function headingSlug(text: string): string {
  const slug = text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s-]+/gu, '-')
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

export function headingSlugs(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return texts.map((text) => {
    const base = headingSlug(text);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export function findFragmentTarget(root: HTMLElement, fragment: string): HTMLElement | null {
  const explicit = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[id]')).find(
    (element) => element.id === fragment,
  );
  if (explicit) return explicit;

  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'));
  const slugs = headingSlugs(headings.map((heading) => heading.textContent ?? ''));
  const index = slugs.indexOf(fragment);
  return index < 0 ? null : headings[index] ?? null;
}

export function scrollToFragment(root: HTMLElement, fragment: string): boolean {
  const target = findFragmentTarget(root, fragment);
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  return true;
}
