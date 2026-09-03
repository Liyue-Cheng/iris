---
title: agent banner
status: In Review
---
**部分供应商模型加载失败**

Sudochat: Could not load models for OpenAI Compatible: TypeError: fetch failed caused by ConnectTimeoutError \[UND\_ERR\_CONNECT\_TIMEOUT]: Connect Timeout Error (attempted address: api.sudocode.chat:443, timeout: 10000ms)

<br />

这种小问题，不要搞这么大的banner，你换一种呈现方式

---

## 改进方案

### 问题分析

当前实现（`src/renderer/components/agent/IrisAgentView.tsx:251-275`）：
- 使用完整的横向banner，包含图标、标题、完整错误信息和重试按钮
- 占据较大垂直空间，对于轻微错误过于醒目
- 无论是"所有模型失败"还是"部分模型失败"，呈现方式相同

### 设计原则

1. **区分严重程度**：所有模型失败 vs 部分模型失败
2. **渐进式披露**：默认显示摘要，详情按需展开
3. **不阻碍工作流**：已有可用模型时，错误不应抢占视觉焦点

### 推荐方案：分级提示

#### 方案A：模型选择器集成提示（推荐）

**当部分模型加载失败时：**
- 在模型选择器右侧增加一个小的警告图标（amber色）
- 鼠标悬停时显示tooltip："部分供应商模型加载失败，点击查看详情"
- 点击图标后，在下拉菜单底部或弹出小浮层显示失败的供应商列表和简短错误

**当所有模型加载失败时：**
- 保留当前的banner样式（因为这是阻塞性错误）
- 或者使用精简版：只保留标题和重试按钮，错误详情折叠到"查看详情"

**实现要点：**
```tsx
// 部分失败：在标题栏添加小图标
{modelError && models.length > 0 && (
  <button className="h-7 w-7 shrink-0" title="部分供应商加载失败">
    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
  </button>
)}

// 所有失败：保持banner但简化高度
{modelError && models.length === 0 && (
  <div className="flex h-8 items-center gap-2 border-b bg-amber-500/10 px-3 text-xs">
    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
    <span className="flex-1">模型加载失败</span>
    <button>查看详情</button>
    <button>重试</button>
  </div>
)}
```

#### 方案B：状态栏通知

将错误移到底部状态栏或顶部TitleBar区域，使用：
- 小圆点或图标指示有错误
- 点击后展开完整信息

#### 方案C：内联文字提示

在模型选择器下方显示一行紧凑文字：
```
⚠️ 部分供应商不可用（点击查看）
```

### 建议

优先实现**方案A**，理由：
1. 信息就近：错误提示靠近模型选择器，符合用户心智模型
2. 渐进式：默认不占空间，需要时才展开
3. 视觉层级合理：小图标 < 折叠banner < 完整banner

---

## 实现检查点

- [ ] 修改 `IrisAgentView.tsx` 中的错误展示逻辑
- [ ] 区分 `models.length === 0` 和 `models.length > 0` 两种情况
- [ ] 为部分失败情况添加紧凑提示组件
- [ ] 保持重试功能的可访问性
- [ ] 手工测试：制造一个供应商连接失败的场景，验证新UI
