// POST /api/scan  { image: "<base64 jpeg, no data: prefix>" }
// Runs the Roboflow Workflow (SAM 3 text-prompted segmentation) and returns
// simplified, normalized landmark outlines the game uses as hiding spots.
// The Roboflow API key never leaves the server.

const WORKSPACE = process.env.ROBOFLOW_WORKSPACE || "hudsons-workspace-7m230";
const WORKFLOW = process.env.ROBOFLOW_WORKFLOW || "ar-hunt-scene-scan";
const ENDPOINT = `https://serverless.roboflow.com/infer/workflows/${WORKSPACE}/${WORKFLOW}`;

// Map SAM 3 prompt classes onto the game's landmark kinds.
const KIND = {
  "tree trunk": "trunk",
  "tree stump": "rock",
  log: "rock",
  rock: "rock",
  bush: "bush",
  bench: "bench",
  fence: "fence",
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  const key = process.env.ROBOFLOW_API_KEY;
  if (!key) return res.status(500).json({ error: "ROBOFLOW_API_KEY not set" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const image = body && body.image;
  if (!image || typeof image !== "string" || image.length > 4_000_000) {
    return res.status(400).json({ error: "Send { image: base64 jpeg } under ~3MB" });
  }

  const t0 = Date.now();
  let data;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        inputs: {
          image: { type: "base64", value: image.replace(/^data:image\/\w+;base64,/, "") },
          ...(body.confidence ? { confidence: Number(body.confidence) } : {}),
        },
      }),
    });
    data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "Roboflow error", status: r.status, detail: data });
    }
  } catch (e) {
    return res.status(502).json({ error: "Roboflow request failed", detail: String(e) });
  }

  const out = (data.outputs && data.outputs[0]) || {};
  const pred = out.predictions || {};
  const W = (pred.image && pred.image.width) || 1;
  const H = (pred.image && pred.image.height) || 1;
  const minArea = W * H * 0.002; // drop specks

  const landmarks = [];
  for (const p of pred.predictions || []) {
    const kind = KIND[p.class];
    if (!kind) continue;
    if (p.width * p.height < minArea) continue;
    const pts = (p.points || []).map((q) => [q.x, q.y]);
    if (pts.length < 3) continue;
    const simple = simplify(pts, Math.max(1.5, Math.min(W, H) * 0.006));
    landmarks.push({
      kind,
      cls: p.class,
      conf: round(p.confidence, 3),
      box: {
        x: round((p.x - p.width / 2) / W), y: round((p.y - p.height / 2) / H),
        w: round(p.width / W), h: round(p.height / H),
      },
      poly: simple.map(([x, y]) => [round(x / W), round(y / H)]),
    });
  }
  // Big things first so spawning prefers prominent cover.
  landmarks.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ms: Date.now() - t0, width: W, height: H, landmarks: landmarks.slice(0, 40) });
};

function round(v, d = 4) { const m = 10 ** d; return Math.round(v * m) / m; }

// Ramer–Douglas–Peucker polyline simplification (closed polygon treated as open ring).
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
