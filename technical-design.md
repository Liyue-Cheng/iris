# 技术设计书 — Iris（待定名）

> 本文记录**技术栈选型**与**复用来源**。产品语义、协议定义、设计原则见《软件定义书》（software-definition.md）。
> 实现可以换，协议不能破：任何实现决策与定义书冲突时，以定义书为准。

---

## 技术选型总表

| 层 | 选择 | 备注 |
|----|------|------|
| 桌面壳 | Electron（electron-vite） | 与 Marina 同栈，会话层代码直接复用；Tauri 因此出局 |
| 语言/框架 | TypeScript + React 18 | 同 Marina |
| 业务逻辑层 | front-cpu（FrontCPU ISA，npm 包 v0.3.0，作者自有） | 含中断系统、可插拔 executor、生命周期保证；用法见"复用 front-cpu" |
| 组件体系 | shadcn/ui + Tailwind（Radix 原语打底） | 拷贝式组件，源码归仓库所有 |
| 渲染管线 | remark / unified | AST 后按类型走默认配置表解释 |
| 正文编辑 | Crepe（Milkdown 成品发行版） | Typora 式 WYSIWYG |
| 源码编辑 | CodeMirror 6 | raw toggle 逃生舱 |
| 文档树 | react-arborist 或社区 shadcn tree-view | shadcn 唯一缺口 |
| 文件监听 | chokidar | Electron 主进程（Node） |
| PTY | node-pty + xterm.js（含 webgl/fit/serialize/headless 等 addon） | 直接复用 Marina 的会话层 |
| git | shell out 或 simple-git | v1 无 git 功能（reflects 延后），暂不引入 |
| License | AGPL-3.0 | Marina 为 MIT、同一作者，复制无障碍 |

**选栈的首要标准是 AI 可读性**：React + Tailwind + shadcn 是训练语料浓度最高的前端栈，AI 编写返工率最低。对一个主要由 agent 编写的代码库，栈的流行度本身就是生产力。

**设计语言**：继承姊妹项目 Marina——Rose Pine 配色 + 霞鹜文楷。家族相似性白来，零设计决策。xterm.js 主题与 Tailwind CSS 变量对齐同一色板。主题系统的具体方案见"主题系统"一节。

**编辑器红线**：永不自研 CodeMirror live-preview——该生态历史是一连串弃船（HyperMD、MarkText），打磨表格/图片/列表的成本即"需要大量编写的地方"。

---

## 复用 Marina（E:\projects\terminal）

Iris 的整个会话层不重写，从 Marina 复制后小改。Marina 已解决的问题与对应源码：

### 直接复制的部分

| Marina 源码 | 解决的问题 | Iris 侧改动 |
|-------------|-----------|------------|
| `src/main/session-manager.ts` | PTY 池、会话状态机（idle ↔ active → exited）、防闪烁 | 锚定对象从 path 换成 doc；spawn 时注入 `FOCUS_DOC` 环境变量 |
| `src/main/path-manager.ts` | 锚定模型：对象↔会话绑定创建时确定、终生不变，一对象任意多会话 | `pathId` → 文档相对路径；三分类（收藏/临时/最近）可简化 |
| `src/shared/types.ts` | `SessionInfo` / `SessionState` / 树结构等数据模型 | 同上改名 |
| `src/main/settings-manager.ts` | 设置持久化 | 存储位置改 `~/.iris/` |
| electron-vite 工程脚手架 | 三进程 tsconfig、构建、smoke 测试脚本 | 起项目时整体照搬 |

### 关键机制与参数（已在 Marina 验证，照抄）

- **状态判定**：纯 PTY 字节流活动启发式。静默阈值 `activeIdleThresholdSeconds = 2s`（可配，下限 100ms）。
- **三个防闪烁静默窗口**：启动期 grace `1500ms`（shell 横幅不算活动）、resize 回声 `500ms`（ConPTY 重排不算活动）、按键回显 `200ms`（echo 不算活动，按 Enter 主动关窗让命令输出立即亮灯）。
- **IPC 聚合**：PTY 输出 `8ms` 批量窗口，防高速输出打爆 renderer。
- **多窗口所有权**：会话同一时刻 0–1 个 owner window。v1 单窗口用不到，但复制时不必剔除——它是未来"会话跨窗口"的免费基础。

### 复制时砍掉的部分

- **LLM 状态复核**（`ai-client.ts`，依赖 `@anthropic-ai/sdk` / `openai`）——Iris 哑壳原则：不内嵌 SDK 和 API key。只留启发式层，"等待输入"细状态留给未来 OSC 信号方案。
- Marina 特有的路径收藏/最近列表逻辑中与 Iris 文档树重叠的部分，以 Iris 渲染器为准。

---

## 复用 front-cpu（E:\projects\dashboard\cpu-pipeline）

业务逻辑层不自研，直接用 `front-cpu` npm 包（FrontCPU ISA 的实现，框架无关、零 React 耦合）。姊妹项目 cutie（E:\projects\dashboard\cutie）是它的完整生产级用例，接入姿势照它抄。

**现状（0.3.0，前置工程已完成）**：中断系统已实现进库本体并通过 playground 真实文件链路的手工验证；综合治理修掉了全部已知缺陷（resolver 泄漏、IF buffer 泄漏、commit 失败误判、调度器纯化、事件驱动调度等），测试全绿，并提供实例级依赖注入与生命周期硬保证（终态唯一、锁必释放、完成即调度、超时即中止）。0.3.0 新增**可插拔 executor**（任意 transport 的声明式指令），并移除了库内去重工具——去重是 ISR 侧业务逻辑、只用确定性判据。**Iris 可以直接开工，无遗留前置。**

### 范式一句话

每个有副作用的操作注册为一条指令（`registerISA`），UI 只 `pipeline.dispatch('doc.save', payload)`；指令经五阶流水线（IF 取指 → SCH 调度 → EX 执行 → RES 响应 → WB 写回），SCH 阶段按 `resourceIdentifier` 自动做资源冲突检测，支持四种调度策略：`out-of-order`（默认乱序并发）/ `serial`（同资源串行）/ `latest`（自动取消旧指令，适合搜索）/ `read-write`（读共享写互斥）。

### 接入方式（照抄 cutie 的结构）

- `npm install front-cpu`，不复制源码。
- 建 `src/cpu/` 目录：`index.ts`（Pipeline 实例化）、`isa/`（按领域分文件注册指令，命名 `{domain}.{operation}`）、`cpu-adapters/`（适配层）。
- cutie 的 `vueAdapter` 换成 React 版 `reactiveStateFactory`；`correlationIdAdapter` 直接照搬。
- **用 0.2.0 的实例级配置**，不依赖全局单例：`new Pipeline({ isa, resourceStrategies, correlationIdGenerator, logging })`——实例优先、全局兜底，单元测试隔离白送。`setHttpClient` 整个用不上（见下）。

### Iris 侧的用法差异（相对 cutie）

- **指令体走 `ipc` executor，保持声明式**：cutie 的指令是声明式 HTTP 配置；Iris 没有后端，注册一个 `ipc` executor（`registerExecutor('ipc', (config, payload) => ipcRenderer.invoke(config.channel, payload))`，约 10 行），指令声明 `executor: 'ipc'` + `config: { channel }`——拿到与 cutie 同级的声明式体验。`setHttpClient` 不需要；`execute` 仅留给真有逻辑的指令。
- **禁用乐观更新**（`optimistic` 一律不配）：本地写盘没有网络延迟，没有什么可乐观的。
- **`doc.save` 按文件路径串行**：`resourceIdentifier: (p) => [\`doc:\${p.path}\`]` + **显式声明 serial**（0.2.0 起默认策略是 out-of-order，串行靠指令级 `schedulingStrategy: 'serial'` 或实例级 `resourceStrategies: [{ pattern: 'doc:*', strategy: 'serial' }]`）；其余指令默认乱序。`resourceIdentifier` 有纯函数契约（库只调一次并缓存）——路径→资源天然满足。
- **写盘类指令不提供取消**：front-cpu 的取消是协作式的——取消/超时只丢结果，`execute` 不检查 abort signal 副作用照常发生。`doc.save` 被"取消"后文件可能还是写了，语义脏；干脆不给写盘指令配 tag、不对它 flush。
- **CQRS 边界与 cutie 相同**：ISA 只收编"改变世界"的动词；"反映世界"的投影（文件系统 → 渲染）是反应式纯函数，不进流水线。
- **外部事件走中断系统**：chokidar 文件事件经 `pipeline.interrupts.raise()` 进入，由 ISR 更新投影——对应 cutie 里 SSE 事件的角色。中断不走 pipeline.dispatch。

### 中断系统（前置工程已完成，front-cpu 0.3.0）

原计划的"raise → 中断控制器 → ISR + 指令完成通知"已全部实现进库本体，并在 playground 用真实链路验证过：浏览器按钮 → 写磁盘真文件 → chokidar 检测 → 推回浏览器 → raise → 控制器路由 → ISR 去重/处理 → 回显。Iris 的核心回路就是这条链路的 Electron 版。

**去重是 ISR 内的业务逻辑，只用确定性判据、零启发式**（库内不提供去重工具）。Iris 的判据是**状态比对**：写盘内容来自内存里的文档状态，且状态在 dispatch 之前就已是最新（编辑器即真相源）——所以没有"登记"步骤，事件无论先到后到，比对结果都正确，不存在时序竞争，也不存在 TTL 之类的待定参数。

**Iris 接入示意**：

```typescript
// 进程拓扑：chokidar 在主进程盯 .iris/ 树 → IPC 推送到 renderer →
// renderer 收到后 raise（Pipeline 与 ISA 都住 renderer）
ipcRenderer.on('fs:changed', (_evt, { path, content }) => {
  pipeline.interrupts.raise({
    type: 'fs.doc.changed',
    source: 'file-watcher',
    data: { path, content },
  })
})

// 投影层 ISR：状态比对去重——盘上内容 = 内存状态 → 无信息增量，跳过；
// 不一致 = 真正的外部修改 → 重投影
pipeline.interrupts.register({
  name: 'doc-projection',
  events: 'fs.doc.*',
  onInterrupt: (e) => {
    const { path, content } = e.data
    if (hash(content) === hash(docStore.get(path)?.content)) return // 回声或等价修改
    reproject(path, content)
  },
})
```

**对 Iris 有用的生命周期保证（引擎级承诺）**：每条指令恰好一个终态、promise 恰好 settle 一次；锁必释放；完成通知在 promise settle 之后送达（`await dispatch` 的调用方先看到结果）；完成即调度（serial 队列无轮询延迟）；commit 抛错按失败处理。

### 理由备忘

代码库主要由 agent 编写，中央指令注册表是反熵装置——"新功能 = 注册一条新指令"给 agent 唯一正确答案，diff 统一可审。ISA 之于代码库，如 `.iris/` 之于项目："键是硬的"应用于代码自身。

---

## 主题系统

Marina 的主题（`src/renderer/styles/global.css`，10 套主题）是三层 design token 架构：Layer 1 调色板层（`--rp-*` 等品牌词汇，命名空间隔离）→ Layer 2 语义层（15 个自定义角色 token，组件消费的唯一 API）→ `[data-theme]` 块切换。

**Iris 的方案：架构思想复用，语义层词汇不复用。** Marina 的 Layer 2 是自造词汇；Iris 用 shadcn，组件全部消费 shadcn 标准 token（`--background` / `--foreground` / `--primary` / `--card` / `--border` / `--ring` 等）。搬自造词汇会让每个拷贝来的 shadcn 组件都要手工改名，毁掉拷贝式组件的意义；shadcn token 也是 AI 语料浓度最高的主题词汇，生态工具（tweakcn、各 theme generator）全部对着它。

- **结构**：Layer 1 照搬 Marina 的 Rose Pine 三变体 hex（含 Dawn 的 WCAG 对比度修正），Layer 2 换成 shadcn token 词汇做映射，`[data-theme]` + `color-scheme` 切换机制照搬。
- **现成预设**：查过，没有官方 Rose Pine shadcn 预设（tweakcn 有 Catppuccin 等 16+，无 Rose Pine）——用 Marina 的 hex 手工映射 ~20 个 token，一次性半小时工作。
- **直接照搬的资产**：字体栈（UI：LXGW WenKai + 系统回退；终端：Cascadia Mono / JetBrains Mono）、`XTERM_THEMES` JS 对象（xterm 不走 CSS，独立维护，与 CSS 变量对齐同一色板）。
- **v1 范围**：先只做 Rose Pine 三变体（默认深色 rose-pine、浅色 dawn、中度 moon），Marina 另外 7 套主题不急着搬。
