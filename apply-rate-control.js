"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const files = {
  index: path.join(ROOT, "SHADOW/index.js"),
  guard: path.join(ROOT, "SHADOW/thread-info-guard.js"),
  queueTest: path.join(ROOT, "SHADOW/tests/thread-operation-queue.test.js"),
  patchGuard: path.join(ROOT, "patch/SHADOW/thread-info-guard.js"),
  patchTest: path.join(ROOT, "patch/SHADOW/tests/thread-operation-queue.test.js")
};

function stop(message) {
  console.error("STOP:", message);
  process.exit(1);
}

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    stop(`Required file missing or invalid: ${name}`);
  }
}

const indexOriginal = fs.readFileSync(files.index, "utf8");
const importPattern =
  /^([ \t]*const[ \t]*\{([^}]*)\}[ \t]*=[ \t]*require\(["']\.\/thread-info-guard["']\);[ \t]*)$/gm;

const importsFound = [...indexOriginal.matchAll(importPattern)];
if (importsFound.length !== 1) {
  stop(`Expected exactly one guard import; found ${importsFound.length}.`);
}

const imports = importsFound[0][2]
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

if (!imports.includes("installThreadOperationGuard")) {
  imports.push("installThreadOperationGuard");
}

const newImport =
  `const { ${imports.join(", ")} } = require("./thread-info-guard");`;

let index = indexOriginal.replace(importPattern, newImport);

const installCall = "  installThreadOperationGuard(api);";
const installCount =
  (index.match(/installThreadOperationGuard\s*\(\s*api\b/g) || []).length;

if (installCount > 1) {
  stop("Multiple guard installation calls found.");
}

if (installCount === 0) {
  const anchor = '  require("./ws3-profile-api")(api);';
  const count = index.split(anchor).length - 1;

  if (count !== 1) {
    stop(`Expected one installation anchor; found ${count}.`);
  }

  index = index.replace(anchor, `${anchor}\n\n${installCall}`);
}

const contents = {
  index,
  guard: fs.readFileSync(files.patchGuard, "utf8"),
  queueTest: fs.readFileSync(files.patchTest, "utf8")
};

const targets = [
  { target: files.index, content: contents.index },
  { target: files.guard, content: contents.guard },
  { target: files.queueTest, content: contents.queueTest }
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(ROOT, "backups", `thread-operation-guard-${stamp}`);
const tempFiles = [];
const existed = new Map();

try {
  for (let i = 0; i < targets.length; i++) {
    const temp = `${targets[i].target}.rate-control-${process.pid}.tmp.js`;
    fs.writeFileSync(temp, targets[i].content, { encoding: "utf8", flag: "wx" });
    tempFiles.push(temp);
    execFileSync(process.execPath, ["--check", temp], { stdio: "pipe" });
  }
} catch (error) {
  for (const file of tempFiles) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
  }
  stop(`Pre-install validation failed: ${error.message}`);
}

try {
  fs.mkdirSync(backupDir, { recursive: true });

  for (const item of targets) {
    existed.set(item.target, fs.existsSync(item.target));

    if (existed.get(item.target)) {
      const destination = path.join(backupDir, path.relative(ROOT, item.target));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(item.target, destination);
    }
  }

  for (let i = 0; i < targets.length; i++) {
    fs.renameSync(tempFiles[i], targets[i].target);
  }
} catch (error) {
  const rollbackErrors = [];

  for (const item of targets) {
    try {
      if (existed.get(item.target)) {
        const saved = path.join(backupDir, path.relative(ROOT, item.target));
        if (!fs.existsSync(saved)) throw new Error(`Backup missing: ${saved}`);
        fs.copyFileSync(saved, item.target);
      } else if (existed.has(item.target)) {
        fs.rmSync(item.target, { force: true });
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError.message);
    }
  }

  for (const file of tempFiles) {
    try { fs.rmSync(file, { force: true }); } catch (_) {}
  }

  stop(
    `Installation failed: ${error.message}. ` +
    `Backup: ${path.relative(ROOT, backupDir)}. ` +
    `Rollback errors: ${rollbackErrors.join(" | ") || "none"}`
  );
}

console.log("RATE CONTROL PATCH APPLIED.");
console.log("Backup:", path.relative(ROOT, backupDir));
console.log("The bot was NOT started.");
