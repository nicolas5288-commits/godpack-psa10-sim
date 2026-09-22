/**
 * 靜態站入口：把 godpack-old 分支的 3D 撕包引擎（yuan2838）打包成單一檔案，
 * 掛在 window.GodPackOpen3D 上給 app.js 用。引擎本身不依賴 React。
 */
export { createPackOpen } from "./packOpenEngine";
export type { OpenStage, PackOpenController, PackOpenOptions } from "./packOpenEngine";
export { styleFor, RARITY_STYLES, BRAND_STYLE, GOD_PACK_STYLE } from "./rarity";
export { createRng, deriveSeed, hashSeed } from "./rng";
export type { Card, Rarity } from "./types";
