// Precios de metales para el Flash de Planta (16-nov-26)
// Lee LBMA (Au AM, Au PM, Ag) desde la pagina oficial y COMEX (Yahoo GC=F / SI=F),
// y los guarda en Supabase con flash_precios_guardar. La clave robot llega por GitHub Secrets.
const { chromium } = require('playwright');

const URL_SB = process.env.SUPABASE_URL;
const ANON   = process.env.SUPABASE_ANON_KEY;
const CLAVE  = process.env.FLASH_CLAVE_ROBOT;
const num = v => (v === null || v === undefined || Number(v) === 0 || isNaN(Number(v))) ? null : Number(v);

async function leerLBMA() {
  const b = await chromium.launch();
  const p = await b.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
  await p.goto('https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(5000);
  const r = await p.evaluate(async () => {
    const out = {};
    for (const n of ['gold_am', 'gold_pm', 'silver']) {
      const x = await fetch('https://prices.lbma.org.uk/json/limited/' + n + '.json');
      out[n] = x.ok ? await x.json() : { error: x.status };
    }
    return out;
  });
  await b.close();
  return r;
}

async function leerComex(sym) {
  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1mo&interval=1d';
    const x = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!x.ok) { console.log('COMEX ' + sym + ': respuesta ' + x.status); return {}; }
    const j = await x.json(); const res = j.chart.result[0];
    const t = res.timestamp || [], c = res.indicators.quote[0].close || [];
    // La vela diaria marca la medianoche de Nueva York (04:00 o 05:00 UTC segun horario de verano).
    // Se suman 12 h para caer siempre en el dia correcto, sin depender del gmtoffset actual.
    // Se omite el dia de hoy: su "cierre" todavia se esta moviendo.
    const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const m = {};
    t.forEach((s, i) => {
      if (c[i] == null) return;
      const d = new Date((s + 12 * 3600) * 1000).toISOString().slice(0, 10);
      if (d >= hoy) return;
      m[d] = Math.round(c[i] * 1000) / 1000;
    });
    return m;
  } catch (e) { console.log('COMEX ' + sym + ': ' + e.message); return {}; }
}

(async () => {
  if (!URL_SB || !ANON || !CLAVE) throw new Error('Faltan datos: revisa el Secret FLASH_CLAVE_ROBOT');
  const l = await leerLBMA();
  for (const k of ['gold_am', 'gold_pm', 'silver'])
    if (!Array.isArray(l[k])) throw new Error('LBMA ' + k + ' no respondio (' + JSON.stringify(l[k]) + ')');
  const [gc, si] = [await leerComex('GC=F'), await leerComex('SI=F')];

  const filas = {};
  const fila = d => (filas[d] = filas[d] || { fecha: d });
  for (const r of l.gold_am) fila(r.d).au_am  = num(r.v && r.v[0]);
  for (const r of l.gold_pm) fila(r.d).au_pm  = num(r.v && r.v[0]);
  for (const r of l.silver)  fila(r.d).ag_lbma = num(r.v && r.v[0]);
  for (const d in gc) fila(d).au_comex = gc[d];
  for (const d in si) fila(d).ag_comex = si[d];
  const lista = Object.values(filas).sort((a, b) => a.fecha < b.fecha ? -1 : 1);

  const x = await fetch(URL_SB + '/rest/v1/rpc/flash_precios_guardar', {
    method: 'POST',
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_clave: CLAVE, p_filas: lista })
  });
  const t = await x.text();
  if (!x.ok) throw new Error('Supabase respondio ' + x.status + ': ' + t.slice(0, 200));
  const u = lista[lista.length - 1];
  console.log('LBMA: ' + l.gold_pm.length + ' dias · COMEX: ' + Object.keys(gc).length + ' dias');
  console.log('Guardados ' + t + ' dias, del ' + lista[0].fecha + ' al ' + u.fecha);
  console.log('Ultimo: ' + JSON.stringify(u));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
