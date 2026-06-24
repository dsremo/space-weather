// Space Weather — a multi-source data pipeline + live ops dashboard.
// A scheduled Worker ingests NOAA SWPC feeds into D1 (the pipeline); the dashboard pulls
// several NOAA feeds live and renders a real space-weather operations console:
// official G/R/S storm scales, a 3-day forecast, geomagnetic Kp, solar wind + IMF Bz,
// X-ray flare activity, and solar-cycle context.

const F = {
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  kpForecast: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
  plasma: "https://services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json",
  mag: "https://services.swpc.noaa.gov/products/solar-wind/mag-1-day.json",
  xray: "https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json",
  scales: "https://services.swpc.noaa.gov/products/noaa-scales.json",
  sunspot: "https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json",
};
const UA = { "User-Agent": "spaceweather.dsremo.com" };
const getJSON = async (url) => { try { const r = await fetch(url, { headers: UA }); return r.ok ? await r.json() : null; } catch (e) { return null; } };

function flareClass(flux) {
  if (flux == null) return "—";
  const bands = [[1e-4, "X"], [1e-5, "M"], [1e-6, "C"], [1e-7, "B"], [0, "A"]];
  for (const [t, c] of bands) if (flux >= t) return c + (flux / (t || 1e-8)).toFixed(1);
  return "A";
}
function kpStatus(kp) {
  if (kp == null) return { label: "No data", color: "#64748b", g: "G0" };
  if (kp < 4) return { label: "Quiet", color: "#34d399", g: "G0" };
  if (kp < 5) return { label: "Active", color: "#a3e635", g: "G0" };
  if (kp < 6) return { label: "Minor storm", color: "#fbbf24", g: "G1" };
  if (kp < 7) return { label: "Moderate storm", color: "#fb923c", g: "G2" };
  if (kp < 8) return { label: "Strong storm", color: "#f87171", g: "G3" };
  if (kp < 9) return { label: "Severe storm", color: "#ef4444", g: "G4" };
  return { label: "Extreme storm", color: "#dc2626", g: "G5" };
}

async function ingest(env) {
  const [kp, plasma, mag] = await Promise.all([getJSON(F.kp), getJSON(F.plasma), getJSON(F.mag)]);
  const stmts = [];
  let kpN = 0, windN = 0;
  if (Array.isArray(kp)) for (const r of kp) if (r && r.time_tag && r.Kp != null) { stmts.push(env.DB.prepare("INSERT OR IGNORE INTO kp_index (ts, kp, a_running) VALUES (?,?,?)").bind(r.time_tag, Number(r.Kp), r.a_running ?? null)); kpN++; }
  const bzByMin = {};
  if (Array.isArray(mag)) for (const row of mag.slice(1)) { const bz = parseFloat(row[3]); if (!isNaN(bz)) bzByMin[row[0]] = bz; }
  if (Array.isArray(plasma)) { const rows = plasma.slice(1).filter((_, i) => i % 60 === 0); for (const row of rows) { const ts = row[0], density = parseFloat(row[1]), speed = parseFloat(row[2]); if (!ts) continue; stmts.push(env.DB.prepare("INSERT OR IGNORE INTO solar_wind (ts, speed, density, bz) VALUES (?,?,?,?)").bind(ts, isNaN(speed) ? null : speed, isNaN(density) ? null : density, bzByMin[ts] ?? null)); windN++; } }
  if (stmts.length) await env.DB.batch(stmts);
  await env.DB.prepare("INSERT INTO ingest_log (at, kp_rows, wind_rows) VALUES (?,?,?)").bind(new Date().toISOString(), kpN, windN).run();
  return { ok: true, ingested: { kp: kpN, wind: windN } };
}

async function dashboardData(env) {
  const [kp, kpF, plasma, mag, xray, scales, sunspot, stats] = await Promise.all([
    getJSON(F.kp), getJSON(F.kpForecast), getJSON(F.plasma), getJSON(F.mag), getJSON(F.xray), getJSON(F.scales), getJSON(F.sunspot),
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM kp_index) kp_n, (SELECT COUNT(*) FROM solar_wind) wind_n, (SELECT at FROM ingest_log ORDER BY id DESC LIMIT 1) last").first().catch(() => null),
  ]);
  // Kp history (objects) + forecast (split observed/predicted)
  const kpHist = Array.isArray(kp) ? kp.filter((r) => r.Kp != null).map((r) => ({ ts: r.time_tag, kp: Number(r.Kp) })) : [];
  const kpFc = Array.isArray(kpF) ? kpF.filter((r) => r.observed === "predicted").map((r) => ({ ts: r.time_tag, kp: Number(r.kp) })) : [];
  // Solar wind speed + Bz series (hourly-ish)
  const wind = Array.isArray(plasma) ? plasma.slice(1).filter((_, i) => i % 20 === 0).map((r) => ({ ts: r[0], speed: parseFloat(r[2]) })) : [];
  const bzSeries = Array.isArray(mag) ? mag.slice(1).filter((_, i) => i % 20 === 0).map((r) => ({ ts: r[0], bz: parseFloat(r[3]) })) : [];
  // X-ray long band (0.1-0.8nm) flux series
  const xl = Array.isArray(xray) ? xray.filter((r) => r.energy === "0.1-0.8nm").map((r) => ({ ts: r.time_tag, flux: r.flux })) : [];
  const xrayDS = xl.filter((_, i) => i % 6 === 0);
  // current values
  const latestKp = kpHist.length ? kpHist[kpHist.length - 1].kp : null;
  const latestSpeed = wind.length ? wind[wind.length - 1].speed : null;
  const latestBz = bzSeries.length ? bzSeries[bzSeries.length - 1].bz : null;
  const latestFlux = xl.length ? xl[xl.length - 1].flux : null;
  // NOAA scales: current + forecast days
  let cur = null, fc = [];
  if (scales && typeof scales === "object") {
    cur = scales["0"] || scales["-1"] || null;
    for (const k of ["1", "2", "3"]) if (scales[k]) fc.push(scales[k]);
  }
  const ss = Array.isArray(sunspot) ? sunspot.filter((r) => r.ssn != null).slice(-120).map((r) => ({ t: r["time-tag"], ssn: r.ssn, f: r["f10.7"] })) : [];
  return { kpHist, kpFc, wind, bzSeries, xrayDS, latestKp, latestSpeed, latestBz, latestFlux, cur, fc, ss, stats };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(ingest(env)); },
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/ingest") return json(await ingest(env));
      if (url.pathname === "/api/data") return json(await dashboardData(env));
      if (url.pathname === "/" || url.pathname === "") return html(render(await dashboardData(env)));
      return new Response("Not found", { status: 404 });
    } catch (err) { return new Response("Error: " + (err && err.message), { status: 500 }); }
  },
};

function scaleCard(label, sObj, key, sub) {
  const s = sObj && sObj[key] ? sObj[key] : null;
  const lvl = s ? Number(s.Scale ?? 0) : 0;
  const txt = s ? (s.Text || (key + lvl)) : "none";
  const colors = ["#34d399", "#fbbf24", "#fb923c", "#f87171", "#ef4444", "#dc2626"];
  const c = colors[Math.min(lvl, 5)];
  return `<div class="card"><div class="k">${label}</div><div class="v"><span class="pill"><span class="pdot" style="background:${c}"></span>${key}${lvl}</span></div><div class="k" style="margin-top:6px">${escapeHtml(txt)}</div><div class="k" style="opacity:.6">${sub}</div></div>`;
}

function render(d) {
  const st = kpStatus(d.latestKp);
  const last = d.stats && d.stats.last ? new Date(d.stats.last).toUTCString().replace("GMT", "UTC") : "—";
  const payload = JSON.stringify({ kpHist: d.kpHist, kpFc: d.kpFc, wind: d.wind, bz: d.bzSeries, xray: d.xrayDS, ss: d.ss });
  const fcStrip = d.fc.map((day, i) => {
    const g = day.G || {}; const lvl = Number(g.Scale ?? 0);
    const colors = ["#34d399", "#fbbf24", "#fb923c", "#f87171", "#ef4444", "#dc2626"];
    return `<div class="fcd"><div class="k">Day ${i + 1}</div><div class="fg" style="color:${colors[Math.min(lvl,5)]}">G${lvl}</div><div class="k">${escapeHtml((g.Text||"quiet").split(" ")[0])}</div></div>`;
  }).join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Space Weather — live operations dashboard</title>
<meta name="description" content="A live space-weather operations console: NOAA storm scales, 3-day forecast, geomagnetic Kp, solar wind + IMF Bz, X-ray flares, and solar-cycle context — ingested on a schedule into Cloudflare D1.">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root{--bg:#0a0e17;--panel:#121826;--line:#1f2937;--ink:#e7ecf3;--muted:#8b96a8;--accent:#6cb6ff;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:1100px;margin:0 auto;padding:30px 20px 56px}
  h1{font-size:clamp(24px,4vw,36px);margin:0 0 4px;letter-spacing:-.02em}
  .sub{color:var(--muted);margin:0;font-size:14.5px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:22px 0}
  @media(max-width:820px){.grid{grid-template-columns:repeat(2,1fr)}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:16px}
  .card .k{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
  .card .v{font-size:26px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:19px;font-weight:700}
  .pdot{width:12px;height:12px;border-radius:50%}
  .fcstrip{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}
  .fcd{flex:1;min-width:90px;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px;text-align:center}
  .fcd .fg{font-size:22px;font-weight:800;margin:4px 0}
  .panels{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:820px){.panels{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px;margin-top:16px}
  .panel h2{margin:0 0 2px;font-size:15.5px}.panel p{margin:0 0 12px;color:var(--muted);font-size:12.5px}
  canvas{max-height:230px}
  .sec{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:26px 0 10px}
  footer{margin-top:30px;color:var(--muted);font-size:12px;font-family:ui-monospace,Menlo,monospace;display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<div class="wrap">
  <h1>Space Weather <span style="font-size:14px;color:var(--muted);font-weight:400">· live operations console</span></h1>
  <p class="sub">Six NOAA feeds, ingested on a schedule into Cloudflare D1 and rendered live — official storm scales, a 3-day forecast, and the drivers behind them.</p>

  <div class="sec">Current conditions</div>
  <div class="grid">
    <div class="card"><div class="k">Geomagnetic (now)</div><div class="v"><span class="pill"><span class="pdot" style="background:${st.color}"></span>${st.label}</span></div><div class="k" style="margin-top:6px">Kp ${d.latestKp != null ? d.latestKp.toFixed(2) : "—"} · ${st.g}</div></div>
    ${scaleCard("Radio blackout", d.cur, "R", "solar flares")}
    ${scaleCard("Radiation storm", d.cur, "S", "solar protons")}
    <div class="card"><div class="k">Solar wind</div><div class="v">${d.latestSpeed != null ? Math.round(d.latestSpeed) : "—"}<span style="font-size:13px;color:var(--muted)"> km/s</span></div><div class="k" style="margin-top:6px">IMF Bz ${d.latestBz != null ? d.latestBz.toFixed(1) + " nT" : "—"} · X-ray ${flareClass(d.latestFlux)}</div></div>
  </div>

  <div class="sec">NOAA 3-day geomagnetic forecast</div>
  <div class="fcstrip">${fcStrip || '<div class="fcd"><div class="k">forecast unavailable</div></div>'}</div>

  <div class="panels">
    <div class="panel"><h2>Planetary Kp — observed + forecast</h2><p>Geomagnetic disturbance (0 calm → 9 extreme). Dashed bars are NOAA's forecast.</p><canvas id="kpChart"></canvas></div>
    <div class="panel"><h2>Solar wind speed &amp; IMF Bz</h2><p>A southward (negative) Bz with fast wind is what drives storms.</p><canvas id="windChart"></canvas></div>
    <div class="panel"><h2>X-ray flux — flare activity</h2><p>GOES 0.1–0.8 nm flux (log). Crossing C/M/X marks flare strength.</p><canvas id="xrayChart"></canvas></div>
    <div class="panel"><h2>Solar cycle — sunspot number &amp; F10.7</h2><p>Where we are in the ~11-year cycle; more sunspots, more space weather.</p><canvas id="ssChart"></canvas></div>
  </div>

  <footer>
    <span>Pipeline: ${d.stats ? d.stats.kp_n : 0} Kp + ${d.stats ? d.stats.wind_n : 0} wind rows in D1 · last ingest ${last}</span>
    <span>6 feeds from <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener">NOAA SWPC</a> · built by Ashutosh Tiwari · <a href="/api/data">JSON</a></span>
  </footer>
</div>
<script>
  const D=${payload};
  const grid={color:"rgba(148,163,184,.1)"}, ticks={color:"#8b96a8",maxTicksLimit:7,font:{size:9}};
  const fmt=(t)=>{const d=new Date(String(t).replace(" ","T")+(String(t).includes("Z")?"":"Z"));return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit"});};
  const kpCol=(v)=>v<5?"#34d399":v<6?"#fbbf24":v<7?"#fb923c":"#ef4444";
  if(D.kpHist.length){
    const labels=D.kpHist.map(r=>fmt(r.ts)).concat(D.kpFc.map(r=>fmt(r.ts)));
    const obs=D.kpHist.map(r=>r.kp).concat(D.kpFc.map(()=>null));
    const fc=D.kpHist.map(()=>null).concat(D.kpFc.map(r=>r.kp));
    new Chart(kpChart,{type:"bar",data:{labels,datasets:[
      {label:"observed",data:obs,backgroundColor:D.kpHist.map(r=>kpCol(r.kp)).concat(D.kpFc.map(()=>"#0000")),borderRadius:2},
      {label:"forecast",data:fc,backgroundColor:"rgba(108,182,255,.45)",borderColor:"#6cb6ff",borderWidth:1,borderRadius:2}]},
      options:{plugins:{legend:{display:false}},scales:{x:{stacked:true,grid,ticks},y:{stacked:true,grid,ticks,beginAtZero:true,max:9}}}});
  }
  if(D.wind.length){
    new Chart(windChart,{data:{labels:D.wind.map(r=>fmt(r.ts)),datasets:[
      {type:"line",label:"speed",data:D.wind.map(r=>r.speed),borderColor:"#6cb6ff",backgroundColor:"rgba(108,182,255,.1)",fill:true,tension:.3,pointRadius:0,borderWidth:2,yAxisID:"y"},
      {type:"line",label:"Bz",data:D.bz.map(r=>r.bz),borderColor:"#f59e0b",pointRadius:0,borderWidth:1.5,yAxisID:"y1"}]},
      options:{plugins:{legend:{display:true,labels:{color:"#8b96a8",boxWidth:12,font:{size:10}}}},scales:{x:{grid,ticks},y:{position:"left",grid,ticks,title:{display:true,text:"km/s",color:"#8b96a8"}},y1:{position:"right",grid:{display:false},ticks:{color:"#f59e0b"},title:{display:true,text:"Bz nT",color:"#f59e0b"}}}}});
  }
  if(D.xray.length){
    new Chart(xrayChart,{type:"line",data:{labels:D.xray.map(r=>fmt(r.ts)),datasets:[{data:D.xray.map(r=>r.flux),borderColor:"#a78bfa",backgroundColor:"rgba(167,139,250,.1)",fill:true,tension:.3,pointRadius:0,borderWidth:2}]},
      options:{plugins:{legend:{display:false}},scales:{x:{grid,ticks},y:{type:"logarithmic",grid,ticks:{color:"#8b96a8",font:{size:9},callback:(v)=>({1e-4:"X",1e-5:"M",1e-6:"C",1e-7:"B"}[v]||"")}}}}});
  }
  if(D.ss.length){
    new Chart(ssChart,{data:{labels:D.ss.map(r=>r.t),datasets:[
      {type:"line",label:"sunspots",data:D.ss.map(r=>r.ssn),borderColor:"#fbbf24",pointRadius:0,borderWidth:2,tension:.3,yAxisID:"y"},
      {type:"line",label:"F10.7",data:D.ss.map(r=>r.f),borderColor:"#34d399",pointRadius:0,borderWidth:1.5,tension:.3,yAxisID:"y1"}]},
      options:{plugins:{legend:{display:true,labels:{color:"#8b96a8",boxWidth:12,font:{size:10}}}},scales:{x:{grid,ticks:{...ticks,maxTicksLimit:6}},y:{position:"left",grid,ticks},y1:{position:"right",grid:{display:false},ticks:{color:"#34d399"}}}}});
  }
</script>
</body></html>`;
}

function escapeHtml(s){ return String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function json(o){ return new Response(JSON.stringify(o,null,2),{headers:{"content-type":"application/json","cache-control":"no-store"}}); }
function html(b){ return new Response(b,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"public, max-age=180"}}); }
