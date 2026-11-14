"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const helper = {
  send(api, event, payload) {
    api.sendMessage(payload, event.threadID);
    return payload;
  },
  getMentionIds(event) {
    return Object.keys(event.mentions || {});
  },
  async invoke(api, method, args) {
    if (typeof api[method] !== "function") throw new Error(`missing ${method}`);
    return api[method](...args);
  },
  async downloadImage(url, filename) {
    return { testImage: true, url, filename };
  }
};

Module._load = function(request, parent, isMain) {
  if (request === "../SHADOW/quasar-command-utils" && parent && /[\\/]commands[\\/]/.test(parent.filename)) {
    return helper;
  }
  return originalLoad.call(this, request, parent, isMain);
};
const setBio = require("../../commands/setbio");
const changeAvatar = require("../../commands/صورة");
const deletion = require("../../commands/حذف");
Module._load = originalLoad;

function createApi() {
  const sent = [];
  return {
    sent,
    sendMessage(message, threadID) { sent.push({ message, threadID }); },
    async changeBio(value) { this.bio = value; },
    async changeAvatar(image) { this.avatar = image; },
    async unsendMessage(messageID, threadID) { (this.unsentCalls ||= []).push({ messageID, threadID }); }
  };
}

test("setbio يغير بايو الحساب نفسه وليس وصف المجموعة", async () => {
  const api = createApi();
  await setBio(api, { threadID: "group" }, ["setbio", "نبذة جديدة"]);
  assert.equal(api.bio, "نبذة جديدة");
  assert.match(String(api.sent[0].message), /بايو حساب البوت/);
});

test("حذف يسحب رسائل البوت القديمة والجديدة فقط ولا يحذف رسالة الأمر", async () => {
  const api = createApi();

  // رسالة قديمة أرسلها البوت
  await deletion(api, {
    threadID: "group",
    messageID: "command-old",
    messageReply: { senderID: "bot-1", messageID: "old-bot-message" }
  }, [], 0, null, null, null, null, null, null, "bot-1");

  // رسالة جديدة أرسلها البوت
  await deletion(api, {
    threadID: "group",
    messageID: "command-new",
    messageReply: { senderID: "bot-1", messageID: "new-bot-message" }
  }, [], 0, null, null, null, null, null, null, "bot-1");

  // رسالة شخص آخر يجب ألا تُحذف
  await deletion(api, {
    threadID: "group",
    messageID: "command-other",
    messageReply: { senderID: "other", messageID: "other-message" }
  }, [], 0, null, null, null, null, null, null, "bot-1");

  assert.deepEqual(api.unsentCalls, [
    { messageID: "old-bot-message", threadID: "group" },
    { messageID: "new-bot-message", threadID: "group" }
  ]);

  assert.equal(
    api.unsentCalls.some(x => x.messageID.startsWith("command-")),
    false
  );
});


test("صورة يغيّر صورة الحساب من رابط صورة عبر واجهة FCA فقط", async () => {
  const api = createApi();
  await changeAvatar(api, { threadID: "group" }, ["صورة", "https://images.example/avatar.jpg"]);
  assert.equal(api.avatar.testImage, true);
  assert.equal(api.avatar.url, "https://images.example/avatar.jpg");
  assert.match(String(api.sent.at(-1).message), /تغيير صورة حساب البوت/);
});

test("صورة لا يدّعي النجاح إذا لم توفر المكتبة changeAvatar", async () => {
  const api = createApi();
  delete api.changeAvatar;
  await changeAvatar(api, { threadID: "group" }, ["صورة"]);
  assert.match(String(api.sent.at(-1).message), /غير متاح/);
});
