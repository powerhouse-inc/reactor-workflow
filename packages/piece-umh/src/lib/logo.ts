// A neutral factory mark rather than the United Manufacturing Hub's own logo:
// this piece is not published by UMH, and a borrowed brand would say it was.
// Inlined as a data URI because a first-party piece has no CDN entry to point
// the catalog at.
export const UMH_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<rect width="48" height="48" rx="10" fill="#0b3d5c"/>' +
      '<path d="M8 34V20l8 5v-5l8 5v-5l8 5V16h4v18z" fill="#ffffff"/>' +
      '<rect x="8" y="34" width="32" height="4" fill="#38bdf8"/>' +
      "</svg>",
  );
