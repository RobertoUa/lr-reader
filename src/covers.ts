// Book covers: the one inside the file when there is one, else Apple Books search, else Open Library.
// Both APIs answer any origin. Covers are shrunk to a small JPEG data URL so they stay offline and sync cheaply.
const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const COUNTRY: Record<string, string> = { es: "es", fr: "fr", de: "de", it: "it", pt: "pt", en: "us" };

// "Un Planeta Rojo - Nivel Intermedio (B1-B2): ..." -> "un planeta rojo"
const coreTitle = (t: string) => fold(t.replace(/\(.*?\)|\[.*?\]/g, " ").split(/[:\-–|]/)[0]).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
// A hit counts only when its title starts with the book's first words, so an unrelated cover never shows.
const matches = (found: string, title: string) => {
  const want = coreTitle(title).split(" ").slice(0, 3).join(" ");
  return want.length >= 3 && coreTitle(found).replace(/^(el|la|los|las|the|le|les|der|die|das) /, "").startsWith(want.replace(/^(el|la|los|las|the|le|les|der|die|das) /, ""));
};

export async function find(title: string, author: string, sl: string): Promise<string | null> {
  const last = author.split(/[ ,]+/).filter((w) => w.length > 2).pop() || "";
  const term = encodeURIComponent(`${coreTitle(title)} ${fold(last)}`.trim());
  try {
    const r = await (await fetch(`https://itunes.apple.com/search?media=ebook&limit=5&country=${COUNTRY[sl] || "us"}&term=${term}`)).json();
    const hit = (r.results || []).find((x: { trackName: string }) => matches(x.trackName, title));
    if (hit?.artworkUrl100) return hit.artworkUrl100.replace("100x100bb", "400x600bb");
  } catch {}
  const r = await (await fetch(`https://openlibrary.org/search.json?q=${term}&limit=5&fields=cover_i,title`)).json();
  const hit = (r.docs || []).find((x: { title: string; cover_i?: number }) => x.cover_i && matches(x.title, title));
  return hit ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-M.jpg` : null;
}

export async function shrink(src: Blob | string): Promise<string> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  const img = await createImageBitmap(blob);
  const w = Math.min(300, img.width), h = Math.round((img.height * w) / img.width);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.8);
}
