"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  installThreadOperationGuard,
  getThreadOperationStatus,
  isRateLimitError
} = require("../thread-info-guard");

function fastOptions(extra = {}) {
  return {
    threadInfoDelayMs: 0,
    threadListDelayMs: 0,
    nicknameDelayMs: 0,
    groupNameDelayMs: 0,
    baseBackoffMs: 40,
    maxBackoffMs: 80,
    ...extra
  };
}

test("جميع قراءات القروبات وتعديلات الكنيات تمر بالتتابع دون تداخل", async () => {
  let active = 0;
  let maxActive = 0;
  const begin = async result => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 8));
    active--;
    return result;
  };

  const api = {
    getThreadInfo: ids => begin({ ids }),
    getThreadList: (limit, cursor, tags) => begin([{ limit, cursor, tags }]),
    nickname: (nickname, threadID, userID) => begin({ nickname, threadID, userID }),
    gcname: (name, threadID) => begin({ name, threadID })
  };

  installThreadOperationGuard(api, fastOptions());
  const results = await Promise.all([
    api.getThreadInfo(["100", "200"]),
    api.getThreadList(100, null, ["INBOX"]),
    api.nickname("new nick", "100", "200"),
    api.gcname("new title", "100")
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(results[0], { ids: ["100", "200"] });
  assert.deepEqual(results[1], [{ limit: 100, cursor: null, tags: ["INBOX"] }]);
  assert.deepEqual(results[2], { nickname: "new nick", threadID: "100", userID: "200" });
  assert.deepEqual(results[3], { name: "new title", threadID: "100" });
  assert.equal(getThreadOperationStatus(api).queued, 0);
});

test("طلبات getThreadInfo المتطابقة أثناء الانتظار تُدمج في طلب واحد", async () => {
  let calls = 0;
  const api = {
    getThreadInfo: async ids => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ids };
    }
  };

  installThreadOperationGuard(api, fastOptions());
  const [first, second] = await Promise.all([
    api.getThreadInfo(["123", "456"]),
    api.getThreadInfo(["123", "456"])
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(getThreadOperationStatus(api).stats.deduplicated, 1);
});

test("يدعم واجهة callback القديمة مع وعد Promise", async () => {
  const api = {
    getThreadInfo: function (threadID, callback) {
      setTimeout(() => callback(null, { threadID }), 5);
    }
  };

  installThreadOperationGuard(api, fastOptions());
  const value = await api.getThreadInfo("777");
  assert.deepEqual(value, { threadID: "777" });

  const callbackValue = await new Promise((resolve, reject) => {
    api.getThreadInfo("888", (error, info) => error ? reject(error) : resolve(info));
  });
  assert.deepEqual(callbackValue, { threadID: "888" });
});

test("يوقف طابور العمليات مؤقتًا عند ظهور rate limit", async () => {
  let calls = 0;
  const api = {
    getThreadInfo: async ids => {
      calls++;
      if (calls === 1) {
        const error = new Error("HTTP 429: rate limit");
        error.code = 429;
        throw error;
      }
      return { ids };
    }
  };

  installThreadOperationGuard(api, fastOptions({ baseBackoffMs: 40, maxBackoffMs: 40 }));
  await assert.rejects(api.getThreadInfo("first"), /rate limit/i);
  assert.ok(getThreadOperationStatus(api).blockedForMs > 0);
  const result = await api.getThreadInfo("second");
  assert.deepEqual(result, { ids: "second" });
  assert.equal(calls, 2);
});


test("الاستجابة غير الصالحة لا تصنف كتجاوز سرعة ولا تفعّل التهدئة", async () => {
  const api = {
    getThreadInfo: async () => ({})
  };

  installThreadOperationGuard(api, fastOptions());

  await assert.rejects(
    api.getThreadInfo("invalid-response"),
    /Unexpected thread response/
  );

  assert.equal(isRateLimitError(new Error("Unexpected thread response")), false);
  assert.equal(getThreadOperationStatus(api).blockedForMs, 0);
});

test("تغليف setNickname وgcname يحافظ على Promise وCallback وتعمل الأسماء البديلة", async () => {
  const api = {
    setNickname: function (nickname, threadID, participantID, callback) {
      const event = { nickname, threadID, participantID };
      callback(null, event);
      return Promise.resolve(event);
    },
    gcname: function (name, threadID, callback) {
      const event = { name, threadID };
      callback(null, event);
      return Promise.resolve(event);
    }
  };

  const result = installThreadOperationGuard(api, fastOptions());

  assert.ok(result.wrapped.includes("nickname"));
  assert.ok(result.wrapped.includes("groupName"));
  assert.equal(api.nickname, api.setNickname);
  assert.equal(api.changeNickname, api.setNickname);
  assert.equal(api.setGroupName, api.gcname);
  assert.equal(api.setThreadName, api.gcname);

  const nicknameEvent = await api.setNickname("new nick", "100", "200");
  assert.deepEqual(nicknameEvent, {
    nickname: "new nick",
    threadID: "100",
    participantID: "200"
  });

  const callbackEvent = await new Promise((resolve, reject) => {
    api.nickname("callback nick", "100", "201", (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });

  assert.deepEqual(callbackEvent, {
    nickname: "callback nick",
    threadID: "100",
    participantID: "201"
  });

  const groupEvent = await api.gcname("new title", "100");
  assert.deepEqual(groupEvent, { name: "new title", threadID: "100" });
});

test("فشل تثبيت اسم بديل يعيد الخصائص الأصلية ولا يعلن نجاح التغليف", () => {
  const original = function (nickname, threadID, participantID, callback) {
    callback(null, { nickname, threadID, participantID });
  };

  const target = { setNickname: original };
  const api = new Proxy(target, {
    set(object, property, value, receiver) {
      if (property === "setNickname") return false;
      return Reflect.set(object, property, value, receiver);
    }
  });

  const result = installThreadOperationGuard(api, fastOptions());

  assert.equal(result.wrapped.includes("nickname"), false);
  assert.ok(result.warnings.some(message => message.includes("nickname")));
  assert.equal(target.setNickname, original);
  assert.equal(Object.prototype.hasOwnProperty.call(target, "nickname"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(target, "changeNickname"), false);
});
