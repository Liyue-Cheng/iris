/**
 * Tailwind config. Color tokens map to CSS variables defined per-theme in
 * src/renderer/styles/global.css ([data-theme='...'] blocks). Values are raw
 * hex vars (not the shadcn hsl(var(--x)) convention) so Marina's Rose Pine
 * palette can be carried over verbatim.
 */
const path = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['selector', '[data-theme="rose-pine"], [data-theme="rose-pine-moon"]'],
  content: [path.join(__dirname, 'src/renderer/**/*.{ts,tsx,html}')],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        // Second (and only second) border tier — list rows / indent guides.
        subtle: 'var(--border-subtle)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['LXGW WenKai', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Mono', 'JetBrains Mono', 'Consolas', 'LXGW WenKai Mono', 'monospace'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
