/* GodPack PSA 10 抽卡模擬器 — 接 godpack-old 分支的 3D 撕包引擎（opening3d.bundle.js） */
(() => {
  "use strict";

  const E = window.GodPackOpen3D;
  const PACK_PRICE = 99;
  /* 五個賠率帶（對應 cards.js 的 b 欄）；3D 引擎的稀有度是視覺強度，照順序對上去 */
  const BANDS = [
    { rarity: "common", zh: "普通", odds: 0.40, range: "$8 – $30" },
    { rarity: "uncommon", zh: "非凡", odds: 0.30, range: "$30 – $100" },
    { rarity: "rare", zh: "稀有", odds: 0.18, range: "$100 – $300" },
    { rarity: "epic", zh: "史詩", odds: 0.09, range: "$300 – $1,000" },
    { rarity: "legendary", zh: "傳說", odds: 0.03, range: "$1,000+" },
  ];
  const ZH = { common: "普通", uncommon: "非凡", rare: "稀有", epic: "史詩", legendary: "傳說", mythic: "神話" };
  /** 傳說帶裡超過這個價的，升到引擎的最高一級 mythic（例：Illustrator Pikachu） */
  const MYTHIC_PRICE = 50000;

  const $ = (id) => document.getElementById(id);

  /* ---------- 工具 ---------- */
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }
  const certOf = (card) => String(20000000 + (hashCode(card.n + card.s + card.num + card.i) % 79999999));
  const rarityOf = (card) => (card.b >= 4 && card.p >= MYTHIC_PRICE ? "mythic" : BANDS[Math.min(card.b, 4)].rarity);
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } };
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 音效（移植 lib/godpack/audio.ts） ---------- */
  let ctx = null, master = null, noiseBuf = null;
  let muted = load("gpsim-muted", null);
  if (muted === null) muted = window.matchMedia("(max-width: 639px)").matches;
  function ac() {
    if (muted) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  function noise(c) {
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  function noiseSweep(fromHz, toHz, dur, gain, type, q) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noise(c);
    const f = c.createBiquadFilter();
    f.type = type || "bandpass";
    f.Q.value = q || 1;
    f.frequency.setValueAtTime(fromHz, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }
  function tone(freq, dur, gain, type, delay, endFreq) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const o = c.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  const sfx = {
    click: () => tone(950, 0.05, 0.12, "triangle"),
    tearTick: (p) => noiseSweep(2400 + p * 1600, 900, 0.05, 0.05 + p * 0.05, "bandpass", 2),
    tearOpen: () => { noiseSweep(3400, 500, 0.4, 0.3, "bandpass", 0.8); tone(130, 0.22, 0.3, "sine", 0.03, 55); },
    rise: () => { tone(320, 0.45, 0.09, "sine", 0, 880); tone(324, 0.45, 0.06, "sine", 0.02, 890); },
    tick: () => tone(1900, 0.018, 0.05, "square"),
    reveal: (big) => {
      tone(880, 0.18, 0.16, "triangle");
      if (big) { tone(1174.7, 0.22, 0.16, "triangle", 0.09); tone(1760, 0.3, 0.1, "sine", 0.18); }
    },
    burst: (tier) => {
      const notes = tier >= 3 ? [523.25, 659.25, 784, 1046.5, 1318.5] : [523.25, 659.25, 784];
      notes.forEach((n, i) => tone(n, 0.32, 0.14, "triangle", i * 0.085));
      if (tier >= 3) { noiseSweep(5000, 9000, 0.5, 0.06, "highpass", 1.2); tone(2093, 0.5, 0.07, "sine", notes.length * 0.085); }
    },
  };
  const renderMute = () => { $("btn-mute").textContent = muted ? "🔇" : "🔊"; };
  $("btn-mute").addEventListener("click", () => {
    muted = !muted;
    store("gpsim-muted", muted);
    renderMute();
    if (!muted) sfx.click();
  });
  renderMute();

  /* ---------- 卡池 ---------- */
  const POOL = Array.isArray(window.GP_CARDS) ? window.GP_CARDS : [];
  const byBand = [[], [], [], [], []];
  POOL.forEach((c) => byBand[c.b].push(c));
  function draw() {
    let r = Math.random(), band = 0;
    for (let i = 0; i < BANDS.length; i++) { r -= BANDS[i].odds; band = i; if (r <= 0) break; }
    let group = byBand[band];
    while (!group.length && band > 0) group = byBand[--band];
    return group[Math.floor(Math.random() * group.length)];
  }
  const artUrl = (card) => "cards/" + card.i + ".jpg";

  /* ---------- 狀態 / 收藏 ---------- */
  const state = { count: 0, total: 0, best: null, history: [] };
  Object.assign(state, load("gpsim-state", {}));
  if (!Array.isArray(state.history)) state.history = [];
  const saveState = () => store("gpsim-state", state);
  function renderStats() {
    $("st-count").textContent = state.count;
    $("st-total").textContent = money(state.total);
    $("st-best").textContent = state.best ? money(state.best.p) : "—";
    $("col-total").textContent = money(state.total);
    const strip = $("strip");
    if (!state.history.length) {
      strip.innerHTML = '<span class="empty">還沒抽到任何卡，撕一包試試</span>';
      return;
    }
    strip.innerHTML = state.history.slice().reverse().slice(0, 40).map((c) => {
      const color = E.styleFor(rarityOf(c)).color;
      const src = c.i && POOL.some((p) => p.i === c.i) ? artUrl(c) : "";
      return `<div class="sim-thumb" style="--c:${color}66" title="${esc(c.n)} · ${money(c.p)}"><div class="lb"></div>${src ? `<img src="${src}" alt="" loading="lazy" />` : ""}<div class="v">${money(c.p)}</div></div>`;
    }).join("");
  }
  $("btn-clear").addEventListener("click", () => {
    if (!state.history.length) return;
    if (!confirm("清空收藏與統計？")) return;
    state.count = 0; state.total = 0; state.best = null; state.history = [];
    saveState();
    renderStats();
  });

  /* ---------- 賠率 ---------- */
  $("home-odds").innerHTML = BANDS.map((b) => {
    const c = E.styleFor(b.rarity).color;
    return `<span style="color:${c};border-color:${c}55"><i>${(b.odds * 100).toFixed(0)}%</i>${b.zh} ${b.range}</span>`;
  }).join("");
  $("odds-table").innerHTML = BANDS.map((b) => {
    const s = E.styleFor(b.rarity);
    return `<tr><td style="color:${s.color};font-weight:800">${s.label}<span style="color:var(--godpack-muted);font-weight:400"> ${b.zh}</span></td><td style="color:var(--godpack-muted)">${b.range}</td><td>${(b.odds * 100).toFixed(0)}%</td></tr>`;
  }).join("");
  $("home-price").textContent = money(PACK_PRICE);
  $("btn-odds").addEventListener("click", () => $("modal-odds").classList.add("on"));
  $("btn-odds-close").addEventListener("click", () => $("modal-odds").classList.remove("on"));
  $("modal-odds").addEventListener("click", (e) => { if (e.target === $("modal-odds")) $("modal-odds").classList.remove("on"); });

  /* ---------- 3D 舞台（移植 opening3d/PackOpen3D.tsx 的指標邏輯） ---------- */
  const ui = {
    home: $("scr-home"), stage: $("scr-stage"), collection: $("collection"),
    root: $("gp-root"), float: $("gp-float"), canvas: $("gp-canvas"), probe: $("gp-probe"), hint: $("gp-hint"),
    reveal: $("gp-reveal"), info: $("info"), name: $("r-name"), meta: $("r-meta"), value: $("r-value"), mult: $("r-mult"),
    auto: $("btn-auto"),
  };
  const TAP_SLOP = 8;
  const HINTS = {
    float: "拖曳旋轉 · 點一下開包",
    sealed: "沿封口往右滑撕開 · 點一下自動撕",
    tearing: "沿封口往右滑撕開",
    torn: "往下拖把卡抽出來 · 點一下直接揭曉",
    pulling: "往下拖把卡抽出來",
    burst: "",
    slab: "拖曳檢視卡磚",
    done: "",
  };
  let engine = null, observer = null, current = null, stage = "float", drag = null, shown = false, countFrame = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** 移植 hooks.ts useResolvedQuality：弱機走 low */
  function resolveQuality() {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const small = Math.min(window.innerWidth, window.innerHeight) < 640;
    return cores <= 4 || (memory !== undefined && memory <= 4) || (coarse && small) ? "low" : "high";
  }

  function toEngineCard(card) {
    const rarity = rarityOf(card);
    const rank = ["common", "uncommon", "rare", "epic", "legendary", "mythic"].indexOf(rarity);
    return {
      id: card.i,
      name: card.n,
      subtitle: "Pokémon " + card.s,
      rarity,
      artUrl: artUrl(card),
      fullArt: true,
      backArtUrl: "assets/card-back.jpg",
      ...(card.num ? { collectorNumber: "#" + card.num } : {}),
      foil: rank >= 2,
      grade: "GEM MT",
      gradeScore: 10,
      cert: certOf(card),
    };
  }

  function setHint(s) {
    ui.hint.textContent = HINTS[s] || "";
    ui.hint.style.display = HINTS[s] ? "" : "none";
  }
  function setTheme(colors) {
    ui.root.style.setProperty("--gp-rarity", colors.color);
    ui.root.style.setProperty("--gp-accent", colors.accent);
    ui.root.style.setProperty("--gp-secondary", colors.secondary);
    ui.float.style.setProperty("--gp-tear-color", colors.color);
  }
  function fit() {
    if (!engine) return;
    const ch = ui.canvas.clientHeight, ph = ui.probe.clientHeight;
    if (ch > 0 && ph > 0) engine.setFit(ph / ch);
  }
  function destroyEngine() {
    if (observer) { observer.disconnect(); observer = null; }
    if (engine) { try { engine.dispose(); } catch (_) { /* ignore */ } engine = null; }
    ui.canvas.innerHTML = "";
    cancelAnimationFrame(countFrame);
  }

  function showHome() {
    destroyEngine();
    document.body.classList.remove("in-stage");
    ui.stage.hidden = true;
    ui.home.hidden = false;
    ui.collection.hidden = false;
    window.scrollTo({ top: 0 });
  }

  function startPack() {
    if (!POOL.length) { alert("卡池載入失敗，請重新整理"); return; }
    sfx.click();
    destroyEngine();
    current = draw();
    shown = false;
    stage = "float";
    document.body.classList.add("in-stage");
    ui.home.hidden = true;
    ui.collection.hidden = true;
    ui.stage.hidden = false;
    ui.info.hidden = true;
    ui.reveal.innerHTML = "";
    ui.auto.hidden = false;
    ui.value.classList.remove("pop");
    setTheme(E.BRAND_STYLE);
    setHint("float");

    const img = new Image();
    img.src = artUrl(current);

    try {
      engine = E.createPackOpen({
        container: ui.canvas,
        seed: E.hashSeed(current.i + ":" + Date.now()),
        quality: resolveQuality(),
        reducedMotion,
        colors: { ...E.BRAND_STYLE },
        packArtUrl: "assets/pack-art.webp",
        logoUrl: "assets/gp-logo.webp",
        cards: [toEngineCard(current)],
        onStage,
        onCardShown,
        onFinished: () => {},
      });
    } catch (err) {
      console.error(err);
      alert("這個裝置跑不動 3D 開包（需要 WebGL）。");
      showHome();
      return;
    }
    fit();
    observer = new ResizeObserver(fit);
    observer.observe(ui.canvas);
  }

  function onStage(next) {
    const prev = stage;
    stage = next;
    setHint(next);
    if (next === "sealed" && prev === "float") sfx.click();
    else if (next === "tearing" && prev === "sealed") sfx.tearTick(0.4);
    else if (next === "torn" && prev !== "torn") sfx.tearOpen();
    else if (next === "burst") { sfx.rise(); ui.auto.hidden = true; }
  }

  function onCardShown() {
    if (shown) return;
    shown = true;
    const card = current;
    const rarity = rarityOf(card);
    const style = E.styleFor(rarity);
    setTheme(style);
    ui.auto.hidden = true;
    if (style.celebration >= 1) {
      ui.reveal.innerHTML = `<div class="gp-banner gp-banner--rarity">${style.label}</div>`;
    }

    ui.name.textContent = card.n;
    ui.name.style.color = style.color;
    ui.meta.textContent = `Pokémon ${card.s}${card.num ? " · #" + card.num : ""} · PSA 10 GEM MT · cert ${certOf(card)} · ${ZH[rarity]}`;
    ui.mult.textContent = "";
    ui.value.textContent = "$0";
    ui.value.classList.remove("pop");
    ui.info.hidden = false;

    const beat = card.p >= PACK_PRICE;
    const mult = card.p / PACK_PRICE;
    let lastTickAt = 0;
    const startedAt = performance.now();
    const animate = (ts) => {
      const t = Math.min(1, (ts - startedAt) / 700);
      const eased = 1 - Math.pow(1 - t, 3);
      ui.value.textContent = money(card.p * eased);
      if (ts - lastTickAt > 65) { lastTickAt = ts; sfx.tick(); }
      if (t < 1) { countFrame = requestAnimationFrame(animate); return; }
      ui.value.textContent = money(card.p);
      ui.value.classList.add("pop");
      sfx.reveal(beat);
      if (mult >= 1) ui.mult.textContent = `${mult.toFixed(2)}× 包價`;
      if (style.celebration >= 2) setTimeout(() => sfx.burst(style.celebration), 120);
    };
    countFrame = requestAnimationFrame(animate);

    state.count += 1;
    state.total += card.p;
    if (!state.best || card.p > state.best.p) state.best = card;
    state.history.push(card);
    if (state.history.length > 200) state.history = state.history.slice(-200);
    saveState();
    renderStats();
  }

  /* 指標：float/slab 拖曳旋轉；sealed 沿封口撕；torn 往下拉；輕點＝自動跑這一步 */
  function tap() {
    if (!engine) return;
    switch (engine.getStage()) {
      case "float": engine.settle(); break;
      case "sealed": engine.autoTear(); break;
      case "torn": engine.autoPull(); break;
      default: break;
    }
  }
  ui.float.addEventListener("pointerdown", (e) => {
    if (!engine) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    ui.float.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: 0, at: performance.now() };
    if (stage === "float" || stage === "slab" || stage === "done") engine.setDragging(true);
  });
  ui.float.addEventListener("pointermove", (e) => {
    if (!engine) return;
    const rect = ui.canvas.getBoundingClientRect();
    engine.setPointer(
      ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
      true,
    );
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.hypot(dx, dy);
    switch (stage) {
      case "sealed":
      case "tearing":
        engine.scrubTear((e.clientX - rect.left) / Math.max(1, rect.width));
        break;
      case "torn":
      case "pulling":
        engine.scrubPull(dy / Math.max(1, ui.canvas.clientHeight));
        break;
      default:
        engine.rotateBy(dx * 0.0072, dy * 0.0054);
    }
  });
  const pointerUp = (e) => {
    const d = drag;
    drag = null;
    if (ui.float.hasPointerCapture && ui.float.hasPointerCapture(e.pointerId)) ui.float.releasePointerCapture(e.pointerId);
    if (!engine) return;
    engine.setDragging(false);
    if (!d) return;
    if (d.moved < TAP_SLOP && performance.now() - d.at < 500) { tap(); return; }
    if (stage === "tearing") engine.endTearScrub();
    else if (stage === "pulling") engine.endPullScrub();
  };
  ui.float.addEventListener("pointerup", pointerUp);
  ui.float.addEventListener("pointercancel", pointerUp);
  ui.float.addEventListener("pointerleave", () => engine && engine.setPointer(0, 0, false));
  document.addEventListener("visibilitychange", () => engine && engine.setPaused(document.hidden));

  ui.auto.addEventListener("click", () => {
    if (!engine) return;
    sfx.click();
    if (stage === "float" || stage === "sealed" || stage === "tearing" || stage === "torn" || stage === "pulling") engine.open();
  });
  $("btn-open").addEventListener("click", startPack);
  $("home-pack").addEventListener("click", startPack);
  $("btn-again").addEventListener("click", startPack);
  $("btn-home").addEventListener("click", () => { sfx.click(); showHome(); });
  $("btn-exit").addEventListener("click", () => { sfx.click(); showHome(); });

  renderStats();
})();
