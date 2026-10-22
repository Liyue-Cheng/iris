/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('renderer native tooltip policy', () => {
  it('does not pass title attributes to DOM elements', () => {
    const root = path.resolve(__dirname, '../components');
    const files: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith('.tsx')) files.push(full);
      }
    };
    visit(root);
    const violations = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return [...source.matchAll(/(?:<[^>]*\s)title\s*=/g)]
        .filter((match) => !/^<(?:SettingGroup|CardFrame)\b/.test(match[0]))
        .map(() => path.relative(process.cwd(), file));
    });
    expect(violations).toEqual([]);
  });
});
