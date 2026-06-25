/**
 * @file scripts/clean-release.mjs
 * @purpose 打包前清掉本版本的输出目录 dist/release/<version>，让 electron-builder
 *   从干净状态开始，从根上消除「重打同一版本卡住」的问题。
 *
 * 为什么需要它：
 *   electron-builder 的 directories.output 是 dist/release/${version}。重打同一个
 *   版本时这个目录被复用，而上一次打出来的 win-unpacked\Iris.exe（以及签名过的
 *   node-pty 原生二进制）经常仍被占用——旧的 Iris 还开着、杀软在扫、句柄没释放。
 *   electron-builder 删不掉就无限重试，表现为「卡住」。以前只能靠升版本号换一个全新
 *   目录绕过（于是 alpha.1~.5 + alpha2-rebuild 全是被逼出来的）。
 *
 * 这个脚本做两件事：
 *   1. 带重试地强删该目录，扛住杀软那种几百毫秒的瞬时锁；
 *   2. 真删不掉时（确实有进程占着），快速给出可读报错并退出非 0——把「无限卡死」
 *      变成「几秒内明确告诉你去关掉正在运行的 Iris」。
 */
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const target = resolve(root, 'dist', 'release', pkg.version);

if (!existsSync(target)) {
  console.log(`[clean-release] 无需清理：${target} 不存在`);
  process.exit(0);
}

console.log(`[clean-release] 清理上次的输出目录：${target}`);

// fs.rm 的 maxRetries/retryDelay 专为 Windows 的 EBUSY/EPERM/ENOTEMPTY 设计，
// 能自动扛住杀软扫描这类瞬时锁；总共约 20 次 × 300ms ≈ 6s。
try {
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 300,
  });
  console.log('[clean-release] 已清理，可以开始打包');
} catch (err) {
  console.error('\n[clean-release] 无法删除上次的输出目录，多半是有进程正占着里面的文件：');
  console.error(`  ${err.code ?? ''} ${err.path ?? target}`);
  console.error(
    '\n  最常见的原因：上一次打出来的 Iris 还开着。请关掉所有正在运行的 Iris（' +
      '任务管理器里结束 Iris.exe），然后重新运行 npm run dist。\n',
  );
  process.exit(1);
}
