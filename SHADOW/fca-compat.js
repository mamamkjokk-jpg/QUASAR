"use strict";

/**
 * Keep QUASAR's historical SHADOW API names while using
 * @dongdev/fca-unofficial's flat FCA-compatible API.
 * No network calls or login attempts are made by this module.
 */
function asPromise(api, method, args, label) {
  if (typeof method !== "function") {
    return Promise.reject(new Error(`واجهة ${label || "FCA"} غير متاحة`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`انتهت مهلة واجهة ${label || "FCA"}`)), 60000);

    try {
      const expectsCallback = method.length > args.length;
      const result = expectsCallback
        ? method.apply(api, [...args, (error, value) => finish(error, value)])
        : method.apply(api, args);

      if (result && typeof result.then === "function") {
        result.then(value => finish(null, value), error => finish(error));
      } else if (!expectsCallback) {
        finish(null, result);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function withOptionalCallback(promise, callback) {
  if (typeof callback === "function") {
    promise.then(value => callback(null, value), error => callback(error));
  }
  return promise;
}

function defineAlias(api, alias, target, transform = args => args) {
  if (typeof api[alias] === "function" || typeof api[target] !== "function") return false;
  const targetMethod = api[target];
  Object.defineProperty(api, alias, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function (...input) {
      const args = input.slice();
      const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
      let mapped;
      try {
        mapped = transform(args);
      } catch (error) {
        return withOptionalCallback(Promise.reject(error), callback);
      }
      const promise = asPromise(api, targetMethod, mapped, target);
      return withOptionalCallback(promise, callback);
    }
  });
  return true;
}

function installBulkThreadInfo(api) {
  const original = api.getThreadInfo;
  if (typeof original !== "function" || original.__quasarCompat) return false;

  const wrapped = function (threadIDs, ...rest) {
    const callback = typeof rest[rest.length - 1] === "function" ? rest.pop() : null;
    const args = rest;
    let operation;

    if (!Array.isArray(threadIDs)) {
      operation = asPromise(api, original, [String(threadIDs), ...args], "getThreadInfo");
    } else {
      // Older QUASAR code expects an ID -> thread-info object map.
      // Fetch sequentially to avoid a burst of concurrent group requests.
      operation = (async () => {
        const result = Object.create(null);
        for (const id of [...new Set(threadIDs.map(value => String(value)))]) {
          result[id] = await asPromise(api, original, [id, ...args], "getThreadInfo");
        }
        return result;
      })();
    }
    return withOptionalCallback(operation, callback);
  };

  Object.defineProperty(wrapped, "__quasarCompat", { value: true });
  Object.defineProperty(api, "getThreadInfo", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapped
  });
  return true;
}

function installFcaCompat(api) {
  if (!api || (typeof api !== "object" && typeof api !== "function")) {
    throw new TypeError("كائن FCA غير صالح");
  }

  const installed = [];
  installBulkThreadInfo(api) && installed.push("getThreadInfo[]");

  // New library names -> the aliases used by SHADOW and old commands.
  for (const alias of ["nickname", "setNickname"]) {
    if (defineAlias(api, alias, "changeNickname")) installed.push(alias);
  }
  for (const alias of ["gcname", "setGroupName", "setThreadName"]) {
    if (defineAlias(api, alias, "setTitle")) installed.push(alias);
  }

  // Legacy SHADOW used setMessageReactionMqtt(reaction, messageID, threadID).
  if (typeof api.setMessageReactionMqtt !== "function" && typeof api.setMessageReaction === "function") {
    if (defineAlias(api, "setMessageReactionMqtt", "setMessageReaction", args => args.slice(0, 3))) {
      installed.push("setMessageReactionMqtt");
    }
  }

  // Legacy Goat/FCA code may use gcmember("remove", userID, threadID).
  if (typeof api.gcmember !== "function" && typeof api.removeUserFromGroup === "function") {
    Object.defineProperty(api, "gcmember", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function (action, userID, threadID, callback) {
        if (String(action).toLowerCase() !== "remove") {
          const error = new Error("عملية gcmember المدعومة هنا هي remove فقط");
          if (typeof callback === "function") callback(error);
          return Promise.reject(error);
        }
        return withOptionalCallback(
          asPromise(api, api.removeUserFromGroup, [String(userID), String(threadID)], "removeUserFromGroup"),
          callback
        );
      }
    });
    installed.push("gcmember");
  }

  return { installed };
}

module.exports = installFcaCompat;
module.exports.asPromise = asPromise;
