// Reading appearance modelled on Apple Books: size, theme, font, bold, spacing, margins, justify.
export const THEMES = ["original", "paper", "calm", "focus", "quiet", "night"] as const;
export const FONTS: Record<string, string> = {
  Athelas: "Athelas, Georgia, serif",
  Charter: "Charter, 'Bitstream Charter', Georgia, serif",
  Georgia: "Georgia, serif",
  Iowan: "'Iowan Old Style', Georgia, serif",
  "New York": "ui-serif, 'New York', Georgia, serif",
  Palatino: "Palatino, 'Palatino Linotype', serif",
  "San Francisco": "system-ui, -apple-system, sans-serif",
  Seravek: "Seravek, 'Gill Sans', system-ui, sans-serif",
  Times: "'Times New Roman', Times, serif",
};
const SPACING = { Tight: "1.35", Normal: "1.55", Loose: "1.8" };
const MARGINS = { Narrow: "12px", Normal: "22px", Wide: "38px" };

export type Look = { theme: string; size: number; font: string; bold: boolean; spacing: keyof typeof SPACING; margin: keyof typeof MARGINS; justify: boolean };
const DEFAULT: Look = { theme: "", size: 20, font: "Georgia", bold: false, spacing: "Normal", margin: "Normal", justify: false };

export function load(): Look {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem("look") || "{}") };
  } catch {
    return DEFAULT;
  }
}

// The same vars are applied by the inline script in index.html before first paint.
export function apply(l: Look) {
  const vars = {
    "--font": `${l.size}px`,
    "--family": FONTS[l.font] || FONTS.Georgia,
    "--weight": l.bold ? "600" : "400",
    "--lh": SPACING[l.spacing],
    "--pad": MARGINS[l.margin],
    "--align": l.justify ? "justify" : "start",
  };
  const r = document.documentElement;
  if (l.theme) r.dataset.theme = l.theme;
  else delete r.dataset.theme;
  for (const [k, v] of Object.entries(vars)) r.style.setProperty(k, v);
  try {
    localStorage.setItem("look", JSON.stringify({ ...l, vars }));
  } catch {}
}

const opt = (on: boolean, attrs: string, label: string, style = "") => `<button class="${on ? "on" : ""}" ${attrs} style="${style}">${label}</button>`;

export function panel(l: Look): string {
  const current = l.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "original");
  return `<div class="look-row">${opt(false, 'data-size="-2"', "A", "font-size:14px")}<span class="sub">${l.size}px</span>${opt(false, 'data-size="2"', "A", "font-size:24px")}</div>
    <div class="look-themes">${THEMES.map((t) => `<button data-theme-pick="${t}" class="swatch ${current === t ? "on" : ""}" data-theme-swatch="${t}"><b>Aa</b><span>${t[0].toUpperCase() + t.slice(1)}</span></button>`).join("")}</div>
    <div class="look-row">${opt(l.bold, 'data-toggle="bold"', "Bold text")}${opt(l.justify, 'data-toggle="justify"', "Justify")}</div>
    <div class="look-row"><span class="sub">Lines</span>${Object.keys(SPACING).map((k) => opt(l.spacing === k, `data-spacing="${k}"`, k)).join("")}</div>
    <div class="look-row"><span class="sub">Margins</span>${Object.keys(MARGINS).map((k) => opt(l.margin === k, `data-margin="${k}"`, k)).join("")}</div>
    <div class="look-fonts">${Object.entries(FONTS).map(([name, fam]) => opt(l.font === name, `data-font="${name}"`, name, `font-family:${fam.replace(/"/g, "'")}`)).join("")}</div>`;
}

// Applies a tap in the panel; returns the new look, or null when the tap was not on an option.
export function change(l: Look, b: HTMLElement): Look | null {
  const d = b.dataset;
  if (d.size) return { ...l, size: Math.max(12, Math.min(40, l.size + Number(d.size))) };
  if (d.themePick) return { ...l, theme: d.themePick };
  if (d.toggle === "bold") return { ...l, bold: !l.bold };
  if (d.toggle === "justify") return { ...l, justify: !l.justify };
  if (d.spacing) return { ...l, spacing: d.spacing as Look["spacing"] };
  if (d.margin) return { ...l, margin: d.margin as Look["margin"] };
  if (d.font) return { ...l, font: d.font };
  return null;
}
