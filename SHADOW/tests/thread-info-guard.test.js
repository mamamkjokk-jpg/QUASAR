"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getThreadInfoSafe,
  getThreadListSafe
} = require("../thread-info-guard");

test("معلومات مجموعة واحدة تُقبل ككائن", async () => {
  const expected = { threadID: "12345", threadName: "Test" };
  const result = await getThreadInfoSafe({
    getThreadInfo: async id => {
      assert.equal(id, "12345");
      return expected;
    }
  }, "12345");

  assert.deepEqual(result, expected);
});

test("معلومات عدة مجموعات تُقبل كخريطة نتائج", async () => {
  const expected = {
    "12345": { threadID: "12345" },
    "67890": { threadID: "67890" }
  };

  const result = await getThreadInfoSafe({
    getThreadInfo: async ids => {
      assert.deepEqual(ids, ["12345", "67890"]);
      return expected;
    }
  }, ["12345", "67890"]);

  assert.deepEqual(result, expected);
});

test("طلبات معلومات المجموعات تنفذ بالتتابع", async () => {
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;

  const api = {
    getThreadInfo: async id => {
      active++;
      maximumActive = Math.max(maximumActive, active);

      if (id === "first") {
        await new Promise(resolve => {
          releaseFirst = resolve;
        });
      }

      active--;
      return { threadID: id };
    }
  };

  const first = getThreadInfoSafe(api, "first");
  const second = getThreadInfoSafe(api, "second");

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximumActive, 1);

  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maximumActive, 1);
});

test("القائمة الفارغة نتيجة صحيحة لنهاية الصفحات", async () => {
  const result = await getThreadListSafe({
    getThreadList: async () => []
  }, 100, null, ["INBOX"]);

  assert.deepEqual(result, []);
});

test("رفض نتيجة قائمة المجموعات غير المصفوفة", async () => {
  await assert.rejects(
    getThreadListSafe({
      getThreadList: async () => ({ threadID: "12345" })
    }, 100, null, ["INBOX"]),
    /thread list must be an array/
  );
});

test("رفض نتيجة معلومات المجموعة الفارغة", async () => {
  await assert.rejects(
    getThreadInfoSafe({
      getThreadInfo: async () => ({})
    }, "12345"),
    /Unexpected thread response/
  );
});
