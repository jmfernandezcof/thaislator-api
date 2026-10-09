import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import morgan from "morgan";
import fs from "fs";
import crypto from "crypto";
import { execFile } from "child_process";
import { createInviteStore } from "./lib/invite-store.js";

const PORT = process.env.PORT || 3010;
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("ANTHROPIC_API_KEY missing"); process.exit(1); }

const anthropic = new Anthropic({ apiKey: KEY });
const MODEL = "claude-haiku-4-5";
const TYPHOON_KEY = process.env.TYPHOON_API_KEY || "";
const TYPHOON_URL = "https://api.opentyphoon.ai/v1/chat/completions";
const TYPHOON_MODEL = "typhoon-v2.5-30b-a3b-instruct";

const app = express();
app.disable("x-powered-by"); // no filtrar el stack (Express) en cabeceras
app.use(express.json({ limit: "6mb", strict: true }));
app.set('trust proxy', 1); // detras de Traefik
app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
morgan.token('anon-ip', (req) => {
  // eurthai ya va tras Cloudflare y el router solo acepta tráfico de CF (middleware cloudflare-ips),
  // así que CF-Connecting-IP la pone CF (IP real del visitante, no falsificable: el acceso directo
  // al origen está bloqueado). Fallback a req.ip. Se anonimiza a /24 (IPv4) o /48 (IPv6).
  const ip = (req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '-').toString();
  if (ip.includes(':') && !ip.includes('.')) return ip.split(':').slice(0, 3).join(':') + '::'; // IPv6 -> /48
  return ip.replace(/^(\d+\.\d+\.\d+)\.\d+$/, '$1.0').replace(/^(::ffff:\d+\.\d+\.\d+)\.\d+$/, '$1.0');
});
// Log de acceso PERSISTENTE (volumen /data/logs) + stdout. Sobrevive a rebuilds.
const LOG_DIR = "/data/logs";
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
const _accessLog = fs.createWriteStream(LOG_DIR + "/access.log", { flags: "a" });
const _tee = { write: (s) => { process.stdout.write(s); _accessLog.write(s); } };
morgan.token('safe-path', req => (req.originalUrl || req.url || '/').split('?')[0]);
app.use(morgan(':anon-ip - [:date[iso]] ":method :safe-path HTTP/:http-version" :status :res[content-length] ":user-agent" :response-time ms', { stream: _tee }));


// --- Rate-limit por IP real (ventana deslizante en memoria) ---
// Protege los endpoints de pago de bucles/scripts sin molestar a un humano.
const _rl = new Map();
// IP REAL del cliente para el rate-limit. eurthai ya va tras Cloudflare (proxied) y el router solo
// acepta tráfico de CF (middleware cloudflare-ips@file), así que CF-Connecting-IP la pone Cloudflare
// y NO es falsificable: un acceso directo al origen (donde se podria spoofear la cabecera) queda
// bloqueado por el allowlist. Usamos CF-Connecting-IP y NO req.ip, porque tras CF req.ip seria la IP
// del edge (pocas) y meteria a todos los usuarios en el mismo cubo de rate-limit.
function clientIp(req){ return (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString().trim() || 'unknown'; }
function rateLimit(maxPerMin){
  return (req, res, next) => {
    const key = clientIp(req) + ' ' + req.path;
    const now = Date.now();
    const arr = (_rl.get(key) || []).filter(t => now - t < 60000);
    if (arr.length >= maxPerMin) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'too many requests' }); }
    arr.push(now); _rl.set(key, arr); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, a] of _rl) if (!a.some(t => now - t < 60000)) _rl.delete(k); }, 300000).unref();

// --- Guard for AI endpoints: invitación individual (o x-arti-token para tests locales) ---
const API_TOKEN = process.env.ARTI_API_TOKEN || '';
if (!API_TOKEN) console.warn('ARTI_API_TOKEN not set');
const INVITE_DAILY_CREDITS = parseInt(process.env.INVITE_DAILY_CREDITS || "30", 10) || 30;
const GLOBAL_DAILY_CREDITS = parseInt(process.env.GLOBAL_DAILY_CREDITS || "250", 10) || 250;
const inviteStore = createInviteStore(LOG_DIR + "/invites.json", {
  defaultDailyCredits: INVITE_DAILY_CREDITS,
  globalDailyCredits: GLOBAL_DAILY_CREDITS
});

// Solo invitaciones individuales; el token administrativo queda para pruebas locales.
async function guardAI(req, res, next) {
  if (API_TOKEN && req.get('x-arti-token') === API_TOKEN) { req.aiAccess = { type: 'admin' }; return next(); }
  const inviteToken = req.get("x-arti-invite") || "";
  let invite;
  try { invite = inviteStore.status(inviteToken); }
  catch (error) {
    console.error("[invites] ledger unavailable");
    return res.status(503).json({ error: "access service temporarily unavailable" });
  }
  if (invite.ok) { req.aiAccess = { type: 'invite', token: inviteToken, status: invite }; return next(); }
  return res.status(403).json({ error: 'invite required' });
}

// --- Circuit-breaker de gasto diario (seguro de vida del saldo prepago) ---
// Tope DURO de llamadas a endpoints de IA por dia natural (UTC). Aunque fallen Turnstile
// y el rate-limit, esto frena un denial-of-wallet: superado el tope -> 503 hasta el dia siguiente.
// Cuenta SOLO peticiones que llaman de verdad al modelo (ver bumpSpend), no las que fallan
// validacion: si no, un atacante agotaria el cupo con requests vacias de coste cero.
// parseInt puede dar NaN si DAILY_AI_CAP esta mal puesto; NaN desactivaria el tope en silencio
// (count >= NaN siempre false), asi que validamos y caemos a 3000 con aviso.
const _capRaw = parseInt(process.env.DAILY_AI_CAP || '3000', 10);
const DAILY_AI_CAP = (Number.isFinite(_capRaw) && _capRaw > 0) ? _capRaw : 3000;
if (!Number.isFinite(_capRaw) || _capRaw <= 0) console.warn(`[spend] DAILY_AI_CAP invalido (${process.env.DAILY_AI_CAP}) — usando ${DAILY_AI_CAP}`);
let _spend = { day: '', count: 0 };
function _spendRollover() {
  const day = new Date().toISOString().slice(0, 10);
  if (_spend.day !== day) _spend = { day, count: 0 };
}
// spendGuard SOLO comprueba el tope (no incrementa). El gasto se contabiliza con bumpSpend(),
// que cada handler llama TRAS validar el body y justo antes de llamar al modelo de pago.
function spendGuard(req, res, next) {
  _spendRollover();
  if (_spend.count >= DAILY_AI_CAP) {
    res.set('Retry-After', '3600');
    return res.status(503).json({ error: 'service temporarily unavailable' });
  }
  next();
}
function bumpSpend() {
  _spendRollover();
  _spend.count++;
  // un solo aviso al cruzar el tope (no en cada request bloqueada -> evita spam de logs)
  if (_spend.count === DAILY_AI_CAP) console.warn(`[spend] tope diario ${DAILY_AI_CAP} alcanzado (${_spend.day}) — la IA devolvera 503 hasta manana (UTC)`);
}

const TOOL_COST = { translate: 1, verify: 1, image: 3, menu: 3, vision: 8 };
function chargeAI(req, res, tool) {
  const cost = TOOL_COST[tool] || 1;
  try {
    if (req.aiAccess?.type === "invite") {
      const charged = inviteStore.charge(req.aiAccess.token, cost, tool);
      if (!charged.ok) {
        res.set("Retry-After", charged.reason === "global_quota" ? "3600" : "86400");
        res.status(429).json({ error: "quota exhausted", reason: charged.reason, remaining: charged.remaining || 0 });
        return false;
      }
      res.set("X-ArtI-Credits-Remaining", String(charged.remaining));
    } else {
      const charged = inviteStore.chargeGlobal(cost);
      if (!charged.ok) { res.set("Retry-After", "3600"); res.status(429).json({ error: "quota exhausted", reason: charged.reason }); return false; }
    }
    bumpSpend();
    return true;
  } catch (error) {
    console.error("[invites] ledger unavailable");
    res.status(503).json({ error: "access service temporarily unavailable" });
    return false;
  }
}

app.get("/health", (_q, r) => r.json({ ok: true, service: "eur-thai" }));
app.post("/invite/status", rateLimit(30), (req, res) => {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Vary", "x-arti-invite");
  let result;
  try { result = inviteStore.status(req.get("x-arti-invite") || ""); }
  catch (error) {
    console.error("[invites] ledger unavailable");
    return res.status(503).json({ error: "access service temporarily unavailable" });
  }
  if (!result.ok) return res.status(403).json({ error: "invalid invite", reason: result.reason });
  res.json(result);
});


// --- TTS de servidor (fallback de voz) ---
// El traductor usa Web Speech del dispositivo cuando hay voz; los navegadores in-app
// (WebView de WhatsApp/Line/FB, caso Arty) no la tienen -> aquí generamos el audio.
// edge-tts (gratis, mismas voces Thai que el frasero). ESCALA por diseño:
//  - caché en disco por hash(voz+texto): cada frase única se genera UNA vez y se sirve
//    estática para siempre (a 1.000 usuarios, las frases repetidas = 0 generaciones nuevas).
//  - Cache-Control immutable -> navegador y CDN (Cloudflare, con Cache Rule) la cachean.
//  - generación desacoplada de la entrega: cambiar de motor no toca caché ni frontend.
const TTS_DIR = "/data/tts";
try { fs.mkdirSync(TTS_DIR, { recursive: true }); } catch (e) {}
const TTS_VOICES = {
  th: { m: "th-TH-NiwatNeural",  f: "th-TH-PremwadeeNeural" },
  es: { m: "es-ES-AlvaroNeural", f: "es-ES-ElviraNeural" },
  en: { m: "en-US-GuyNeural",    f: "en-US-JennyNeural" }
};
const _ttsInflight = new Map(); // dedupe de generaciones idénticas concurrentes
const TTS_MAX_FILES = Math.max(100, parseInt(process.env.TTS_MAX_FILES || "5000", 10) || 5000);
const TTS_DAILY_GENERATIONS = Math.max(10, parseInt(process.env.TTS_DAILY_GENERATIONS || "250", 10) || 250);
let _ttsGenerations = { day: "", count: 0 };
function reserveTTSGeneration() {
  const day = new Date().toISOString().slice(0, 10);
  if (_ttsGenerations.day !== day) _ttsGenerations = { day, count: 0 };
  if (_ttsGenerations.count >= TTS_DAILY_GENERATIONS) throw new Error("tts generation cap");
  const files = fs.readdirSync(TTS_DIR).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name));
  if (files.length >= TTS_MAX_FILES) throw new Error("tts storage cap");
  _ttsGenerations.count += 1;
}
function edgeTTS(voice, text, outPath) {
  return new Promise((resolve, reject) => {
    execFile("edge-tts", ["--voice", voice, "--text", text, "--write-media", outPath],
      { timeout: 15000 }, (err) => err ? reject(err) : resolve());
  });
}
async function ensureTTS(voice, text, key, file) {
  if (fs.existsSync(file)) return true;
  if (!_ttsInflight.has(key)) {
    reserveTTSGeneration();
    const tmp = file + ".tmp" + process.pid;
    _ttsInflight.set(key, edgeTTS(voice, text, tmp)
      .then(() => fs.renameSync(tmp, file))
      .catch((error) => { try { fs.unlinkSync(tmp); } catch (_) {} throw error; })
      .finally(() => _ttsInflight.delete(key)));
  }
  await _ttsInflight.get(key);
  return false;
}

// El texto viaja en el body, nunca en la URL. El audio conserva cache por hash.
app.post("/tts", rateLimit(60), async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const lang = (req.body?.lang || "th").toString();
  const g = ((req.body?.g || "m").toString() === "f") ? "f" : "m";
  if (!text) return res.status(400).json({ error: "text required" });
  if (text.length > 1000) return res.status(400).json({ error: "too long" });
  const voices = TTS_VOICES[lang];
  if (!voices) return res.status(400).json({ error: "invalid lang" });
  const voice = voices[g];
  const key = crypto.createHash("sha256").update(voice + "|" + text).digest("hex");
  const file = TTS_DIR + "/" + key + ".mp3";
  try {
    const hit = await ensureTTS(voice, text, key, file);
    console.log(`[tts] ${lang}/${g} ${hit ? "HIT" : "gen"} len=${text.length} key=${key.slice(0, 8)}`);
    res.set("Cache-Control", "no-store");
    res.json({ url: `/tts/audio/${key}.mp3` });
  } catch (error) {
    console.warn(`[tts] FAIL ${lang}/${g} len=${text.length}`);
    res.status(502).json({ error: "tts failed" });
  }
});

app.get("/tts/audio/:file", rateLimit(120), (req, res) => {
  const match = /^([a-f0-9]{64})\.mp3$/.exec(req.params.file || "");
  if (!match) return res.status(404).end();
  const file = `${TTS_DIR}/${match[1]}.mp3`;
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(file).pipe(res);
});

let rateCache = { rates: null, fetchedAt: 0, date: null };
const RATE_TTL = 3600000;

async function fetchRate() {
  const r = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=THB,USD,GBP");
  if (!r.ok) throw new Error("frankfurter " + r.status);
  const j = await r.json();
  if (!j?.rates?.THB) throw new Error("no THB");
  return { rates: { EUR: 1, ...j.rates }, date: j.date };
}

app.get("/rate", async (_q, res) => {
  const now = Date.now();
  if (rateCache.rates && now - rateCache.fetchedAt < RATE_TTL) {
    return res.json({ rates: rateCache.rates, rate: rateCache.rates.THB, fetchedAt: rateCache.fetchedAt, date: rateCache.date, source: "cache" });
  }
  try {
    const { rates, date } = await fetchRate();
    rateCache = { rates, fetchedAt: now, date };
    res.json({ rates, rate: rates.THB, fetchedAt: now, date, source: "live" });
  } catch (e) {
    if (rateCache.rates) return res.json({ rates: rateCache.rates, rate: rateCache.rates.THB, fetchedAt: rateCache.fetchedAt, date: rateCache.date, source: "stale", error: String(e) });
    res.status(502).json({ error: "rate unavailable" });
  }
});

// --- Clima TMD (Thai Meteorological Department) ---
// Endpoint GRATUITO (como /rate): sin guardAI/spendGuard, solo rate-limit suave.
// Cache por coordenada redondeada (~11 km) con TTL 30 min + fallback a stale si la API falla,
// para respetar el rate-limit de TMD (60 req/min) y dar respuesta aunque TMD esté caído.
const TMD_TOKEN = (process.env.TMD_API_TOKEN || "").trim();
if (!TMD_TOKEN) console.warn("TMD_API_TOKEN not set — /weather devolverá 503");
const TMD_BASE = "https://data.tmd.go.th/nwpapi/v1";
const WEATHER_TTL = 1800000; // 30 min
const _weatherCache = new Map(); // key "lat,lon" -> { data, fetchedAt }

// Tailandia aprox: lat 5.5–20.5, lon 97–106. Fuera de eso TMD no tiene datos.
function inThailand(lat, lon) {
  return lat >= 5 && lat <= 21 && lon >= 96 && lon <= 106;
}

async function fetchWeather(lat, lon) {
  const url = new URL(TMD_BASE + "/forecast/location/hourly/at");
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  url.searchParams.set("fields", "tc,rh,rain,cond,ws10m");
  url.searchParams.set("hours", "1");
  const r = await fetch(url, { headers: { accept: "application/json", authorization: "Bearer " + TMD_TOKEN } });
  if (!r.ok) throw new Error("tmd http " + r.status);
  const j = await r.json();
  const fc = j?.WeatherForecasts?.[0]?.forecasts?.[0];
  if (!fc?.data) throw new Error("tmd empty");
  const d = fc.data;
  const loc = j.WeatherForecasts[0].location || {};
  return {
    cond: Math.round(Number(d.cond ?? 0)),
    tc: Math.round(Number(d.tc ?? 0) * 10) / 10,
    rh: Math.round(Number(d.rh ?? 0)),
    rain: Math.round(Number(d.rain ?? 0) * 10) / 10,
    ws10m: Math.round(Number(d.ws10m ?? 0) * 10) / 10,
    time: fc.time || null,
    location: { lat: loc.lat ?? Number(lat), lon: loc.lon ?? Number(lon) }
  };
}

app.get("/weather", rateLimit(20), async (req, res) => {
  if (!TMD_TOKEN) return res.status(503).json({ error: "weather unavailable" });
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inThailand(lat, lon)) {
    return res.status(400).json({ error: "lat/lon required (within Thailand)" });
  }
  // Redondeo a 1 decimal (~11 km) para compartir cache entre peticiones cercanas.
  const rLat = Math.round(lat * 10) / 10;
  const rLon = Math.round(lon * 10) / 10;
  const key = rLat + "," + rLon;
  const now = Date.now();
  const cached = _weatherCache.get(key);
  if (cached && now - cached.fetchedAt < WEATHER_TTL) {
    return res.json({ ...cached.data, fetchedAt: cached.fetchedAt, source: "cache" });
  }
  try {
    const data = await fetchWeather(rLat, rLon);
    _weatherCache.set(key, { data, fetchedAt: now });
    res.json({ ...data, fetchedAt: now, source: "live" });
  } catch (e) {
    if (cached) return res.json({ ...cached.data, fetchedAt: cached.fetchedAt, source: "stale", error: String(e) });
    res.status(502).json({ error: "weather unavailable" });
  }
});

// --- Typhoon translation helper ---
async function typhoonTranslate(text, toLang, timeoutMs) {
  const dir = toLang === "th" ? "Thai" : toLang === "es" ? "Spanish" : "English";
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
  const r = await fetch(TYPHOON_URL, {
    method: "POST",
    signal: ctrl.signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TYPHOON_KEY },
    body: JSON.stringify({ model: TYPHOON_MODEL,
      messages: [
        { role: "system", content: "Translate the following text into " + dir + ". Translate EXACTLY what is written: do not add, remove, expand or interpret any concept. Keep allergy, medical and food terms precise and literal. Allergen vocabulary reference - use an entry ONLY if that allergen is explicitly mentioned in the source text, NEVER include items not present in the source: peanut=\u0e16\u0e31\u0e48\u0e27\u0e25\u0e34\u0e2a\u0e07, shellfish=\u0e2a\u0e31\u0e15\u0e27\u0e4c\u0e19\u0e49\u0e33\u0e21\u0e35\u0e40\u0e1b\u0e25\u0e37\u0e2d\u0e01, shrimp=\u0e01\u0e38\u0e49\u0e07, milk/dairy=\u0e19\u0e21, egg=\u0e44\u0e02\u0e48, fish=\u0e1b\u0e25\u0e32, gluten=\u0e01\u0e25\u0e39\u0e40\u0e15\u0e19. Reply ONLY with the translation, nothing else." },
        { role: "user", content: text }],
      temperature: 0.1, max_tokens: 1024 })
  });
  if (!r.ok) throw new Error("typhoon http " + r.status);
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || "").trim();
  } finally { if (timer) clearTimeout(timer); }
}


async function haikuEs2En(text) {
  const m = await anthropic.messages.create({
    model: MODEL, max_tokens: 512,
    system: [{ type: "text", text: "Translate the Spanish text to English. Translate exactly, add nothing. Reply ONLY with the translation." }],
    messages: [{ role: "user", content: text }]
  });
  return (m.content?.[0]?.type === "text" ? m.content[0].text : "").trim();
}

// Fallback de traducción cuando Typhoon tarda o falla. Constante (~1-2s).
async function haikuTranslate(text, toLang) {
  const dir = toLang === "th" ? "Thai" : toLang === "es" ? "Spanish" : "English";
  const m = await anthropic.messages.create({
    model: MODEL, max_tokens: 512,
    system: [{ type: "text", text: "Translate the text into " + dir + ". Translate EXACTLY what is written: add, remove or interpret nothing. Keep allergy, medical and food terms precise and literal. Reply ONLY with the translation, nothing else." }],
    messages: [{ role: "user", content: text }]
  });
  return (m.content?.[0]?.type === "text" ? m.content[0].text : "").trim();
}

const SYS = `Two independent tasks about a translation pair (one side Thai). Reply ONLY JSON: {"transliteration":"...","backTranslation":"...","match":true}. transliteration=RTGS romanization of the Thai side. backTranslation: translate the TRANSLATION text back to the original language reading ONLY the translation, completely ignoring the original (blind check). match: compare your backTranslation with the original; false if meaning differs, words are nonsensical/invented, or anything was added/omitted (be strict: allergies, medical, numbers, food); true only if faithful. No extras.`;

app.post("/translate", rateLimit(30), guardAI, spendGuard, async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const from = (req.body?.from || "es").toString();
  const to = (req.body?.to || "th").toString();
  if (!text) return res.status(400).json({ error: "text required" });
  if (text.length > 2000) return res.status(400).json({ error: "too long" });
  const V = ["es","en","th"];
  if (!V.includes(from) || !V.includes(to) || from === to)
    return res.status(400).json({ error: "invalid from/to" });
  if (!TYPHOON_KEY)
    return res.status(503).json({ error: "typhoon key missing" });
  if (!chargeAI(req, res, "translate")) return;
  try {
    const t0 = Date.now();
    const srcText = (from === "es" && to === "th") ? await haikuEs2En(text) : text;
    const t1 = Date.now();
    let target, via = "typhoon";
    try {
      target = await typhoonTranslate(srcText, to, 2500);
    } catch (e) {
      via = "haiku";
      target = await haikuTranslate(srcText, to);
    }
    const t2 = Date.now();
    console.log(`[translate] ${from}->${to} bridge=${t1-t0}ms tr=${t2-t1}ms via=${via} total=${t2-t0}ms len=${text.length}`);
    res.json({ target, from, to });
  } catch (e) {
    res.status(502).json({ error: "translate failed" });
  }
});

// Fase 2 (UX progresiva): verificación ciega — translit RTGS + back-translation + match.
// Endpoint aparte para NO bloquear el mostrado/voz del resultado en /translate.
app.post("/verify", rateLimit(30), guardAI, spendGuard, async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  const target = (req.body?.target || "").toString().trim();
  const from = (req.body?.from || "es").toString();
  if (!text || !target) return res.status(400).json({ error: "text and target required" });
  if (text.length > 2000 || target.length > 2000) return res.status(400).json({ error: "too long" });
  if (!["es", "en", "th"].includes(from)) return res.status(400).json({ error: "invalid from" });
  const backLang = from === "es" ? "Spanish" : from === "en" ? "English" : "Thai";
  if (!chargeAI(req, res, "verify")) return;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL, max_tokens: 512,
      system: [{ type: "text", text: SYS }],
      messages: [{ role: "user", content:
        "Original ("+from+"): "+text+"\nTranslation: "+target+
        "\nBack-translate to: "+backLang }]
    });
    const raw = msg.content?.[0]?.type === "text" ? msg.content[0].text : "";
    const clean = raw.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
    let extra = { transliteration: "", backTranslation: "", match: false };
    try { extra = { match: false, ...JSON.parse(clean) }; } catch {}
    res.json({ ...extra, usage: msg.usage });
  } catch (e) {
    res.status(502).json({ error: "verify failed" });
  }
});

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
function validBase64Image(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return false;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.byteLength(value, "base64") <= MAX_IMAGE_BYTES;
}

const SYS_IMG = `Eres un asistente de traduccion para un viajero. Recibes una foto de un cartel/menu/letrero y un par {from, to} con idiomas (es o th). Pasos: 1) extrae el texto principal visible (ignora marcas/logos/decoraciones). 2) detecta su idioma. 3) traduce al idioma destino indicado. Responde SOLO JSON valido sin markdown con esta forma exacta: {"detectedText":"...","detectedLang":"es|th|other","target":"...","transliteration":"...","backTranslation":"..."}. Reglas: si detectedLang=th la transliteration es romanizacion RTGS del detectedText; si target en thai la transliteration cubre el target; si no hay nada thai, transliteration="". backTranslation: del target al idioma de detectedText. Sin texto fuera del JSON.`;

app.post("/translate-image", rateLimit(30), guardAI, spendGuard, async (req, res) => {
  const image = req.body?.image;
  const from = (req.body?.from || "th").toString();
  const to = (req.body?.to || "es").toString();
  if (!validBase64Image(image)) return res.status(400).json({ error: "valid image required" });
  if (!["es","th","auto"].includes(from) || !["es","th"].includes(to)) return res.status(400).json({ error: "invalid from/to" });
  if (!chargeAI(req, res, "image")) return;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SYS_IMG, cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: JSON.stringify({ from, to }) }
        ]
      }]
    });
    const raw = msg.content?.[0]?.type === "text" ? msg.content[0].text : "";
    const clean = raw.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return res.status(502).json({ error: "bad model output" }); }
    res.json({ ...parsed, from, to, usage: msg.usage });
  } catch (e) {
    res.status(502).json({ error: "translate-image failed" });
  }
});

const SYS_MENU = `Eres un asistente para un viajero leyendo un menu/carta de restaurante en Tailandia. Recibes una foto del menu. Para cada plato visible:
1) original: texto exacto del nombre del plato en el idioma de la foto (thai si esta en thai, ingles si esta en ingles).
2) translation: traduccion natural al idioma destino (indicado en el mensaje del usuario).
3) transliteration: si original esta en thai, romanizacion RTGS. Si no, "".
4) protein: una de: chicken, pork, beef, duck, fish, shellfish, seafood, egg, tofu, vegetable, mixed, unknown.
5) allergens: array con cualquiera de: spicy, peanut, shellfish, dairy, gluten, egg, fish, soy, pork, sesame, coconut. Si dudas, incluye.
6) spiceLevel: 0 (no pica), 1 (suave), 2 (medio), 3 (muy picante). 0 si no aplica.
7) vegan: boolean. true solo si seguro sin carne, pescado, huevo, lacteo, salsa de pescado.
8) vegetarian: boolean. true si sin carne ni pescado (puede tener huevo/lacteo).
9) price: si aparece visible en la foto (con baht/THB/฿), extrae numero. Si no, null.
10) warnings: string corto en el idioma destino con avisos relevantes (ej. "muy picante, contiene salsa de pescado"). "" si nada relevante.

Reglas:
- Platos thai tipicos: tom yum (picante, mariscos), pad thai (cacahuete, huevo), som tum (picante, cacahuete, salsa pescado), green curry (coco, picante), massaman (cacahuete, coco), pad krapow (picante, salsa pescado), khao soi (coco, gluten), satay (cacahuete).
- Salsa de pescado (nam pla) es omnipresente: marca pescado como alergeno y no-vegano salvo que el plato sea claramente vegetariano.
- Si el menu no es legible o no hay platos, devuelve dishes: [] y notes con explicacion.

Responde SOLO JSON valido sin markdown:
{"dishes":[{"original":"...","translation":"...","transliteration":"...","protein":"...","allergens":[...],"spiceLevel":0,"vegan":false,"vegetarian":false,"price":null,"warnings":"..."}],"notes":"..."}
Sin texto fuera del JSON.`;

const MENU_LANGS = {es:'español',en:'English',fr:'français',de:'Deutsch',it:'italiano'};

app.post("/menu", rateLimit(15), guardAI, spendGuard, async (req, res) => {
  const image = req.body?.image;
  if (!validBase64Image(image)) return res.status(400).json({ error: "valid image required" });
  const target = (req.body?.target || 'es').toString().toLowerCase();
  const targetName = MENU_LANGS[target];
  if (!targetName) return res.status(400).json({ error: 'invalid target, valid: '+Object.keys(MENU_LANGS).join(',') });
  if (!chargeAI(req, res, "menu")) return;
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: "text", text: SYS_MENU, cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: `Extrae los platos del menu de esta foto. Idioma destino: ${targetName}` }
        ]
      }]
    });
    const raw = msg.content?.[0]?.type === "text" ? msg.content[0].text : "";
    const clean = raw.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return res.status(502).json({ error: "bad model output" }); }
    if (!Array.isArray(parsed?.dishes)) return res.status(502).json({ error: "bad model output" });
    res.json({ ...parsed, target, usage: msg.usage });
  } catch (e) {
    res.status(502).json({ error: "menu failed" });
  }
});

// ===== ArtI Sign Translator: /vision (Vision OCR + Haiku + LaMa) =====
import { PNG } from "pngjs";

const VISION_KEY = process.env.GOOGLE_VISION_API_KEY || "";
const REPL_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const LAMA_MODEL = "twn39/lama";
let lamaVer = null;
const THAI_RE = /[\u0E00-\u0E7F]/;

async function visionOCR(b64) {
  const body = { requests: [{ image: { content: b64 },
    features: [{ type: "TEXT_DETECTION" }] }] };
  const r = await fetch(
    "https://vision.googleapis.com/v1/images:annotate?key=" + VISION_KEY,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) });
  if (!r.ok) throw new Error("vision http " + r.status);
  const resp = (await r.json()).responses?.[0] || {};
  if (resp.error) throw new Error("vision: " + resp.error.message);
  return resp;
}

function thaiBlocks(resp) {
  const page = resp.fullTextAnnotation?.pages?.[0];
  if (!page) return { blocks: [], width: 0, height: 0 };
  const blocks = [];
  for (const b of page.blocks || []) for (const p of b.paragraphs || []) {
    const text = (p.words || []).map(w =>
      (w.symbols || []).map(s => s.text).join("")).join(" ").trim();
    if (!text || !THAI_RE.test(text)) continue;
    const vs = p.boundingBox?.vertices || [];
    if (!vs.length) continue;
    const xs = vs.map(v => v.x || 0), ys = vs.map(v => v.y || 0);
    const x = Math.min(...xs), y = Math.min(...ys);
    blocks.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y,
      original: text });
  }
  return { blocks, width: page.width || 0, height: page.height || 0 };
}

function buildMask(width, height, blocks, pad = 8) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0; png.data[i+1] = 0; png.data[i+2] = 0; png.data[i+3] = 255;
  }
  for (const b of blocks) {
    const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad);
    const x1 = Math.min(width - 1, b.x + b.w + pad);
    const y1 = Math.min(height - 1, b.y + b.h + pad);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (width * y + x) << 2;
      png.data[i] = 255; png.data[i+1] = 255; png.data[i+2] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

async function lamaInpaint(imgB64, maskB64) {
  if (!lamaVer) {
    const r = await fetch("https://api.replicate.com/v1/models/" + LAMA_MODEL,
      { headers: { Authorization: "Bearer " + REPL_TOKEN } });
    if (!r.ok) throw new Error("replicate model http " + r.status);
    lamaVer = (await r.json()).latest_version?.id;
    if (!lamaVer) throw new Error("no lama version");
  }
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: "Bearer " + REPL_TOKEN,
      "Content-Type": "application/json", Prefer: "wait=60" },
    body: JSON.stringify({ version: lamaVer, input: {
      image: "data:image/jpeg;base64," + imgB64,
      mask: "data:image/png;base64," + maskB64 } })
  });
  if (!r.ok) throw new Error("replicate http " + r.status);
  let pred = await r.json();
  let tries = 0;
  while (["starting","processing"].includes(pred.status) && tries < 25) {
    await new Promise(s => setTimeout(s, 2000)); tries++;
    const pr = await fetch(pred.urls.get,
      { headers: { Authorization: "Bearer " + REPL_TOKEN } });
    pred = await pr.json();
  }
  if (pred.status !== "succeeded")
    throw new Error("lama " + pred.status + ": " + (pred.error || "timeout"));
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  const img = await fetch(out);
  if (!img.ok) throw new Error("fetch output http " + img.status);
  const buf = Buffer.from(await img.arrayBuffer());
  const mime = img.headers.get("content-type") || "image/png";
  return "data:" + mime + ";base64," + buf.toString("base64");
}

const SYS_SIGN = `Eres traductor de carteles tailandeses para viajeros. Recibes un array JSON de textos thai de OCR de un cartel. Devuelve SOLO JSON valido sin markdown: {"translations":["..."]} con la traduccion natural y concisa de cada texto al idioma destino, mismo orden y longitud que la entrada. Si un elemento es ruido OCR, devuelve "" en su posicion. Sin texto fuera del JSON.`;

async function translateBlocks(texts, target) {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 2048,
    system: [{ type: "text", text: SYS_SIGN }],
    messages: [{ role: "user", content: "Idioma destino: " +
      (target === "es" ? "español" : "English") +
      "\nTextos: " + JSON.stringify(texts) }]
  });
  const raw = msg.content?.[0]?.type === "text" ? msg.content[0].text : "";
  const clean = raw.replace(/^\s*```(?:json)?\s*/i,"")
    .replace(/\s*```\s*$/,"").trim();
  try {
    const t = JSON.parse(clean).translations;
    return { tr: Array.isArray(t) ? t : [], usage: msg.usage };
  } catch { return { tr: [], usage: msg.usage }; }
}

app.post("/vision", rateLimit(15), guardAI, spendGuard, async (req, res) => {
  const image = req.body?.image;
  if (!validBase64Image(image))
    return res.status(400).json({ error: "valid image required" });
  const target = (req.body?.target || "es").toString().toLowerCase();
  if (!["es","en"].includes(target))
    return res.status(400).json({ error: "invalid target, valid: es,en" });
  if (!VISION_KEY || !REPL_TOKEN)
    return res.status(503).json({ error: "vision/replicate keys missing" });
  if (!chargeAI(req, res, "vision")) return;
  try {
    const ocr = await visionOCR(image);
    const { blocks, width, height } = thaiBlocks(ocr);
    if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 16000000)
      return res.status(422).json({ error: "unsupported image dimensions" });
    if (!blocks.length)
      return res.json({ blocks: [], cleaned_image: null, width, height,
        notes: "no thai text found" });
    const [trRes, cleaned] = await Promise.all([
      translateBlocks(blocks.map(b => b.original), target),
      lamaInpaint(image, buildMask(width, height, blocks))
    ]);
    res.json({
      width, height, target,
      cleaned_image: cleaned,
      blocks: blocks.map((b, i) => ({
        box: { x: b.x, y: b.y, w: b.w, h: b.h },
        original: b.original,
        translation: trRes.tr[i] || ""
      })),
      usage: trRes.usage
    });
  } catch (e) {
    res.status(502).json({ error: "vision failed" });
  }
});


app.use((_req, res) => res.status(404).json({ error: "not found" }));
app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") return res.status(413).json({ error: "payload too large" });
  if (error instanceof SyntaxError) return res.status(400).json({ error: "invalid json" });
  console.error("[server] unhandled request error");
  res.status(500).json({ error: "internal error" });
});

const server = app.listen(PORT, () => console.log("eur-thai backend on :" + PORT));
server.headersTimeout = 15000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 5000;
