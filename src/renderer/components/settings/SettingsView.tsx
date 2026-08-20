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
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  FolderCog,
  FolderOpen,
  Info,
  KeyRound,
  Moon,
  MoonStar,
  Palette,
  Plus,
  ScrollText,
  RefreshCw,
  SquareTerminal,
  Sun,
  Trash2,
  Unlink,
  Wrench,
  X,
} from 'lucide-react';
import {
  AGENT_PRESETS,
  type AppExternalLinkId,
  type AppInfo,
  type AppLegalDocumentId,
  type AgentConfig,
  type DeepPartial,
  type HookCliInfo,
  type InjectionState,
  type IrisAgentProviderCatalog,
  type ProjectPromptStateUi,
  type ProjectCommandTerminal,
  type ProjectToolbarAction,
  type Settings,
  type SoftwareBlockStateUi,
  type SoftwarePromptState,
  type ThemeId,
  type LocalePreference,
} from '@shared/types';
import { CHANNELS, EVENTS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { useSettings } from '@renderer/stores/settings-store';
import { useProject } from '@renderer/stores/project-store';
import { editorStore } from '@renderer/stores/editor-store';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { cn } from '@renderer/lib/utils';
import { confirmDialog } from '@renderer/components/ui/confirm-dialog';
import { IrisMark } from '@renderer/components/layout/IrisMark';
import { writeClipboardText } from '@renderer/lib/clipboard';
import { runUserAction } from '@renderer/lib/action-runtime';
import { translate } from '@renderer/i18n';
import {
  APP_BUILD_TYPE_KEYS,
  appDiagnostics,
  formatAppPlatform,
} from '@renderer/lib/app-info';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu';
import {
  LUCIDE_ICON_NAMES,
  LucideDynamicIcon,
  isLucideIconName,
} from '@renderer/components/ui/lucide-dynamic-icon';
import {
  projectSettingsStore,
  useProjectSettings,
} from '@renderer/stores/project-settings-store';

// ──────────────────────────────────────────────────────────────────
// Open/close state — module-level store, same pattern as CreateDocDialog.
// ──────────────────────────────────────────────────────────────────

export type SettingsCategoryId =
  | 'appearance'
  | 'terminal'
  | 'iris-agent'
  | 'agents'
  | 'project'
  | 'prompts'
  | 'advanced'
  | 'about';

let open = false;
let activeCategory: SettingsCategoryId = 'appearance';
const subs = new Set<() => void>();

export function openSettingsView(category: SettingsCategoryId = activeCategory): void {
  // Opening settings unmounts the editor. A conflict or write failure keeps
  // the current document visible so its draft can be resolved.
  void runUserAction(
    { title: translate('errors.settingsOpenFailed'), dedupeKey: 'settings:open' },
    async () => {
      const ready = await editorStore.flushBeforeSwitch('view-switch');
      if (!ready) return;
      activeCategory = category;
      open = true;
      subs.forEach((cb) => cb());
    },
  );
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

const CATEGORIES: Array<{ id: SettingsCategoryId; icon: typeof Palette; labelKey: 'settings.appearance' | 'settings.terminal' | 'settings.irisAgent' | 'settings.agents' | 'projectSettings.title' | 'settings.prompts' | 'settings.advanced' | 'settings.about' }> = [
  { id: 'appearance', icon: Palette, labelKey: 'settings.appearance' },
  { id: 'terminal', icon: SquareTerminal, labelKey: 'settings.terminal' },
  { id: 'iris-agent', icon: KeyRound, labelKey: 'settings.irisAgent' },
  { id: 'agents', icon: Bot, labelKey: 'settings.agents' },
  { id: 'project', icon: FolderCog, labelKey: 'projectSettings.title' },
  { id: 'prompts', icon: ScrollText, labelKey: 'settings.prompts' },
  { id: 'advanced', icon: Wrench, labelKey: 'settings.advanced' },
  { id: 'about', icon: Info, labelKey: 'settings.about' },
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
  const { t } = useTranslation();
  const active = useSyncExternalStore(
    (subscriber) => {
      subs.add(subscriber);
      return () => subs.delete(subscriber);
    },
    () => activeCategory,
  );
  const setActive = (category: SettingsCategoryId): void => {
    activeCategory = category;
    subs.forEach((subscriber) => subscriber());
  };
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
        <h1 className="text-sm font-semibold">{t('settings.title')}</h1>
        {errorMsg && (
          <span role="alert" className="truncate text-xs text-destructive">
            {errorMsg}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          title={t('settings.close')}
          onClick={closeSettingsView}
        >
          <X />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 space-y-1 overflow-y-auto border-r border-subtle p-3" aria-label={t('settings.categories')}>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActive(c.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                active === c.id
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <c.icon className="h-4 w-4 shrink-0" />
              {t(c.labelKey)}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
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
  categoryId: SettingsCategoryId;
  setError: (msg: string | null) => void;
}): JSX.Element {
  switch (categoryId) {
    case 'appearance':
      return <AppearancePanel setError={setError} />;
    case 'terminal':
      return <TerminalPanel setError={setError} />;
    case 'iris-agent':
      return <IrisAgentSettingsPanel setError={setError} />;
    case 'agents':
      return <AgentsPanel setError={setError} />;
    case 'project':
      return <ProjectSettingsPanel setError={setError} />;
    case 'prompts':
      return <PromptsPanel setError={setError} />;
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
    <div className="flex items-start gap-6 px-4 py-4">
      <div className="w-52 shrink-0">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function PanelTitle({
  children,
  description,
}: {
  children: ReactNode;
  description?: string;
}): JSX.Element {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold">{children}</h2>
      {description && (
        <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

/** Dummy marker for sections other agents will fill in. */
function Placeholder({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-md border border-subtle px-3 py-2.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Card container for a group of SettingRow items. */
function SettingGroup({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-5">
      {title && (
        <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">{title}</h3>
      )}
      <div className="divide-y divide-subtle overflow-hidden rounded-lg border bg-card/50">
        {children}
      </div>
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

const THEMES: Array<{ id: ThemeId; label: string; icon: typeof Moon; toneKey: 'settings.darkDefault' | 'settings.dark' | 'settings.light' | 'settings.darkKawaii' | 'settings.lightKawaii' }> = [
  { id: 'rose-pine', label: 'Rosé Pine', icon: Moon, toneKey: 'settings.darkDefault' },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', icon: Sun, toneKey: 'settings.light' },
  { id: 'rose-pine-moon', label: 'Rosé Pine Moon', icon: MoonStar, toneKey: 'settings.dark' },
  { id: 'cutie', label: 'Cutie', icon: Sun, toneKey: 'settings.lightKawaii' },
  { id: 'light-pink', label: 'Light Pink', icon: Sun, toneKey: 'settings.lightKawaii' },
  { id: 'fairyfloss', label: 'Fairyfloss', icon: Moon, toneKey: 'settings.darkKawaii' },
  { id: 'business', label: 'Business', icon: Moon, toneKey: 'settings.dark' },
  { id: 'ubuntu', label: 'Ubuntu', icon: Moon, toneKey: 'settings.dark' },
  { id: 'windows-terminal', label: 'Windows Terminal', icon: Moon, toneKey: 'settings.dark' },
  { id: 'one-dark-pro', label: 'One Dark Pro', icon: Moon, toneKey: 'settings.dark' },
  { id: 'dracula', label: 'Dracula', icon: Moon, toneKey: 'settings.dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', icon: Moon, toneKey: 'settings.dark' },
  { id: 'tokyo-night-day', label: 'Tokyo Night Day', icon: Sun, toneKey: 'settings.light' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', icon: Moon, toneKey: 'settings.dark' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', icon: Sun, toneKey: 'settings.light' },
];

// Hardcoded hex values for inactive-theme color previews (CSS vars only resolve
// for the active theme). Sourced from global.css [data-theme] blocks.
// Order: [base, surface, accent, info, secondary-accent]
const THEME_COLORS: Record<ThemeId, [string, string, string, string, string]> = {
  'rose-pine':        ['#191724', '#1f1d2e', '#c4a7e7', '#9ccfd8', '#ebbcba'],
  'rose-pine-dawn':   ['#faf4ed', '#fffaf3', '#907aa9', '#56949f', '#d7827e'],
  'rose-pine-moon':   ['#232136', '#2a273f', '#c4a7e7', '#9ccfd8', '#ea9a97'],
  'cutie':            ['#fff8fb', '#ffeef4', '#c558a0', '#b89cd9', '#ff7aa8'],
  'light-pink':       ['#f5f5f5', '#f5f0f3', '#ff7ab3', '#1f6e89', '#9466aa'],
  'fairyfloss':       ['#5a5475', '#464258', '#c5a3ff', '#9673d3', '#ffb8d1'],
  'business':         ['#1d2733', '#232e3c', '#81a1c1', '#88c0d0', '#d08770'],
  'ubuntu':           ['#300a24', '#3d1130', '#dd4814', '#34e2e2', '#ad7fa8'],
  'windows-terminal': ['#0c0c0c', '#1e1e1e', '#3b78ff', '#61d6d6', '#b4009e'],
  'one-dark-pro':     ['#282c34', '#21252b', '#c678dd', '#56b6c2', '#d19a66'],
  'dracula':          ['#282a36', '#1e1f29', '#bd93f9', '#8be9fd', '#ffb86c'],
  'tokyo-night':      ['#1a1b26', '#16161e', '#bb9af7', '#7dcfff', '#ff9e64'],
  'tokyo-night-day':  ['#e1e2e7', '#d0d5e3', '#9854f1', '#007197', '#b15c00'],
  'catppuccin-mocha': ['#1e1e2e', '#181825', '#cba6f7', '#94e2d5', '#fab387'],
  'catppuccin-latte': ['#eff1f5', '#e6e9ef', '#8839ef', '#179299', '#fe640b'],
};

function AppearancePanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();
  const theme = settings?.appearance.theme ?? 'rose-pine';

  return (
    <section>
      <PanelTitle description={t('settings.appearanceDescription')}>{t('settings.appearance')}</PanelTitle>

      <SettingGroup title={t('locale.label')}>
        <SettingRow label={t('locale.label')} hint={t('locale.hint')}>
          <Segmented
            value={settings?.locale ?? 'system'}
            options={[
              { value: 'system', label: t('locale.system') },
              { value: 'zh-CN', label: t('locale.zhCN') },
              { value: 'en-US', label: t('locale.enUS') },
            ]}
            onChange={(v) => void updateSettings({ locale: v as LocalePreference }, setError)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.themeGroup')}>
        <SettingRow label={t('settings.theme')} hint={t('settings.themeHint')}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {THEMES.map((themeOption) => (
              <button
                key={themeOption.id}
                type="button"
                onClick={() => void updateSettings({ appearance: { theme: themeOption.id } }, setError)}
                className={cn(
                  'flex min-w-0 flex-col items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  theme === themeOption.id
                    ? 'border-primary bg-accent ring-1 ring-primary/30'
                    : 'hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-1">
                  {THEME_COLORS[themeOption.id].map((color, i) => (
                    <span
                      key={i}
                      className="h-3 w-3 rounded-full border border-foreground/10"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
                <span className="flex items-center gap-1.5 text-[13px]">
                  <themeOption.icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {themeOption.label}
                </span>
                <span className="text-[11px] text-muted-foreground">{t(themeOption.toneKey)}</span>
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.fontsZoom')}>
        <SettingRow label={t('settings.uiFont')} hint={t('settings.uiFontHint')}>
          <CommitInput
            value={settings?.appearance.uiFontFamily ?? ''}
            placeholder="'LXGW WenKai', system-ui, sans-serif"
            onCommit={(v) => void updateSettings({ appearance: { uiFontFamily: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.uiZoom')} hint={t('settings.uiZoomHint')}>
          <NumberCommitInput
            value={settings?.appearance.uiZoom ?? 1.0}
            min={0.75}
            max={1.5}
            step={0.05}
            onCommit={(v) => void updateSettings({ appearance: { uiZoom: v } }, setError)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.editorGroup')}>
        <SettingRow label={t('settings.autosave')} hint={t('settings.autosaveHint')}>
          <ToggleSwitch
            checked={settings?.behavior.editorAutosave ?? true}
            onChange={(v) => void updateSettings({ behavior: { editorAutosave: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.autosaveDelay')} hint={t('settings.autosaveDelayHint')}>
          <NumberCommitInput
            value={settings?.behavior.editorAutosaveDelayMs ?? 1500}
            min={300}
            max={10000}
            step={100}
            onCommit={(v) =>
              void updateSettings({ behavior: { editorAutosaveDelayMs: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow label={t('settings.saveOnBlur')} hint={t('settings.saveOnBlurHint')}>
          <ToggleSwitch
            checked={settings?.behavior.editorSaveOnBlur ?? true}
            onChange={(v) => void updateSettings({ behavior: { editorSaveOnBlur: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.conflictPolicy')} hint={t('settings.conflictPolicyHint')}>
          <Segmented
            value={settings?.behavior.editorConflictPolicy ?? 'ask'}
            options={[
              { value: 'ask', label: t('settings.ask') },
              { value: 'overwrite', label: t('settings.overwrite') },
            ]}
            onChange={(v) =>
              void updateSettings({ behavior: { editorConflictPolicy: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow
          label={t('settings.blockEdit')}
          hint={t('settings.blockEditHint')}
        >
          <ToggleSwitch
            checked={settings?.behavior.editorBlockEdit ?? false}
            onChange={(v) => void updateSettings({ behavior: { editorBlockEdit: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.bodyAlign')} hint={t('settings.bodyAlignHint')}>
          <Segmented
            value={settings?.behavior.editorBodyAlign ?? 'center'}
            options={[
              { value: 'center', label: t('settings.center') },
              { value: 'left', label: t('settings.left') },
            ]}
            onChange={(v) => void updateSettings({ behavior: { editorBodyAlign: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.bodyWidth')} hint={t('settings.bodyWidthHint')}>
          <Segmented
            value={String(settings?.behavior.editorMaxWidth ?? 58)}
            options={[
              { value: '48', label: t('settings.narrow') },
              { value: '58', label: t('settings.medium') },
              { value: '72', label: t('settings.wide') },
            ]}
            onChange={(v) =>
              void updateSettings({ behavior: { editorMaxWidth: Number(v) } }, setError)
            }
          />
        </SettingRow>
      </SettingGroup>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 终端
// ──────────────────────────────────────────────────────────────────

function TerminalPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();

  return (
    <section>
      <PanelTitle description={t('settings.terminalDescription')}>{t('settings.terminal')}</PanelTitle>

      <SettingGroup title={t('settings.fonts')}>
        <SettingRow label={t('settings.terminalFont')} hint={t('settings.terminalFontHint')}>
          <CommitInput
            value={settings?.appearance.terminalFontFamily ?? ''}
            placeholder="'Cascadia Mono', Consolas, monospace"
            onCommit={(v) =>
              void updateSettings({ appearance: { terminalFontFamily: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow label={t('settings.terminalFontSize')}>
          <NumberCommitInput
            value={settings?.appearance.terminalFontSize ?? 13}
            min={8}
            max={24}
            step={1}
            onCommit={(v) => void updateSettings({ appearance: { terminalFontSize: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.terminalLineHeight')} hint={t('settings.terminalLineHeightHint')}>
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
      </SettingGroup>

      <SettingGroup title={t('settings.behavior')}>
        <SettingRow label={t('settings.selectToCopy')} hint={t('settings.selectToCopyHint')}>
          <ToggleSwitch
            checked={settings?.behavior.selectOnCopy ?? true}
            onChange={(v) => void updateSettings({ behavior: { selectOnCopy: v } }, setError)}
          />
        </SettingRow>

        <SettingRow label={t('settings.rightClick')} hint={t('settings.rightClickHint')}>
          <Segmented
            value={settings?.behavior.terminalRightClick ?? 'menu'}
            options={[
              { value: 'menu', label: t('settings.menu') },
              { value: 'paste', label: t('settings.directPaste') },
            ]}
            onChange={(v) =>
              void updateSettings({ behavior: { terminalRightClick: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow label={t('settings.docDrop')} hint={t('settings.docDropHint')}>
          <Segmented
            value={settings?.behavior.terminalDocDrop ?? 'content'}
            options={[
              { value: 'path', label: t('settings.path') },
              { value: 'content', label: t('settings.fullContent') },
            ]}
            onChange={(v) =>
              void updateSettings({ behavior: { terminalDocDrop: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow
          label={t('settings.renderer')}
          hint={t('settings.rendererHint')}
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
      </SettingGroup>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Agents — 核心手势"用 X 打开"的 X 列表 + 上下文注入适配层（round-3 A 条）。
// 协议层不变：壳只设 FOCUS_DOC。注入是适配器——focus-context 脚本（机器级，
// App 拥有）+ 各 agent CLI 自己配置里的 SessionStart hook（用户拥有，Iris
// 只检测、建议、经确认代写）。
// ──────────────────────────────────────────────────────────────────

const HOOK_STATE_META: Record<
  HookCliInfo['state'],
  { labelKey: 'settings.configured' | 'settings.stale' | 'settings.hookMissing' | 'settings.cliMissing'; cls: string }
> = {
  configured: { labelKey: 'settings.configured', cls: 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]' },
  stale: { labelKey: 'settings.stale', cls: 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]' },
  'not-configured': { labelKey: 'settings.hookMissing', cls: 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]' },
  'cli-not-found': { labelKey: 'settings.cliMissing', cls: 'bg-muted text-muted-foreground' },
};

function uniqueAgentId(preferred: string, agents: readonly AgentConfig[]): string {
  const base = preferred
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
  const ids = new Set(agents.map((agent) => agent.id));
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function IrisAgentSettingsPanel({
  setError,
}: {
  setError: (message: string | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();
  const [catalog, setCatalog] = useState<IrisAgentProviderCatalog | null>(null);
  const [templateId, setTemplateId] = useState('openai');
  const [profileName, setProfileName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const next = await window.api.invoke<undefined, IrisAgentProviderCatalog>(
        CHANNELS.IRIS_AGENT_PROVIDERS,
      );
      setCatalog(next);
      setError(next.error ?? null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refresh();
    return window.api.on(EVENTS.IRIS_AGENT_PROVIDERS_CHANGED, () => void refresh());
    // The provider projection is machine-level and refreshes only on explicit events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const templates = catalog?.templates ?? [];
  const profiles = catalog?.profiles ?? [];
  const selectedTemplate = templates.find((template) => template.id === templateId);

  useEffect(() => {
    if (templates.length === 0 || selectedTemplate) return;
    const fallback = templates[0]!;
    setTemplateId(fallback.id);
    setBaseUrl(fallback.defaultBaseUrl);
  }, [templates, selectedTemplate]);

  const addProfile = async (): Promise<void> => {
    if (!selectedTemplate || !profileName.trim() || !apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.api.invoke<
        { name: string; templateId: string; baseUrl: string; apiKey: string },
        IrisAgentProviderCatalog
      >(CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_ADD, {
        name: profileName,
        templateId,
        baseUrl,
        apiKey,
      });
      setCatalog(next);
      setError(next.error ?? null);
      setProfileName('');
      setApiKey('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = async (profileId: string, name: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: t('settings.removeProviderProfile'),
      message: t('settings.removeProviderProfileConfirm', { profile: name }),
      confirmText: t('settings.removeCredential'),
      tone: 'destructive',
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.api.invoke<
        { profileId: string },
        IrisAgentProviderCatalog
      >(CHANNELS.IRIS_AGENT_PROVIDER_PROFILE_REMOVE, { profileId });
      setCatalog(next);
      setError(next.error ?? null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <PanelTitle description={t('settings.irisAgentDescription')}>
        {t('settings.irisAgent')}
      </PanelTitle>

      <SettingGroup title={t('settings.experimentalFeatures')}>
        <SettingRow
          label={t('settings.enableIrisAgent')}
          hint={t('settings.enableIrisAgentHint')}
        >
          <ToggleSwitch
            checked={settings?.experimental.irisAgent ?? false}
            onChange={(value) =>
              void updateSettings({ experimental: { irisAgent: value } }, setError)
            }
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.addProviderProfile')}>
        <SettingRow label={t('settings.providerTemplate')} hint={t('settings.providerTemplateHint')}>
          <select
            value={templateId}
            disabled={busy || templates.length === 0}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            onChange={(event) => {
              const nextId = event.target.value;
              const nextTemplate = templates.find((template) => template.id === nextId);
              setTemplateId(nextId);
              setBaseUrl(nextTemplate?.defaultBaseUrl ?? '');
              setApiKey('');
            }}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t('settings.providerProfileName')} hint={t('settings.providerProfileNameHint')}>
          <Input
            value={profileName}
            disabled={busy || !selectedTemplate}
            spellCheck={false}
            placeholder={t('settings.providerProfileNamePlaceholder')}
            onChange={(event) => setProfileName(event.target.value)}
          />
        </SettingRow>
        <SettingRow label={t('settings.baseUrl')} hint={t('settings.baseUrlHint')}>
          <Input
            value={baseUrl}
            disabled={busy || !selectedTemplate}
            type="url"
            spellCheck={false}
            placeholder={t('settings.baseUrlPlaceholder')}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </SettingRow>
        <SettingRow label={t('settings.apiKey')} hint={t('settings.apiKeyHint')}>
          <div className="flex min-w-0 gap-2">
            <Input
              type="password"
              value={apiKey}
              disabled={busy || !selectedTemplate}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={t('settings.apiKeyPlaceholder')}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addProfile().catch(() => undefined);
                }
              }}
            />
            <Button
              type="button"
              className="shrink-0"
              disabled={busy
                || !selectedTemplate
                || !profileName.trim()
                || (!baseUrl.trim() && !selectedTemplate.defaultBaseUrl)
                || !apiKey.trim()}
              onClick={() => addProfile().catch(() => undefined)}
            >
              <Plus className="!size-4" />
              {t('settings.addProvider')}
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.configuredProviderProfiles')}>
        {catalog === null ? (
          <div className="px-4 py-4 text-xs text-muted-foreground">
            {t('settings.loadingProviders')}
          </div>
        ) : profiles.length === 0 ? (
          <div className="px-4 py-4 text-xs text-muted-foreground">
            {t('settings.noConfiguredProviderProfiles')}
          </div>
        ) : profiles.map((profile) => {
          const template = templates.find((candidate) => candidate.id === profile.templateId);
          const resolvedBaseUrl = profile.baseUrl || template?.defaultBaseUrl || '';
          return (
            <SettingRow
              key={profile.id}
              label={profile.name}
              hint={[template?.name, resolvedBaseUrl].filter(Boolean).join(' · ')}
            >
              <div className="flex h-8 items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">••••••••</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  title={t('settings.removeProviderProfile')}
                  aria-label={t('settings.removeProviderProfile')}
                  onClick={() => {
                    removeProfile(profile.id, profile.name).catch(() => undefined);
                  }}
                >
                  <Trash2 className="!size-3.5" />
                </Button>
              </div>
            </SettingRow>
          );
        })}
      </SettingGroup>
    </section>
  );
}

function AgentsPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();
  const agents = settings?.agents ?? [];
  const [inj, setInj] = useState<InjectionState | null>(null);
  const [confirmCli, setConfirmCli] = useState<string | null>(null);
  const [confirmRemoveCli, setConfirmRemoveCli] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCommand, setNewCommand] = useState('');

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
  const addPreset = (preset: AgentConfig): void => {
    writeAgents([...agents, { ...preset, id: uniqueAgentId(preset.id, agents) }]);
  };
  const addCustom = (): void => {
    const label = newLabel.trim();
    if (!label) return;
    const next: AgentConfig = {
      id: uniqueAgentId(label, agents),
      label,
      command: newCommand.trim(),
    };
    writeAgents([...agents, next]);
    setNewLabel('');
    setNewCommand('');
  };
  const moveAgent = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= agents.length) return;
    const next = [...agents];
    const current = next[index];
    const destination = next[target];
    if (!current || !destination) return;
    next[index] = destination;
    next[target] = current;
    writeAgents(next);
  };
  const duplicateAgent = (agent: AgentConfig): void => {
    writeAgents([
      ...agents,
      {
        ...agent,
        id: uniqueAgentId(agent.id, agents),
        label: t('settings.launcherCopyName', { name: agent.label }),
      },
    ]);
  };

  const installCliHook = async (cliId: string): Promise<void> => {
    setBusy(true);
    setConfirmCli(null);
    setConfirmRemoveCli(null);
    try {
      // The hook calls the script — make sure the script exists first.
      if (inj && inj.script.state !== 'current') {
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

  const removeCliHook = async (cliId: string): Promise<void> => {
    setBusy(true);
    setConfirmCli(null);
    setConfirmRemoveCli(null);
    try {
      await pipeline.dispatch('agent.remove-hook', { cliId });
      await refreshInj();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <PanelTitle description={t('settings.agentsDescription')}>{t('settings.agents')}</PanelTitle>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('settings.agentsIntro')}
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-[13px]">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-28 px-3 py-1.5 font-medium">{t('settings.displayName')}</th>
              <th className="px-3 py-1.5 font-medium">{t('settings.command')}</th>
              <th className="w-32 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {agents.map((a, index) => (
              <tr key={a.id} className="border-t border-subtle align-middle">
                <td className="px-2 py-1">
                  <CommitInput value={a.label} onCommit={(v) => patchAgent(a.id, { label: v })} />
                </td>
                <td className="px-2 py-1">
                  <CommitInput
                    value={a.command}
                    placeholder={t('settings.plainTerminal')}
                    onCommit={(v) => patchAgent(a.id, { command: v })}
                  />
                </td>
                <td className="px-2 py-1">
                  <div className="flex justify-end gap-0.5">
                    <button
                      type="button"
                      title={t('settings.moveLauncherUp', { agent: a.label })}
                      disabled={index === 0}
                      onClick={() => moveAgent(index, -1)}
                      className="rounded-sm p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground disabled:opacity-20"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t('settings.moveLauncherDown', { agent: a.label })}
                      disabled={index === agents.length - 1}
                      onClick={() => moveAgent(index, 1)}
                      className="rounded-sm p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground disabled:opacity-20"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t('settings.duplicateLauncher', { agent: a.label })}
                      onClick={() => duplicateAgent(a)}
                      className="rounded-sm p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={agents.length <= 1 ? t('settings.keepAgent') : t('settings.removeAgent', { agent: a.label })}
                      disabled={agents.length <= 1}
                      onClick={() => writeAgents(agents.filter((x) => x.id !== a.id))}
                      className="rounded-sm p-1 text-muted-foreground/60 hover:bg-muted hover:text-destructive disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={() => setShowAdd((value) => !value)}>
          <Plus />
          {t('settings.addLauncher')}
        </Button>
      </div>

      {showAdd && (
        <div className="mt-3 border-l-2 border-subtle pl-4">
          <div className="text-xs font-medium text-muted-foreground">
            {t('settings.launcherPresets')}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {AGENT_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant="secondary"
                title={preset.command || t('settings.plainTerminal')}
                onClick={() => addPreset(preset)}
              >
                <Plus />
                {preset.label}
              </Button>
            ))}
          </div>

          <div className="mt-4 text-xs font-medium text-muted-foreground">
            {t('settings.customLauncher')}
          </div>
          <div className="mt-2 grid grid-cols-[minmax(7rem,0.6fr)_minmax(12rem,1.4fr)] gap-2">
            <Input
              value={newLabel}
              placeholder={t('settings.launcherNamePlaceholder')}
              aria-label={t('settings.displayName')}
              onChange={(event) => setNewLabel(event.target.value)}
            />
            <Input
              value={newCommand}
              placeholder={t('settings.launcherCommandPlaceholder')}
              aria-label={t('settings.command')}
              onChange={(event) => setNewCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addCustom();
              }}
            />
          </div>
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={!newLabel.trim()} onClick={addCustom}>
              <Plus />
              {t('settings.addCustomLauncher')}
            </Button>
          </div>
        </div>
      )}

      <div className="mb-5 mt-8">
        <h3 className="text-base font-semibold">{t('settings.contextInjection')}</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t('settings.contextIntro')}
        </p>
      </div>

      {inj && inj.script.state !== 'current' && (
        <div className="mb-3 border-l-2 border-[var(--rp-gold)] pl-3 text-xs text-muted-foreground">
          <div className="text-[var(--rp-gold)]">
            {inj.script.state === 'stale'
              ? t('settings.staleSyncFailed')
              : t('settings.missingSyncFailed')}
          </div>
          <div className="mt-0.5 break-all">{inj.script.path}</div>
        </div>
      )}

      <SettingGroup>
        {(inj?.clis ?? []).map((cli) => (
          <SettingRow key={cli.id} label={cli.label} hint={cli.configPath}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('rounded px-1.5 py-0.5 text-xs', HOOK_STATE_META[cli.state].cls)}>
                {t(HOOK_STATE_META[cli.state].labelKey)}
              </span>
              {(cli.state === 'not-configured' || cli.state === 'stale') &&
                (confirmCli === cli.id ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {t('settings.writeCliConfig', {
                        action: cli.state === 'stale' ? t('settings.updateAction') : t('settings.writeAction'),
                        cli: cli.label,
                      })}
                    </span>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void installCliHook(cli.id)}
                    >
                      {t('settings.confirmWrite')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmCli(null)}>
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setConfirmRemoveCli(null);
                      setConfirmCli(cli.id);
                    }}
                  >
                    {cli.state === 'stale' ? t('settings.updateHook') : t('settings.writeHook')}
                  </Button>
                ))}
              {(cli.state === 'configured' || cli.state === 'stale') &&
                (confirmRemoveCli === cli.id ? (
                  <>
                    <span className="text-xs text-muted-foreground">
                      {t('settings.removeHookConfirm', { cli: cli.label })}
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void removeCliHook(cli.id)}
                    >
                      <Trash2 />
                      {t('settings.confirmRemoveHook')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveCli(null)}>
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => {
                      setConfirmCli(null);
                      setConfirmRemoveCli(cli.id);
                    }}
                  >
                    <Trash2 />
                    {t('settings.removeHook')}
                  </Button>
                ))}
              {cli.detail && cli.id === 'codex' && (
                <span className="max-w-md text-xs leading-snug text-muted-foreground">
                  {cli.detail}
                </span>
              )}
            </div>
          </SettingRow>
        ))}
      </SettingGroup>

      <p className="mt-3 text-xs text-muted-foreground/70">
        {t('settings.noHookFallback')}
      </p>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Project settings — project-owned toolbar commands in .iris/settings.json.
// ──────────────────────────────────────────────────────────────────

function IconNameInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);
  const matches = useMemo(() => {
    const needle = draft.trim().toLowerCase();
    if (!needle) return LUCIDE_ICON_NAMES.slice(0, 8);
    return LUCIDE_ICON_NAMES.filter((name) => name.includes(needle)).slice(0, 8);
  }, [draft]);

  const commit = (name: string): void => {
    setDraft(name);
    if (name !== value && isLucideIconName(name)) onCommit(name);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-subtle">
          <LucideDynamicIcon name={draft} className="h-4 w-4" />
        </span>
        <Input
          value={draft}
          aria-label={t('projectSettings.icon')}
          aria-invalid={draft.length > 0 && !isLucideIconName(draft)}
          placeholder="rocket"
          onFocus={() => setFocused(true)}
          onChange={(event) => setDraft(event.target.value.toLowerCase())}
          onBlur={() => {
            setFocused(false);
            if (isLucideIconName(draft)) commit(draft);
            else setDraft(value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft(value);
              event.currentTarget.blur();
              event.stopPropagation();
            }
          }}
        />
      </div>
      {focused && matches.length > 0 && (
        <div className="absolute left-10 right-0 top-9 z-20 max-h-48 overflow-y-auto rounded-md border border-subtle bg-popover p-1 shadow-md">
          {matches.map((name) => (
            <button
              key={name}
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                commit(name);
                setFocused(false);
              }}
            >
              <LucideDynamicIcon name={name} className="h-4 w-4" />
              <span>{name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectSettingsPanel({
  setError,
}: {
  setError: (message: string | null) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { phase, scan } = useProject();
  const { snapshot, loading, error } = useProjectSettings();
  const projectOpen = phase === 'ready' && (scan?.hasIris ?? false);
  const actions = snapshot?.settings.toolbar.actions ?? [];
  const [newIcon, setNewIcon] = useState('rocket');
  const [newDescription, setNewDescription] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newTerminal, setNewTerminal] = useState<ProjectCommandTerminal>('iris');

  const writeActions = async (next: ProjectToolbarAction[]): Promise<boolean> => {
    if (!snapshot || snapshot.error) return false;
    setError(null);
    try {
      await pipeline.dispatch('project-settings.update-toolbar', {
        actions: next,
        expectedRevision: snapshot.revision,
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const patchAction = (index: number, patch: Partial<ProjectToolbarAction>): void => {
    void writeActions(actions.map((action, i) => (i === index ? { ...action, ...patch } : action)));
  };
  const moveAction = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    const current = next[index];
    const other = next[target];
    if (!current || !other) return;
    next[index] = other;
    next[target] = current;
    void writeActions(next);
  };
  const addAction = (): void => {
    if (!isLucideIconName(newIcon) || !newDescription.trim() || !newCommand.trim()) return;
    void writeActions([
      ...actions,
      {
        icon: newIcon,
        description: newDescription.trim(),
        command: newCommand.trim(),
        terminal: newTerminal,
      },
    ]).then((saved) => {
      if (saved) {
        setNewDescription('');
        setNewCommand('');
      }
    });
  };

  if (!projectOpen) {
    return (
      <section>
        <PanelTitle description={t('projectSettings.description')}>
          {t('projectSettings.title')}
        </PanelTitle>
        <Placeholder>{t('projectSettings.needProject')}</Placeholder>
      </section>
    );
  }

  return (
    <section>
      <PanelTitle description={t('projectSettings.description')}>
        {t('projectSettings.title')}
      </PanelTitle>
      {(error || snapshot?.error) && (
        <div role="alert" className="mb-4 border-l-2 border-destructive pl-3 text-xs text-destructive">
          {error ?? snapshot?.error}
        </div>
      )}
      {snapshot && snapshot.diagnostics.length > 0 && (
        <div className="mb-4 border-l-2 border-[var(--rp-gold)] pl-3 text-xs text-muted-foreground">
          {snapshot.diagnostics.join('\n')}
        </div>
      )}
      {loading && !snapshot ? (
        <Placeholder>{t('common.loading')}</Placeholder>
      ) : (
        <SettingGroup title={t('projectSettings.toolbarActions')}>
          {actions.map((action, index) => (
            <div key={`${index}:${action.icon}:${action.description}`} className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <LucideDynamicIcon name={action.icon} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {action.description}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={index === 0}
                  title={t('projectSettings.moveUp', { description: action.description })}
                  onClick={() => moveAction(index, -1)}
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={index === actions.length - 1}
                  title={t('projectSettings.moveDown', { description: action.description })}
                  onClick={() => moveAction(index, 1)}
                >
                  <ChevronDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  title={t('projectSettings.remove', { description: action.description })}
                  onClick={() => void writeActions(actions.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  <span>{t('projectSettings.icon')}</span>
                  <IconNameInput
                    value={action.icon}
                    onCommit={(icon) => patchAction(index, { icon })}
                  />
                </label>
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  <span>{t('projectSettings.actionDescription')}</span>
                  <CommitInput
                    value={action.description}
                    onCommit={(description) => patchAction(index, { description })}
                  />
                </label>
                <label className="space-y-1 text-[11px] text-muted-foreground sm:col-span-2">
                  <span>{t('projectSettings.command')}</span>
                  <CommitInput
                    value={action.command}
                    onCommit={(command) => patchAction(index, { command })}
                  />
                </label>
              </div>
              <div className="mt-3">
                <Segmented
                  value={action.terminal}
                  options={[
                    { value: 'iris', label: t('projectSettings.irisTerminal') },
                    { value: 'system', label: t('projectSettings.systemTerminal') },
                  ]}
                  onChange={(terminal) => patchAction(index, { terminal })}
                />
              </div>
            </div>
          ))}
          {actions.length === 0 && (
            <div className="px-4 py-5 text-xs text-muted-foreground">
              {t('projectSettings.noActions')}
            </div>
          )}
          <div className="border-t border-subtle p-4">
            <div className="mb-3 text-[13px] font-medium">{t('projectSettings.addAction')}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <IconNameInput value={newIcon} onCommit={setNewIcon} />
              <Input
                value={newDescription}
                placeholder={t('projectSettings.descriptionPlaceholder')}
                aria-label={t('projectSettings.actionDescription')}
                onChange={(event) => setNewDescription(event.target.value)}
              />
              <Input
                value={newCommand}
                className="sm:col-span-2"
                placeholder={t('projectSettings.commandPlaceholder')}
                aria-label={t('projectSettings.command')}
                onChange={(event) => setNewCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addAction();
                }}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <Segmented
                value={newTerminal}
                options={[
                  { value: 'iris', label: t('projectSettings.irisTerminal') },
                  { value: 'system', label: t('projectSettings.systemTerminal') },
                ]}
                onChange={setNewTerminal}
              />
              <Button
                size="sm"
                disabled={
                  !!snapshot?.error ||
                  !isLucideIconName(newIcon) ||
                  !newDescription.trim() ||
                  !newCommand.trim()
                }
                onClick={addAction}
              >
                <Plus />
                {t('projectSettings.addAction')}
              </Button>
            </div>
          </div>
        </SettingGroup>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 软件提示词 — 分层注入治理（issue: iris软件提示词治理）。
// 软件层 = AGENTS.md / vendor 入口里的 <iris-software> 托管块（App 拥有）；
// 项目层 = 同一批入口里的 <iris-project> 锁相块（磁盘拥有，用户按需自定义）。
// 一切写入经此处确认。
// ──────────────────────────────────────────────────────────────────

const SW_STATE_META: Record<SoftwareBlockStateUi, { labelKey: string; cls: string }> = {
  ok: { labelKey: 'settings.stateOk', cls: 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]' },
  drifted: { labelKey: 'settings.stateDrifted', cls: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]' },
  missing: { labelKey: 'settings.stateMissing', cls: 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]' },
  duplicate: { labelKey: 'settings.stateDuplicate', cls: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]' },
  'write-failed': { labelKey: 'settings.stateWriteFailed', cls: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]' },
  'no-entry': { labelKey: 'settings.stateNoEntry', cls: 'bg-muted text-muted-foreground' },
};

const PROJECT_STATE_META: Record<ProjectPromptStateUi, { labelKey: string; cls: string }> = {
  synced: { labelKey: 'settings.projectSynced', cls: 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]' },
  conflict: { labelKey: 'settings.projectConflictState', cls: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]' },
  missing: { labelKey: 'settings.projectUnset', cls: 'bg-muted text-muted-foreground' },
  drifted: { labelKey: 'settings.projectDrifted', cls: 'bg-[var(--rp-gold)]/20 text-[var(--rp-gold)]' },
  partial: { labelKey: 'settings.projectPartial', cls: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]' },
  'invalid-settings': { labelKey: 'settings.projectInvalid', cls: 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]' },
};

/**
 * Collapsible read-only viewer for one prompt layer's text — the content behind
 * the freshness badges, so the user can actually READ what gets injected.
 * `body === null` renders the `empty` note instead of a code box.
 */
function PromptViewer({
  title,
  body,
  empty,
  note,
  defaultOpen = false,
}: {
  title: string;
  body: string | null;
  empty?: string;
  note?: string | undefined;
  defaultOpen?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const has = body !== null && body.trim() !== '';
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', open ? '' : '-rotate-90')} />
        {title}
      </button>
      {open && (
        <>
          {note && <div className="mt-1.5 text-[11px] text-[var(--rp-gold)]">{note}</div>}
          {has ? (
            <pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-subtle bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
              {body}
            </pre>
          ) : (
            <div className="mt-1.5 rounded-md border border-subtle px-3 py-2 text-[11px] text-muted-foreground">
              {empty ?? t('settings.emptyValue')}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PromptsPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const { phase, scan, scope } = useProject();
  const { snapshot: projectSettingsSnapshot } = useProjectSettings();
  const projectOpen = phase === 'ready' && (scan?.hasIris ?? false);
  const [state, setState] = useState<SoftwarePromptState | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectDraft, setProjectDraft] = useState('');
  const [projectDraftRevision, setProjectDraftRevision] = useState<string | null>(null);
  const [projectDraftDirty, setProjectDraftDirty] = useState(false);

  const refresh = async (): Promise<void> => {
    if (!scope) return;
    try {
      const next = await window.api.invoke<
        { expectedScope: typeof scope },
        SoftwarePromptState
      >(CHANNELS.SOFTWARE_PROMPT_STATE, { expectedScope: scope });
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    if (projectOpen) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectOpen, scope]);
  useEffect(() => {
    setProjectDraftDirty(false);
    setProjectDraftRevision(null);
  }, [scope?.root, scope?.generation]);
  useEffect(() => {
    if (!projectSettingsSnapshot || projectDraftDirty) return;
    setProjectDraft(projectSettingsSnapshot.settings.prompts.project);
    setProjectDraftRevision(projectSettingsSnapshot.revision);
  }, [projectSettingsSnapshot, projectDraftDirty]);
  useEffect(() => {
    if (!projectOpen) return;
    return window.api.on(EVENTS.PROMPT_CHANGED, () => void refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectOpen]);

  const run = async (verb: string, payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await pipeline.dispatch(verb, payload);
      await refresh(); // pull both status badges and the now-changed content
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveProjectPrompt = async (): Promise<void> => {
    if (projectDraftRevision === null || projectSettingsSnapshot?.error) return;
    const saved = await run('project-prompt.sync', {
      text: projectDraft,
      expectedRevision: projectDraftRevision,
    });
    if (!saved) return;
    const latest = projectSettingsStore.get().snapshot;
    setProjectDraftDirty(false);
    if (latest) {
      setProjectDraft(latest.settings.prompts.project);
      setProjectDraftRevision(latest.revision);
    }
  };

  const removeEntry = async (path: string): Promise<void> => {
    if (!projectSettingsSnapshot || projectDraftDirty) return;
    const confirmed = await confirmDialog({
      title: t('settings.stopSyncTitle'),
      message: t('settings.stopSyncMessage', { path }),
      confirmText: t('settings.stopSync'),
      tone: 'destructive',
    });
    if (!confirmed) return;
    await run('prompt.entry-remove', {
      path,
      expectedRevision: projectSettingsSnapshot.revision,
    });
  };

  const addEntry = async (path: string): Promise<void> => {
    if (!projectSettingsSnapshot || projectDraftDirty) return;
    await run('prompt.entry-add', {
      path,
      expectedRevision: projectSettingsSnapshot.revision,
    });
  };

  if (!projectOpen) {
    return (
      <section>
        <PanelTitle description={t('settings.promptsDescription')}>{t('settings.prompts')}</PanelTitle>
        <Placeholder>
          {t('settings.promptsNeedProject')}
        </Placeholder>
      </section>
    );
  }

  return (
    <section>
      <PanelTitle description={t('settings.promptsDescription')}>{t('settings.prompts')}</PanelTitle>
      <p className="mb-4 text-xs text-muted-foreground">
        {t('settings.promptsIntro')}
      </p>
      <SettingGroup title={t('settings.projectLayer')}>
        <SettingRow label={t('settings.projectInstructions')} hint={t('settings.projectHint')}>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-xs',
              PROJECT_STATE_META[state?.project.state ?? 'missing'].cls,
            )}
          >
            {t(PROJECT_STATE_META[state?.project.state ?? 'missing'].labelKey)}
          </span>
        </SettingRow>
      </SettingGroup>
      {state?.project.error && (
        <div role="alert" className="mt-3 border-l-2 border-destructive pl-3 text-xs text-destructive">
          {state.project.error}
        </div>
      )}
      {state?.project.state === 'conflict' && (
        <div className="mt-3 space-y-3 rounded-md border border-[var(--rp-love)]/40 bg-[var(--rp-love)]/5 p-3">
          <p className="text-xs text-[var(--rp-love)]">
            {t('settings.projectConflict')}
          </p>
          {state.project.conflicts.map((item) => (
            <div key={item.path}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <code className="text-xs">{item.path}</code>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setProjectDraft(item.text);
                    setProjectDraftDirty(true);
                  }}
                >
                  {t('settings.useVersion')}
                </Button>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-subtle bg-muted/30 px-2 py-1.5 font-mono text-[11px]">
                {item.text}
              </pre>
            </div>
          ))}
        </div>
      )}
      <textarea
        value={projectDraft}
        onChange={(event) => {
          setProjectDraft(event.target.value);
          setProjectDraftDirty(true);
        }}
        placeholder={t('settings.projectPlaceholder')}
        className="mt-3 min-h-48 w-full resize-y rounded-md border border-subtle bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-[var(--rp-iris)]"
      />
      {projectDraftDirty &&
        projectSettingsSnapshot &&
        projectDraftRevision !== projectSettingsSnapshot.revision && (
          <div role="alert" className="mt-2 flex items-center justify-between gap-3 border-l-2 border-[var(--rp-gold)] pl-3 text-xs text-muted-foreground">
            <span>{t('settings.projectDraftStale')}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setProjectDraft(projectSettingsSnapshot.settings.prompts.project);
                setProjectDraftRevision(projectSettingsSnapshot.revision);
                setProjectDraftDirty(false);
              }}
            >
              {t('settings.reloadLatest')}
            </Button>
          </div>
        )}
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          disabled={
            busy ||
            !projectDraftDirty ||
            projectDraftRevision === null ||
            !!projectSettingsSnapshot?.error ||
            projectDraftRevision !== projectSettingsSnapshot?.revision
          }
          onClick={() => void saveProjectPrompt()}
        >
          {t('settings.saveSync')}
        </Button>
      </div>

      <div className="mb-2 mt-8 flex items-center gap-3">
        <div>
          <h3 className="text-base font-semibold">{t('settings.participatingEntries')}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t('settings.participatingEntriesHint')}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={busy || !state || state.project.state === 'conflict' || state.project.state === 'invalid-settings'}
          onClick={() => void run('prompt.sync-all', {})}
        >
          <RefreshCw />
          {t('settings.resyncAll')}
        </Button>
      </div>

      <SettingGroup>
        {(state?.entries ?? []).map((softwareEntry) => {
          const projectEntry = state?.project.entries.find(
            (entry) => entry.path === softwareEntry.path,
          );
          const healthy = softwareEntry.state === 'ok' && projectEntry?.state === 'synced';
          return (
            <SettingRow
              key={softwareEntry.path}
              label={softwareEntry.path}
              hint={softwareEntry.isStandard ? t('settings.requiredEntry') : t('settings.participatingEntry')}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('rounded px-1.5 py-0.5 text-xs', SW_STATE_META[softwareEntry.state].cls)}>
                  {t('settings.softwareStatus', { status: t(SW_STATE_META[softwareEntry.state].labelKey) })}
                </span>
                {projectEntry && (
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-xs',
                    projectEntry.state === 'synced'
                      ? 'bg-[var(--rp-pine)]/20 text-[var(--rp-pine)]'
                      : 'bg-[var(--rp-love)]/20 text-[var(--rp-love)]',
                  )}>
                    {t('settings.projectStatus', { status: t(`settings.projectEntry.${projectEntry.state}`) })}
                  </span>
                )}
                {!healthy && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run('software-prompt.sync-entry', { path: softwareEntry.path })}
                  >
                    <RefreshCw />
                    {t('settings.resync')}
                  </Button>
                )}
                {!softwareEntry.isStandard && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto h-7 w-7 text-destructive"
                    title={t('settings.stopSync')}
                    disabled={busy || projectDraftDirty}
                    onClick={() => void removeEntry(softwareEntry.path)}
                  >
                    <Unlink />
                  </Button>
                )}
              </div>
            </SettingRow>
          );
        })}
        {(state?.availableEntries.length ?? 0) > 0 && (
          <div className="flex justify-end border-t border-subtle px-4 py-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={busy || projectDraftDirty}>
                  <Plus />
                  {t('settings.addEntry')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(state?.availableEntries ?? []).map((path) => (
                  <DropdownMenuItem key={path} onClick={() => void addEntry(path)}>
                    {path}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </SettingGroup>

      <PromptViewer
        title={t('settings.softwareBody')}
        body={state?.softwareText ?? null}
      />
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 高级
// ──────────────────────────────────────────────────────────────────

function AdvancedPanel({ setError }: { setError: (m: string | null) => void }): JSX.Element {
  const { t } = useTranslation();
  const settings = useSettings();

  return (
    <section>
      <PanelTitle description={t('settings.advancedDescription')}>{t('settings.advanced')}</PanelTitle>

      <SettingGroup>
        <SettingRow
          label={t('settings.restoreProjects')}
          hint={t('settings.restoreProjectsHint')}
        >
          <ToggleSwitch
            checked={settings?.behavior.restoreProjectsOnStartup ?? false}
            onChange={(v) =>
              void updateSettings({ behavior: { restoreProjectsOnStartup: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow
          label={t('settings.idleThreshold')}
          hint={t('settings.idleThresholdHint')}
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

        <SettingRow
          label={t('settings.autoCheckTodosOnDone')}
          hint={t('settings.autoCheckTodosOnDoneHint')}
        >
          <ToggleSwitch
            checked={settings?.behavior.autoCheckTodosOnDone ?? false}
            onChange={(v) =>
              void updateSettings({ behavior: { autoCheckTodosOnDone: v } }, setError)
            }
          />
        </SettingRow>

        <SettingRow label={t('settings.confirmQuit')} hint={t('settings.confirmQuitHint')}>
          <ToggleSwitch
            checked={settings?.behavior.confirmOnQuit ?? true}
            onChange={(v) => void updateSettings({ behavior: { confirmOnQuit: v } }, setError)}
          />
        </SettingRow>
      </SettingGroup>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// 关于
// ──────────────────────────────────────────────────────────────────

function AboutPanel(): JSX.Element {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [copied, setCopied] = useState<'data' | 'diagnostics' | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    window.api
      .invoke<undefined, AppInfo>(CHANNELS.APP_INFO)
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) {
          setInfo(null);
          setLoadError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const openLegalDocument = async (id: AppLegalDocumentId): Promise<void> => {
    setActionError(false);
    try {
      await window.api.invoke(CHANNELS.APP_OPEN_LEGAL_DOCUMENT, { id });
    } catch {
      setActionError(true);
    }
  };

  const openExternalLink = async (id: AppExternalLinkId): Promise<void> => {
    setActionError(false);
    try {
      await window.api.invoke(CHANNELS.APP_OPEN_EXTERNAL_LINK, { id });
    } catch {
      setActionError(true);
    }
  };

  const revealUserData = async (): Promise<void> => {
    setActionError(false);
    try {
      await window.api.invoke(CHANNELS.APP_REVEAL_USER_DATA);
    } catch {
      setActionError(true);
    }
  };

  const copyText = async (text: string, kind: 'data' | 'diagnostics'): Promise<void> => {
    setActionError(false);
    if (await writeClipboardText(text)) {
      setCopied(kind);
    } else {
      setActionError(true);
    }
  };

  return (
    <section>
      <PanelTitle>{t('settings.about')}</PanelTitle>

      <div className="mb-6 flex items-center gap-4 px-1 py-2">
        <IrisMark className="h-14 w-14 shrink-0" />
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{info?.name ?? 'Iris'}</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
            {t('settings.aboutDescription')}
          </p>
          {info && (
            <p className="mt-1 text-xs text-muted-foreground">
              v{info.version} · {t(APP_BUILD_TYPE_KEYS[info.buildType])}
            </p>
          )}
        </div>
      </div>

      {loadError && (
        <div role="alert" className="mb-5 flex items-center gap-3 border-l-2 border-destructive px-3 py-2 text-[13px] text-destructive">
          <span>{t('settings.aboutLoadError')}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            <RefreshCw />
            {t('settings.aboutRetry')}
          </Button>
        </div>
      )}

      {actionError && (
        <p role="alert" className="mb-4 text-[13px] text-destructive">
          {t('settings.aboutActionError')}
        </p>
      )}

      {loading && (
        <SettingGroup title={t('settings.aboutRuntime')}>
          <SettingRow label={t('settings.aboutVersion')}>
            <span className="text-[13px] text-muted-foreground">{t('settings.aboutLoading')}</span>
          </SettingRow>
        </SettingGroup>
      )}

      {info && !loading && (
        <>
          <SettingGroup title={t('settings.aboutRuntime')}>
            <SettingRow label={t('settings.aboutVersion')}>
              <span className="text-[13px] text-muted-foreground">v{info.version}</span>
            </SettingRow>

            <SettingRow label={t('settings.aboutBuildType')}>
              <span className="text-[13px] text-muted-foreground">
                {t(APP_BUILD_TYPE_KEYS[info.buildType])}
              </span>
            </SettingRow>

            <SettingRow label={t('settings.aboutPlatform')}>
              <span className="text-[13px] text-muted-foreground">
                {formatAppPlatform(info.platform, info.arch)}
              </span>
            </SettingRow>

            <SettingRow label={t('settings.aboutRuntimeVersions')}>
              <span className="text-[13px] leading-relaxed text-muted-foreground">
                Electron {info.electronVersion} · Chromium {info.chromiumVersion}
              </span>
            </SettingRow>

            <SettingRow label={t('settings.aboutDataDirectory')}>
              <div className="flex min-w-0 items-start gap-1">
                <code
                  className="min-w-0 flex-1 break-all pt-2 text-xs leading-relaxed text-muted-foreground"
                  title={info.userDataPath}
                >
                  {info.userDataPath}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title={copied === 'data' ? t('settings.aboutCopied') : t('settings.aboutCopyDataDirectory')}
                  aria-label={copied === 'data' ? t('settings.aboutCopied') : t('settings.aboutCopyDataDirectory')}
                  onClick={() => void copyText(info.userDataPath, 'data')}
                >
                  {copied === 'data' ? <Check /> : <Copy />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title={t('settings.aboutOpenDataDirectory')}
                  aria-label={t('settings.aboutOpenDataDirectory')}
                  onClick={() => void revealUserData()}
                >
                  <FolderOpen />
                </Button>
              </div>
            </SettingRow>
          </SettingGroup>

          <SettingGroup title={t('settings.aboutLegal')}>
            <SettingRow label={t('settings.aboutLicense')}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void openLegalDocument('license')}
              >
                <FileText />
                {info.license} License
              </Button>
            </SettingRow>

            <SettingRow label={t('settings.aboutThirdPartyNotices')}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void openLegalDocument('thirdPartyNotices')}
              >
                <FileText />
                {t('settings.aboutViewNotices')}
              </Button>
            </SettingRow>

            <SettingRow label={t('settings.aboutCopyright')}>
              <span className="text-[13px] text-muted-foreground">{info.copyright}</span>
            </SettingRow>
          </SettingGroup>

          <SettingGroup title={t('settings.aboutProjectLinks')}>
            <SettingRow label={t('settings.aboutProject')}>
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" size="sm" onClick={() => void openExternalLink('source')}>
                  <Code2 />
                  {t('settings.aboutSource')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void openExternalLink('releases')}>
                  <ExternalLink />
                  {t('settings.aboutReleases')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void openExternalLink('issues')}>
                  <ExternalLink />
                  {t('settings.aboutReportIssue')}
                </Button>
              </div>
            </SettingRow>
          </SettingGroup>

          <SettingGroup>
            <SettingRow
              label={t('settings.aboutDiagnostics')}
              hint={t('settings.aboutDiagnosticsHint')}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyText(appDiagnostics(info), 'diagnostics')}
              >
                {copied === 'diagnostics' ? <Check /> : <Copy />}
                {copied === 'diagnostics'
                  ? t('settings.aboutCopied')
                  : t('settings.aboutCopyDiagnostics')}
              </Button>
            </SettingRow>
          </SettingGroup>
        </>
      )}
    </section>
  );
}
