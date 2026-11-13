"use strict";

/*
 * QUASAR-SHADOW shared group-operation scheduler.
 * All thread reads and group nickname/title writes are serialized per API session.
 * It does not retry failed changes automatically; rate-limit errors pause queued work.
 */

const states = new WeakMap();
const installed = new WeakSet();

const DEFAULTS = Object.freeze({
  maxQueueSize: 300,
  baseBackoffMs: 60000,
  maxBackoffMs: 900000,
  threadInfoDelayMs: 1000,
  threadListDelayMs: 1500,
  nicknameDelayMs: 900,
  groupNameDelayMs: 900
});

const METHOD_KINDS = Object.freeze({
  getThreadInfo: "threadInfo",
  getThreadList: "threadList",
  gcname: "groupName",
  setGroupName: "groupName",
  setThreadName: "groupName"
});

const NICKNAME_METHODS = ["nickname", "changeNickname", "setNickname"];
const GROUP_NAME_METHODS = ["gcname", "setGroupName", "setThreadName"];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function getOptions(options) {
  const merged = { ...DEFAULTS, ...(options || {}) };
  for (const key of Object.keys(DEFAULTS)) {
    if (!Number.isFinite(merged[key]) || merged[key] < 0) merged[key] = DEFAULTS[key];
  }
  return merged;
}

function makeState(api, options) {
  const opts = getOptions(options);
  const state = {
    api,
    options: opts,
    queue: [],
    pending: new Map(),
    draining: false,
    activeKind: null,
    activeKey: null,
    lastStartedAt: 0,
    lastKind: null,
    blockedUntil: 0,
    failures: 0,
    successStreak: 0,
    sequence: 0,
    lastNoticeAt: 0,
    originalMethods: new Map(),
    stats: {
      total: 0,
      succeeded: 0,
      failed: 0,
      deduplicated: 0,
      byKind: Object.create(null)
    }
  };
  states.set(api, state);
  return state;
}

function stateFor(api, options) {
  if (!api || (typeof api !== "object" && typeof api !== "function")) {
    throw new TypeError("A valid Messenger API session is required");
  }
  return states.get(api) || makeState(api, options);
}

function stableKey(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function errorText(error) {
  const parts = [error && error.message, error && error.code, error && error.error, error && error.statusCode];
  try { parts.push(JSON.stringify(error)); } catch (_) {}
  return parts.filter(value => value !== undefined && value !== null).join(" ").toLowerCase();
}

function isRateLimitError(error) {
  const message = errorText(error);
  if (/rate[\s_-]*limit|too many requests|request limit|temporarily blocked|http\s*429|\b429\b/.test(message)) {
    return true;
  }
  const codes = [error && error.code, error && error.error, error && error.statusCode]
    .map(value => Number(value));
  return codes.some(code => [10, 368, 429, 1545012, 1675004].includes(code));
}

function invokeOriginal(api, method, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    let result;
    try {
      result = method.apply(api, [...args, (error, value) => finish(error, value)]);
    } catch (error) {
      finish(error);
      return;
    }

    if (result && typeof result.then === "function") {
      result.then(value => finish(null, value), error => finish(error));
    } else if (method.length <= args.length) {
      finish(null, result);
    }
  });
}

function delayFor(state, kind) {
  switch (kind) {
    case "threadInfo": return state.options.threadInfoDelayMs;
    case "threadList": return state.options.threadListDelayMs;
    case "nickname": return state.options.nicknameDelayMs;
    case "groupName": return state.options.groupNameDelayMs;
    default: return 1000;
  }
}

function rateLimitCooldown(state) {
  state.failures = Math.min(state.failures + 1, 5);
  const cooldown = Math.min(
    state.options.baseBackoffMs * (2 ** (state.failures - 1)),
    state.options.maxBackoffMs
  );
  state.blockedUntil = Date.now() + cooldown;
  state.successStreak = 0;

  if (Date.now() - state.lastNoticeAt >= 10000) {
    console.log(
      "[SHADOW OPERATION GUARD] Rate limit detected; pausing group operations for",
      Math.ceil(cooldown / 1000), "seconds."
    );
    state.lastNoticeAt = Date.now();
  }
}

function settleSuccess(state) {
  state.stats.succeeded++;
  state.successStreak++;
  if (state.successStreak >= 8 && state.failures > 0) {
    state.failures--;
    state.successStreak = 0;
  }
}

function enqueue(api, kind, key, run, priority = 0, options) {
  const state = stateFor(api, options);
  const existing = state.pending.get(key);
  if (existing) {
    state.stats.deduplicated++;
    return existing;
  }

  if (state.queue.length >= state.options.maxQueueSize) {
    return Promise.reject(new Error("SHADOW group-operation queue is full; request was not sent"));
  }

  let resolveTask;
  let rejectTask;
  const promise = new Promise((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });

  const task = {
    kind,
    key,
    run,
    priority: Number.isFinite(priority) ? priority : 0,
    sequence: ++state.sequence,
    resolve: resolveTask,
    reject: rejectTask,
    promise
  };

  state.pending.set(key, promise);
  state.queue.push(task);
  state.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
  scheduleDrain(state);
  return promise;
}

function scheduleDrain(state) {
  if (state.draining) return;
  setImmediate(() => drain(state).catch(error => {
    console.log("[SHADOW OPERATION GUARD] Queue error:", error && (error.message || error));
  }));
}

async function drain(state) {
  if (state.draining) return;
  state.draining = true;

  try {
    while (state.queue.length) {
      const task = state.queue.shift();

      const requiredGap = Math.max(
        delayFor(state, state.lastKind),
        delayFor(state, task.kind)
      );
      const spacingWait = state.lastStartedAt
        ? Math.max(0, requiredGap - (Date.now() - state.lastStartedAt))
        : 0;
      const cooldownWait = Math.max(0, state.blockedUntil - Date.now());
      const waitMs = Math.max(spacingWait, cooldownWait);
      if (waitMs > 0) await sleep(waitMs);

      // Re-check cooldown because another request may have extended it.
      if (Date.now() < state.blockedUntil) {
        state.queue.unshift(task);
        continue;
      }

      state.activeKind = task.kind;
      state.activeKey = task.key;
      state.lastKind = task.kind;
      state.lastStartedAt = Date.now();
      state.stats.total++;
      state.stats.byKind[task.kind] = (state.stats.byKind[task.kind] || 0) + 1;

      try {
        const value = await task.run();
        settleSuccess(state);
        task.resolve(value);
      } catch (error) {
        state.stats.failed++;
        state.successStreak = 0;
        if (isRateLimitError(error)) rateLimitCooldown(state);
        task.reject(error);
      } finally {
        state.pending.delete(task.key);
        state.activeKind = null;
        state.activeKey = null;
      }
    }
  } finally {
    state.draining = false;
    if (state.queue.length) scheduleDrain(state);
  }
}

function createQueuedWrapper(api, state, methodName, kind, original) {
  if (typeof original !== "function") return null;

  const wrapped = function (...input) {
    const args = input.slice();
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const key = `${kind}:${methodName}:${stableKey(args)}`;

    const run = async () => {
      const value = await invokeOriginal(api, original, args);
      return kind === "threadInfo"
        ? validateThreadInfoResponse(value)
        : kind === "threadList"
          ? validateThreadListResponse(value)
          : value;
    };

    const promise = enqueue(api, kind, key, run);

    if (callback) {
      promise.then(
        value => callback(null, value),
        error => callback(error)
      );
    }

    return promise;
  };

  Object.defineProperty(wrapped, "__shadowQueued", { value: true });
  Object.defineProperty(wrapped, "__shadowOriginal", { value: original });

  return wrapped;
}

function wrapMethod(api, state, methodName, kind, original) {
  const wrapped = createQueuedWrapper(api, state, methodName, kind, original);
  if (!wrapped) return false;

  try {
    api[methodName] = wrapped;
    if (api[methodName] !== wrapped) return false;
    state.originalMethods.set(methodName, original);
    return true;
  } catch (_) {
    return false;
  }
}

/*
 * Installs one shared wrapper on all supported aliases.
 * If any assignment fails, restore the original own-property descriptors.
 */
function installAliasWrapper(api, state, aliases, wrapper, original) {
  const snapshots = aliases.map(name => ({
    name,
    hadOwn: Object.prototype.hasOwnProperty.call(api, name),
    descriptor: Object.getOwnPropertyDescriptor(api, name)
  }));

  try {
    for (const name of aliases) {
      if (!Reflect.set(api, name, wrapper, api) || api[name] !== wrapper) {
        throw new Error(`Could not install wrapper for ${name}`);
      }
    }

    for (const name of aliases) {
      state.originalMethods.set(name, original);
    }

    return true;
  } catch (_) {
    for (const item of snapshots.slice().reverse()) {
      try {
        if (item.hadOwn) {
          Object.defineProperty(api, item.name, item.descriptor);
        } else {
          Reflect.deleteProperty(api, item.name);
        }
      } catch (_) {}
      state.originalMethods.delete(item.name);
    }

    return false;
  }
}

function installThreadOperationGuard(api, options = {}) {
  const state = stateFor(api, options);
  if (installed.has(api)) return { installed: true, alreadyInstalled: true };

  const wrapped = [];
  const warnings = [];

  for (const methodName of ["getThreadInfo", "getThreadList"]) {
    const method = api[methodName];
    if (typeof method !== "function") {
      warnings.push(`${methodName} is unavailable`);
      continue;
    }
    if (method.__shadowQueued) {
      state.originalMethods.set(methodName, method.__shadowOriginal || method);
      continue;
    }
    if (wrapMethod(api, state, methodName, METHOD_KINDS[methodName], method)) wrapped.push(methodName);
    else warnings.push(`${methodName} could not be wrapped`);
  }

  const nicknameMethodName = NICKNAME_METHODS.find(name => typeof api[name] === "function");
  if (nicknameMethodName) {
    const raw = api[nicknameMethodName].__shadowOriginal || api[nicknameMethodName];
    const wrapper = createQueuedWrapper(api, state, nicknameMethodName, "nickname", raw);

    if (wrapper && installAliasWrapper(api, state, NICKNAME_METHODS, wrapper, raw)) {
      wrapped.push("nickname");
    } else {
      warnings.push("nickname method could not be wrapped; original methods restored");
    }
  } else {
    warnings.push("nickname method is unavailable");
  }

  const groupNameMethodName = GROUP_NAME_METHODS.find(name => typeof api[name] === "function");
  if (groupNameMethodName) {
    const raw = api[groupNameMethodName].__shadowOriginal || api[groupNameMethodName];
    const wrapper = createQueuedWrapper(api, state, groupNameMethodName, "groupName", raw);

    if (wrapper && installAliasWrapper(api, state, GROUP_NAME_METHODS, wrapper, raw)) {
      wrapped.push("groupName");
    } else {
      warnings.push("group-name method could not be wrapped; original methods restored");
    }
  } else {
    warnings.push("group-name method is unavailable");
  }

  installed.add(api);
  if (wrapped.length) {
    console.log("[SHADOW OPERATION GUARD] Installed:", wrapped.join(", "));
  }
  if (warnings.length) {
    console.log("[SHADOW OPERATION GUARD] Warnings:", warnings.join("; "));
  }
  return { installed: true, alreadyInstalled: false, wrapped, warnings };
}

function callSafe(api, methodName, kind, args, priority = 0) {
  if (!api || typeof api[methodName] !== "function") {
    return Promise.reject(new Error(`Messenger API method ${methodName} is unavailable`));
  }

  if (api[methodName].__shadowQueued) {
    return api[methodName](...args);
  }

  const state = stateFor(api);
  const original = state.originalMethods.get(methodName) || api[methodName];
  const key = `${kind}:${methodName}:${stableKey(args)}`;
  const run = async () => {
    const value = await invokeOriginal(api, original, args);
    return kind === "threadInfo" ? validateThreadInfoResponse(value) : kind === "threadList" ? validateThreadListResponse(value) : value;
  };
  return enqueue(api, kind, key, run, priority);
}

function validateThreadInfoResponse(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new Error("Unexpected thread response");
  }
  return value;
}

function validateThreadListResponse(value) {
  if (!Array.isArray(value)) {
    throw new Error("Unexpected thread response: thread list must be an array.");
  }
  return value;
}

function getThreadInfoSafe(api, ids, options = {}) {
  return callSafe(api, "getThreadInfo", "threadInfo", [ids], options.priority || 0);
}

function getThreadListSafe(api, limit, cursor, tags, options = {}) {
  return callSafe(api, "getThreadList", "threadList", [limit, cursor, tags], options.priority || 0);
}

function isCoolingDown(api) {
  const state = api && states.get(api);
  return Boolean(state && Date.now() < state.blockedUntil);
}

function getCooldownRemaining(api) {
  const state = api && states.get(api);
  return state ? Math.max(0, state.blockedUntil - Date.now()) : 0;
}

function getThreadOperationStatus(api) {
  const state = api && states.get(api);
  if (!state) return null;
  return {
    queued: state.queue.length,
    inFlight: Boolean(state.activeKind),
    activeKind: state.activeKind,
    blockedForMs: Math.max(0, state.blockedUntil - Date.now()),
    failures: state.failures,
    lastKind: state.lastKind,
    stats: {
      ...state.stats,
      byKind: { ...state.stats.byKind }
    }
  };
}

module.exports = {
  installThreadOperationGuard,
  getThreadInfoSafe,
  getThreadListSafe,
  getThreadOperationStatus,
  isCoolingDown,
  getCooldownRemaining,
  isRateLimitError
};
