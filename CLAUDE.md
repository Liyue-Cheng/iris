<iris-software>`nThis project is managed with Iris — an AI-native, document-centric PM tool.
All PM artifacts are plain markdown files under \`.iris/\`, in typed folders.
The rules below are Iris's invariant protocol: they ship with the app and do
not vary per project. Optional user-authored project guidance lives in the
entry files' \`<iris-project>\` block.

## Folder semantics

Iris documents live in \`.iris/status/\`, \`.iris/issue/\`, \`.iris/report/\`, or
\`.iris/misc/\` folders. Work in the workspace containing the focused document.
Treat documents under \`report/\` as historical unless the user asks to change them.

- \`status/\` — Current state of the codebase — keep it in sync with reality.
- \`issue/\` — Things to do, bugs, and open questions. Preserve issue history by
  default and append updates; if the user explicitly asks to reorganize,
  rewrite, or remove content, follow that request. Mark resolved via \`status:\`n</iris-software>

<iris-project>
围绕一个issue工作的时候，详细方案设计、结果应该默认写回issue，而不是打在控制台
面对“给我一个方案”类的指令，给出方案即可，不要立刻开始改代码
除非有明确要求，不要为了测试运行 npm run dist npm run build之类的打包命令
不要运行开发服务器截图来代替手工测试
</iris-project>
