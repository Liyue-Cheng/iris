/**
 * Settings view — Marina's SettingsView pattern, trimmed to Iris's schema.
 *
 * Form factor (Marina CP-4 decisions, kept here):
 * - Not a modal, not a window: a view that replaces the three-pane body
 *   (TitleBar stays — it carries the drag region and window controls).
 * - Left category nav + right detail panel.
 * - Every control applies immediately (no save button): control → the
 *   `settings.update` instruction → main validates/persists/broadcasts →
 *   settings-store re-renders. Controls never mutate local state as truth.
 * - Validation failures (SettingsError from main) land in the header error
 *   bar; the control snaps back to the last valid value on next broadcast.
 *
 * Extending (for the next agent): add a CategoryId + CATEGORIES entry and a
 * case in CategoryPanel, then build the panel from SettingRow / the shared
 * inputs. New persisted fields first go into Settings + DEFAULT_SETTINGS +
 * validateSettings (src/main/settings-manager.ts), then get a control here.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Bot,
  ChevronDown,
  Info,
  Moon,
  MoonStar,
  Palette,
  SquareTerminal,
  Sun,
  SwatchBook,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type {
  AgentConfig,
  DeepPartial,
  HookCliInfo,
  InjectionState,
  Settings,
  ThemeId,
} from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import {
  BADGE_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  ISSUE_STATUSES,
  REPORT_STATUSES,
  templateById,
} from '@shared/style-maps';
import { pipeline } from '@renderer/cpu';
import { useSettings } from '@renderer/stores/settings-store';
import { useStyleMaps } from '@renderer/stores/styles-store';
import { useProject } from '@renderer/stores/project-store';
import { editorStore } from '@renderer/stores/editor-store';
import { Badge } from '@renderer/components/ui/badge';
import { collectAllLabels } from '@renderer/lib/label-utils';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import { cn } from '@renderer/lib/utils';

// ──────────────────────────────────────────────────────────────────
// Open/close state — module-level store, same pattern as CreateDocDialog.
// ──────────────────────────────────────────────────────────────────

let open = false;
const subs = new Set<() => void>();

export function openSettingsView(): void {
  // B4: opening settings unmounts the editor — flush pending edits first.
  void editorStore.flushBeforeSwitch();
  open = true;
  subs.forEach((cb) => cb());
}

export function closeSettingsView(): void {
  open = false;
  subs.forEach((cb) => cb());
}

export function useSettingsViewOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => open,
  );
}

// ──────────────────────────────────────────────────────────────────
// Categories
// ──────────────────────────────────────────────────────────────────

type CategoryId = 'appearance' | 'styles' | 'terminal' | 'agents' | 'advanced' | 'about';

const CATEGORIES: Array<{ id: CategoryId; icon: typeof Palette; label: string }> = [
  { id: 'appearance', icon: Palette, label: '外观' },
  { id: 'styles', icon: SwatchBook, label: '样式' },
  { id: 'terminal', icon: SquareTerminal, label: '终端' },
  { id: 'agents', icon: Bot, label: 'Agents' },
  { id: 'advanced', icon: Wrench, label: '高级' },
  { id: 'about', icon: Info, label: '关于' },
];

/** All controls funnel updates through here: instruction in, broadcast out. */
async function updateSettings(
  partial: DeepPartial<Settings>,
  setError: (msg: string | null) => void,
): Promise<void> {
  setError(null);
  try {
    await pipeline.dispatch('settings.update', partial);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

// ──────────────────────────────────────────────────────────────────
// View shell
// ──────────────────────────────────────────────────────────────────

export function SettingsView(): JSX.Element {
  const [active, setActive] = useState<CategoryId>('appearance');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSettingsView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-3 px-4">
        <h1 className="text-sm font-semibold">设置</h1>
        {errorMsg && (
          <span role="alert" className="truncate text-xs text-destructive">
            {errorMsg}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          title="关闭（Esc）"
          onClick={closeSettingsView}
        >
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r border-subtle p-2" aria-label="设置分类">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActive(c.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]',
                active === c.id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <c.icon className="h-3.5 w-3.5" />
              {c.label}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="max-w-2xl">
            <CategoryPanel categoryId={active} setError={setErrorMsg} />
          </div>
        </main>
      </div>
    </div>
  );
}

function CategoryPanel({
  categoryId,
  setError,
}: {
  categoryId: CategoryId;
  setError: (msg: string | null) => void;
}): JSX.Element {
  switch (categoryId) {
    case 'appearance':
      return <AppearancePanel setError={setError} />;
    case 'styles':
      return <StylesPanel setError={setError} />;
    case 'terminal':
      return <TerminalPanel setError={setError} />;
    case 'agents':
      return <AgentsPanel setError={setError} />;
    case 'advanced':
      return <AdvancedPanel setError={setError} />;
    case 'about':
      return <AboutPanel />;
  }
}

// ──────────────────────────────────────────────────────────────────
// Shared primitives
// ──────────────────────────────────────────────────────────────────

/** Label + hint on the left, control on the right. Every setting is one row. */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start gap-6 border-b border-subtle py-3.5 last:border-b-0">
      <div className="w-52 shrink-0">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PanelTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h2 className="mb-1 text-base font-semibold">{children}</h2>;
}

/** Dummy marker for sections other agents will fill in. */
function Placeholder({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-subtle px-3 py-2.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Text input that commits on blur / Enter. Local draft while focused so a
 * settings broadcast mid-typing can't clobber the user's input (Marina FBK-3
 * lesson); the broadcast value re-syncs once the field loses focus.
 */
function CommitInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  return (
    <Input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
          e.stopPropagation(); // don't let Esc also close the settings view
        }
      }}
    />
  );
}

/** Two-state switch; commits immediately like every other control. */
function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'h-5 w-9 rounded-full p-0.5 transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'block h-4 w-4 rounded-full bg-background shadow transition-transform',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}

/** Small enum picker — one button per option, immediate commit. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-[12px]',
            value === o.value ? 'border-primary bg-accent' : 'hover:bg-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** CommitInput for numbers; out-of-range values are rejected by main and snap back. */
function NumberCommitInput({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="w-24"
        defaultValue={value}
        key={value} // snap back to broadcast value after a rejected commit
        min={min}
        max={max}
        step={step}
        onBlur={(e) => {
          const v = Number.parseFloat(e.target.value);
          if (Number.isFinite(v) && v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <span className="text-[11px] text-muted-foreground">
        {min} – {max}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// 外观
// ──────────────────────────────────────────────────────────────────

const THEMES: Array<{ id: ThemeId; label: string; icon: typeof Moon; tone: string }> = [
  { id: 'rose-pine', label: 'Rosé Pine', icon: Moon, tone: '深色 · 默认' },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', icon: Sun, tone: '浅色' },
  { id: 'rose-pine-moon', label: 'Rosé Pine Moon', icon: MoonStar, tone: '深色' },
];

function AppearancePanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const settings = useSettings();
  const theme = settings?.appearance.theme ?? 'rose-pine';

  return (
    <section>
      <PanelTitle>外观</PanelTitle>

      <SettingRow label="主题" hint="立即生效；终端配色同步切换">
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => void updateSettings({ appearance: { theme: t.id } }, setError)}
              className={cn(
                'flex flex-1 flex-col items-start gap-1 rounded-md border px-3 py-2 text-left',
                theme === t.id ? 'border-primary bg-accent' : 'hover:bg-muted',
              )}
            >
              <span className="flex items-center gap-1.5 text-[13px]">
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </span>
              <span className="text-[11px] text-muted-foreground">{t.tone}</span>
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="UI 字体" hint="侧栏 / 按钮 / 正文等界面区域；font-family 串">
        <CommitInput
          value={settings?.appearance.uiFontFamily ?? ''}
          placeholder="'LXGW WenKai', system-ui, sans-serif"
          onCommit={(v) => void updateSettings({ appearance: { uiFontFamily: v } }, setError)}
        />
      </SettingRow>

      <SettingRow label="界面缩放" hint="整窗缩放（原生 Chromium zoom），1.0 为 100%">
        <NumberCommitInput
          value={settings?.appearance.uiZoom ?? 1.0}
          min={0.75}
          max={1.5}
          step={0.05}
          onCommit={(v) => void updateSettings({ appearance: { uiZoom: v } }, setError)}
        />
      </SettingRow>

      <SettingRow
        label="编辑器块编辑（BlockEdit）"
        hint="悬停块左侧的 ＋/拖拽手柄与斜杠菜单（/ 唤起）；关闭即整体禁用"
      >
        <ToggleSwitch
          checked={settings?.behavior.editorBlockEdit ?? false}
          onChange={(v) => void updateSettings({ behavior: { editorBlockEdit: v } }, setError)}
        />
      </SettingRow>

      <SettingRow label="文档排版" hint="标题字阶、行宽等正文渲染参数">
        <Placeholder>占位 — 待 Crepe 排版 token（--crepe-font-* 系列）接入设置层。</Placeholder>
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 样式 — 两张同构的可配置表：状态 → 徽章样式、标签 → 徽章样式。
// 项目级配置（.iris/styles.json，初始化时由机器默认播种）；字面精确匹配，
// 未配置的值落灰色默认（键是硬的，值是软的）。
// ──────────────────────────────────────────────────────────────────

/**
 * Template picker — a dropdown gallery of the preset templates, each shown
 * as a live preview rendered with the row's own string (round-3: 预设模板，
 * 把匹配字符串填进模板). The trigger shows the current template's preview.
 */
function TemplatePicker({
  sampleText,
  value,
  onPick,
}: {
  sampleText: string;
  value: string;
  onPick: (templateId: string) => void;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="选择显示模板"
          className="flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-muted/60"
        >
          <Badge template={templateById(value)} text={sampleText} />
          <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="grid max-h-72 grid-cols-2 gap-0.5 overflow-y-auto">
        {BADGE_TEMPLATES.map((t) => (
          <DropdownMenuItem key={t.id} onClick={() => onPick(t.id)} className="justify-start">
            <Badge template={t} text={sampleText} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StyleMapTable({
  title,
  hint,
  entries,
  suggestions,
  onChange,
}: {
  title: string;
  hint: string;
  entries: Record<string, string>;
  /** Quick-add candidates not yet in the table (canonical states / in-use labels). */
  suggestions: string[];
  onChange: (next: Record<string, string>) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const keys = Object.keys(entries);
  const candidates = suggestions.filter((s) => !(s in entries));

  const add = (key: string): void => {
    const k = key.trim();
    if (k !== '' && !(k in entries)) onChange({ ...entries, [k]: DEFAULT_TEMPLATE_ID });
    setDraft('');
  };

  return (
    <div className="mb-6">
      <h3 className="text-[13px] font-medium">{title}</h3>
      <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-[13px]">
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-b border-subtle last:border-b-0">
                <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{k}</td>
                <td className="w-56 px-3 py-1.5">
                  <TemplatePicker
                    sampleText={k}
                    value={entries[k] ?? DEFAULT_TEMPLATE_ID}
                    onPick={(id) => onChange({ ...entries, [k]: id })}
                  />
                </td>
                <td className="w-8 px-2 py-1.5">
                  <button
                    type="button"
                    title="移除映射（该值降级为灰色默认）"
                    onClick={() => {
                      const next = { ...entries };
                      delete next[k];
                      onChange(next);
                    }}
                    className="rounded-sm p-1 text-muted-foreground/60 hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-center text-xs text-muted-foreground">
                  空表 — 所有值都渲染灰色默认
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Input
          value={draft}
          placeholder="新增字符串，回车添加"
          className="h-7 w-48 text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(draft);
            if (e.key === 'Escape') {
              setDraft('');
              e.stopPropagation();
            }
          }}
        />
        {candidates.map((s) => (
          <button
            key={s}
            type="button"
            title={`添加 ${s}`}
            onClick={() => add(s)}
            className="rounded border border-subtle px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground"
          >
            + {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function StylesPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const { maps, source } = useStyleMaps();
  const { phase, scan } = useProject();
  const projectOpen = phase === 'ready' && (scan?.hasIris ?? false);

  const write = async (partial: Partial<typeof maps>): Promise<void> => {
    setError(null);
    try {
      await pipeline.dispatch('styles.update', { maps: { ...maps, ...partial } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!projectOpen) {
    return (
      <section>
        <PanelTitle>样式</PanelTitle>
        <Placeholder>
          样式表是项目级配置（.iris/styles.json）。打开一个带 .iris/ 的项目后在这里编辑；
          初始化项目时会以机器级默认（~/.iris/styles.json）作为起点。
        </Placeholder>
      </section>
    );
  }

  return (
    <section>
      <PanelTitle>样式</PanelTitle>
      <p className="mb-4 text-xs text-muted-foreground">
        写入 <code className="font-mono">.iris/styles.json</code>（当前生效层：
        {source === 'project' ? '项目级' : source === 'machine' ? '机器级默认' : '内置默认'}
        ）。匹配按字面精确比对，未配置的值渲染灰色默认徽章。
      </p>

      <StyleMapTable
        title="状态 → 模板"
        hint="把状态字符串指到一个预设模板（实心 / 柔光 / 描边 / 圆点 × 七色）；issue 六态与 report 两态共用一张表，自由状态字符串也可加入"
        entries={maps.status}
        suggestions={[...ISSUE_STATUSES, ...REPORT_STATUSES]}
        onChange={(next) => void write({ status: next })}
      />

      <StyleMapTable
        title="标签 → 模板"
        hint="把标签字符串指到一个预设模板；未配置的标签落灰色默认"
        entries={maps.label}
        suggestions={scan?.root ? collectAllLabels(scan.root) : []}
        onChange={(next) => void write({ label: next })}
      />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 终端
// ──────────────────────────────────────────────────────────────────

function TerminalPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const settings = useSettings();

  return (
    <section>
      <PanelTitle>终端</PanelTitle>

      <SettingRow label="终端字体" hint="等宽字体优先；font-family 串">
        <CommitInput
          value={settings?.appearance.terminalFontFamily ?? ''}
          placeholder="'Cascadia Mono', Consolas, monospace"
          onCommit={(v) =>
            void updateSettings({ appearance: { terminalFontFamily: v } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label="终端字号">
        <NumberCommitInput
          value={settings?.appearance.terminalFontSize ?? 13}
          min={8}
          max={24}
          step={1}
          onCommit={(v) => void updateSettings({ appearance: { terminalFontSize: v } }, setError)}
        />
      </SettingRow>

      <SettingRow label="终端行高" hint="行高倍数，默认 1.2">
        <NumberCommitInput
          value={settings?.appearance.terminalLineHeight ?? 1.2}
          min={1.0}
          max={2.0}
          step={0.1}
          onCommit={(v) =>
            void updateSettings({ appearance: { terminalLineHeight: v } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label="划选即复制" hint="选中终端文本自动写入剪贴板">
        <ToggleSwitch
          checked={settings?.behavior.selectOnCopy ?? true}
          onChange={(v) => void updateSettings({ behavior: { selectOnCopy: v } }, setError)}
        />
      </SettingRow>

      <SettingRow label="终端右键" hint="菜单：复制/粘贴/清屏；直接粘贴：右键即粘贴（配合划选即复制）">
        <Segmented
          value={settings?.behavior.terminalRightClick ?? 'menu'}
          options={[
            { value: 'menu', label: '菜单' },
            { value: 'paste', label: '直接粘贴' },
          ]}
          onChange={(v) =>
            void updateSettings({ behavior: { terminalRightClick: v } }, setError)
          }
        />
      </SettingRow>

      <SettingRow
        label="终端渲染器"
        hint="auto 优先 WebGL、失败回退 DOM；显式 DOM 是兼容性逃生舱。切换会话后生效"
      >
        <Segmented
          value={settings?.advanced.terminalRenderer ?? 'auto'}
          options={[
            { value: 'auto', label: 'auto' },
            { value: 'webgl', label: 'WebGL' },
            { value: 'dom', label: 'DOM' },
          ]}
          onChange={(v) =>
            void updateSettings({ advanced: { terminalRenderer: v } }, setError)
          }
        />
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Agents — 核心手势"用 X 打开"的 X 列表 + 上下文注入适配层（round-3 A 条）。
// 协议层不变：壳只设 FOCUS_DOC。注入是适配器——focus-context 脚本（机器级，
// App 拥有）+ 各 agent CLI 自己配置里的 SessionStart hook（用户拥有，Iris
// 只检测、建议、经确认代写）。
// ──────────────────────────────────────────────────────────────────

const INJECTION_LABEL: Record<NonNullable<AgentConfig['injection']> | 'unset', string> = {
  hook: 'hook',
  flag: 'flag',
  none: '无',
  unset: '无',
};

const HOOK_STATE_META: Record<
  HookCliInfo['state'],
  { label: string; cls: string }
> = {
  configured: { label: '已配置', cls: 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]' },
  'not-configured': { label: '未配置 hook', cls: 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]' },
  'cli-not-found': { label: '未检测到', cls: 'bg-muted text-muted-foreground' },
  'manual-only': { label: '需手动配置', cls: 'bg-[var(--rp-iris)]/20 text-[var(--rp-iris)]' },
};

/** New-agent quick presets — flag templates for the hook-less CLIs included
 *  (the "哪个 agent 吃哪种参数" knowledge, living at the machine layer). */
const AGENT_PRESETS: AgentConfig[] = [
  { id: 'claude', label: 'claude', command: 'claude', injection: 'hook' },
  { id: 'codex', label: 'codex', command: 'codex', injection: 'hook' },
  { id: 'gemini', label: 'gemini', command: 'gemini', injection: 'hook' },
  { id: 'qwen', label: 'qwen', command: 'qwen', injection: 'hook' },
  { id: 'cursor', label: 'cursor', command: 'cursor-agent', injection: 'hook' },
  { id: 'aider', label: 'aider', command: 'aider --read $env:FOCUS_DOC', injection: 'flag' },
  {
    id: 'goose',
    label: 'goose',
    command:
      'goose run --interactive --system "$((powershell -NoProfile -ExecutionPolicy Bypass -File \\"$env:USERPROFILE/.iris/focus-context.ps1\\") -join \\"`n\\")"',
    injection: 'flag',
  },
  { id: 'shell', label: '终端', command: '', injection: 'none' },
];

function AgentsPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const settings = useSettings();
  const agents = settings?.agents ?? [];
  const [inj, setInj] = useState<InjectionState | null>(null);
  const [confirmCli, setConfirmCli] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshInj = async (): Promise<void> => {
    try {
      setInj(await window.api.invoke<undefined, InjectionState>(CHANNELS.AGENT_INJECTION_STATE));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void refreshInj();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeAgents = (next: AgentConfig[]): void => {
    void updateSettings({ agents: next } as DeepPartial<Settings>, setError);
  };
  const patchAgent = (id: string, patch: Partial<AgentConfig>): void => {
    writeAgents(agents.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const installScript = async (): Promise<void> => {
    setBusy(true);
    try {
      await pipeline.dispatch('agent.install-focus-script', {});
      await refreshInj();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const installCliHook = async (cliId: string): Promise<void> => {
    setBusy(true);
    setConfirmCli(null);
    try {
      // The hook calls the script — make sure the script exists first.
      if (inj && !inj.script.exists) {
        await pipeline.dispatch('agent.install-focus-script', {});
      }
      await pipeline.dispatch('agent.install-hook', { cliId });
      await refreshInj();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const presets = AGENT_PRESETS.filter((p) => !agents.some((a) => a.id === p.id));

  return (
    <section>
      <PanelTitle>Agents</PanelTitle>
      <p className="mb-3 text-xs text-muted-foreground">
        右键菜单「用 X 打开」的候选列表。command 为空表示纯终端；注入通道只是标注——hook
        在下方的注入区配置，flag 直接写在命令里。
      </p>

      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-[13px]">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-20 px-3 py-1.5 font-medium">id</th>
              <th className="w-28 px-3 py-1.5 font-medium">显示名</th>
              <th className="px-3 py-1.5 font-medium">命令</th>
              <th className="w-36 px-3 py-1.5 font-medium">注入通道</th>
              <th className="w-8 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-t border-subtle align-middle">
                <td className="px-3 py-1.5 font-mono text-xs">{a.id}</td>
                <td className="px-2 py-1">
                  <CommitInput value={a.label} onCommit={(v) => patchAgent(a.id, { label: v })} />
                </td>
                <td className="px-2 py-1">
                  <CommitInput
                    value={a.command}
                    placeholder="（纯终端）"
                    onCommit={(v) => patchAgent(a.id, { command: v })}
                  />
                </td>
                <td className="px-2 py-1">
                  <Segmented
                    value={a.injection ?? 'none'}
                    options={[
                      { value: 'hook', label: 'hook' },
                      { value: 'flag', label: 'flag' },
                      { value: 'none', label: INJECTION_LABEL.none },
                    ]}
                    onChange={(v) => patchAgent(a.id, { injection: v })}
                  />
                </td>
                <td className="px-2 py-1">
                  <button
                    type="button"
                    title={agents.length <= 1 ? '至少保留一个 agent' : `移除 ${a.label}`}
                    disabled={agents.length <= 1}
                    onClick={() => writeAgents(agents.filter((x) => x.id !== a.id))}
                    className="rounded-sm p-1 text-muted-foreground/60 hover:bg-muted hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {presets.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">快速添加：</span>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.command || '（纯终端）'}
              onClick={() => writeAgents([...agents, p])}
              className="rounded border border-subtle px-1.5 py-0.5 text-xs text-muted-foreground hover:border-border hover:text-foreground"
            >
              + {p.label}
            </button>
          ))}
        </div>
      )}

      <h3 className="mb-1 mt-8 text-base font-semibold">上下文注入</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        零轮次注入：终端打开时 agent 的 SessionStart hook 调用 focus-context 脚本，把
        FOCUS_DOC 指向的文档（元数据 + 全文快照，超 32 KiB 退化为指针）直接放进上下文——agent
        依然静止等待指令，打开 ≠ 开跑。hook 配置住在你自己的 agent 配置文件里，Iris
        只检测、建议、经你确认后代写。
      </p>

      <SettingRow
        label="focus-context 脚本"
        hint={inj ? inj.script.path : '~/.iris/focus-context.ps1'}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-xs',
              inj?.script.exists
                ? 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]'
                : 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]',
            )}
          >
            {inj?.script.exists ? '已安装' : '未安装'}
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void installScript()}>
            {inj?.script.exists ? '更新脚本' : '安装脚本'}
          </Button>
        </div>
      </SettingRow>

      <SettingRow label="hook 命令" hint="五家 CLI 的 SessionStart hook 都指向这一条命令">
        <code className="block break-all rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {inj?.script.hookCommand ?? '…'}
        </code>
      </SettingRow>

      {(inj?.clis ?? []).map((cli) => (
        <SettingRow key={cli.id} label={cli.label} hint={cli.configPath}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded px-1.5 py-0.5 text-xs', HOOK_STATE_META[cli.state].cls)}>
              {HOOK_STATE_META[cli.state].label}
            </span>
            {cli.state === 'not-configured' &&
              (confirmCli === cli.id ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    将写入你的 {cli.label} 配置（先备份 .bak）：
                  </span>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void installCliHook(cli.id)}
                  >
                    确认代写
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmCli(null)}>
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmCli(cli.id)}
                >
                  代写 hook…
                </Button>
              ))}
            {cli.detail && cli.state === 'manual-only' && (
              <span className="max-w-md text-xs leading-snug text-muted-foreground">
                {cli.detail}
              </span>
            )}
          </div>
        </SettingRow>
      ))}

      <p className="mt-3 text-xs text-muted-foreground/70">
        没有 hook 的 CLI 用启动 flag（上方 aider / goose 预设即模板）；两者皆无的 agent
        降级回 AGENTS.md 引导——协议本来就允许。
      </p>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 高级
// ──────────────────────────────────────────────────────────────────

function AdvancedPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const settings = useSettings();

  return (
    <section>
      <PanelTitle>高级</PanelTitle>

      <SettingRow
        label="会话空闲阈值（秒）"
        hint="终端无输出超过该时长 → 状态点从 ● 工作中 变为 ◐ 等待"
      >
        <NumberCommitInput
          value={settings?.advanced.activeIdleThresholdSeconds ?? 2}
          min={0.1}
          max={60}
          step={0.1}
          onCommit={(v) =>
            void updateSettings({ advanced: { activeIdleThresholdSeconds: v } }, setError)
          }
        />
      </SettingRow>

      <SettingRow label="退出确认" hint="关闭窗口时若仍有运行中的会话（含工作中的 agent），先弹确认">
        <ToggleSwitch
          checked={settings?.behavior.confirmOnQuit ?? true}
          onChange={(v) => void updateSettings({ behavior: { confirmOnQuit: v } }, setError)}
        />
      </SettingRow>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 关于
// ──────────────────────────────────────────────────────────────────

function AboutPanel(): JSX.Element {
  return (
    <section>
      <PanelTitle>关于</PanelTitle>

      <SettingRow label="Iris" hint="AI 原生 · 文档中心 · 终端驱动的项目管理">
        <Placeholder>占位 — 版本号 / 构建形态（dev · portable · installed）/ 数据目录待接 IPC。</Placeholder>
      </SettingRow>

      <SettingRow label="协议" hint=".iris/ 目录约定 + CONVENTIONS.md">
        <span className="text-[13px] text-muted-foreground">protocol: 1</span>
      </SettingRow>

      <SettingRow label="License">
        <span className="text-[13px] text-muted-foreground">AGPL-3.0</span>
      </SettingRow>
    </section>
  );
}
