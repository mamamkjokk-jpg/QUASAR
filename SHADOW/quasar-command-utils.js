"use strict";

const axios = require("axios");
const net = require("net");
const { getThreadInfoSafe } = require("./thread-info-guard");

function send(api, event, payload) {
  if (!event || !event.threadID) throw new Error("معرّف المحادثة غير متاح");
  return Promise.resolve(api.sendMessage(payload, String(event.threadID)));
}

function uniqueIds(values) {
  return [...new Set((values || []).map(value => String(value || "").trim()).filter(value => /^\d{5,25}$/.test(value)))];
}

async function invoke(api, methodName, args, timeoutMs = 30000) {
  const method = api && api[methodName];
  if (typeof method !== "function") throw new Error(`واجهة ${methodName} غير متاحة في @dongdev/fca-unofficial`);

  if (method.length <= args.length) return await method.apply(api, args);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`انتهت مهلة ${methodName}`)), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    try {
      const result = method.apply(api, [...args, (error, value) => finish(error, value)]);
      if (result && typeof result.then === "function") result.then(value => finish(null, value), finish);
      else if (method.length <= args.length + 1) {
        // Callback-style FCA methods resolve through the callback.
      }
    } catch (error) {
      finish(error);
    }
  });
}

async function getThreadInfo(api, threadID) {
  if (typeof api.getThreadInfo !== "function") throw new Error("تعذّر الوصول إلى معلومات المجموعة");
  const info = await getThreadInfoSafe(api, String(threadID));
  if (!info || typeof info !== "object") throw new Error("لم تصل معلومات المجموعة");
  return info;
}

function getMentionIds(event) {
  return uniqueIds(Object.keys(event?.mentions || {}));
}

function getTargetIds(event, args, botID) {
  const mentions = getMentionIds(event);
  if (mentions.length) return mentions;
  if (event?.messageReply?.senderID) return uniqueIds([event.messageReply.senderID]);
  const numeric = (args || []).filter(value => /^\d{5,25}$/.test(String(value)));
  if (numeric.length) return uniqueIds(numeric);
  if (event?.senderID && String(event.senderID) !== String(botID)) return [String(event.senderID)];
  return [];
}

// Kept as a compatibility helper for existing commands, but all output is plain text.
function styledFrame(title, lines) {
  return [String(title || "").trim(), ...(Array.isArray(lines) ? lines.map(line => String(line)) : [])]
    .filter(Boolean)
    .join("\n");
}

function isSafeImageUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    const ipType = net.isIP(host);
    if (ipType === 4) {
      const [a, b] = host.split(".").map(Number);
      if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return false;
    }
    if (ipType === 6 && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) return false;
    return true;
  } catch {
    return false;
  }
}

async function downloadImage(url, filename = "quasar-image") {
  if (!isSafeImageUrl(url)) throw new Error("استخدم رابط صورة HTTPS عام وصالحاً");
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 20000,
    maxContentLength: 8 * 1024 * 1024,
    maxBodyLength: 8 * 1024 * 1024,
    headers: { "User-Agent": "QUASAR-SHADOW/1.0" }
  });
  const type = String(response.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("image/")) {
    response.data.destroy?.();
    throw new Error("الرابط لا يعيد ملف صورة");
  }
  response.data.path = filename;
  return response.data;
}

async function changeNickname(api, nickname, threadID, userID) {
  const method = [api.nickname, api.changeNickname, api.setNickname].find(fn => typeof fn === "function");
  if (!method) throw new Error("تغيير الكنية غير متاح في المكتبة الحالية");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("انتهت مهلة تغيير الكنية")), 30000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    try {
      const result = method.call(api, String(nickname), String(threadID), String(userID), error => finish(error));
      if (result && typeof result.then === "function") result.then(value => finish(null, value), finish);
      else if (method.length < 4) finish(null);
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = {
  send, invoke, getThreadInfo, getMentionIds, getTargetIds,
  uniqueIds, styledFrame, downloadImage, changeNickname
};
