"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Jimp, loadFont } = require("jimp");

const WIDTH = 1200;
const HEIGHT = 820;

const COLORS = {
  background: 0x0a1020ff,
  panel: 0x121d31ff,
  panel2: 0x17253cff,
  border: 0x263a55ff,
  white: 0xeaf3ffff,
  muted: 0x91a6c1ff,
  cyan: 0x45d6eaff,
  green: 0x43d6a0ff,
  orange: 0xffbd69ff,
  red: 0xff737dff,
  track: 0x26364dff
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "N/A";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${value.toFixed(1)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "N/A";

  let seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;

  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;

  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  return `${days}d  ${hours}h  ${minutes}m  ${seconds}s`;
}

function directorySize(directory) {
  let total = 0;

  const excludedDirectories = new Set([
    "node_modules",
    ".git",
    ".cache"
  ]);

  const excludedFiles = new Set([
    "config.json",
    "fca-config.json",
    ".env"
  ]);

  function walk(current) {
    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (excludedFiles.has(entry.name)) continue;
      if (/^appState.*\.json$/i.test(entry.name)) continue;
      if (/\.(tar\.gz|zip)$/i.test(entry.name)) continue;

      try {
        total += fs.statSync(fullPath).size;
      } catch (_) {}
    }
  }

  walk(directory);
  return total;
}

function getPanelStatus(statusFile) {
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const startedAt = Date.parse(status.startedAt);
    const pid = Number(status.pid);

    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return { online: false, uptime: "N/A", startedAt: "N/A" };
    }

    if (!Number.isInteger(pid) || pid <= 0) {
      return { online: false, uptime: "N/A", startedAt: "N/A" };
    }

    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "EPERM") {
        return { online: false, uptime: "N/A", startedAt: "N/A" };
      }
    }

    return {
      online: true,
      uptime: formatDuration(Math.max(0, Date.now() - startedAt)),
      startedAt: new Date(startedAt).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    };
  } catch (_) {
    return { online: false, uptime: "N/A", startedAt: "N/A" };
  }
}

function getSystemMetrics(dataDir, projectDir, statusFile) {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = Math.max(0, totalRam - freeRam);

  let storage = {
    total: null,
    used: null,
    free: null,
    percent: null
  };

  try {
    const stat = fs.statfsSync(dataDir);
    const blockSize = Number(stat.bsize);
    const total = Number(stat.blocks) * blockSize;
    const free = Number(stat.bavail) * blockSize;

    if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
      storage = {
        total,
        used: Math.max(0, total - free),
        free,
        percent: Math.round(((total - free) / total) * 100)
      };
    }
  } catch (_) {}

  const android = process.platform === "android" ||
    String(process.env.PREFIX || "").includes("com.termux");

  const cpus = os.cpus();
  const load = os.loadavg();

  return {
    panel: getPanelStatus(statusFile),
    ram: {
      total: totalRam,
      used: usedRam,
      free: freeRam,
      percent: totalRam > 0 ? Math.round((usedRam / totalRam) * 100) : null
    },
    storage,
    projectSize: directorySize(projectDir),
    hosting: android ? "TERMUX / ANDROID" :
      process.platform === "linux" ? "LINUX HOST" : process.platform.toUpperCase(),
    provider: "Not detected",
    os: `${os.type()} ${os.release()}`,
    architecture: process.arch.toUpperCase(),
    node: process.version,
    hostname: os.hostname() || "N/A",
    cpu: cpus.length ? `${cpus.length} cores` : "N/A",
    load: load.every(Number.isFinite) ? load.map(v => v.toFixed(2)).join(" / ") : "N/A"
  };
}

function rect(image, x, y, width, height, color) {
  const x2 = Math.min(WIDTH, x + width);
  const y2 = Math.min(HEIGHT, y + height);

  for (let py = Math.max(0, y); py < y2; py++) {
    for (let px = Math.max(0, x); px < x2; px++) {
      image.setPixelColor(color, px, py);
    }
  }
}

function text(image, font, value, x, y, maxWidth = 500) {
  image.print({
    font,
    x,
    y,
    text: String(value),
    maxWidth
  });
}

function progressBar(image, x, y, width, percent, color) {
  rect(image, x, y, width, 12, COLORS.track);

  if (Number.isFinite(percent)) {
    const filled = Math.max(0, Math.min(width, Math.round(width * percent / 100)));
    if (filled > 0) rect(image, x, y, filled, 12, color);
  }
}

async function createSessionCard(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.resolve(__dirname, ".."));
  const projectDir = path.resolve(options.projectDir || path.resolve(__dirname, ".."));
  const statusFile = path.join(dataDir, "panel-status.json");

  const metrics = getSystemMetrics(dataDir, projectDir, statusFile);

  const fontRoot = path.resolve(
    path.dirname(require.resolve("@jimp/plugin-print")),
    "../fonts/open-sans"
  );

  const font = async (size, color) => {
    const fontPath = path.join(
      fontRoot,
      `open-sans-${size}-${color}`,
      `open-sans-${size}-${color}.fnt`
    );
    if (!fs.existsSync(fontPath)) {
      throw new Error(`Font file not found: ${fontPath}`);
    }
    return loadFont(fontPath);
  };

  const [f12, f16, f32, f64] = await Promise.all([
    font(8, "white"),
    font(16, "white"),
    font(32, "white"),
    font(64, "white")
  ]);

  const image = new Jimp({
    width: WIDTH,
    height: HEIGHT,
    color: COLORS.background
  });

  // Header
  rect(image, 0, 0, WIDTH, 7, COLORS.cyan);
  text(image, f64, "QUASAR", 48, 35, 400);
  text(image, f16, "SYSTEM OVERVIEW  /  HOSTING DASHBOARD", 52, 112, 700);
  text(image, f12, `GENERATED ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`, 800, 64, 350);
  rect(image, 48, 155, 1104, 2, COLORS.border);

  // Panel status
  rect(image, 48, 180, 1104, 125, COLORS.panel);
  rect(image, 48, 180, 6, 125, metrics.panel.online ? COLORS.green : COLORS.red);
  text(image, f12, "PANEL STATUS", 76, 199, 250);
  text(image, f32, metrics.panel.online ? "ONLINE" : "OFFLINE", 76, 230, 350);
  text(image, f12, "PANEL UPTIME", 470, 199, 250);
  text(image, f32, metrics.panel.uptime, 470, 230, 500);
  text(image, f12, `STARTED: ${metrics.panel.startedAt}`, 850, 240, 270);

  // RAM card
  rect(image, 48, 330, 530, 180, COLORS.panel);
  text(image, f16, "SYSTEM MEMORY", 76, 352, 400);
  text(image, f32, formatBytes(metrics.ram.used), 76, 392, 300);
  text(image, f12, `USED / ${formatBytes(metrics.ram.total)} TOTAL`, 78, 440, 400);
  progressBar(image, 78, 475, 450, metrics.ram.percent, COLORS.cyan);
  text(image, f12, `FREE: ${formatBytes(metrics.ram.free)}   ${metrics.ram.percent ?? "N/A"}% USED`, 78, 485, 450);

  // Storage card
  rect(image, 622, 330, 530, 180, COLORS.panel);
  text(image, f16, "DEVICE STORAGE", 650, 352, 400);
  text(image, f32, formatBytes(metrics.storage.used), 650, 392, 300);
  text(image, f12, `USED / ${formatBytes(metrics.storage.total)} TOTAL`, 652, 440, 400);
  progressBar(image, 652, 475, 450, metrics.storage.percent, COLORS.green);
  text(image, f12, `FREE: ${formatBytes(metrics.storage.free)}   ${metrics.storage.percent ?? "N/A"}% USED`, 652, 485, 450);

  // Project and hosting
  rect(image, 48, 535, 530, 115, COLORS.panel);
  text(image, f16, "PROJECT FOOTPRINT", 76, 555, 400);
  text(image, f32, formatBytes(metrics.projectSize), 76, 590, 400);
  text(image, f12, "SOURCE FILES (EXCLUDES DEPENDENCIES / SECRETS)", 78, 630, 460);

  rect(image, 622, 535, 530, 115, COLORS.panel);
  text(image, f16, "HOSTING ENVIRONMENT", 650, 555, 400);
  text(image, f32, metrics.hosting, 650, 590, 450);
  text(image, f12, `PROVIDER: ${metrics.provider}`, 652, 630, 450);

  // System details
  rect(image, 48, 675, 1104, 100, COLORS.panel2);
  text(image, f12, "SYSTEM", 76, 692, 200);
  text(image, f16, metrics.os, 76, 716, 450);
  text(image, f12, "RUNTIME", 460, 692, 200);
  text(image, f16, `${metrics.node}  /  ${metrics.architecture}`, 460, 716, 400);
  text(image, f12, "CPU / LOAD", 850, 692, 200);
  text(image, f12, `${metrics.cpu}  /  ${metrics.load}`, 850, 720, 280);

  return image.getBuffer("image/png");
}

module.exports = {
  createSessionCard,
  formatBytes,
  formatDuration,
  getSystemMetrics
};
