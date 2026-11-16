// Precios de metales para el Flash de Planta (v2 · 16-nov-26)
// Lee LBMA (Au AM, Au PM, Ag) desde la pagina oficial y COMEX (Yahoo GC=F / SI=F),
// guarda el JSON crudo (evidencia) y los precios en Supabase. La clave robot llega por GitHub Secrets.
// Termina en ROJO (GitHub manda correo) si: no se pudo leer, falta el precio del ultimo dia habil,
// o LBMA y COMEX difieren mas de 2 %.
const { chromium } = require('playwright');

const URL_SB = process.env.SUPABASE_URL;
const ANON   = process.env.SUPABASE_ANON_KEY;
const CLAVE  = process.env.FLASH_CLAVE_ROBOT;
const PAGINA = 'https://www.lbma.org.uk/prices-and-data/lbma-precious-metal-prices';
const ARCHIVOS = ['gold_am', 'gold_pm', 'silver'];
const MAX_DIF_AU = 0.02;       // 2 % LBMA vs COMEX en oro (lo normal es < 1.2 %)
const MAX_DIF_AG = 0.04;       // 4 % en plata (lo normal llega a ~2.3 %: otra hora y mercado mas volatil)
const MAX_DIAS_SIN_PRECIO = 4; // fin de semana + un festivo de Londres
const num = v => (v === null || v === undefined || Number(v) === 0 || isNaN(Number(v))) ? null : Number(v);
const espera = ms => new Promise(r => setTimeout(r, ms));

// 1) Esperar al dato real (no segundos fijos) y reintentar
async function leerLBMAunaVez() {
  const b = await chromium.launch();
  try {
    const p = await b.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' });
    const llegoJson = p.waitForResponse(r => r.url().includes('/json/') && r.status() === 200, { timeout: 45000 }).catch(() => null);
    await p.goto(PAGINA, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const r0 = await llegoJson;                       // la propia pagina ya cargo su JSON: el acceso esta listo
    if (!r0) await p.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    const r = await p.evaluate(async (archivos) => {
      const out = {};
      for (const n of archivos) {
        const x = await fetch('https://prices.lbma.org.uk/json/limited/' + n + '.json', { cache: 'no-store' });
        let j = null; try { j = await x.json(); } catch (e) {}
        out[n] = (x.ok && Array.isArray(j)) ? j : { error: x.status };
      }
      return out;
    }, ARCHIVOS);
    for (const k of ARCHIVOS) if (!Array.isArray(r[k]) || !r[k].length) throw new Error('LBMA ' + k + ' sin datos (' + JSON.stringify(r[k]) + ')');
    return r;
  } finally { await b.close(); }
}
async function leerLBMA() {
  let ultimoError;
  for (let intento = 1; intento <= 3; intento++) {
    try { return await leerLBMAunaVez(); }
    catch (e) { ultimoError = e; console.log('Intento ' + intento + ' de LBMA fallo: ' + e.message); if (intento < 3) await espera(intento * 20000); }
  }
  throw new Error('No se pudo leer la LBMA despues de 3 intentos: ' + ultimoError.message);
}

async function leerComex(sym) {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1mo&interval=1d';
      const x = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!x.ok) throw new Error('respuesta ' + x.status);
      const j = await x.json(); const res = j.chart.result[0];
      const t = res.timestamp || [], c = res.indicators.quote[0].close || [];
      // La vela diaria marca la medianoche de Nueva York: +12 h cae siempre en el dia correcto. Se omite hoy.
      const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
      const m = {};
      t.forEach((s, i) => {
        if (c[i] == null) return;
        const d = new Date((s + 12 * 3600) * 1000).toISOString().slice(0, 10);
        if (d < hoy) m[d] = Math.round(c[i] * 1000) / 1000;
      });
      return { mapa: m, crudo: j };
    } catch (e) { console.log('COMEX ' + sym + ' intento ' + intento + ': ' + e.message); if (intento < 2) await espera(10000); }
  }
  return { mapa: {}, crudo: null };
}

async function rpc(nombre, cuerpo) {
  const x = await fetch(URL_SB + '/rest/v1/rpc/' + nombre, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  const t = await x.text();
  if (!x.ok) throw new Error(nombre + ': Supabase respondio ' + x.status + ': ' + t.slice(0, 200));
  return t;
}

(async () => {
  if (!URL_SB || !ANON || !CLAVE) throw new Error('Faltan datos: revisa el Secret FLASH_CLAVE_ROBOT');
  const alertas = [];

  const l = await leerLBMA();
  const gc = await leerComex('GC=F'), si = await leerComex('SI=F');
  if (!Object.keys(gc.mapa).length || !Object.keys(si.mapa).length) alertas.push('COMEX (Yahoo) no respondio; solo se guardo LBMA.');

  // 2) Guardar el JSON crudo tal cual llego (evidencia)
  await rpc('flash_precios_crudo_guardar', { p_clave: CLAVE, p_fuente: 'lbma', p_datos: l });
  if (gc.crudo || si.crudo) await rpc('flash_precios_crudo_guardar', { p_clave: CLAVE, p_fuente: 'comex', p_datos: { 'GC=F': gc.crudo, 'SI=F': si.crudo } });

  // Precios por dia
  const filas = {};
  const fila = d => (filas[d] = filas[d] || { fecha: d });
  for (const r of l.gold_am) fila(r.d).au_am  = num(r.v && r.v[0]);
  for (const r of l.gold_pm) fila(r.d).au_pm  = num(r.v && r.v[0]);
  for (const r of l.silver)  fila(r.d).ag_lbma = num(r.v && r.v[0]);
  for (const d in gc.mapa) fila(d).au_comex = gc.mapa[d];
  for (const d in si.mapa) fila(d).ag_comex = si.mapa[d];
  const lista = Object.values(filas).sort((a, b) => a.fecha < b.fecha ? -1 : 1);
  const t = await rpc('flash_precios_guardar', { p_clave: CLAVE, p_filas: lista });
  console.log('LBMA: ' + l.gold_pm.length + ' dias · COMEX: ' + Object.keys(gc.mapa).length + ' dias');
  console.log('Guardados ' + t + ' dias, del ' + lista[0].fecha + ' al ' + lista[lista.length - 1].fecha);

  // 3) Alertas
  const conLbma = lista.filter(f => f.au_am != null || f.au_pm != null || f.ag_lbma != null);
  const ult = conLbma[conLbma.length - 1];
  const dias = ult ? Math.floor((Date.now() - Date.parse(ult.fecha + 'T00:00:00Z')) / 86400000) : 999;
  if (!ult || dias > MAX_DIAS_SIN_PRECIO) alertas.push('El ultimo precio LBMA es del ' + (ult ? ult.fecha : '—') + ' (' + dias + ' dias). Revisa si la LBMA dejo de publicar o cambio algo.');
  if (ult && (ult.au_am == null && ult.au_pm == null)) alertas.push('El ' + ult.fecha + ' no trae precio de oro (AM ni PM).');
  if (ult && ult.ag_lbma == null) alertas.push('El ' + ult.fecha + ' no trae precio de plata.');
  // Solo el dia mas reciente que tenga LBMA y COMEX (para no repetir la misma alerta toda la semana)
  const auF = f => f.au_am != null && f.au_pm != null ? (f.au_am + f.au_pm) / 2 : (f.au_pm != null ? f.au_pm : f.au_am);
  const fAu = [...lista].reverse().find(f => auF(f) != null && f.au_comex != null);
  if (fAu && Math.abs(fAu.au_comex - auF(fAu)) / auF(fAu) > MAX_DIF_AU)
    alertas.push('Au ' + fAu.fecha + ': LBMA ' + auF(fAu).toFixed(3) + ' vs COMEX ' + fAu.au_comex + ' (difieren mas de 2 %).');
  const fAg = [...lista].reverse().find(f => f.ag_lbma != null && f.ag_comex != null);
  if (fAg && Math.abs(fAg.ag_comex - fAg.ag_lbma) / fAg.ag_lbma > MAX_DIF_AG)
    alertas.push('Ag ' + fAg.fecha + ': LBMA ' + fAg.ag_lbma + ' vs COMEX ' + fAg.ag_comex + ' (difieren mas de 4 %).');
  console.log('Ultimo: ' + JSON.stringify(lista[lista.length - 1]));
  if (alertas.length) {
    console.error('ALERTAS:\n- ' + alertas.join('\n- '));
    process.exit(1);
  }
  console.log('Sin alertas.');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
