// POST /api/scan  { image: "<base64 jpeg>" }   (or GET /api/scan?demo=park-bench)
// Runs the Roboflow Workflow `ar-hunt-scene-scan`:
//   SAM 3 (text-prompted segmentation) + Depth Anything v3 (depth) + RF-DETR (object detection)
// and returns a compact scene description the game builds the hunt from.
// The Roboflow API key never leaves the server.

const WORKSPACE = process.env.ROBOFLOW_WORKSPACE || "hudsons-workspace-7m230";
const WORKFLOW = process.env.ROBOFLOW_WORKFLOW || "ar-hunt-scene-scan";
const ENDPOINT = `https://serverless.roboflow.com/infer/workflows/${WORKSPACE}/${WORKFLOW}`;
const GRID_W = 96; // depth grid columns sent to the phone

const KIND = {
  "tree trunk": "trunk", "tree stump": "stump", log: "log", rock: "rock",
  bush: "bush", bench: "bench", fence: "fence", sky: "sky",
};

module.exports = async function handler(req, res) {
  const key = process.env.ROBOFLOW_API_KEY;
  if (!key) return res.status(500).json({ error: "ROBOFLOW_API_KEY not set" });

  let body = req.body;
  if (req.method === "GET" && req.query && req.query.demo) {
    const r = await fetch(`https://${req.headers.host}/api/img?name=${encodeURIComponent(req.query.demo)}`);
    if (!r.ok) return res.status(502).json({ error: "demo image unavailable" });
    body = { image: Buffer.from(await r.arrayBuffer()).toString("base64") };
  } else if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only (or GET ?demo=park-bench)" });
  }
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const image = body && body.image;
  if (!image || typeof image !== "string" || image.length > 4_000_000) {
    return res.status(400).json({ error: "Send { image: base64 jpeg } under ~3MB" });
  }

  const t0 = Date.now();
  let out;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        inputs: { image: { type: "base64", value: image.replace(/^data:image\/\w+;base64,/, "") } },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Roboflow error", status: r.status, detail: data });
    out = (data.outputs && data.outputs[0]) || {};
  } catch (e) {
    return res.status(502).json({ error: "Roboflow request failed", detail: String(e) });
  }
  const roboflowMs = Date.now() - t0;
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(describeScene(out, roboflowMs));
};

function describeScene(out, roboflowMs) {
  const pred = out.predictions || {};
  const W = (pred.image && pred.image.width) || 1;
  const H = (pred.image && pred.image.height) || 1;

  // ---- depth: downsample Depth Anything's normalized map (1 = nearest) to a small uint8 grid
  const depth = Array.isArray(out.depth) ? out.depth : null;
  let grid = null, gw = 0, gh = 0;
  if (depth && depth.length && depth[0].length) {
    const dh = depth.length, dw = depth[0].length;
    gw = GRID_W; gh = Math.max(1, Math.round((GRID_W * dh) / dw));
    grid = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      const y0 = Math.floor((gy * dh) / gh), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * dh) / gh));
      for (let gx = 0; gx < gw; gx++) {
        const x0 = Math.floor((gx * dw) / gw), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * dw) / gw));
        let s = 0, n = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += depth[y][x]; n++; }
        grid[gy * gw + gx] = Math.max(0, Math.min(255, Math.round((s / n) * 255)));
      }
    }
  }
  const depthAt = (nx, ny) => {
    if (!grid) return null;
    const gx = Math.min(gw - 1, Math.max(0, Math.floor(nx * gw)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor(ny * gh)));
    return grid[gy * gw + gx] / 255;
  };

  // ---- segmentation → landmarks
  const minArea = W * H * 0.0015;
  const landmarks = [];
  let skyArea = 0;
  for (const p of pred.predictions || []) {
    const kind = KIND[p.class];
    if (!kind || p.width * p.height < minArea) continue;
    const pts = (p.points || []).map((q) => [q.x, q.y]);
    if (pts.length < 3) continue;
    const poly = simplify(pts, Math.max(1.5, Math.min(W, H) * 0.005)).map(([x, y]) => [r4(x / W), r4(y / H)]);
    const box = { x: r4((p.x - p.width / 2) / W), y: r4((p.y - p.height / 2) / H), w: r4(p.width / W), h: r4(p.height / H) };
    if (kind === "sky") { skyArea += polyArea(poly); landmarks.push({ kind, cls: p.class, conf: r4(p.confidence), box, poly }); continue; }
    // depth inside the outline: median of grid samples, plus depth at the base (nearest ground contact)
    const ds = [];
    if (grid) {
      for (let gy = Math.floor(box.y * gh); gy <= Math.ceil((box.y + box.h) * gh) && gy < gh; gy++)
        for (let gx = Math.floor(box.x * gw); gx <= Math.ceil((box.x + box.w) * gw) && gx < gw; gx++) {
          const cx = (gx + 0.5) / gw, cy = (gy + 0.5) / gh;
          if (inPoly(cx, cy, poly)) ds.push(grid[gy * gw + gx] / 255);
        }
    }
    ds.sort((a, b) => a - b);
    const med = ds.length ? ds[Math.floor(ds.length / 2)] : depthAt(box.x + box.w / 2, box.y + box.h * 0.8);
    landmarks.push({ kind, cls: p.class, conf: r4(p.confidence), box, poly, depth: r4(med ?? 0.5) });
  }
  // big, confident cover first
  landmarks.sort((a, b) => (b.kind !== "sky") - (a.kind !== "sky") || b.box.w * b.box.h - a.box.w * a.box.h);

  // ---- object detection (RF-DETR, COCO classes)
  const dpred = (out.detections && out.detections.predictions) || [];
  const detections = dpred.slice(0, 25).map((p) => {
    const box = { x: r4((p.x - p.width / 2) / W), y: r4((p.y - p.height / 2) / H), w: r4(p.width / W), h: r4(p.height / H) };
    return { cls: p.class, conf: r4(p.confidence), box, depth: r4(depthAt(box.x + box.w / 2, box.y + box.h * 0.9) ?? 0.5) };
  });

  const counts = {};
  for (const l of landmarks) counts[l.kind] = (counts[l.kind] || 0) + 1;
  for (const d of detections) counts["det:" + d.cls] = (counts["det:" + d.cls] || 0) + 1;

  return {
    ms: roboflowMs, width: W, height: H,
    models: ["SAM 3", "Depth Anything v3", "RF-DETR"],
    landmarks: landmarks.slice(0, 48),
    detections,
    sky: r4(skyArea),
    counts,
    depth: grid ? { w: gw, h: gh, data: Buffer.from(grid).toString("base64") } : null,
  };
}

function r4(v) { return Math.round(v * 10000) / 10000; }
function polyArea(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return Math.abs(a / 2); }
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Ramer–Douglas–Peucker
function simplify(points, eps) {
  if (points.length <= 8) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const [x0, y0] = points[i];
      const d = Math.abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}
