/* GodPack PSA 10 抽卡模擬器 — 移植自 viralarc-landing godpack-components/Opening */
(() => {
  "use strict";

  const IMG_BASE = "https://storage.googleapis.com/images.pricecharting.com/";
  const PACK_PRICE = 99;
  /* 稀有度：黃 → 紅 升溫（對應 godpack.css 的 r0~r4） */
  const BANDS = [
    { key: "common", label: "COMMON", zh: "普通", color: "#8c8270", odds: 0.40, range: "$8 – $30" },
    { key: "uncommon", label: "UNCOMMON", zh: "非凡", color: "#d9b34d", odds: 0.30, range: "$30 – $100" },
    { key: "rare", label: "RARE", zh: "稀有", color: "#f7ba0b", odds: 0.18, range: "$100 – $300" },
    { key: "epic", label: "EPIC", zh: "史詩", color: "#ff7a0d", odds: 0.09, range: "$300 – $1,000" },
    { key: "legendary", label: "LEGENDARY", zh: "傳說", color: "#ed1010", odds: 0.03, range: "$1,000+" },
  ];
  const PARTICLE_TEAR = ["#f7ba0b", "#ffffff", "#c08b05", "#ffd24a"];
  const PARTICLE_EPIC = ["#ff7a0d", "#ffffff", "#ffd24a"];
  const PARTICLE_LEGEND = ["#ed1010", "#ffffff", "#ff7a0d", "#ffd24a"];

  const $ = (id) => document.getElementById(id);

  /* ---------- 工具 ---------- */
  function money(n) {
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }
  function certOf(card) {
    return String(20000000 + (hashCode(card.n + card.s + card.num + card.i) % 79999999));
  }
  function imgUrl(card, size) {
    return IMG_BASE + card.i + "/" + (size || 1600) + ".jpg";
  }
  function preload(url) {
    const im = new Image();
    im.decoding = "async";
    im.src = url;
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* ignore */ }
  }
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) { return fallback; }
  }

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
    flip: () => noiseSweep(600, 3800, 0.22, 0.14, "highpass", 0.7),
    tick: () => tone(1900, 0.018, 0.05, "square"),
    reveal: (big) => {
      tone(880, 0.18, 0.16, "triangle");
      if (big) { tone(1174.7, 0.22, 0.16, "triangle", 0.09); tone(1760, 0.3, 0.1, "sine", 0.18); }
    },
    burst: (band) => {
      const notes = band >= 4 ? [523.25, 659.25, 784, 1046.5, 1318.5] : [523.25, 659.25, 784];
      notes.forEach((n, i) => tone(n, 0.32, 0.14, "triangle", i * 0.085));
      if (band >= 4) { noiseSweep(5000, 9000, 0.5, 0.06, "highpass", 1.2); tone(2093, 0.5, 0.07, "sine", notes.length * 0.085); }
    },
    spin: () => {
      noiseSweep(700, 4800, 0.8, 0.1, "highpass", 0.8);
      tone(440, 0.55, 0.1, "triangle", 0.05, 1320);
      noiseSweep(6000, 9500, 0.5, 0.05, "highpass", 1.5);
      tone(1568, 0.28, 0.09, "sine", 0.62);
    },
  };
  function renderMute() { $("btn-mute").textContent = muted ? "🔇" : "🔊"; }
  $("btn-mute").addEventListener("click", () => {
    muted = !muted;
    store("gpsim-muted", muted);
    renderMute();
    if (!muted) sfx.click();
  });
  renderMute();

  /* ---------- 撕口幾何（移植 Opening/tear.ts） ---------- */
  const TEAR_Y = 14;
  function tearY(x) {
    const t = x / 100;
    return TEAR_Y + t * 1.2 + Math.sin(t * 1.3 * Math.PI * 2 + 0.6) * 1.6 + Math.sin(t * 2.6 * Math.PI * 2 + 2.1) * 0.32;
  }
  function tearPoints() {
    const pts = [];
    for (let x = 0; x <= 100; x += 2.5) pts.push({ x: +x.toFixed(2), y: +tearY(x).toFixed(2) });
    return pts;
  }
  const TOP_CLIP = (() => {
    const pts = tearPoints().reverse();
    return `polygon(0% 0%, 100% 0%, ${pts.map((p) => `${p.x}% ${p.y}%`).join(", ")})`;
  })();
  const BODY_CLIP = (() => {
    const pts = tearPoints();
    return `polygon(${pts.map((p) => `${p.x}% ${(p.y - 0.6).toFixed(1)}%`).join(", ")}, 100% 100%, 0% 100%)`;
  })();

  function spawnParticles(host, cx, cy, colors, count, spread) {
    spread = spread || 1;
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "godpack-particle";
      const angle = Math.random() * Math.PI * 2;
      const dist = (34 + Math.random() * 86) * spread;
      el.style.left = cx + (Math.random() - 0.5) * 40 + "px";
      el.style.top = cy + (Math.random() - 0.5) * 14 + "px";
      el.style.setProperty("--p-x", Math.cos(angle) * dist + "px");
      el.style.setProperty("--p-y", Math.sin(angle) * dist * 0.7 - 46 * spread + "px");
      el.style.setProperty("--p-rot", 120 + Math.random() * 260 + "deg");
      el.style.setProperty("--p-size", 3 + Math.random() * 6 + "px");
      el.style.setProperty("--p-dur", 0.55 + Math.random() * 0.4 + "s");
      el.style.setProperty("--p-color", colors[Math.floor(Math.random() * colors.length)]);
      host.appendChild(el);
      setTimeout(() => el.remove(), 1100);
    }
  }

  /* ---------- 鑑定磚 HTML（移植 Cards/Slab.tsx、CardBackSlab.tsx） ---------- */
  function slabWidth() {
    return Math.min(300, Math.floor(window.innerWidth * 0.72), Math.floor(window.innerHeight * 0.42));
  }
  const SHELL = "linear-gradient(155deg, #5f5a50 0%, #423d35 24%, #2a2621 55%, #464139 82%, #5f5a50 100%)";

  function slabFront(card, w) {
    const base = w * 0.041;
    const cert = certOf(card);
    return `
<div class="gp-slab godpack-glow-${card.b}" style="width:${w}px;border-radius:${w * 0.02}px;padding:${w * 0.045}px;background:${SHELL};box-shadow:inset 0 0 0 1px rgba(255,255,255,.28), inset 0 0 ${w * 0.08}px rgba(255,255,255,.10), 0 ${w * 0.05}px ${w * 0.12}px rgba(0,0,0,.55)">
  <div class="gloss"></div>
  <div class="rim" style="inset:${w * 0.018}px;border-radius:${w * 0.014}px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14), inset 0 0 ${w * 0.03}px rgba(0,0,0,.4)"></div>
  <div class="label" style="font-size:${base}px;background:#f4f1e6;color:#16130c;border-radius:${base * 0.45}px;padding:${base * 0.5}px;box-shadow:0 1px 2px rgba(0,0,0,.35)">
    <div class="box" style="border:${Math.max(1, base * 0.14)}px solid #ed1010;border-radius:${base * 0.3}px;padding:${base * 0.35}px ${base * 0.5}px;gap:${base * 0.4}px">
      <div class="l">
        <div style="font-size:.82em;line-height:1.25">POKEMON ${esc(card.s)}</div>
        <div style="font-size:.9em;line-height:1.25">${esc(card.n)}</div>
        <div style="margin-top:${base * 0.35}px;height:${base * 0.75}px;width:62%;opacity:.85;background:repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 2.6px, currentColor 2.6px 4.2px, transparent 4.2px 5.2px)"></div>
      </div>
      <div class="psa" style="font-size:1.35em">PSA</div>
      <div class="r">
        ${card.num ? `<div style="font-size:.82em;font-weight:700">#${esc(card.num)}</div>` : ""}
        <div style="font-size:.85em;font-weight:800">GEM MT</div>
        <div style="font-size:1.7em;font-weight:900;line-height:1">10</div>
        <div style="font-size:.72em;opacity:.85;font-family:ui-monospace,Menlo,monospace">${cert}</div>
      </div>
    </div>
  </div>
  <div class="slot" style="margin-top:${w * 0.03}px;border-radius:${w * 0.03}px;padding:${w * 0.022}px;background:rgba(10,8,4,.55);box-shadow:inset 0 0 ${w * 0.04}px rgba(0,0,0,.7)">
    <div class="face" style="border-radius:${w * 0.02}px"><img src="${imgUrl(card, 1600)}" alt="${esc(card.n)}" /></div>
  </div>
</div>`;
  }

  function slabBack(card, w) {
    const cert = certOf(card);
    const pad = w * 0.043;
    return `
<div class="gp-slab godpack-glow-${card.b}" style="width:${w}px;border-radius:${w * 0.02}px;padding:${pad}px;background:${SHELL};box-shadow:inset 0 0 0 1px rgba(255,255,255,.28), 0 15px 36px rgba(0,0,0,.55)">
  <div class="gloss"></div>
  <div class="backlabel" style="margin-bottom:${w * 0.027}px;padding:${w * 0.023}px ${w * 0.03}px">
    <div class="row1">
      <span class="mark" style="font-size:${w * 0.073}px">VARC</span>
      <span class="sub" style="font-size:${w * 0.043}px">VAULT</span>
      ${qrMark(w * 0.113)}
    </div>
    <div class="row2" style="margin-top:${w * 0.02}px">
      <div style="height:${w * 0.037}px;width:46%;opacity:.9;background:repeating-linear-gradient(90deg, #dfe2e5 0 1px, transparent 1px 2.6px, #dfe2e5 2.6px 4.4px, transparent 4.4px 5.4px)"></div>
      <span class="cert" style="font-size:${w * 0.04}px">${cert}</span>
    </div>
  </div>
  <div class="cardback" style="border-radius:${w * 0.027}px">
    <img src="assets/card-back.jpg" alt="" />
    <div class="halo"></div>
  </div>
</div>`;
  }

  function qrMark(size) {
    const M = ["1111111010111", "1000001001001", "1011101110101", "1011101010111", "1011101101001", "1000001011010", "1111111010111", "0000000110100", "1101011011011", "0110100101110", "1011011100101", "0100110011010", "1110101101101"];
    const n = M.length, c = size / n;
    let rects = "";
    M.forEach((row, y) => row.split("").forEach((v, x) => {
      if (v === "1") rects += `<rect x="${(x * c + c * 0.08).toFixed(2)}" y="${(y * c + c * 0.08).toFixed(2)}" width="${(c * 0.84).toFixed(2)}" height="${(c * 0.84).toFixed(2)}" fill="#16130c"/>`;
    }));
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><rect width="${size}" height="${size}" fill="#f4f1e6" rx="${size * 0.06}"/>${rects}</svg>`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  /* ---------- 卡池與抽卡 ---------- */
  let POOL = [];
  let byBand = [[], [], [], [], []];
  (function initPool() {
    const cards = Array.isArray(window.GP_CARDS) ? window.GP_CARDS : [];
    POOL = cards;
    byBand = [[], [], [], [], []];
    cards.forEach((c) => byBand[c.b].push(c));
    if (!cards.length) alert("卡池載入失敗，請重新整理");
  })();

  function draw() {
    let r = Math.random();
    let band = 0;
    for (let i = 0; i < BANDS.length; i++) {
      r -= BANDS[i].odds;
      if (r <= 0) { band = i; break; }
      band = i;
    }
    let group = byBand[band];
    while (!group.length && band > 0) group = byBand[--band];
    return group[Math.floor(Math.random() * group.length)];
  }

  /* ---------- 狀態 / 收藏 ---------- */
  const state = { count: 0, total: 0, best: null, history: [] };
  Object.assign(state, load("gpsim-state", {}));
  if (!Array.isArray(state.history)) state.history = [];

  function saveState() { store("gpsim-state", state); }
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
    strip.innerHTML = state.history
      .slice()
      .reverse()
      .slice(0, 40)
      .map((c) => `<div class="gp-thumb godpack-glow-${c.b}" title="${esc(c.n)} · ${money(c.p)}"><div class="lb"></div><img src="${imgUrl(c, 240)}" alt="" loading="lazy" /><div class="v">${money(c.p)}</div></div>`)
      .join("");
  }
  $("btn-clear").addEventListener("click", () => {
    if (!state.history.length) return;
    if (!confirm("清空收藏與統計？")) return;
    state.count = 0; state.total = 0; state.best = null; state.history = [];
    saveState();
    renderStats();
  });

  /* ---------- 畫面切換 ---------- */
  function show(id) {
    document.querySelectorAll(".gp-screen").forEach((s) => s.classList.toggle("on", s.id === id));
    window.scrollTo({ top: 0 });
  }

  /* ---------- 賠率 ---------- */
  $("home-odds").innerHTML = BANDS.map((b) => `<span style="color:${b.color};border-color:${b.color}55"><i>${(b.odds * 100).toFixed(0)}%</i>${b.zh} ${b.range}</span>`).join("");
  $("odds-table").innerHTML = BANDS.map((b) => `<tr><td style="color:${b.color};font-weight:800">${b.label}<span style="color:var(--godpack-muted);font-weight:400"> ${b.zh}</span></td><td style="color:var(--godpack-muted)">${b.range}</td><td>${(b.odds * 100).toFixed(0)}%</td></tr>`).join("");
  $("home-price").textContent = money(PACK_PRICE);
  $("btn-odds").addEventListener("click", () => $("modal-odds").classList.add("on"));
  $("btn-odds-close").addEventListener("click", () => $("modal-odds").classList.remove("on"));
  $("modal-odds").addEventListener("click", (e) => { if (e.target === $("modal-odds")) $("modal-odds").classList.remove("on"); });

  /* ---------- 流程 ---------- */
  let current = null;

  function startPack() {
    if (!POOL.length) { alert("卡池還在載入，請稍等一下"); return; }
    sfx.click();
    current = draw();
    preload(imgUrl(current, 1600));
    setupRip();
    show("scr-rip");
  }
  $("btn-open").addEventListener("click", startPack);
  $("home-pack").addEventListener("click", startPack);
  $("btn-again").addEventListener("click", startPack);
  $("btn-home").addEventListener("click", () => { sfx.click(); show("scr-home"); });

  /* ----- 撕包（移植 PackRipStage） ----- */
  const rip = {
    stage: $("rip-stage"), group: $("pack-group"), top: $("pack-top"), body: $("pack-body"),
    flash: $("rip-flash"), glow: $("cavity-glow"), hint: $("rip-hint"), zone: $("tear-zone"),
    riseHost: $("rise-host"), line: $("tear-line"), auto: $("btn-autotear"),
  };
  rip.top.style.clipPath = TOP_CLIP;
  rip.body.style.clipPath = BODY_CLIP;
  rip.line.style.top = TEAR_Y + "%";
  let dragging = false, startX = 0, progress = 0, lastTick = 0, torn = false;

  function setupRip() {
    torn = false; dragging = false; progress = 0; lastTick = 0;
    rip.stage.classList.remove("godpack-shake");
    rip.top.className = "gp-pack-layer gp-pack-top";
    rip.body.className = "gp-pack-layer gp-pack-body";
    rip.top.style.transition = ""; rip.top.style.transform = "";
    rip.body.style.transition = ""; rip.body.style.transform = "";
    rip.flash.classList.remove("godpack-flash-go");
    rip.glow.style.opacity = "0";
    rip.hint.style.opacity = "1";
    rip.riseHost.innerHTML = "";
    rip.group.classList.add("godpack-float");
    rip.auto.style.visibility = "visible";
  }

  function completeTear() {
    if (torn) return;
    torn = true;
    sfx.tearOpen();
    rip.hint.style.opacity = "0";
    rip.auto.style.visibility = "hidden";
    rip.top.style.transition = "none";
    rip.top.classList.add("godpack-top-fly");
    rip.flash.classList.add("godpack-flash-go");
    rip.stage.classList.add("godpack-shake");
    const sr = rip.stage.getBoundingClientRect();
    const gr = rip.group.getBoundingClientRect();
    spawnParticles(rip.stage, gr.left - sr.left + gr.width / 2, gr.top - sr.top + gr.height * (TEAR_Y / 100), PARTICLE_TEAR, 16);
    setTimeout(() => rip.body.classList.add("godpack-body-drop"), 80);
    setTimeout(() => {
      const w = slabWidth();
      rip.riseHost.innerHTML = `<div class="godpack-card-rise">${slabBack(current, w)}</div>`;
      sfx.rise();
    }, 150);
    setTimeout(showReveal, 800);
  }

  rip.zone.addEventListener("pointerdown", (e) => {
    if (torn) return;
    dragging = true;
    startX = e.clientX;
    rip.zone.setPointerCapture(e.pointerId);
    rip.group.classList.remove("godpack-float");
  });
  rip.zone.addEventListener("pointermove", (e) => {
    if (!dragging || torn) return;
    const span = rip.group.offsetWidth * 0.72;
    const p = Math.max(0, Math.min(1, (e.clientX - startX) / span));
    if (p - lastTick > 0.12) { lastTick = p; sfx.tearTick(p); }
    progress = p;
    rip.top.style.transition = "none";
    rip.top.style.transform = `translateX(${p * 56}%) translateY(-${p * 9}%) rotate(${p * 9}deg)`;
    rip.body.style.transition = "none";
    rip.body.style.transform = `rotate(${-p * 1.6}deg)`;
    rip.glow.style.opacity = String(Math.min(1, p * 1.4));
    rip.hint.style.opacity = String(Math.max(0, 1 - p * 2));
  });
  function pointerUp() {
    if (!dragging || torn) return;
    dragging = false;
    if (progress >= 0.55) { completeTear(); return; }
    const spring = "transform .34s cubic-bezier(.3,1.5,.4,1)";
    rip.top.style.transition = spring; rip.top.style.transform = "";
    rip.body.style.transition = spring; rip.body.style.transform = "";
    rip.glow.style.opacity = "0";
    rip.hint.style.opacity = "1";
  }
  rip.zone.addEventListener("pointerup", pointerUp);
  rip.zone.addEventListener("pointercancel", pointerUp);

  /* 手機／懶人：自動撕 */
  rip.auto.addEventListener("click", () => {
    if (torn) return;
    sfx.click();
    rip.group.classList.remove("godpack-float");
    rip.top.style.transition = "transform .32s ease-in";
    rip.top.style.transform = "translateX(34%) translateY(-6%) rotate(6deg)";
    rip.glow.style.opacity = "0.9";
    sfx.tearTick(0.6);
    setTimeout(completeTear, 300);
  });

  /* ----- 翻卡（移植 CardRevealStage） ----- */
  const rv = {
    root: $("reveal-root"), rays: $("rays"), wrap: $("flip-wrap"), outer: $("flip-outer"), inner: $("flip-inner"),
    front: $("face-front-card"), back: $("face-back-card"), hint: $("flip-hint"), result: $("result"),
    name: $("r-name"), meta: $("r-meta"), value: $("r-value"), mult: $("r-mult"), rar: $("r-rar"),
  };
  let flipped = false, countFrame = 0;

  function showReveal() {
    const card = current;
    const w = slabWidth();
    flipped = false;
    cancelAnimationFrame(countFrame);
    rv.rays.className = "gp-rays";
    rv.outer.className = "gp-flip-outer";
    rv.inner.classList.remove("flipped");
    rv.inner.style.setProperty("--slab-corner", w * 0.02 + "px");
    rv.front.innerHTML = slabFront(card, w);
    rv.back.innerHTML = slabBack(card, w);
    rv.hint.hidden = false;
    rv.result.hidden = true;
    rv.value.textContent = "$0";
    rv.value.classList.remove("godpack-value-pop");
    rv.mult.textContent = "";
    rv.root.classList.remove("godpack-shake-big");
    show("scr-reveal");
  }

  rv.wrap.addEventListener("click", () => {
    if (flipped) return;
    flipped = true;
    const card = current;
    const band = BANDS[card.b];
    sfx.flip();
    rv.inner.classList.add("flipped");
    rv.hint.hidden = true;
    const glint = document.createElement("div");
    glint.className = "godpack-glint";
    rv.front.firstElementChild.appendChild(glint);
    if (card.b >= 3) {
      rv.rays.classList.add("show");
      if (card.b === 3) rv.rays.classList.add("hot");
    }

    /* 結果區 + 金額跳數 */
    rv.name.textContent = card.n;
    rv.name.style.color = band.color;
    rv.meta.textContent = `Pokémon ${card.s}${card.num ? " · #" + card.num : ""} · PSA 10 GEM MT · cert ${certOf(card)}`;
    rv.rar.textContent = band.label + " · " + band.zh;
    rv.rar.style.color = band.color;
    rv.result.hidden = false;
    rv.result.classList.remove("godpack-rise");
    void rv.result.offsetWidth;
    rv.result.classList.add("godpack-rise");

    const beat = card.p >= PACK_PRICE;
    const mult = card.p / PACK_PRICE;
    let lastTickAt = 0;
    const startedAt = performance.now();
    const animate = (ts) => {
      const t = Math.min(1, (ts - startedAt) / 700);
      const eased = 1 - Math.pow(1 - t, 3);
      rv.value.textContent = money(card.p * eased);
      if (ts - lastTickAt > 65) { lastTickAt = ts; sfx.tick(); }
      if (t < 1) { countFrame = requestAnimationFrame(animate); return; }
      rv.value.textContent = money(card.p);
      rv.value.classList.add("godpack-value-pop");
      sfx.reveal(beat);
      if (mult >= 1) rv.mult.textContent = `${mult.toFixed(2)}× 包價`;
      if (mult >= 2) {
        setTimeout(() => {
          rv.outer.classList.add("godpack-victory-spin");
          sfx.spin();
          const r = rv.root.getBoundingClientRect();
          spawnParticles(rv.root, r.width / 2, r.height * 0.34, PARTICLE_LEGEND, 16, 1.7);
        }, 260);
      }
    };
    countFrame = requestAnimationFrame(animate);

    /* 高稀有度爆發 */
    if (card.b >= 3) {
      setTimeout(() => {
        const r = rv.root.getBoundingClientRect();
        spawnParticles(rv.root, r.width / 2, r.height * 0.36, card.b === 4 ? PARTICLE_LEGEND : PARTICLE_EPIC, 26, 1.9);
        rv.root.classList.add("godpack-shake-big");
        sfx.burst(card.b);
      }, 420);
    }

    /* 記帳 */
    state.count += 1;
    state.total += card.p;
    if (!state.best || card.p > state.best.p) state.best = card;
    state.history.push(card);
    if (state.history.length > 200) state.history = state.history.slice(-200);
    saveState();
    renderStats();
  });
  rv.outer.addEventListener("animationend", (e) => {
    if (e.target !== rv.outer) return;
    if (rv.outer.classList.contains("godpack-victory-spin")) {
      rv.outer.classList.remove("godpack-victory-spin");
      rv.outer.classList.add("godpack-victory-float");
    }
  });

  renderStats();
})();
