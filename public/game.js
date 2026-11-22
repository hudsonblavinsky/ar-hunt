/* ONE SHOT — AR hunt, v1 (fake mode, solo)
 * Scene understanding: /api/scan -> Roboflow Workflow (SAM 3) -> landmark outlines.
 * Everything else (spawning, occlusion, shots, scoring, kill cam) runs on the device.
 */
(() => {
  "use strict";

  // ---------- Config ----------
  const ROUND_SECONDS = 60;
  const HORIZON = 0.42;            // normalized frame y where things get tiny
  const SCAN_LONG_SIDE = 640;      // px sent to the server
  const RESCAN_EVERY_MS = 12000;
  const RESCAN_DRIFT_DEG = 14;
  const SHOT_COOLDOWN_MS = 380;

  const SPECIES = {
    rabbit: { name: "Rabbit", points: 100, window: 3.2, k: 0.13, weight: 55, speed: 0.9 },
    fox:    { name: "Fox",    points: 250, window: 2.4, k: 0.17, weight: 30, speed: 1.3 },
    deer:   { name: "Deer",   points: 400, window: 2.0, k: 0.42, weight: 15, speed: 1.6 },
    stag:   { name: "Silver stag", points: 1500, window: 1.3, k: 0.48, weight: 0, speed: 2.2 },
  };
  const MASK_COLORS = { trunk: "#a463f2", bush: "#e0483c", rock: "#8fa3b8", bench: "#e8a33c", fence: "#f0d34a" };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $("view"), ctx = canvas.getContext("2d");
  const video = $("cam");
  const ui = {
    hud: $("hud"), score: $("score"), streak: $("streak"), timer: $("timer"), ammo: $("ammo"),
    reticle: $("reticle"), toast: $("toast"), status: $("status"), toolbar: $("toolbar"),
    home: $("home"), over: $("over"), killcam: $("killcam"),
  };

  // ---------- State ----------
  const S = {
    source: null,          // "camera" | "photo"
    img: null,             // HTMLImageElement for photo mode
    W: 0, H: 0, dpr: 1,
    landmarks: [],         // normalized: {kind, poly:[[x,y]], box}
    scanning: false, lastScanAt: 0, scanOrient: null,
    orient: null, pan: { x: 0, y: 0 }, gyro: false,
    showMasks: false, revealUntil: 0,
    aim: { x: 0, y: 0 }, pointerIsMouse: false,
    playing: false, roundEnd: 0, nextSpawnAt: 0,
    animals: [], fx: [],
    score: 0, streak: 0, bestStreak: 0, hits: 0, shots: 0, stagSeen: false, stagAt: 0,
    lastShot: 0, best: null,
  };

  // ---------- Layout ----------
  function resize() {
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.W = window.innerWidth; S.H = window.innerHeight;
    canvas.width = Math.round(S.W * S.dpr); canvas.height = Math.round(S.H * S.dpr);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    if (!S.pointerIsMouse) { S.aim.x = S.W / 2; S.aim.y = S.H / 2; }
  }
  window.addEventListener("resize", resize);
  resize();

  function srcSize() {
    if (S.source === "camera") return [video.videoWidth || 1, video.videoHeight || 1];
    if (S.img) return [S.img.naturalWidth, S.img.naturalHeight];
    return [1, 1];
  }
  // "cover" fit of the source into the screen
  function cover() {
    const [vw, vh] = srcSize();
    const s = Math.max(S.W / vw, S.H / vh);
    const sw = vw * s, sh = vh * s;
    return { s, sw, sh, dx: (S.W - sw) / 2, dy: (S.H - sh) / 2, vw, vh };
  }
  // normalized frame coords -> screen (includes gyro pan for live camera)
  function toScreen(nx, ny, c = cover()) {
    return [c.dx + nx * c.sw + S.pan.x, c.dy + ny * c.sh + S.pan.y];
  }
  function drawSource(c = cover()) {
    const el = S.source === "camera" ? video : S.img;
    if (!el) return;
    ctx.drawImage(el, c.dx, c.dy, c.sw, c.sh);
  }

  // ---------- Motion (gyro) ----------
  function onOrient(e) {
    if (e.alpha == null) return;
    S.gyro = true;
    S.orient = { a: e.alpha, b: e.beta, g: e.gamma };
  }
  async function enableMotion() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const r = await DeviceOrientationEvent.requestPermission(); // iOS: must be from a tap
        if (r !== "granted") return;
      }
      window.addEventListener("deviceorientation", onOrient);
    } catch (_) { /* no gyro: overlays stay put, rescans keep things aligned */ }
  }
  function angDiff(a, b) { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }
  function orientDelta() {
    if (!S.orient || !S.scanOrient) return { yaw: 0, pitch: 0 };
    const landscape = Math.abs((screen.orientation && screen.orientation.angle) || window.orientation || 0) === 90;
    const yaw = angDiff(S.orient.a, S.scanOrient.a);
    const pitch = landscape ? -(S.orient.g - S.scanOrient.g) * Math.sign((screen.orientation && screen.orientation.angle) || window.orientation || 90)
                            : (S.orient.b - S.scanOrient.b);
    return { yaw, pitch };
  }
  function updatePan() {
    if (S.source !== "camera" || !S.gyro) { S.pan.x = S.pan.y = 0; return; }
    const c = cover();
    // Rough horizontal FOV of the displayed image; rescans correct drift anyway.
    const fov = c.vw < c.vh ? 50 : 64;
    const ppd = c.sw / fov;
    const d = orientDelta();
    const tx = d.yaw * ppd, ty = d.pitch * ppd;
    S.pan.x += (tx - S.pan.x) * 0.35;
    S.pan.y += (ty - S.pan.y) * 0.35;
  }

  // ---------- Scanning (Roboflow) ----------
  const grab = document.createElement("canvas");
  async function scan({ silent = false } = {}) {
    if (S.scanning) return;
    S.scanning = true;
    if (!silent) status("Scanning the scene… hold steady");
    const [vw, vh] = srcSize();
    const k = SCAN_LONG_SIDE / Math.max(vw, vh);
    grab.width = Math.round(vw * Math.min(1, k)); grab.height = Math.round(vh * Math.min(1, k));
    const g = grab.getContext("2d");
    g.drawImage(S.source === "camera" ? video : S.img, 0, 0, grab.width, grab.height);
    const orientAtCapture = S.orient ? { ...S.orient } : null;
    const b64 = grab.toDataURL("image/jpeg", 0.75).split(",")[1];
    try {
      const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: b64 }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.status);
      // Only swap cover while nothing is on screen, so animals don't teleport.
      S.landmarks = data.landmarks || [];
      S.scanOrient = orientAtCapture;
      S.pan.x = S.pan.y = 0;
      S.lastScanAt = performance.now();
      if (!silent) {
        S.revealUntil = performance.now() + 1400;
        const n = S.landmarks.length;
        status(n ? `Found ${n} hiding spot${n > 1 ? "s" : ""} · ${data.ms} ms` : "No cover found — animals will run in the open", 2200);
      }
    } catch (e) {
      console.warn("scan failed", e);
      S.lastScanAt = performance.now();
      if (!silent) status("Scan failed — playing in the open", 2500);
    } finally {
      S.scanning = false;
    }
  }

  // ---------- Geometry helpers ----------
  function landmarkScreen(l, c) {
    const pts = l.poly.map(([x, y]) => toScreen(x, y, c));
    const p = new Path2D();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return { l, path: p, pts };
  }
  function polyBottom(l) { return Math.max(...l.poly.map((q) => q[1])); }
  function polyTopNear(l, nx) {
    let best = Infinity;
    for (const [x, y] of l.poly) if (Math.abs(x - nx) < l.box.w * 0.25) best = Math.min(best, y);
    return best === Infinity ? l.box.y : best;
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- Spawning ----------
  function pickSpecies(t) {
    if (!S.stagSeen && t >= S.stagAt) { S.stagSeen = true; return "stag"; }
    const list = Object.entries(SPECIES).filter(([, v]) => v.weight > 0);
    let r = Math.random() * list.reduce((a, [, v]) => a + v.weight, 0);
    for (const [k, v] of list) { if ((r -= v.weight) <= 0) return k; }
    return "rabbit";
  }
  function sizeFor(sp, feetN) { return Math.max(0.045, SPECIES[sp].k * Math.max(0.08, feetN - HORIZON)); }

  function spawn(now) {
    const t = (now - (S.roundEnd - ROUND_SECONDS * 1000)) / 1000;
    const sp = pickSpecies(t);
    const usable = S.landmarks.filter((l) => polyBottom(l) > HORIZON + 0.05 && l.box.h > 0.04);
    let a;
    if (usable.length) {
      // Prefer big cover, but mix it up.
      const l = usable[Math.floor(Math.pow(Math.random(), 1.6) * usable.length)];
      const cx = l.box.x + l.box.w / 2, bottom = polyBottom(l);
      const side = cx < 0.5 ? 1 : -1; // come out toward the middle
      const mode = l.kind === "rock" ? "perch" : l.kind === "bush" ? (Math.random() < 0.5 ? "pop" : "dash")
                 : (Math.random() < 0.7 ? "peek" : "dash");
      let feet = bottom - 0.004, x0 = cx, x1 = cx, y0, y1;
      const h = sizeFor(sp, feet);
      const c0 = cover(); const wN = h * aspect(sp) * (c0.sh / c0.sw); // animal width in normalized x
      if (mode === "peek") {
        x1 = side > 0 ? l.box.x + l.box.w + wN * 0.1 : l.box.x - wN * 0.1;
        x0 = cx;
        if (l.kind === "fence" || l.kind === "bench") { x0 = side > 0 ? l.box.x + l.box.w * 0.6 : l.box.x + l.box.w * 0.4; }
        y0 = y1 = feet;
      } else if (mode === "pop") {
        feet = bottom - l.box.h * 0.2;
        x0 = x1 = clamp(cx + rand(-0.25, 0.25) * l.box.w, l.box.x + wN / 2, l.box.x + l.box.w - wN / 2);
        y0 = feet + h * 0.9; y1 = feet;
      } else if (mode === "perch") {
        const top = polyTopNear(l, cx);
        x0 = cx - side * wN; x1 = cx; y0 = bottom; y1 = top + 0.005; feet = y1;
      } else { // dash out of cover and across the screen
        x0 = cx; x1 = side > 0 ? 1.15 : -0.15; y0 = y1 = feet;
      }
      a = mkAnimal(sp, mode, l, x0, y0, x1, y1, side);
    } else {
      const feet = rand(0.68, 0.86), side = Math.random() < 0.5 ? 1 : -1;
      a = mkAnimal(sp, "dash", null, side > 0 ? -0.12 : 1.12, feet, side > 0 ? 1.12 : -0.12, feet, side);
    }
    S.animals.push(a);
    if (sp === "stag") toast("✨ SILVER STAG ✨", "#dfe8f2", 900);
  }
  function mkAnimal(sp, mode, anchor, x0, y0, x1, y1, side) {
    const spec = SPECIES[sp];
    const dashTime = mode === "dash" ? spec.window : 0;
    return {
      sp, mode, anchor, x0, y0, x1, y1, side,
      face: x1 >= x0 ? 1 : -1, born: performance.now(),
      enter: mode === "dash" ? dashTime : 0.35, hold: mode === "dash" ? 0 : spec.window,
      state: "live", stateAt: 0, x: x0, y: y0, h: sizeFor(sp, Math.max(y0, y1)), hitPose: 0,
      depth: mode === "pop" ? y1 : mode === "perch" ? y0 : Math.max(y0, y1),
      clipBottom: mode === "pop" && anchor ? polyBottom(anchor) : null,
    };
  }

  function updateAnimals(now) {
    for (const a of S.animals) {
      const t = (now - a.born) / 1000;
      if (a.state === "live") {
        if (a.mode === "dash") {
          const u = clamp(t / a.enter, 0, 1);
          a.x = a.x0 + (a.x1 - a.x0) * u; a.y = a.y0;
          if (u >= 1) escape(a, now, true);
        } else {
          const u = clamp(t / a.enter, 0, 1), e = 1 - Math.pow(1 - u, 3);
          a.x = a.x0 + (a.x1 - a.x0) * e; a.y = a.y0 + (a.y1 - a.y0) * e;
          if (t > a.enter + a.hold) escape(a, now, false);
        }
      } else if (a.state === "leaving" || a.state === "bolt") {
        const u = (now - a.stateAt) / 1000;
        const spd = (a.state === "bolt" ? 2.2 : 1) * SPECIES[a.sp].speed * 0.9;
        if (a.mode === "peek" && a.state === "leaving") { // duck back behind cover
          a.x += (a.x0 - a.x) * 0.18;
        } else if (a.mode === "pop" && a.state === "leaving") {
          a.y += (a.y0 - a.y) * 0.18;
        } else {
          a.x += a.face * spd * 0.016; a.y -= Math.sin(u * 18) * 0.0015;
        }
        if (u > (a.state === "bolt" ? 0.9 : 0.7)) a.dead = true;
      } else if (a.state === "hit") {
        a.hitPose = clamp((now - a.stateAt) / 350, 0, 1);
        if (now - a.stateAt > 1000) a.dead = true;
      }
    }
    S.animals = S.animals.filter((a) => !a.dead);
    if (S.playing && !S.animals.length && now >= S.nextSpawnAt) spawn(now);
  }
  function escape(a, now, quiet) {
    a.state = "leaving"; a.stateAt = now;
    breakStreak("It got away", "#b9ab90");
    S.nextSpawnAt = now + rand(700, 1600);
  }
  function breakStreak(msg, color) {
    S.streak = 0; if (msg) toast(msg, color, 700); sfx("whoosh");
  }

  // ---------- Animal art (original, procedural) ----------
  function aspect(sp) { return sp === "rabbit" ? 1.15 : sp === "fox" ? 1.6 : 1.25; }
  function animalHitboxes(sp) { // ellipses in local units (feet at 0,0; height 1; facing +x)
    switch (sp) {
      case "rabbit": return [[0, -0.32, 0.42, 0.3], [0.3, -0.62, 0.2, 0.2], [0.28, -0.92, 0.1, 0.18]];
      case "fox": return [[-0.05, -0.42, 0.5, 0.2], [0.55, -0.55, 0.2, 0.17], [-0.65, -0.4, 0.3, 0.12], [0, -0.18, 0.4, 0.18]];
      default: return [[-0.05, -0.62, 0.42, 0.18], [0.42, -0.85, 0.14, 0.18], [0.55, -0.92, 0.15, 0.1], [0, -0.3, 0.38, 0.3]];
    }
  }
  function drawAnimal(a, c, now) {
    const [sx, sy] = toScreen(a.x, a.y, c);
    const H = a.h * c.sh;
    const moving = a.state !== "live" || a.mode === "dash" || ((now - a.born) / 1000 < a.enter);
    const gait = moving ? Math.sin(now / 55) : Math.sin(now / 400) * 0.15;
    ctx.save();
    if (a.clipBottom != null) { const cy = toScreen(0, a.clipBottom, c)[1]; ctx.beginPath(); ctx.rect(-1e4, -1e4, 3e4, cy + 1e4); ctx.clip(); }
    ctx.translate(sx, sy);
    if (a.state === "hit") {
      ctx.globalAlpha = 1 - clamp((now - a.stateAt - 600) / 400, 0, 1);
      ctx.rotate(-a.face * a.hitPose * 1.4);
    }
    ctx.scale(a.face * H, H);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    // soft ground shadow
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.beginPath(); ctx.ellipse(0, 0, 0.45 * aspect(a.sp), 0.05, 0, 0, Math.PI * 2); ctx.fill();
    if (a.sp === "rabbit") rabbit(gait); else if (a.sp === "fox") fox(gait); else deer(gait, a.sp === "stag", now);
    ctx.restore();
  }
  function ell(x, y, rx, ry, rot = 0) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill(); }
  function grad(y0, y1, c0, c1) { const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, c0); g.addColorStop(1, c1); return g; }
  function rabbit(g) {
    const fur = grad(-1, 0, "#a08468", "#6f5844");
    ctx.fillStyle = fur;
    ell(-0.05 + g * 0.02, -0.06, 0.22, 0.07);                 // hind foot
    ell(0, -0.3, 0.4, 0.28, -0.15);                            // body
    ell(0.3, -0.6, 0.19, 0.17);                                // head
    ctx.save(); ctx.translate(0.24, -0.72); ctx.rotate(-0.25 + g * 0.05); ell(0, -0.18, 0.06, 0.2); ctx.restore();
    ctx.save(); ctx.translate(0.33, -0.74); ctx.rotate(0.05 + g * 0.05); ell(0, -0.18, 0.065, 0.21); ctx.restore();
    ctx.fillStyle = "#c9a98c"; ctx.save(); ctx.translate(0.33, -0.74); ctx.rotate(0.05 + g * 0.05); ell(0, -0.18, 0.03, 0.15); ctx.restore();
    ctx.fillStyle = "#ece6dc"; ell(-0.38, -0.36, 0.09, 0.09);  // tail
    ctx.fillStyle = "#6f5844"; ell(0.22 + g * 0.04, -0.05, 0.08, 0.05); // fore paw
    ctx.fillStyle = "#1a1410"; ell(0.38, -0.63, 0.032, 0.036);
    ctx.fillStyle = "#d9b3a8"; ell(0.48, -0.58, 0.025, 0.02);
  }
  function fox(g) {
    const fur = grad(-0.8, 0, "#d9782f", "#a5501d");
    ctx.strokeStyle = "#2a1c14"; ctx.lineWidth = 0.07;
    for (const [x, ph] of [[-0.3, 0], [-0.18, Math.PI], [0.25, Math.PI], [0.37, 0]]) {
      ctx.beginPath(); ctx.moveTo(x, -0.3); ctx.lineTo(x + Math.sin(g * 1.2 + ph) * 0.1, -0.02); ctx.stroke();
    }
    ctx.fillStyle = fur;
    ctx.save(); ctx.translate(-0.45, -0.42); ctx.rotate(0.35 + g * 0.08); ell(-0.25, 0, 0.32, 0.12); ctx.restore(); // tail
    ctx.fillStyle = "#f1e8da"; ctx.save(); ctx.translate(-0.45, -0.42); ctx.rotate(0.35 + g * 0.08); ell(-0.5, 0, 0.08, 0.07); ctx.restore();
    ctx.fillStyle = fur; ell(0, -0.42, 0.45, 0.17);           // body
    ell(0.5, -0.56, 0.17, 0.14);                               // head
    ctx.beginPath(); ctx.moveTo(0.58, -0.6); ctx.lineTo(0.8, -0.52); ctx.lineTo(0.6, -0.48); ctx.fill(); // snout
    ctx.beginPath(); ctx.moveTo(0.42, -0.64); ctx.lineTo(0.44, -0.84); ctx.lineTo(0.53, -0.66); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0.53, -0.66); ctx.lineTo(0.6, -0.84); ctx.lineTo(0.64, -0.62); ctx.fill();
    ctx.fillStyle = "#f1e8da"; ell(0.45, -0.46, 0.12, 0.08); ell(0.66, -0.5, 0.08, 0.035);
    ctx.fillStyle = "#1a1410"; ell(0.79, -0.53, 0.025, 0.022); ell(0.58, -0.61, 0.022, 0.026);
  }
  function deer(g, silver, now) {
    const body = silver ? grad(-1, 0, "#f6f8fb", "#aeb8c6") : grad(-1, 0, "#b48a5e", "#7d5a3a");
    if (silver) { ctx.shadowColor = "rgba(220,235,255,.95)"; ctx.shadowBlur = 25 + Math.sin(now / 120) * 8; }
    ctx.strokeStyle = silver ? "#9aa6b6" : "#5d4128"; ctx.lineWidth = 0.055;
    for (const [x, ph] of [[-0.3, 0], [-0.2, Math.PI], [0.25, Math.PI], [0.34, 0]]) {
      ctx.beginPath(); ctx.moveTo(x, -0.5); ctx.lineTo(x + Math.sin(g + ph) * 0.09, -0.2); ctx.lineTo(x + Math.sin(g + ph) * 0.05, 0); ctx.stroke();
    }
    ctx.fillStyle = body;
    ell(0, -0.6, 0.42, 0.17);                                   // body
    ctx.save(); ctx.translate(0.32, -0.66); ctx.rotate(-0.9); ell(0.15, 0, 0.18, 0.08); ctx.restore(); // neck
    ell(0.5, -0.9, 0.12, 0.08, 0.35);                           // head
    ctx.beginPath(); ctx.moveTo(0.52, -0.95); ctx.lineTo(0.7, -0.86); ctx.lineTo(0.55, -0.82); ctx.fill();
    ctx.fillStyle = silver ? "#ffffff" : "#efe6d6"; ell(-0.4, -0.66, 0.06, 0.08); // tail
    ctx.fillStyle = body; ell(0.4, -0.99, 0.06, 0.03, -0.6);   // ear
    ctx.shadowBlur = 0;
    ctx.strokeStyle = silver ? "#e9eef6" : "#d8c5a0"; ctx.lineWidth = 0.035;  // antlers
    ctx.beginPath();
    ctx.moveTo(0.47, -0.97); ctx.quadraticCurveTo(0.38, -1.15, 0.5, -1.3);
    ctx.moveTo(0.43, -1.1); ctx.lineTo(0.33, -1.2);
    ctx.moveTo(0.46, -1.2); ctx.lineTo(0.6, -1.25);
    if (silver) { ctx.moveTo(0.5, -1.3); ctx.lineTo(0.44, -1.42); ctx.moveTo(0.5, -1.3); ctx.lineTo(0.6, -1.4); }
    ctx.stroke();
    ctx.fillStyle = "#14100c"; ell(0.56, -0.92, 0.02, 0.022); ell(0.69, -0.865, 0.022, 0.018);
  }

  // ---------- Occlusion ----------
  function occludersFor(a, shapes) {
    // Anything whose base is lower on screen than the animal's feet is closer -> in front.
    return shapes.filter(({ l }) => !(a.mode === "perch" && l === a.anchor) && polyBottom(l) > a.depth + 0.001);
  }

  // ---------- Shooting ----------
  function shoot(x, y) {
    const now = performance.now();
    if (!S.playing || now - S.lastShot < SHOT_COOLDOWN_MS) return;
    S.lastShot = now;
    sfx("shot"); flash(x, y);
    if (navigator.vibrate) navigator.vibrate(25);
    ui.reticle.classList.add("cool"); setTimeout(() => ui.reticle.classList.remove("cool"), SHOT_COOLDOWN_MS);

    const target = S.animals.find((a) => a.state === "live");
    if (!target) return; // nothing up: free shot, no penalty
    S.shots++;
    const c = cover();
    const shapes = S.landmarks.map((l) => landmarkScreen(l, c));
    const onAnimal = hitsAnimal(target, x, y, c);
    const blocker = occludersFor(target, shapes).find((s) => ptInPoly(x, y, s.pts));
    if (onAnimal && !blocker) {
      S.hits++; S.streak++; S.bestStreak = Math.max(S.bestStreak, S.streak);
      const mult = S.streak >= 5 ? 3 : S.streak >= 3 ? 2 : S.streak >= 2 ? 1.5 : 1;
      const pts = Math.round(SPECIES[target.sp].points * mult);
      S.score += pts;
      target.state = "hit"; target.stateAt = now;
      S.nextSpawnAt = now + rand(900, 1700);
      sfx("hit");
      S.fx.push({ type: "pop", x, y, t: now, text: `+${pts}${mult > 1 ? `  x${mult}` : ""}` });
      captureKillCam(target, x, y, pts, mult);
    } else {
      target.state = "bolt"; target.stateAt = now;
      if (target.mode === "peek" || target.mode === "pop") target.face = target.side;
      S.nextSpawnAt = now + rand(800, 1600);
      S.fx.push({ type: "miss", x, y, t: now });
      breakStreak(onAnimal && blocker ? `Blocked by the ${blocker.l.kind}!` : "Missed!", "#e0483c");
    }
    renderHud();
  }
  function hitsAnimal(a, x, y, c) {
    const [sx, sy] = toScreen(a.x, a.y, c);
    const H = a.h * c.sh;
    const lx = ((x - sx) / H) * a.face, ly = (y - sy) / H;
    const pad = 1.12; // a little forgiveness
    return animalHitboxes(a.sp).some(([ex, ey, rx, ry]) => ((lx - ex) / (rx * pad)) ** 2 + ((ly - ey) / (ry * pad)) ** 2 <= 1);
  }
  function ptInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------- Kill cam ----------
  function captureKillCam(a, x, y, pts, mult) {
    if (S.best && S.best.pts >= pts) return;
    render(performance.now(), true); // draw the frame with the animal still standing
    const out = document.createElement("canvas");
    const scale = Math.min(1, 1080 / Math.max(S.W, S.H));
    out.width = Math.round(S.W * scale * S.dpr); out.height = Math.round(S.H * scale * S.dpr);
    const o = out.getContext("2d");
    o.drawImage(canvas, 0, 0, out.width, out.height);
    o.setTransform(scale * S.dpr, 0, 0, scale * S.dpr, 0, 0);
    // vignette
    const v = o.createRadialGradient(x, y, 40, x, y, Math.max(S.W, S.H) * 0.8);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.55)");
    o.fillStyle = v; o.fillRect(0, 0, S.W, S.H);
    // crosshair
    o.strokeStyle = "#fff"; o.lineWidth = 2.5; o.shadowColor = "#000"; o.shadowBlur = 4;
    o.beginPath(); o.arc(x, y, 20, 0, Math.PI * 2);
    o.moveTo(x - 34, y); o.lineTo(x - 10, y); o.moveTo(x + 10, y); o.lineTo(x + 34, y);
    o.moveTo(x, y - 34); o.lineTo(x, y - 10); o.moveTo(x, y + 10); o.lineTo(x, y + 34); o.stroke();
    o.fillStyle = "#e0483c"; o.beginPath(); o.arc(x, y, 3, 0, Math.PI * 2); o.fill();
    // stamp
    const fs = Math.round(Math.min(S.W, S.H) * 0.14);
    o.font = `900 ${fs}px system-ui, sans-serif`; o.textAlign = "center";
    o.lineWidth = 6; o.strokeStyle = "rgba(0,0,0,.7)"; o.fillStyle = "#e0483c";
    o.strokeText("HIT", S.W / 2, S.H * 0.2); o.fillText("HIT", S.W / 2, S.H * 0.2);
    o.font = `800 ${Math.round(fs * 0.28)}px system-ui, sans-serif`; o.fillStyle = "#f4ead8";
    const line = `${SPECIES[a.sp].name.toUpperCase()} · +${pts}${mult > 1 ? ` (x${mult} streak)` : ""}`;
    o.strokeText(line, S.W / 2, S.H * 0.2 + fs * 0.45); o.fillText(line, S.W / 2, S.H * 0.2 + fs * 0.45);
    o.font = `700 ${Math.round(fs * 0.18)}px system-ui, sans-serif`; o.fillStyle = "rgba(244,234,216,.85)"; o.textAlign = "right";
    o.fillText("ONE SHOT · scene by Roboflow", S.W - 14, S.H - 16);
    S.best = { pts, url: out.toDataURL("image/jpeg", 0.88), sp: a.sp };
  }

  // ---------- FX + sound ----------
  function flash(x, y) { S.fx.push({ type: "flash", x, y, t: performance.now() }); }
  let ac = null;
  function audioInit() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch (_) {} }
  function sfx(kind) {
    if (!ac) return;
    const t = ac.currentTime;
    if (kind === "shot") {
      const len = 0.35, buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
      const src = ac.createBufferSource(); src.buffer = buf;
      const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(2400, t); f.frequency.exponentialRampToValueAtTime(300, t + len);
      const gn = ac.createGain(); gn.gain.value = 0.9;
      src.connect(f).connect(gn).connect(ac.destination); src.start(t);
    } else {
      const o = ac.createOscillator(), gn = ac.createGain();
      o.connect(gn).connect(ac.destination);
      if (kind === "hit") { o.type = "triangle"; o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.12); }
      else { o.type = "sine"; o.frequency.setValueAtTime(380, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.25); }
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(kind === "hit" ? 0.25 : 0.08, t + 0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t); o.stop(t + 0.32);
    }
  }

  // ---------- Render ----------
  function render(now, forCapture = false) {
    ctx.clearRect(0, 0, S.W, S.H);
    const c = cover();
    drawSource(c);
    const shapes = S.landmarks.map((l) => landmarkScreen(l, c));

    for (const a of S.animals) {
      drawAnimal(a, c, now);
      // put the real-world cover back on top of the animal
      for (const s of occludersFor(a, shapes)) {
        ctx.save(); ctx.clip(s.path); drawSource(c); ctx.restore();
      }
    }

    const reveal = now < S.revealUntil;
    if (!forCapture && (S.showMasks || reveal)) {
      const alpha = S.showMasks ? 0.38 : 0.45 * clamp((S.revealUntil - now) / 600, 0, 1);
      ctx.save();
      for (const s of shapes) {
        ctx.fillStyle = MASK_COLORS[s.l.kind] || "#fff"; ctx.globalAlpha = alpha; ctx.fill(s.path);
        ctx.globalAlpha = Math.min(1, alpha * 2.2); ctx.strokeStyle = MASK_COLORS[s.l.kind]; ctx.lineWidth = 2; ctx.stroke(s.path);
      }
      ctx.globalAlpha = Math.min(1, alpha * 2.4);
      ctx.font = "800 12px system-ui, sans-serif"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
      for (const s of shapes.slice(0, 14)) {
        const [x, y] = toScreen(s.l.box.x + s.l.box.w / 2, s.l.box.y + s.l.box.h / 2, c);
        ctx.fillText(s.l.kind.toUpperCase(), x, y);
      }
      ctx.restore();
    }

    if (forCapture) return;
    // effects
    S.fx = S.fx.filter((f) => now - f.t < 900);
    for (const f of S.fx) {
      const u = (now - f.t) / 900;
      if (f.type === "flash" && u < 0.1) {
        ctx.fillStyle = `rgba(255,236,200,${0.35 * (1 - u / 0.1)})`; ctx.fillRect(0, 0, S.W, S.H);
      } else if (f.type === "pop") {
        ctx.save(); ctx.globalAlpha = 1 - u; ctx.font = "900 26px system-ui, sans-serif"; ctx.textAlign = "center";
        ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.fillStyle = "#e8a33c";
        ctx.strokeText(f.text, f.x, f.y - 30 - u * 50); ctx.fillText(f.text, f.x, f.y - 30 - u * 50);
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
        for (let i = 0; i < 8; i++) { const ang = (i / 8) * Math.PI * 2, r0 = 10 + u * 40, r1 = r0 + 10 * (1 - u);
          ctx.beginPath(); ctx.moveTo(f.x + Math.cos(ang) * r0, f.y + Math.sin(ang) * r0); ctx.lineTo(f.x + Math.cos(ang) * r1, f.y + Math.sin(ang) * r1); ctx.stroke(); }
        ctx.restore();
      } else if (f.type === "miss") {
        ctx.save(); ctx.globalAlpha = 1 - u; ctx.strokeStyle = "#e0483c"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(f.x - 9, f.y - 9); ctx.lineTo(f.x + 9, f.y + 9); ctx.moveTo(f.x + 9, f.y - 9); ctx.lineTo(f.x - 9, f.y + 9); ctx.stroke(); ctx.restore();
      }
    }
    if (S.scanning) {
      const y = ((now / 1200) % 1) * S.H;
      const g = ctx.createLinearGradient(0, y - 60, 0, y);
      g.addColorStop(0, "rgba(232,163,60,0)"); g.addColorStop(1, "rgba(232,163,60,.45)");
      ctx.fillStyle = g; ctx.fillRect(0, y - 60, S.W, 60);
    }
  }

  // ---------- HUD ----------
  function renderHud() {
    ui.score.textContent = S.score;
    const mult = S.streak >= 5 ? 3 : S.streak >= 3 ? 2 : S.streak >= 2 ? 1.5 : 1;
    ui.streak.textContent = S.streak >= 2 ? `streak ${S.streak} · x${mult}` : "";
    ui.ammo.textContent = `${S.hits}/${S.shots} hits`;
  }
  let toastTimer = 0, statusTimer = 0;
  function toast(text, color = "#f4ead8", ms = 800) {
    ui.toast.textContent = text; ui.toast.style.color = color; ui.toast.style.opacity = 1;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (ui.toast.style.opacity = 0), ms);
  }
  function status(text, ms) {
    ui.status.textContent = text; ui.status.style.display = "block";
    clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => (ui.status.style.display = "none"), ms);
  }

  // ---------- Loop ----------
  function loop(now) {
    if (S.source) {
      updatePan();
      if (S.playing) {
        const left = Math.max(0, (S.roundEnd - now) / 1000);
        ui.timer.textContent = Math.ceil(left);
        ui.timer.classList.toggle("low", left <= 10);
        if (left <= 0) endRound();
        // keep cover fresh on a live camera, but only while nothing is on screen
        if (S.source === "camera" && !S.scanning && !S.animals.length) {
          const d = orientDelta();
          if (now - S.lastScanAt > RESCAN_EVERY_MS || Math.hypot(d.yaw, d.pitch) > RESCAN_DRIFT_DEG) scan({ silent: true });
        }
      }
      updateAnimals(now);
      render(now);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- Flow ----------
  async function startCamera() {
    audioInit();
    await enableMotion();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      video.srcObject = stream;
      await video.play();
      await new Promise((r) => (video.videoWidth ? r() : video.addEventListener("loadedmetadata", r, { once: true })));
      S.source = "camera"; S.img = null;
      beginRound();
    } catch (e) {
      alert("Couldn't open the camera (" + (e.name || e) + "). Try a photo or a demo scene instead.");
    }
  }
  function startPhoto(src) {
    audioInit();
    const img = new Image();
    img.onload = () => { S.source = "photo"; S.img = img; stopCamera(); beginRound(); };
    img.onerror = () => {
      const m = /^\/demo\/([\w-]+)\.jpg$/.exec(src); // static demo missing -> same-origin proxy
      if (m && !img.dataset.retried) { img.dataset.retried = 1; img.src = "/api/img?name=" + m[1]; return; }
      alert("Couldn't load that image.");
    };
    img.src = src;
  }
  function stopCamera() {
    if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  }
  async function beginRound() {
    show(null);
    ui.hud.style.display = "flex"; ui.toolbar.style.display = "flex"; ui.reticle.style.display = "block";
    Object.assign(S, { score: 0, streak: 0, bestStreak: 0, hits: 0, shots: 0, animals: [], fx: [], best: null,
      stagSeen: false, stagAt: rand(22, 48), playing: false, landmarks: [] });
    renderHud(); ui.timer.textContent = ROUND_SECONDS;
    if (S.source === "camera") await new Promise((r) => setTimeout(r, 900)); // let exposure settle, player hold still
    await scan();
    S.playing = true;
    S.roundEnd = performance.now() + ROUND_SECONDS * 1000;
    S.nextSpawnAt = performance.now() + 1200;
    toast("HUNT!", "#e8a33c", 700);
  }
  function endRound() {
    S.playing = false;
    S.animals = [];
    ui.hud.style.display = "none"; ui.toolbar.style.display = "none"; ui.reticle.style.display = "none"; ui.status.style.display = "none";
    $("finalScore").textContent = S.score;
    $("stHits").textContent = S.hits;
    $("stAcc").textContent = S.shots ? Math.round((S.hits / S.shots) * 100) + "%" : "–";
    $("stStreak").textContent = S.bestStreak;
    if (S.best) { ui.killcam.src = S.best.url; ui.killcam.style.display = "block"; $("btnShare").style.display = ""; }
    else { ui.killcam.style.display = "none"; $("btnShare").style.display = "none"; }
    show("over");
  }
  function show(id) { for (const s of document.querySelectorAll(".screen")) s.classList.toggle("show", s.id === id); }

  async function shareKillCam() {
    if (!S.best) return;
    const blob = await (await fetch(S.best.url)).blob();
    const file = new File([blob], "one-shot-killcam.jpg", { type: "image/jpeg" });
    const text = `${S.score} points in ONE SHOT 🎯`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text, title: "ONE SHOT" }); return; } catch (_) { return; }
    }
    const a = document.createElement("a"); a.href = S.best.url; a.download = "one-shot-killcam.jpg"; a.click();
  }

  // ---------- Input ----------
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") { S.pointerIsMouse = true; S.aim.x = e.clientX; S.aim.y = e.clientY; placeReticle(); }
  });
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    let x = S.W / 2, y = S.H / 2;
    if (e.pointerType === "mouse") { S.pointerIsMouse = true; x = e.clientX; y = e.clientY; }
    else if (S.source === "photo") { x = e.clientX; y = e.clientY; S.aim.x = x; S.aim.y = y; placeReticle(); }
    shoot(x, y);
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); shoot(S.pointerIsMouse ? S.aim.x : S.W / 2, S.pointerIsMouse ? S.aim.y : S.H / 2); }
    if (e.key === "m") toggleMasks();
  });
  function placeReticle() { ui.reticle.style.left = S.aim.x + "px"; ui.reticle.style.top = S.aim.y + "px"; }
  function toggleMasks() { S.showMasks = !S.showMasks; $("btnMasks").classList.toggle("on", S.showMasks); }

  $("btnCamera").onclick = startCamera;
  $("btnPhoto").onclick = () => $("file").click();
  $("file").onchange = (e) => { const f = e.target.files[0]; if (f) startPhoto(URL.createObjectURL(f)); e.target.value = ""; };
  for (const b of document.querySelectorAll("[data-demo]")) b.onclick = () => startPhoto(b.dataset.demo);
  $("btnMasks").onclick = (e) => { e.stopPropagation(); toggleMasks(); };
  $("btnRescan").onclick = (e) => { e.stopPropagation(); if (!S.animals.some((a) => a.state === "live")) scan(); };
  $("btnShare").onclick = shareKillCam;
  $("btnAgain").onclick = () => beginRound();
  $("btnHome").onclick = () => { stopCamera(); S.source = null; ctx.clearRect(0, 0, S.W, S.H); show("home"); };

  // Debug handle
  window.__hunt = S;
})();
