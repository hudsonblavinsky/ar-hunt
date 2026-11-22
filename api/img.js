// GET /api/img?name=park-bench
// Same-origin proxy for the two CC0 demo scenes (WordPress Photo Directory), so the
// canvas stays untainted for scanning and kill cams. Fallback when /demo/*.jpg isn't deployed.
const DEMOS = {
  "park-bench": [
    "https://pd.w.org/2025/01/9936793fff5e21861.51460097-1536x1024.jpg",
    "https://pd.w.org/2025/01/9936793fff5e21861.51460097-1024x682.jpg",
    "https://pd.w.org/2025/01/9936793fff5e21861.51460097-768x512.jpg",
  ],
  "two-trees": [
    "https://pd.w.org/2024/06/32166812ed14e0878.77533264-768x1024.jpeg",
    "https://pd.w.org/2024/06/32166812ed14e0878.77533264-1152x1536.jpeg",
    "https://pd.w.org/2024/06/32166812ed14e0878.77533264-1536x2048.jpeg",
  ],
};

// Also: GET /api/img?u=<pd.w.org image URL> for the CC0 wildlife photos the sprites are cut from.
const ALLOWED = /^https:\/\/pd\.w\.org\/\d{4}\/\d{2}\/[\w.\-]+\.(jpe?g|png)$/;

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const list = q.u ? (ALLOWED.test(q.u) ? [q.u] : null) : DEMOS[q.name || ""];
  if (!list) return res.status(404).json({ error: "unknown image" });
  for (const url of list) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4_000_000) continue;
      res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, s-maxage=604800, max-age=86400");
      return res.status(200).send(buf);
    } catch (_) { /* try next size */ }
  }
  return res.status(502).json({ error: "demo image unavailable" });
};
