/* ONE SHOT — AR hunt, v2
 * 1) SCAN: frames go to /api/scan → Roboflow Workflow (SAM 3 + Depth Anything v3 + RF-DETR).
 * 2) ANALYSIS: the app shows what Roboflow found (outlines, depth, objects, distances) and builds the hunt from it.
 * 3) HUNT: real-photo animals (cut out with SAM 3) hide behind real cover; depth decides what's in front;
 *    ground geometry decides how far away things are and how big animals should be.
 */
(() => {
  "use strict";

  // ---------------- Config ----------------
  const ROUND_SECONDS = 75;
  const HFOV_LONG = 66;          // deg, typical phone main camera across the long side
  const CAM_HEIGHT = 1.3;        // m, phone held sitting/standing
  const SCAN_LONG_SIDE = 640;
  const SHOT_COOLDOWN_MS = 420;

  const SPECIES = {
    rabbit:   { name: "Cottontail",     spr: "rabbit",   realH: 0.30, minPx: 40, pts: 100, win: 3.0 },
    squirrel: { name: "Grey squirrel",  spr: "squirrel", realH: 0.27, minPx: 36, pts: 150, win: 2.6 },
    sparrow:  { name: "Sparrow",        spr: "sparrow",  realH: 0.16, minPx: 32, pts: 200, win: 2.6 },
    buck:     { name: "Buck",           spr: "buck",     realH: 1.05, minPx: 70, pts: 400, win: 2.3 },
    tern:     { name: "Tern",           spr: "tern",     realH: 0.42, minPx: 110, pts: 300, win: 0 },
    whimbrel: { name: "Whimbrel",       spr: "whimbrel", realH: 0.50, minPx: 120, pts: 300, win: 0 },
    ghost:    { name: "Ghost squirrel", spr: "ghost",    realH: 0.36, minPx: 52, pts: 1500, win: 1.5 },
  };
  const KIND_LABEL = { trunk: "tree trunk", bush: "bush", rock: "rock", bench: "bench", fence: "fence", log: "log", stump: "stump", sky: "sky" };
  const KIND_COLOR = { trunk: "#a476ff", bush: "#ff6b5b", rock: "#9fb4c8", bench: "#ffb347", fence: "#f5d64b", log: "#c58b5a", stump: "#c58b5a", sky: "#5bc0ff" };

  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);
  const canvas = $("view"), ctx = canvas.getContext("2d");
  const video = $("cam");
  const ui = { hud: $("hud"), score: $("score"), streak: $("streak"), timer: $("timer"), ammo: $("ammo"),
    reticle: $("reticle"), toast: $("toast"), status: $("status"), toolbar: $("toolbar"),
    scan: $("scan"), sweep: document.querySelector("#sweep i"), frames: $("frames"), scanTitle: $("scanTitle"), scanHint: $("scanHint"),
    analysis: $("analysis"), brief: $("brief"), warns: $("warns"), anaStats: $("anaStats") };

  // ---------------- State ----------------
  const S = {
    phase: "home",            // home | scan | analysis | hunt | over
    source: null, img: null,  // "camera" | "photo"
    W: 0, H: 0, dpr: 1,
    frames: [], primary: null, pending: 0,
    orient: null, sm: null, gyro: false,
    layer: "seg", anaT0: 0, vision: 0,
    aim: { x: 0, y: 0 }, mouse: false,
    brief: null,
    animals: [], tells: [], fx: [],
    round: null, score: 0, streak: 0, bestStreak: 0, hits: 0, shots: 0, longest: 0, best: null,
    lastShot: 0, lastRescan: 0, scanning: false,
  };
  window.__hunt = S;

  // ---------------- Layout ----------------
  function resize() {
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.W = window.innerWidth; S.H = window.innerHeight;
    canvas.width = Math.round(S.W * S.dpr); canvas.height = Math.round(S.H * S.dpr);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    if (!S.mouse) { S.aim.x = S.W / 2; S.aim.y = S.H / 2; }
  }
  window.addEventListener("resize", resize); resize();

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = { lin: (u) => u, i: (u) => u * u, o: (u) => 1 - (1 - u) * (1 - u), io: (u) => 0.5 - Math.cos(Math.PI * u) / 2 };

  function viewFrame() { return S.frames[S.view] || S.primary; }
  function srcEl() { return S.phase === "analysis" && S.source === "camera" && viewFrame() ? viewFrame().canvas : (S.source === "camera" ? video : S.img); }
  function srcSize() {
    const el = srcEl();
    if (!el) return [1, 1];
    return [el.videoWidth || el.naturalWidth || el.width || 1, el.videoHeight || el.naturalHeight || el.height || 1];
  }
  function cover() {
    const [vw, vh] = srcSize();
    const s = Math.max(S.W / vw, S.H / vh), sw = vw * s, sh = vh * s;
    return { sw, sh, dx: (S.W - sw) / 2, dy: (S.H - sh) / 2 };
  }
  function drawSource(c) { const el = srcEl(); if (el) ctx.drawImage(el, c.dx, c.dy, c.sw, c.sh); }

  // ---------------- Motion sensors ----------------
  function onOrient(e) {
    if (e.alpha == null) return;
    S.gyro = true;
    S.orient = { a: e.alpha, b: e.beta, g: e.gamma };
    if (!S.sm) S.sm = { ...S.orient };
  }
  async function enableMotion() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        if ((await DeviceOrientationEvent.requestPermission()) !== "granted") return;
      }
      window.addEventListener("deviceorientation", onOrient);
    } catch (_) {}
  }
  const angDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
  function smoothOrient() {
    if (!S.orient || !S.sm) return;
    S.sm.a += angDiff(S.orient.a, S.sm.a) * 0.3;
    S.sm.b += (S.orient.b - S.sm.b) * 0.3;
  }
  function pan(fr, c) {
    if (S.source !== "camera" || S.phase === "analysis" || !S.gyro || !fr || !fr.orient || !S.sm) return [0, 0];
    const ppd = c.sw / (fr.w >= fr.h ? HFOV_LONG : HFOV_LONG * (fr.w / fr.h));
    return [angDiff(S.sm.a, fr.orient.a) * ppd, (S.sm.b - fr.orient.b) * ppd];
  }
  function toScreen(fr, nx, ny, c) { const [px, py] = pan(fr, c); return [c.dx + nx * c.sw + px, c.dy + ny * c.sh + py]; }
  function fromScreen(fr, x, y, c) { const [px, py] = pan(fr, c); return [(x - c.dx - px) / c.sw, (y - c.dy - py) / c.sh]; }

  // ---------------- Camera model / measurement ----------------
  // Ground-plane geometry: a point on the ground at row y is at distance CAM_HEIGHT / tan(angle below horizon).
  function fN(fr) { return (Math.max(fr.w, fr.h) / 2 / Math.tan((HFOV_LONG / 2) * Math.PI / 180)) / fr.h; }
  function groundDist(fr, ny) {
    const ang = Math.atan((ny - 0.5) / fN(fr)) - (fr.pitchUp * Math.PI) / 180;
    if (ang < (0.8 * Math.PI) / 180) return null;
    return clamp(CAM_HEIGHT / Math.tan(ang), 0.8, 80);
  }
  function depthAt(fr, nx, ny) {
    const d = fr.depth; if (!d) return 0.5;
    const gx = clamp(Math.floor(nx * d.w), 0, d.w - 1), gy = clamp(Math.floor(ny * d.h), 0, d.h - 1);
    return d.data[gy * d.w + gx] / 255;
  }
  // Distance for a ground contact point: geometry first, depth as a fallback (relative → rough metres).
  function distAt(fr, nx, ny) { return groundDist(fr, ny) ?? lerp(40, 2, depthAt(fr, nx, ny)); }
  function measure(fr, l) {
    const base = polyBottom(l), cx = l.box.x + l.box.w / 2;
    const d = distAt(fr, cx, base);
    return { d, h: (d * l.box.h) / fN(fr) };
  }
  const fmtM = (m) => (m >= 10 ? Math.round(m) : m.toFixed(1)) + " m";

  // ---------------- Geometry helpers ----------------
  function polyBottom(l) { let m = 0; for (const p of l.poly) if (p[1] > m) m = p[1]; return m; }
  function polyTopNear(l, nx, frac = 0.25) {
    let best = Infinity;
    for (const [x, y] of l.poly) if (Math.abs(x - nx) < l.box.w * frac) best = Math.min(best, y);
    return best === Infinity ? l.box.y : best;
  }
  function inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function screenPath(fr, poly, c, ox = 0, oy = 0) {
    const p = new Path2D();
    poly.forEach(([x, y], i) => { const [sx, sy] = toScreen(fr, x, y, c); i ? p.lineTo(sx + ox, sy + oy) : p.moveTo(sx + ox, sy + oy); });
    p.closePath(); return p;
  }

  // ---------------- Sprites (CC0 photos, cut out with SAM 3 polygons) ----------------
  const SPR = {};
  let spritesReady = null;
  function loadSprites() {
    if (spritesReady) return spritesReady;
    const defs = window.SPRITES || {};
    spritesReady = Promise.all(Object.entries(defs).map(([k, d]) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight;
        const bx = d.box[0] * W, by = d.box[1] * H, bw = (d.box[2] - d.box[0]) * W, bh = (d.box[3] - d.box[1]) * H;
        const k2 = Math.min(1, 360 / Math.max(bw, bh));
        const cw = Math.max(2, Math.round(bw * k2)), ch = Math.max(2, Math.round(bh * k2));
        const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
        const g = cv.getContext("2d");
        g.drawImage(img, bx, by, bw, bh, 0, 0, cw, ch);
        const mask = document.createElement("canvas"); mask.width = cw; mask.height = ch;
        const m = mask.getContext("2d");
        const local = d.polys.map((poly) => poly.map(([x, y]) => [((x * W - bx) / bw), ((y * H - by) / bh)]));
        m.fillStyle = "#000";
        for (const poly of local) { m.beginPath(); poly.forEach(([x, y], i) => (i ? m.lineTo(x * cw, y * ch) : m.moveTo(x * cw, y * ch))); m.closePath(); m.fill(); }
        g.globalCompositeOperation = "destination-in";
        try { g.filter = "blur(0.8px)"; } catch (_) {}
        g.drawImage(mask, 0, 0); g.filter = "none"; g.globalCompositeOperation = "source-over";
        SPR[k] = { canvas: cv, w: cw, h: ch, asp: cw / ch, face: d.face, polys: local, conf: d.conf };
        resolve();
      };
      img.onerror = () => resolve();
      img.src = "/api/img?u=" + encodeURIComponent(d.url);
    })));
    return spritesReady;
  }

  // ---------------- Scanning (Roboflow) ----------------
  let frameSeq = 0;
  function grabFrame() {
    const el = S.source === "camera" ? video : S.img;
    const vw = el.videoWidth || el.naturalWidth, vh = el.videoHeight || el.naturalHeight;
    const k = Math.min(1, SCAN_LONG_SIDE / Math.max(vw, vh));
    const cv = document.createElement("canvas"); cv.width = Math.round(vw * k); cv.height = Math.round(vh * k);
    cv.getContext("2d").drawImage(el, 0, 0, cv.width, cv.height);
    const orient = S.source === "camera" && S.orient ? { ...S.orient } : null;
    const portrait = !screen.orientation || Math.abs(screen.orientation.angle || 0) !== 90;
    const pitchUp = orient && portrait ? clamp(orient.b - 90, -60, 60) : 0;
    return { id: ++frameSeq, canvas: cv, w: cv.width, h: cv.height, orient, pitchUp, scene: null, depth: null, covers: [], sky: [], dets: [], ms: 0 };
  }
  async function analyzeFrame(fr) {
    const b64 = fr.canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
    const t0 = performance.now();
    const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: b64 }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "scan failed");
    fr.scene = data; fr.ms = Math.round(performance.now() - t0); fr.rfMs = data.ms;
    if (data.depth) {
      const bin = atob(data.depth.data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      fr.depth = { w: data.depth.w, h: data.depth.h, data: arr };
      fr.depthImg = depthImage(fr.depth);
    }
    fr.covers = data.landmarks.filter((l) => l.kind !== "sky").map((l) => ({ ...l, m: null }));
    for (const l of fr.covers) l.m = measure(fr, l);
    fr.sky = data.landmarks.filter((l) => l.kind === "sky");
    fr.skyFrac = data.sky || 0;
    fr.dets = data.detections || [];
    for (const d of fr.dets) d.dist = distAt(fr, d.box.x + d.box.w / 2, d.box.y + d.box.h);
    return fr;
  }
  // Turbo-ish colormap for the depth layer (near = warm, far = cool)
  function turbo(t) {
    const r = 34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))));
    const g = 23.31 + t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56))));
    const b = 27.2 + t * (3211.1 - t * (15327.97 - t * (27814 - t * (22569.18 - t * 6838.66))));
    return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
  }
  function depthImage(d) {
    const cv = document.createElement("canvas"); cv.width = d.w; cv.height = d.h;
    const g = cv.getContext("2d"), im = g.createImageData(d.w, d.h);
    for (let i = 0; i < d.data.length; i++) {
      const [r, gg, b] = turbo(d.data[i] / 255);
      im.data[i * 4] = r; im.data[i * 4 + 1] = gg; im.data[i * 4 + 2] = b; im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0); return cv;
  }

  // ---------------- Scan phase ----------------
  const scanState = { start: 0, last: 0, lastYaw: null, max: 1, done: false, finish: false };
  function beginScan() {
    S.phase = "scan"; S.frames = []; S.primary = null; S.pending = 0;
    show(null); hideGameUI();
    ui.scan.classList.add("show"); ui.frames.innerHTML = ""; ui.sweep.style.width = "0%";
    setModels("");
    scanState.start = performance.now(); scanState.last = 0; scanState.lastYaw = null; scanState.done = false; scanState.finish = false;
    scanState.max = S.source === "camera" ? 8 : 1;
    const done = $("scanDone"); done.style.display = S.source === "camera" ? "block" : "none"; done.disabled = true; done.textContent = "Finish scan";
    ui.scanTitle.textContent = S.source === "camera" ? "Scan your hunting ground" : "Analyzing your scene";
    ui.scanHint.textContent = S.source === "camera" ? (S.gyro ? "Slowly pan around — trees, bushes, benches, fences. Tap Finish when you're done." : "Point at trees, bushes, a bench… tap Finish when you're done.") : "Sending it to Roboflow";
    loadSprites();
  }
  function setModels(state) { for (const el of document.querySelectorAll(".model")) { el.classList.toggle("busy", state === "busy"); el.classList.toggle("done", state === "done"); } }
  function scanTick(now) {
    if (scanState.done) return;
    const n = S.frames.length;
    if (n < scanState.max) {
      const since = now - scanState.last, elapsed = now - scanState.start;
      const yaw = S.orient ? S.orient.a : null;
      const moved = scanState.lastYaw == null || yaw == null ? 0 : Math.abs(angDiff(yaw, scanState.lastYaw));
      const first = n === 0 && elapsed > (S.source === "camera" ? 900 : 100);
      if (!scanState.finish && (first || (n > 0 && since > 1400 && (moved > 14 || since > (S.gyro ? 2400 : 2800))))) {
        scanState.last = now; scanState.lastYaw = yaw;
        captureForScan();
      }
    }
    const returned = S.frames.filter((f) => f.scene).length;
    const cap = S.frames.length / scanState.max, ret = S.frames.filter((f) => f.scene || f.failed).length / scanState.max;
    ui.sweep.style.width = Math.round((cap * 0.5 + ret * 0.5) * 100) + "%";
    if (S.source === "camera") {
      const done = $("scanDone");
      done.disabled = returned < 1;
      done.textContent = scanState.finish ? (S.pending ? "Finishing… Roboflow still analyzing" : "Finishing…")
        : returned < 1 ? "Scanning… (first frame analyzing)" : `Finish scan · ${S.frames.length} frame${S.frames.length > 1 ? "s" : ""}`;
    }
    const enough = S.source !== "camera" || scanState.finish || S.frames.length >= scanState.max;
    if (enough && S.frames.length && S.pending === 0) {
      scanState.done = true;
      const ok = S.frames.filter((f) => f.scene);
      if (!ok.length) { status("Roboflow scan failed — check connection and retry", 4000); setTimeout(goHome, 2500); return; }
      S.frames = ok;
      S.primary = ok[ok.length - 1];
      setModels("done");
      $("scanDone").style.display = "none";
      setTimeout(enterAnalysis, 450);
    }
  }
  function captureForScan() {
    const fr = grabFrame(); S.frames.push(fr); S.pending++;
    setModels("busy");
    const card = document.createElement("div"); card.className = "fcard";
    const th = document.createElement("canvas"); th.width = 192; th.height = 128;
    card.appendChild(th); const lab = document.createElement("div"); lab.textContent = "Roboflow analyzing…"; card.appendChild(lab);
    ui.frames.appendChild(card);
    drawThumb(th, fr);
    analyzeFrame(fr).then(() => {
      card.classList.add("done");
      const nObj = fr.covers.length + fr.dets.length;
      lab.textContent = `${nObj} objects · ${(fr.rfMs / 1000).toFixed(1)} s`;
      drawThumb(th, fr);
    }).catch((e) => { fr.failed = true; lab.textContent = "failed"; console.warn(e); })
      .finally(() => { S.pending--; });
  }
  function drawThumb(cv, fr) {
    const g = cv.getContext("2d"), k = Math.max(cv.width / fr.w, cv.height / fr.h);
    const w = fr.w * k, h = fr.h * k, ox = (cv.width - w) / 2, oy = (cv.height - h) / 2;
    g.drawImage(fr.canvas, ox, oy, w, h);
    if (!fr.scene) return;
    g.globalAlpha = 0.55;
    for (const l of fr.covers) {
      g.fillStyle = KIND_COLOR[l.kind] || "#fff"; g.beginPath();
      l.poly.forEach(([x, y], i) => (i ? g.lineTo(ox + x * w, oy + y * h) : g.moveTo(ox + x * w, oy + y * h)));
      g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
  }

  // ---------------- Analysis phase ----------------
  function enterAnalysis() {
    S.phase = "analysis"; S.anaT0 = performance.now(); S.layer = "seg";
    ui.scan.classList.remove("show");
    S.brief = buildBrief();
    renderBrief();
    S.view = Math.max(0, S.frames.indexOf(S.primary)); S.focus = null; S.objFilter = "all";
    ui.analysis.classList.remove("min"); $("anaToggle").textContent = "▾ Hide";
    renderFrameStrip(); renderObjects();
    setTab("seg");
    ui.analysis.classList.add("show");
    // auto-tour the layers once
    clearTimeout(S.tour);
    S.tour = setTimeout(() => setTab("depth"), 2600);
    S.tour2 = setTimeout(() => setTab("det"), 4800);
    S.tour3 = setTimeout(() => setTab("all"), 6800);
  }
  function setTab(layer) {
    S.layer = layer; S.anaT0 = performance.now();
    for (const b of document.querySelectorAll("#tabs .chip")) b.classList.toggle("on", b.dataset.layer === layer);
  }
  function stopTour() { clearTimeout(S.tour); clearTimeout(S.tour2); clearTimeout(S.tour3); }

  function buildBrief() {
    const covers = S.frames.flatMap((f) => f.covers.map((l) => ({ l, f })));
    const dets = S.frames.flatMap((f) => f.dets);
    const count = (k) => covers.filter((c) => c.l.kind === k).length;
    const n = { trunk: count("trunk"), bush: count("bush"), rock: count("rock") + count("stump") + count("log"), bench: count("bench"), fence: count("fence") };
    const sky = Math.max(0, ...S.frames.map((f) => f.skyFrac || 0));
    const far = covers.filter((c) => c.l.m && c.l.m.d >= 6).sort((a, b) => b.l.m.d - a.l.m.d)[0];
    const tallTrunk = covers.find((c) => c.l.kind === "trunk" && c.l.box.h > 0.22);
    const people = dets.filter((d) => d.cls === "person").length;
    const dogs = dets.filter((d) => d.cls === "dog").length;
    const cars = dets.filter((d) => ["car", "truck", "bus", "motorcycle"].includes(d.cls)).length;
    const birds = dets.filter((d) => d.cls === "bird").length;
    const pl = (k, w, s = "s") => `${k} ${w}${k === 1 ? "" : s}`;
    const sp = [];
    sp.push({ k: "rabbit", on: true, why: n.bush ? `${pl(n.bush, "bush", "es")} to hide in` : "hops across open ground" });
    sp.push({ k: "squirrel", on: n.trunk + n.rock + n.bench > 0, why: n.trunk ? `${pl(n.trunk, "tree trunk")} to dart from` : n.rock + n.bench ? "rocks & benches to perch on" : "needs trunks, rocks or benches" });
    sp.push({ k: "sparrow", on: n.fence + n.bench + n.rock + n.bush > 0, why: n.fence + n.bench + n.rock + n.bush > 0 ? `perches on ${[n.fence && pl(n.fence, "fence"), n.bench && pl(n.bench, "bench", "es"), n.rock && pl(n.rock, "rock"), n.bush && pl(n.bush, "bush", "es")].filter(Boolean).join(", ")}` : "needs a fence, bench or rock" });
    sp.push({ k: "buck", on: !!far, why: far ? `cover ${fmtM(far.l.m.d)} out (${KIND_LABEL[far.l.kind]})` : "needs cover 6 m+ away" });
    sp.push({ k: "tern", on: sky > 0.025 || true, why: sky > 0.025 ? `open sky · ${Math.round(sky * 100)}% of view` : "fly-overs above the tree line" });
    sp.push({ k: "ghost", on: !!tallTrunk, rare: true, why: tallTrunk ? `rare · clings to tall trunks (${fmtM(tallTrunk.l.m.h)} tall)` : "rare · needs a tall tree trunk" });
    const warns = [];
    if (people) warns.push(`👤 ${pl(people, "person", "s")} detected — animals keep away from them`);
    if (dogs) warns.push(`🐕 Dog detected — everything is jumpy (shorter windows)`);
    if (cars) warns.push(`🚗 ${pl(cars, "vehicle")} — birds fly higher`);
    if (birds) warns.push(`🐦 ${pl(birds, "real bird")} spotted by RF-DETR`);
    const near = covers.slice().sort((a, b) => a.l.m.d - b.l.m.d)[0];
    return { sp, warns, people, dogs, cars, near, far, sky,
      winMul: dogs ? 0.82 : 1, skyLift: cars ? 0.08 : 0,
      nObj: covers.length + dets.length,
      avgMs: Math.round(S.frames.reduce((s, f) => s + (f.rfMs || 0), 0) / S.frames.length) };
  }
  function renderBrief() {
    const b = S.brief;
    ui.anaStats.textContent = `${S.frames.length} frame${S.frames.length > 1 ? "s" : ""} · ${b.nObj} objects · ${(b.avgMs / 1000).toFixed(1)} s/frame`;
    ui.warns.innerHTML = b.warns.map((w) => `<div class="warn">${w}</div>`).join("") +
      (b.near ? `<div class="warn" style="color:var(--dim)">📏 Nearest cover: ${KIND_LABEL[b.near.l.kind]} at ${fmtM(b.near.l.m.d)}${b.far ? ` · farthest: ${fmtM(b.far.l.m.d)}` : ""}</div>` : "");
    ui.brief.innerHTML = "";
    for (const s of b.sp) {
      const spec = SPECIES[s.k];
      const row = document.createElement("div"); row.className = "sp" + (s.on ? "" : " off");
      const icon = document.createElement("canvas"); icon.width = 80; icon.height = 80;
      row.appendChild(icon);
      row.insertAdjacentHTML("beforeend", `<div><div class="t">${spec.name}${s.rare ? " ✨" : ""}</div><div class="r">${s.why}</div></div><div class="pts">${s.on ? spec.pts : "—"}</div>`);
      ui.brief.appendChild(row);
      spritesReady.then(() => {
        const sp = SPR[spec.spr]; if (!sp) return;
        const g = icon.getContext("2d"), k = Math.min(76 / sp.w, 76 / sp.h);
        g.drawImage(sp.canvas, (80 - sp.w * k) / 2, (80 - sp.h * k) / 2, sp.w * k, sp.h * k);
      });
    }
  }

  // ---- browsable scene: frames strip + full object list + tap-to-highlight
  function objectsOf(fr) {
    const segs = fr.covers.map((l, i) => ({ type: "seg", i, l, label: KIND_LABEL[l.kind], conf: l.conf, color: KIND_COLOR[l.kind], d: l.m && l.m.d, h: l.m && l.m.h }));
    const dets = fr.dets.map((d, i) => ({ type: "det", i, det: d, label: d.cls, conf: d.conf, color: "#3fe0a8", d: d.dist, h: (d.dist * d.box.h) / fN(fr) }));
    const sky = fr.sky.map((l, i) => ({ type: "sky", i, l, label: "sky", conf: l.conf, color: KIND_COLOR.sky }));
    return { segs, dets, sky };
  }
  function renderFrameStrip() {
    const el = $("anaFrames"); el.innerHTML = "";
    S.frames.forEach((fr, i) => {
      const t = document.createElement("div"); t.className = "athumb" + (i === S.view ? " on" : "");
      const cv = document.createElement("canvas"); cv.width = 168; cv.height = 112; t.appendChild(cv);
      t.insertAdjacentHTML("beforeend", `<span>#${i + 1} · ${fr.covers.length + fr.dets.length}</span>`);
      drawThumb(cv, fr);
      t.onclick = () => { S.view = i; S.focus = null; S.anaT0 = performance.now(); stopTour(); renderFrameStrip(); renderObjects(); };
      el.appendChild(t);
    });
    $("frameLabel").textContent = S.frames.length > 1 ? `frame ${S.view + 1} of ${S.frames.length}` : "";
    $("anaFrames").parentElement && ($("anaFrames").style.display = S.frames.length > 1 ? "flex" : "flex");
  }
  function renderObjects() {
    const fr = viewFrame(), { segs, dets, sky } = objectsOf(fr), f = S.objFilter || "all";
    const list = (f === "seg" ? segs : f === "det" ? dets : [...segs, ...dets, ...sky]).slice().sort((a, b) => (a.d ?? 999) - (b.d ?? 999));
    $("objCount").textContent = `${segs.length} segments · ${dets.length} objects`;
    for (const b of document.querySelectorAll("#objFilter .chip")) b.classList.toggle("on", b.dataset.f === f);
    const el = $("objList"); el.innerHTML = "";
    if (!list.length) el.innerHTML = `<div class="r" style="color:var(--dim);font-size:12px">Nothing in this category for this frame.</div>`;
    for (const o of list) {
      const row = document.createElement("div");
      row.className = "obj" + (S.focus && S.focus.type === o.type && S.focus.i === o.i ? " on" : "");
      const src = o.type === "det" ? "RF-DETR" : "SAM 3";
      const meas = o.d != null ? `${fmtM(o.d)} away${o.h ? ` · ${fmtM(o.h)} tall` : ""}` : "";
      row.innerHTML = `<i style="background:${o.color}"></i><div><b>${o.label}</b> <span style="color:var(--dim)">${o.conf.toFixed(2)}</span><div class="src">${src}</div></div><div class="m">${meas}</div>`;
      row.onclick = () => { stopTour(); S.focus = (S.focus && S.focus.type === o.type && S.focus.i === o.i) ? null : { type: o.type, i: o.i }; S.focusT = performance.now(); if (S.layer === "depth") setTab("all"); renderObjects(); };
      el.appendChild(row);
    }
  }
  function focusObj(fr) {
    if (!S.focus) return null;
    const { segs, dets, sky } = objectsOf(fr);
    return (S.focus.type === "seg" ? segs : S.focus.type === "det" ? dets : sky)[S.focus.i] || null;
  }
  function drawFocus(fr, c, now) {
    const o = focusObj(fr); if (!o) return;
    const pulse = 0.5 + 0.5 * Math.sin((now - (S.focusT || 0)) / 180);
    let path;
    if (o.type === "det") {
      const [x0, y0] = toScreen(fr, o.det.box.x, o.det.box.y, c), [x1, y1] = toScreen(fr, o.det.box.x + o.det.box.w, o.det.box.y + o.det.box.h, c);
      path = new Path2D(); path.rect(x0, y0, x1 - x0, y1 - y0);
    } else path = screenPath(fr, o.l.poly, c);
    ctx.save();
    const dim = new Path2D(); dim.rect(0, 0, S.W, S.H); dim.addPath(path);
    ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fill(dim, "evenodd");
    ctx.lineWidth = 3 + pulse * 2; ctx.strokeStyle = o.color; ctx.shadowColor = o.color; ctx.shadowBlur = 12; ctx.stroke(path);
    ctx.restore();
    const box = o.type === "det" ? o.det.box : o.l.box;
    const [tx, ty] = toScreen(fr, box.x + box.w / 2, box.y, c);
    const meas = o.d != null ? `${fmtM(o.d)} away${o.h ? ` · ${fmtM(o.h)} tall` : ""}` : "no ground contact";
    tag(tx, Math.max(ty - 22, 56), `${o.label.toUpperCase()} · ${o.conf.toFixed(2)} · ${o.type === "det" ? "RF-DETR" : "SAM 3"}`, meas, o.color, 1);
  }
  function pickAt(x, y) {
    const fr = viewFrame(), c = cover(), [nx, ny] = fromScreen(fr, x, y, c), { segs, dets } = objectsOf(fr);
    const hitsDet = dets.filter((o) => nx >= o.det.box.x && nx <= o.det.box.x + o.det.box.w && ny >= o.det.box.y && ny <= o.det.box.y + o.det.box.h);
    const hitsSeg = segs.filter((o) => inPoly(nx, ny, o.l.poly));
    const area = (o) => (o.type === "det" ? o.det.box.w * o.det.box.h : o.l.box.w * o.l.box.h);
    const all = [...hitsDet, ...hitsSeg].sort((a, b) => area(a) - area(b)); // smallest (most specific) first
    S.focus = all.length ? { type: all[0].type, i: all[0].i } : null; S.focusT = performance.now();
    stopTour(); renderObjects();
    const on = document.querySelector("#objList .obj.on"); if (on) on.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function renderAnalysis(now) {
    const c = cover(), fr = viewFrame();
    ctx.clearRect(0, 0, S.W, S.H);
    drawSource(c);
    const t = (now - S.anaT0) / 1000;
    const L = S.layer;
    if (L === "depth" || L === "all") {
      const a = L === "all" ? 0.35 : clamp(t / 0.8, 0, 1) * 0.62;
      const reveal = L === "all" ? 1 : clamp(t / 1.2, 0, 1);
      if (fr.depthImg) {
        ctx.save(); ctx.globalAlpha = a; ctx.imageSmoothingEnabled = true;
        ctx.beginPath(); ctx.rect(c.dx, c.dy, c.sw, c.sh * reveal); ctx.clip();
        ctx.drawImage(fr.depthImg, c.dx, c.dy, c.sw, c.sh); ctx.restore();
      }
      if (L === "depth") legendDepth();
    }
    if (L === "seg" || L === "all") drawSegments(fr, c, L === "all" ? 99 : t, !S.focus);
    if (L === "det" || L === "all") drawDetections(fr, c, L === "all" ? 99 : t);
    drawFocus(fr, c, now);
    // header ribbon
    ctx.save();
    ctx.fillStyle = "rgba(15,14,11,.72)"; ctx.fillRect(0, 0, S.W, 34);
    ctx.font = "700 12px ui-sans-serif, system-ui"; ctx.fillStyle = "#c9b5ff"; ctx.textAlign = "left";
    const label = { seg: "SAM 3 · open-vocabulary segmentation", depth: "Depth Anything v3 · monocular depth", det: "RF-DETR · object detection", all: "Roboflow Workflow · all layers" }[L];
    ctx.fillText(label, 12, 22);
    ctx.restore();
  }
  function legendDepth() {
    const w = 140, x = 12, y = 44;
    for (let i = 0; i < w; i++) { const [r, g, b] = turbo(i / w); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x + i, y, 1, 8); }
    ctx.font = "600 10px ui-sans-serif, system-ui"; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText("far", x, y + 20); ctx.textAlign = "right"; ctx.fillText("near", x + w, y + 20);
  }
  function drawSegments(fr, c, t, labels) {
    const covers = fr.covers;
    ctx.save();
    covers.forEach((l, i) => {
      const appear = clamp((t - i * 0.08) / 0.35, 0, 1); if (appear <= 0) return;
      const p = screenPath(fr, l.poly, c);
      ctx.globalAlpha = 0.38 * appear; ctx.fillStyle = KIND_COLOR[l.kind]; ctx.fill(p);
      ctx.globalAlpha = Math.min(1, appear * 1.5); ctx.strokeStyle = KIND_COLOR[l.kind]; ctx.lineWidth = 2; ctx.stroke(p);
    });
    if (labels) {
      ctx.globalAlpha = 1;
      const placed = [];
      covers.slice(0, 12).forEach((l, i) => {
        const appear = clamp((t - 0.3 - i * 0.08) / 0.3, 0, 1); if (appear <= 0) return;
        const [x, y] = toScreen(fr, l.box.x + l.box.w / 2, l.box.y + Math.min(l.box.h * 0.5, 0.25), c);
        if (placed.some(([px, py]) => Math.abs(px - x) < 90 && Math.abs(py - y) < 34)) return;
        placed.push([x, y]);
        tag(x, y, `${KIND_LABEL[l.kind].toUpperCase()} ${l.conf.toFixed(2)}`, l.m ? `${fmtM(l.m.d)} away · ${fmtM(l.m.h)} tall` : "", KIND_COLOR[l.kind], appear);
      });
    }
    ctx.restore();
  }
  function drawDetections(fr, c, t) {
    ctx.save();
    fr.dets.forEach((d, i) => {
      const appear = clamp((t - i * 0.12) / 0.3, 0, 1); if (appear <= 0) return;
      const [x0, y0] = toScreen(fr, d.box.x, d.box.y, c), [x1, y1] = toScreen(fr, d.box.x + d.box.w, d.box.y + d.box.h, c);
      ctx.globalAlpha = appear; ctx.strokeStyle = "#3fe0a8"; ctx.lineWidth = 2; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.font = "800 11px ui-sans-serif, system-ui"; const txt = `${d.cls} ${d.conf.toFixed(2)} · ${fmtM(d.dist)}`;
      const tw = ctx.measureText(txt).width + 10;
      ctx.fillStyle = "#3fe0a8"; ctx.fillRect(x0, y0 - 18, tw, 18); ctx.fillStyle = "#06251b"; ctx.textAlign = "left"; ctx.fillText(txt, x0 + 5, y0 - 5);
    });
    ctx.restore();
  }
  function tag(x, y, t1, t2, color, alpha = 1) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.font = "800 11px ui-sans-serif, system-ui"; const w1 = ctx.measureText(t1).width;
    ctx.font = "600 10px ui-sans-serif, system-ui"; const w2 = t2 ? ctx.measureText(t2).width : 0;
    const w = Math.max(w1, w2) + 14, h = t2 ? 32 : 19;
    const bx = clamp(x - w / 2, 4, S.W - w - 4), by = clamp(y - h / 2, 40, S.H - h - 4);
    ctx.fillStyle = "rgba(10,10,10,.78)"; roundRect(bx, by, w, h, 6); ctx.fill();
    ctx.fillStyle = color; ctx.fillRect(bx, by, 3, h);
    ctx.textAlign = "left"; ctx.fillStyle = "#fff"; ctx.font = "800 11px ui-sans-serif, system-ui"; ctx.fillText(t1, bx + 9, by + 13);
    if (t2) { ctx.fillStyle = "#d8cfbf"; ctx.font = "600 10px ui-sans-serif, system-ui"; ctx.fillText(t2, bx + 9, by + 26); }
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------------- Hunt: animals ----------------
  // An animal moves along keyframes {t, x, y, e, hop, c:[cx,cy]} in its frame's normalized coordinates.
  function animalSizeN(fr, sp, nx, ny, distOverride) {
    const spec = SPECIES[sp], c = cover();
    const d = distOverride ?? distAt(fr, nx, ny);
    let hN = (spec.realH * fN(fr)) / d;
    hN = clamp(hN, spec.minPx / c.sh, 0.5);
    return { hN, d };
  }
  function wNorm(fr, sp, hN) { const s = SPR[SPECIES[sp].spr]; return hN * (s ? s.asp : 1) * (fr.h / fr.w); }
  function mkAnimal(fr, sp, keys, o) {
    return Object.assign({ fr, sp, keys, born: performance.now(), state: "live", face: 1, rot: 0, alpha: 1,
      shootFrom: 0, shootUntil: keys.length ? keys[keys.length - 1].t : 0, anchor: null, depth: 0.5, hN: 0.1, dist: 10, flyer: false, perch: false }, o);
  }
  function posAt(a, t) {
    const K = a.keys;
    if (t <= K[0].t) return { x: K[0].x, y: K[0].y, moving: false, dx: 0, dy: 0 };
    for (let i = 1; i < K.length; i++) {
      const k0 = K[i - 1], k1 = K[i];
      if (t < k1.t) {
        const u = (t - k0.t) / (k1.t - k0.t), e = (ease[k1.e || "io"])(u);
        let x, y;
        if (k1.c) { const m = 1 - e; x = m * m * k0.x + 2 * m * e * k1.c[0] + e * e * k1.x; y = m * m * k0.y + 2 * m * e * k1.c[1] + e * e * k1.y; }
        else { x = lerp(k0.x, k1.x, e); y = lerp(k0.y, k1.y, e); }
        if (k1.hop) y -= Math.sin(Math.PI * u) * k1.hop * a.hN;
        if (k1.walk) y -= Math.abs(Math.sin(u * Math.PI * k1.walk)) * 0.025 * a.hN;
        return { x, y, moving: k1.x !== k0.x || k1.y !== k0.y, dx: k1.x - k0.x, dy: k1.y - k0.y, hopU: k1.hop ? u : -1 };
      }
    }
    const L = K[K.length - 1]; return { x: L.x, y: L.y, moving: false, dx: 0, dy: 0, done: true };
  }
  function occludersFor(a) {
    if (!a.fr || a.flyer) return []; // birds fly over the cover: always in view
    const ax0 = a.cur ? a.cur.x - a.wN : 0, ax1 = a.cur ? a.cur.x + a.wN : 1;
    return a.fr.covers.filter((l) => l !== (a.perch ? a.anchor : null) && l.depth > a.depth + 0.035 && l.box.x < ax1 && l.box.x + l.box.w > ax0);
  }
  // sample the animal's own outline at a pose and see how much of it is hidden by closer cover
  function visibleFraction(a, x, y) {
    const s = SPR[SPECIES[a.sp].spr]; if (!s) return 1;
    a.cur = { x, y }; const occ = occludersFor(a);
    let seen = 0, total = 0;
    const w = a.wN, h = a.hN;
    for (const poly of s.polys) for (let i = 0; i < poly.length; i += Math.max(1, Math.floor(poly.length / 14))) {
      const [u, v] = poly[i];
      const fx = a.face * (s.face || 1) >= 0 ? u : 1 - u;
      const nx = x + (fx - 0.5) * w, ny = y - (1 - v) * h;
      // pull samples slightly inward so we test the body, not the outline
      const ix = lerp(nx, x, 0.25), iy = lerp(ny, y - h / 2, 0.25);
      if (ix < 0 || ix > 1 || iy < 0 || iy > 1) continue;
      total++;
      if (!occ.some((l) => inPoly(ix, iy, l.poly))) seen++;
    }
    return total ? seen / total : 0;
  }

  // ---- behaviours
  function sideToward(fr, cx) {
    if (S.source === "camera" && S.gyro) { const c = cover(); const [sx] = toScreen(fr, cx, 0.5, c); return sx < S.W / 2 ? 1 : -1; }
    return cx < 0.5 ? 1 : -1;
  }
  function groundPeek(fr, sp, l) {
    const cx = l.box.x + l.box.w / 2, base = polyBottom(l) - 0.006;
    const { hN, d } = animalSizeN(fr, sp, cx, base);
    const a = mkAnimal(fr, sp, [], { anchor: l, hN, dist: d, depth: l.depth - 0.07 });
    a.wN = wNorm(fr, sp, hN);
    const side = sideToward(fr, cx);
    const edge = side > 0 ? l.box.x + l.box.w : l.box.x;
    const out = clamp(edge + side * a.wN * 0.75, a.wN / 2, 1 - a.wN / 2);
    const start = clamp(edge - side * a.wN * 0.55, 0, 1);
    const win = SPECIES[sp].win * S.brief.winMul;
    let K;
    if (sp === "rabbit") {
      const mid = lerp(start, out, 0.5);
      K = [{ t: 0, x: start, y: base }, { t: 0.42, x: mid, y: base, hop: 0.22, e: "lin" }, { t: 0.84, x: out, y: base, hop: 0.2, e: "lin" }, { t: 0.84 + win, x: out, y: base }];
    } else if (sp === "squirrel") {
      const out2 = clamp(out + side * a.wN * 0.5, a.wN / 2, 1 - a.wN / 2);
      K = [{ t: 0, x: start, y: base }, { t: 0.38, x: out, y: base, e: "o" }, { t: 1.1, x: out, y: base }, { t: 1.35, x: out2, y: base, e: "io" }, { t: 1.35 + win - 0.5, x: out2, y: base }];
    } else { // buck
      const walk = Math.abs(out - start) / (a.wN * 0.9);
      K = [{ t: 0, x: start, y: base }, { t: 1.7, x: out, y: base, e: "o", walk: Math.max(2, Math.round(walk * 2)) }, { t: 1.7 + win, x: out, y: base }];
    }
    a.keys = K; a.face = side; a.shootFrom = 0.25; a.shootUntil = K[K.length - 1].t; a.home = start; a.side = side;
    a.check = { x: out, y: base };
    return a;
  }
  function perch(fr, sp, l) {
    const cx = clamp(l.box.x + l.box.w * rand(0.3, 0.7), 0.05, 0.95);
    const top = polyTopNear(l, cx, 0.12) + 0.004;
    const base = polyBottom(l);
    const d = distAt(fr, cx, base);
    const { hN } = animalSizeN(fr, sp, cx, base, d);
    const a = mkAnimal(fr, sp, [], { anchor: l, hN, dist: d, depth: l.depth + 0.02, perch: true });
    a.wN = wNorm(fr, sp, hN);
    const side = sideToward(fr, cx);
    const win = SPECIES[sp].win * S.brief.winMul;
    let K;
    if (sp === "sparrow") {
      const sx = side > 0 ? -0.12 : 1.12, sy = Math.max(0.02, top - 0.32);
      K = [{ t: 0, x: sx, y: sy }, { t: 0.95, x: cx, y: top, e: "o", c: [lerp(sx, cx, 0.6), sy - 0.06] },
        { t: 1.6, x: cx, y: top }, { t: 1.85, x: cx + side * a.wN * 0.25, y: top, hop: 0.35, e: "lin" },
        { t: 1.85 + win - 0.6, x: cx + side * a.wN * 0.25, y: top }];
      a.flying = true;
    } else { // squirrel climbs up onto a rock/bench/stump
      const sx = clamp(cx - side * (l.box.w / 2 + a.wN * 0.4), 0, 1);
      K = [{ t: 0, x: sx, y: base }, { t: 0.45, x: lerp(sx, cx, 0.6), y: top, hop: 0.5, e: "o" }, { t: 0.7, x: cx, y: top, e: "o" }, { t: 0.7 + win, x: cx, y: top }];
    }
    a.keys = K; a.face = side; a.shootFrom = sp === "sparrow" ? 0.3 : 0.2; a.shootUntil = K[K.length - 1].t; a.side = side;
    a.check = { x: cx, y: top };
    return a;
  }
  function openGround(fr, sp) {
    const y = rand(0.74, 0.93), side = Math.random() < 0.5 ? 1 : -1;
    const c = cover(), v0 = fromScreen(fr, 0, 0, c)[0], v1 = fromScreen(fr, S.W, 0, c)[0];
    const { hN, d } = animalSizeN(fr, sp, 0.5, y);
    const a = mkAnimal(fr, sp, [], { hN, dist: d, depth: depthAt(fr, 0.5, y) });
    a.wN = wNorm(fr, sp, hN);
    const x0 = side > 0 ? v0 - a.wN : v1 + a.wN, x1 = side > 0 ? v1 + a.wN : v0 - a.wN;
    const dur = (sp === "buck" ? 3.6 : 3.2) * clamp((v1 - v0) * 1.1, 0.6, 1), hops = sp === "buck" ? 4 : 7;
    const K = [{ t: 0, x: x0, y }];
    for (let i = 1; i <= hops; i++) K.push({ t: (dur * i) / hops, x: lerp(x0, x1, i / hops), y, hop: sp === "buck" ? 0.18 : 0.22, e: "lin" });
    a.keys = K; a.face = side; a.side = side; a.shootFrom = 0; a.shootUntil = dur; a.check = { x: 0.5, y };
    return a;
  }
  function flyover(fr, sp, delay = 0, laneY) {
    const skyY = clamp(laneY ?? rand(0.14, 0.34) - S.brief.skyLift, 0.1, 0.45);
    const side = Math.random() < 0.5 ? 1 : -1;
    const d = rand(7, 12);
    const { hN } = animalSizeN(fr, sp, 0.5, skyY, d);
    const a = mkAnimal(fr, sp, [], { hN, dist: d, depth: 1.5, flyer: true });
    a.wN = wNorm(fr, sp, hN);
    // fly across what's actually on screen (portrait phones crop a lot of the frame)
    const c = cover(), v0 = fromScreen(fr, 0, 0, c)[0], v1 = fromScreen(fr, S.W, 0, c)[0];
    const x0 = side > 0 ? v0 - a.wN * 0.6 : v1 + a.wN * 0.6, x1 = side > 0 ? v1 + a.wN * 0.6 : v0 - a.wN * 0.6;
    const dur = rand(5.2, 6.6) * clamp((v1 - v0) * 1.2, 0.6, 1);
    a.keys = [{ t: 0, x: x0, y: skyY + rand(0.02, 0.06) }, { t: dur, x: x1, y: skyY + rand(-0.04, 0.03), e: "lin", c: [0.5, skyY - rand(0.03, 0.08)] }];
    a.face = side; a.side = side; a.shootFrom = 0.2; a.shootUntil = dur - 0.2; a.born += delay * 1000; a.check = { x: 0.5, y: skyY };
    return a;
  }
  function ghostOnTrunk(fr, l) {
    const side = sideToward(fr, l.box.x + l.box.w / 2);
    const y = l.box.y + l.box.h * rand(0.45, 0.65);
    const edge = side > 0 ? l.box.x + l.box.w : l.box.x;
    const base = polyBottom(l);
    const d = distAt(fr, l.box.x + l.box.w / 2, base);
    const { hN } = animalSizeN(fr, "ghost", 0.5, base, d);
    const a = mkAnimal(fr, "ghost", [], { anchor: l, hN, dist: d, depth: l.depth - 0.06 });
    a.wN = wNorm(fr, "ghost", hN);
    const x0 = edge - side * a.wN * 0.9, x1 = edge + side * a.wN * 0.15, yb = y + hN / 2;
    const win = SPECIES.ghost.win;
    a.keys = [{ t: 0, x: x0, y: yb }, { t: 0.45, x: x1, y: yb, e: "o" }, { t: 0.45 + win, x: x1, y: yb }];
    a.face = side; a.side = side; a.shootFrom = 0.2; a.shootUntil = 0.45 + win; a.home = x0; a.check = { x: x1, y: yb };
    return a;
  }
  // escape / flee paths appended from the current pose
  function retreat(a, now, spooked) {
    const t = (now - a.born) / 1000, p = posAt(a, t), sp = a.sp;
    const sx = spooked ? 1.6 : 1;
    let K;
    if (a.flyer) { a.state = spooked ? "flee" : "leave"; return; }
    if (a.flying || sp === "sparrow") {
      const ox = p.x + a.side * 0.5, oy = Math.max(-0.2, p.y - 0.45);
      K = [{ t, x: p.x, y: p.y }, { t: t + 0.8 / sx, x: ox, y: oy, e: "i", c: [p.x + a.side * 0.1, p.y - 0.25] }];
      a.flying = true;
    } else if (sp === "buck" || (spooked && sp !== "ghost")) {
      const dir = a.home != null && !spooked ? Math.sign(a.home - p.x) || -a.side : a.side;
      const x1 = dir > 0 ? 1 + a.wN * 1.2 : -a.wN * 1.2, n = 4;
      K = [{ t, x: p.x, y: p.y }];
      for (let i = 1; i <= n; i++) K.push({ t: t + (i * 0.34) / sx, x: lerp(p.x, x1, i / n), y: p.y, hop: sp === "buck" ? 0.32 : 0.28, e: "lin" });
      a.face = dir;
    } else {
      const hx = a.home ?? p.x;
      K = sp === "rabbit"
        ? [{ t, x: p.x, y: p.y }, { t: t + 0.36, x: lerp(p.x, hx, 0.55), y: p.y, hop: 0.2, e: "lin" }, { t: t + 0.72, x: hx, y: p.y, hop: 0.18, e: "lin" }]
        : [{ t, x: p.x, y: p.y }, { t: t + 0.35, x: hx, y: p.y, e: "io" }];
      a.face = Math.sign(hx - p.x) || a.face;
    }
    a.keys = K; a.state = spooked ? "flee" : "leave";
  }

  // ---------------- Hunt: director (cadence) ----------------
  function startHunt() {
    stopTour();
    S.phase = "hunt";
    ui.analysis.classList.remove("show");
    ui.hud.style.display = "flex"; ui.toolbar.style.display = "flex"; ui.reticle.style.display = "block";
    Object.assign(S, { score: 0, streak: 0, bestStreak: 0, hits: 0, shots: 0, longest: 0, best: null, animals: [], tells: [], fx: [], vision: 0 });
    $("btnVision").textContent = "Vision: off"; $("btnVision").classList.remove("on");
    const now = performance.now();
    const on = (k) => S.brief.sp.find((s) => s.k === k && s.on);
    S.round = { t0: now, end: now + ROUND_SECONDS * 1000, next: now + 2600,
      flyovers: on("tern") ? [rand(18, 24), rand(44, 52), rand(62, 68)] : [],
      ghostAt: on("ghost") ? rand(28, 58) : null };
    renderHud(); toast("Hunt is on", "#e9a23b", 900);
    ambience(true);
  }
  function director(now) {
    const R = S.round, t = (now - R.t0) / 1000;
    const prog = clamp(t / ROUND_SECONDS, 0, 1);
    // scheduled fly-overs
    while (R.flyovers.length && t >= R.flyovers[0]) {
      R.flyovers.shift();
      const fr = currentFrame();
      const n = Math.random() < 0.5 ? 2 : 3, lane = rand(0.16, 0.32);
      tell({ fr, kind: "call", x: 0.5, y: lane, dur: 1.0, then: () => {
        for (let i = 0; i < n; i++) S.animals.push(flyover(fr, i % 2 ? "whimbrel" : "tern", i * rand(0.9, 1.4), lane + rand(-0.07, 0.07)));
      } });
    }
    if (R.ghostAt != null && t >= R.ghostAt && !busyGround()) {
      R.ghostAt = null;
      const choices = allCovers().filter(({ l }) => l.kind === "trunk" && l.box.h > 0.22);
      if (choices.length) {
        const { f, l } = pick(choices);
        const a = ghostOnTrunk(f, l);
        tell({ fr: f, kind: "rustle", anchor: l, x: l.box.x + l.box.w / 2, y: l.box.y + l.box.h * 0.5, dur: 0.9, then: () => { a.born = performance.now(); S.animals.push(a); toast("✨ Ghost squirrel ✨", "#e8f0ff", 1000); } });
      }
    }
    if (now >= R.next && !busyGround()) {
      const a = planEncounter();
      R.next = now + 99999;
      if (a) {
        const cue = a.sp === "sparrow" ? "chirp" : "rustle";
        tell({ fr: a.fr, kind: cue, anchor: cue === "rustle" ? a.anchor : null, x: a.check.x, y: a.check.y, dur: rand(0.8, 1.3), then: () => { a.born = performance.now(); S.animals.push(a); } });
      } else R.next = now + 800;
    }
    // after everything resolves, schedule the next encounter with a shrinking gap
    if (R.next > now + 50000 && !busyGround()) R.next = now + 1000 * (lerp(2.8, 1.5, prog) + rand(-0.5, 0.7));
    if (now >= R.end) endRound();
  }
  const busyGround = () => S.animals.some((a) => !a.flyer && a.state !== "gone") || S.tells.some((x) => x.kind !== "call");
  function allCovers() { return S.frames.flatMap((f) => f.covers.map((l) => ({ f, l }))); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function currentFrame() {
    if (!S.gyro || S.source !== "camera" || !S.sm) return S.primary;
    let best = S.frames[0], bd = 1e9;
    for (const f of S.frames) { const d = f.orient ? Math.abs(angDiff(S.sm.a, f.orient.a)) : 0; if (d < bd) { bd = d; best = f; } }
    return best;
  }
  function nearPerson(f, l) { return f.dets.some((d) => d.cls === "person" && d.box.x < l.box.x + l.box.w + 0.05 && d.box.x + d.box.w > l.box.x - 0.05); }
  function onScreenish(f, l) {
    const c = cover(); const [x] = toScreen(f, l.box.x + l.box.w / 2, 0.5, c);
    return x > S.W * 0.05 && x < S.W * 0.95;
  }
  function planEncounter() {
    const enabled = S.brief.sp.filter((s) => s.on && ["rabbit", "squirrel", "sparrow", "buck"].includes(s.k)).map((s) => s.k);
    const weights = { rabbit: 38, squirrel: 28, sparrow: 26, buck: 16 };
    for (let attempt = 0; attempt < 10; attempt++) {
      let r = Math.random() * enabled.reduce((s, k) => s + weights[k], 0), sp = enabled[0];
      for (const k of enabled) { if ((r -= weights[k]) <= 0) { sp = k; break; } }
      let cands = allCovers().filter(({ f, l }) => !nearPerson(f, l) && polyBottom(l) > 0.35 && l.box.h > 0.03);
      if (attempt < 6) { const vis = cands.filter(({ f, l }) => onScreenish(f, l)); if (vis.length) cands = vis; }
      let a = null;
      if (sp === "sparrow") {
        const c = cands.filter(({ l }) => ["fence", "bench", "rock", "stump", "log", "bush"].includes(l.kind));
        if (c.length) { const { f, l } = pick(c); a = perch(f, sp, l); }
      } else if (sp === "squirrel") {
        const c = cands.filter(({ l }) => ["trunk", "rock", "stump", "log", "bench"].includes(l.kind));
        if (c.length) { const { f, l } = pick(c); a = ["rock", "stump", "log", "bench"].includes(l.kind) && Math.random() < 0.45 ? perch(f, sp, l) : groundPeek(f, sp, l); }
      } else if (sp === "buck") {
        const c = cands.filter(({ l }) => ["trunk", "bush", "fence"].includes(l.kind) && l.m && l.m.d >= 6);
        a = c.length ? (() => { const { f, l } = pick(c); return groundPeek(f, sp, l); })() : openGround(currentFrame(), sp);
      } else {
        const c = cands.filter(({ l }) => ["bush", "trunk", "bench", "fence", "rock", "stump", "log"].includes(l.kind));
        a = c.length && Math.random() < 0.85 ? (() => { const { f, l } = pick(c); return groundPeek(f, sp, l); })() : openGround(currentFrame(), sp);
      }
      if (!a) continue;
      if (visibleFraction(a, a.check.x, a.check.y) >= 0.55) return a;
    }
    return openGround(currentFrame(), "rabbit");
  }
  function tell(o) { o.t0 = performance.now(); S.tells.push(o); sfx(o.kind, panFor(o.fr, o.x, o.y)); }
  function panFor(fr, x, y) { const c = cover(); const [sx] = toScreen(fr || S.primary, x, y, c); return clamp((sx / S.W) * 2 - 1, -1, 1); }

  function updateHunt(now) {
    director(now);
    // tells → spawn
    S.tells = S.tells.filter((tl) => { if (now - tl.t0 >= tl.dur * 1000) { tl.then(); return false; } return true; });
    for (const a of S.animals) {
      const t = (now - a.born) / 1000;
      if (t < 0) continue;
      if (a.state === "live" && t > a.shootUntil) { retreat(a, now, false); if (!a.flyer) { breakStreak("It slipped away", "#aea592"); } }
      if (a.state === "hit") { if (now - a.hitAt > 1100) a.state = "gone"; continue; }
      const p = posAt(a, t); a.cur = p;
      if (p.dx) a.face = Math.sign(p.dx);
      if ((a.state === "leave" || a.state === "flee") && p.done) a.state = "gone";
      if (a.flyer && p.done) a.state = "gone";
      if (a.flyer && (a.state === "flee" || a.state === "leave")) { // climb away
        a.keys = [{ t, x: p.x, y: p.y }, { t: t + 1.1, x: p.x + a.face * 0.35, y: p.y - 0.4, e: "i" }]; a.state = "leaving2";
      }
      if (a.state === "leaving2" && p.done) a.state = "gone";
    }
    const before = S.animals.length;
    S.animals = S.animals.filter((a) => a.state !== "gone");
    if (S.animals.length !== before && S.round && !busyGround() && S.round.next > now + 50000) S.round.next = now + 1000 * rand(1.3, 2.6);
    maybeRescan(now);
  }

  // ---------------- Shooting ----------------
  function shoot(x, y) {
    const now = performance.now();
    if (S.phase !== "hunt" || now - S.lastShot < SHOT_COOLDOWN_MS) return;
    S.lastShot = now;
    sfx("shot", clamp((x / S.W) * 2 - 1, -1, 1)); S.fx.push({ type: "flash", t: now });
    if (navigator.vibrate) navigator.vibrate(25);
    ui.reticle.classList.add("cool"); setTimeout(() => ui.reticle.classList.remove("cool"), SHOT_COOLDOWN_MS);
    const c = cover();
    const live = S.animals.filter((a) => a.state === "live" && (now - a.born) / 1000 >= a.shootFrom && a.cur);
    if (!live.length) return;
    let target = null, blocker = null;
    for (const a of live) {
      if (hitTest(a, x, y, c)) {
        const [nx, ny] = fromScreen(a.fr, x, y, c);
        const b = occludersFor(a).find((l) => inPoly(nx, ny, l.poly));
        if (!b) { target = a; blocker = null; break; }
        if (!target) { target = a; blocker = b; }
      }
    }
    if (!target) { // missed everything: the nearest visible animal hears it and bolts
      target = live.map((a) => ({ a, d: Math.hypot(...screenOf(a, c).map((v, i) => v - [x, y][i])) })).sort((p, q) => p.d - q.d)[0].a;
    }
    S.shots++;
    if (target && hitTest(target, x, y, c) && !blocker) {
      const spec = SPECIES[target.sp];
      S.hits++; S.streak++; S.bestStreak = Math.max(S.bestStreak, S.streak);
      const mult = S.streak >= 5 ? 3 : S.streak >= 3 ? 2 : S.streak >= 2 ? 1.5 : 1;
      const longShot = 1 + clamp((target.dist - 5) / 12, 0, 1.5);
      const pts = Math.round(spec.pts * mult * longShot);
      S.score += pts; S.longest = Math.max(S.longest, target.dist);
      target.state = "hit"; target.hitAt = now; target.hitPose = target.cur;
      sfx("hit", 0);
      S.fx.push({ type: "pop", x, y, t: now, text: `+${pts}`, sub: `${spec.name} · ${fmtM(target.dist)}${mult > 1 ? ` · x${mult}` : ""}${longShot > 1.15 ? " · long shot" : ""}` });
      captureKillCam(target, x, y, pts, mult, longShot);
    } else {
      retreat(target, now, true);
      S.fx.push({ type: "miss", x, y, t: now });
      breakStreak(blocker ? `Blocked by the ${KIND_LABEL[blocker.kind]}` : "Missed — it bolted", "#e0483c");
    }
    renderHud();
  }
  function screenOf(a, c) { return toScreen(a.fr, a.cur.x, a.cur.y - a.hN / 2, c); }
  function hitTest(a, x, y, c) {
    const s = SPR[SPECIES[a.sp].spr]; if (!s || !a.cur) return false;
    const h = a.hN * c.sh, w = h * s.asp;
    const [fx, fy] = toScreen(a.fr, a.cur.x, a.cur.y, c);
    let u = (x - (fx - w / 2)) / w, v = (y - (fy - h)) / h;
    if (u < -0.08 || u > 1.08 || v < -0.08 || v > 1.08) return false;
    if (flipFor(a, s)) u = 1 - u;
    if (a.flyer) { const du = (u - 0.5) / 0.55, dv = (v - 0.5) / 0.6; if (du * du + dv * dv <= 1) return true; }
    const pad = a.flyer ? 0.12 : 0.06;
    for (const poly of s.polys) {
      if (inPoly(u, v, poly)) return true;
      for (const [du, dv] of [[pad, 0], [-pad, 0], [0, pad], [0, -pad]]) if (inPoly(u + du, v + dv, poly)) return true;
    }
    return false;
  }
  const flipFor = (a, s) => s.face && Math.sign(s.face) !== Math.sign(a.face || 1);

  // ---------------- Kill cam (annotated with what Roboflow saw) ----------------
  function captureKillCam(a, x, y, pts, mult, longShot) {
    if (S.best && S.best.pts >= pts) return;
    renderHunt(performance.now(), true);
    const out = document.createElement("canvas");
    const k = Math.min(1, 1080 / Math.max(S.W, S.H));
    out.width = Math.round(S.W * k * S.dpr); out.height = Math.round(S.H * k * S.dpr);
    const o = out.getContext("2d");
    o.drawImage(canvas, 0, 0, out.width, out.height);
    o.setTransform(k * S.dpr, 0, 0, k * S.dpr, 0, 0);
    const v = o.createRadialGradient(x, y, 40, x, y, Math.max(S.W, S.H) * 0.8);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.55)"); o.fillStyle = v; o.fillRect(0, 0, S.W, S.H);
    const c = cover(), h = a.hN * c.sh, s = SPR[SPECIES[a.sp].spr], w = h * (s ? s.asp : 1);
    const [fx, fy] = toScreen(a.fr, a.cur.x, a.cur.y, c);
    o.strokeStyle = "#3fe0a8"; o.lineWidth = 2; o.strokeRect(fx - w / 2 - 6, fy - h - 6, w + 12, h + 12);
    o.font = "800 13px system-ui, sans-serif"; o.textAlign = "left";
    const label = `${SPECIES[a.sp].name.toUpperCase()} · ${fmtM(a.dist)}`;
    const lw = o.measureText(label).width + 12;
    o.fillStyle = "#3fe0a8"; o.fillRect(fx - w / 2 - 6, fy - h - 28, lw, 20); o.fillStyle = "#06251b"; o.fillText(label, fx - w / 2, fy - h - 13);
    if (a.anchor) {
      const ax = fx, ay = clamp(fy + 16, 60, S.H - 30);
      o.font = "700 11px system-ui, sans-serif"; o.fillStyle = "rgba(10,10,10,.75)";
      const t2 = `${a.perch ? "on" : "behind"} ${KIND_LABEL[a.anchor.kind]} · SAM 3 ${a.anchor.conf.toFixed(2)}`;
      const w2 = o.measureText(t2).width + 12; o.fillRect(clamp(ax - w2 / 2, 4, S.W - w2 - 4), ay - 10, w2, 20);
      o.fillStyle = KIND_COLOR[a.anchor.kind]; o.fillText(t2, clamp(ax - w2 / 2, 4, S.W - w2 - 4) + 6, ay + 4);
    }
    o.strokeStyle = "#fff"; o.lineWidth = 2.2; o.shadowColor = "#000"; o.shadowBlur = 4;
    o.beginPath(); o.arc(x, y, 18, 0, Math.PI * 2);
    o.moveTo(x - 32, y); o.lineTo(x - 9, y); o.moveTo(x + 9, y); o.lineTo(x + 32, y); o.moveTo(x, y - 32); o.lineTo(x, y - 9); o.moveTo(x, y + 9); o.lineTo(x, y + 32); o.stroke();
    o.shadowBlur = 0;
    const fs = Math.round(Math.min(S.W, S.H) * 0.12);
    o.font = `900 ${fs}px system-ui, sans-serif`; o.textAlign = "center"; o.lineWidth = 6; o.strokeStyle = "rgba(0,0,0,.7)"; o.fillStyle = "#e9a23b";
    o.strokeText("TAGGED", S.W / 2, S.H * 0.18); o.fillText("TAGGED", S.W / 2, S.H * 0.18);
    o.font = `800 ${Math.round(fs * 0.26)}px system-ui, sans-serif`; o.fillStyle = "#f3ece0";
    const line = `+${pts}${mult > 1 ? ` · x${mult} streak` : ""}${longShot > 1.15 ? ` · long shot ${fmtM(a.dist)}` : ""}`;
    o.strokeText(line, S.W / 2, S.H * 0.18 + fs * 0.45); o.fillText(line, S.W / 2, S.H * 0.18 + fs * 0.45);
    o.font = "700 11px system-ui, sans-serif"; o.fillStyle = "rgba(243,236,224,.9)"; o.textAlign = "right";
    o.fillText("ONE SHOT · scene by Roboflow — SAM 3 · Depth Anything v3 · RF-DETR", S.W - 12, S.H - 14);
    S.best = { pts, url: out.toDataURL("image/jpeg", 0.88) };
  }

  // ---------------- Rendering (hunt) ----------------
  function drawAnimal(a, c, now) {
    const s = SPR[SPECIES[a.sp].spr]; if (!s || !a.cur) return;
    const t = (now - a.born) / 1000; if (t < 0) return;
    let { x, y } = a.cur;
    let rot = 0, alpha = 1, sy = 1;
    if (a.state === "hit") {
      const u = clamp((now - a.hitAt) / 700, 0, 1);
      if (a.flyer || a.flying) { y = a.hitPose.y + u * u * 0.5; rot = u * 2.2 * (a.face || 1); }
      else { rot = -u * 1.25 * (a.face || 1); y = a.hitPose.y; }
      alpha = 1 - clamp((now - a.hitAt - 650) / 450, 0, 1);
      x = a.hitPose.x;
    } else if (!a.cur.moving) {
      sy = 1 + Math.sin(now / 420 + a.born) * 0.012; // breathing
    }
    if (a.cur.hopU >= 0 && a.cur.hopU < 0.12) sy *= 0.94; // land squash
    if (a.flyer && a.state !== "hit") rot = Math.atan2(a.cur.dy * c.sh, Math.abs(a.cur.dx * c.sw) + 1e-6) * 0.25 * (a.face || 1);
    const h = a.hN * c.sh, w = h * s.asp;
    const [fx, fy] = toScreen(a.fr, x, y, c);
    // ground shadow for walkers
    if (!a.flyer && !(a.flying && a.cur.moving) && a.state !== "hit") {
      ctx.save(); ctx.globalAlpha = 0.28 * alpha; ctx.fillStyle = "#000";
      ctx.beginPath(); ctx.ellipse(fx, fy, w * 0.42, Math.max(2, h * 0.05), 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(fx, fy); ctx.rotate(rot);
    ctx.scale(flipFor(a, s) ? -1 : 1, sy);
    // match the scene's light a little; soften far animals
    const far = a.dist > 16 ? 0.6 : 0;
    try { ctx.filter = `brightness(${S.light.toFixed(2)}) saturate(0.9)${far ? ` blur(${far}px)` : ""}`; } catch (_) {}
    ctx.drawImage(s.canvas, -w / 2, -h, w, h);
    ctx.filter = "none";
    ctx.restore();
  }
  function renderHunt(now, forCapture = false) {
    const c = cover();
    ctx.clearRect(0, 0, S.W, S.H);
    drawSource(c);
    // tells: real cover rustles before something comes out
    for (const tl of S.tells) {
      if (tl.kind !== "rustle" || !tl.anchor) continue;
      const u = (now - tl.t0) / 1000, amp = 2.2 * Math.sin(Math.PI * clamp(u / tl.dur, 0, 1));
      const ox = Math.sin(u * 47) * amp, oy = Math.cos(u * 31) * amp * 0.4;
      const p = screenPath(tl.fr, tl.anchor.poly, c);
      ctx.save(); ctx.clip(p); ctx.translate(ox, oy); drawSource(c); ctx.restore();
    }
    // animals far → near, each re-covered by closer real cover
    const order = S.animals.slice().sort((p, q) => p.depth - q.depth);
    for (const a of order) {
      drawAnimal(a, c, now);
      if (a.state === "hit" || !a.cur) continue;
      for (const l of occludersFor(a)) { ctx.save(); ctx.clip(screenPath(a.fr, l.poly, c)); drawSource(c); ctx.restore(); }
    }
    if (forCapture) return;
    // vision overlay
    if (S.vision === 1) for (const f of S.frames) drawSegments(f, c, 99, false);
    if (S.vision === 2) for (const f of S.frames) if (f.depthImg) {
      const [px, py] = pan(f, c); ctx.save(); ctx.globalAlpha = 0.45; ctx.drawImage(f.depthImg, c.dx + px, c.dy + py, c.sw, c.sh); ctx.restore();
    }
    // off-screen cues
    for (const a of S.animals) {
      if (a.state !== "live" || !a.cur) continue;
      const [sx, sy] = toScreen(a.fr, a.cur.x, a.cur.y - a.hN / 2, c);
      if (sx > -10 && sx < S.W + 10 && sy > -10 && sy < S.H + 10) continue;
      const ex = clamp(sx, 26, S.W - 26), ey = clamp(sy, 70, S.H - 70), ang = Math.atan2(sy - ey, sx - ex);
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang); ctx.fillStyle = "rgba(233,162,59,.9)";
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    // effects
    S.fx = S.fx.filter((f) => now - f.t < 1100);
    for (const f of S.fx) {
      const u = (now - f.t) / 1100;
      if (f.type === "flash" && u < 0.08) { ctx.fillStyle = `rgba(255,240,215,${0.3 * (1 - u / 0.08)})`; ctx.fillRect(0, 0, S.W, S.H); }
      else if (f.type === "pop") {
        ctx.save(); ctx.globalAlpha = 1 - u * u; ctx.textAlign = "center";
        ctx.font = "900 26px system-ui, sans-serif"; ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.fillStyle = "#e9a23b";
        const yy = f.y - 34 - u * 40; ctx.strokeText(f.text, f.x, yy); ctx.fillText(f.text, f.x, yy);
        ctx.font = "700 12px system-ui, sans-serif"; ctx.fillStyle = "#f3ece0"; ctx.strokeText(f.sub, f.x, yy + 18); ctx.fillText(f.sub, f.x, yy + 18);
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(f.x, f.y, 10 + u * 34, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      } else if (f.type === "miss") {
        ctx.save(); ctx.globalAlpha = 1 - u; ctx.strokeStyle = "#e0483c"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(f.x - 8, f.y - 8); ctx.lineTo(f.x + 8, f.y + 8); ctx.moveTo(f.x + 8, f.y - 8); ctx.lineTo(f.x - 8, f.y + 8); ctx.stroke(); ctx.restore();
      }
    }
    if (S.scanning) { ctx.fillStyle = "rgba(138,92,246,.85)"; ctx.beginPath(); ctx.arc(S.W - 18, 82, 4 + Math.sin(now / 120) * 1.5, 0, Math.PI * 2); ctx.fill(); }
  }
  function renderScan(now) {
    const c = cover();
    ctx.clearRect(0, 0, S.W, S.H);
    drawSource(c);
    // show finished frames' outlines live over the camera
    for (const f of S.frames) if (f.scene) drawSegments(f, c, 99, false);
    const y = ((now / 1400) % 1) * S.H;
    const g = ctx.createLinearGradient(0, y - 80, 0, y);
    g.addColorStop(0, "rgba(138,92,246,0)"); g.addColorStop(1, "rgba(138,92,246,.5)");
    ctx.fillStyle = g; ctx.fillRect(0, y - 80, S.W, 80);
  }
  // rough scene brightness so cut-out animals sit in the light of the place
  function sampleLight() {
    const el = S.source === "camera" ? video : S.img; if (!el) return;
    const cv = sampleLight.cv || (sampleLight.cv = document.createElement("canvas")); cv.width = 16; cv.height = 16;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(el, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data; let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const lum = s / (d.length / 4) / 255;
    S.light = clamp(0.62 + lum * 0.75, 0.7, 1.12);
  }
  S.light = 1;

  // ---------------- Rescan during the hunt (keeps cover aligned) ----------------
  function maybeRescan(now) {
    if (S.source !== "camera" || S.scanning || now - S.lastRescan < 11000) return;
    if (S.animals.length || S.tells.length) return;
    S.lastRescan = now; S.scanning = true;
    const fr = grabFrame();
    analyzeFrame(fr).then(() => {
      if (S.animals.length || S.tells.length) return; // don't swap cover under a live animal
      let idx = 0, bd = 1e9;
      S.frames.forEach((f, i) => { const d = f.orient && fr.orient ? Math.abs(angDiff(f.orient.a, fr.orient.a)) : 0; if (d < bd) { bd = d; idx = i; } });
      if (bd < 25 || !S.gyro || S.frames.length >= 4) S.frames[idx] = fr; else S.frames.push(fr);
      if (S.primary && !S.frames.includes(S.primary)) S.primary = fr;
    }).catch(() => {}).finally(() => { S.scanning = false; });
  }

  // ---------------- HUD / UI ----------------
  function renderHud() {
    ui.score.textContent = S.score;
    const mult = S.streak >= 5 ? 3 : S.streak >= 3 ? 2 : S.streak >= 2 ? 1.5 : 1;
    ui.streak.textContent = S.streak >= 2 ? `streak ${S.streak} · x${mult}` : "";
    ui.ammo.textContent = `${S.hits}/${S.shots} tagged`;
  }
  function breakStreak(msg, color) { if (S.streak >= 2) msg += ` · streak lost`; S.streak = 0; toast(msg, color, 900); sfx("whoosh", 0); renderHud(); }
  let toastTimer = 0, statusTimer = 0;
  function toast(text, color = "#f3ece0", ms = 900) {
    ui.toast.textContent = text; ui.toast.style.color = color; ui.toast.style.opacity = 1;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (ui.toast.style.opacity = 0), ms);
  }
  function status(text, ms) {
    ui.status.textContent = text; ui.status.style.display = "block";
    clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => (ui.status.style.display = "none"), ms);
  }
  function hideGameUI() { ui.hud.style.display = "none"; ui.toolbar.style.display = "none"; ui.reticle.style.display = "none"; ui.status.style.display = "none"; ui.analysis.classList.remove("show"); }
  function show(id) { for (const s of document.querySelectorAll(".screen")) s.classList.toggle("show", s.id === id); }

  // ---------------- Audio ----------------
  let ac = null, amb = null;
  function audioInit() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch (_) {} }
  function out(panv) {
    const g = ac.createGain();
    if (ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = panv || 0; g.connect(p).connect(ac.destination); }
    else g.connect(ac.destination);
    return g;
  }
  function noise(len) { const b = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const s = ac.createBufferSource(); s.buffer = b; return s; }
  function sfx(kind, panv = 0) {
    if (!ac) return;
    const t = ac.currentTime;
    if (kind === "shot") {
      const n = noise(0.45), f = ac.createBiquadFilter(), g = out(panv);
      f.type = "lowpass"; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(240, t + 0.4);
      g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      n.connect(f).connect(g); n.start(t);
    } else if (kind === "rustle") {
      const n = noise(1.0), f = ac.createBiquadFilter(), g = out(panv);
      f.type = "bandpass"; f.frequency.value = 2600; f.Q.value = 0.8;
      g.gain.setValueAtTime(0.0001, t);
      for (let i = 0; i < 6; i++) { g.gain.linearRampToValueAtTime(0.18 * Math.random() + 0.05, t + 0.08 + i * 0.13); g.gain.linearRampToValueAtTime(0.02, t + 0.14 + i * 0.13); }
      g.gain.linearRampToValueAtTime(0.0001, t + 0.95);
      n.connect(f).connect(g); n.start(t);
    } else if (kind === "chirp" || kind === "call") {
      const reps = kind === "chirp" ? 3 : 2;
      for (let i = 0; i < reps; i++) {
        const o = ac.createOscillator(), g = out(panv), t1 = t + i * (kind === "chirp" ? 0.14 : 0.32);
        o.type = kind === "chirp" ? "sine" : "triangle";
        o.frequency.setValueAtTime(kind === "chirp" ? 3600 : 1900, t1); o.frequency.exponentialRampToValueAtTime(kind === "chirp" ? 5200 : 1100, t1 + (kind === "chirp" ? 0.07 : 0.22));
        g.gain.setValueAtTime(0.0001, t1); g.gain.exponentialRampToValueAtTime(kind === "chirp" ? 0.08 : 0.06, t1 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t1 + (kind === "chirp" ? 0.1 : 0.26));
        o.connect(g); o.start(t1); o.stop(t1 + 0.3);
      }
    } else if (kind === "hit") {
      const o = ac.createOscillator(), g = out(panv);
      o.type = "triangle"; o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(1040, t + 0.12);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g); o.start(t); o.stop(t + 0.4);
    } else if (kind === "whoosh") {
      const n = noise(0.35), f = ac.createBiquadFilter(), g = out(panv);
      f.type = "bandpass"; f.frequency.setValueAtTime(800, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.33);
      n.connect(f).connect(g); n.start(t);
    }
  }
  function ambience(on) {
    if (!ac) return;
    if (amb) { try { amb.stop(); } catch (_) {} amb = null; }
    if (!on) return;
    const n = noise(4), f = ac.createBiquadFilter(), g = ac.createGain();
    n.loop = true; f.type = "lowpass"; f.frequency.value = 420; g.gain.value = 0.035;
    n.connect(f).connect(g).connect(ac.destination); n.start(); amb = n;
  }

  // ---------------- Loop ----------------
  let lightAt = 0;
  function loop(now) {
    smoothOrient();
    if (now - lightAt > 1500 && (S.phase === "hunt" || S.phase === "analysis")) { lightAt = now; sampleLight(); }
    if (S.phase === "scan") { scanTick(now); renderScan(now); }
    else if (S.phase === "analysis") renderAnalysis(now);
    else if (S.phase === "hunt") {
      updateHunt(now);
      const left = Math.max(0, (S.round.end - now) / 1000);
      ui.timer.textContent = Math.ceil(left); ui.timer.classList.toggle("low", left <= 10);
      if (S.phase === "hunt") renderHunt(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------------- Flow ----------------
  async function startCamera() {
    audioInit(); loadSprites();
    await enableMotion();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; await video.play();
      await new Promise((r) => (video.videoWidth ? r() : video.addEventListener("loadedmetadata", r, { once: true })));
      S.source = "camera"; S.img = null;
      setTimeout(beginScan, 250); // give sensors a moment to report
    } catch (e) { alert("Couldn't open the camera (" + (e.name || e) + "). Try a photo or a demo scene instead."); }
  }
  function startPhoto(src) {
    audioInit(); loadSprites();
    const img = new Image();
    img.onload = () => { stopCamera(); S.source = "photo"; S.img = img; beginScan(); };
    img.onerror = () => alert("Couldn't load that image.");
    img.src = src;
  }
  function stopCamera() { if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; } }
  function endRound() {
    S.phase = "over"; ambience(false);
    hideGameUI();
    $("finalScore").textContent = S.score;
    $("stHits").textContent = S.hits;
    $("stAcc").textContent = S.shots ? Math.round((S.hits / S.shots) * 100) + "%" : "–";
    $("stStreak").textContent = S.bestStreak;
    $("stLong").textContent = S.longest ? fmtM(S.longest) : "–";
    const kc = $("killcam");
    if (S.best) { kc.src = S.best.url; kc.style.display = "block"; $("btnShare").style.display = ""; }
    else { kc.style.display = "none"; $("btnShare").style.display = "none"; }
    show("over");
  }
  function goHome() { stopCamera(); ambience(false); S.phase = "home"; S.source = null; hideGameUI(); ui.scan.classList.remove("show"); ctx.clearRect(0, 0, S.W, S.H); show("home"); }
  async function shareKillCam() {
    if (!S.best) return;
    const blob = await (await fetch(S.best.url)).blob();
    const file = new File([blob], "one-shot-killcam.jpg", { type: "image/jpeg" });
    const text = `${S.score} points in ONE SHOT 🎯 — scene by Roboflow`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], text, title: "ONE SHOT" }); } catch (_) {} return; }
    const a = document.createElement("a"); a.href = S.best.url; a.download = "one-shot-killcam.jpg"; a.click();
  }

  // ---------------- Input ----------------
  canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { S.mouse = true; S.aim.x = e.clientX; S.aim.y = e.clientY; placeReticle(); } });
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (S.phase === "analysis") { pickAt(e.clientX, e.clientY); return; }
    if (S.phase !== "hunt") return;
    let x = S.W / 2, y = S.H / 2;
    if (e.pointerType === "mouse") { S.mouse = true; x = e.clientX; y = e.clientY; }
    else if (S.source === "photo") { x = e.clientX; y = e.clientY; S.aim.x = x; S.aim.y = y; placeReticle(); }
    shoot(x, y);
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && S.phase === "hunt") { e.preventDefault(); shoot(S.mouse ? S.aim.x : S.W / 2, S.mouse ? S.aim.y : S.H / 2); }
    if (e.key === "v") cycleVision();
  });
  function placeReticle() { ui.reticle.style.left = S.aim.x + "px"; ui.reticle.style.top = S.aim.y + "px"; }
  function cycleVision() { S.vision = (S.vision + 1) % 3; const b = $("btnVision"); b.textContent = "Vision: " + ["off", "segments", "depth"][S.vision]; b.classList.toggle("on", S.vision > 0); }

  $("btnCamera").onclick = startCamera;
  $("btnPhoto").onclick = () => $("file").click();
  $("file").onchange = (e) => { const f = e.target.files[0]; if (f) startPhoto(URL.createObjectURL(f)); e.target.value = ""; };
  for (const b of document.querySelectorAll("[data-demo]")) b.onclick = () => startPhoto("/api/img?name=" + b.dataset.demo);
  for (const b of document.querySelectorAll("#tabs .chip")) b.onclick = () => { stopTour(); setTab(b.dataset.layer); };
  $("anaGo").onclick = () => { audioInit(); spritesReady.then(startHunt); };
  $("btnVision").onclick = (e) => { e.stopPropagation(); cycleVision(); };
  $("btnShare").onclick = shareKillCam;
  $("btnAgain").onclick = () => { show(null); startHunt(); };
  $("btnRescan").onclick = () => { show(null); if (S.source === "camera") beginScan(); else beginScan(); };
  $("btnHome").onclick = goHome;
  for (const b of document.querySelectorAll("#objFilter .chip")) b.onclick = () => { S.objFilter = b.dataset.f; S.focus = null; renderObjects(); };
  $("anaToggle").onclick = () => { const m = ui.analysis.classList.toggle("min"); $("anaToggle").textContent = m ? "▴ Details" : "▾ Hide"; };
  $("scanDone").onclick = () => { if (S.frames.some((f) => f.scene)) scanState.finish = true; };
  $("anaRescan").onclick = () => { stopTour(); ui.analysis.classList.remove("show"); beginScan(); };
  $("btnHuntRescan").onclick = (e) => { e.stopPropagation(); ambience(false); S.round = null; beginScan(); };
})();
