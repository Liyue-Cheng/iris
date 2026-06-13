/**
 * @file src/shared/style-maps.ts
 * @purpose The two isomorphic style tables (status → badge template,
 *   label → badge template) shared by main (IO + seeding) and renderer
 *   (badge rendering + settings UI).
 *
 * Protocol stance (软件定义书 键是硬的，值是软的): the stored status/label
 * string IS the displayed string — no canonical lowercase forms, no display
 * mapping layer. The tables match LITERALLY (case-sensitive); any string
 * without an entry renders with the gray default TEMPLATE. Graceful
 * degradation, not an error.
 *
 * Templates (round-3 验收反馈): a badge is not "just a color" — it's a
 * designed visual recipe. We ship a fixed library of preset templates
 * (variant × color); the config assigns matching strings to a template id.
 * "有预设模板，把匹配字符串填进模板" — that's exactly this map.
 *
 * Storage: project level wins — `.iris/styles.json`; machine defaults live
 * in `~/.iris/styles.json` and are copied into the project at init time.
 */

/** Visual variants — the "shape" half of a template. */
export type BadgeVariant = 'solid' | 'soft' | 'outline' | 'dot';

/** Palette slots — the "color" half. gray maps to the muted tone. */
export type BadgeColor = 'gray' | 'love' | 'gold' | 'rose' | 'pine' | 'foam' | 'iris';

/** One preset template: a complete designed look with a stable id. */
export interface BadgeTemplate {
  /** Stable id, also the value stored in the maps, e.g. "soft:pine". */
  id: string;
  /** Human label for the settings gallery, e.g. "柔光·松绿". */
  label: string;
  variant: BadgeVariant;
  color: BadgeColor;
}

const VARIANT_LABEL: Record<BadgeVariant, string> = {
  solid: '实心',
  soft: '柔光',
  outline: '描边',
  dot: '圆点',
};

const COLOR_LABEL: Record<BadgeColor, string> = {
  gray: '灰',
  love: '玫红',
  gold: '金',
  rose: '粉',
  pine: '松绿',
  foam: '青',
  iris: '紫',
};

function tmpl(variant: BadgeVariant, color: BadgeColor): BadgeTemplate {
  return {
    id: `${variant}:${color}`,
    label: `${VARIANT_LABEL[variant]}·${COLOR_LABEL[color]}`,
    variant,
    color,
  };
}

/**
 * The preset library — a curated gallery (not every variant×color combo, to
 * keep choices tasteful). soft + dot cover all colors (the workhorses);
 * solid + outline are the emphasis / muted accents.
 */
export const BADGE_TEMPLATES: readonly BadgeTemplate[] = [
  // soft tint — the default status look
  tmpl('soft', 'gray'),
  tmpl('soft', 'foam'),
  tmpl('soft', 'gold'),
  tmpl('soft', 'love'),
  tmpl('soft', 'pine'),
  tmpl('soft', 'iris'),
  tmpl('soft', 'rose'),
  // solid fill — strong emphasis (done / urgent)
  tmpl('solid', 'pine'),
  tmpl('solid', 'love'),
  tmpl('solid', 'gold'),
  tmpl('solid', 'iris'),
  // outline — muted / not-started
  tmpl('outline', 'gray'),
  tmpl('outline', 'foam'),
  tmpl('outline', 'iris'),
  // dot + text — the classic label look
  tmpl('dot', 'gray'),
  tmpl('dot', 'foam'),
  tmpl('dot', 'gold'),
  tmpl('dot', 'love'),
  tmpl('dot', 'pine'),
  tmpl('dot', 'iris'),
  tmpl('dot', 'rose'),
];

/** Gray soft pill — the fallback for any unmapped / unknown-id string. */
export const DEFAULT_TEMPLATE_ID = 'soft:gray';

const TEMPLATE_BY_ID = new Map(BADGE_TEMPLATES.map((t) => [t.id, t]));

/** Resolve a stored template id to a template; unknown ids → gray default. */
export function templateById(id: string | undefined): BadgeTemplate {
  return (id && TEMPLATE_BY_ID.get(id)) || TEMPLATE_BY_ID.get(DEFAULT_TEMPLATE_ID)!;
}

/**
 * Values are stored as plain strings (soft): an unknown template id degrades
 * to the gray default at render time, same as an unmapped status string.
 */
export interface StyleMaps {
  version: 1;
  /** Literal status string → template id. One table for all doc types. */
  status: Record<string, string>;
  /** Literal label string → template id. */
  label: Record<string, string>;
}

/** Where the effective maps came from (display hint in the settings UI). */
export type StyleMapsSource = 'project' | 'machine' | 'builtin';

export interface StyleMapsState {
  maps: StyleMaps;
  source: StyleMapsSource;
}

/** The canonical issue state machine — stored value = displayed value. */
export const ISSUE_STATUSES = [
  'Todo',
  'In Progress',
  'In Review',
  'Blocked',
  'Done',
  'Canceled',
] as const;

/** The canonical report states. `Backlog` is hidden in the left lens. */
export const REPORT_STATUSES = ['Active', 'Backlog'] as const;

export const DEFAULT_STYLE_MAPS: StyleMaps = {
  version: 1,
  status: {
    Todo: 'soft:gray',
    'In Progress': 'soft:foam',
    'In Review': 'soft:gold',
    Blocked: 'soft:love',
    Done: 'solid:pine',
    Canceled: 'outline:gray',
    Active: 'soft:foam',
    Backlog: 'dot:gray',
  },
  label: {},
};

/**
 * Legacy migration: round-3 batch 2 first shipped raw color ids
 * ('foam', 'gray', …) as values; they now mean a soft tint of that color.
 * A value that's a bare color name maps to `soft:<color>`.
 */
const LEGACY_COLORS = new Set<string>(['gray', 'love', 'gold', 'rose', 'pine', 'foam', 'iris']);
function migrateValue(v: string): string {
  return LEGACY_COLORS.has(v) ? `soft:${v}` : v;
}

/** Tolerant shape check: salvage what fits, drop the rest (never throw). */
export function sanitizeStyleMaps(input: unknown): StyleMaps | null {
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const pick = (v: unknown): Record<string, string> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = migrateValue(val);
    }
    return out;
  };
  if (!('status' in obj) && !('label' in obj)) return null;
  return { version: 1, status: pick(obj['status']), label: pick(obj['label']) };
}
