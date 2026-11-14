"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const stats = require("./stats");
const vm = require("vm");
const { spawn } = require("child_process");
const multer = require("multer");

const app = express();
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.SHADOW_DATA_DIR || ROOT);
fs.mkdirSync(DATA_DIR, { recursive: true });

const ENV_FILE = path.join(ROOT, ".telegram.env");
try {
  const envText = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }

    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = value;
    }
  }
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const SESSION_FILE = path.join(DATA_DIR, "appState.json");
const STATUS_FILE = path.join(DATA_DIR, "bot-status.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PANEL_STATUS_FILE = path.join(DATA_DIR, "panel-status.json");
const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 3001);
const TELEGRAM_SECRET_FILE = path.join(DATA_DIR, ".telegram-secret");
const TELEGRAM_INTERNAL_SECRET = (() => {
  try {
    const value = fs.readFileSync(TELEGRAM_SECRET_FILE, "utf8").trim();
    return /^[a-f0-9]{96}$/i.test(value) ? value : "";
  } catch (_) { return ""; }
})();
const PASSWORD = process.env.PANEL_PASSWORD;

if (!PASSWORD || PASSWORD.length < 12) {
  console.error("Set PANEL_PASSWORD to a password of at least 12 characters.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use("/shadowxdiablos", express.static(PUBLIC_DIR));
app.get("/shadowxdiablos", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function auth(req, res, next) {
  const token = (req.headers.cookie || "").split(";").map(x => x.trim())
    .find(x => x.startsWith("shadow_panel="))?.slice("shadow_panel=".length);
  const expiresAt = token ? sessions.get(token) : null;

  if (!token || !expiresAt) {
    return res.status(401).json({ error: "يلزم تسجيل الدخول" });
  }

  if (Date.now() >= expiresAt) {
    sessions.delete(token);
    res.setHeader("Set-Cookie", "shadow_panel=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
    return res.status(401).json({ error: "انتهت جلسة الدخول، سجّل الدخول مجددًا" });
  }

  next();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}


const loginFailures = new Map();
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function loginClientKey(req) {
  const remote = String(req.socket?.remoteAddress || "unknown")
    .replace(/^::ffff:/, "");
  const isLocal = ["127.0.0.1", "::1"].includes(remote);
  const forwarded = isLocal
    ? String(req.headers["cf-connecting-ip"] || "").trim()
    : "";
  return net.isIP(forwarded) ? forwarded : remote;
}

function loginRateLimit(req, res, next) {
  const now = Date.now();

  for (const [ip, state] of loginFailures) {
    if (state.windowUntil <= now && state.blockedUntil <= now) {
      loginFailures.delete(ip);
    }
  }

  const key = loginClientKey(req);
  const state = loginFailures.get(key);

  if (state && state.blockedUntil > now) {
    res.setHeader("Retry-After",
      Math.ceil((state.blockedUntil - now) / 1000));
    return res.status(429).json({
      error: "محاولات كثيرة، حاول بعد انتهاء الحظر"
    });
  }

  if (state && state.windowUntil <= now) loginFailures.delete(key);
  req.panelLoginRateKey = key;
  next();
}

function recordLoginFailure(key) {
  const now = Date.now();
  const old = loginFailures.get(key);
  const active = old && old.windowUntil > now;
  const count = active ? old.failures + 1 : 1;

  loginFailures.set(key, {
    failures: count,
    windowUntil: active ? old.windowUntil : now + LOGIN_LOCK_MS,
    blockedUntil: count >= LOGIN_MAX_FAILURES
      ? now + LOGIN_LOCK_MS : 0
  });
}

app.post("/api/login", loginRateLimit, (req, res) => {
  if (!safeEqual(req.body?.password || "", PASSWORD)) {
    recordLoginFailure(req.panelLoginRateKey);
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  loginFailures.delete(req.panelLoginRateKey);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  const secureCookie = "; Secure";
  res.setHeader("Set-Cookie", `shadow_panel=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookie}`);
  res.json({ ok: true });
});
app.post("/api/logout", auth, (req, res) => {
  const token = (req.headers.cookie || "").split(";").map(x => x.trim())
    .find(x => x.startsWith("shadow_panel="))?.slice("shadow_panel=".length);
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "shadow_panel=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/me", auth, (_req, res) => res.json({ ok: true }));

app.get("/api/dashboard", auth, (_req, res) => {
  const data = readJson(DATA_FILE, {});
  const commandsDir = path.join(ROOT, "commands");
  const commands = fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)).sort()
    : [];
  const status = readJson(STATUS_FILE, { online: false, updatedAt: null });
  const botConfig = readJson(CONFIG_FILE, {});
  const fresh = status.updatedAt && Date.now() - new Date(status.updatedAt).getTime() < 20000;
  const groups = Object.entries(data.protected || {}).map(([id, g]) => ({
    id, name: g.threadName || id, active: !!g.active,
    members: Object.keys(g.nicknames || {}).length
  }));
  res.json({
    bot: { online: !!fresh && !!status.online, startedAt: status.startedAt || null, botId: status.botId || null },
    prefix: data.prefix || "!",
    developerIds: Array.isArray(botConfig.DEV_IDS) ? botConfig.DEV_IDS : [String(botConfig.DEV_ID || "")],
    botNickname: String(botConfig.BOT_NICK || "𝚀𝚄𝙰𝚂𝙰𝚁 ⦓ ⚛️ ⦔"),
    nicknameGuardEnabled: botConfig.NICK_GUARD_ENABLED !== false,
    developerNickname: String(botConfig.DEV_NICK || "𝚂𝙷𝙰𝙳𝙾𝚆 ⦓ ⚛️ ⦔"),
    freePrefix: !!data.freePrefix,
    admins: data.admins || [],
    commands,
    groups,
    groupsUpdatedAt: data.groupsUpdatedAt || null,
    lockedCount: Object.keys(data.locked || {}).length,
    savedMessagesCount: Array.isArray(data.savedMessages) ? data.savedMessages.length : 0
  });
});

app.put("/api/settings", auth, (req, res) => {
  const data = readJson(DATA_FILE, {});
  if (typeof req.body.prefix === "string") {
    const p = req.body.prefix.trim();
    if (!p || p.length > 5) return res.status(400).json({ error: "البادئة يجب أن تكون من 1 إلى 5 أحرف" });
    data.prefix = p;
  }
  if (typeof req.body.freePrefix === "boolean") data.freePrefix = req.body.freePrefix;
  writeJsonAtomic(DATA_FILE, data);
  res.json({ ok: true });
});

app.put("/api/admins", auth, (req, res) => {
  const id = String(req.body.id || "").trim();
  const action = req.body.action;
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: "معرّف غير صالح" });
  const data = readJson(DATA_FILE, {});
  data.admins = Array.isArray(data.admins) ? data.admins : [];
  if (action === "add" && !data.admins.includes(id)) data.admins.push(id);
  else if (action === "remove") data.admins = data.admins.filter(x => String(x) !== id);
  else return res.status(400).json({ error: "إجراء غير صالح" });
  writeJsonAtomic(DATA_FILE, data);
  res.json({ ok: true });
});

app.put("/api/developer", auth, (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(x => String(x).trim()).filter(Boolean)
    : [String(req.body?.id || "").trim()].filter(Boolean);
  if (ids.length < 1 || ids.length > 2 || ids.some(id => !/^[0-9]{5,25}$/.test(id)) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "أدخل معرفاً أو معرفين صحيحين من 5 إلى 25 رقماً" });
  }
  const config = readJson(CONFIG_FILE, {});
  config.DEV_ID = ids[0];
  config.DEV_IDS = ids;
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true, message: "تم حفظ معرفات المطورين. أعد تشغيل البوت لتطبيقها." });
});
app.get("/api/sessions/:id/nickname", auth, (req, res) => {
  const id = String(req.params.id);
  if (!/^[123]$/.test(id)) return res.status(400).json({ error: "رقم الجلسة غير صالح" });

  const config = readJson(CONFIG_FILE, {});
  const session = config.SESSIONS?.[id] || {};

  res.json({
    nickname: String(session.BOT_NICK || config.BOT_NICK || "𝚀𝚄𝙰𝚂𝙰𝚁 ⦓ ⚛️ ⦔"),
    enabled: (session.NICK_GUARD_ENABLED ?? config.NICK_GUARD_ENABLED) !== false
  });
});

app.put("/api/sessions/:id/nickname", auth, (req, res) => {
  const id = String(req.params.id);
  if (!/^[123]$/.test(id)) return res.status(400).json({ error: "رقم الجلسة غير صالح" });

  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname || nickname.length > 80) {
    return res.status(400).json({ error: "الكنية مطلوبة ويجب ألا تتجاوز 80 حرفاً" });
  }
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "حالة المراقبة غير صالحة" });
  }

  const config = readJson(CONFIG_FILE, {});
  config.SESSIONS = config.SESSIONS && typeof config.SESSIONS === "object" ? config.SESSIONS : {};
  config.SESSIONS[id] = config.SESSIONS[id] && typeof config.SESSIONS[id] === "object" ? config.SESSIONS[id] : {};
  config.SESSIONS[id].BOT_NICK = nickname;
  config.SESSIONS[id].NICK_GUARD_ENABLED = req.body.enabled;
  writeJsonAtomic(CONFIG_FILE, config);

  res.json({ ok: true, message: "تم حفظ كنية الجلسة وإعدادات الاسترجاع التلقائي." });
});

app.put("/api/bot-nickname", auth, (req, res) => {
  const nickname = String(req.body?.nickname || "").trim();

  if (!nickname || nickname.length > 80) {
    return res.status(400).json({ error: "الكنية مطلوبة ويجب ألا تتجاوز 80 حرفاً" });
  }

  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "حالة المراقبة غير صالحة" });
  }

  const config = readJson(CONFIG_FILE, {});
  config.BOT_NICK = nickname;
  config.NICK_GUARD_ENABLED = req.body.enabled;

  writeJsonAtomic(CONFIG_FILE, config);

  res.json({
    ok: true,
    message: "تم حفظ الكنية وإعدادات الاسترجاع التلقائي."
  });
});

app.put("/api/developer-nickname", auth, (req, res) => {
  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname || nickname.length > 80) {
    return res.status(400).json({ error: "كنية المطور مطلوبة ويجب ألا تتجاوز 80 حرفاً" });
  }
  const config = readJson(CONFIG_FILE, {});
  config.DEV_NICK = nickname;
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true, message: "تم حفظ كنية المطور." });
});

app.put("/api/groups/:id", auth, (req, res) => {
  const data = readJson(DATA_FILE, {});
  const group = data.protected?.[req.params.id];
  if (!group) return res.status(404).json({ error: "المجموعة غير موجودة في protected" });
  if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "قيمة غير صالحة" });
  group.active = req.body.active;
  writeJsonAtomic(DATA_FILE, data);
  res.json({ ok: true });
});



function saveCookies(req, res, sessionId = "1") {
  const raw = String(req.body?.cookies || "").trim();
  if (!raw) return res.status(400).json({ error: "ألصق JSON الجلسة أولاً" });

  let appState;

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed) || parsed.length === 0 ||
        !parsed.every(x => x && typeof x === "object" &&
          typeof (x.key || x.name) === "string" &&
          typeof x.value === "string")) {
      return res.status(400).json({ error: "يجب أن يكون JSON مصفوفة كوكيز تحتوي key/value أو name/value" });
    }

    appState = parsed.map(x => ({
      ...x,
      key: String(x.key || x.name),
      value: String(x.value),
      domain: x.domain || "facebook.com",
      path: x.path || "/"
    }));
  } catch {
    const pairs = [];

    for (const part of raw.split(";")) {
      const item = part.trim();
      if (!item) continue;

      const pos = item.indexOf("=");
      if (pos <= 0) {
        return res.status(400).json({ error: "صيغة الكوكيز غير صحيحة؛ استخدم JSON صالحاً أو نصاً مفصولاً بفواصل منقوطة" });
      }

      const key = item.slice(0, pos).trim();
      const value = item.slice(pos + 1).trim();

      if (!/^[A-Za-z0-9_-]+$/.test(key) || !value) {
        return res.status(400).json({ error: "يوجد اسم أو قيمة كوكيز غير صالحة" });
      }

      pairs.push({ key, value, domain: "facebook.com", path: "/", hostOnly: false });
    }

    appState = pairs;
  }

  const cookieMap = new Map(appState.map(x => [String(x.key || x.name), String(x.value)]));
  if (!cookieMap.has("c_user") || !cookieMap.has("xs")) {
    return res.status(400).json({ error: "الكوكيز غير مكتملة: يجب أن تحتوي على c_user و xs" });
  }

  const sessionFile = getSessionFiles(String(sessionId)).session;
  if (fs.existsSync(sessionFile)) {
    fs.copyFileSync(sessionFile, sessionFile + ".backup-" + Date.now());
  }

  writeJsonAtomic(sessionFile, appState);
  res.json({ ok: true, message: "تم حفظ جلسة QUASAR. أعد تشغيل الجلسة لتطبيقها." });
}



app.post("/api/cookies", auth, (req, res) => saveCookies(req, res, "1"));
app.post("/api/sessions/:id/cookies", auth, (req, res) => saveCookies(req, res, req.params.id));

function saveSession(req, res, sessionId = "1") {
  if (!req.file) return res.status(400).json({ error: "اختر ملف JSON أولاً" });
  let parsed;
  try { parsed = JSON.parse(req.file.buffer.toString("utf8")); }
  catch { return res.status(400).json({ error: "الملف ليس JSON صالحاً" }); }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(x => x && typeof x === "object" && "key" in x && "value" in x)) {
    return res.status(400).json({ error: "صيغة الجلسة غير مطابقة لـ appState.json" });
  }
  const sessionFile = getSessionFiles(String(sessionId)).session;
  const cookieMap = new Map(parsed.map(x => [String(x.key || x.name || ""), String(x.value || "")]));
  if (!cookieMap.has("c_user") || !cookieMap.has("xs")) {
    return res.status(400).json({ error: "ملف الجلسة لا يحتوي على c_user و xs" });
  }
  if (fs.existsSync(sessionFile)) {
    fs.copyFileSync(sessionFile, sessionFile + ".backup-" + Date.now());
  }
  writeJsonAtomic(sessionFile, parsed);
  res.json({ ok: true, message: "تم حفظ جلسة QUASAR. أعد تشغيل الجلسة لتطبيقها." });
}




app.post("/api/session", auth, upload.single("session"), (req, res) => saveSession(req, res, "1"));
app.post("/api/sessions/:id/session", auth, upload.single("session"), (req, res) => saveSession(req, res, req.params.id));

const botStates = {
  "1": { process: null, startedAt: null, logs: [] },
  "2": { process: null, startedAt: null, logs: [] },
  "3": { process: null, startedAt: null, logs: [] }
};

function getSessionFiles(id) {
  id = String(id);
  if (!/^[123]$/.test(id)) throw new Error("رقم الجلسة غير صالح");
  const suffix = id === "1" ? "" : id;
  return {
    session: path.join(DATA_DIR, "appState" + suffix + ".json"),
    data: path.join(DATA_DIR, "data" + suffix + ".json"),
    status: path.join(DATA_DIR, "bot-status" + suffix + ".json"),
    refreshSignal: path.join(DATA_DIR, ".groups-refresh" + suffix + ".json"),
    port: id === "1" ? 3000 : id === "2" ? 3002 : 3003
  };
}


function sessionData(id) {
  const files = getSessionFiles(id);
  return { files, data: readJson(files.data, {}) };
}

function validSession(req, res) {
  const id = String(req.params.id);
  if (!/^[123]$/.test(id)) {
    res.status(400).json({ error: "رقم الجلسة غير صالح" });
    return null;
  }
  return id;
}

app.get("/api/sessions/:id/dashboard", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const { files, data } = sessionData(id);
  const commandsDir = path.join(ROOT, "commands");
  const commands = fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)).sort()
    : [];
  const status = readJson(files.status, { online: false, updatedAt: null });
  const processInfo = getProcessInfo(id);
  const botConfig = readJson(CONFIG_FILE, {});
  const session = botConfig.SESSIONS?.[id] || {};
  const fresh = status.updatedAt && Date.now() - new Date(status.updatedAt).getTime() < 20000;
  const protectedGroups = data.protected && typeof data.protected === "object" ? data.protected : {};
  const botGroups = Array.isArray(data.botGroups) ? data.botGroups : [];
  const mutedGroups = data.mutedGroups && typeof data.mutedGroups === "object" ? data.mutedGroups : {};
  const allGroups = new Map();

  for (const g of botGroups) {
    if (!g || !g.id) continue;
    const groupId = String(g.id);
    const protectedGroup = protectedGroups[groupId] || {};
    allGroups.set(groupId, {
      id: groupId,
      name: g.name || protectedGroup.threadName || groupId,
      active: !!protectedGroup.active,
      members: Object.keys(protectedGroup.nicknames || {}).length,
      muted: mutedGroups[groupId] === true,
      protected: !!protectedGroups[groupId]
    });
  }

  for (const [groupId, g] of Object.entries(protectedGroups)) {
    const existing = allGroups.get(String(groupId));
    if (existing) {
      existing.name = existing.name || g.threadName || String(groupId);
      existing.active = !!g.active;
      existing.members = Object.keys(g.nicknames || {}).length;
    } else {
      allGroups.set(String(groupId), {
        id: String(groupId),
        name: g.threadName || String(groupId),
        active: !!g.active,
        members: Object.keys(g.nicknames || {}).length,
        muted: mutedGroups[String(groupId)] === true,
        protected: true
      });
    }
  }

  const groups = [...allGroups.values()];

  res.json({
    bot: {
      online: processInfo.running,
      startedAt: processInfo.startedAt || status.startedAt || null,
      botId: processInfo.botId || status.botId || null
    },
    prefix: data.prefix || "!",
    developerIds: Array.isArray(botConfig.DEV_IDS) ? botConfig.DEV_IDS : [String(botConfig.DEV_ID || "")],
    botNickname: String(session.BOT_NICK || botConfig.BOT_NICK || "𝚀𝚄𝙰𝚂𝙰𝚁 ⦓ ⚛️ ⦔"),
    nicknameGuardEnabled: (session.NICK_GUARD_ENABLED ?? botConfig.NICK_GUARD_ENABLED) !== false,
    developerNickname: String(botConfig.DEV_NICK || "𝚂𝙷𝙰𝙳𝙾𝚆 ⦓ ⚛️ ⦔"),
    freePrefix: !!data.freePrefix,
    admins: Array.isArray(data.admins) ? data.admins : [],
    commands,
    groups,
    groupsUpdatedAt: data.groupsUpdatedAt || null,
    lockedCount: Object.keys(data.locked || {}).length,
    savedMessagesCount: Array.isArray(data.savedMessages) ? data.savedMessages.length : 0
  });
});

app.put("/api/sessions/:id/settings", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const { files, data } = sessionData(id);

  if (typeof req.body.prefix === "string") {
    const prefix = req.body.prefix.trim();
    if (!prefix || prefix.length > 5) {
      return res.status(400).json({ error: "البادئة يجب أن تكون من 1 إلى 5 أحرف" });
    }
    data.prefix = prefix;
  }
  if (typeof req.body.freePrefix === "boolean") data.freePrefix = req.body.freePrefix;

  writeJsonAtomic(files.data, data);
  res.json({ ok: true });
});

app.put("/api/sessions/:id/admins", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const { files, data } = sessionData(id);
  const adminId = String(req.body.id || "").trim();
  const action = req.body.action;

  if (!/^\d{5,25}$/.test(adminId)) {
    return res.status(400).json({ error: "معرّف غير صالح" });
  }

  data.admins = Array.isArray(data.admins) ? data.admins : [];
  if (action === "add" && !data.admins.includes(adminId)) data.admins.push(adminId);
  else if (action === "remove") data.admins = data.admins.filter(x => String(x) !== adminId);
  else return res.status(400).json({ error: "إجراء غير صالح" });

  writeJsonAtomic(files.data, data);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/groups/refresh", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const files = getSessionFiles(id);
  const status = readJson(files.status, { online: false, updatedAt: null });
  const updatedAt = status.updatedAt ? new Date(status.updatedAt).getTime() : 0;
  const isFresh = Number.isFinite(updatedAt) && Date.now() - updatedAt < 20000;
  if (!status.online || !isFresh) {
    return res.status(409).json({ error: "البوت غير متصل حالياً؛ شغّل الجلسة ثم حدّث المجموعات." });
  }

  const requestedAt = new Date().toISOString();
  const tempFile = files.refreshSignal + ".tmp";
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ requestedAt }), { mode: 0o600 });
    fs.renameSync(tempFile, files.refreshSignal);
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch {}
    return res.status(500).json({ error: "تعذر إرسال طلب تحديث المجموعات: " + err.message });
  }

  return res.status(202).json({ ok: true, requestedAt, message: "تم إرسال طلب تحديث المجموعات إلى البوت." });
});

app.put("/api/sessions/:id/groups/:groupId", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const { files, data } = sessionData(id);
  const group = data.protected?.[req.params.groupId];

  if (!group) return res.status(404).json({ error: "المجموعة غير موجودة في protected" });
  if (typeof req.body.active !== "boolean") {
    return res.status(400).json({ error: "قيمة غير صالحة" });
  }

  group.active = req.body.active;
  writeJsonAtomic(files.data, data);
  res.json({ ok: true });
});


app.put("/api/sessions/:id/groups/:groupId/mute", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const { files, data } = sessionData(id);
  const groupId = String(req.params.groupId || "");
  const knownInBot = Array.isArray(data.botGroups) &&
    data.botGroups.some(g => g && String(g.id) === groupId);
  const knownInProtected = !!data.protected?.[groupId];

  if (!knownInBot && !knownInProtected) {
    return res.status(404).json({ error: "المجموعة غير مسجلة لهذه الجلسة" });
  }

  if (typeof req.body.muted !== "boolean") {
    return res.status(400).json({ error: "قيمة الكتم غير صالحة" });
  }

  if (!data.mutedGroups || typeof data.mutedGroups !== "object" || Array.isArray(data.mutedGroups)) {
    data.mutedGroups = {};
  }

  if (req.body.muted) data.mutedGroups[groupId] = true;
  else delete data.mutedGroups[groupId];

  writeJsonAtomic(files.data, data);
  res.json({ ok: true, muted: req.body.muted });
});

function customCommandsFile(id) {
  const suffix = String(id) === "1" ? "" : String(id);
  return path.join(DATA_DIR, "custom-commands" + suffix + ".json");
}

function readCustomCommands(id) {
  const value = readJson(customCommandsFile(id), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validCommandName(value) {
  const name = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_\u0600-\u06FF]{1,24}$/.test(name) ? name : null;
}

function isBuiltInCommand(name) {
  return fs.existsSync(path.join(ROOT, "commands", name + ".js"));
}

const protectedBuiltInCommands = new Set([
  "help", "ping", "prefix", "uptime", "ابتايم"
]);

function isProtectedBuiltInCommand(name) {
  return protectedBuiltInCommands.has(name);
}

function getBuiltInCommandPath(name) {
  const safeName = validCommandName(name);
  if (!safeName) return null;

  const dir = path.join(ROOT, "commands");
  const file = path.join(dir, safeName + ".js");

  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (path.dirname(file) !== dir) return null;
    return file;
  } catch {
    return null;
  }
}

function backupBuiltInCommand(name, file) {
  const backupDir = path.join(ROOT, "backups", "commands");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(4).toString("hex");
  const backup = path.join(
    backupDir,
    name + "-" + stamp + "-" + suffix + ".bak"
  );

  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {}
  return backup;
}

function validateBuiltInCommandCode(code) {
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("كود الأمر مطلوب");
  }
  if (code.length > 50000) {
    throw new Error("الكود أطول من الحد المسموح (50000 حرف)");
  }

  new vm.Script(code, { filename: "built-in-command.js" });
}

function writeBuiltInCommandSafely(name, file, code) {
  validateBuiltInCommandCode(code);

  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("ملف الأمر غير صالح");
  }

  const backup = backupBuiltInCommand(name, file);
  const temp = path.join(
    path.dirname(file),
    "." + name + "-" + crypto.randomBytes(8).toString("hex") + ".tmp"
  );

  try {
    fs.writeFileSync(temp, code, {
      encoding: "utf8",
      flag: "wx",
      mode: stat.mode & 0o777
    });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }

  return backup;
}


// إدارة الأوامر المدمجة
app.get("/api/built-in-commands/:name", auth, (req, res) => {
  const name = validCommandName(req.params.name);
  if (!name) return res.status(400).json({ error: "اسم الأمر غير صالح" });

  const file = getBuiltInCommandPath(name);
  if (!file) return res.status(404).json({ error: "الأمر المدمج غير موجود" });

  try {
    const stat = fs.statSync(file);
    if (stat.size > 50000) {
      return res.status(413).json({ error: "حجم ملف الأمر أكبر من الحد المسموح" });
    }
    res.json({ name, code: fs.readFileSync(file, "utf8") });
  } catch {
    res.status(500).json({ error: "تعذرت قراءة ملف الأمر" });
  }
});

app.put("/api/built-in-commands/:name", auth, (req, res) => {
  const name = validCommandName(req.params.name);
  if (!name) return res.status(400).json({ error: "اسم الأمر غير صالح" });

  const file = getBuiltInCommandPath(name);
  if (!file) return res.status(404).json({ error: "الأمر المدمج غير موجود" });

  try {
    const backup = writeBuiltInCommandSafely(name, file, req.body?.code);
    res.json({ ok: true, name, backup: path.relative(ROOT, backup) });
  } catch (error) {
    res.status(400).json({ error: error.message || "تعذر حفظ الأمر" });
  }
});

app.patch("/api/built-in-commands/:name", auth, (req, res) => {
  const name = validCommandName(req.params.name);
  const newName = validCommandName(req.body?.newName);

  if (!name || !newName) {
    return res.status(400).json({ error: "اسم الأمر الجديد غير صالح" });
  }
  if (name === newName) {
    return res.status(400).json({ error: "الاسم الجديد مطابق للاسم الحالي" });
  }

  const file = getBuiltInCommandPath(name);
  if (!file) return res.status(404).json({ error: "الأمر المدمج غير موجود" });

  const dir = path.join(ROOT, "commands");
  const destination = path.join(dir, newName + ".js");

  try {
    if (fs.existsSync(destination) || (() => {
      try { fs.lstatSync(destination); return true; } catch { return false; }
    })()) {
      return res.status(409).json({ error: "يوجد أمر بهذا الاسم بالفعل" });
    }

    const backup = backupBuiltInCommand(name, file);
    fs.renameSync(file, destination);
    res.json({
      ok: true,
      oldName: name,
      newName,
      backup: path.relative(ROOT, backup)
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "تعذرت إعادة تسمية الأمر" });
  }
});

app.delete("/api/built-in-commands/:name", auth, (req, res) => {
  const name = validCommandName(req.params.name);
  if (!name) return res.status(400).json({ error: "اسم الأمر غير صالح" });

  if (isProtectedBuiltInCommand(name)) {
    return res.status(403).json({ error: "هذا أمر أساسي؛ يمكن تعديله لكن لا يمكن حذفه" });
  }

  const file = getBuiltInCommandPath(name);
  if (!file) return res.status(404).json({ error: "الأمر المدمج غير موجود" });

  try {
    const backup = backupBuiltInCommand(name, file);
    fs.unlinkSync(file);
    res.json({ ok: true, name, backup: path.relative(ROOT, backup) });
  } catch (error) {
    res.status(500).json({ error: error.message || "تعذر حذف الأمر" });
  }
});

app.get("/api/sessions/:id/custom-commands", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const dir = path.join(ROOT, "commands");
  const builtInCommands = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)).sort()
    : [];

  const customCommands = Object.entries(readCustomCommands(id)).map(([name, item]) => ({
    name,
    reply: typeof item?.reply === "string" ? item.reply : "",
    code: typeof item?.code === "string" ? item.code : "",
    enabled: item?.enabled === true
  })).sort((a, b) => a.name.localeCompare(b.name));

  res.json({ builtInCommands, customCommands });
});

app.put("/api/sessions/:id/custom-commands/:name", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const name = validCommandName(req.params.name);
  if (!name) return res.status(400).json({ error: "اسم الأمر غير صالح" });
  if (isBuiltInCommand(name)) {
    return res.status(409).json({ error: "هذا الاسم مستخدم لأمر مدمج" });
  }

  const reply = req.body?.reply;
  const code = req.body?.code;
  const enabled = req.body?.enabled;

  const hasCode = typeof code === "string" && code.trim().length > 0;
  const hasReply = typeof reply === "string" && reply.trim().length > 0;

  if (hasCode && code.length > 12000) {
    return res.status(400).json({ error: "الكود أطول من الحد المسموح (12000 حرف)" });
  }
  if (!hasCode && (!hasReply || reply.length > 1500)) {
    return res.status(400).json({ error: "الكود أو الرد النصي مطلوب" });
  }
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "حالة التفعيل غير صالحة" });
  }

  if (hasCode) {
    try {
      new Function("api", "event", "args", "startTime", "loadData", "saveData", "automicTimers", "config", "hostingInfo", "botSentMessages", "BOT_ID", "return (" + code + ")");
    } catch (e) {
      return res.status(400).json({ error: "خطأ في صياغة الكود: " + e.message });
    }
  }

  const commands = readCustomCommands(id);
  commands[name] = hasCode
    ? { code: code.trim(), enabled }
    : { reply: reply.trim(), enabled };
  writeJsonAtomic(customCommandsFile(id), commands);
  res.json({ ok: true, name });
});

app.patch("/api/sessions/:id/custom-commands/:name", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const oldName = validCommandName(req.params.name);
  const newName = validCommandName(req.body?.newName);

  if (!oldName || !newName) {
    return res.status(400).json({ error: "اسم الأمر غير صالح" });
  }
  if (oldName === newName) {
    return res.status(400).json({ error: "الاسم الجديد مطابق للاسم الحالي" });
  }
  if (isBuiltInCommand(newName)) {
    return res.status(409).json({ error: "الاسم مستخدم لأمر مدمج" });
  }

  const commands = readCustomCommands(id);

  if (!Object.prototype.hasOwnProperty.call(commands, oldName)) {
    return res.status(404).json({ error: "الأمر المخصص غير موجود" });
  }
  if (Object.prototype.hasOwnProperty.call(commands, newName)) {
    return res.status(409).json({ error: "يوجد أمر مخصص بهذا الاسم بالفعل" });
  }

  commands[newName] = commands[oldName];
  delete commands[oldName];

  writeJsonAtomic(customCommandsFile(id), commands);
  res.json({ ok: true, oldName, newName });
});

app.delete("/api/sessions/:id/custom-commands/:name", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;

  const name = validCommandName(req.params.name);
  if (!name) return res.status(400).json({ error: "اسم الأمر غير صالح" });

  const commands = readCustomCommands(id);
  if (!Object.prototype.hasOwnProperty.call(commands, name)) {
    return res.status(404).json({ error: "الأمر المخصص غير موجود" });
  }

  delete commands[name];
  writeJsonAtomic(customCommandsFile(id), commands);
  res.json({ ok: true });
});

function getBotState(id) {
  if (!/^[123]$/.test(String(id))) throw new Error("رقم الجلسة غير صالح");
  return botStates[String(id)];
}

function addBotLog(id, value) {
  const state = getBotState(id);
  const lines = String(value).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    state.logs.push({ time: new Date().toISOString(), text: line });
    if (state.logs.length > 300) state.logs.shift();
    console.log("[BOT " + id + "]", line);
  }
}

function startManagedBot(id = "1") {
  id = String(id);
  const state = getBotState(id);
  const files = getSessionFiles(id);
  const entry = path.join(__dirname, "index.js");
  const sessionFile = files.session;
  if (state.process && state.process.exitCode === null) throw new Error("الجلسة " + id + " تعمل بالفعل");
  if (!fs.existsSync(entry)) throw new Error("ملف تشغيل SHADOW غير موجود");
  if (!fs.existsSync(sessionFile) || !fs.readFileSync(sessionFile, "utf8").trim()) throw new Error("ارفع ملف جلسة Facebook لهذه الجلسة أولاً");
  let appState;
  try { appState = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch { throw new Error("ملف appState لهذه الجلسة ليس JSON صالحاً"); }
  if (!Array.isArray(appState) ||
      !appState.some(x => x && [x.key, x.name].includes("c_user") && typeof x.value === "string" && x.value.trim()) ||
      !appState.some(x => x && [x.key, x.name].includes("xs") && typeof x.value === "string" && x.value.trim())) {
    throw new Error("ملف الجلسة يجب أن يحتوي على c_user و xs بقيم غير فارغة");
  }
  const currentCookie = appState.find(x => x && [x.key, x.name].includes("c_user"));
  const currentAccountId = String(currentCookie.value).trim();
  for (const otherId of ["1", "2", "3"]) {
    if (otherId === id) continue;
    const otherFile = getSessionFiles(otherId).session;
    if (!fs.existsSync(otherFile)) continue;
    try {
      const otherState = JSON.parse(fs.readFileSync(otherFile, "utf8"));
      if (!Array.isArray(otherState)) continue;
      const otherCookie = otherState.find(x => x && [x.key, x.name].includes("c_user") && typeof x.value === "string");
      if (otherCookie && String(otherCookie.value).trim() === currentAccountId) {
        throw new Error("الحساب نفسه موجود في الجلسة " + otherId + ". تم منع تشغيله مرتين محليًا؛ استخدم حسابًا منفصلًا لكل جلسة.");
      }
    } catch (error) {
      if (error && /الحساب نفسه موجود/.test(String(error.message))) throw error;
      // A different session with malformed JSON is ignored here and remains independently diagnosable.
    }
  }
  state.logs.length = 0;
  const port = files.port;
  const child = spawn(process.execPath, [entry], { cwd: ROOT, env: { ...process.env, NODE_ENV: "", SHADOW_SESSION_ID: id, SHADOW_BOT_PORT: String(port), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  state.process = child; state.startedAt = new Date().toISOString();
  child.stdout.on("data", data => addBotLog(id, data.toString()));
  child.stderr.on("data", data => addBotLog(id, "[stderr] " + data.toString()));
  child.on("error", err => addBotLog(id, "خطأ تشغيل: " + err.message));
  child.on("exit", (code, signal) => { addBotLog(id, "انتهت العملية: code=" + code + " signal=" + signal); if (state.process === child) state.process = null; });
  addBotLog(id, "تم تشغيل محرك QUASAR عبر SHADOW للجلسة " + id);
  return child.pid;
}

function stopManagedBot(id = "1") {
  const state = getBotState(String(id));
  const child = state.process;

  if (!child || child.exitCode !== null) {
    state.process = null;
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      clearTimeout(finalTimer);
      resolve(true);
    };

    child.once("exit", finish);
    child.kill("SIGTERM");

    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 4000);

    const finalTimer = setTimeout(finish, 6500);
  });
}

function getProcessInfo(id) {
  const state = getBotState(String(id));
  const files = getSessionFiles(String(id));
  const running = !!state.process && state.process.exitCode === null;
  const status = readJson(files.status, {});

  return {
    sessionId: String(id),
    running,
    pid: running ? state.process.pid : null,
    startedAt: running ? state.startedAt : null,
    uptimeSeconds: running && state.startedAt
      ? Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000)
      : 0,
    botId: status.botId || null,
    port: files.port
  };
}


function telegramInternalAuth(req, res, next) {
  const remote = req.socket.remoteAddress || "";
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  if (!TELEGRAM_INTERNAL_SECRET) return res.status(503).json({error:"الخدمة الداخلية غير مهيأة"});
  if (!local || !safeEqual(String(req.headers["x-shadow-telegram-secret"] || ""), TELEGRAM_INTERNAL_SECRET))
    return res.status(403).json({error:"غير مصرح"});
  next();
}



app.delete("/internal/telegram/facebook-developers", telegramInternalAuth, (req, res) => {
  const id = String(req.body?.id || "").trim();

  if (!/^\d{5,25}$/.test(id)) {
    return res.status(400).json({ error: "معرّف المطور غير صالح" });
  }

  const config = readJson(CONFIG_FILE, {});
  const raw = Array.isArray(config.DEV_IDS) ? config.DEV_IDS : [config.DEV_ID];
  const ids = [...new Set(raw.map(x => String(x || "").trim()).filter(x => /^\d{5,25}$/.test(x)))];

  if (!ids.includes(id)) {
    return res.status(404).json({ error: "هذا المعرف غير مسجل كمطور" });
  }

  if (ids.length <= 1) {
    return res.status(400).json({ error: "لا يمكن حذف آخر مطور" });
  }

  const updated = ids.filter(x => x !== id);
  config.DEV_IDS = updated;
  config.DEV_ID = updated[0] || "";
  writeJsonAtomic(CONFIG_FILE, config);

  res.json({ ok: true, removed: id, ids: updated });
});

app.get("/internal/telegram/facebook-developers", telegramInternalAuth, (_req, res) => {
  const config = readJson(CONFIG_FILE, {});
  const raw = Array.isArray(config.DEV_IDS) ? config.DEV_IDS : [config.DEV_ID];
  const ids = [...new Set(raw.map(x => String(x || "").trim()).filter(x => /^\d{5,25}$/.test(x)))];
  res.json({ ids });
});

app.post("/internal/telegram/facebook-developers", telegramInternalAuth, (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!/^\d{5,25}$/.test(id)) {
    return res.status(400).json({ error: "معرّف فيسبوك يجب أن يكون من 5 إلى 25 رقماً" });
  }

  const config = readJson(CONFIG_FILE, {});
  const raw = Array.isArray(config.DEV_IDS) ? config.DEV_IDS : [config.DEV_ID];
  const ids = [...new Set(raw.map(x => String(x || "").trim()).filter(x => /^\d{5,25}$/.test(x)))];

  if (ids.includes(id)) {
    return res.json({ ok: true, added: false, ids });
  }

  if (ids.length >= 50) {
    return res.status(400).json({ error: "وصلت قائمة المطورين إلى الحد الأقصى" });
  }

  ids.push(id);
  config.DEV_IDS = ids;
  config.DEV_ID = ids[0];
  writeJsonAtomic(CONFIG_FILE, config);

  res.json({ ok: true, added: true, ids });
});

app.put("/internal/telegram/developer-nickname", telegramInternalAuth, (req, res) => {
  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname || nickname.length > 80) {
    return res.status(400).json({ error: "كنية المطور مطلوبة ويجب ألا تتجاوز 80 حرفاً" });
  }

  const config = readJson(CONFIG_FILE, {});
  config.DEV_NICK = nickname;
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.put("/internal/telegram/bot-nickname", telegramInternalAuth, (req, res) => {
  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname || nickname.length > 80) {
    return res.status(400).json({ error: "كنية البوت مطلوبة ويجب ألا تتجاوز 80 حرفاً" });
  }

  const config = readJson(CONFIG_FILE, {});
  config.BOT_NICK = nickname;
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.get("/internal/telegram/process", telegramInternalAuth, (_req,res) => res.json(getProcessInfo("1")));
app.get("/internal/telegram/logs", telegramInternalAuth, (_req,res) => res.json({logs:botStates["1"].logs.slice(-30)}));
app.get("/internal/telegram/process/:id", telegramInternalAuth, (req,res) => {
  try { res.json(getProcessInfo(req.params.id)); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.get("/internal/telegram/logs/:id", telegramInternalAuth, (req,res) => {
  try { res.json({logs:getBotState(req.params.id).logs.slice(-30)}); }
  catch(e) { res.status(400).json({error:e.message}); }
});

app.get("/internal/telegram/stats", telegramInternalAuth, (_req,res) => res.json(stats.snapshot()));
app.get("/internal/telegram/stats/:period", telegramInternalAuth, (req,res) => {
  try { res.json(stats.summary(req.params.period)); }
  catch(e) { res.status(400).json({error:e.message}); }
});

app.post("/internal/telegram/start/:id", telegramInternalAuth, (req,res) => {
  try { res.json({ok:true,pid:startManagedBot(req.params.id)}); }
  catch(e) { res.status(400).json({ok:false,error:e.message}); }
});
app.post("/internal/telegram/stop/:id", telegramInternalAuth, async (req,res) => {
  try { res.json({ok:true,stopped:await stopManagedBot(req.params.id)}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});
app.post("/internal/telegram/restart/:id", telegramInternalAuth, async (req,res) => {
  try {
    await stopManagedBot(req.params.id);
    res.json({ok:true,pid:startManagedBot(req.params.id)});
  } catch(e) { res.status(400).json({ok:false,error:e.message}); }
});

app.get("/api/bot/process", auth, (_req, res) => {
  res.json(getProcessInfo("1"));
});

app.get("/api/bot/logs", auth, (_req, res) => {
  res.json({ logs: botStates["1"].logs.slice(-200) });
});

app.post("/api/bot/start", auth, (_req, res) => {
  try {
    const pid = startManagedBot("1");
    res.json({ ok: true, message: "تم تشغيل البوت", pid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bot/stop", auth, async (_req, res) => {
  try {
    const stopped = await stopManagedBot("1");
    res.json({ ok: true, message: stopped ? "تم إيقاف البوت" : "البوت متوقف بالفعل" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bot/restart", auth, async (_req, res) => {
  try {
    await stopManagedBot("1");
    const pid = startManagedBot("1");
    res.json({ ok: true, message: "تمت إعادة تشغيل البوت", pid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sessions/:id/process", auth, (req, res) => {
  try {
    res.json(getProcessInfo(String(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sessions/:id/logs", auth, (req, res) => {
  try {
    res.json({ logs: getBotState(String(req.params.id)).logs.slice(-200) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/start", auth, (req, res) => {
  try {
    const pid = startManagedBot(String(req.params.id));
    res.json({ ok: true, message: "تم تشغيل الجلسة " + req.params.id, pid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/stop", auth, async (req, res) => {
  try {
    const stopped = await stopManagedBot(String(req.params.id));
    res.json({ ok: true, message: stopped ? "تم إيقاف الجلسة" : "الجلسة متوقفة بالفعل" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/restart", auth, async (req, res) => {
  try {
    const id = String(req.params.id);
    await stopManagedBot(id);
    const pid = startManagedBot(id);
    res.json({ ok: true, message: "تمت إعادة تشغيل الجلسة " + id, pid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// ===== SHADOW FILE MANAGER: SAFE READ ONLY =====
function fileManagerBlockedName(name) {
  const n = String(name).toLowerCase();

  return n.startsWith(".") ||
    ["node_modules", "backups", "backup-panel-20261106-221122"].includes(n) ||
    /^backup-panel-/.test(n) ||
    /^appstate\d*\.json$/.test(n) ||
    /^data\d*\.json$/.test(n) ||
    /^bot-status\d*\.json$/.test(n) ||
    /^custom-commands\d*\.json$/.test(n) ||
    /^config(\..*)?$/.test(n) ||
    /^panel.*\.log$/.test(n) ||
    /\.log(\.\d+)?$/.test(n) ||
    /(^|[._-])(cookies?|secrets?|credentials?|tokens?|private|id_rsa|id_ed25519)([._-]|$)/i.test(n) ||
    /\.(pem|key|p12|pfx)$/i.test(n);
}

function resolveFileManagerPath(value) {
  const rel = typeof value === "string" ? value : "";

  if (rel.includes("\0") || rel.includes("\\") || path.isAbsolute(rel)) {
    throw new Error("مسار غير صالح");
  }

  const parts = rel ? rel.split("/") : [];

  if (parts.some(part =>
    !part || part === "." || part === ".." || fileManagerBlockedName(part)
  )) {
    throw new Error("المسار محظور أو غير صالح");
  }

  let current = ROOT;

  for (const part of parts) {
    current = path.join(current, part);
    const info = fs.lstatSync(current);

    if (info.isSymbolicLink()) {
      throw new Error("الروابط الرمزية غير مسموحة");
    }
  }

  const real = fs.realpathSync(current);
  const realRoot = fs.realpathSync(ROOT);
  const relative = path.relative(realRoot, real);

  if (relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)) {
    throw new Error("الوصول خارج مجلد المشروع مرفوض");
  }

  return real;
}

app.get("/api/files", auth, (req, res) => {
  try {
    const target = resolveFileManagerPath(req.query.path || "");

    if (!fs.statSync(target).isDirectory()) {
      return res.status(400).json({ error: "المسار ليس مجلدًا" });
    }

    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter(entry => !fileManagerBlockedName(entry.name))
      .map(entry => {
        try {
          const full = path.join(target, entry.name);
          const info = fs.lstatSync(full);

          if (info.isSymbolicLink()) return null;
          if (!info.isDirectory() && !info.isFile()) return null;

          return {
            name: entry.name,
            type: info.isDirectory() ? "directory" : "file",
            size: info.isFile() ? info.size : null
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) =>
        a.type !== b.type
          ? (a.type === "directory" ? -1 : 1)
          : a.name.localeCompare(b.name)
      );

    res.json({
      path: req.query.path || "",
      entries
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/files/read", auth, (req, res) => {
  try {
    if (typeof req.query.path !== "string" || !req.query.path) {
      return res.status(400).json({ error: "حدد مسار الملف" });
    }

    const target = resolveFileManagerPath(req.query.path);
    const info = fs.statSync(target);

    if (!info.isFile()) {
      return res.status(400).json({ error: "المسار ليس ملفًا" });
    }

    if (info.size > 1024 * 1024) {
      return res.status(413).json({ error: "حجم الملف أكبر من 1 ميجابايت" });
    }

    const content = fs.readFileSync(target);

    if (content.includes(0)) {
      return res.status(415).json({ error: "هذا الملف ليس ملفًا نصيًا" });
    }

    res.json({
      path: req.query.path,
      content: content.toString("utf8"),
      size: info.size
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// ===== END FILE MANAGER =====

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, "0.0.0.0", () => {
  try {
    writeJsonAtomic(PANEL_STATUS_FILE, {
      startedAt: new Date().toISOString(),
      pid: process.pid
    });
  } catch (error) {
    console.log("تعذر حفظ حالة واجهة QUASAR:", error.message);
  }
  console.log(`QUASAR PANEL: http://127.0.0.1:${PORT}/shadowxdiablos`);
});
