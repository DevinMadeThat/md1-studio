// Small inline SVG icons (stroke = currentColor).
const svg = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  camera: (s?: number) =>
    svg(`<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>`, s),
  disc: (s?: number) =>
    svg(`<path d="M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"/><rect x="9" y="3" width="8" height="7" rx="1"/><path d="M8 15h8"/>`, s),
  folder: (s?: number) => svg(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`, s),
  plus: (s?: number) => svg(`<path d="M12 5v14M5 12h14"/>`, s),
  sound: (s?: number) =>
    svg(`<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>`, s),
  export: (s?: number) => svg(`<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>`, s),
  close: (s?: number) => svg(`<path d="M6 6l12 12M18 6 6 18"/>`, s),
  left: (s?: number) => svg(`<path d="m15 5-7 7 7 7"/>`, s),
  right: (s?: number) => svg(`<path d="m9 5 7 7-7 7"/>`, s),
  play: (s?: number) => `<svg width="${s ?? 16}" height="${s ?? 16}" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>`,
  pause: (s?: number) => `<svg width="${s ?? 16}" height="${s ?? 16}" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>`,
  refresh: (s?: number) => svg(`<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>`, s),
  check: (s?: number) => svg(`<path d="m5 12 5 5 9-10"/>`, s),
  flash: (s?: number) => svg(`<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>`, s),
  finder: (s?: number) => svg(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>`, s),
  pin: (s?: number) => svg(`<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>`, s),
  calendar: (s?: number) => svg(`<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`, s),
  rotateLeft: (s?: number) => svg(`<path d="M4 4v6h6"/><path d="M4.5 10A8 8 0 1 1 7 17.7"/>`, s),
  rotateRight: (s?: number) => svg(`<path d="M20 4v6h-6"/><path d="M19.5 10A8 8 0 1 0 17 17.7"/>`, s),
  search: (s?: number) => svg(`<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>`, s),
  loop: (s?: number) => svg(`<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>`, s),
  zoomOut: (s?: number) => svg(`<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M8 11h6"/>`, s),
  edit: (s?: number) => svg(`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>`, s),
  external: (s?: number) => svg(`<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>`, s),
  photos: (s?: number) => svg(`<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/>`, s),
  download: (s?: number) => svg(`<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/>`, s),
  lock: (s?: number) => svg(`<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`, s),
  trash: (s?: number) => svg(`<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>`, s),
  grid: (s?: number) => svg(`<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>`, s),
  copy: (s?: number) => svg(`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>`, s),
  clock: (s?: number) => svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`, s),
  plug: (s?: number) => svg(`<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>`, s),
};
