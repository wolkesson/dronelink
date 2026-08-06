/**
 * Shared inline SVG icons, sized via currentColor so callers can style them
 * with plain CSS `color`. Kept as small template strings — no icon
 * dependency, no separate asset requests.
 */

const svg = (body: string, viewBox = "0 0 16 16") =>
  `<svg viewBox="${viewBox}" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

export const icons = {
  dot: svg('<circle cx="8" cy="8" r="4" fill="currentColor"/>'),

  usb: svg(
    '<rect x="3" y="5" width="10" height="6" rx="1.5" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M5.5 5V3.5M10.5 5V3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  ),

  wifiBars: svg(
    '<rect x="2" y="9" width="2.4" height="4" rx="0.6" fill="currentColor"/>' +
      '<rect x="6.2" y="6.5" width="2.4" height="6.5" rx="0.6" fill="currentColor"/>' +
      '<rect x="10.4" y="3.5" width="2.4" height="9.5" rx="0.6" fill="currentColor"/>',
  ),

  camera: svg(
    '<rect x="1.5" y="4.5" width="9" height="7" rx="1.3" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M10.5 7L14 5v6l-3.5-2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  ),

  chevronDown: svg(
    '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  ),

  refresh: svg(
    '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3.5h-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  ),

  power: svg(
    '<path d="M8 2.5v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M4.8 4.3a5 5 0 1 0 6.4 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  ),

  qrCode: svg(
    '<rect x="2" y="2" width="4" height="4" stroke="currentColor" stroke-width="1.2"/>' +
      '<rect x="10" y="2" width="4" height="4" stroke="currentColor" stroke-width="1.2"/>' +
      '<rect x="2" y="10" width="4" height="4" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M10 10h1.6v1.6H10zM12.4 10H14v1.6h-1.6zM10 12.4h1.6V14H10zM12.4 12.4H14V14h-1.6z" fill="currentColor"/>',
  ),

  keyboard: svg(
    '<rect x="1.5" y="4" width="13" height="8" rx="1.3" stroke="currentColor" stroke-width="1.2"/>' +
      '<path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M4.5 9.5h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  ),
};

export type IconName = keyof typeof icons;
