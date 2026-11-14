"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const command = require("../../commands/جلسة");

test("يرسل بطاقة QUASAR كصورة PNG", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quasar-panel-"));
  const previous = process.env.SHADOW_DATA_DIR;

  try {
    process.env.SHADOW_DATA_DIR = dir;

    fs.writeFileSync(
      path.join(dir, "panel-status.json"),
      JSON.stringify({
        startedAt: new Date(Date.now() - 65000).toISOString(),
        pid: process.pid
      })
    );

    let payload;

    await command({
      sendMessage(message, threadID) {
        payload = { message, threadID };
        return Promise.resolve();
      }
    }, { threadID: "test-group" });

    assert.equal(payload.threadID, "test-group");
    assert.equal(payload.message.body, "QUASAR SYSTEM OVERVIEW");
    assert.ok(Buffer.isBuffer(payload.message.attachment));
    assert.deepEqual(
      [...payload.message.attachment.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10]
    );
  } finally {
    if (previous === undefined) delete process.env.SHADOW_DATA_DIR;
    else process.env.SHADOW_DATA_DIR = previous;

    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("يرسل البطاقة حتى عند عدم وجود ملف حالة الواجهة", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quasar-panel-"));
  const previous = process.env.SHADOW_DATA_DIR;

  try {
    process.env.SHADOW_DATA_DIR = dir;

    let payload;

    await command({
      sendMessage(message, threadID) {
        payload = { message, threadID };
        return Promise.resolve();
      }
    }, { threadID: "test-group" });

    assert.equal(payload.message.body, "QUASAR SYSTEM OVERVIEW");
    assert.ok(Buffer.isBuffer(payload.message.attachment));
  } finally {
    if (previous === undefined) delete process.env.SHADOW_DATA_DIR;
    else process.env.SHADOW_DATA_DIR = previous;

    fs.rmSync(dir, { recursive: true, force: true });
  }
});
