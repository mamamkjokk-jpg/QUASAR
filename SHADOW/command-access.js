"use strict";

const DEVELOPER_ONLY_COMMANDS = new Set([
  "اسم", "الاسم", "nm",
  "كنيات", "nik",
  "محرك", "بيس",
  "setbio", "بايو", "bio", "changebio", "botbio",
  "صورة", "avatar", "changeavatar", "botavatar",
  "خروج", "leave",
  "command", "cmd",
  "فتح", "open", "فتح_عام",
  "قفل", "close", "قفل_عام"
]);

function canExecuteCommand({ cmd, isDeveloper, publicMode }) {
  if (DEVELOPER_ONLY_COMMANDS.has(String(cmd || "").toLowerCase())) {
    return isDeveloper === true;
  }

  return isDeveloper === true || publicMode === true;
}

module.exports = { canExecuteCommand, DEVELOPER_ONLY_COMMANDS };
