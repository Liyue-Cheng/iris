/**
 * Iris logomark as inline SVG — the aperture-bloom from build/mark.svg, kept
 * in sync by hand (it's tiny). Inlined rather than imported as an asset so it
 * renders crisp at any size and needs no img-src CSP allowance. Three violet
 * "standards" + three rose "falls" converge on a gold focus point.
 */
export function IrisMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="iris-std" x1="256" y1="60" x2="256" y2="276" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#dac6f4" />
          <stop offset="1" stopColor="#9a7bd4" />
        </linearGradient>
        <linearGradient id="iris-fall" x1="256" y1="124" x2="256" y2="268" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f1cbc9" />
          <stop offset="1" stopColor="#d597a0" />
        </linearGradient>
        <radialGradient id="iris-pupil" cx="0.42" cy="0.4" r="0.7">
          <stop offset="0" stopColor="#fbd9a0" />
          <stop offset="1" stopColor="#f0b65a" />
        </radialGradient>
        <path id="iris-ps" d="M256 272 C 178 250 156 150 256 60 C 356 150 334 250 256 272 Z" />
        <path id="iris-pf" d="M256 266 C 200 254 186 184 256 124 C 326 184 312 254 256 266 Z" />
      </defs>
      <g fill="url(#iris-fall)" opacity="0.92">
        <use href="#iris-pf" transform="rotate(60 256 256)" />
        <use href="#iris-pf" transform="rotate(180 256 256)" />
        <use href="#iris-pf" transform="rotate(300 256 256)" />
      </g>
      <g fill="url(#iris-std)">
        <use href="#iris-ps" transform="rotate(0 256 256)" />
        <use href="#iris-ps" transform="rotate(120 256 256)" />
        <use href="#iris-ps" transform="rotate(240 256 256)" />
      </g>
      <circle cx="256" cy="256" r="30" fill="url(#iris-pupil)" />
      <circle cx="248" cy="248" r="9" fill="#fff" opacity="0.45" />
    </svg>
  );
}
