const TITLE_MAX_LEN = 100;

export function sanitizeTerminalTitle(raw: string): string {
  let sanitized = '';
  for (const char of raw) {
    const code = char.codePointAt(0)!;
    if (
      code < 0x20 ||
      code === 0x7f ||
      code === 0x200b ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      sanitized += ' ';
    } else {
      sanitized += char;
    }
  }
  return sanitized.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_LEN);
}

export function looksLikeShellStartupGarbage(title: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(title)) return true;
  if (/^\\\\/.test(title)) return true;
  if (title.startsWith('/')) return true;
  if (/^(MINGW(32|64|ARM)?|MSYS\d?):/i.test(title)) return true;
  return /^\S+\.exe$/i.test(title);
}
