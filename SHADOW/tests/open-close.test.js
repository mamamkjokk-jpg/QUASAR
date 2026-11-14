"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { canExecuteCommand, DEVELOPER_ONLY_COMMANDS } = require("../command-access");
const openCommand = require("../../commands/فتح");
const closeCommand = require("../../commands/قفل");

function createContext(isDeveloper) {
  const data = { publicMode: false };
  const sent = [];
  let saves = 0;

  const api = {
    async sendMessage(message, threadID) {
      sent.push({ message, threadID });
    }
  };

  const args = [
    api,
    { threadID: "test-group" },
    [],
    Date.now(),
    () => data,
    value => { Object.assign(data, value); saves++; },
    {},
    {},
    {},
    {},
    "bot-id",
    [],
    [],
    {},
    { isDeveloper }
  ];

  return { data, sent, args, get saves() { return saves; } };
}

test("الوضع المغلق يمنع المستخدم العادي حتى لو كان أدمن لوحة التحكم", () => {
  assert.equal(canExecuteCommand({
    cmd: "عام",
    isDeveloper: false,
    publicMode: false
  }), false);
});

test("الوضع المفتوح يسمح بالأوامر العامة", () => {
  assert.equal(canExecuteCommand({
    cmd: "عام",
    isDeveloper: false,
    publicMode: true
  }), true);
});

test("أوامر المطور تبقى محمية في الوضع المفتوح", () => {
  for (const cmd of DEVELOPER_ONLY_COMMANDS) {
    assert.equal(canExecuteCommand({
      cmd,
      isDeveloper: false,
      publicMode: true
    }), false, cmd);
  }
});

test("المطور يستطيع تنفيذ الأوامر المحمية في الوضعين", () => {
  for (const publicMode of [false, true]) {
    assert.equal(canExecuteCommand({
      cmd: "قفل",
      isDeveloper: true,
      publicMode
    }), true);
  }
});

test("فتح يفعّل الوضع العام للمطور فقط", async () => {
  const context = createContext(true);
  assert.equal(await openCommand(...context.args), true);
  assert.equal(context.data.publicMode, true);
  assert.equal(context.saves, 1);
  assert.match(context.sent[0].message, /فتح/);
});

test("فتح يرفض غير المطور ولا يغيّر الوضع", async () => {
  const context = createContext(false);
  assert.equal(await openCommand(...context.args), false);
  assert.equal(context.data.publicMode, false);
  assert.equal(context.saves, 0);
});

test("قفل يعطّل الوضع العام للمطور فقط", async () => {
  const context = createContext(true);
  context.data.publicMode = true;
  assert.equal(await closeCommand(...context.args), true);
  assert.equal(context.data.publicMode, false);
  assert.equal(context.saves, 1);
  assert.match(context.sent[0].message, /قفل/);
});

test("قفل يرفض غير المطور ولا يغيّر الوضع", async () => {
  const context = createContext(false);
  context.data.publicMode = true;
  assert.equal(await closeCommand(...context.args), false);
  assert.equal(context.data.publicMode, true);
  assert.equal(context.saves, 0);
});

test("اختصارات فتح وقفل مسجلة", () => {
  assert.deepEqual(openCommand.aliases, ["open", "فتح_عام"]);
  assert.deepEqual(closeCommand.aliases, ["close", "قفل_عام"]);
});
