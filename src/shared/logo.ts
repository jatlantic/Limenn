/** Atlas mark: a bracket with a blinking bar, "[▬]" (from limenn.io). `id` is kept for callers that pass one. */
export const logoSvg = (size = 18, _id = 'ag') =>
  `<svg width="${Math.round(size * 1.6)}" height="${size}" viewBox="0 0 32 20" aria-hidden="true" fill="none" stroke="#1a3cff" stroke-width="2"><path d="M6 2H2v16h4M26 2h4v16h-4"/><rect x="9" y="8.5" width="14" height="3" fill="#1a3cff" stroke="none"><animate attributeName="opacity" values="1;1;.25;.25" keyTimes="0;.5;.5;1" dur="2.4s" repeatCount="indefinite"/></rect></svg>`;
