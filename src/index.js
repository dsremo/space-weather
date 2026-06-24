// Space Weather — a small data pipeline + dashboard.
// A scheduled Cloudflare Worker ingests NOAA SWPC space-weather data into D1,
// then serves a dashboard that charts the geomagnetic Kp index and solar wind.

const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const PLASMA_URL = "https://services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json";
const UA = { "User-Agent": "space-weather.dsremo.com (data pipeline)" };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ingest(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/ingest") {
        const result = await ingest(env);
        return json(result);
      }
      if (url.pathname === "/api/data") {
        return json(await readData(env));
      }
      if (url.pathname === "/" || url.pathname === "") {
        return html(await renderDashboard(env));
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return new Response("Error: " + (err && err.message), { status: 500 });
    }
  },
};

async function ingest(env) {
  const [kpResp, plasmaResp] = await Promise.all([
    fetch(KP_URL, { headers: UA }),
    fetch(PLASMA_URL, { headers: UA }),
  ]);
  const kpData = await kpResp.json();
  const plasma = await plasmaResp.json();

  // Kp feed is an array of objects: { time_tag, Kp, a_running, ... }
  const kpRows = kpData.filter((r) => r && r.time_tag && r.Kp != null);

  // Plasma feed is an array of arrays; row 0 is the header [time_tag, density, speed, temperature].
  const plasmaRows = Array.isArray(plasma) ? plasma.slice(1) : [];
  // Cadence is ~1 min; keep roughly hourly to stay light.
  const windRows = plasmaRows.filter((_, i) => i % 60 === 0);

  const statements = [];
  for (const row of kpRows) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO kp_index (ts, kp, a_running) VALUES (?, ?, ?)")
        .bind(row.time_tag, Number(row.Kp), row.a_running != null ? Number(row.a_running) : null)
    );
  }
  for (const row of windRows) {
    const ts = row[0];
    const density = parseFloat(row[1]);
    const speed = parseFloat(row[2]);
    if (!ts) continue;
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO solar_wind (ts, speed, density) VALUES (?, ?, ?)")
        .bind(ts, isNaN(speed) ? null : speed, isNaN(density) ? null : density)
    );
  }
  if (statements.length) await env.DB.batch(statements);
  await env.DB.prepare("INSERT INTO ingest_log (at, kp_rows, wind_rows) VALUES (?, ?, ?)")
    .bind(new Date().toISOString(), kpRows.length, windRows.length)
    .run();

  return { ok: true, ingested: { kp: kpRows.length, wind: windRows.length } };
}

async function readData(env) {
  const kp = (await env.DB.prepare("SELECT ts, kp FROM kp_index ORDER BY ts DESC LIMIT 64").all()).results.reverse();
  const wind = (await env.DB.prepare("SELECT ts, speed, density FROM solar_wind ORDER BY ts DESC LIMIT 168").all()).results.reverse();
  const stats = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM kp_index) AS kp_n, (SELECT COUNT(*) FROM solar_wind) AS wind_n, (SELECT at FROM ingest_log ORDER BY id DESC LIMIT 1) AS last_ingest"
  ).first();
  return { kp, wind, stats };
}

function kpStatus(kp) {
  if (kp == null) return { label: "No data", level: "none", color: "#64748b" };
  if (kp < 4) return { label: "Quiet", level: "G0", color: "#34d399" };
  if (kp < 5) return { label: "Active", level: "G0", color: "#a3e635" };
  if (kp < 6) return { label: "Minor storm", level: "G1", color: "#fbbf24" };
  if (kp < 7) return { label: "Moderate storm", level: "G2", color: "#fb923c" };
  if (kp < 8) return { label: "Strong storm", level: "G3", color: "#f87171" };
  if (kp < 9) return { label: "Severe storm", level: "G4", color: "#ef4444" };
  return { label: "Extreme storm", level: "G5", color: "#dc2626" };
}

async function renderDashboard(env) {
  const data = await readData(env);
  const latestKp = data.kp.length ? data.kp[data.kp.length - 1] : null;
  const latestWind = data.wind.length ? data.wind[data.wind.length - 1] : null;
  const status = kpStatus(latestKp ? latestKp.kp : null);
  const lastIngest = data.stats && data.stats.last_ingest
    ? new Date(data.stats.last_ingest).toUTCString().replace("GMT", "UTC")
    : "—";
  const payload = JSON.stringify({ kp: data.kp, wind: data.wind });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Space Weather — live geomagnetic & solar-wind dashboard</title>
<meta name="description" content="A live space-weather dashboard: NOAA Kp index and solar wind, ingested on a schedule into Cloudflare D1.">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root{ --bg:#0a0e17; --panel:#121826; --line:#1f2937; --ink:#e7ecf3; --muted:#8b96a8; --accent:#6cb6ff; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:1040px;margin:0 auto;padding:32px 20px 56px}
  header h1{font-size:clamp(26px,4vw,40px);margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--muted);font-size:15px;margin:0}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}
  @media(max-width:720px){.grid{grid-template-columns:repeat(2,1fr)}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
  .card .k{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .card .v{font-size:30px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums}
  .status{grid-column:span 2}
  .pill{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:22px}
  .pdot{width:13px;height:13px;border-radius:50%}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:18px}
  .panel h2{margin:0 0 2px;font-size:17px}
  .panel p{margin:0 0 14px;color:var(--muted);font-size:13px}
  canvas{max-height:300px}
  footer{margin-top:36px;color:var(--muted);font-size:12.5px;font-family:ui-monospace,Menlo,monospace;display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Space Weather</h1>
    <p class="sub">NOAA geomagnetic &amp; solar-wind conditions, ingested on a schedule into Cloudflare D1 and charted live.</p>
  </header>

  <section class="grid">
    <div class="card status">
      <div class="k">Geomagnetic activity now</div>
      <div class="v"><span class="pill"><span class="pdot" style="background:${status.color}"></span>${status.label}</span></div>
      <div class="k" style="margin-top:8px">Kp ${latestKp ? latestKp.kp.toFixed(2) : "—"} · NOAA scale ${status.level}</div>
    </div>
    <div class="card">
      <div class="k">Solar wind speed</div>
      <div class="v">${latestWind && latestWind.speed != null ? Math.round(latestWind.speed) : "—"}<span style="font-size:14px;color:var(--muted)"> km/s</span></div>
    </div>
    <div class="card">
      <div class="k">Proton density</div>
      <div class="v">${latestWind && latestWind.density != null ? latestWind.density.toFixed(1) : "—"}<span style="font-size:14px;color:var(--muted)"> p/cm³</span></div>
    </div>
  </section>

  <section class="panel">
    <h2>Planetary Kp index — last 8 days</h2>
    <p>Kp measures global geomagnetic disturbance (0 = calm, 9 = extreme). Bars turn warm above storm level (Kp ≥ 5).</p>
    <canvas id="kpChart"></canvas>
  </section>

  <section class="panel">
    <h2>Solar wind speed — last 7 days</h2>
    <p>Faster solar wind (and higher density) drives stronger geomagnetic activity at Earth.</p>
    <canvas id="windChart"></canvas>
  </section>

  <footer>
    <span>Pipeline: ${data.stats ? data.stats.kp_n : 0} Kp + ${data.stats ? data.stats.wind_n : 0} wind rows stored · last ingest ${lastIngest}</span>
    <span>Source: <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener">NOAA SWPC</a> · built by Ashutosh Tiwari · <a href="/api/data">JSON</a></span>
  </footer>
</div>

<script>
  const DATA = ${payload};
  const kpColor = (v) => v < 5 ? "#34d399" : v < 6 ? "#fbbf24" : v < 7 ? "#fb923c" : "#ef4444";
  const fmt = (t) => { const d = new Date(t.replace(" ", "T") + (t.includes("Z") ? "" : "Z")); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" }); };
  const grid = { color: "rgba(148,163,184,.12)" }, ticks = { color: "#8b96a8", maxTicksLimit: 8, font: { size: 10 } };

  if (DATA.kp.length) new Chart(document.getElementById("kpChart"), {
    type: "bar",
    data: { labels: DATA.kp.map(r => fmt(r.ts)), datasets: [{ data: DATA.kp.map(r => r.kp), backgroundColor: DATA.kp.map(r => kpColor(r.kp)), borderRadius: 3 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { grid, ticks }, y: { grid, ticks, beginAtZero: true, max: 9 } } }
  });

  if (DATA.wind.length) new Chart(document.getElementById("windChart"), {
    type: "line",
    data: { labels: DATA.wind.map(r => fmt(r.ts)), datasets: [{ data: DATA.wind.map(r => r.speed), borderColor: "#6cb6ff", backgroundColor: "rgba(108,182,255,.12)", fill: true, tension: .3, pointRadius: 0, borderWidth: 2 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: { grid, ticks }, y: { grid, ticks, title: { display: true, text: "km/s", color: "#8b96a8" } } } }
  });
</script>
</body>
</html>`;
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
