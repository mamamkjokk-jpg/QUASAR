"use strict";

const { send, downloadImage, invoke } = require("../SHADOW/quasar-command-utils");

function firstImageAttachment(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  return attachments.find(item => {
    const type = String(item?.type || "").toLowerCase();
    return type === "photo" || type === "image" || /image\//i.test(String(item?.mimeType || item?.contentType || ""));
  }) || attachments.find(item => item && (item.url || item.largePreviewUrl || item.previewUrl));
}

function attachmentUrl(item) {
  return item?.largePreviewUrl || item?.previewUrl || item?.url || item?.href || null;
}

module.exports = async function changeAvatarCommand(api, event, args) {
  const threadID = String(event?.threadID || "");
  if (!threadID) return;

  if (typeof api.changeAvatar !== "function") {
    return send(api, event, "تغيير صورة الحساب غير متاح في مكتبة FCA المثبتة حاليًا. لم يتم إرسال أي طلب.");
  }

  const directUrl = String(args.slice(1).join(" ") || "").trim();
  const attachment = firstImageAttachment(event) || firstImageAttachment(event?.messageReply);
  const url = directUrl || attachmentUrl(attachment);
  if (!url) {
    return send(api, event, "أرسل صورة مع الأمر !صورة، أو أرسل رابط صورة HTTPS بعد الأمر، أو رد على صورة بالأمر !صورة.");
  }

  let image;
  try {
    image = await downloadImage(url, "quasar-profile-image");
    await invoke(api, "changeAvatar", [image], 60000);
    return send(api, event, "تم إرسال طلب تغيير صورة حساب البوت بنجاح.");
  } catch (error) {
    image?.destroy?.();
    return send(api, event, `فشل تغيير صورة الحساب: ${String(error?.message || error).slice(0, 180)}`);
  }
};

module.exports.aliases = ["avatar", "changeavatar", "botavatar"];
