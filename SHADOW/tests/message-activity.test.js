"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMessageActivity } = require("../message-activity");

test("يضع القلب على أحدث رسالة للمطور بعد 120 رسالة في المجموعة", async () => {
  const reactions = [];
  const activity = createMessageActivity({
    developerIds: ["dev-1"],
    react: async (messageID, threadID) => reactions.push({ messageID, threadID })
  });

  for (let i = 1; i <= 119; i++) {
    await activity.record({
      type: "message",
      threadID: "group-1",
      senderID: i === 1 ? "dev-1" : "user-1",
      messageID: `m-${i}`
    }, () => true);
  }

  assert.equal(reactions.length, 0);

  await activity.record({
    type: "message",
    threadID: "group-1",
    senderID: "user-1",
    messageID: "m-120"
  }, () => true);

  assert.deepEqual(reactions, [
    { messageID: "m-1", threadID: "group-1" }
  ]);
});

test("عداد كل مجموعة مستقل عن المجموعات الأخرى", async () => {
  const reactions = [];
  const activity = createMessageActivity({
    developerIds: ["dev-1"],
    react: async (messageID, threadID) => reactions.push({ messageID, threadID })
  });

  for (let i = 1; i <= 60; i++) {
    await activity.record({
      type: "message",
      threadID: "group-1",
      senderID: i === 1 ? "dev-1" : "user-1",
      messageID: `a-${i}`
    }, () => true);

    await activity.record({
      type: "message",
      threadID: "group-2",
      senderID: i === 1 ? "dev-1" : "user-1",
      messageID: `b-${i}`
    }, () => true);
  }

  assert.equal(reactions.length, 0);
});

test("لا يتفاعل إذا لم يرسل المطور أي رسالة في المجموعة", async () => {
  const reactions = [];
  const activity = createMessageActivity({
    developerIds: ["dev-1"],
    react: async (...args) => reactions.push(args)
  });

  for (let i = 1; i <= 120; i++) {
    await activity.record({
      type: "message",
      threadID: "group-1",
      senderID: "user-1",
      messageID: `m-${i}`
    }, () => true);
  }

  assert.equal(reactions.length, 0);
});
