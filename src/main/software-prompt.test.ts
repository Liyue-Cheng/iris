/**
 * Prompt-governance core (software-prompt.ts): deterministic tag parsing,
 * content-keyed drift detection, idempotent upsert, and factory-default
 * recognition for the project constitution.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSTITUTION_TEMPLATE,
  LEGACY_CONSTITUTION_DEFAULTS,
  SOFTWARE_PROMPT_TEMPLATE,
} from './iris-templates';
import {
  buildSoftwareBlock,
  classifyConstitution,
  classifySoftwareBlock,
  docSkeleton,
  HISTORICAL_SOFTWARE_PROMPT_SHAS,
  parseSoftwareBlock,
  SOFTWARE_PROMPT_SHA,
  upsertSoftwareBlock,
} from './software-prompt';

const V = '9.9.9';

describe('software block — build & parse', () => {
  it('a freshly built block classifies as ok', () => {
    const block = buildSoftwareBlock(V);
    expect(classifySoftwareBlock(block)).toEqual({ state: 'ok', version: V });
  });

  it('parses version, protocol, sha and the body', () => {
    const parsed = parseSoftwareBlock(buildSoftwareBlock(V));
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(V);
    expect(parsed!.attrs.protocol).toBe('2');
    expect(parsed!.declaredSha).toBe(parsed!.actualSha); // intact
    expect(parsed!.body).toContain('Folder semantics');
  });

  it('reports missing when there is no block', () => {
    expect(classifySoftwareBlock('# AGENTS\n\njust prose\n').state).toBe('missing');
  });

  it('detects drift when the body is hand-edited under its declared sha', () => {
    const block = buildSoftwareBlock(V);
    // Flip a character inside the body without touching the sha attr.
    const tampered = block.replace('Folder semantics', 'Folder semanticz');
    expect(classifySoftwareBlock(tampered).state).toBe('drifted');
  });
});

describe('software block — upsert preserves user content', () => {
  it('creates into an empty file', () => {
    const { text, action } = upsertSoftwareBlock('', V);
    expect(action).toBe('created');
    expect(classifySoftwareBlock(text).state).toBe('ok');
  });

  it('appends below existing hand-written content, leaving it intact', () => {
    const intro = '# My project\n\nhand-written intro\n';
    const { text, action } = upsertSoftwareBlock(intro, V);
    expect(action).toBe('created');
    expect(text.startsWith('# My project\n\nhand-written intro')).toBe(true);
    expect(classifySoftwareBlock(text).state).toBe('ok');
  });

  it('is idempotent — re-upserting the same version changes nothing', () => {
    const once = upsertSoftwareBlock('# x\n', V);
    const twice = upsertSoftwareBlock(once.text, V);
    expect(twice.action).toBe('unchanged');
    expect(twice.text).toBe(once.text);
  });

  it('replaces an old-version block in place, keeping surrounding text', () => {
    const intro = '# top\n\n';
    const tail = '\n## my own footer\n';
    const oldBlock = buildSoftwareBlock('0.0.1');
    const file = intro + oldBlock + tail;
    const { text, action } = upsertSoftwareBlock(file, V);
    expect(action).toBe('updated');
    expect(text.startsWith('# top')).toBe(true);
    expect(text).toContain('## my own footer');
    expect(classifySoftwareBlock(text)).toEqual({ state: 'ok', version: V });
    // Exactly one block survives (the body itself mentions the opening tag in
    // prose, so count the closing tag, which only the real block carries).
    expect(text.split('</iris-software>').length).toBe(2);
  });
});

describe('constitution — factory-default recognition', () => {
  it('recognizes the current shipped template', () => {
    expect(classifyConstitution(CONSTITUTION_TEMPLATE)).toBe('current-default');
  });

  it('recognizes every prior shipped template as stale (upgradeable)', () => {
    expect(LEGACY_CONSTITUTION_DEFAULTS.length).toBeGreaterThan(0);
    for (const legacy of LEGACY_CONSTITUTION_DEFAULTS) {
      expect(classifyConstitution(legacy)).toBe('stale-default');
    }
  });

  it('treats a hand-edited constitution as customized', () => {
    const edited = `${CONSTITUTION_TEMPLATE}\n\n## my extra house rule\n`;
    expect(classifyConstitution(edited)).toBe('customized');
  });

  it('ignores CRLF / trailing-whitespace differences', () => {
    const crlf = CONSTITUTION_TEMPLATE.replace(/\n/g, '\r\n') + '\n\n  ';
    expect(classifyConstitution(crlf)).toBe('current-default');
  });
});

describe('software prompt body sanity', () => {
  it('carries the injection fallback rule', () => {
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('FALLBACK');
    expect(SOFTWARE_PROMPT_TEMPLATE).toContain('do not re-read it from disk');
  });
});

describe('prompt governance discipline', () => {
  it('the historical sha archive holds well-formed shas, never the current one', () => {
    expect(HISTORICAL_SOFTWARE_PROMPT_SHAS.length).toBeGreaterThan(0);
    for (const sha of HISTORICAL_SOFTWARE_PROMPT_SHAS) {
      expect(sha).toMatch(/^[0-9a-f]{12}$/);
      expect(sha).not.toBe(SOFTWARE_PROMPT_SHA);
    }
  });
});

describe('doc skeleton ↔ prompt example consistency', () => {
  it('createDoc skeletons carry exactly the protocol frontmatter', () => {
    expect(docSkeleton('issue', 'x')).toBe('---\ntitle: x\nstatus: Todo\n---\n');
    expect(docSkeleton('report', 'x')).toBe('---\ntitle: x\nstatus: Active\n---\n');
    expect(docSkeleton('status', 'x')).toBe('---\ntitle: x\nreflects:\n---\n');
    expect(docSkeleton('misc', 'x')).toBe('---\ntitle: x\n---\n');
  });

  it('the software prompt example shows the same literals the skeletons write', () => {
    for (const literal of ['title:', 'status: Todo', 'status: Active', 'reflects:', 'labels:']) {
      expect(SOFTWARE_PROMPT_TEMPLATE).toContain(literal);
    }
  });

  it('the constitution owns the status values the skeletons seed', () => {
    expect(CONSTITUTION_TEMPLATE).toContain('`Todo`');
    expect(CONSTITUTION_TEMPLATE).toContain('`Active`');
  });
});
