import * as THREE from "three";

/**
 * Ported from the shipped godpack.app renderer (godpack-web/js/pack.js +
 * textures.js) — the visual standard for this sandbox. The cut art is treated
 * as a finished offline render: geometry supplies the pillow-pouch silhouette
 * and thickness, the alpha channel supplies the serrated die-cut, and foil
 * creases live only in the normal map so they glint as the light moves.
 */

/**
 * One horizontal slice of the pillow pouch, in pack-absolute coordinates.
 * `v` runs top-down over the FULL pack (0 = top edge, 1 = bottom), so cutting
 * the pouch into strip [0..vTear] and body [vTear..1] keeps the profile,
 * thickness and UVs continuous across the tear line. Both sheets share the
 * same UVs so the die-cut silhouette aligns front/back.
 */
export function pouchSectionGeometry(
  W: number,
  H: number,
  T: number,
  v0: number,
  v1: number,
  segU: number,
  segV: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  // Both seals pressed flat: thickness → 0 at v=0 and v=1 of the full pouch.
  const pinch = (v: number): number => smoothstep(0, 0.15, v) * smoothstep(0, 0.15, 1 - v);
  // Side seams pressed flat, belly at maximum.
  const bulge = (u: number): number => Math.pow(Math.sin(Math.PI * u), 0.62);

  const vertsPerSheet = (segU + 1) * (segV + 1);

  for (let sheet = 0; sheet < 2; sheet += 1) {
    const sign = sheet === 0 ? 1 : -1;
    for (let j = 0; j <= segV; j += 1) {
      const v = v0 + (j / segV) * (v1 - v0);
      for (let i = 0; i <= segU; i += 1) {
        const u = i / segU;
        pos.push((u - 0.5) * W, (0.5 - v) * H, sign * (T / 2) * bulge(u) * pinch(v));
        nor.push(0, 0, sign);
        uv.push(u, 1 - v);
      }
    }
  }

  for (let sheet = 0; sheet < 2; sheet += 1) {
    const base = sheet * vertsPerSheet;
    for (let j = 0; j < segV; j += 1) {
      for (let i = 0; i < segU; i += 1) {
        const a = base + j * (segU + 1) + i;
        const b = a + 1;
        const c = a + (segU + 1);
        const d = c + 1;
        // Back sheet winds the other way so its normals face outward.
        if (sheet === 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);

  // Material groups: 0 = front (print), 1 = back.
  const indicesPerSheet = segU * segV * 6;
  g.addGroup(0, indicesPerSheet, 0);
  g.addGroup(indicesPerSheet, indicesPerSheet, 1);

  g.computeVertexNormals();
  g.computeTangents?.();
  return g;
}

/** 不透明區域的像素邊界，原點在左上。全透明時回 null。 */
export interface AlphaBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 量出去背後袋子真正佔的範圍。
 *
 * 包裝圖四周常有透明邊，而幾何是整張攤到袋子上的（uv.x = u），
 * 透明邊等於也佔了袋子的寬高，袋子本體就被縮小。量出邊界之後把貼圖與遮罩
 * 一起裁到這個範圍，袋子才會填滿幾何、大小跟去背後的圖一致。
 *
 * 門檻取 8 而不是 0：去背邊緣常留一圈接近透明的殘值，全當成不透明會白白把邊界撐大。
 */
export function alphaBounds(img: HTMLImageElement, threshold = 8): AlphaBounds | null {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if ((d[(y * w + x) * 4 + 3] ?? 0) <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Bakes the art's alpha channel into a grayscale mask — three.js reads
 * alphaMap from the green channel, so a black pack can't use its own RGBA.
 */
export function alphaMaskFrom(img: HTMLImageElement): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const a = d.data[i + 3] ?? 0;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = a;
      d.data[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}

// ---------------------------------------------------------------- foil maps

function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Lattice {
  w: number;
  h: number;
  g: Float32Array;
}

function makeLattice(w: number, h: number, rnd: () => number): Lattice {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i += 1) g[i] = rnd();
  return { w, h, g };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function sampleLattice(L: Lattice, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const wrap = (v: number, n: number): number => ((v % n) + n) % n;
  const x0 = wrap(xi, L.w);
  const x1 = wrap(xi + 1, L.w);
  const y0 = wrap(yi, L.h);
  const y1 = wrap(yi + 1, L.h);
  const a = L.g[y0 * L.w + x0] ?? 0;
  const b = L.g[y0 * L.w + x1] ?? 0;
  const c = L.g[y1 * L.w + x0] ?? 0;
  const d = L.g[y1 * L.w + x1] ?? 0;
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}

/**
 * Foil crumple heightfield: broad vertical undulation + seal-adjacent radial
 * wrinkles + fine grain. Creases go into normals only — never into colour —
 * so they flash as the pack turns.
 */
function buildHeight(W: number, H: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const L1 = makeLattice(6, 26, rnd);
  const L2 = makeLattice(14, 60, rnd);
  const L3 = makeLattice(40, 40, rnd);
  const L4 = makeLattice(96, 96, rnd);

  const hgt = new Float32Array(W * H);
  for (let y = 0; y < H; y += 1) {
    const v = y / (H - 1);
    const dSeal = Math.min(v, 1 - v) / 0.5;
    const sealPull = Math.pow(1 - Math.min(dSeal / 0.55, 1), 1.6);
    for (let x = 0; x < W; x += 1) {
      const u = x / (W - 1);
      let n = 0;
      n += 0.55 * sampleLattice(L1, u * L1.w, v * L1.h);
      n += 0.26 * sampleLattice(L2, u * L2.w, v * L2.h);
      n += 0.13 * sampleLattice(L3, u * L3.w, v * L3.h);
      n += 0.06 * sampleLattice(L4, u * L4.w, v * L4.h);
      n = n * 2 - 1;
      const radial = Math.sin(u * Math.PI * 9 + sampleLattice(L2, u * 8, v * 4) * 6);
      n += radial * 0.5 * sealPull;
      const edge = Math.pow(1 - Math.abs(u - 0.5) * 2, 0.5);
      n *= 0.45 + 0.55 * edge;
      hgt[y * W + x] = n;
    }
  }
  return hgt;
}

export interface FoilMaps {
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export function makeFoilMaps(seed = 7, W = 512, H = 768, strength = 0.85): FoilMaps {
  const hgt = buildHeight(W, H, seed);

  const nCanvas = document.createElement("canvas");
  nCanvas.width = W;
  nCanvas.height = H;
  const nCtx = nCanvas.getContext("2d");
  const rCanvas = document.createElement("canvas");
  rCanvas.width = W;
  rCanvas.height = H;
  const rCtx = rCanvas.getContext("2d");

  if (nCtx && rCtx) {
    const nImg = nCtx.createImageData(W, H);
    const rImg = rCtx.createImageData(W, H);
    const at = (x: number, y: number): number =>
      hgt[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] ?? 0;

    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const dx =
          at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
          (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dy =
          at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
          (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));

        let nx = -dx * strength;
        let ny = -dy * strength;
        let nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        ny /= len;
        nz /= len;

        const i = (y * W + x) * 4;
        nImg.data[i] = (nx * 0.5 + 0.5) * 255;
        nImg.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        nImg.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        nImg.data[i + 3] = 255;

        const r = 128 + at(x, y) * 18;
        rImg.data[i] = rImg.data[i + 1] = rImg.data[i + 2] = Math.max(0, Math.min(255, r));
        rImg.data[i + 3] = 255;
      }
    }
    nCtx.putImageData(nImg, 0, 0);
    rCtx.putImageData(rImg, 0, 0);
  }

  const normalMap = new THREE.CanvasTexture(nCanvas);
  const roughnessMap = new THREE.CanvasTexture(rCanvas);
  for (const t of [normalMap, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.colorSpace = THREE.NoColorSpace;
  }
  return { normalMap, roughnessMap };
}

/**
 * Studio PMREM environment for a black pack on a dark stage — RoomEnvironment
 * is far too white and greys the foil. Top softbox, cold left/right rims and
 * a warm gold floor bounce, same rig as the shipped site.
 */
export function makeStudioEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  const add = (
    w: number,
    h: number,
    color: number,
    intensity: number,
    pos: [number, number, number],
    rot?: [number, number, number],
  ): void => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    m.position.set(...pos);
    if (rot) m.rotation.set(...rot);
    env.add(m);
  };

  env.background = new THREE.Color(0x050508);
  add(9, 5, 0xffffff, 2.0, [0, 7, 0], [Math.PI / 2, 0, 0]);
  add(2.2, 9, 0xf3d488, 1.5, [-6.5, 1.5, 1], [0, Math.PI / 2, 0]);
  add(2.2, 9, 0xfff0d2, 1.2, [6.5, 1.5, 1], [0, -Math.PI / 2, 0]);
  add(7, 3, 0xffe6c4, 0.28, [0, -3.5, 2], [-Math.PI / 2, 0, 0]);
  add(6, 4, 0xffffff, 0.35, [0, 1.2, -8], [0, 0, 0]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  env.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) (mesh.material as THREE.Material).dispose();
  });
  return rt.texture;
}

/**
 * 玻璃表面的霧面顆粒，用來當 roughnessMap。
 *
 * 在 transmission 材質上，粗糙度控制的是「透過去的東西有多糊」，所以拿一張細噪聲去調變它，
 * 折射就會變得不均勻，看起來像模壓壓克力表面那層極細的霧面，而不是一塊完美的光學玻璃。
 *
 * 只寫綠色通道有意義（three 的 roughnessMap 讀 G），但三通道一起填以免被當成灰階以外的用途。
 * 噪聲刻意做兩層：大顆粒給不規則的流紋，細顆粒給砂目。
 */
export function makeGlassGrain(size = 256, seed = 11): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  if (!ctx) return texture;

  let state = seed >>> 0;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const image = ctx.createImageData(size, size);
  const coarse = new Float32Array(size * size);
  // 先鋪一層低頻的流紋，再疊高頻砂目，單一頻率的噪聲看起來像雜訊不像玻璃。
  const cells = 16;
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const gy = (y / size) * cells;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = gx - x0;
      const ty = gy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = grid[y0 * (cells + 1) + x0] ?? 0;
      const b = grid[y0 * (cells + 1) + x0 + 1] ?? 0;
      const c = grid[(y0 + 1) * (cells + 1) + x0] ?? 0;
      const d = grid[(y0 + 1) * (cells + 1) + x0 + 1] ?? 0;
      coarse[y * size + x] = (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    }
  }

  for (let i = 0; i < size * size; i++) {
    // 0.62 到 1.0：乘在材質的 roughness 上，所以這是「最多把粗糙度打到六成」。
    const v = 0.62 + (0.26 * (coarse[i] ?? 0) + 0.12 * rand()) * 1.0;
    const b = Math.max(0, Math.min(255, Math.round(v * 255)));
    const o = i * 4;
    image.data[o] = b;
    image.data[o + 1] = b;
    image.data[o + 2] = b;
    image.data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 4);
  texture.needsUpdate = true;
  return texture;
}
