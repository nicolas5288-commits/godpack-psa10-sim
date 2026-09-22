import { createRng, hashSeed } from "./rng";
import { styleFor } from "./rarity";
import type { Card } from "./types";

/**
 * Slab-face texture factory for the continuous 3D opening scene. The pack
 * itself no longer gets composed here — the engine maps the die-cut art file
 * directly (see packSkin.ts), so this file only paints what goes inside the
 * slab: label, card face and card back.
 */

const GOLD = "#e8b64c";
const GOLD_DEEP = "#8a6420";
const GOLD_LIGHT = "#f7dc8f";

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  }).then(async (img) => {
    // 解碼放在 onload 之後、drawImage 之前。少了這一步，第一次把卡圖畫進
    // atlas 時才會在主執行緒同步解 JPEG，剛好撞上撕開的那幾個 frame。
    // decode() 不是每個瀏覽器都有，失敗也只是回到原本的行為。
    try {
      await img.decode?.();
    } catch {
      /* 解碼失敗就交給 drawImage 自己處理 */
    }
    return img;
  });
}

/**
 * 卡圖圖庫的縮圖網址。PriceCharting 的路徑長 `.../<id>/1600.jpg`，
 * 同一層有 12KB 的 240.jpg（沒有 480，實測 404）。
 *
 * 只認這兩種形狀：結尾是 /1600.jpg 的圖庫網址，以及沒有副檔名的目錄路徑。
 * 其他來源（landing 現金卡那種直接給好的圖檔）沒有縮圖，回 null 就好，
 * 不要亂猜一個會 404 的網址。
 */
const LIBRARY_FULL = /\/1600\.jpg$/i;
const HAS_EXTENSION = /\.(jpe?g|png|webp|avif|gif|svg)$/i;

export function thumbUrlFor(url: string): string | null {
  if (LIBRARY_FULL.test(url)) return url.replace(LIBRARY_FULL, "/240.jpg");
  if (!HAS_EXTENSION.test(url)) return `${url}/240.jpg`;
  return null;
}

/**
 * The brand wordmark is the authored logo file, never a system font — the
 * label and card back wait for it via ensureBrandWordmark before drawing.
 */
let brandWordmark: HTMLImageElement | null = null;

export function ensureBrandWordmark(): Promise<void> {
  if (brandWordmark) return Promise.resolve();
  return loadImage("assets/wordmark.webp")
    .then((img) => {
      brandWordmark = img;
    })
    .catch(() => undefined);
}

/** Draws the wordmark left-aligned at (x, centreY) scaled to the given width. */
function drawWordmark(
  ctx: CanvasRenderingContext2D,
  x: number,
  centreY: number,
  width: number,
  align: "left" | "center" = "left",
): boolean {
  if (!brandWordmark) return false;
  const lh = width * (brandWordmark.height / brandWordmark.width);
  ctx.drawImage(brandWordmark, align === "center" ? x - width / 2 : x, centreY - lh / 2, width, lh);
  return true;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return [canvas, ctx];
}

/** Fraction of pack height taken by each crimped seal band. Matches geometry. */
export const PACK_SEAL = 0.06;

// ----------------------------------------------------------------- slab faces

export interface SlabFaces {
  label: HTMLCanvasElement;
  card: HTMLCanvasElement;
  cardBack: HTMLCanvasElement;
}

/**
 * Anodized black-metal slab label, graded-slab layout: brand + name + cert on
 * the left, the grade block on the right, a barcode strip between. The metal
 * itself is fine speckle + brushed grain so light breaks up like real anodize.
 */
export function createLabelTexture(card: Card, w = 840, h = 248): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(w, h);
  const style = styleFor(card.rarity);
  const rng = createRng(0xabe1);

  ctx.fillStyle = "#121110";
  ctx.fillRect(0, 0, w, h);
  // Speckled anodize grain.
  for (let i = 0; i < 3200; i += 1) {
    const v = 20 + Math.floor(rng.next() * 30);
    ctx.fillStyle = `rgba(${v},${v},${v},${(0.2 + rng.next() * 0.3).toFixed(2)})`;
    ctx.fillRect(rng.next() * w, rng.next() * h, 1.2, 1.2);
  }
  // Brushed pull marks.
  for (let i = 0; i < 150; i += 1) {
    const y = rng.next() * h;
    const v = 18 + Math.floor(rng.next() * 20);
    ctx.strokeStyle = `rgba(${v},${v},${v},${(0.1 + rng.next() * 0.16).toFixed(2)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rng.next() * w * 0.3, y);
    ctx.lineTo(w - rng.next() * w * 0.3, y);
    ctx.stroke();
  }
  // Faint brand watermark behind the grade block.
  ctx.strokeStyle = "rgba(232,182,76,0.07)";
  ctx.lineWidth = h * 0.05;
  ctx.beginPath();
  ctx.arc(w * 0.79, h * 0.5, h * 0.62, 0, Math.PI * 2);
  ctx.stroke();

  // Double gold frame.
  ctx.strokeStyle = "rgba(232,182,76,0.75)";
  ctx.lineWidth = 3;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.strokeStyle = "rgba(232,182,76,0.3)";
  ctx.lineWidth = 1;
  ctx.strokeRect(15, 15, w - 30, h - 30);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (!drawWordmark(ctx, w * 0.05, h * 0.22, w * 0.4)) {
    const gold = ctx.createLinearGradient(0, h * 0.12, 0, h * 0.42);
    gold.addColorStop(0, GOLD_LIGHT);
    gold.addColorStop(1, GOLD_DEEP);
    ctx.fillStyle = gold;
    ctx.font = `800 ${h * 0.24}px Georgia, "Times New Roman", serif`;
    ctx.fillText("GODPACK", w * 0.05, h * 0.22);
  }

  // 年份＋系列，對應真鑑定標籤的第一行。沒有資料就整行留空，不要編。
  if (card.subtitle) {
    ctx.fillStyle = "rgba(210,205,190,0.62)";
    ctx.font = `600 ${h * 0.11}px system-ui, sans-serif`;
    ctx.fillText(card.subtitle.toUpperCase(), w * 0.05, h * 0.45, w * 0.44);
  }

  // Fit the name to its column — long real-card names must never run into
  // the barcode or the grade block.
  ctx.fillStyle = "#e7e4da";
  const nameMaxW = w * 0.44;
  let nameSize = h * 0.19;
  const minNameSize = h * 0.09;
  const nameText = card.name.toUpperCase();
  do {
    ctx.font = `700 ${nameSize}px system-ui, sans-serif`;
    if (ctx.measureText(nameText).width <= nameMaxW) break;
    nameSize -= h * 0.01;
  } while (nameSize > minNameSize);
  ctx.fillText(nameText, w * 0.05, h * 0.64, nameMaxW);

  // 卡名底下接編號，跟真的鑑定標籤一樣左欄就是「這是哪一張卡」。
  // 認證碼不印：裸卡根本沒有，先前的 00000000 只是佔位，看起來像壞掉。
  ctx.fillStyle = "rgba(210,205,190,0.7)";
  ctx.font = `500 ${h * 0.13}px system-ui, sans-serif`;
  ctx.fillText(card.collectorNumber ?? "", w * 0.05, h * 0.85);

  // Barcode strip.
  {
    const bx0 = w * 0.52;
    const bx1 = w * 0.66;
    const by0 = h * 0.66;
    const by1 = h * 0.9;
    let bx = bx0;
    // 認證碼不再印在標籤上，但條碼還是要每張不同，所以改用卡片身分當種子。
    const brng = createRng(hashSeed(card.collectorNumber ?? card.name ?? "gp"));
    while (bx < bx1) {
      const bw = 1 + Math.floor(brng.next() * 3);
      if (brng.next() > 0.42) {
        ctx.fillStyle = "rgba(226,222,210,0.82)";
        ctx.fillRect(bx, by0, bw, by1 - by0);
      }
      bx += bw + 1;
    }
  }

  // Right side: graded cards get the grade block, ungraded ones a RAW tag.
  // 「沒鑑定」不等於「隨機」：有卡名有編號的裸卡也走這一支，
  // 印成隨機卡會把一張具名的卡說成沒有身分的普卡。
  ctx.textAlign = "right";
  if (card.grade == null && card.gradeScore == null) {
    ctx.fillStyle = style.color;
    ctx.font = `900 ${h * 0.3}px "Arial Black", "PingFang TC", "Avenir Next Condensed", sans-serif`;
    ctx.fillText("裸卡", w * 0.95, h * 0.42);
    ctx.fillStyle = "rgba(210,205,190,0.55)";
    ctx.font = `600 ${h * 0.12}px system-ui, sans-serif`;
    ctx.fillText("RAW", w * 0.95, h * 0.78);
  } else {
    ctx.fillStyle = style.color;
    ctx.font = `900 ${h * 0.38}px "Arial Black", "Avenir Next Condensed", Impact, sans-serif`;
    ctx.fillText(String(card.gradeScore ?? 10), w * 0.95, h * 0.36);
    ctx.fillStyle = "#cfcabb";
    ctx.font = `900 ${h * 0.15}px "Arial Black", "Avenir Next Condensed", Impact, sans-serif`;
    ctx.fillText(card.grade ?? "GEM MT", w * 0.95, h * 0.66);
  }

  return canvas;
}

/**
 * Frosted inner mat for the slab: translucent white everywhere except clear
 * feathered windows over the card and the label, so the contents read as
 * physically held between panes (the wyrmslate middle-glass trick).
 */
export function createSlabFrostTexture(
  cuts: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  w = 512,
  h = 712,
): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(w, h);
  const rng = createRng(0xf057);

  ctx.fillStyle = "rgba(255,255,255,0.34)";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 2400; i += 1) {
    ctx.fillStyle = `rgba(255,255,255,${(0.05 + rng.next() * 0.16).toFixed(2)})`;
    ctx.fillRect(rng.next() * w, rng.next() * h, 1.4, 1.4);
  }

  // Feathered clear windows.
  ctx.globalCompositeOperation = "destination-out";
  ctx.filter = "blur(7px)";
  ctx.fillStyle = "rgba(0,0,0,1)";
  for (const cut of cuts) {
    ctx.fillRect((cut.x - cut.w / 2) * w, (cut.y - cut.h / 2) * h, cut.w * w, cut.h * h);
  }
  ctx.filter = "none";

  // Fade the outer border so the mat has no hard silhouette edge.
  ctx.globalCompositeOperation = "destination-in";
  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(0.06, "rgba(0,0,0,1)");
  edge.addColorStop(0.94, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
  const edgeX = ctx.createLinearGradient(0, 0, w, 0);
  edgeX.addColorStop(0, "rgba(0,0,0,0)");
  edgeX.addColorStop(0.08, "rgba(0,0,0,1)");
  edgeX.addColorStop(0.92, "rgba(0,0,0,1)");
  edgeX.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = edgeX;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";

  return canvas;
}

/**
 * 卡片圓角半徑，佔卡寬的比例。
 *
 * 真卡是 63mm 寬配約 3mm 圓角，換算 4.8%。裁成透明而不是畫個圓角框：
 * 裝在殼裡時角落透出襯紙，裸卡單獨浮著時角落就是真的缺口。
 */
const CARD_CORNER = 0.048;

/** 把繪圖區裁成圓角矩形，之後畫的東西都會被角落切掉。 */
function clipRoundedCard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = w * CARD_CORNER;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.clip();
}

/** Card front: art window, name plate, rarity rail. */
export function createCardTexture(
  card: Card,
  art: HTMLImageElement | null,
  w = 640,
  h = 896,
): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(w, h);
  const style = styleFor(card.rarity);

  // 圓角先裁再畫，角落就留白（透明），不用事後補遮罩。
  clipRoundedCard(ctx, w, h);

  ctx.fillStyle = "#121110";
  ctx.fillRect(0, 0, w, h);

  if (card.fullArt && art) {
    // Cover-fit the finished card face; no generated frame on top.
    const scale = Math.max(w / art.width, h / art.height);
    const dw = art.width * scale;
    const dh = art.height * scale;
    ctx.drawImage(art, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return canvas;
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = w * 0.012;
  ctx.strokeRect(w * 0.02, w * 0.02, w * 0.96, h - w * 0.04);

  const pad = w * 0.05;
  const artH = h * 0.62;
  if (art) {
    ctx.drawImage(art, pad, pad, w - pad * 2, artH);
  } else {
    ctx.fillStyle = "#242019";
    ctx.fillRect(pad, pad, w - pad * 2, artH);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 2;
  ctx.strokeRect(pad, pad, w - pad * 2, artH);

  ctx.fillStyle = "#f2efe6";
  ctx.font = `700 ${w * 0.072}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(card.name, pad, pad + artH + h * 0.06);
  if (card.subtitle) {
    ctx.fillStyle = "rgba(220,215,200,0.65)";
    ctx.font = `400 ${w * 0.046}px system-ui, sans-serif`;
    ctx.fillText(card.subtitle, pad, pad + artH + h * 0.115);
  }
  ctx.fillStyle = style.color;
  ctx.font = `700 ${w * 0.048}px system-ui, sans-serif`;
  ctx.fillText(style.label.toUpperCase(), pad, h - h * 0.06);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(220,215,200,0.6)";
  ctx.fillText(card.collectorNumber ?? "", w - pad, h - h * 0.06);

  return canvas;
}

/** Card back: the card's own printed back when supplied, else dark field, gold ring, wordmark. */
export function createCardBackTexture(
  backArt: HTMLImageElement | null = null,
  w = 640,
  h = 896,
): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(w, h);

  // 正反面都要圓角，否則翻面時角落會忽然變方的。
  clipRoundedCard(ctx, w, h);
  if (backArt) {
    const scale = Math.max(w / backArt.width, h / backArt.height);
    const dw = backArt.width * scale;
    const dh = backArt.height * scale;
    ctx.drawImage(backArt, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return canvas;
  }
  ctx.fillStyle = "#121216";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(232,182,76,0.8)";
  ctx.lineWidth = w * 0.016;
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.44, w * 0.24, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = GOLD;
  ctx.font = `800 ${w * 0.15}px Georgia, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GP", w / 2, h * 0.44);
  if (!drawWordmark(ctx, w / 2, h * 0.78, w * 0.5, "center")) {
    ctx.font = `italic 600 ${w * 0.07}px "Snell Roundhand", "Brush Script MT", Georgia, cursive`;
    ctx.fillText("godpack.app", w / 2, h * 0.78);
  }
  return canvas;
}

export function createSlabFaces(
  card: Card,
  art: HTMLImageElement | null,
  backArt: HTMLImageElement | null = null,
): SlabFaces {
  return {
    label: createLabelTexture(card),
    card: createCardTexture(card, art),
    cardBack: createCardBackTexture(backArt),
  };
}

/**
 * The six-dot pill that sits on the seal. Nothing else in the scene says where
 * the pack wants to be grabbed — the crimp reads as decoration until you
 * already know it tears.
 */
export function createGripHandleTexture(w = 192, h = 96): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const pad = h * 0.14;
  const x = pad;
  const y = pad;
  const ww = w - pad * 2;
  const hh = h - pad * 2;
  const r = hh / 2;

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + ww - r, y);
  ctx.arc(x + ww - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + hh);
  ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(20, 18, 26, 0.5)";
  ctx.fill();
  ctx.lineWidth = Math.max(2, h * 0.03);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.stroke();

  // Two rows of three: the grip mark every drag handle already trained people on.
  const dot = h * 0.07;
  const gap = dot * 3.2;
  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      ctx.beginPath();
      ctx.arc(w / 2 + (col - 1) * gap, h / 2 + (row - 0.5) * gap, dot, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas;
}
