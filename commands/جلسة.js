"use strict";

const path = require("path");
const { createSessionCard } = require("../SHADOW/session-card");

module.exports = async (api, event) => {
  try {
    const dataDir = path.resolve(
      process.env.SHADOW_DATA_DIR || path.resolve(__dirname, "..")
    );

    const projectDir = path.resolve(__dirname, "..");

    const image = await createSessionCard({
      dataDir,
      projectDir
    });

    return await api.sendMessage({
      body: "QUASAR SYSTEM OVERVIEW",
      attachment: image
    }, event.threadID);
  } catch (error) {
    console.log("QUASAR SESSION CARD ERROR:", error?.stack || error);

    return api.sendMessage(
      "Unable to generate the QUASAR system dashboard image.",
      event.threadID
    );
  }
};
