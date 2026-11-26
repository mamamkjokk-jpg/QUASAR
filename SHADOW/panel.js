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
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
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
const PASSWORD = process.env.PANEL_PASSWORD || "ShadowYellowPanel2026!";

if (!process.env.PANEL_PASSWORD) {
  console.warn("تنبيه: لم يتم تعيين PANEL_PASSWORD، يتم استخدام كلمة مرور افتراضية. عيّن PANEL_PASSWORD في المتغيرات لتأمين الدخول.");
}

const liveBridgeApis = new Map();
global.setShadowBridgeApi = (sessionId, apiInstance) => {
  liveBridgeApis.set(String(sessionId || "1"), apiInstance);
};
global.getShadowBridgeApi = (sessionId = "1") => {
  return liveBridgeApis.get(String(sessionId || "1")) || null;
};

function renderYellowPanelHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>لوحة تحكم SHADOW / QUASAR — الوضع الأصفر</title>
  <style>
    :root {
      --bg-main: #141106;
      --bg-card: #1f1a09;
      --bg-card-2: #28210b;
      --yellow: #facc15;
      --yellow-bright: #fde047;
      --yellow-dark: #ca8a04;
      --yellow-soft: rgba(250, 204, 21, 0.14);
      --text-main: #fefce8;
      --text-muted: #fde68a;
      --border-yellow: rgba(250, 204, 21, 0.35);
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
      background: radial-gradient(circle at top right, #2c2308, var(--bg-main) 65%);
      color: var(--text-main);
      min-height: 100vh;
    }
    header {
      background: linear-gradient(90deg, #1d1706, #2d2308, #1d1706);
      border-bottom: 2px solid var(--yellow);
      padding: 14px 22px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 800;
      font-size: 1.15rem;
      color: var(--yellow-bright);
    }
    .pill {
      background: var(--yellow-soft);
      border: 1px solid var(--border-yellow);
      color: var(--yellow-bright);
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 0.85rem;
    }
    .container {
      max-width: 1280px;
      margin: 20px auto;
      padding: 0 16px 40px;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
    }
    .tab-btn {
      background: var(--bg-card);
      color: var(--text-muted);
      border: 1px solid var(--border-yellow);
      padding: 9px 16px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 700;
      transition: 0.15s;
    }
    .tab-btn.active, .tab-btn:hover {
      background: var(--yellow);
      color: #161204;
      border-color: var(--yellow-bright);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-yellow);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .card h3 {
      margin: 0 0 12px;
      color: var(--yellow-bright);
      font-size: 1.05rem;
      border-bottom: 1px solid rgba(250, 204, 21, 0.2);
      padding-bottom: 8px;
    }
    label {
      display: block;
      font-size: 0.88rem;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input, select, textarea {
      width: 100%;
      background: var(--bg-card-2);
      color: var(--text-main);
      border: 1px solid var(--border-yellow);
      border-radius: 9px;
      padding: 9px 11px;
      margin-bottom: 10px;
      font-size: 0.92rem;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--yellow-bright);
      box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.2);
    }
    button {
      background: var(--yellow);
      color: #151104;
      border: none;
      border-radius: 9px;
      padding: 9px 14px;
      font-weight: 800;
      cursor: pointer;
      transition: 0.15s;
    }
    button:hover { background: var(--yellow-bright); }
    button.secondary {
      background: var(--bg-card-2);
      color: var(--yellow-bright);
      border: 1px solid var(--border-yellow);
    }
    button.danger {
      background: var(--danger);
      color: #fff;
    }
    .row-flex {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .chat-box {
      height: 280px;
      overflow-y: auto;
      background: #120f05;
      border: 1px solid var(--border-yellow);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg {
      background: #261f09;
      border: 1px solid rgba(250, 204, 21, 0.22);
      padding: 8px 11px;
      border-radius: 10px;
      max-width: 90%;
    }
    .msg .meta {
      font-size: 0.75rem;
      color: var(--yellow);
      margin-bottom: 3px;
    }
    .logs {
      background: #0d0b03;
      color: var(--yellow-bright);
      border: 1px solid var(--border-yellow);
      border-radius: 10px;
      padding: 10px;
      height: 220px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 0.82rem;
      white-space: pre-wrap;
    }
    .toast {
      position: fixed;
      bottom: 18px;
      left: 18px;
      background: var(--yellow);
      color: #141003;
      padding: 10px 16px;
      border-radius: 10px;
      font-weight: 800;
      display: none;
      z-index: 99;
      box-shadow: 0 6px 20px rgba(0,0,0,0.45);
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>⚡ لوحة SHADOW / QUASAR — الوضع الأصفر</span>
      <span class="pill" id="botStatusBadge">جاري الفحص...</span>
    </div>
    <div class="row-flex">
      <label style="margin:0;">الجلسة:</label>
      <select id="sessionSelect" style="width:auto;margin:0;">
        <option value="1">جلسة 1</option>
        <option value="2">جلسة 2</option>
        <option value="3">جلسة 3</option>
      </select>
      <button class="secondary" onclick="startBot()">تشغيل</button>
      <button class="secondary" onclick="restartBot()">إعادة تشغيل</button>
      <button class="danger" onclick="stopBot()">إيقاف</button>
    </div>
  </header>

  <div class="container">
    <div id="loginCard" class="card hidden" style="max-width:420px;margin:40px auto;">
      <h3>🔐 تسجيل الدخول للواجهة الصفراء</h3>
      <label>كلمة مرور اللوحة</label>
      <input type="password" id="loginPassword" placeholder="أدخل كلمة المرور" onkeydown="if(event.key==='Enter') loginPanel()" />
      <button style="width:100%;" onclick="loginPanel()">دخول</button>
    </div>

    <div id="appContent" class="hidden">
      <div class="tabs">
        <button class="tab-btn active" data-tab="messengerTab" onclick="switchTab('messengerTab', this)">💬 الماسنجر والخاص والأوامر</button>
        <button class="tab-btn" data-tab="identityTab" onclick="switchTab('identityTab', this)">🏷️ الأسماء والكنيات والغروبات</button>
        <button class="tab-btn" data-tab="settingsTab" onclick="switchTab('settingsTab', this)">⚙️ الإعدادات والأدمن والكوكيز</button>
        <button class="tab-btn" data-tab="logsTab" onclick="switchTab('logsTab', this)">📜 السجلات والأوامر</button>
      </div>

      <div id="messengerTab" class="grid">
        <div class="card">
          <h3>📥 المحادثات والغروبات</h3>
          <div class="row-flex" style="margin-bottom:8px;">
            <button onclick="loadThreads()">تحديث القائمة</button>
            <input id="manualThreadId" placeholder="أو اكتب Thread ID مباشرة..." style="margin:0;flex:1;" />
            <button class="secondary" onclick="selectManualThread()">فتح</button>
          </div>
          <select id="threadSelect" onchange="onThreadChanged()">
            <option value="">-- اختر محادثة أو غروب --</option>
          </select>
          <div id="chatBox" class="chat-box">
            <div class="msg"><div class="meta">النظام</div>اختر محادثة أو غروب لعرض الرسائل والتحدث بحساب البوت.</div>
          </div>
          <div class="row-flex">
            <input id="chatMessageInput" placeholder="اكتب رسالة أو أمر..." style="margin:0;flex:1;" onkeydown="if(event.key==='Enter') sendChatMessage()" />
            <button onclick="sendChatMessage()">إرسال</button>
          </div>
        </div>

        <div class="card">
          <h3>✉️ رسائل الخاص (شخص لشخص فقط - بدون غروبات)</h3>
          <div class="row-flex" style="margin-bottom:8px;">
            <button onclick="loadPrivateThreads()">تحديث الخاص</button>
            <input id="privateUserIdInput" placeholder="أدخل User ID الشخص..." style="margin:0;flex:1;" />
            <button class="secondary" onclick="openPrivateChatById()">فتح الخاص</button>
          </div>
          <select id="privateThreadSelect" onchange="onPrivateThreadChanged()">
            <option value="">-- اختر محادثة خاصة مع شخص --</option>
          </select>
          <div id="privateChatBox" class="chat-box">
            <div class="msg"><div class="meta">الخاص</div>اختر شخصاً أو أدخل الـ ID لعرض الرسائل الخاصة وإرسال رسالة مباشرة له.</div>
          </div>
          <div class="row-flex">
            <input id="privateMessageInput" placeholder="اكتب رسالة خاصة لهذا الشخص..." style="margin:0;flex:1;" onkeydown="if(event.key==='Enter') sendPrivateMessage()" />
            <button onclick="sendPrivateMessage()">إرسال خاص</button>
          </div>
        </div>

        <div class="card">
          <h3>🚀 تشغيل أمر في الغروب من الواجهة</h3>
          <p style="font-size:0.86rem;color:var(--text-muted);margin-top:0;">
            نفّذ أي أمر داخل الغروب المحدد مباشرة من الواجهة دون إرساله داخل الغروب.
          </p>
          <label>رقم الغروب / المحادثة (Thread ID)</label>
          <input id="cmdGroupId" placeholder="مثال: 123456789012345" />
          <label>الأمر أو النص المراد تنفيذه</label>
          <input id="cmdDirectInput" placeholder="مثال: !help أو !ping أو تشغيل..." />
          <label>معرّف المرسل (اختياري)</label>
          <input id="cmdSenderId" placeholder="افتراضي معرف المطور" />
          <div class="row-flex">
            <button onclick="executeGroupCommandFromPanel()">⚡ تنفيذ الأمر الآن</button>
            <button class="secondary" onclick="quickCmd('!help')">!help</button>
            <button class="secondary" onclick="quickCmd('!ping')">!ping</button>
            <button class="secondary" onclick="quickCmd('!uptime')">!uptime</button>
          </div>
        </div>
      </div>

      <div id="identityTab" class="grid hidden">
        <div class="card">
          <h3>🏷️ تغيير اسم الغروب</h3>
          <label>معرّف الغروب (Thread ID)</label>
          <input id="renameGroupId" placeholder="معرّف الغروب" />
          <label>الاسم الجديد للغروب</label>
          <input id="renameGroupTitle" placeholder="اكتب اسم الغروب الجديد" />
          <button onclick="changeGroupTitle()">💾 حفظ وتغيير اسم الغروب</button>
        </div>

        <div class="card">
          <h3>🎭 تغيير كنية عضو / البوت / المطور في غروب</h3>
          <label>معرّف الغروب (Thread ID)</label>
          <input id="nickGroupId" placeholder="معرّف الغروب" />
          <label>معرّف المستخدم (اتركه فارغاً لتغيير كنية البوت)</label>
          <input id="nickUserId" placeholder="User ID أو اتركه فارغاً للبوت" />
          <label>الكنية الجديدة (اتركها فارغة لإزالة الكنية)</label>
          <input id="nickValue" placeholder="الكنية الجديدة" />
          <button onclick="changeMemberNickname()">✨ تغيير الكنية الآن</button>
        </div>

        <div class="card">
          <h3>🛡️ الكنيات الافتراضية وحماية الكنيات</h3>
          <label>كنية البوت الافتراضية</label>
          <input id="defaultBotNick" placeholder="كنية البوت" />
          <label><input type="checkbox" id="botNickGuard" style="width:auto;" /> تفعيل حماية كنية البوت</label>
          <label>كنية المطور الافتراضية</label>
          <input id="defaultDevNick" placeholder="كنية المطور" />
          <label><input type="checkbox" id="devNickGuard" style="width:auto;" /> تفعيل حماية كنية المطور</label>
          <button onclick="saveIdentitySettings()">💾 حفظ إعدادات الكنيات</button>
        </div>
      </div>

      <div id="settingsTab" class="grid hidden">
        <div class="card">
          <h3>⚙️ البادئة والمطورون</h3>
          <label>البادئة (Prefix)</label>
          <input id="prefixInput" maxlength="5" placeholder="!" />
          <label><input type="checkbox" id="freePrefixCheck" style="width:auto;" /> تفعيل البادئة الحرة</label>
          <button onclick="saveGeneralSettings()">حفظ البادئة</button>
          <hr style="border-color:rgba(250,204,21,0.2);margin:14px 0;" />
          <label>معرّفات المطورين (مفصولة بفاصلة، حتى 2)</label>
          <input id="devIdsInput" placeholder="1000..., 1000..." />
          <button onclick="saveDevelopers()">حفظ المطورين</button>
        </div>

        <div class="card">
          <h3>👑 إدارة الأدمن</h3>
          <label>معرّف الأدمن</label>
          <div class="row-flex">
            <input id="adminIdInput" placeholder="معرّف حساب الأدمن" style="margin:0;flex:1;" />
            <button onclick="manageAdmin('add')">إضافة</button>
            <button class="danger" onclick="manageAdmin('remove')">حذف</button>
          </div>
          <div id="adminsList" style="margin-top:12px;font-size:0.9rem;color:var(--text-muted);"></div>
        </div>

        <div class="card">
          <h3>🍪 تحديث كوكيز / appState للجلسة</h3>
          <label>الصق JSON الكوكيز أو نص الكوكيز</label>
          <textarea id="cookiesTextarea" rows="6" placeholder='[{"key":"c_user","value":"..."},{"key":"xs","value":"..."}]'></textarea>
          <button onclick="saveCookiesPanel()">💾 حفظ الكوكيز</button>
        </div>
      </div>

      <div id="logsTab" class="grid hidden">
        <div class="card">
          <h3>📜 سجل تشغيل الجلسة</h3>
          <div id="botLogsBox" class="logs">جاري تحميل السجلات...</div>
        </div>
        <div class="card">
          <h3>🧩 الأوامر المتاحة</h3>
          <div id="commandsListBox" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let currentThreadId = "";
    let currentPrivateUserId = "";

    function showToast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.style.display = "block";
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => { el.style.display = "none"; }, 3500);
    }

    function currentSession() {
      return document.getElementById("sessionSelect").value || "1";
    }

    async function apiFetch(url, opts = {}) {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
        ...opts
      });
      if (res.status === 401) {
        document.getElementById("appContent").classList.add("hidden");
        document.getElementById("loginCard").classList.remove("hidden");
        throw new Error("يلزم تسجيل الدخول");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "حدث خطأ");
      return data;
    }

    async function loginPanel() {
      try {
        const password = document.getElementById("loginPassword").value;
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || "فشل الدخول");
        document.getElementById("loginCard").classList.add("hidden");
        document.getElementById("appContent").classList.remove("hidden");
        await refreshAll();
      } catch (e) { showToast(e.message); }
    }

    function switchTab(tabId, btn) {
      document.querySelectorAll('[id$="Tab"]').forEach(el => el.classList.add("hidden"));
      document.getElementById(tabId).classList.remove("hidden");
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      if (btn) btn.classList.add("active");
    }

    async function refreshAll() {
      const sid = currentSession();
      try {
        await apiFetch("/api/me");
        document.getElementById("loginCard").classList.add("hidden");
        document.getElementById("appContent").classList.remove("hidden");
      } catch {
        return;
      }

      try {
        const d = await apiFetch("/api/sessions/" + sid + "/dashboard");
        const badge = document.getElementById("botStatusBadge");
        badge.textContent = d.bot.online ? ("متصل (" + (d.bot.botId || sid) + ")") : "متوقف";
        badge.style.borderColor = d.bot.online ? "#22c55e" : "#ef4444";
        badge.style.color = d.bot.online ? "#86efac" : "#fca5a5";

        document.getElementById("prefixInput").value = d.prefix || "!";
        document.getElementById("freePrefixCheck").checked = !!d.freePrefix;
        document.getElementById("devIdsInput").value = (d.developerIds || []).join(", ");
        document.getElementById("defaultBotNick").value = d.botNickname || "";
        document.getElementById("botNickGuard").checked = d.nicknameGuardEnabled !== false;
        document.getElementById("defaultDevNick").value = d.developerNickname || "";
        document.getElementById("devNickGuard").checked = d.developerNicknameGuardEnabled !== false;
        document.getElementById("adminsList").textContent = (d.admins && d.admins.length) ? d.admins.join(" ، ") : "لا يوجد أدمن مضافون";

        const cmdsBox = document.getElementById("commandsListBox");
        cmdsBox.innerHTML = (d.commands || []).map(c => '<span class="pill">' + c + '</span>').join("");
      } catch (e) { showToast(e.message); }

      try {
        const logsRes = await apiFetch("/api/sessions/" + sid + "/logs");
        document.getElementById("botLogsBox").textContent = (logsRes.logs || []).map(l => "[" + l.time.slice(11,19) + "] " + l.text).join("\\n") || "لا توجد سجلات";
      } catch {}
    }

    async function startBot() {
      try { const r = await apiFetch("/api/sessions/" + currentSession() + "/start", { method: "POST" }); showToast(r.message || "تم التشغيل"); refreshAll(); }
      catch (e) { showToast(e.message); }
    }
    async function stopBot() {
      try { const r = await apiFetch("/api/sessions/" + currentSession() + "/stop", { method: "POST" }); showToast(r.message || "تم الإيقاف"); refreshAll(); }
      catch (e) { showToast(e.message); }
    }
    async function restartBot() {
      try { const r = await apiFetch("/api/sessions/" + currentSession() + "/restart", { method: "POST" }); showToast(r.message || "تمت إعادة التشغيل"); refreshAll(); }
      catch (e) { showToast(e.message); }
    }

    async function loadThreads() {
      try {
        const r = await apiFetch("/api/sessions/" + currentSession() + "/messenger/threads");
        const sel = document.getElementById("threadSelect");
        sel.innerHTML = '<option value="">-- اختر محادثة أو غروب --</option>' +
          (r.threads || []).map(t => '<option value="' + t.threadID + '">' + (t.isGroup ? "👥 " : "👤 ") + (t.name || t.threadID) + ' (' + t.threadID + ')</option>').join("");
        showToast("تم تحديث قائمة المحادثات (" + (r.threads || []).length + ")");
      } catch (e) { showToast(e.message); }
    }

    function selectManualThread() {
      const id = document.getElementById("manualThreadId").value.trim();
      if (!id) return showToast("أدخل Thread ID");
      currentThreadId = id;
      document.getElementById("cmdGroupId").value = id;
      document.getElementById("renameGroupId").value = id;
      document.getElementById("nickGroupId").value = id;
      loadMessages(id);
    }

    function onThreadChanged() {
      const id = document.getElementById("threadSelect").value;
      if (!id) return;
      currentThreadId = id;
      document.getElementById("cmdGroupId").value = id;
      document.getElementById("renameGroupId").value = id;
      document.getElementById("nickGroupId").value = id;
      loadMessages(id);
    }

    async function loadMessages(threadID) {
      try {
        const r = await apiFetch("/api/sessions/" + currentSession() + "/messenger/messages?threadID=" + encodeURIComponent(threadID));
        const box = document.getElementById("chatBox");
        const msgs = r.messages || [];
        if (!msgs.length) {
          box.innerHTML = '<div class="msg"><div class="meta">النظام</div>لا توجد رسائل حديثة في هذه المحادثة.</div>';
          return;
        }
        box.innerHTML = msgs.map(m =>
          '<div class="msg"><div class="meta">' + (m.senderName || m.senderID || "مستخدم") + '</div><div>' + (m.body || "[مرفق/حدث]") + '</div></div>'
        ).join("");
        box.scrollTop = box.scrollHeight;
      } catch (e) { showToast(e.message); }
    }

    async function sendChatMessage() {
      const tid = currentThreadId || document.getElementById("manualThreadId").value.trim() || document.getElementById("threadSelect").value;
      const body = document.getElementById("chatMessageInput").value.trim();
      if (!tid) return showToast("اختر محادثة أو غروب أولاً");
      if (!body) return showToast("اكتب رسالة أو أمراً");
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/messenger/send", {
          method: "POST",
          body: JSON.stringify({ threadID: tid, message: body })
        });
        document.getElementById("chatMessageInput").value = "";
        showToast("تم الإرسال عبر حساب البوت");
        await loadMessages(tid);
      } catch (e) { showToast(e.message); }
    }

    async function loadPrivateThreads() {
      try {
        const r = await apiFetch("/api/sessions/" + currentSession() + "/messenger/private-threads");
        const sel = document.getElementById("privateThreadSelect");
        sel.innerHTML = '<option value="">-- اختر محادثة خاصة مع شخص --</option>' +
          (r.threads || []).map(t =>
            '<option value="' + t.userID + '">👤 ' + (t.name || t.userID) + ' (' + t.userID + ')</option>'
          ).join("");
        showToast("تم تحديث الخاص (" + (r.threads || []).length + " شخص)");
      } catch (e) { showToast(e.message); }
    }

    function openPrivateChatById() {
      const uid = document.getElementById("privateUserIdInput").value.trim();
      if (!uid) return showToast("أدخل User ID للشخص");
      currentPrivateUserId = uid;
      loadPrivateMessages(uid);
    }

    function onPrivateThreadChanged() {
      const uid = document.getElementById("privateThreadSelect").value;
      if (!uid) return;
      currentPrivateUserId = uid;
      document.getElementById("privateUserIdInput").value = uid;
      loadPrivateMessages(uid);
    }

    async function loadPrivateMessages(userID) {
      try {
        const r = await apiFetch("/api/sessions/" + currentSession() + "/messenger/private-messages?userID=" + encodeURIComponent(userID));
        const box = document.getElementById("privateChatBox");
        const msgs = r.messages || [];
        if (!msgs.length) {
          box.innerHTML = '<div class="msg"><div class="meta">الخاص</div>لا توجد رسائل حديثة مع هذا الشخص.</div>';
          return;
        }
        box.innerHTML = msgs.map(m =>
          '<div class="msg"><div class="meta">' + (m.senderName || m.senderID || "مستخدم") + '</div><div>' + (m.body || "[مرفق/حدث]") + '</div></div>'
        ).join("");
        box.scrollTop = box.scrollHeight;
      } catch (e) { showToast(e.message); }
    }

    async function sendPrivateMessage() {
      const uid = currentPrivateUserId || document.getElementById("privateUserIdInput").value.trim() || document.getElementById("privateThreadSelect").value;
      const msg = document.getElementById("privateMessageInput").value.trim();
      if (!uid) return showToast("حدد الشخص أولاً");
      if (!msg) return showToast("اكتب رسالة خاصة");
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/messenger/private-send", {
          method: "POST",
          body: JSON.stringify({ userID: uid, message: msg })
        });
        document.getElementById("privateMessageInput").value = "";
        showToast("تم إرسال الرسالة الخاصة");
        await loadPrivateMessages(uid);
      } catch (e) { showToast(e.message); }
    }

    function quickCmd(cmd) {
      document.getElementById("cmdDirectInput").value = cmd;
      executeGroupCommandFromPanel();
    }

    async function executeGroupCommandFromPanel() {
      const threadID = document.getElementById("cmdGroupId").value.trim() || currentThreadId;
      const commandText = document.getElementById("cmdDirectInput").value.trim();
      const senderID = document.getElementById("cmdSenderId").value.trim();
      if (!threadID) return showToast("أدخل معرّف الغروب أولاً");
      if (!commandText) return showToast("أدخل الأمر المراد تشغيله");
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/messenger/run-command", {
          method: "POST",
          body: JSON.stringify({ threadID, command: commandText, senderID: senderID || undefined })
        });
        showToast("تم إرسال الأمر للتنفيذ في الغروب");
      } catch (e) { showToast(e.message); }
    }

    async function changeGroupTitle() {
      const threadID = document.getElementById("renameGroupId").value.trim();
      const title = document.getElementById("renameGroupTitle").value.trim();
      if (!threadID || !title) return showToast("أدخل معرّف الغروب والاسم الجديد");
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/messenger/group-name", {
          method: "PUT",
          body: JSON.stringify({ threadID, title })
        });
        showToast("تم تغيير اسم الغروب");
      } catch (e) { showToast(e.message); }
    }

    async function changeMemberNickname() {
      const threadID = document.getElementById("nickGroupId").value.trim();
      const userID = document.getElementById("nickUserId").value.trim();
      const nickname = document.getElementById("nickValue").value;
      if (!threadID) return showToast("أدخل معرّف الغروب");
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/messenger/nickname", {
          method: "PUT",
          body: JSON.stringify({ threadID, userID: userID || undefined, nickname })
        });
        showToast("تم تحديث الكنية");
      } catch (e) { showToast(e.message); }
    }

    async function saveIdentitySettings() {
      const sid = currentSession();
      try {
        await apiFetch("/api/sessions/" + sid + "/nickname", {
          method: "PUT",
          body: JSON.stringify({
            nickname: document.getElementById("defaultBotNick").value.trim(),
            enabled: document.getElementById("botNickGuard").checked
          })
        });
        await apiFetch("/api/sessions/" + sid + "/developer-nickname", {
          method: "PUT",
          body: JSON.stringify({
            nickname: document.getElementById("defaultDevNick").value.trim(),
            enabled: document.getElementById("devNickGuard").checked
          })
        });
        showToast("تم حفظ كنيات البوت والمطور");
      } catch (e) { showToast(e.message); }
    }

    async function saveGeneralSettings() {
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/settings", {
          method: "PUT",
          body: JSON.stringify({
            prefix: document.getElementById("prefixInput").value.trim(),
            freePrefix: document.getElementById("freePrefixCheck").checked
          })
        });
        showToast("تم حفظ الإعدادات");
      } catch (e) { showToast(e.message); }
    }

    async function saveDevelopers() {
      const ids = document.getElementById("devIdsInput").value.split(",").map(s => s.trim()).filter(Boolean);
      try {
        const r = await apiFetch("/api/sessions/" + currentSession() + "/developer", {
          method: "PUT",
          body: JSON.stringify({ ids })
        });
        showToast(r.message || "تم حفظ المطورين");
      } catch (e) { showToast(e.message); }
    }

    async function manageAdmin(action) {
      const id = document.getElementById("adminIdInput").value.trim();
      if (!id) return showToast("أدخل معرّف الأدمن");
      try {
        await apiFetch("/api/sessions/" + currentSession() + "/admins", {
          method: "PUT",
          body: JSON.stringify({ id, action })
        });
        showToast("تم تحديث قائمة الأدمن");
        refreshAll();
      } catch (e) { showToast(e.message); }
    }

    async function saveCookiesPanel() {
      const cookies = document.getElementById("cookiesTextarea").value.trim();
      if (!cookies) return showToast("ألصق الكوكيز أولاً");
      try {
        const r = await apiFetch("/api/sessions/" + currentSession() + "/cookies", {
          method: "POST",
          body: JSON.stringify({ cookies })
        });
        showToast(r.message || "تم حفظ الكوكيز");
      } catch (e) { showToast(e.message); }
    }

    document.getElementById("sessionSelect").addEventListener("change", refreshAll);
    refreshAll();
    setInterval(refreshAll, 10000);
  </script>
</body>
</html>`;
}

// تحديث ملف index.html بالواجهة الصفراء دائماً حتى لا يظهر ملف قديم
try {
  fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), renderYellowPanelHtml(), "utf8");
} catch (e) {
  console.log("تنبيه تحديث index.html:", e.message);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use("/shadowxdiablos", express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.redirect("/shadowxdiablos");
});

app.get("/shadowxdiablos", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderYellowPanelHtml());
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
    res.setHeader("Set-Cookie", "shadow_panel=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
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
  const remote = String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const isLocal = ["127.0.0.1", "::1"].includes(remote);
  const forwarded = isLocal ? String(req.headers["cf-connecting-ip"] || "").trim() : "";
  return net.isIP(forwarded) ? forwarded : remote;
}

function loginRateLimit(req, res, next) {
  const now = Date.now();
  for (const [ip, state] of loginFailures) {
    if (state.windowUntil <= now && state.blockedUntil <= now) loginFailures.delete(ip);
  }
  const key = loginClientKey(req);
  const state = loginFailures.get(key);
  if (state && state.blockedUntil > now) {
    res.setHeader("Retry-After", Math.ceil((state.blockedUntil - now) / 1000));
    return res.status(429).json({ error: "محاولات كثيرة، حاول بعد انتهاء الحظر" });
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
    blockedUntil: count >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : 0
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
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secureCookie = isHttps ? "; Secure" : "";
  res.setHeader("Set-Cookie", `shadow_panel=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secureCookie}`);
  res.json({ ok: true });
});

app.post("/api/logout", auth, (req, res) => {
  const token = (req.headers.cookie || "").split(";").map(x => x.trim())
    .find(x => x.startsWith("shadow_panel="))?.slice("shadow_panel=".length);
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "shadow_panel=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", auth, (_req, res) => res.json({ ok: true }));

function getSessionFiles(id) {
  id = String(id);
  if (!/^[123]$/.test(id)) throw new Error("رقم الجلسة غير صالح");
  const suffix = id === "1" ? "" : id;
  return {
    session: path.join(DATA_DIR, "appState" + suffix + ".json"),
    data: path.join(DATA_DIR, "data" + suffix + ".json"),
    status: path.join(DATA_DIR, "bot-status" + suffix + ".json"),
    refreshSignal: path.join(DATA_DIR, ".groups-refresh" + suffix + ".json"),
    bridgeQueue: path.join(DATA_DIR, "panel-bridge-queue" + suffix + ".json"),
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

function callCallbackOrPromise(fn, argsList = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("انتهت مهلة الاستجابة من ماسنجر")); }
    }, 15000);
    const done = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };
    try {
      const res = fn(...argsList, done);
      if (res && typeof res.then === "function") {
        res.then(val => done(null, val), err => done(err));
      } else if (fn.length <= argsList.length) {
        done(null, res);
      }
    } catch (e) {
      done(e);
    }
  });
}

function enqueueBridgeAction(sessionId, actionPayload) {
  const files = getSessionFiles(sessionId);
  const queue = readJson(files.bridgeQueue, []);
  const item = { id: crypto.randomBytes(8).toString("hex"), createdAt: new Date().toISOString(), ...actionPayload };
  queue.push(item);
  writeJsonAtomic(files.bridgeQueue, queue);
  return item;
}

app.get("/api/sessions/:id/messenger/threads", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const liveApi = global.getShadowBridgeApi(id);
  if (liveApi && typeof liveApi.getThreadList === "function") {
    try {
      const list = await callCallbackOrPromise(liveApi.getThreadList.bind(liveApi), [30, null, ["INBOX"]]);
      const threads = (Array.isArray(list) ? list : []).map(t => ({
        threadID: String(t.threadID || ""),
        name: t.threadName || t.name || String(t.threadID || ""),
        isGroup: Boolean(t.isGroup),
        snippet: t.snippet || ""
      })).filter(t => t.threadID);
      return res.json({ threads });
    } catch (e) {
      return res.status(500).json({ error: "تعذر جلب المحادثات: " + e.message });
    }
  }
  const { data } = sessionData(id);
  const fallbackThreads = (Array.isArray(data.botGroups) ? data.botGroups : []).map(g => ({
    threadID: String(g.id),
    name: g.name || String(g.id),
    isGroup: true,
    snippet: ""
  }));
  res.json({ threads: fallbackThreads });
});

app.get("/api/sessions/:id/messenger/messages", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const threadID = String(req.query.threadID || "").trim();
  if (!threadID) return res.status(400).json({ error: "حدد threadID" });
  const liveApi = global.getShadowBridgeApi(id);
  if (liveApi && typeof liveApi.getThreadHistory === "function") {
    try {
      const hist = await callCallbackOrPromise(liveApi.getThreadHistory.bind(liveApi), [threadID, 25, null]);
      const messages = (Array.isArray(hist) ? hist : []).map(m => ({
        messageID: m.messageID || "",
        senderID: String(m.senderID || ""),
        senderName: m.senderName || String(m.senderID || ""),
        body: m.body || ""
      }));
      return res.json({ messages });
    } catch (e) {
      return res.status(500).json({ error: "تعذر جلب الرسائل: " + e.message });
    }
  }
  res.json({ messages: [] });
});

app.get("/api/sessions/:id/messenger/private-threads", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const liveApi = global.getShadowBridgeApi(id);
  if (liveApi && typeof liveApi.getThreadList === "function") {
    try {
      const list = await callCallbackOrPromise(liveApi.getThreadList.bind(liveApi), [40, null, ["INBOX"]]);
      const privateThreads = (Array.isArray(list) ? list : [])
        .filter(t => t && !t.isGroup)
        .map(t => ({
          userID: String(t.threadID || ""),
          name: t.threadName || t.name || String(t.threadID || ""),
          snippet: t.snippet || ""
        }))
        .filter(t => t.userID);
      return res.json({ threads: privateThreads });
    } catch (e) {
      return res.status(500).json({ error: "تعذر جلب المحادثات الخاصة: " + e.message });
    }
  }
  res.json({ threads: [] });
});

app.get("/api/sessions/:id/messenger/private-messages", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const userID = String(req.query.userID || "").trim();
  if (!userID) return res.status(400).json({ error: "أدخل userID الخاص بالشخص" });
  const liveApi = global.getShadowBridgeApi(id);
  if (liveApi && typeof liveApi.getThreadHistory === "function") {
    try {
      const hist = await callCallbackOrPromise(liveApi.getThreadHistory.bind(liveApi), [userID, 25, null]);
      const messages = (Array.isArray(hist) ? hist : []).map(m => ({
        messageID: m.messageID || "",
        senderID: String(m.senderID || ""),
        senderName: m.senderName || String(m.senderID || ""),
        body: m.body || ""
      }));
      return res.json({ messages });
    } catch (e) {
      return res.status(500).json({ error: "تعذر جلب رسائل الخاص: " + e.message });
    }
  }
  res.json({ messages: [] });
});

app.post("/api/sessions/:id/messenger/private-send", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const userID = String(req.body?.userID || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!userID || !message) return res.status(400).json({ error: "معرّف الشخص ونص الرسالة مطلوبان" });

  const liveApi = global.getShadowBridgeApi(id);
  if (liveApi && typeof liveApi.sendMessage === "function") {
    try {
      await callCallbackOrPromise(liveApi.sendMessage.bind(liveApi), [message, userID]);
      return res.json({ ok: true, mode: "live" });
    } catch (e) {
      return res.status(500).json({ error: "فشل إرسال الرسالة الخاصة: " + e.message });
    }
  }
  enqueueBridgeAction(id, { type: "sendMessage", threadID: userID, message, isPrivate: true });
  res.json({ ok: true, mode: "queued" });
});

app.post("/api/sessions/:id/messenger/send", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const threadID = String(req.body?.threadID || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!threadID || !message) return res.status(400).json({ error: "المحادثة والرسالة مطلوبة" });

  const liveApi = global.getShadowBridgeApi(id);
  if (liveApi && typeof liveApi.sendMessage === "function") {
    try {
      await callCallbackOrPromise(liveApi.sendMessage.bind(liveApi), [message, threadID]);
      return res.json({ ok: true, mode: "live" });
    } catch (e) {
      return res.status(500).json({ error: "فشل الإرسال: " + e.message });
    }
  }
  enqueueBridgeAction(id, { type: "sendMessage", threadID, message });
  res.json({ ok: true, mode: "queued" });
});

app.post("/api/sessions/:id/messenger/run-command", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const threadID = String(req.body?.threadID || "").trim();
  const command = String(req.body?.command || "").trim();
  const senderID = String(req.body?.senderID || "").trim();
  if (!threadID || !command) return res.status(400).json({ error: "معرّف الغروب والأمر مطلوبان" });
  enqueueBridgeAction(id, { type: "runCommand", threadID, command, senderID });
  res.json({ ok: true, message: "تم إرسال الأمر للتنفيذ الفوري في الغروب" });
});

app.put("/api/sessions/:id/messenger/group-name", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const threadID = String(req.body?.threadID || "").trim();
  const title = String(req.body?.title || "").trim();
  if (!threadID || !title) return res.status(400).json({ error: "معرّف الغروب والاسم الجديد مطلوبان" });

  const liveApi = global.getShadowBridgeApi(id);
  const renameFn = liveApi && [liveApi.setTitle, liveApi.gcname, liveApi.changeGroupName].find(fn => typeof fn === "function");
  if (renameFn) {
    try {
      await callCallbackOrPromise(renameFn.bind(liveApi), [title, threadID]);
      return res.json({ ok: true, mode: "live" });
    } catch (e) {
      return res.status(500).json({ error: "تعذر تغيير اسم الغروب: " + e.message });
    }
  }
  enqueueBridgeAction(id, { type: "setTitle", threadID, title });
  res.json({ ok: true, mode: "queued" });
});

app.put("/api/sessions/:id/messenger/nickname", auth, async (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const threadID = String(req.body?.threadID || "").trim();
  const nickname = String(req.body?.nickname ?? "").trim();
  if (!threadID) return res.status(400).json({ error: "معرّف الغروب مطلوب" });

  const liveApi = global.getShadowBridgeApi(id);
  const targetUserID = String(req.body?.userID || (liveApi && typeof liveApi.getCurrentUserID === "function" ? liveApi.getCurrentUserID() : "") || "").trim();
  if (!targetUserID) return res.status(400).json({ error: "معرّف المستخدم غير متوفر" });

  const nickFn = liveApi && [liveApi.changeNickname, liveApi.nickname, liveApi.setNickname].find(fn => typeof fn === "function");
  if (nickFn) {
    try {
      await callCallbackOrPromise(nickFn.bind(liveApi), [nickname, threadID, targetUserID]);
      return res.json({ ok: true, mode: "live" });
    } catch (e) {
      return res.status(500).json({ error: "تعذر تغيير الكنية: " + e.message });
    }
  }
  enqueueBridgeAction(id, { type: "setNickname", threadID, userID: targetUserID, nickname });
  res.json({ ok: true, mode: "queued" });
});

function getSessionDeveloperSettings(sourceConfig = {}, id = "1") {
  const session = sourceConfig.SESSIONS?.[id] || {};
  let rawIds = [];
  if (Array.isArray(session.DEV_IDS)) rawIds = session.DEV_IDS;
  else if (session.DEV_ID) rawIds = [session.DEV_ID];
  else if (id === "1") rawIds = [...(Array.isArray(sourceConfig.DEV_IDS) ? sourceConfig.DEV_IDS : []), sourceConfig.DEV_ID];
  const ids = [...new Set(rawIds.map(String).map(v => v.trim()).filter(v => /^[0-9]{5,25}$/.test(v)))];
  return { id: ids[0] || "", ids };
}

const botStates = {
  "1": { process: null, startedAt: null, logs: [] },
  "2": { process: null, startedAt: null, logs: [] },
  "3": { process: null, startedAt: null, logs: [] }
};

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
  if (!fs.existsSync(entry)) throw new Error("ملف تشغيل البوت غير موجود");
  if (!fs.existsSync(sessionFile) || !fs.readFileSync(sessionFile, "utf8").trim()) throw new Error("ارفع ملف جلسة Facebook لهذه الجلسة أولاً");
  let appState;
  try { appState = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch { throw new Error("ملف appState لهذه الجلسة ليس JSON صالحاً"); }
  if (!Array.isArray(appState) ||
      !appState.some(x => x && [x.key, x.name].includes("c_user") && typeof x.value === "string" && x.value.trim()) ||
      !appState.some(x => x && [x.key, x.name].includes("xs") && typeof x.value === "string" && x.value.trim())) {
    throw new Error("ملف الجلسة يجب أن يحتوي على c_user و xs بقيم غير فارغة");
  }

  state.logs.length = 0;
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "", SHADOW_SESSION_ID: id, SHADOW_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });
  state.process = child;
  state.startedAt = new Date().toISOString();
  child.stdout.on("data", data => addBotLog(id, data.toString()));
  child.stderr.on("data", data => addBotLog(id, "[stderr] " + data.toString()));
  child.on("error", err => addBotLog(id, "خطأ تشغيل: " + err.message));
  child.on("exit", (code, signal) => {
    addBotLog(id, "انتهت العملية: code=" + code + " signal=" + signal);
    if (state.process === child) state.process = null;
  });
  addBotLog(id, "تم تشغيل محرك الجلسة " + id);
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
    const forceTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 4000);
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
    startedAt: running ? state.startedAt : (status.startedAt || null),
    uptimeSeconds: running && state.startedAt ? Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000) : 0,
    botId: status.botId || null,
    port: files.port
  };
}

app.get("/api/sessions/:id/dashboard", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const { data } = sessionData(id);
  const commandsDir = path.join(ROOT, "commands");
  const commands = fs.existsSync(commandsDir)
    ? fs.readdirSync(commandsDir).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3)).sort()
    : [];
  const files = getSessionFiles(id);
  const status = readJson(files.status, { online: false, updatedAt: null });
  const processInfo = getProcessInfo(id);
  const botConfig = readJson(CONFIG_FILE, {});
  const session = botConfig.SESSIONS?.[id] || {};
  const devSet = getSessionDeveloperSettings(botConfig, id);

  res.json({
    bot: {
      online: Boolean(processInfo.running || status.online),
      startedAt: processInfo.startedAt || status.startedAt || null,
      botId: processInfo.botId || status.botId || null
    },
    prefix: data.prefix || "!",
    developerIds: devSet.ids,
    botNickname: String(session.BOT_NICK || botConfig.BOT_NICK || "𝚀𝚄𝙰𝚂𝙰𝚁 ⦓ ⚛️ ⦔"),
    nicknameGuardEnabled: (session.NICK_GUARD_ENABLED ?? botConfig.NICK_GUARD_ENABLED) !== false,
    developerNickname: String(session.DEV_NICK || (id === "1" ? botConfig.DEV_NICK : "") || "𝚂𝙷𝙰𝙳𝙾𝚆 ⦓ ⚛️ ⦔"),
    developerNicknameGuardEnabled: (session.DEV_NICK_GUARD_ENABLED ?? (id === "1" ? botConfig.DEV_NICK_GUARD_ENABLED : undefined)) !== false,
    freePrefix: !!data.freePrefix,
    admins: Array.isArray(data.admins) ? data.admins : [],
    commands
  });
});

app.put("/api/sessions/:id/settings", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const { files, data } = sessionData(id);
  if (typeof req.body.prefix === "string") {
    const p = req.body.prefix.trim();
    if (!p || p.length > 5) return res.status(400).json({ error: "البادئة يجب أن تكون من 1 إلى 5 أحرف" });
    data.prefix = p;
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
  if (!/^\d{5,25}$/.test(adminId)) return res.status(400).json({ error: "معرّف غير صالح" });
  data.admins = Array.isArray(data.admins) ? data.admins : [];
  if (action === "add" && !data.admins.includes(adminId)) data.admins.push(adminId);
  else if (action === "remove") data.admins = data.admins.filter(x => String(x) !== adminId);
  else return res.status(400).json({ error: "إجراء غير صالح" });
  writeJsonAtomic(files.data, data);
  res.json({ ok: true });
});

app.put("/api/sessions/:id/developer", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => String(x).trim()).filter(Boolean) : [];
  if (ids.length < 1 || ids.length > 2 || ids.some(v => !/^[0-9]{5,25}$/.test(v)) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "أدخل معرفاً أو معرفين صحيحين" });
  }
  const config = readJson(CONFIG_FILE, {});
  config.SESSIONS = config.SESSIONS || {};
  config.SESSIONS[id] = config.SESSIONS[id] || {};
  config.SESSIONS[id].DEV_ID = ids[0];
  config.SESSIONS[id].DEV_IDS = ids;
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true, message: "تم حفظ مطوري الجلسة" });
});

app.put("/api/sessions/:id/nickname", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname || nickname.length > 80) return res.status(400).json({ error: "الكنية مطلوبة" });
  const config = readJson(CONFIG_FILE, {});
  config.SESSIONS = config.SESSIONS || {};
  config.SESSIONS[id] = config.SESSIONS[id] || {};
  config.SESSIONS[id].BOT_NICK = nickname;
  config.SESSIONS[id].NICK_GUARD_ENABLED = Boolean(req.body?.enabled);
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.put("/api/sessions/:id/developer-nickname", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname || nickname.length > 80) return res.status(400).json({ error: "كنية المطور مطلوبة" });
  const config = readJson(CONFIG_FILE, {});
  config.SESSIONS = config.SESSIONS || {};
  config.SESSIONS[id] = config.SESSIONS[id] || {};
  config.SESSIONS[id].DEV_NICK = nickname;
  config.SESSIONS[id].DEV_NICK_GUARD_ENABLED = Boolean(req.body?.enabled);
  writeJsonAtomic(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/cookies", auth, (req, res) => {
  const id = validSession(req, res);
  if (!id) return;
  const raw = String(req.body?.cookies || "").trim();
  if (!raw) return res.status(400).json({ error: "ألصق JSON الكوكيز أولاً" });
  let appState;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return res.status(400).json({ error: "يجب أن يكون JSON مصفوفة كوكيز" });
    appState = parsed.map(x => ({
      ...x,
      key: String(x.key || x.name || ""),
      value: String(x.value || ""),
      domain: x.domain || "facebook.com",
      path: x.path || "/"
    }));
  } catch {
    return res.status(400).json({ error: "صيغة JSON غير صالحة" });
  }
  const cookieMap = new Map(appState.map(x => [x.key, x.value]));
  if (!cookieMap.has("c_user") || !cookieMap.has("xs")) {
    return res.status(400).json({ error: "الكوكيز يجب أن تحتوي على c_user و xs" });
  }
  writeJsonAtomic(getSessionFiles(id).session, appState);
  res.json({ ok: true, message: "تم حفظ الكوكيز بنجاح" });
});

app.get("/api/sessions/:id/logs", auth, (req, res) => {
  try { res.json({ logs: getBotState(String(req.params.id)).logs.slice(-200) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/sessions/:id/start", auth, (req, res) => {
  try { res.json({ ok: true, message: "تم تشغيل الجلسة " + req.params.id, pid: startManagedBot(String(req.params.id)) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post("/api/sessions/:id/stop", auth, async (req, res) => {
  try { res.json({ ok: true, message: (await stopManagedBot(String(req.params.id))) ? "تم إيقاف الجلسة" : "الجلسة متوقفة بالفعل" }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/sessions/:id/restart", auth, async (req, res) => {
  try {
    const id = String(req.params.id);
    await stopManagedBot(id);
    res.json({ ok: true, message: "تمت إعادة تشغيل الجلسة " + id, pid: startManagedBot(id) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, "0.0.0.0", () => {
  try { writeJsonAtomic(PANEL_STATUS_FILE, { startedAt: new Date().toISOString(), pid: process.pid }); } catch {}
  console.log(`QUASAR YELLOW PANEL: http://0.0.0.0:${PORT}/shadowxdiablos`);
});
