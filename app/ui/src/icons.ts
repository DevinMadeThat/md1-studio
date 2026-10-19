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
  plug: (s?: number) => svg(`<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>`, s),
};
