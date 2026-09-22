import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createRng, deriveSeed, hashSeed, type Rng } from "./rng";
import { styleFor } from "./rarity";
import {
  createGripHandleTexture,
  createSlabFaces,
  ensureBrandWordmark,
  loadImage,
  PACK_SEAL,
  thumbUrlFor,
} from "./packOpenTextures";
import {
  alphaBounds,
  alphaMaskFrom,
  makeFoilMaps,
  makeGlassGrain,
  makeStudioEnv,
  pouchSectionGeometry,
} from "./packSkin";
import { loadSlabModel } from "./slabModel";
import type { Card } from "./types";

/**
 * The whole tear-style opening as ONE continuous physically lit scene:
 * float/spin → rip the crimp strip off → pull the pouch away → light burst →
 * thick graded slab, card by card. No DOM handoffs, so nothing ever "pops"
 * into a different render — and because every highlight comes from live PBR
 * lights, the pack/card art is swappable data, not baked pixels.
 */

export type OpenStage =
  | "float"
  | "sealed"
  | "tearing"
  | "torn"
  | "pulling"
  | "burst"
  | "slab"
  | "done";

export interface PackOpenColors {
  color: string;
  accent: string;
  secondary: string;
}

export interface PackOpenOptions {
  container: HTMLElement;
  seed: number;
  quality: "high" | "low";
  reducedMotion: boolean;
  colors: PackOpenColors;
  /** Custom wrapper art URL, or null for the built-in godpack print. */
  packArtUrl: string | null;
  logoUrl: string;
  cards: Card[];
  onStage?: (stage: OpenStage) => void;
  onCardShown?: (index: number) => void;
  onFinished?: () => void;
}

export interface PackOpenController {
  rotateBy: (dYaw: number, dPitch: number) => void;
  setDragging: (dragging: boolean) => void;
  /** Full auto: settle front-facing, then tear → pull → first card. */
  open: () => void;
  /** Float tap: settle front-facing and wait sealed for a manual tear. */
  settle: () => void;
  /** Auto-run just the tear (sealed/tearing), then rest at torn. */
  autoTear: () => void;
  /** Auto-run just the pull (torn/pulling), then burst the first card. */
  autoPull: () => void;
  /** 手動撕開：傳游標在畫布上的 x（0..1），撕口前緣會落在那個位置。只進不退。 */
  scrubTear: (stageFractionX: number) => void;
  /** Release mid-rip: commit past threshold, otherwise spring back. */
  endTearScrub: () => void;
  /** Manual peek: slide the pouch down by a 0..1 fraction. */
  scrubPull: (delta: number) => void;
  endPullScrub: () => void;
  /** Slab stage: next card, or finish after the last one. */
  advance: () => void;
  skip: () => void;
  setFit: (ratio: number) => void;
  /** Absolute pointer over the stage in -1..1, y up. Drives tilt and the holo. */
  setPointer: (nx: number, ny: number, over: boolean) => void;
  setPaused: (paused: boolean) => void;
  getStage: () => OpenStage;
  dispose: () => void;
}

/**
 * 卡包長寬比，取自 public/godpack/pack-art.webp 的 864×1520。
 *
 * 貼圖是整片攤平映射上去的（packSkin.ts 的 pouchSectionGeometry：pos.x = (u - 0.5) * W、
 * uv.x = u），袋子只在 z 軸鼓起來，所以正面寬度就是 PACK_W。PACK_W / PACK_H 一旦跟圖的
 * 長寬比不一樣，整張包裝就會被橫向拉伸，而且拉伸量剛好等於兩者的比值。換包裝圖要一起改這裡。
 */
const PACK_ART_ASPECT = 864 / 1520;
const PACK_H = 3.6;
const PACK_W = PACK_H * PACK_ART_ASPECT;
const FOV = 38;
const FACE_FRONT_MS = 640;
/** Tear line, as a bottom-up fraction of pack height (just under the top crimp). */
/**
 * 撕開線的位置，由下往上算的卡包高度比例。
 *
 * 0.88 讓封口帶佔卡包高度 12%。帶寬同時是捲曲半徑的下限：半徑一旦小於帶寬，帶子會翻過
 * 弧心跑到另一側自我穿透。要捲得夠緊、夠右上，帶子就不能太寬。
 * 另一個理由是彎折半徑本來就跟帶寬成正比：
 * 彎折半徑是「帶寬 ÷ 彎折角度」，帶子只有 9% 寬時，彎 150 度的半徑只有 0.12，那必然捲成
 * 一根細管，做不出參考圖那種張開的弧。帶子加寬，同樣的角度半徑就等比放大。
 * 副作用是撕下來的那條會帶到一點主視覺印刷，而不是只有封口壓紋，這跟參考圖一致。
 */
const TEAR_FRAC = 0.88;
/** 拉下時要拖過卡包自身高度的多少比例才算拉滿。 */
const PULL_SPAN = 0.5;
/** Float rotation is front-only — the back is plain foil, so yaw is fenced. */
const YAW_LIMIT = 0.15;
const PITCH_LIMIT = 0.25;
/** Slab lean at the edge of the stage. The reference uses center/3.5 deg. */
const TILT_MAX = 0.25;

const SLAB_H = 3.42;

/**
 * 卡磚揭曉靜止時的大小。
 *
 * 原本靜止在 1.0 時外殼約 2.03 寬、跟卡包（2.05）幾乎等寬，看起來像換了個框
 * 而不是從裡面抽出東西，所以調小讓卡包明顯是容器。入場與退場的補間都以這個值
 * 為終點；裸卡的揭曉尺寸也由它推導，改這一個數字兩種卡會一起走。
 */
const SLAB_SCALE = 0.78;

/** 卡磚滑出袋口時，外殼寬度要佔卡包寬的幾成。 */
const SLAB_PULL_WIDTH_FRAC = 0.9;

/**
 * 裸卡的卡片寬度要佔卡包寬的幾成。
 *
 * 裸卡沒有殼撐場面，卡片得自己站得住，所以另外指定而不是沿用 SLAB_SCALE。
 */
const RAW_CARD_WIDTH_FRAC = 0.9;

/**
 * 卡面平面在 GLB 裡的寬度，換算到 slabGroup 的單位（縮放 1 時）。
 *
 * 量法：wyrmslate.glb 的 Glass_Card003_4 取 POSITION 的 min/max，
 * 乘節點世界縮放、FBX_UNITS(100) 與 slabModelScale(SLAB_H / 135.3)。
 * 模型是固定的所以量一次寫死；SLAB_H 改了要重量。
 */
const CARD_PLANE_W = 1.653;

/** 卡磚外殼在 GLB 裡的寬度，量法同 CARD_PLANE_W。 */
const SLAB_SHELL_W = 2.026;

/**
 * 卡磚滑出袋口時的縮放：外殼寬度等於 SLAB_PULL_WIDTH_FRAC × 卡包寬。
 *
 * 跟裸卡同一個道理，滑出與揭曉的參照對象不同所以分開：滑出時對的是袋口，
 * 揭曉時卡包已退場、對的是版面。共用一個值會讓揭曉太大而蓋掉底下的資訊列。
 */
const SLAB_PULL_SCALE = (PACK_W * SLAB_PULL_WIDTH_FRAC) / SLAB_SHELL_W;

/**
 * 裸卡滑出袋口時的縮放：卡面寬度剛好等於 RAW_CARD_WIDTH_FRAC × 卡包寬。
 *
 * 只用在抽出卡片那一段。那一刻卡片跟卡包同框，寬度關係要讀得出來是從裡面出來的。
 */
const RAW_PULL_SCALE = (PACK_W * RAW_CARD_WIDTH_FRAC) / CARD_PLANE_W;

/**
 * 裸卡揭曉時的縮放：卡面寬度對齊鑑定卡的外殼寬度。
 *
 * 揭曉時卡包已經退場，參照對象換成「另一種卡長怎樣」——
 * 兩種卡佔一樣的畫面寬度，底下那行卡片資訊的位置才不會一種卡壓到、一種卡沒壓到。
 * 沿用滑出時的 0.9 會超出版面把文字蓋掉。
 */
const RAW_REVEAL_SCALE = (SLAB_SHELL_W * SLAB_SCALE) / CARD_PLANE_W;

/**
 * 卡磚靜止時再往上抬多少（單位同 SLAB_H，卡磚高 3.42）。
 *
 * 掛在 slabModel 而不是 slabGroup：slabGroup 的 y 每幀都被閒置浮動覆寫，
 * 常數放上去會被抹掉。slabModel 是它的子層，抬升跟著整組縮放走，比例不會跑掉。
 * 底下那行卡片資訊要一起往上，見 PackOpeningOverlay 的 RevealInfo。
 */
const SLAB_LIFT = 0.3;

/** 卡磚頂端要縮在袋口底下多少，留一點餘裕給袋口的捲曲與晃動。 */
const SLAB_POUCH_MARGIN = 0.06;

/**
 * 卡磚還在袋子裡時的高度。
 *
 * 卡磚連同 SLAB_LIFT 之後頂端落在 y≈1.83，比撕開後的袋口（tearY≈1.37）還高，
 * 所以袋子都還沒拉下來，整個頂端就已經穿出袋口。這裡把它壓回袋口底下，
 * 揭曉補間會再把 y 帶回 0，位移只活在「還在袋子裡」的那一段。
 */
const SLAB_POUCH_Y =
  (TEAR_FRAC - 0.5) * PACK_H
  - (SLAB_H / 2 + SLAB_LIFT) * SLAB_PULL_SCALE
  - SLAB_POUCH_MARGIN;


export function createPackOpen(options: PackOpenOptions): PackOpenController {
  const { container, quality, reducedMotion, colors, cards } = options;
  const high = quality === "high";
  const rng = createRng(options.seed);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);

  const renderer = new THREE.WebGLRenderer({
    antialias: high,
    alpha: true,
    powerPreference: "high-performance",
  });
  // 不透明地清成頁面自己的底色。
  //
  // 這是啟用 transmission 的前提：three 的 renderTransmissionPass 在 getClearAlpha() < 1 時
  // 會把透射用的背景清成「半透明白」，於是每一片透射材質都在折射一張白紙，玻璃就變乳白。
  // 畫布後面只有 <main> 的純色底，沒有任何 CSS 圖層，所以改成不透明在畫面上完全等價。
  // 純黑。原本的 0x050508 是線性值，OutputPass 轉成 sRGB 之後會亮成深藍灰
  // （約 #272730），在黑底頁面上看起來像畫布浮了一層。alpha 仍是 1，
  // transmission 需要的不透明底色不受影響。
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  // 卡磚在袋子裡的那一段靠裁切面藏住，見 pouchClip。
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  // ------------------------------------------------------------ environment
  // Studio rig from the shipped site — RoomEnvironment is too white for a
  // black foil pack and greys everything it reflects.
  scene.environment = track(makeStudioEnv(renderer));

  const key = new THREE.DirectionalLight(0xfff4e2, 2.0);
  key.position.set(2.6, 2.4, 3.4);
  scene.add(key);
  const accent = new THREE.PointLight(new THREE.Color(colors.accent), 26, 12, 1.8);
  accent.position.set(-2.8, 1.2, 2.4);
  scene.add(accent);
  const rim = new THREE.PointLight(new THREE.Color(colors.color), 20, 14, 1.7);
  rim.position.set(2.2, -1.4, -3.0);
  scene.add(rim);
  scene.add(new THREE.AmbientLight(0x262118, 1.4));
  /** Reveal flash — intensity is tweened, everything else static. */
  const flash = new THREE.PointLight(new THREE.Color(colors.accent), 0, 22, 1.5);
  flash.position.set(0, 0.3, 2.2);
  scene.add(flash);

  // --------------------------------------------------------------- composer
  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  const BLOOM_BASE = 0.32;
  if (high) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_BASE, 0.85, 0.82);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    // MSAA in the composer target so alphaToCoverage can feather the die-cut
    // serration instead of the hard alphaTest cliff.
    composer.renderTarget1.samples = 4;
    composer.renderTarget2.samples = 4;
    disposables.push({ dispose: () => composer?.dispose() });
  }

  // -------------------------------------------------------------- pack mesh
  // godpack.app material strategy: the cut art is a finished offline render —
  // the diamond sparkle, metal relief and shadows are already painted in. So
  // diffuse is zeroed (black) and the art rides emissiveMap 1:1; scene lights
  // only add a thin clearcoat/env reflection layer, which is the moving
  // highlight that reads as real 3D. Serration comes free from the art's
  // alpha channel — no procedural die-cut, no repainting.
  const foil = makeFoilMaps(7, 512, 768, 0.85);
  const foilNormal = track(foil.normalMap);
  const foilRough = track(foil.roughnessMap);

  const packFrontMaterial = track(
    new THREE.MeshPhysicalMaterial({
      color: 0x000000,
      metalness: 0,
      roughness: 0.34,
      emissive: 0xffffff,
      // Raised to 1.12 once the art texture lands — a mapless white emissive
      // would flash the whole pouch white on first paint.
      emissiveIntensity: 0,
      envMapIntensity: 0.55,
      clearcoat: 0.35,
      clearcoatRoughness: 0.18,
      normalMap: foilNormal,
      normalScale: new THREE.Vector2(0.16, 0.16),
      roughnessMap: foilRough,
      alphaTest: 0.5,
      alphaToCoverage: true,
      side: THREE.FrontSide,
    }),
  );
  const packBackMaterial = track(
    new THREE.MeshPhysicalMaterial({
      color: 0x000000,
      metalness: 0,
      roughness: 0.48,
      emissive: 0x1b1a17,
      emissiveIntensity: 0.3,
      envMapIntensity: 0.33,
      clearcoat: 0.2,
      clearcoatRoughness: 0.3,
      normalMap: foilNormal,
      normalScale: new THREE.Vector2(0.16, 0.16),
      roughnessMap: foilRough,
      alphaTest: 0.5,
      alphaToCoverage: true,
      side: THREE.FrontSide,
    }),
  );
  // Strip gets clones so it can fade out as it flies off.
  const stripFrontMaterial = track(packFrontMaterial.clone());
  const stripBackMaterial = track(packBackMaterial.clone());
  stripFrontMaterial.transparent = true;
  stripBackMaterial.transparent = true;
  // The curl swings the strip's inner face through grazing angles, which is
  // where the studio env map used to blow it out into a white band. Drop the
  // reflection to nothing and let the emissive foil carry that face alone.
  stripBackMaterial.envMapIntensity = 0.04;
  stripBackMaterial.roughness = 0.72;
  stripBackMaterial.clearcoat = 0;

  // Pillow pouch from the site: pinch() presses both seals flat (no open top),
  // bulge() puffs the belly. Cut into strip + body along the tear line with a
  // shared full-range v so profile, thickness and UVs stay continuous.
  const PACK_T = PACK_W * 0.3;
  const V_TEAR = 1 - TEAR_FRAC;
  const segU = high ? 72 : 44;
  const bodyGeo = track(pouchSectionGeometry(PACK_W, PACK_H, PACK_T, V_TEAR, 1, segU, high ? 100 : 64));
  // 縱向分段從 10 加到 24：帶子加寬又要彎 150 度，段數不夠弧會有稜。
  const stripGeo = track(pouchSectionGeometry(PACK_W, PACK_H, PACK_T, 0, V_TEAR, segU, high ? 24 : 16));

  const tearY = (TEAR_FRAC - 0.5) * PACK_H;
  const bodyGroup = new THREE.Group();
  bodyGroup.add(new THREE.Mesh(bodyGeo, [packFrontMaterial, packBackMaterial]));

  const stripPivot = new THREE.Group();
  stripPivot.position.set(-PACK_W / 2, tearY, 0);
  const stripInner = new THREE.Group();
  stripInner.position.set(PACK_W / 2, -tearY, 0);
  stripInner.add(new THREE.Mesh(stripGeo, [stripFrontMaterial, stripBackMaterial]));
  stripPivot.add(stripInner);

  // ---------------------------------------------------------------- the curl
  /** 封口帶在撕開線以上的高度，也就是這條弧要走完的弧長。 */
  const STRIP_H = PACK_H / 2 - tearY;
  /**
   * 掀起來那段圓弧的半徑。
   *
   * 彎的軸是 z（指向鏡頭），也就是帶子在「畫面平面內」彎。這是它看得見的唯一理由：
   * 畫面平面內的彎不會被正投影壓掉，而繞任何一條躺在卡包表面上的軸去彎都會。
   * 0.62 讓撕到底時整條剛好走完約 190 度，自由端會倒回撕口正上方，就是參考圖那個鉤狀。
   */
  /**
   * 掀起來那段弧的半徑。
   *
   * 下限是封口帶寬度（0.432）：半徑一旦小於帶寬，帶子會翻過弧心跑到另一側自我穿透。
   * 1.55 是被「自由端要停在右上方」反推出來的：整條弧長就是撕開的長度（約 2.05），
   * 而弧只能在 90 到 180 度之間結束，超過 180 度切線就轉向下、自由端會掉到撕開線底下。
   * 可用的角度只有約 78 度，配上 2.05 的弧長，半徑就只能是這個量級。
   */
  const arcRadius = 1.55;
  /** 撕開時卡包轉幾度的倍率，0 就是鎖正面。 */
  const leanAmount = 1;
  /**
   * 掀起方向：帶子一離開撕口時的前進方向，從「沿著卡包往左」起算。
   * 0 = 往左拖著走，90 度 = 從撕口直接往上立，超過 90 度 = 一離開撕口就往右倒。
   * 這個角度決定整條的走向；arcMax 決定它走到最後捲成什麼樣。
   *
   * 1.75（100 度）超過 90 度，所以帶子一離開撕口的切線就就朝右上，整條往右邊倒。
   * 低於 90 度會先往左拖一段才轉回來，那就是先前「前半段在左上」的原因。
   */
  const liftAngle = 1.75;
  /**
   * 弧平面的傾角：抬升裡有多少比例是「往鏡頭」而不是「往上」。
   *
   * 0 = 弧完全在畫面平面內，等於在卡包表面上畫一條弧，看起來是貼著的。
   * 0.95（54 度）讓抬升分成 cos 54 度往上、sin 54 度往前，箔膜是從卡包正面被掀起來的，
   * 本來就該往鏡頭方向翹出來。往前的位移還會讓它離鏡頭更近、在畫面上變大並蓋住袋身，
   * 這是它讀起來像立體的主要線索。
   */
  const planeTilt = 0.95;
  /**
   * 扭轉角：截面繞著弧的切線轉。過 90 度會看到帶子的側面，接近 180 度會露出無印刷的內面。
   * 0.55（31 度）只取到「箔膜沿著長邊反光會變化」的程度，不到遮住印刷面的地步。
   */
  const twistAngle = 0.55;
  /** 撕開線的斜度：0 = 撕口是垂直線。0.15 讓上緣稍微早一點撕開，撕口不會是一條死板的直線。 */
  const tearSlant = 0.15;
  /**
   * 弧最多走幾弧度。4.2 約 240 度。
   *
   * 超過 180 度是「往右上方捲」的必要條件：過了 180 度弧的切線才會轉向右上，
   * 自由端才跑得到撕口的右上方去。停在 180 度以內，自由端永遠只會在撕口左上方。
   * 超過上限的長度沿切線直走，避免帶子捲進自己裡面。
   */
  const arcMax = 3.1;

  /** Rest pose, kept so every curl is recomputed from scratch rather than fed back. */
  const stripPosAttr = stripGeo.getAttribute("position");
  const stripPos = stripPosAttr.array as Float32Array;
  const stripRestPos = Float32Array.from(stripPos);

  /**
   * 摺線走到哪，以卡包寬度的比例表示。刻意是恆等函數：撕開進度就是摺線位置，
   * 而 scrubTear 又把游標位置直接當成撕開進度，所以三者是同一個數字，游標到哪就撕到哪。
   * 原本會乘上一個 1 以上的係數，害摺線在進度 0.85 就抵達右緣，最後 15% 的拖曳完全沒反應。
   */
  const curlFront = (amount: number): number => amount;

  /**
   * Rolls the strip around the tear line, front to back across its width: at any
   * instant the left columns are fully rolled, the right ones still flat, and
   * 一段固定寬度的圓角摺痕落在兩者之間。整條一起動看起來會像百葉窗，不像掀開。
   *
   * A pure coordinate warp, so the pouch's front, back and thickness bend as one
   * body; normals ride the same rotation, which is what keeps the foil's
   * highlight travelling instead of freezing to the flat pose.
   */
  /**
   * 把撕口左邊那段掀起來，讓它沿一條圓弧走。
   *
   * 攤平的帶子，其「長度」方向沿 x，「寬度」方向沿 y。撕口左邊的部分離開卡包之後，
   * 就沿著一條在畫面平面（x-y）內的圓弧前進：離撕口 b 遠的材料，走到弧上 b / R 的角度。
   * 角度過 90 度之後，弧的切線開始往右轉，自由端就往回倒 —— 這就是「左邊向右邊捲」。
   * 帶子的寬度方向始終垂直於弧的切線，所以整條是一條等寬的緞帶，不是一片斜板。
   *
   * 先前的寫法是繞水平撕開線彎，再加一個線性的抬升。線性抬升畫出來必然是直斜線，
   * 而且它的量級蓋過彎曲本身，所以結果是一片平板。
   */
  const curlStrip = (amount: number): void => {
    const foldX = (curlFront(amount) - 0.5) * PACK_W;
    // 起算角不能超過總捲曲角，否則 phi 會被夾死在 arcMax，整條退化成一片不動的平面。
    const phiStart = Math.min(liftAngle, arcMax - 0.05);
    const sinLift = Math.sin(phiStart);
    const cosLift = Math.cos(phiStart);
    const cosPlane = Math.cos(planeTilt);
    const sinPlane = Math.sin(planeTilt);
    for (let i = 0; i < stripRestPos.length; i += 3) {
      const restX = stripRestPos[i] ?? 0;
      const restY = stripRestPos[i + 1] ?? 0;
      const restZ = stripRestPos[i + 2] ?? 0;
      // 帶子上的高度，0 在撕開線、STRIP_H 在最上緣。
      const w = restY - tearY;
      // 離撕口多遠。tearSlant 讓上緣比下緣早撕到，撕口就從垂直變成斜的。
      const b = foldX - restX + tearSlant * w;
      if (b <= 0) {
        stripPos[i] = restX;
        stripPos[i + 1] = restY;
        stripPos[i + 2] = restZ;
        continue;
      }
      // 走到弧上的角度。從 liftAngle 起算，所以帶子一離開撕口就已經翹著。
      const phi = Math.min(phiStart + b / arcRadius, arcMax);
      // 超過上限的長度沿最後的切線直走，弧才不會捲進自己裡面。
      const extra = Math.max(0, b - (phi - phiStart) * arcRadius);
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      // 弧上的中心線。扣掉起算角，b = 0 時才會剛好落在撕口上。
      const cx = foldX - arcRadius * (sinP - sinLift) - extra * cosP;
      const cy = arcRadius * (cosLift - cosP) + extra * sinP;
      // 截面繞切線扭轉，轉越多越看得到帶子的側面與內面。
      const tw = twistAngle * (arcMax > 1e-4 ? phi / arcMax : 0);
      const cosT = Math.cos(tw);
      const sinT = Math.sin(tw);
      // 寬度方向固定朝上，不跟著切線轉。
      //
      // 先前是讓截面垂直於切線，那在數學上比較「正確」，但切線一過 90 度 cos 就變負，
      // 寬度方向跟著指向下方，帶子整個翻面、上緣跑到下面去。掀起方向是 100 度，
      // 所以它一離開撕口就已經是翻的。改成固定朝上，上緣就永遠是上緣。
      //
      // 傾角只作用在弧本身的抬升、不作用在寬度上，這樣 b 趨近 0 時位置會剛好接回原狀，
      // 撕口不會出現一道突然變矮的接縫。
      stripPos[i] = cx;
      stripPos[i + 1] = tearY + cy * cosPlane + w * cosT;
      stripPos[i + 2] = restZ + cy * sinPlane - w * sinT;
    }
    stripPosAttr.needsUpdate = true;
    stripGeo.computeVertexNormals();
  };

  // -------------------------------------------------------------- grip handle
  // Parented to stripPivot, so it tracks the peel for free and leaves with it.
  const gripTexture = track(new THREE.CanvasTexture(createGripHandleTexture()));
  gripTexture.colorSpace = THREE.SRGBColorSpace;
  const gripMaterial = track(
    new THREE.SpriteMaterial({ map: gripTexture, transparent: true, depthTest: false }),
  );
  const grip = new THREE.Sprite(gripMaterial);
  /**
   * 拉鍊在封口帶上的高度，0 是撕開線（撕開口）、1 是卡包最上緣。
   *
   * 貼著撕開口的上緣，不要往鋸齒帶中間跑：拉鍊要標示的是「從這裡撕」，
   * 離撕開線越遠就越不像撕開的起點，比較像封口上的裝飾。
   */
  const GRIP_Y_FRAC = 0.22;
  grip.scale.set(PACK_W * 0.185, PACK_W * 0.0925, 1);
  grip.position.set(PACK_W * 0.26, STRIP_H * GRIP_Y_FRAC, PACK_T * 0.8);
  grip.renderOrder = 20;
  stripPivot.add(grip);

  const packGroup = new THREE.Group();
  /**
   * 包裝圖到位之前先不要出現。
   *
   * 幾何是同步建好的、貼圖是非同步載的，兩者中間會先閃一個沒有印刷的素袋子，
   * 再被印刷「蓋」上去，看起來像載到一半被看見。等貼圖好了再一起現身。
   * 失敗也要現身，否則圖掛掉就永遠看不到卡包。
   */
  packGroup.visible = false;
  packGroup.add(bodyGroup, stripPivot);
  scene.add(packGroup);

  // Hot spot pinned to the seam as it lets go. Riding packGroup keeps it welded
  // to the pack through the tremor, and it feeds the bloom pass for free.
  /** 撕開漏光的最大強度。撕完由 finishTear 收回 0，不然會跟開卡爆光疊在一起把畫面燒白。 */
  const lightPeak = high ? 26 : 16;
  /** 漏光落在已撕開區域的哪裡。0 = 一直待在最左緣，1 = 跟著撕口跑。 */
  const lightBias = 0.28;
  /**
   * 撕完之後開口殘留的亮度，佔 lightPeak 的比例。
   *
   * 不能留在全亮：撕開的亮度曲線是單調上升的，撕完會停在最亮，
   * 再疊上開卡的爆光整個畫面會燒白（原本因此直接收成 0）。
   * 收成一小段殘光，開口就還看得出來是「破了一個會漏光的口」。
   */
  const OPENING_GLOW = 0.16;
  const tearLight = new THREE.PointLight(0xffd9a0, 0, 5.5, 2.2);
  tearLight.position.set(-PACK_W / 2, tearY, PACK_T * 0.9);
  packGroup.add(tearLight);

  /** Brightest mid-rip, and welded to the roll front so it lights the seam that
   * is actually letting go rather than a point that merely tracks progress. */
  const updateTearLight = (v: number): void => {
    const front = Math.min(1, curlFront(v));
    // 光是從已經撕開的縫裡漏出來的，不是撕開前緣本身在發光。所以它待在偏左的已開區域，
    // 只隨著開口變大往右移一點，左上角那圈溢出輪廓的暖光才會一路都在。
    tearLight.position.x = (front * lightBias - 0.5) * PACK_W;
    // 單調變亮。原本的 sin(vπ) 會在撕到一半最亮、撕完反而暗回去，跟「開口越大漏越多光」相反。
    tearLight.intensity = Math.pow(Math.min(1, v), 0.7) * lightPeak;
  };

  // The die-cut art arrives async; until then the pouch renders as dark foil.
  let alive = true;
  loadImage(options.packArtUrl ?? "assets/pack-cut.webp")
    .then((img) => {
      if (!alive) return;
      const artTex = track(new THREE.Texture(img));
      artTex.colorSpace = THREE.SRGBColorSpace;
      artTex.anisotropy = Math.min(high ? 8 : 4, renderer.capabilities.getMaxAnisotropy());
      artTex.needsUpdate = true;
      /**
       * 裁到去背後的袋子本體。
       *
       * 幾何是整張圖攤上去的（packSkin 的 uv.x = u），所以圖四周的透明邊
       * 同樣佔掉袋子的寬高，袋子就比該有的小一圈 —— op-17 實測只填到 82% 寬。
       * 把貼圖與遮罩用同一組 offset/repeat 裁到不透明範圍，袋子才會填滿幾何。
       * 沒有透明邊的圖（例如內建那張）量出來就是整張，offset 0、repeat 1，等於沒動。
       */
      const bounds = alphaBounds(img);
      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;
      /** 貼圖與遮罩要裁成同一塊，錯開一個像素就會在袋子邊緣露出破綻。 */
      const cropToPouch = (tex: THREE.Texture): void => {
        if (!bounds) return;
        // 兩張貼圖都是 flipY，所以 offset.y 從底邊算起。
        tex.offset.set(bounds.x / imgW, 1 - (bounds.y + bounds.h) / imgH);
        tex.repeat.set(bounds.w / imgW, bounds.h / imgH);
        tex.needsUpdate = true;
      };
      cropToPouch(artTex);

      // 比例要拿裁切後的袋子來比，不是整張圖 —— 透明邊會把比例算歪。
      const drawn = bounds ? bounds.w / bounds.h : imgW / Math.max(1, imgH);
      if (Math.abs(drawn - PACK_ART_ASPECT) > 0.01) {
        console.warn(
          `[godpack] 包裝圖長寬比 ${drawn.toFixed(4)} 與 PACK_ART_ASPECT ${PACK_ART_ASPECT.toFixed(4)} 不符，`
            + `畫面會被拉伸 ${(drawn / PACK_ART_ASPECT).toFixed(3)} 倍。請一併更新 packOpenEngine.ts 的 PACK_ART_ASPECT。`,
        );
      }
      const mask = track(alphaMaskFrom(img));
      cropToPouch(mask);
      // 正反面同一張圖。撕開後封條捲起來露出的是內面，素箔會穿幫。
      // 背面材質原本的 emissive 是 0x1b1a17（幾乎全黑），而 emissivemap 是
      // 用乘的（totalEmissiveRadiance *= emissiveColor），直接掛貼圖會被乘成
      // 黑的等於沒掛，所以要同時把 emissive 提到白色。
      for (const m of [
        packFrontMaterial,
        stripFrontMaterial,
        packBackMaterial,
        stripBackMaterial,
      ]) {
        m.emissiveMap = artTex;
        m.emissive.setHex(0xffffff);
        m.emissiveIntensity = 1.12;
      }
      for (const m of [packFrontMaterial, packBackMaterial, stripFrontMaterial, stripBackMaterial]) {
        m.alphaMap = mask;
        m.needsUpdate = true;
      }
      // 印刷都上好了才讓卡包現身，這樣袋子與封面是同一幀出現的。
      packGroup.visible = true;
    })
    .catch(() => {
      // 圖載不到就退回素袋子，總比整個看不到好。
      packGroup.visible = true;
    });

  // ------------------------------------------------------------------- slab
  const slabGroup = new THREE.Group();
  slabGroup.visible = false;
  slabGroup.position.z = -0.16;
  slabGroup.position.y = SLAB_POUCH_Y;
  // 入場前的預設值。真正的目標縮放由 dressSlab 決定（鑑定卡 SLAB_SCALE、裸卡 RAW_SCALE）。
  slabGroup.scale.setScalar(SLAB_SCALE);
  scene.add(slabGroup);

  /**
   * 袋口裁切面：卡磚只畫在袋口以上。
   *
   * 袋子是枕形的，側邊縫線處厚度收到 0（bulge(u) 在 u=0/1 是 0），而卡殼有固定厚度，
   * SLAB_DEPTH 還特地把它撐厚。只要卡磚夠寬，留在袋子裡的那段一定會從袋面穿出來，
   * 這不是縮小或往後推能解決的：縮到不穿透就細得不像從袋子裡抽出來的東西。
   * 改成不畫它 —— 袋口以下直接裁掉，袋子拉到哪就露到哪，任何角度都穿不出來。
   */
  const pouchClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let pouchClipOn = false;
  const clipNormal = new THREE.Vector3();
  const clipPoint = new THREE.Vector3();

  /** 把裁切面掛上或卸下卡磚的每一個材質。平面數量一變 three 會自己重編 shader。 */
  const setPouchClip = (on: boolean): void => {
    pouchClipOn = on;
    slabGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) m.clippingPlanes = on ? [pouchClip] : null;
    });
  };

  /** 袋口在世界空間的位置，跟著袋子的下移與傾斜走，所以拉的過程裁切線始終貼著袋口。 */
  const syncPouchClip = (): void => {
    if (!pouchClipOn) return;
    bodyGroup.updateWorldMatrix(true, false);
    clipPoint.set(0, tearY, 0).applyMatrix4(bodyGroup.matrixWorld);
    clipNormal.set(0, 1, 0).transformDirection(bodyGroup.matrixWorld);
    pouchClip.setFromNormalAndCoplanarPoint(clipNormal, clipPoint);
  };

  // The real wyrmslate case, baked from the FBX: chamfered front/back plates,
  // middle frame, inner pocket and frost mat. Moulded-acrylic read comes from
  // the true geometry + crisp fresnel; high tier adds refraction (transmission).
  /**
   * 卡殼：真正的玻璃。
   *
   * 先前這裡是 opacity 0.07 的「幾乎不存在」，因為 transmission 會被 three 的白色背景 bug
   * 弄成乳白（見上面 setClearColor 的註解）。底色改成不透明之後那個限制就不存在了，
   * 可以直接用 transmission 做真實折射：厚度撐出體積、ior 1.49 是真實壓克力、
   * 一點點虹彩讓倒角在轉動時有色散，這三個加起來才有立體感。
   *
   * transmission 會多一個 render target，所以低畫質維持舊的近乎透明做法。
   */
  /**
   * 卡殼：真正的玻璃。
   *
   * 先前這裡是 opacity 0.07 的「幾乎不存在」，因為 transmission 會被 three 的白色背景 bug
   * 弄成乳白（見上面 setClearColor 的註解）。底色改成不透明之後那個限制就不存在了。
   *
   * 立體感來自三件事疊加，缺一個都只會變亮而不會變立體：
   *   thickness  讓光穿過時偏折，後面卡片的邊緣會錯位，眼睛就讀到「這塊有厚度」
   *   iridescence 讓倒角在轉動時出現色散
   *   envMapIntensity 拉高，讓模壓的圓角抓到棚燈的長條反光
   *
   * 不分畫質一律開。transmission 只多一個 render target，而整個場景裡只有這一片卡殼用到，
   * 它又只在開卡結束後出現，不跟撕開的重負載重疊。
   */
  /** 玻璃表面的霧面顆粒。調變粗糙度，讓折射不均勻。 */
  const glassGrain = track(makeGlassGrain());
  const acrylicMaterial = track(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      // 高清：回到近乎完美的光學面。顆粒貼圖留著但基底壓到 0.05，
      // 實際落在 0.031~0.05 —— 只在反射裡留下極細的不規則，不會讓卡片變糊。
      roughness: 0.05,
      roughnessMap: glassGrain,
      transmission: 1,
      thickness: 0.5,
      ior: 1.52,
      // 黑玻璃的性格幾乎全在反射上：本體幾乎不透光，你看到的是它映出來的環境。
      // 所以清漆和環境強度都要拉滿，倒角才會出現那條銳利的白線。
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      clearcoatRoughnessMap: glassGrain,
      specularIntensity: 1,
      envMapIntensity: 2.8,
      // 顏色由吸收做，不由 color 做。
      //
      // color 會把反射一起染黑，那就變成黑塑膠；attenuation 只吸收「穿過去」的光，
      // 反射保持乾淨，這才是煙燻黑玻璃。距離 1.6 對上 0.5 的厚度，穿透率約六成，
      // 卡片看得清楚但明顯壓暗、偏冷。要更黑就把距離調小。
      attenuationColor: new THREE.Color(0x1a1d24),
      attenuationDistance: 1.6,
      // 倒角保留一點色散，純黑會顯得死板。
      iridescence: 0.2,
      iridescenceIOR: 1.35,
    }),
  );

  /** 卡片後面的霧面墊。磨砂玻璃而不是半透明白片，卡片邊緣才會有一圈柔和的散射。 */
  const frostMaterial = track(
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      metalness: 0,
      roughness: 0.82,
      clearcoat: 0.4,
      clearcoatRoughness: 0.6,
      envMapIntensity: 0.9,
      depthWrite: false,
    }),
  );

  // FBX source units: the inner card brick spans 80 x 135.3, centred at y≈77.75.
  const slabModelScale = SLAB_H / 135.3;
  /**
   * 卡殼的實體厚度倍率。
   *
   * 只加材質的 thickness 會讓折射更強、顏色更深，但側邊看起來一樣薄 —— 那是光學厚度，
   * 不是幾何厚度。把 z 撐開才會真的變厚：模壓的側面變寬、傾斜時看得到殼的斷面，
   * 而且卡片平面跟著往裡面退，卡片和殼面之間出現可見的空氣層。
   */
  const SLAB_DEPTH = 2.6;
  const slabModel = new THREE.Group();
  slabModel.scale.set(slabModelScale, slabModelScale, slabModelScale * SLAB_DEPTH);
  slabModel.position.y = -77.75 * slabModelScale + SLAB_LIFT;

  // The FBX label/card planes sample fixed rects of one 596x1000 atlas (the
  // layout of textures/Blaze.jpg). Drawing each card into those rects turns
  // the brick into a reusable template — any card art, same moulded model.
  const ATLAS_W = 596;
  const ATLAS_H = 1000;
  const LABEL_RECT = { x: 43.9, y: 42.2, w: 503.1, h: 143.8 } as const;
  const CARD_RECT = { x: 66.8, y: 263.0, w: 464.4, h: 650.7 } as const;
  /**
   * 清除卡片區塊時要多往外推的邊界。
   *
   * 卡面平面的 UV 剛好貼齊 CARD_RECT，雙線性取樣與 mipmap 會把緊鄰在外的
   * 圖集內容拉進來。裸卡時外面是襯紙的米白，於是沿著方形的幾何邊界描出一條
   * 細白線 —— 圓角明明切掉了，那條線卻還是方的。清掉外圈就不會被取樣到。
   */
  const CARD_BLEED = 8;
  const frontAtlas = document.createElement("canvas");
  frontAtlas.width = ATLAS_W;
  frontAtlas.height = ATLAS_H;
  const backAtlas = document.createElement("canvas");
  backAtlas.width = ATLAS_W;
  backAtlas.height = ATLAS_H;
  const frontTex = track(new THREE.CanvasTexture(frontAtlas));
  const backTex = track(new THREE.CanvasTexture(backAtlas));
  for (const t of [frontTex, backTex]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  const innerFrontMaterial = track(
    new THREE.MeshPhysicalMaterial({
      map: frontTex,
      metalness: 0.1,
      roughness: 0.5,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.5,
      /**
       * 卡片貼圖的四角是透明的（圓角）。
       *
       * 用 alphaTest 而不是 transparent：transparent 會把這個平面丟進透明佇列，
       * 跟外殼的 transmission 重新排序，鑑定卡那條路徑有可能連帶出問題。
       * alphaTest 只是丟棄低透明度的像素，鑑定卡的圖集底下是不透明襯紙、
       * alpha 全是 1，一個像素都不會被丟，等於完全不受影響。
       */
      alphaTest: 0.5,
    }),
  );

  // ------------------------------------------------------------------- holo
  // The pokemon-cards-css treatment, ported to GLSL because the card is a plane
  // inside this scene and the engine takes no DOM handoffs. Two layers, exactly
  // as the reference stacks them: a rainbow band that parallaxes SLOWLY, and a
  // glare that tracks the finger 1:1. The difference in those two rates is the
  // entire depth illusion — matching them kills the effect.
  //
  // The label plate shares this material, so the card window is masked out of
  // the atlas rect rather than applied to the whole plane. Derived from the same
  // constants that paint the atlas, so it cannot drift out of sync.
  const holo = {
    uHoloPointer: { value: new THREE.Vector2(0.5, 0.5) },
    uHoloShift: { value: new THREE.Vector2(0, 0) },
    uHoloAmount: { value: 0 },
    uHoloCardRect: {
      value: new THREE.Vector4(
        CARD_RECT.x / ATLAS_W,
        // cleanGeometry flips V and the canvas texture uploads flipY, so the
        // atlas row at CARD_RECT.y lands at the TOP of the card in UV space.
        1 - (CARD_RECT.y + CARD_RECT.h) / ATLAS_H,
        CARD_RECT.w / ATLAS_W,
        CARD_RECT.h / ATLAS_H,
      ),
    },
  };
  /** Peak holo strength for the card on screen; set when the slab is dressed. */
  let holoTarget = 0;

  innerFrontMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, holo);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform vec2 uHoloPointer;
        uniform vec2 uHoloShift;
        uniform float uHoloAmount;
        uniform vec4 uHoloCardRect;
        // The reference's --sunpillar-1..6, converted from HSL.
        vec3 gpSunpillar(float t) {
          float s = fract(t) * 6.0;
          vec3 c = vec3(1.000, 0.478, 0.460);
          c = mix(c, vec3(1.000, 0.928, 0.380), clamp(s, 0.0, 1.0));
          c = mix(c, vec3(0.659, 1.000, 0.380), clamp(s - 1.0, 0.0, 1.0));
          c = mix(c, vec3(0.520, 1.000, 0.968), clamp(s - 2.0, 0.0, 1.0));
          c = mix(c, vec3(0.480, 0.584, 1.000), clamp(s - 3.0, 0.0, 1.0));
          c = mix(c, vec3(0.847, 0.460, 1.000), clamp(s - 4.0, 0.0, 1.0));
          c = mix(c, vec3(1.000, 0.478, 0.460), clamp(s - 5.0, 0.0, 1.0));
          return c;
        }
        // filter: brightness(.85) contrast(2.75) saturate(.65) — the reference
        // runs this on the shine layer BEFORE blending. The contrast is the
        // load-bearing part: it crushes the layer to near-black everywhere but
        // the ridges, which is what makes a dodge behave instead of blowing out.
        vec3 gpShineFilter(vec3 c) {
          c *= 0.85;
          c = (c - 0.5) * 2.75 + 0.5;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          return clamp(mix(vec3(l), c, 0.65), 0.0, 1.0);
        }`,
      )
      // Blend AFTER colorspace_fragment, in sRGB 0..1 — that is the space CSS
      // blend modes are defined in. The first attempt added the shine to
      // totalEmissiveRadiance instead: linear HDR, pre-tonemap, and additive.
      // Addition lifts every channel by the same amount, so on a bright card it
      // washes to grey-white and the hue never survives. color-dodge DIVIDES,
      // channel by channel, so it pushes the card's own pixels toward the holo
      // hue instead of pouring white light over them.
      .replace(
        "#include <colorspace_fragment>",
        `#include <colorspace_fragment>
        {
          vec2 cuv = (vMapUv - uHoloCardRect.xy) / uHoloCardRect.zw;
          vec2 edge = step(vec2(0.0), cuv) * step(cuv, vec2(1.0));
          float inCard = edge.x * edge.y * uHoloAmount;
          if (inCard > 0.001) {
            // Grazing angles only. Foil that shows face-on is a printed rainbow;
            // this is what puts it UNDER the surface rather than on it.
            float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 2.2);
            // 110deg bands, offset by the compressed parallax — the slow layer.
            float band = dot(cuv - uHoloShift, vec2(0.93969, -0.34202)) * 9.0;
            float ridge = pow(0.5 + 0.5 * sin(band * 6.28318), 5.0);
            // Hue cycles slower than the ridges so neighbours differ in colour.
            vec3 rainbow = gpSunpillar(band * 0.22);
            // background-blend-mode: overlay against the reference's scanlines.
            float scan = mix(0.88, 1.0, step(0.5, fract(cuv.x * 300.0)));
            // The fast layer: a highlight sitting exactly under the finger.
            float glare = smoothstep(0.95, 0.1, distance(cuv, uHoloPointer));
            vec3 shine = gpShineFilter(rainbow * ridge * scan);
            shine *= inCard * (0.42 + 0.58 * glare) * (0.42 + 0.58 * fres);
            // color-dodge is base / (1 - shine), which has almost no usable
            // middle: at shine 0.1 it is a 1.1x lift, at 0.98 it is 50x and the
            // card goes pure white. Flooring the divisor caps the gain at 1/0.38
            // ~= 2.6x, so the ridges shift the card's hue hard without clipping.
            gl_FragColor.rgb = min(gl_FragColor.rgb / max(1.0 - shine, 0.38), vec3(1.0));
          }
        }`,
      );
  };
  const innerBackMaterial = track(
    new THREE.MeshPhysicalMaterial({
      map: backTex,
      metalness: 0.1,
      roughness: 0.55,
      envMapIntensity: 0.4,
      // 同正面：圓角要切得出來，理由見 innerFrontMaterial。
      alphaTest: 0.5,
    }),
  );

  /** 目前這張卡該不該穿殼。GLB 可能比第一張卡晚到，所以狀態要獨立記著。 */
  let slabDressed = true;

  /** 這張卡揭曉後靜止的縮放，也是入場補間的終點。dressSlab 依有沒有鑑定切換。 */
  let slabScale = SLAB_SCALE;

  /** 這張卡從袋口滑出來時的縮放。鑑定卡兩段一樣，裸卡滑出時比較大。 */
  let slabPullScale = SLAB_SCALE;

  /**
   * 入場補間進行中。
   *
   * 補間自己會把縮放從起點帶到 slabScale，這期間 dressSlab 不可以直接寫縮放，
   * 否則晚到的卡圖回頭重畫時會把補間的中間值蓋掉、卡磚當場跳一下。
   * 補間以外（例如抽出卡片的 pull 階段）就必須直接寫，那時沒有人會幫忙套。
   */
  let slabEntering = false;

  /**
   * 只有鑑定卡才有殼：壓克力外殼、霧墊、標籤面三者，裸卡一律不出現。
   *
   * 這是 app 既有的規則（見 Cards/Slab.tsx）：沒送鑑定就沒有殼、沒有標籤，就是一張卡。
   * 裝進來的清單在 dressSlab 依當前卡片切換顯示。
   */
  const gradedOnlyMeshes: THREE.Mesh[] = [];

  /**
   * 哪個平面是標籤、哪個是卡面，GLB 的部件名看不出來（Glass_Card003_1 / _4），
   * 所以改用 UV 落點判定：兩個平面都對到同一張圖集，標籤面的 UV 會落在
   * LABEL_RECT 的範圍，卡面落在 CARD_RECT。用幾何自己說話，不靠猜名字。
   */
  const isLabelPlane = (geometry: THREE.BufferGeometry): boolean => {
    const uv = geometry.getAttribute("uv");
    if (!uv) return false;
    let sum = 0;
    for (let i = 0; i < uv.count; i += 1) sum += uv.getY(i);
    const meanV = sum / Math.max(1, uv.count);
    // cleanGeometry 已經把 V 翻回 FBX 慣例，所以圖集的 y 要同樣翻過來比。
    const labelV = 1 - (LABEL_RECT.y + LABEL_RECT.h / 2) / ATLAS_H;
    const cardV = 1 - (CARD_RECT.y + CARD_RECT.h / 2) / ATLAS_H;
    return Math.abs(meanV - labelV) < Math.abs(meanV - cardV);
  };

  loadSlabModel()
    .then((parts) => {
      if (!alive) return;
      for (const part of parts) {
        track(part.geometry);
        let material: THREE.Material | THREE.Material[] = acrylicMaterial;
        let order = 4;
        let gradedOnly = true;
        if (part.name === "GLASS_FROST") {
          material = frostMaterial;
          order = 3;
        } else if (part.name !== "Glass_Card003") {
          // Label + card planes: group material order follows the FBX's own
          // material list ("BACK" faces away, "FRONT 1" faces the camera).
          material = part.materials.map((name) =>
            name === "BACK" ? innerBackMaterial : innerFrontMaterial,
          );
          order = 2;
          gradedOnly = isLabelPlane(part.geometry);
        }
        const mesh = new THREE.Mesh(part.geometry, material);
        mesh.renderOrder = order;
        if (gradedOnly) {
          gradedOnlyMeshes.push(mesh);
          mesh.visible = slabDressed;
        }
        slabModel.add(mesh);
      }
      // 網格是 GLB 載完才生出來的，裁切面要補掛上去。
      if (pouchClipOn) setPouchClip(true);
    })
    .catch(() => undefined);

  slabGroup.add(slabModel);

  const artCache = new Map<string, HTMLImageElement>();
  const backArtCache = new Map<string, HTMLImageElement>();
  /** 卡圖已經是全解析度的那幾張。縮圖進來時不能蓋掉已經到位的大圖。 */
  const artIsFull = new Set<string>();
  /** 目前這塊鑑定磚身上穿的是哪一張卡，晚到的圖要靠它決定要不要重畫。 */
  let dressedCardId: string | null = null;

  ensureBrandWordmark().catch(() => undefined);

  /**
   * 圖到了就把磚重畫一次。
   *
   * 原本這裡是 fire-and-forget：dressSlab 拿當下 artCache 裡有什麼就畫什麼，
   * 圖慢一步到就畫成沒有卡面的版本，而且之後不會再畫第二次 —— 所以看起來
   * 不只是「載得慢」，是根本沒出現。這一行讓晚到的圖補上去。
   */
  const adoptArt = (cardId: string, img: HTMLImageElement, full: boolean): void => {
    if (artIsFull.has(cardId) && !full) return;
    artCache.set(cardId, img);
    if (full) artIsFull.add(cardId);
    if (dressedCardId === cardId) {
      const dressed = cards.find((c) => c.id === cardId);
      if (dressed) dressSlab(dressed);
    }
  };

  const dressSlab = (card: Card): void => {
    dressedCardId = card.id;
    // 沒有等級就是沒送鑑定，沒送鑑定就沒有殼。GLB 可能還沒載完，
    // 所以狀態記在 slabDressed，載完時一併套用。
    slabDressed = card.grade != null || card.gradeScore != null;
    for (const mesh of gradedOnlyMeshes) mesh.visible = slabDressed;
    // 入場補間緊接在 dressSlab 之後跑（revealBurst），會把縮放帶到這個目標值，
    // 所以這裡只記不套。晚到的卡圖回頭重畫時等級不會變，縮放也就不需要重設。
    slabScale = slabDressed ? SLAB_SCALE : RAW_REVEAL_SCALE;
    slabPullScale = slabDressed ? SLAB_PULL_SCALE : RAW_PULL_SCALE;
    // pull 階段（卡片從袋口滑出來）發生在入場補間之前，那時沒有人會套用縮放，
    // 所以這裡要直接寫進去，否則裸卡會用到建立時的預設值而顯得偏小。
    if (!slabEntering) slabGroup.scale.setScalar(slabPullScale);
    // Commons get a hint of sheen, mythics get the full rainbow.
    holoTarget = 0.45 + styleFor(card.rarity).celebration * 0.18;
    const faces = createSlabFaces(card, artCache.get(card.id) ?? null, backArtCache.get(card.id) ?? null);
    const f = frontAtlas.getContext("2d");
    const b = backAtlas.getContext("2d");
    if (!f || !b) return;
    f.fillStyle = "#f4f2ec";
    f.fillRect(0, 0, ATLAS_W, ATLAS_H);
    // 裝在殼裡時，卡片圓角後面本來就該透出襯紙，所以米白留著；
    // 裸卡沒有殼，米白會變成四個角的白色楔形，要清成透明。
    if (!slabDressed) {
      f.clearRect(
        CARD_RECT.x - CARD_BLEED,
        CARD_RECT.y - CARD_BLEED,
        CARD_RECT.w + CARD_BLEED * 2,
        CARD_RECT.h + CARD_BLEED * 2,
      );
    }
    f.drawImage(faces.label, LABEL_RECT.x, LABEL_RECT.y, LABEL_RECT.w, LABEL_RECT.h);
    f.drawImage(faces.card, CARD_RECT.x, CARD_RECT.y, CARD_RECT.w, CARD_RECT.h);
    b.fillStyle = "#f4f2ec";
    b.fillRect(0, 0, ATLAS_W, ATLAS_H);
    if (!slabDressed) {
      b.clearRect(
        CARD_RECT.x - CARD_BLEED,
        CARD_RECT.y - CARD_BLEED,
        CARD_RECT.w + CARD_BLEED * 2,
        CARD_RECT.h + CARD_BLEED * 2,
      );
    }
    // Two-sided insert like a real slab: label repeats, card shows its back.
    b.drawImage(faces.label, LABEL_RECT.x, LABEL_RECT.y, LABEL_RECT.w, LABEL_RECT.h);
    b.drawImage(faces.cardBack, CARD_RECT.x, CARD_RECT.y, CARD_RECT.w, CARD_RECT.h);
    frontTex.needsUpdate = true;
    backTex.needsUpdate = true;
  };

  // 卡圖在場景一建好就開始抓，不等撕開。這個迴圈要放在 dressSlab 之後，
  // 因為晚到的圖會回頭呼叫它補畫。
  for (const card of cards) {
    // 先抓 12KB 的縮圖，撕開的瞬間就有卡面可看；1600 到了再換上去。
    // 兩個同時發，縮圖幾乎一定先到，而且它不會覆蓋已經到位的大圖。
    const thumb = thumbUrlFor(card.artUrl);
    if (thumb) {
      loadImage(thumb)
        .then((img) => adoptArt(card.id, img, false))
        .catch(() => undefined);
    }
    loadImage(card.artUrl)
      .then((img) => adoptArt(card.id, img, true))
      .catch(() => undefined);
    if (card.backArtUrl) {
      loadImage(card.backArtUrl)
        .then((img) => {
          backArtCache.set(card.id, img);
          if (dressedCardId === card.id) dressSlab(card);
        })
        .catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- effects
  const shaftGroup = new THREE.Group();
  shaftGroup.visible = false;
  shaftGroup.position.z = -0.8;
  scene.add(shaftGroup);
  const shaftMaterial = track(
    new THREE.MeshBasicMaterial({
      map: track(makeShaftTexture(colors.accent)),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const shaftGeo = track(new THREE.PlaneGeometry(0.34, 10));
  for (let i = 0; i < (high ? 9 : 5); i += 1) {
    const shaft = new THREE.Mesh(shaftGeo, shaftMaterial);
    shaft.rotation.z = (i / (high ? 9 : 5)) * Math.PI * 2 + rng.range(-0.2, 0.2);
    shaft.scale.x = rng.range(0.5, 1.4);
    shaftGroup.add(shaft);
  }

  const waveMaterial = track(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(colors.color),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const wave = new THREE.Mesh(track(new THREE.RingGeometry(0.92, 1, 64)), waveMaterial);
  wave.visible = false;
  scene.add(wave);

  const sparkTexture = track(makeRadialTexture(colors.accent));
  const sparks = makeParticlePool(high ? 240 : 120, sparkTexture, colors.accent, 0.085);
  track(sparks.geometry);
  track(sparks.material);
  scene.add(sparks.points);

  // ------------------------------------------------------------ soft shadow
  const shadowMaterial = track(
    new THREE.SpriteMaterial({
      map: track(makeRadialTexture("rgba(0,0,0,0.55)")),
      transparent: true,
      depthWrite: false,
    }),
  );
  const shadow = new THREE.Sprite(shadowMaterial);
  shadow.position.set(0, -PACK_H / 2 - 0.7, -0.2);
  shadow.scale.set(2.7, 0.62, 1);
  scene.add(shadow);

  // ------------------------------------------------------------- dust motes
  const moteCount = reducedMotion ? 0 : high ? 90 : 36;
  const moteGeometry = track(new THREE.BufferGeometry());
  {
    const positions = new Float32Array(Math.max(1, moteCount) * 3);
    for (let i = 0; i < moteCount; i += 1) {
      positions[i * 3] = rng.range(-4.4, 4.4);
      positions[i * 3 + 1] = rng.range(-3.2, 3.2);
      positions[i * 3 + 2] = rng.range(-2.4, 1.6);
    }
    moteGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  }
  const moteMaterial = track(
    new THREE.PointsMaterial({
      map: sparkTexture,
      color: new THREE.Color(colors.accent),
      size: 0.055,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const motes = new THREE.Points(moteGeometry, moteMaterial);
  motes.visible = moteCount > 0;
  scene.add(motes);

  // ------------------------------------------------------------------ state
  let stage: OpenStage = "float";
  let yaw = 0;
  let pitch = 0;
  let yawVel = 0;
  let pitchVel = 0;
  let dragging = false;
  let paused = false;
  let disposed = false;
  let frame = 0;
  let fitRatio = 0.6;
  let cardIndex = -1;
  /** 0..1 rip across the seam — scrubbed by drag or tweened by auto-tear. */
  // Absolute pointer, plus the smoothed value that actually drives the frame.
  // The reference springs these; an exponential chase is the same felt lag with
  // no overshoot to fight the idle sway.
  let ptrTargetX = 0;
  let ptrTargetY = 0;
  let ptrOver = 0;
  let ptrX = 0;
  let ptrY = 0;
  let ptrAmt = 0;
  let tearValue = 0;
  /** 0..1 pouch pull-down — scrubbed by drag or tweened by auto-pull. */
  let pullValue = 0;
  let stripGone = false;
  let tearAnimating = false;
  let pullAnimating = false;
  /** Open button chains tear → pull; taps/scrubs run one step at a time. */
  let autoChain = false;
  let advancing = false;
  const clock = new THREE.Clock();

  const setStage = (next: OpenStage): void => {
    stage = next;
    options.onStage?.(next);
  };

  // ------------------------------------------------------------------ tweens
  interface Tween {
    t0: number;
    dur: number;
    ease: (t: number) => number;
    update: (v: number) => void;
    done?: () => void;
  }
  const tweens: Tween[] = [];
  const tween = (
    dur: number,
    update: (v: number) => void,
    done?: () => void,
    delay = 0,
    ease: (t: number) => number = easeInOutCubic,
  ): void => {
    tweens.push({
      t0: performance.now() + (reducedMotion ? 0 : delay),
      dur: reducedMotion ? 1 : Math.max(1, dur),
      ease,
      update,
      done,
    });
  };
  const runTweens = (): void => {
    const now = performance.now();
    for (let i = tweens.length - 1; i >= 0; i -= 1) {
      const t = tweens[i];
      if (!t || now < t.t0) continue;
      const v = Math.min(1, (now - t.t0) / t.dur);
      t.update(t.ease(v));
      if (v >= 1) {
        tweens.splice(i, 1);
        t.done?.();
      }
    }
  };

  // --------------------------------------------------------------- sequence
  const bloomTo = (peak: number, upMs: number, downMs: number): void => {
    if (!bloom) return;
    const b = bloom;
    const from = b.strength;
    tween(upMs, (v) => (b.strength = from + (peak - from) * v), () => {
      tween(downMs, (v) => (b.strength = peak + (BLOOM_BASE - peak) * v), undefined, 0, easeOutCubic);
    }, 0, easeOutCubic);
  };

  const revealBurst = (index: number): void => {
    const card = cards[index];
    if (!card) return;
    const style = styleFor(card.rarity);
    const cel = style.celebration;
    const styleColor = new THREE.Color(style.color);
    const accentColor = new THREE.Color(style.accent);

    flash.color = accentColor;
    const peakI = 30 + cel * 34;
    tween(140, (v) => (flash.intensity = peakI * v), () => {
      tween(620, (v) => (flash.intensity = peakI * (1 - v)), undefined, 0, easeOutCubic);
    }, 0, easeOutCubic);

    bloomTo(1.15 + cel * 0.55, 160, 780);

    if (!reducedMotion) {
      if (cel >= 1) {
        shaftGroup.visible = true;
        shaftMaterial.color = accentColor;
        tween(220, (v) => (shaftMaterial.opacity = 0.55 * v), () => {
          tween(900, (v) => {
            shaftMaterial.opacity = 0.55 * (1 - v);
            if (v >= 1) shaftGroup.visible = false;
          }, undefined, 0, easeOutCubic);
        }, 0, easeOutCubic);
      }
      if (cel >= 2) {
        wave.visible = true;
        waveMaterial.color = styleColor;
        tween(760, (v) => {
          const s = 0.4 + v * 6.4;
          wave.scale.set(s, s, 1);
          waveMaterial.opacity = 0.85 * (1 - v);
          if (v >= 1) wave.visible = false;
        }, undefined, 0, easeOutCubic);
      }
      sparks.spawn(
        deriveSeed(options.seed, 90 + index),
        60 + cel * 55,
        new THREE.Vector3(0, 0, 0.4),
        2.6 + cel * 1.1,
      );
      sparks.material.color = accentColor;
    }
  };

  const showCard = (index: number, entrance: "burst" | "swap"): void => {
    const card = cards[index];
    if (!card) return;
    cardIndex = index;
    dressSlab(card);
    slabGroup.visible = true;
    yaw = 0;
    pitch = 0;
    yawVel = 0;
    pitchVel = 0;

    const fromZ = entrance === "burst" ? -0.16 : 0.2;
    // 起點取滑出時的大小：卡片是從那個尺寸「安定下來」到揭曉尺寸的，
    // 中間的補間就順成一個收合動作，而不是憑空跳一下。
    const fromScale = entrance === "swap"
      ? slabScale * 0.6
      : slabPullScale;
    slabGroup.position.set(entrance === "swap" ? 1.6 : 0, entrance === "swap" ? -0.3 : slabGroup.position.y, fromZ);
    slabGroup.scale.setScalar(fromScale);
    slabGroup.rotation.set(0, entrance === "swap" ? 0.7 : 0, 0);

    slabEntering = true;
    tween(entrance === "burst" ? 700 : 520, (v) => {
      const o = overshoot(v);
      slabGroup.position.x *= 1 - v;
      slabGroup.position.y = slabGroup.position.y * (1 - v);
      slabGroup.position.z = fromZ + (0.85 - fromZ) * o;
      slabGroup.scale.setScalar(fromScale + (slabScale - fromScale) * o);
      slabGroup.rotation.y = slabGroup.rotation.y * (1 - v);
    }, () => {
      slabEntering = false;
      setStage("slab");
      advancing = false;
    }, 0, easeOutCubic);

    revealBurst(index);
    options.onCardShown?.(index);
  };

  /** Pose everything ripped by fraction `v` — used by scrub and tweens alike. */
  const applyTear = (v: number): void => {
    tearValue = v;
    // The strip rides sideways with the finger and rolls back on itself, the
    // curl baring its inner face. That curl used to flash white; it is
    // stripBackMaterial's dead env reflection, not the motion, that fixed it.
    // 整條的側移與旋轉全部拿掉。摺線要精準落在游標下，網格座標和世界座標之間就不能有
    // 隨撕開進度變動的位移，否則摺線會一路漂離游標。抬升與傾斜改由 curlStrip 逐點處理。
    stripPivot.position.x = -PACK_W / 2;
    stripPivot.position.y = tearY;
    stripPivot.rotation.z = 0;
    curlStrip(v);
    updateTearLight(v);
    // 抓握點釘在「還沒撕開的邊界」上，也就是游標所在的位置，但夾在卡包範圍內：
    // sprite 是置中的，撕開進度 0 時邊界就在最左緣，不夾的話會有一半浮在卡包外面的背景上。
    const gripHalf = PACK_W * 0.0925;
    grip.position.x =
      THREE.MathUtils.clamp(
        (Math.min(1, curlFront(v)) - 0.5) * PACK_W,
        -PACK_W / 2 + gripHalf,
        PACK_W / 2 - gripHalf,
      ) - stripPivot.position.x;
    // 整段撕開都還握著，所以不在中途淡出，只在最後跟著箔膜一起離場。
    gripMaterial.opacity = 1 - THREE.MathUtils.clamp((v - 0.88) / 0.12, 0, 1);
  };

  /** Pose the pouch pulled down by fraction `v`, baring the slab behind it. */
  const applyPull = (v: number): void => {
    pullValue = v;
    if (v > 0.001) {
      slabGroup.visible = true;
      if (!pouchClipOn) setPouchClip(true);
    }
    bodyGroup.position.z = v * 0.6;
    bodyGroup.position.y = -(0.22 * v + 0.78 * easeInCubic(v)) * PACK_H * 1.5;
    bodyGroup.rotation.z = Math.sin(v * Math.PI) * 0.08;
    shadowMaterial.opacity = 0.5 * (1 - v);
  };

  /** Strip slides clean off to the side, then the pack rests torn. */
  const finishTear = (): void => {
    if (stripGone) return;
    stripGone = true;
    tearAnimating = true;
    applyTear(1);
    slabGroup.visible = true;
    const first = cards[0];
    if (first && cardIndex < 0) dressSlab(first);
    setPouchClip(true);
    // 撕完的瞬間燈還黏在封口帶脫離的那一端，要順勢滑到開口中央。
    const seamX = tearLight.position.x;
    tween(reducedMotion ? 1 : 260, (v) => {
      stripPivot.position.x = -PACK_W / 2 + 0.55 + v * 3.4;
      stripPivot.position.y = tearY + 0.1 + v * 0.4;
      stripPivot.rotation.z = 0.05 + v * 0.12;
      stripFrontMaterial.opacity = 1 - v;
      stripBackMaterial.opacity = 1 - v;
      // 封口帶離場的同時把漏光收到殘光，不是收到零：開口還要繼續發光。
      tearLight.intensity = lightPeak * (1 - v * (1 - OPENING_GLOW));
      tearLight.position.x = seamX * (1 - v);
    }, () => {
      stripPivot.visible = false;
      tearAnimating = false;
      setStage("torn");
      if (autoChain) doAutoPull(160);
    }, 0, easeOutCubic);
  };

  const finishPull = (): void => {
    bodyGroup.visible = false;
    // 袋子退場了，整塊卡磚都要看得到。
    setPouchClip(false);
    shadow.visible = false;
    setStage("burst");
    showCard(0, "burst");
  };

  const doAutoTear = (delay = 0): void => {
    if (stripGone || tearAnimating) return;
    if (stage !== "sealed" && stage !== "tearing") return;
    tearAnimating = true;
    if (stage !== "tearing") setStage("tearing");
    const from = tearValue;
    tween(reducedMotion ? 1 : Math.max(140, 620 * (1 - from)), (v) => {
      applyTear(from + (1 - from) * v);
    }, () => {
      tearAnimating = false;
      finishTear();
    }, delay, easeInOutCubic);
  };

  const doAutoPull = (delay = 0): void => {
    if (pullAnimating) return;
    if (stage !== "torn" && stage !== "pulling") return;
    pullAnimating = true;
    if (stage !== "pulling") setStage("pulling");
    const from = pullValue;
    tween(reducedMotion ? 1 : Math.max(180, 760 * (1 - from)), (v) => {
      applyPull(from + (1 - from) * v);
    }, () => {
      pullAnimating = false;
      finishPull();
    }, delay, easeInOutCubic);
  };

  /**
   * 卡包左右緣落在畫布上的位置（0..1）。
   *
   * 直接把兩個角投影到螢幕座標，也就是渲染器自己在做的事的反運算，所以相機距離、fit 比例、
   * 透視、packGroup 的任何縮放都自動算進去。先前是用 PACK_W / visibleW 反推，那條路徑依賴
   * 相機參數與 DOM 探針一致，探針的 aspect-ratio 一跟卡包對不上就整個歪掉，撕開會跑在游標前面。
   */
  const spanA = new THREE.Vector3();
  const spanB = new THREE.Vector3();
  const packSpanY = (): number => {
    packGroup.updateMatrixWorld();
    spanA.set(0, PACK_H / 2, 0).applyMatrix4(packGroup.matrixWorld).project(camera);
    spanB.set(0, -PACK_H / 2, 0).applyMatrix4(packGroup.matrixWorld).project(camera);
    return Math.max(1e-4, Math.abs(spanA.y - spanB.y) / 2);
  };
  const packSpanX = (): { left: number; width: number } => {
    // 卡包會在撕開時轉幾度，所以要先過 packGroup 的世界變換再投影，否則對位會跟著傾斜漂掉。
    packGroup.updateMatrixWorld();
    spanA.set(-PACK_W / 2, tearY, 0).applyMatrix4(packGroup.matrixWorld).project(camera);
    spanB.set(PACK_W / 2, tearY, 0).applyMatrix4(packGroup.matrixWorld).project(camera);
    const left = (spanA.x + 1) / 2;
    const right = (spanB.x + 1) / 2;
    return { left, width: Math.max(1e-4, right - left) };
  };

  const scrubTear = (stageFractionX: number): void => {
    if (stripGone || tearAnimating) return;
    if (stage !== "sealed" && stage !== "tearing") return;
    autoChain = false;
    const span = packSpanX();
    // 游標在畫布上的位置換算成卡包自己的 0..1，curlFront 是恆等函數，所以這就是撕開進度。
    const u = (stageFractionX - span.left) / span.width;
    // 只進不退：手往回帶不該把箔膜縫回去。除此之外撕開就等於游標位置，不做任何補間或追趕，
    // 任何「自己往前跑」的機制都會變成使用者眼中的自動撕完。
    const next = THREE.MathUtils.clamp(Math.max(tearValue, u), 0, 1);
    if (stage === "sealed" && next > 0.01) setStage("tearing");
    applyTear(next);
    if (next >= 1) finishTear();
  };

  /**
   * 放手：箔膜回到原本密封的樣子。
   *
   * 沒有門檻，撕到多少都一樣收回去。這讓整個手勢變成「一口氣拉到底才算數」：
   * 要開就得把撕口一路帶到卡包右緣（scrubTear 到 1 會接 finishTear），
   * 半途鬆手就當作沒發生。不想拖的人直接點一下，tap 會自動撕完。
   */
  const endTearScrub = (): void => {
    if (stripGone || tearAnimating || stage !== "tearing") return;
    if (tearValue <= 0.001) return;
    tearAnimating = true;
    const from = tearValue;
    tween(reducedMotion ? 1 : 300, (v) => applyTear(from * (1 - v)), () => {
      tearAnimating = false;
      setStage("sealed");
    }, 0, easeOutCubic);
  };

  const scrubPull = (stageFractionDeltaY: number): void => {
    if (pullAnimating) return;
    if (stage !== "torn" && stage !== "pulling") return;
    autoChain = false;
    // 用卡包自己在畫面上的高度換算，不是整個畫布的高度。畫布比卡包高得多，
    // 拿畫布當基準會讓同樣的手勢在不同視窗尺寸下拉出不同的距離。
    const delta = stageFractionDeltaY / (packSpanY() * PULL_SPAN);
    const next = THREE.MathUtils.clamp(pullValue + delta, 0, 1);
    if (stage === "torn" && next > 0.01) setStage("pulling");
    applyPull(next);
    if (next >= 1) {
      pullAnimating = true;
      finishPull();
    }
  };

  /**
   * 放手：卡包滑回原位。
   *
   * 跟撕開刻意不對稱。撕開是不可逆的動作，放手就讓它跑完；往下拉是「偷看」，
   * 放手本來就該收回去，要真的開就得一路拉到底（scrubPull 到 1 會接 finishPull），
   * 或是直接點一下讓它自動拉完。
   */
  const endPullScrub = (): void => {
    if (pullAnimating || stage !== "pulling") return;
    if (pullValue <= 0.001) return;
    pullAnimating = true;
    const from = pullValue;
    tween(reducedMotion ? 1 : 300, (v) => applyPull(from * (1 - v)), () => {
      pullAnimating = false;
      setStage("torn");
    }, 0, easeOutCubic);
  };

  let opening = false;
  /** Tween back to face the camera, then hand off. */
  const faceFront = (then: () => void): void => {
    opening = true;
    dragging = false;
    const tau = Math.PI * 2;
    const fromYaw = yaw;
    const fromPitch = pitch;
    const toYaw = Math.round(yaw / tau) * tau;
    tween(FACE_FRONT_MS, (v) => {
      yaw = fromYaw + (toYaw - fromYaw) * v;
      pitch = fromPitch * (1 - v);
      packGroup.scale.setScalar(1 + 0.04 * Math.sin(v * Math.PI));
    }, () => {
      yawVel = 0;
      pitchVel = 0;
      opening = false;
      then();
    });
  };

  /** Float tap: settle front-facing, hold sealed, wait for the manual rip. */
  const settle = (): void => {
    if (opening || stage !== "float") return;
    autoChain = false;
    faceFront(() => setStage("sealed"));
  };

  /** Open button: run the whole thing from wherever we are. */
  const open = (): void => {
    if (opening) return;
    autoChain = true;
    if (stage === "float") {
      faceFront(() => {
        setStage("sealed");
        doAutoTear(60);
      });
    } else if (stage === "sealed" || stage === "tearing") {
      doAutoTear();
    } else if (stage === "torn" || stage === "pulling") {
      doAutoPull();
    }
  };

  const advance = (): void => {
    if (stage !== "slab" || advancing) return;
    if (cardIndex >= cards.length - 1) {
      setStage("done");
      options.onFinished?.();
      return;
    }
    advancing = true;
    const next = cardIndex + 1;
    tween(300, (v) => {
      slabGroup.position.x = -v * 4.2;
      slabGroup.rotation.y = -v * 1.1;
      slabGroup.scale.setScalar(slabScale * (1 - v * 0.25));
    }, () => showCard(next, "swap"), 0, easeInCubic);
  };

  const skip = (): void => {
    tweens.length = 0;
    setStage("done");
  };

  // ----------------------------------------------------------------- sizing
  const resize = (): void => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, high ? 2 : 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer?.setPixelRatio(dpr);
    composer?.setSize(w, h);
    camera.aspect = w / h;
    const halfTan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const distH = PACK_H / Math.max(0.2, fitRatio) / (2 * halfTan);
    const distW = (PACK_W * 1.25) / (camera.aspect * 2 * halfTan);
    camera.position.z = Math.max(distH, distW);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const onVisibility = (): void => {
    paused = document.hidden;
    if (!paused) clock.getDelta();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // ------------------------------------------------------------------- tick
  const tick = (): void => {
    frame = requestAnimationFrame(tick);
    if (paused || disposed) return;

    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    runTweens();

    const interactive = stage === "float" || stage === "slab";
    if (interactive && !dragging && !opening) {
      yaw += yawVel;
      pitch += pitchVel;
      const damp = Math.pow(0.9, dt * 60);
      yawVel *= damp;
      pitchVel *= damp;
    }
    yaw = THREE.MathUtils.clamp(yaw, -YAW_LIMIT, YAW_LIMIT);
    pitch = THREE.MathUtils.clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);

    const idle = reducedMotion || opening ? 0 : 1;

    if (stage === "float") {
      const swayY = Math.sin(time * 0.6) * 0.05 * idle;
      const swayX = Math.cos(time * 0.47) * 0.07 * idle;
      packGroup.rotation.set(pitch + swayX, yaw + swayY, Math.sin(time * 0.8) * 0.02 * idle);
      packGroup.position.y = Math.sin(time * 1.05) * 0.09 * idle;
      shadowMaterial.opacity = 0.5 - packGroup.position.y * 1.4;
    } else if (stage === "sealed" || stage === "tearing" || stage === "torn" || stage === "pulling") {
      // Locked near-frontal; a nervous tremor scales with how far the rip is.
      const tremor =
        stage === "tearing" && !reducedMotion
          ? Math.sin(time * 55) * 0.006 * Math.sin(tearValue * Math.PI)
          : 0;
      const breathe = reducedMotion ? 0 : Math.sin(time * 1.3) * 0.008;
      // 撕開時緩緩轉幾度。正面平視讀不出帶子翹離表面多少，要有透視才看得出它離開了卡包。
      // 只給 yaw 和 pitch，不給 roll：roll 會把撕開線轉斜，游標的水平對位就得跟著補償。
      const lean = easeOutCubic(tearValue) * leanAmount;
      packGroup.rotation.set(tremor + breathe - 0.06 * lean, tremor * 0.7 + 0.13 * lean, 0);
      packGroup.position.y = 0;
      packGroup.scale.setScalar(1);
    }

    // Chase the pointer. reducedMotion snaps, so the card is still readable at
    // an angle but nothing drifts on its own.
    const chase = reducedMotion ? 1 : 1 - Math.pow(0.0016, dt);
    ptrX += (ptrTargetX - ptrX) * chase;
    ptrY += (ptrTargetY - ptrY) * chase;
    ptrAmt += (ptrOver - ptrAmt) * chase;

    const slabLive = slabGroup.visible && (stage === "slab" || stage === "done");
    if (slabLive) {
      const sway = reducedMotion ? 0 : 1;
      // TILT_MAX matches the reference's center/3.5 degrees = ±14.3°.
      const lean = TILT_MAX * ptrAmt;
      slabGroup.rotation.x = pitch + ptrY * lean + Math.cos(time * 0.5) * 0.03 * sway;
      slabGroup.rotation.y = yaw - ptrX * lean + Math.sin(time * 0.62) * 0.05 * sway;
      slabGroup.position.y = Math.sin(time * 0.9) * 0.05 * sway;
    }

    // Glare sits under the finger; the rainbow drifts across a compressed range,
    // the way the reference maps pointer 0..100% onto background 37..63%.
    holo.uHoloPointer.value.set(ptrX * 0.5 + 0.5, ptrY * 0.5 + 0.5);
    holo.uHoloShift.value.set(ptrX * 0.13, ptrY * 0.17);
    const holoWant = slabLive ? holoTarget : 0;
    holo.uHoloAmount.value += (holoWant - holo.uHoloAmount.value) * (reducedMotion ? 1 : 1 - Math.pow(0.02, dt));

    if (!reducedMotion) {
      const a = time * 0.32;
      key.position.set(Math.sin(a) * 3.4, 2.1 + Math.sin(time * 0.21) * 0.7, Math.cos(a) * 2.4 + 2.6);
      shaftGroup.rotation.z = time * 0.18;
    }

    sparks.update(dt);

    if (motes.visible) {
      motes.rotation.y = time * 0.03;
      motes.position.y = Math.sin(time * 0.4) * 0.14;
    }

    syncPouchClip();

    if (composer) composer.render();
    else renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(tick);

  return {
    rotateBy: (dYaw, dPitch) => {
      if (opening && stage === "float") return;
      if (stage !== "float" && stage !== "slab" && stage !== "done") return;
      yaw = THREE.MathUtils.clamp(yaw + dYaw, -YAW_LIMIT, YAW_LIMIT);
      pitch = THREE.MathUtils.clamp(pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
      yawVel = dYaw;
      pitchVel = dPitch * 0.6;
    },
    setPointer: (nx, ny, over) => {
      ptrTargetX = THREE.MathUtils.clamp(nx, -1, 1);
      ptrTargetY = THREE.MathUtils.clamp(ny, -1, 1);
      ptrOver = over ? 1 : 0;
    },
    setDragging: (value) => {
      dragging = value;
    },
    open,
    settle,
    autoTear: () => {
      autoChain = false;
      doAutoTear();
    },
    autoPull: () => {
      autoChain = false;
      doAutoPull();
    },
    scrubTear,
    endTearScrub,
    scrubPull,
    endPullScrub,
    advance,
    skip,
    setFit: (ratio) => {
      fitRatio = ratio;
      resize();
    },
    setPaused: (value) => {
      paused = value;
      if (!value) clock.getDelta();
    },
    getStage: () => stage,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const item of disposables) item.dispose();
      disposables.length = 0;
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

// ----------------------------------------------------------------- particles

interface ParticlePool {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  spawn: (seed: number, count: number, origin: THREE.Vector3, speed: number) => void;
  update: (dt: number) => void;
}

function makeParticlePool(
  capacity: number,
  texture: THREE.Texture,
  color: string,
  size: number,
): ParticlePool {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  positions.fill(9999);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const velocities = new Float32Array(capacity * 3);
  const life = new Float32Array(capacity);
  const material = new THREE.PointsMaterial({
    map: texture,
    color: new THREE.Color(color),
    size,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  let cursor = 0;
  let liveCount = 0;

  return {
    points,
    geometry,
    material,
    spawn: (seed, count, origin, speed) => {
      const rng = createRng(seed >>> 0 || hashSeed("burst"));
      for (let n = 0; n < Math.min(count, capacity); n += 1) {
        const i = cursor;
        cursor = (cursor + 1) % capacity;
        positions[i * 3] = origin.x;
        positions[i * 3 + 1] = origin.y;
        positions[i * 3 + 2] = origin.z;
        const theta = rng.range(0, Math.PI * 2);
        const up = rng.range(-0.25, 1);
        const s = speed * rng.range(0.35, 1);
        velocities[i * 3] = Math.cos(theta) * s;
        velocities[i * 3 + 1] = up * s + speed * 0.25;
        velocities[i * 3 + 2] = Math.sin(theta) * s * 0.6;
        life[i] = rng.range(0.5, 1.05);
      }
      liveCount = capacity;
      geometry.getAttribute("position").needsUpdate = true;
    },
    update: (dt) => {
      if (liveCount <= 0) return;
      let stillLive = 0;
      for (let i = 0; i < capacity; i += 1) {
        const remaining = (life[i] ?? 0) - dt;
        if (remaining <= 0) {
          if ((life[i] ?? 0) > 0) positions[i * 3] = 9999;
          life[i] = 0;
          continue;
        }
        life[i] = remaining;
        stillLive += 1;
        velocities[i * 3 + 1] = (velocities[i * 3 + 1] ?? 0) - 2.6 * dt;
        positions[i * 3] = (positions[i * 3] ?? 0) + (velocities[i * 3] ?? 0) * dt;
        positions[i * 3 + 1] = (positions[i * 3 + 1] ?? 0) + (velocities[i * 3 + 1] ?? 0) * dt;
        positions[i * 3 + 2] = (positions[i * 3 + 2] ?? 0) + (velocities[i * 3 + 2] ?? 0) * dt;
      }
      liveCount = stillLive;
      geometry.getAttribute("position").needsUpdate = true;
    },
  };
}

// ------------------------------------------------------------------ helpers

function makeRadialTexture(color: string): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Vertical soft beam for the god-ray fan. */
function makeShaftTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.45, color);
    g.addColorStop(0.55, color);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 256);
    const gx = ctx.createLinearGradient(0, 0, 32, 0);
    gx.addColorStop(0, "rgba(0,0,0,1)");
    gx.addColorStop(0.5, "rgba(0,0,0,0)");
    gx.addColorStop(1, "rgba(0,0,0,1)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, 32, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function smooth01(v: number): number {
  const t = THREE.MathUtils.clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t: number): number {
  return t * t * t;
}

/** Ease-out with a small elastic overshoot for slab arrivals. */
function overshoot(t: number): number {
  const c = 1.4;
  const p = t - 1;
  return 1 + (c + 1) * p * p * p + c * p * p;
}
