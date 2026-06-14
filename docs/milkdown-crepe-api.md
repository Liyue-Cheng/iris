# Milkdown / Crepe API 参考（本地速查）

来源：本机已装版本的 `.d.ts` 类型定义（`node_modules/@milkdown/crepe`、`@milkdown/core`、
`@milkdown/plugin-listener`）。这是**精确到当前安装版本**的权威清单——官网 milkdown.dev
是前端渲染页，直接抓正文抓不到，类型定义才是真相。

> 关键结论：**Crepe/Milkdown/ProseMirror 都没有"保存/恢复滚动位置"的 API。**
> 正确姿势是：用 `editorViewCtx` 拿到 ProseMirror `EditorView` → `view.dom`（即
> `.ProseMirror` contentEditable 元素）→ 走标准 DOM 滚动（找滚动祖先、读写
> `scrollTop`）。滚动是 DOM 的事，编辑器只负责把 view/DOM 句柄交给你。

---

## 1. Crepe 类（`@milkdown/crepe`）

`Crepe extends CrepeBuilder`，方法都在 builder 上。

```ts
class CrepeBuilder {
  constructor(config?: { root?: Node | string | null; defaultValue?: DefaultValue });

  create:  () => Promise<Editor>;   // 异步挂载，resolve 后 DOM 才就绪
  destroy: () => Promise<Editor>;

  get editor(): Editor;             // ← 底层 Milkdown Editor，一切 ctx 入口
  get readonly(): boolean;
  setReadonly: (value: boolean) => this;

  getMarkdown: () => string;        // 当前内容序列化为 markdown
  on: (fn: (api: ListenerManager) => void) => this;  // 注册事件监听

  addFeature: (feature, config?) => CrepeBuilder;
}

class Crepe extends CrepeBuilder {
  static Feature: typeof CrepeFeature;   // 见 §5
  constructor(config?: {
    root?: Node | string | null;
    defaultValue?: DefaultValue;
    features?: Partial<Record<CrepeFeature, boolean>>;
    featureConfigs?: CrepeFeatureConfig;
  });
}
```

构造 + 挂载：

```ts
const crepe = new Crepe({ root: el, defaultValue: body, features: { ... } });
await crepe.create();          // 必须 await，之后 DOM/view 才存在
// ...
await crepe.destroy();         // 卸载
```

---

## 2. Editor 类（`@milkdown/core` → 经 `@milkdown/kit/core` 转出）

`crepe.editor` 返回它。`action` 是同步取 ctx 的口子。

```ts
enum EditorStatus { Idle, OnCreate, Created, OnDestroy, Destroyed }

class Editor {
  get ctx(): Ctx;
  get status(): EditorStatus;
  readonly onStatusChange: (onChange: (s: EditorStatus) => void) => this;
  readonly create:  () => Promise<Editor>;
  readonly destroy: (clearPlugins?: boolean) => Promise<Editor>;
  readonly action:  <T>(action: (ctx: Ctx) => T) => T;   // ← 同步访问 ctx
  readonly use:     (plugins) => this;
  readonly config:  (configure: (ctx: Ctx) => void) => this;
  readonly remove / removeConfig: ...;
}
```

---

## 3. 核心 Ctx 键（`@milkdown/core/internal-plugin/atoms`，从 `@milkdown/kit/core` 导入）

```ts
const editorViewCtx:  SliceType<EditorView>;    // ProseMirror EditorView
const editorStateCtx: SliceType<EditorState>;   // ProseMirror EditorState
const rootCtx:        SliceType<RootType>;       // 挂载根
const parserCtx:      SliceType<Parser>;         // markdown → ProseMirror doc
const serializerCtx:  SliceType<Serializer>;     // ProseMirror doc → markdown
```

### 拿 ProseMirror EditorView（本仓库滚动记忆要用的就是这个）

```ts
import { editorViewCtx } from '@milkdown/kit/core';

const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
// view.dom        → contentEditable 的 .ProseMirror 元素
// view.state      → EditorState
// view.dispatch() → 派发 transaction
// view.coordsAtPos(pos) → 坐标，可用于精确定位
```

### 手写 getMarkdown（Crepe 已封装 `getMarkdown()`，这里给原理）

```ts
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';

const md = editor.action((ctx) => {
  const view = ctx.get(editorViewCtx);
  const serializer = ctx.get(serializerCtx);
  return serializer(view.state.doc);
});
```

---

## 4. 事件监听 ListenerManager（`@milkdown/plugin-listener`，经 `crepe.on()`）

```ts
crepe.on((listener) => {
  listener.markdownUpdated((ctx, markdown, prevMarkdown) => { /* 内容变更 */ });
  listener.mounted((ctx) => { /* 挂载完成 */ });
  listener.updated((ctx, doc, prevDoc) => { /* doc 变更（ProseMirror 节点） */ });
  listener.selectionUpdated((ctx, sel, prevSel) => { /* 选区变更 */ });
  listener.focus((ctx) => {});
  listener.blur((ctx) => {});
  listener.beforeMount((ctx) => {});
  listener.destroy((ctx) => {});
});
```

全部事件：`beforeMount` · `mounted` · `updated` · `markdownUpdated` ·
`selectionUpdated` · `focus` · `blur` · `destroy`。

---

## 5. Crepe.Feature 枚举

`Crepe.Feature.*`（传给 `features: { [Feature]: boolean }`）：
`CodeMirror` · `ListItem` · `LinkTooltip` · `Cursor` · `ImageBlock` ·
`BlockEdit` · `Placeholder` · `Toolbar` · `Table` · `Latex` · `Diff` · `AI`
（以本机 `@milkdown/crepe/lib/types/feature/index.d.ts` 为准）。

---

## 6. 滚动记忆该怎么做（结论）

没有现成 API。做法：

1. `await crepe.create()` 后，`const view = crepe.editor.action(ctx => ctx.get(editorViewCtx))`。
2. 不硬找某个固定滚动层。当前实现统一走
   `src/renderer/lib/scroll-memory.ts` 的 `attachScrollMemory({ key, content })`：
   保存时在 `document` 捕获 `scroll`，只接受 `e.target.contains(content)` 的祖先
   滚动；恢复时从 `content` 往上对可滚祖先链式写入 `scrollTop`。
3. 恢复期间必须禁止保存。程序写 `scrollTop` 也会触发 `scroll`，而异步布局未完成时
   写入会被 clamp 成偏小值；如果这时回存，就会产生“每次切回都上漂”的棘轮。
4. 重新挂载后跨帧恢复，直到内容高度连续稳定几帧或达到兜底上限。Crepe resolve
   create() 后 DOM 可取，但排版仍可能继续改变 `scrollHeight`。

源码模式（CodeMirror 6）反而有现成滚动句柄：`view.scrollDOM`（即 `.cm-scroller`），
直接读写它的 `scrollTop` 即可。
