import type { Rarity } from "./types";

/**
 * Celebration intensity ladder. The reveal reads this rather than branching on
 * rarity directly, so adding a rarity only means adding a row below.
 * 0 none · 1 shine + sparkles · 2 shockwave + burst · 3 full screen rays + shake
 */
export type CelebrationTier = 0 | 1 | 2 | 3;

export interface RarityStyle {
  label: string;
  /** Primary hue, used for the aura ring and gem. */
  color: string;
  /** Lighter partner used for gradients and highlights. */
  accent: string;
  /** Secondary hue for iridescent/dual-tone rarities. */
  secondary: string;
  celebration: CelebrationTier;
  /** Card gets the animated holographic sheen. */
  foil: boolean;
  /** Particle count multiplier for the burst. */
  particleScale: number;
  /** Milliseconds the reveal beat holds before the next card is offered. */
  holdMs: number;
}

export const RARITY_STYLES: Record<Rarity, RarityStyle> = {
  common: {
    label: "Common",
    color: "#a8a29e",
    accent: "#e7e5e4",
    secondary: "#78716c",
    celebration: 0,
    foil: false,
    particleScale: 0,
    holdMs: 320,
  },
  uncommon: {
    label: "Uncommon",
    color: "#34d399",
    accent: "#a7f3d0",
    secondary: "#059669",
    celebration: 0,
    foil: false,
    particleScale: 0.35,
    holdMs: 380,
  },
  rare: {
    label: "Rare",
    color: "#d9a441",
    accent: "#f7dc8f",
    secondary: "#8a6420",
    celebration: 1,
    foil: true,
    particleScale: 0.7,
    holdMs: 620,
  },
  epic: {
    label: "Epic",
    color: "#a78bfa",
    accent: "#ddd6fe",
    secondary: "#7c3aed",
    celebration: 2,
    foil: true,
    particleScale: 1.1,
    holdMs: 820,
  },
  legendary: {
    label: "Legendary",
    color: "#fbbf24",
    accent: "#fef3c7",
    secondary: "#f97316",
    celebration: 3,
    foil: true,
    particleScale: 1.6,
    holdMs: 1100,
  },
  mythic: {
    label: "Mythic",
    color: "#f0abfc",
    accent: "#fde8ff",
    secondary: "#c026d3",
    celebration: 3,
    foil: true,
    particleScale: 2,
    holdMs: 1350,
  },
};

/** Ascending power order — used to find a pack's "best pull". */
export const RARITY_ORDER: readonly Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
  "mythic",
];

export function rarityRank(rarity: Rarity): number {
  return RARITY_ORDER.indexOf(rarity);
}

export function styleFor(rarity: Rarity): RarityStyle {
  return RARITY_STYLES[rarity];
}

export function bestRarity(rarities: readonly Rarity[]): Rarity {
  return rarities.reduce<Rarity>(
    (best, r) => (rarityRank(r) > rarityRank(best) ? r : best),
    "common",
  );
}

/**
 * godpack.app brand palette (site css --gold #d9a441 on #050508). The pack
 * scene always themes with this — rarity hues stay on the card reveals only.
 */
export const BRAND_STYLE = {
  color: "#d9a441",
  accent: "#f7dc8f",
  secondary: "#8a6420",
} as const;

/**
 * Gold treatment applied to the pack shell and burst when isGodPack is set.
 * `color` is the GodPack wordmark yellow sampled off the brand artwork.
 */
export const GOD_PACK_STYLE = {
  color: "#fec508",
  accent: "#fff6d2",
  secondary: "#ecc541",
} as const;
