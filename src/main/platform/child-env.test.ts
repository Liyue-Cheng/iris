import { describe, expect, it } from 'vitest';
import {
  MACHINE_ENV_KEY,
  USER_ENV_KEY,
  buildRegistryEnvironment,
  createChildEnvironment,
  mergeRegistryEnvironment,
  parseRegExport,
  readRegistryExport,
  type RegistryValue,
} from './child-env';

function hexUtf16(text: string): string {
  return [...Buffer.from(`${text}\0`, 'utf16le')]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(',');
}

/** Wrap a hex(2) dump the way reg.exe does (continuation lines with `\`). */
function wrappedHex(name: string, value: string): string {
  const bytes = hexUtf16(value).split(',');
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 20) chunks.push(bytes.slice(i, i + 20).join(','));
  return `"${name}"=hex(2):${chunks.join(',\\\r\n  ')}`;
}

const SAMPLE = [
  '\uFEFFWindows Registry Editor Version 5.00',
  '',
  '[HKEY_CURRENT_USER\\Environment]',
  '"OneDrive"="C:\\\\Users\\\\张三\\\\OneDrive"',
  '"Quoted"="say \\"hi\\""',
  wrappedHex('Path', '%USERPROFILE%\\AppData\\Local\\Programs\\codebuddy;C:\\工具\\bin'),
  '"Count"=dword:00000001',
  '"Blob"=hex:01,02',
  '',
  '[HKEY_CURRENT_USER\\Environment\\Sub]',
  '"Ignored"="x"',
  '',
].join('\r\n');

describe('parseRegExport', () => {
  it('reads REG_SZ and wrapped REG_EXPAND_SZ values, including non-ASCII', () => {
    expect(parseRegExport(SAMPLE)).toEqual<RegistryValue[]>([
      { name: 'OneDrive', value: 'C:\\Users\\张三\\OneDrive', expand: false },
      { name: 'Quoted', value: 'say "hi"', expand: false },
      {
        name: 'Path',
        value: '%USERPROFILE%\\AppData\\Local\\Programs\\codebuddy;C:\\工具\\bin',
        expand: true,
      },
    ]);
  });

  it('returns nothing for empty or malformed exports', () => {
    expect(parseRegExport('')).toEqual([]);
    expect(parseRegExport('[HKEY_CURRENT_USER\\Environment]\r\n"Bad"=hex(2):zz,00')).toEqual([]);
  });
});

describe('buildRegistryEnvironment', () => {
  it('appends user Path to machine Path and expands against registry then inherited vars', () => {
    const env = buildRegistryEnvironment(
      {
        machine: [
          { name: 'Path', value: '%SystemRoot%\\system32;C:\\Tools', expand: true },
          { name: 'SystemRoot', value: 'C:\\Windows', expand: false },
          { name: 'Shared', value: 'machine', expand: false },
        ],
        user: [
          { name: 'Path', value: '%USERPROFILE%\\bin;%UNKNOWN%\\x', expand: true },
          { name: 'Shared', value: 'user', expand: false },
        ],
      },
      { USERPROFILE: 'C:\\Users\\me' },
    );
    expect(env.get('path')?.value).toBe(
      'C:\\Windows\\system32;C:\\Tools;C:\\Users\\me\\bin;%UNKNOWN%\\x',
    );
    expect(env.get('shared')?.value).toBe('user');
  });
});

describe('mergeRegistryEnvironment', () => {
  const registry = buildRegistryEnvironment(
    {
      machine: [{ name: 'Path', value: 'C:\\Windows;C:\\NEW\\machine', expand: false }],
      user: [
        { name: 'Path', value: 'c:\\users\\me\\npm\\;C:\\Users\\me\\codebuddy', expand: false },
        { name: 'CODEBUDDY_HOME', value: 'C:\\cb', expand: false },
        { name: 'temp', value: 'C:\\registry-temp', expand: false },
      ],
    },
    {},
  );

  it('keeps inherited Path order and appends only new directories', () => {
    const merged = mergeRegistryEnvironment(
      { PATH: 'C:\\Users\\me\\npm;C:\\Windows\\;C:\\iris-dev', TEMP: 'C:\\t' },
      registry,
    );
    expect(merged.PATH).toBe(
      'C:\\Users\\me\\npm;C:\\Windows\\;C:\\iris-dev;C:\\NEW\\machine;C:\\Users\\me\\codebuddy',
    );
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === 'path')).toEqual(['PATH']);
  });

  it('adds missing variables but never overwrites inherited values', () => {
    const merged = mergeRegistryEnvironment({ Path: '', TEMP: 'C:\\t', EMPTY: undefined }, registry);
    expect(merged.CODEBUDDY_HOME).toBe('C:\\cb');
    expect(merged.TEMP).toBe('C:\\t');
    expect(merged.temp).toBeUndefined();
    expect('EMPTY' in merged).toBe(false);
    expect(merged.Path).toBe('C:\\Windows;C:\\NEW\\machine;c:\\users\\me\\npm\\;C:\\Users\\me\\codebuddy');
  });
});

describe('createChildEnvironment', () => {
  const exports: Record<string, string> = {
    [MACHINE_ENV_KEY]: `[HKEY_LOCAL_MACHINE\\x]\r\n"Path"="C:\\\\Windows"`,
    [USER_ENV_KEY]: `[HKEY_CURRENT_USER\\Environment]\r\n"Path"="C:\\\\new-cli"`,
  };

  it('uses the inherited env until a refresh succeeds, then merges the registry', async () => {
    let reads = 0;
    const env = createChildEnvironment({
      platform: 'win32',
      readExport: async (key) => { reads += 1; return exports[key] ?? ''; },
    });
    expect(env.resolve({ Path: 'C:\\Windows' })).toEqual({ Path: 'C:\\Windows' });
    await env.refresh();
    expect(reads).toBe(2);
    expect(env.resolve({ Path: 'C:\\Windows' })).toEqual({ Path: 'C:\\Windows;C:\\new-cli' });
  });

  it('dedupes concurrent refreshes and throttles back-to-back ones', async () => {
    let reads = 0;
    let clock = 0;
    const env = createChildEnvironment({
      platform: 'win32',
      now: () => clock,
      readExport: async (key) => { reads += 1; return exports[key] ?? ''; },
    });
    await Promise.all([env.refresh(), env.refresh()]);
    expect(reads).toBe(2);
    clock = 500;
    await env.refresh();
    expect(reads).toBe(2);
    clock = 5000;
    await env.refresh();
    expect(reads).toBe(4);
  });

  it('never rejects and keeps the last good snapshot when the registry read fails', async () => {
    let fail = false;
    let clock = 0;
    const env = createChildEnvironment({
      platform: 'win32',
      now: () => clock,
      readExport: async (key) => {
        if (fail) throw new Error('reg.exe missing');
        return exports[key] ?? '';
      },
    });
    await env.refresh();
    fail = true;
    clock = 10_000;
    await expect(env.refresh()).resolves.toBeUndefined();
    expect(env.resolve({ Path: 'C:\\Windows' }).Path).toBe('C:\\Windows;C:\\new-cli');
  });

  it('is a pass-through on non-Windows platforms', async () => {
    let reads = 0;
    const env = createChildEnvironment({
      platform: 'linux',
      readExport: async () => { reads += 1; return ''; },
    });
    await env.refresh();
    expect(reads).toBe(0);
    expect(env.resolve({ PATH: '/usr/bin', X: undefined })).toEqual({ PATH: '/usr/bin' });
  });
});

describe.runIf(process.platform === 'win32')('readRegistryExport (real reg.exe)', () => {
  it('reads the machine environment including a Path value', async () => {
    const values = parseRegExport(await readRegistryExport(MACHINE_ENV_KEY));
    const path = values.find((v) => v.name.toLowerCase() === 'path');
    expect(path?.value.toLowerCase()).toContain('system32');
  });
});
