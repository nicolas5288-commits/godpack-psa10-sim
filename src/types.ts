

/**
 * Public data contract for the GodPack opening animation.
 * Everything the animation renders is derived from these types — the component
 * never invents an outcome, so the same `PackOutcome` always replays identically.
 */

export type Rarity =
  | "common"
  | "uncommon"
  | "rare"
  | "epic"
  | "legendary"
  | "mythic";

export interface Card {
  id: string;
  name: string;
  /** Flavour line shown under the name plate. */
  subtitle?: string;
  rarity: Rarity;
  /** Any URL an <img> can load. Swap freely for production art. */
  artUrl: string;
  /** e.g. "GOD" — printed on the card's bottom rail. */
  setCode?: string;
  /** e.g. "012/165" — printed on the card's bottom rail. */
  collectorNumber?: string;
  /** Adds the holographic foil sheen regardless of rarity. */
  foil?: boolean;
  /** artUrl is a complete card face — draw it edge-to-edge, skip the generated frame. */
  fullArt?: boolean;
  /** The card's own back face. Omit to fall back to the generated GodPack back. */
  backArtUrl?: string;
  /** Grade wording on the slab label, e.g. "GEM MT" or "MINT". */
  grade?: string;
  /** Numeric grade printed beside the wording, e.g. 10. */
  gradeScore?: number;
  /** Certification number on the slab label. */
  cert?: string;
}

export interface PackOutcome {
  /** Changing this identity restarts the animation. Stable id = stable replay. */
  id: string;
  /**
   * Seeds every piece of visual randomness (particle vectors, jitter, sparkle
   * placement). Two runs with the same seed are frame-for-frame identical.
   */
  seed: number;
  packName: string;
  /** Reveal order is exactly array order. */
  cards: Card[];
  /** Triggers the gold "GOD PACK" treatment across pack, burst and summary. */
  isGodPack: boolean;
}

export type OpeningPhase =
  /** Pack at rest, awaiting input. */
  | "idle"
  /** Player is holding/charging; energy builds inside the pack. */
  | "charging"
  /** Pack tears open, light column erupts. */
  | "bursting"
  /** Stepping through cards one at a time. */
  | "revealing"
  /** All cards shown as a grid. */
  | "summary";

/** Rendering budget. `auto` probes the device once on mount. */
export type QualityTier = "auto" | "high" | "low";

/**
 * `tear` is the drag-to-rip then pull-down peek. `burst` is the Three.js
 * hold-to-charge alternative.
 */
export type OpeningStyle = "tear" | "burst";

export interface PackOpeningCallbacks {
  onPhaseChange?: (phase: OpeningPhase) => void;
  onCardRevealed?: (card: Card, index: number) => void;
  /** Fires once when the final card has been revealed. */
  onComplete?: (outcome: PackOutcome) => void;
  onSkip?: () => void;
}

export interface PackOpeningProps extends PackOpeningCallbacks {
  outcome: PackOutcome;
  /** Opens itself instead of waiting for the first press. */
  autoStart?: boolean;
  openingStyle?: OpeningStyle;
  /** Real pack artwork for the `tear` style; falls back to a generated wrapper. */
  packImageUrl?: string;
  quality?: QualityTier;
  /**
   * `true`/`false` force the setting; omit to follow the OS
   * `prefers-reduced-motion` media query.
   */
  reducedMotion?: boolean;
  /** Hides the built-in Skip / Reset buttons so a host app can supply its own. */
  hideControls?: boolean;
  className?: string;
}

/**
 * Inline styles that also carry CSS custom properties. Lets the components pass
 * `--mx`, `--rarity` etc. through `style` without reaching for a cast.
 */
export type StyleWithVars = Record<string, string | number> & {
  [key: `--${string}`]: string | number;
};

/** Imperative handle so a host app can drive the animation from outside. */
export interface PackOpeningHandle {
  start: () => void;
  skip: () => void;
  reset: () => void;
  next: () => void;
  getPhase: () => OpeningPhase;
}
