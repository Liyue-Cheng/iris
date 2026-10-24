import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { joinShellPaths, quoteShellPath, ShellPathQuotingError, terminalShellKindFromExecutable } from './shell-quoting';

describe('literal terminal path arguments', () => {
  it('derives grammar from the executable and leaves unrecognized shells unknown', () => {
    expect(terminalShellKindFromExecutable('C:\\Windows\\System32\\CMD.EXE')).toBe('cmd');
    expect(terminalShellKindFromExecutable('C:/Program Files/PowerShell/7/pwsh.exe')).toBe('powershell');
    expect(terminalShellKindFromExecutable('/bin/zsh')).toBe('posix');
    expect(terminalShellKindFromExecutable('/usr/bin/tcsh')).toBe('unknown');
    expect(terminalShellKindFromExecutable('/usr/bin/custom-shell')).toBe('unknown');
  });
  it('escapes single quotes without evaluating PowerShell or POSIX expansions', () => {
    expect(quoteShellPath("O'Brien $(x).txt", 'powershell')).toBe("'O''Brien $(x).txt'");
    expect(quoteShellPath("O'Brien $(x).txt", 'posix')).toBe("'O'\\''Brien $(x).txt'");
    expect(quoteShellPath('C:\\foo&echo.bar\\', 'cmd')).toBe('"C:\\foo&echo.bar"\\');
  });

  it.each(['%PATH%.txt', '!PATH!.txt', 'double"quote.txt'])('rejects cmd expansions in %s', (path) => {
    expect(() => quoteShellPath(path, 'cmd')).toThrow(ShellPathQuotingError);
  });

  it.each(['powershell', 'cmd', 'posix', 'unknown'] as const)('rejects control input in %s', (shell) => {
    expect(() => quoteShellPath('one\rtwo', shell)).toThrow(ShellPathQuotingError);
    expect(() => quoteShellPath('one\x1b[2J', shell)).toThrow(ShellPathQuotingError);
    expect(() => quoteShellPath('one\u009b2J', shell)).toThrow(ShellPathQuotingError);
  });

  it('rejects an unknown shell instead of borrowing another shell grammar', () => {
    expect(() => quoteShellPath('safe.txt', 'unknown')).toThrow(ShellPathQuotingError);
  });

  it.runIf(process.platform === 'win32')('round-trips dangerous paths through real PowerShell as data', () => {
    const paths = [
      ".iris/issue/O'Brien.md", '.iris/issue/%IRIS_AUDIT_PATH_VALUE%.md',
      'C:\\tmp\\$(Write-Output IRIS_PATH_EXECUTED)\\file name.txt',
      'C:\\tmp\\foo&echo.IRIS_PATH_EXECUTED&rem', 'C:\\two words\\', 'C:\\O’Brien‘notes‚low‛quote.md',
    ];
    const source = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(${paths.map((path) => quoteShellPath(path, 'powershell')).join(',')}) | ConvertTo-Json -Compress`;
    const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(paths);
  });

  it.runIf(process.platform === 'win32')('round-trips quoted cmd paths with delayed expansion enabled', () => {
    const paths = ["C:\\O'Brien.md", 'C:\\two words.md', 'C:\\foo&echo.IRIS_PATH_EXECUTED&rem', 'C:\\two words\\', 'C:\\(folder)^name.txt'];
    // Feed the command to cmd stdin, avoiding an extra /c command-line quoting layer.
    const source = `${quoteShellPath(process.execPath, 'cmd')} -e "process.stdout.write('\\n'+JSON.stringify(process.argv.slice(1))+'\\n')" ${joinShellPaths(paths, 'cmd')}\r\nexit\r\n`;
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/q', '/v:on'], { input: source, encoding: 'utf8', env: { ...process.env, PROMPT: '' } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('["'));
    expect(line, result.stdout).toBeDefined();
    expect(JSON.parse(line!)).toEqual(paths);
  });

  it.runIf(process.platform !== 'win32')('round-trips POSIX metacharacters through sh', () => {
    const paths = ["O'Brien.md", 'two words', '$(echo IRIS_PATH_EXECUTED);&*', 'double"quote', 'back\\slash'];
    const result = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${joinShellPaths(paths, 'posix')}`]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.toString().split('\0').slice(0, -1)).toEqual(paths);
  });
});
