import ts from 'typescript';
import { resolve } from 'node:path';

const configPath = resolve('tsconfig.web.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, resolve('.'));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

// Each entry names a Promise-returning boundary whose implementation consumes
// all expected rejections. Additions require a concrete code-review reason.
const SAFE_VOID_CALLEES = new Map([
  ['alertDialog', 'FIFO dialog service always resolves'],
  ['addEntry', 'settings panel catches and renders inline errors'],
  ['adoptLegacy', 'asset panel catches and renders inline errors'],
  ['applyLocale', 'locale store owns fallback behavior'],
  ['attemptAction', 'normalizes every rejection into an outcome'],
  ['chooseFolder', 'welcome view catches and renders inline errors'],
  ['chooseFolderInNewWindow', 'welcome view catches and renders inline errors'],
  ['closeSession', 'session action boundary'],
  ['copyText', 'about panel renders clipboard failure inline'],
  ['create', 'creation dialogs catch and retain user input'],
  ['editorStore.handleDiskChange', 'editor store owns conflict/error state'],
  ['editorStore.flushBeforeSwitch', 'editor save returns an explicit refusal outcome'],
  ['editorStore.overwriteConflict', 'editor store owns conflict/error state'],
  ['editorStore.save', 'editor store owns save error state'],
  ['editorStore.setFrontmatterField', 'editor store owns save error state'],
  ['gitStore.commit', 'git store catches and renders operation errors'],
  ['gitStore.refresh', 'git projection health boundary'],
  ['gitStore.switchBranch', 'git store catches and renders operation errors'],
  ['gitStore.stage', 'git store catches and renders operation errors'],
  ['gitStore.unstage', 'git store catches and renders operation errors'],
  ['handleDocDrop', 'component action boundary'],
  ['handleFileDrop', 'session I/O boundary'],
  ['handlePaste', 'clipboard and confirmation boundary'],
  ['<object>.handlePaste', 'terminal handler ref points to the clipboard boundary'],
  ['healthStore.retry', 'health retry catches and re-records failures'],
  ['hydrateSessions', 'projection health boundary'],
  ['importFiles', 'asset panel catches and renders inline errors'],
  ['installCliHook', 'settings panel catches and renders inline errors'],
  ['onCheck', 'todo action boundary'],
  ['openExternalLink', 'about panel catches and renders inline errors'],
  ['openIssueInDefaultView', 'navigation functions return refusal outcomes'],
  ['openLegalDocument', 'about panel catches and renders inline errors'],
  ['openProject', 'project action boundary'],
  ['openRecent', 'project action boundary'],
  ['openProjectInNewWindow', 'project action boundary'],
  ['openProjectItem', 'shell action boundary'],
  ['openSession', 'session action boundary'],
  ['openWorkspaceSession', 'session action boundary'],
  ['pickAndOpenProject', 'project action boundary'],
  ['projectSettingsStore.refresh', 'settings projection owns error state'],
  ['projectStore.activateSession', 'navigation functions return refusal outcomes'],
  ['projectStore.openCollection', 'navigation functions return refusal outcomes'],
  ['projectStore.selectCollectionDoc', 'navigation functions return refusal outcomes'],
  ['projectStore.selectDoc', 'navigation functions return refusal outcomes'],
  ['projectStore.selectRoot', 'navigation functions return refusal outcomes'],
  ['projectStore.selectWorkspace', 'navigation functions return refusal outcomes'],
  ['projectStore.refreshFromFs', 'project projection health boundary'],
  ['refreshPromptProjectionHealth', 'projection health boundary'],
  ['refresh', 'component projection functions catch and render inline errors'],
  ['refreshInj', 'settings panel catches and renders inline errors'],
  ['refreshRecentProjects', 'recent-project projection owns inline error state'],
  ['refreshRecents', 'welcome projection owns inline error state'],
  ['removeEntry', 'settings panel catches and renders inline errors'],
  ['removeCliHook', 'settings panel catches and renders inline errors'],
  ['removeOrphan', 'asset panel catches and renders inline errors'],
  ['removeRecent', 'welcome view catches and renders inline errors'],
  ['revealProjectItem', 'shell action boundary'],
  ['revealUserData', 'about panel catches and renders inline errors'],
  ['run', 'dialog/panel command functions catch and retain local state'],
  ['runUserAction', 'normalizes and displays every rejection'],
  ['offerPromptProjectionRepair', 'prompt health/action boundary'],
  ['saveProjectPrompt', 'settings panel catches and renders inline errors'],
  ['sendSessionInput', 'session-local failure latch'],
  ['sendSessionResize', 'session-local failure latch'],
  ['setDocStatus', 'document action boundary'],
  ['this.refreshRawTree', 'project projection health boundary'],
  ['this.save', 'editor store owns save error state'],
  ['updateSettings', 'settings panel catches and renders inline errors'],
  ['writeActions', 'toolbar settings catches and renders inline errors'],
  ['writeClipboardText', 'clipboard action boundary'],
]);

function calleeName(expression) {
  if (!ts.isCallExpression(expression)) return '<expression>';
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    const owner = ts.isIdentifier(callee.expression)
      ? callee.expression.text
      : callee.expression.kind === ts.SyntaxKind.ThisKeyword
        ? 'this'
        : '<object>';
    return `${owner}.${callee.name.text}`;
  }
  if (ts.isParenthesizedExpression(callee) || ts.isArrowFunction(callee)) return '<iife>';
  return '<expression>';
}

function rootCalleeName(expression) {
  if (!ts.isCallExpression(expression)) return calleeName(expression);
  const callee = expression.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'then' || callee.name.text === 'finally' || callee.name.text === 'catch')
  ) {
    return rootCalleeName(callee.expression);
  }
  return calleeName(expression);
}

function safeVoidExpression(expression) {
  if (ts.isParenthesizedExpression(expression)) return safeVoidExpression(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return safeVoidExpression(expression.whenTrue) && safeVoidExpression(expression.whenFalse);
  }
  return SAFE_VOID_CALLEES.has(rootCalleeName(expression));
}

function isPromise(expression) {
  return checker.getPromisedTypeOfPromise(checker.getTypeAtLocation(expression)) !== undefined;
}

function hasHandledComment(node, sourceFile) {
  const start = node.getFullStart();
  const text = sourceFile.text.slice(start, node.getStart(sourceFile));
  return text.includes('async-boundary: handled');
}

function chainHasCatch(expression) {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return false;
  }
  if (expression.expression.name.text === 'catch') return true;
  return chainHasCatch(expression.expression.expression);
}

const failures = [];
for (const sourceFile of program.getSourceFiles()) {
  const normalized = sourceFile.fileName.replace(/\\/g, '/');
  if (!normalized.includes('/src/renderer/') || normalized.endsWith('.test.ts')) continue;

  const visit = (node) => {
    if (
      ts.isVoidExpression(node) &&
      isPromise(node.expression)
    ) {
      const name = rootCalleeName(node.expression);
      if (
        !chainHasCatch(node.expression) &&
        !safeVoidExpression(node.expression) &&
        !hasHandledComment(node, sourceFile)
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        failures.push(`${normalized}:${position.line + 1}:${position.character + 1} unsafe void Promise (${name})`);
      }
    } else if (
      ts.isExpressionStatement(node) &&
      !ts.isVoidExpression(node.expression) &&
      isPromise(node.expression)
    ) {
      const expression = node.expression;
      const handledCatch = chainHasCatch(expression);
      if (!handledCatch && !hasHandledComment(node, sourceFile)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        failures.push(`${normalized}:${position.line + 1}:${position.character + 1} floating Promise expression`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

if (failures.length > 0) {
  console.error('Async boundary check failed:\n' + failures.join('\n'));
  process.exitCode = 1;
}
