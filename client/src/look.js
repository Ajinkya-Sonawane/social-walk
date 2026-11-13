// Character appearance: the options, validation and random generation.
// Shared by the client and the server (the server imports this file directly).

export const SKIN_TONES = ['#f6d3b8', '#ebbd98', '#d39c74', '#b07850', '#8a5a3a', '#5e3b26'];
export const HAIR_STYLES = ['short', 'long', 'bun', 'curly', 'buzz', 'cap', 'bald'];
export const HAIR_COLORS = ['#1c1714', '#3b2a20', '#6b4a2e', '#a8743f', '#d8b37a', '#9a9a9a', '#b5452b'];
export const TOP_STYLES = ['tee', 'hoodie', 'jacket'];
const HEX = /^#[0-9a-f]{6}$/i;
const TOPS = ['#e4572e', '#2e86de', '#3fa34d', '#f2c14e', '#8e5ad6', '#222831', '#f4f4f4', '#c0392b', '#16a085', '#ff7aa2'];
const PANTS = ['#2f3640', '#34495e', '#1e3a5f', '#5d4e3a', '#7a7f87', '#111111', '#3c4d3a'];
const SHOES = ['#f4f4f4', '#222222', '#7b4b2a', '#c0392b', '#2e86de'];

export const DEFAULT_LOOK = { skin: 1, hairStyle: 'short', hair: '#3b2a20', top: 'tee', topColor: '#2e86de', pants: '#2f3640', shoes: '#f4f4f4' };

export function sanitizeLook(l, fallback = DEFAULT_LOOK) {
  const src = l && typeof l === 'object' ? l : {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const hex = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
  const skin = Number.isInteger(src.skin) && src.skin >= 0 && src.skin < SKIN_TONES.length ? src.skin : fallback.skin;
  return {
    skin,
    hairStyle: pick(src.hairStyle, HAIR_STYLES, fallback.hairStyle),
    hair: hex(src.hair, fallback.hair),
    top: pick(src.top, TOP_STYLES, fallback.top),
    topColor: hex(src.topColor, fallback.topColor),
    pants: hex(src.pants, fallback.pants),
    shoes: hex(src.shoes, fallback.shoes),
  };
}

export function randomLook(rand = Math.random) {
  const r = (list) => list[Math.floor(rand() * list.length)];
  return {
    skin: Math.floor(rand() * SKIN_TONES.length),
    hairStyle: r(HAIR_STYLES.slice(0, 6)),
    hair: r(HAIR_COLORS),
    top: r(TOP_STYLES),
    topColor: r(TOPS),
    pants: r(PANTS),
    shoes: r(SHOES),
  };
}

export const PALETTES = { tops: TOPS, pants: PANTS, shoes: SHOES };
