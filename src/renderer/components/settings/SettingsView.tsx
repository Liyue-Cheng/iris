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
import { Bot, Info, Moon, MoonStar, Palette, SquareTerminal, Sun, Wrench, X } from 'lucide-react';
import type { DeepPartial, Settings, ThemeId } from '@shared/types';
import { pipeline } from '@renderer/cpu';
import { useSettings } from '@renderer/stores/settings-store';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { cn } from '@renderer/lib/utils';

// ──────────────────────────────────────────────────────────────────
// Open/close state — module-level store, same pattern as CreateDocDialog.
// ──────────────────────────────────────────────────────────────────

let open = false;
const subs = new Set<() => void>();

export function openSettingsView(): void {
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

type CategoryId = 'appearance' | 'terminal' | 'agents' | 'advanced' | 'about';

const CATEGORIES: Array<{ id: CategoryId; icon: typeof Palette; label: string }> = [
  { id: 'appearance', icon: Palette, label: '外观' },
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
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
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
        <nav className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r p-2" aria-label="设置分类">
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
    case 'terminal':
      return <TerminalPanel setError={setError} />;
    case 'agents':
      return <AgentsPanel />;
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
    <div className="flex items-start gap-6 border-b border-border/40 py-3.5 last:border-b-0">
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
    <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
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
// Agents — 核心手势"用 X 打开"的 X 列表。编辑功能未接通，当前只读。
// ──────────────────────────────────────────────────────────────────

function AgentsPanel(): JSX.Element {
  const settings = useSettings();
  const agents = settings?.agents ?? [];

  return (
    <section>
      <PanelTitle>Agents</PanelTitle>
      <p className="mb-3 text-xs text-muted-foreground">
        右键菜单"用 X 打开"的候选列表。command 为空表示纯终端。
      </p>

      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-[13px]">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">id</th>
              <th className="px-3 py-1.5 font-medium">显示名</th>
              <th className="px-3 py-1.5 font-medium">命令</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-t border-border/40">
                <td className="px-3 py-1.5 font-mono text-xs">{a.id}</td>
                <td className="px-3 py-1.5">{a.label}</td>
                <td className="px-3 py-1.5 font-mono text-xs">
                  {a.command || <span className="text-muted-foreground">（纯终端）</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3">
        <Placeholder>
          占位 — 增删改 agent（settings.agents 已支持持久化与校验），表单待实现。
        </Placeholder>
      </div>
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
