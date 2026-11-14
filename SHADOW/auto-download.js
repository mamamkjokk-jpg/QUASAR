"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_FILE = path.join(ROOT, "config.json");
const CACHE_FILE = path.join(ROOT, "data", "downloaded.json");
const API = "https://api.fastsaver.io/v1/fetch";

const URL_RE = /https?:\/\/(?:[\w-]+\.)*(?:instagram\.com|instagr\.am|facebook\.com|fb\.watch|fb\.com|tiktok\.com)\/[^\s]+/i;

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 10;
const MIN_GAP_MS = 6500;
const CACHE_LIMIT = 500;

const ALLOWED_MEDIA_HOSTS = [
  "cdninstagram.com",
  "fbcdn.net",
  "fbsbx.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokv.com",
  "byteoversea.com",
  "ibyteimg.com"
];

let lastCall = 0;
let blockedUntil = 0;
let queue = Promise.resolve();
const inFlight = new Set();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return readJson(CONFIG_FILE, {});
}

function loadCache() {
  return readJson(CACHE_FILE, {});
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });

  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys.slice(0, keys.length - CACHE_LIMIT)
      .forEach(key => delete cache[key]);
  }

  const temp = CACHE_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(cache, null, 2));
  fs.renameSync(temp, CACHE_FILE);
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw.replace(/[)\].,،]+$/, ""));

    if (!["http:", "https:"].includes(url.protocol)) return null;

    url.hash = "";
    [
      "utm_source", "utm_medium", "utm_campaign",
      "igshid", "fbclid", "si"
    ].forEach(key => url.searchParams.delete(key));

    return url.toString();
  } catch {
    return null;
  }
}

function allowedMediaUrl(value) {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" || url.port ||
        url.username || url.password) return false;

    const host = url.hostname.toLowerCase();

    return ALLOWED_MEDIA_HOSTS.some(domain =>
      host === domain || host.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

async function fetchMedia(link, key) {
  const endpoint = new URL(API);
  endpoint.searchParams.set("url", link);

  const response = await fetch(endpoint, {
    headers: { "X-Api-Key": key },
    redirect: "error",
    signal: AbortSignal.timeout(30000)
  });

  const body = await response.json().catch(() => ({}));

  return { status: response.status, body };
}

function extractItems(body) {
  if (!body || body.ok !== true) return [];

  let list = [];

  if (body.type === "album" && Array.isArray(body.items)) {
    list = body.items;
  } else if (body.download_url) {
    list = [body];
  } else if (Array.isArray(body.items)) {
    list = body.items;
  }

  return list.map(item => ({
    url: typeof item === "string"
      ? item
      : item.download_url || item.url || item.src,
    type: String(item?.type || body.type || "").toLowerCase()
  })).filter(item => item.url).slice(0, MAX_ITEMS);
}

async function fetchMediaFile(url) {
  if (!allowedMediaUrl(url)) {
    throw new Error("untrusted-media-host");
  }

  let current = url;
  let response;

  for (let i = 0; i < 5; i++) {
    if (!allowedMediaUrl(current)) {
      throw new Error("unsafe-redirect");
    }

    response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(45000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("invalid-redirect");

      current = new URL(location, current).toString();
      continue;
    }

    break;
  }

  if (!response || response.status !== 200 || !response.body) {
    throw new Error("media-download-failed");
  }

  const contentType = String(
    response.headers.get("content-type") || ""
  ).split(";")[0].toLowerCase();

  if (!contentType.startsWith("image/") &&
      !contentType.startsWith("video/")) {
    throw new Error("unsupported-media-type");
  }

  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_FILE_BYTES) throw new Error("file-too-large");

  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov"
  };

  const ext = extensions[contentType] ||
    (contentType.startsWith("video/") ? ".mp4" : ".jpg");

  const file = path.join(
    os.tmpdir(),
    "quasar_" + crypto.randomUUID() + ext
  );

  let size = 0;

  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;

      if (size > MAX_FILE_BYTES) {
        callback(new Error("file-too-large"));
        return;
      }

      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      fs.createWriteStream(file, { flags: "wx" })
    );

    return file;
  } catch (error) {
    await fs.promises.unlink(file).catch(() => {});
    throw error;
  }
}

async function sendText(api, threadID, message) {
  try {
    await api.sendMessage(message, String(threadID));
  } catch {}
}

async function processLink(api, event, link, key) {
  const threadID = String(event.threadID || "");
  const cache = loadCache();

  if (cache[link] || inFlight.has(link)) return;

  inFlight.add(link);
  const files = [];

  try {
    if (Date.now() < blockedUntil) {
      return sendText(
        api, threadID,
        "⏳ التحميل متوقف مؤقتاً بسبب حدود الخدمة."
      );
    }

    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      await new Promise(resolve => setTimeout(resolve, wait));
    }

    lastCall = Date.now();

    const result = await fetchMedia(link, key);
    const { status, body } = result;

    if (status === 401 || status === 403) {
      return sendText(api, threadID, "⚠️ مفتاح FastSaver غير صالح.");
    }

    if (status === 429) {
      blockedUntil = Date.now() + 60000;
      return sendText(api, threadID, "⏳ تجاوزنا حد الطلبات، حاول لاحقاً.");
    }

    if (status === 402) {
      blockedUntil = Date.now() + 3600000;
      return sendText(api, threadID, "⚠️ رصيد FastSaver انتهى.");
    }

    if (status !== 200 || body.ok !== true) {
      return sendText(
        api, threadID,
        "❌ تعذر تحميل الرابط أو أن المنشور خاص أو محذوف."
      );
    }

    const items = extractItems(body);

    if (!items.length) {
      return sendText(api, threadID, "❌ لم يتم العثور على وسائط.");
    }

    for (const item of items) {
      try {
        files.push(await fetchMediaFile(item.url));
      } catch (error) {
        console.log("[QUASAR DOWNLOAD]", error.message);
      }
    }

    if (!files.length) {
      return sendText(api, threadID, "❌ فشل تنزيل الوسائط.");
    }

    for (const file of files) {
      await api.sendMessage(
        { attachment: fs.createReadStream(file) },
        threadID
      );
    }

    cache[link] = { ok: true, time: Date.now() };
    saveCache(cache);

  } catch (error) {
    console.log("[QUASAR DOWNLOAD]", error.message);
    await sendText(api, threadID, "❌ حدث خطأ أثناء التحميل.");
  } finally {
    inFlight.delete(link);

    for (const file of files) {
      await fs.promises.unlink(file).catch(() => {});
    }
  }
}

module.exports = function autoDownload(api, event, botID) {
  try {
    if (!event || !["message", "message_reply"].includes(event.type)) return;
    if (!event.body || !event.threadID || !event.senderID) return;

    const senderID = String(event.senderID);
    const threadID = String(event.threadID);

    if (senderID === String(botID)) return;
    if (event.isGroup === false || threadID === senderID) return;

    const config = loadConfig();

    if (config.AUTO_DOWNLOAD_ENABLED !== true) return;

    const key = String(config.FASTSAVER_API_KEY || "").trim();
    if (!key) return;

    const match = String(event.body).match(URL_RE);
    if (!match) return;

    const link = normalizeUrl(match[0]);
    if (!link) return;

    queue = queue
      .then(() => processLink(api, event, link, key))
      .catch(error => {
        console.log("[QUASAR DOWNLOAD QUEUE]", error.message);
      });

  } catch (error) {
    console.log("[QUASAR DOWNLOAD]", error.message);
  }
};
