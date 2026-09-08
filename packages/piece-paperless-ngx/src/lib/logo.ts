// A data URI rather than a CDN URL: first-party pieces are merged into the
// catalog without an Activepieces logo host behind them (the POWERHOUSE_PIECE
// precedent). The upstream twin swaps this for cdn.activepieces.com.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
<rect width="48" height="48" rx="8" fill="#17541f"/>
<path d="M14 10h13l7 7v21a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#fff"/>
<path d="M27 10l7 7h-7z" fill="#9fd3a6"/>
<g fill="#17541f">
<rect x="18" y="22" width="16" height="2" rx="1"/>
<rect x="18" y="27" width="16" height="2" rx="1"/>
<rect x="18" y="32" width="10" height="2" rx="1"/>
</g>
</svg>`;

export const PAPERLESS_LOGO = `data:image/svg+xml;base64,${Buffer.from(
  SVG.replace(/\n/g, ""),
  "utf8",
).toString("base64")}`;
