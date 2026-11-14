"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const installFcaCompat = require("../fca-compat");

test("aliases group title and member nickname methods to the new FCA names", async () => {
  const calls = [];
  const api = {
    async setTitle(title, threadID) { calls.push(["title", title, threadID]); return "title-ok"; },
    async changeNickname(nickname, threadID, userID) { calls.push(["nick", nickname, threadID, userID]); return "nick-ok"; }
  };
  installFcaCompat(api);
  assert.equal(await api.gcname("new title", "100"), "title-ok");
  assert.equal(await api.setGroupName("other title", "200"), "title-ok");
  assert.equal(await api.nickname("member", "100", "300"), "nick-ok");
  assert.equal(await api.setNickname("member2", "100", "301"), "nick-ok");
  assert.deepEqual(calls, [
    ["title", "new title", "100"],
    ["title", "other title", "200"],
    ["nick", "member", "100", "300"],
    ["nick", "member2", "100", "301"]
  ]);
});

test("bulk getThreadInfo is converted to sequential per-thread calls and a map", async () => {
  const calls = [];
  let active = 0;
  const api = {
    async getThreadInfo(id) {
      active++;
      assert.equal(active, 1, "requests must not overlap");
      calls.push(String(id));
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return { threadID: String(id), threadName: `Group ${id}` };
    }
  };
  installFcaCompat(api);
  const result = await api.getThreadInfo(["100", "200", "100"]);
  assert.deepEqual(calls, ["100", "200"]);
  assert.equal(result["100"].threadName, "Group 100");
  assert.equal(result["200"].threadName, "Group 200");
});

test("bulk getThreadInfo supports the legacy callback form", async () => {
  const api = { async getThreadInfo(id) { return { threadID: String(id) }; } };
  installFcaCompat(api);
  const result = await new Promise((resolve, reject) => {
    api.getThreadInfo(["thread9", "thread8"], (error, value) => error ? reject(error) : resolve(value));
  });
  assert.deepEqual(Object.keys(result), ["thread9", "thread8"]);
});

test("reaction alias forwards reaction, message ID, and thread ID", async () => {
  const calls = [];
  const api = {
    setMessageReaction(reaction, messageID, threadID, callback) {
      calls.push([reaction, messageID, threadID]);
      callback(null, true);
    }
  };
  installFcaCompat(api);
  assert.equal(await api.setMessageReactionMqtt("❤️", "m-1", "thread-1"), true);
  assert.deepEqual(calls, [["❤️", "m-1", "thread-1"]]);
});

test("native profile methods are left untouched", () => {
  const nativeBio = async () => "native-bio";
  const nativeAvatar = async () => "native-avatar";
  const api = { changeBio: nativeBio, changeAvatar: nativeAvatar };
  installFcaCompat(api);
  assert.equal(api.changeBio, nativeBio);
  assert.equal(api.changeAvatar, nativeAvatar);
});
