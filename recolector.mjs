// Recolector del Panel de Clips.
// Lee los datos públicos de TikTok e Instagram con Microsoft Edge (sin ventana) y guarda sitio/datos.json.
// Después sube el sitio a GitHub Pages. No usa Claude ni inteligencia artificial.
//
// Uso:  node recolector.mjs              (rápido; completo si es la primera pasada de la hora)
//       node recolector.mjs --completo   (fuerza la pasada completa)
//       node recolector.mjs --sin-publicar
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
const SITIO = process.env.GITHUB_ACTIONS ? DIR : path.join(DIR, "sitio");
const DATOS = path.join(SITIO, "datos.json");
const LOG = path.join(DIR, "recolector.log");
const LOCK = path.join(DIR, ".recolector.lock");
const args = new Set(process.argv.slice(2));
const AHORA = new Date();
const COMPLETO = args.has("--completo") || AHORA.getMinutes() < 15;
const PUBLICAR = !process.env.GITHUB_ACTIONS && CFG.publicar !== false && !args.has("--sin-publicar");
const AHORA_MIN = Math.floor(AHORA.getTime() / 60000);
const AHORA_ISO = AHORA.toISOString();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(...a) {
  const line = new Date().toISOString() + " " + a.join(" ");
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + "\n");
    if (fs.statSync(LOG).size > 2_000_000) fs.writeFileSync(LOG, fs.readFileSync(LOG, "utf8").slice(-500_000));
  } catch {}
}
const pad = n => String(n).padStart(2, "0");
const isoDia = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
function numero(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^([\d.,]+)\s*([KkMm]?)$/);
  if (!m) return null;
  if (m[2]) return Math.round(Number(m[1].replace(",", ".")) * (m[2].toLowerCase() === "k" ? 1e3 : 1e6));
  return Number(m[1].replace(/[.,]/g, ""));
}
function limpiarTitulo(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(Number(x)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&;/g, "'")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ").replace(/\s+([!?.,…])/g, "$1").trim().slice(0, 100) || "Clip sin título";
}

// ---------- Evitar dos ejecuciones a la vez ----------
try {
  if (Date.now() - fs.statSync(LOCK).mtimeMs < 12 * 60000) { log("Otra pasada sigue en curso; salgo."); process.exit(0); }
} catch {}
fs.writeFileSync(LOCK, String(process.pid));
const soltar = () => { try { fs.unlinkSync(LOCK); } catch {} };

// ---------- Edge por el protocolo de DevTools ----------
async function abrirEdge() {
  const perfil = process.env.GITHUB_ACTIONS ? path.join(process.env.RUNNER_TEMP || DIR, "perfil-panel") : path.join(DIR, CFG.perfil || "perfil-navegador");
  const port = CFG.puerto || 9333;
  const proc = spawn(process.env.CHROME_PATH || CFG.edge, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${perfil}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    ...(process.env.GITHUB_ACTIONS ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    "--window-size=1280,900", "about:blank"
  ], { stdio: "ignore", windowsHide: true });
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(500); }
  }
  if (!ver) throw new Error("El navegador no respondió");
  const tgt = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("No se pudo conectar con Edge")); });
  let id = 0; const pend = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setUserAgentOverride", { userAgent: String(ver["User-Agent"] || "").replace("HeadlessChrome", "Chrome"), acceptLanguage: "es-ES,es;q=0.9" });
  return {
    async ir(url, espera = 3500) { await send("Page.navigate", { url }); await sleep(espera); },
    async js(code, timeout = 240000) {
      const r = await send("Runtime.evaluate", { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true, timeout });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async cerrar() {
      try { ws.close(); } catch {}
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      } else { try { proc.kill("SIGTERM"); } catch {} }
    }
  };
}

// ---------- Código que corre dentro de cada página ----------
const jsTikTok = (user, ids) => `
const IDS=${JSON.stringify(ids)};
window.scrollTo(0,document.body.scrollHeight); await new Promise(r=>setTimeout(r,2500));
const grab=(h,k)=>{const m=h.match(new RegExp('"'+k+'":"?(\\\\d+)'));return m?Number(m[1]):null};
const gstr=(h,k)=>{const m=h.match(new RegExp('"'+k+'":"((?:[^"\\\\\\\\]|\\\\\\\\.)*)"'));try{return m?JSON.parse('"'+m[1]+'"'):null}catch(e){return null}};
const prof=await (await fetch('/@${user}',{credentials:'include'})).text();
const profile={followers:grab(prof,'followerCount'),hearts:grab(prof,'heartCount'),videos:grab(prof,'videoCount')};
const fresh=[...new Set([...document.querySelectorAll('a[href*="/video/"]')].map(a=>a.href.match(/video\\/(\\d+)/)?.[1]).filter(Boolean)),...[...prof.matchAll(/"id":"(77\\d{16,18})"/g)].map(m=>m[1])];
const ids=[...new Set([...fresh,...IDS])]; const out=[], missing=[];
for(const id of ids){ try{ const h=await (await fetch('/@${user}/video/'+id,{credentials:'include'})).text(); const play=grab(h,'playCount'); if(play==null){ if(IDS.includes(id)) missing.push(id); continue; } out.push({id,play,like:grab(h,'diggCount'),com:grab(h,'commentCount'),share:grab(h,'shareCount'),save:grab(h,'collectCount'),desc:(gstr(h,'desc')||'').slice(0,160)}); }catch(e){} await new Promise(r=>setTimeout(r,300)); }
return {profile, videos:out, missing};`;

const jsInstagram = (user, meta, known) => `
const META=${meta}, KNOWN_IG=${JSON.stringify(known)};
await new Promise(r=>setTimeout(r,2500));
for(let i=0;i<6;i++){ window.scrollTo(0,document.body.scrollHeight); await new Promise(r=>setTimeout(r,1300)); }
const header=document.querySelector('header')?.innerText||document.body.innerText; const fm=header.match(/([\\d.,]+\\s*[KkMm]?)\\s*seguidores/);
const gv={}; for(const a of document.querySelectorAll('a')){ const m=(a.getAttribute('href')||'').match(/\\/reel\\/([^/]+)/); if(m){ const t=a.innerText.replace(/\\s+/g,''); if(/^[\\d.,]+[KkMm]?$/.test(t)) gv[m[1]]=t; } }
const need=Object.keys(gv).concat(KNOWN_IG).filter((c,i,a)=>a.indexOf(c)===i).filter(c=>META||!KNOWN_IG.includes(c));
const meta={}, missing=[];
for(const c of need){ try{ const h=await (await fetch('/${user}/reel/'+c+'/',{credentials:'omit'})).text(); const m=h.match(/<meta (?:name="description"|property="og:description") content="([^"]*)"/); const d=m?m[1].replace(/&quot;/g,'"').replace(/&#x([0-9a-f]+);/gi,(s,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\\d+);/g,(s,x)=>String.fromCodePoint(Number(x))).replace(/&amp;/g,'&'):''; const lm=d.match(/^([\\d.,]+[KkMm]?) likes?, ([\\d.,]+[KkMm]?) comments?/); if(!lm){ if(KNOWN_IG.includes(c)) missing.push(c); continue; } const dm=d.match(/el (\\w+ \\d+, \\d{4}):/); meta[c]={likes:lm[1],comments:lm[2],date:dm?.[1],caption:(d.split(': "')[1]||'').split('\\n')[0].slice(0,140)}; }catch(e){} await new Promise(r=>setTimeout(r,300)); }
return {followers:fm?.[1]||null, views:gv, meta, missing};`;

// ---------- Datos ----------
function cargarDatos() {
  try { return JSON.parse(fs.readFileSync(DATOS, "utf8")); }
  catch { return { config: { cuentas: [] }, clips: [], historial: [], snaps: [], serie: { pts: [] } }; }
}
const UMBRALES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

async function main() {
  const D = cargarDatos();
  D.config ||= {}; D.clips ||= []; D.historial ||= []; D.snaps ||= []; D.serie ||= { pts: [] };
  const cfgAntes = { ...D.config };
  const novedades = [];
  const tocados = new Set();
  const corto = t => (t.length > 40 ? t.slice(0, 38) + "…" : t);
  const hitosViews = (c, antes, despues) => {
    if (antes == null || despues == null) return;
    c.hitos ||= [];
    for (const u of UMBRALES) if (antes < u && despues >= u && !c.hitos.includes(u)) { c.hitos.push(u); novedades.push(`${corto(c.titulo)} pasó las ${u.toLocaleString("es")} views`); }
    if (despues - antes >= 50) novedades.push(`${corto(c.titulo)} está en racha: +${despues - antes} views`);
  };
  let okTT = false, okIG = false;
  const edge = await abrirEdge();
  try {
    // --- TikTok ---
    try {
      const user = CFG.tiktok;
      const hace7 = new Date(AHORA); hace7.setDate(hace7.getDate() - 7);
      const ids = D.clips.filter(c => c.tiktokId && (COMPLETO || c.fecha >= isoDia(hace7))).map(c => c.tiktokId);
      await edge.ir(`https://www.tiktok.com/@${user}`);
      const r = await edge.js(jsTikTok(user, ids));
      if (r.profile.followers != null && r.videos.length) {
        okTT = true;
        D.config.tiktokSeguidores = r.profile.followers;
        if (r.profile.hearts != null) D.config.tiktokMeGusta = r.profile.hearts;
        for (const v of r.videos) {
          let c = D.clips.find(x => x.tiktokId === v.id);
          if (!c) {
            const d = new Date(Number(BigInt(v.id) >> 32n) * 1000);
            c = { id: "tt-" + v.id, titulo: limpiarTitulo(v.desc), plataforma: "tiktok", cuenta: "@" + user, fecha: isoDia(d), views: v.play,
              likes: v.like, comentarios: v.com, compartidos: v.share, guardados: v.save, seguidores: null, ganancia: 0,
              notas: `tiktok.com/@${user}/video/${v.id}`, ejemplo: false, tiktokId: v.id, actualizado: AHORA_ISO, creado: Date.now(), hitos: [] };
            for (const u of UMBRALES) if (v.play >= u) c.hitos.push(u);
            D.clips.push(c); novedades.push(`Nuevo clip detectado: ${corto(c.titulo)}`);
          } else {
            const antes = c.views;
            if (v.play !== antes) { c.viewsAnterior = antes; hitosViews(c, antes, v.play); }
            Object.assign(c, { views: v.play, likes: v.like, comentarios: v.com, compartidos: v.share, guardados: v.save, actualizado: AHORA_ISO, fallos: 0, noDisponible: false });
          }
          tocados.add(c.id);
        }
        for (const id of r.missing) {
          const c = D.clips.find(x => x.tiktokId === id); if (!c) continue;
          c.fallos = (c.fallos || 0) + 1; if (c.fallos >= 3) c.noDisponible = true;
        }
        log(`TikTok: ${r.videos.length} videos, ${r.profile.followers} seguidores`);
      } else log("TikTok: sin datos (posible bloqueo o página distinta)");
    } catch (e) { log("TikTok falló:", e.message); }

    // --- Instagram ---
    try {
      const user = CFG.instagram;
      const known = D.clips.filter(c => c.igCode).map(c => c.igCode);
      await edge.ir(`https://www.instagram.com/${user}/reels/`);
      const r = await edge.js(jsInstagram(user, COMPLETO, known));
      const seg = numero(r.followers);
      if (seg != null) {
        okIG = true;
        D.config.igSeguidores = seg;
        const codes = [...new Set([...Object.keys(r.views), ...Object.keys(r.meta)])];
        for (const code of codes) {
          const vv = numero(r.views[code]); const m = r.meta[code];
          let c = D.clips.find(x => x.igCode === code);
          if (!c) {
            if (!m) continue;
            const fd = m.date ? new Date(m.date) : AHORA;
            c = { id: "ig-" + code, titulo: limpiarTitulo(m.caption), plataforma: "instagram", cuenta: "@" + user, fecha: isoDia(isNaN(fd) ? AHORA : fd),
              views: vv, likes: numero(m.likes), comentarios: numero(m.comments), seguidores: null, ganancia: 0,
              notas: `instagram.com/${user}/reel/${code}`, ejemplo: false, igCode: code, actualizado: AHORA_ISO, creado: Date.now(), hitos: [] };
            for (const u of UMBRALES) if ((vv || 0) >= u) c.hitos.push(u);
            D.clips.push(c); novedades.push(`Nuevo reel detectado: ${corto(c.titulo)}`);
          } else {
            if (vv != null && vv !== c.views) { if (c.views != null) { c.viewsAnterior = c.views; hitosViews(c, c.views, vv); } c.views = vv; }
            if (m) { c.likes = numero(m.likes); c.comentarios = numero(m.comments); }
            c.actualizado = AHORA_ISO; c.fallos = 0; c.noDisponible = false;
          }
          tocados.add(c.id);
        }
        for (const code of r.missing) {
          const c = D.clips.find(x => x.igCode === code); if (!c) continue;
          c.fallos = (c.fallos || 0) + 1; if (c.fallos >= 3) c.noDisponible = true;
        }
        log(`Instagram: ${Object.keys(r.views).length} reels con views, ${seg} seguidores`);
      } else log("Instagram: sin datos (¿se cerró la sesión? ejecuta iniciar-sesion-instagram.cmd)");
    } catch (e) { log("Instagram falló:", e.message); }
  } finally { await edge.cerrar(); }

  if (!okTT && !okIG) { log("Ninguna red respondió; no publico nada."); return; }

  // --- Seguidores: hitos ---
  for (const [k, red] of [["tiktokSeguidores", "TikTok"], ["igSeguidores", "Instagram"]]) {
    const a = cfgAntes[k], b = D.config[k];
    if (a != null && b != null && Math.floor(b / 25) > Math.floor(a / 25)) novedades.push(`Llegaste a ${Math.floor(b / 25) * 25} seguidores en ${red}`);
  }
  // --- Historial de cada clip (pasada completa) ---
  if (COMPLETO) {
    for (const c of D.clips) {
      if (!tocados.has(c.id) || c.views == null) continue;
      let s = D.snaps.find(x => x.id === c.id);
      if (!s) { s = { id: c.id, pts: [] }; D.snaps.push(s); }
      const last = s.pts[s.pts.length - 1];
      if (!last || last.v !== c.views) s.pts.push({ t: AHORA_MIN, v: c.views });
      if (s.pts.length > 300) s.pts = s.pts.slice(-300);
    }
  }
  // --- Serie de seguidores ---
  const tv = D.clips.filter(c => c.plataforma === "tiktok" && !c.noDisponible).reduce((a, c) => a + (Number(c.views) || 0), 0);
  D.serie.pts.push({ t: AHORA_MIN, tt: okTT ? D.config.tiktokSeguidores : null, ig: okIG ? D.config.igSeguidores : null, tv: okTT ? tv : null });
  if (D.serie.pts.length > 700) D.serie.pts = D.serie.pts.slice(-700);
  // --- Historial diario ---
  const hoy = isoDia(AHORA);
  let h = D.historial.find(x => x.fecha === hoy);
  if (!h) { h = { fecha: hoy, tiktokSeguidoresInicio: cfgAntes.tiktokSeguidores ?? D.config.tiktokSeguidores, igSeguidoresInicio: cfgAntes.igSeguidores ?? D.config.igSeguidores }; D.historial.push(h); }
  Object.assign(h, { tiktokSeguidores: D.config.tiktokSeguidores, igSeguidores: D.config.igSeguidores, tiktokViews: tv });
  // --- Config y novedades ---
  D.config.ultimaSync = AHORA_ISO;
  if (novedades.length) D.config.novedades = [...novedades.map(texto => ({ t: AHORA_ISO, texto })), ...(D.config.novedades || [])].slice(0, 15);

  fs.writeFileSync(DATOS, JSON.stringify(D));
  log(`Guardado (${COMPLETO ? "completo" : "rápido"}): ${D.clips.length} clips${novedades.length ? " · novedades: " + novedades.join(" | ") : ""}`);
  if (PUBLICAR) publicar();
}

function publicar() {
  const git = (...a) => execFileSync("git", a, { cwd: SITIO, stdio: "pipe", windowsHide: true }).toString().trim();
  try {
    try { git("rev-parse", "--verify", "HEAD"); } catch { log("Publicar: el sitio todavía no tiene su primer commit."); return; }
    git("add", "-A");
    // Publicación segura: nunca sobrescribir el historial remoto con force push.
    if (!git("status", "--porcelain")) { log("Publicar: no hay cambios."); return; }
    git("-c", "user.name=Panel de Clips", "-c", "user.email=panel@localhost", "commit", "-q", "-m", "Datos del panel " + AHORA_ISO);
    git("push", "-q", "origin", "HEAD:main");
    log("Publicado en GitHub Pages.");
  } catch (e) { log("Publicar falló:", (e.stderr?.toString() || e.message).trim().slice(0, 300)); }
}

main().catch(e => log("Error:", e.message)).finally(soltar);
