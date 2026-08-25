import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { authorizeViktorMediaTelegramSender, VIKTOR_MEDIA_ACCESS_GROUP } from "./api.js";

const config = {
  accessGroups: {
    [VIKTOR_MEDIA_ACCESS_GROUP]: {
      type: "message.senders",
      members: { telegram: ["7339717357", "8948449336"] },
    },
  },
} satisfies OpenClawConfig;

void test("canonical Viktor authorization remains sufficient for a private Telegram DM", async () => {
  assert.deepEqual(
    await authorizeViktorMediaTelegramSender({
      cfg: config,
      channel: "telegram",
      senderId: "7426409164",
      chatId: "7426409164",
      isGroup: false,
      canonicalAuthorized: true,
    }),
    { allowed: true, telegramId: "7426409164", source: "canonical" },
  );
});

void test("Michelle and Brittany are authorized only through the media access group", async () => {
  for (const telegramId of ["7339717357", "8948449336"]) {
    assert.deepEqual(
      await authorizeViktorMediaTelegramSender({
        cfg: config,
        channel: "telegram",
        senderId: telegramId,
        chatId: telegramId,
        isGroup: false,
        canonicalAuthorized: false,
      }),
      { allowed: true, telegramId, source: "media-user" },
    );
  }
});

void test("unknown and nonnumeric media identities fail closed", async () => {
  for (const senderId of ["8707567979", "@mutable_username", undefined]) {
    const result = await authorizeViktorMediaTelegramSender({
      cfg: config,
      channel: "telegram",
      senderId,
      chatId: senderId,
      isGroup: false,
      canonicalAuthorized: false,
    });
    assert.equal(result.allowed, false);
  }
});

void test("private-DM sender and chat equality is mandatory for every authorization source", async () => {
  for (const params of [
    {
      senderId: "7426409164",
      chatId: "7339717357",
      isGroup: false,
      canonicalAuthorized: true,
    },
    {
      senderId: "7339717357",
      chatId: "7339717357",
      isGroup: true,
      canonicalAuthorized: false,
    },
  ]) {
    assert.deepEqual(
      await authorizeViktorMediaTelegramSender({ cfg: config, channel: "telegram", ...params }),
      {
        allowed: false,
        reason: "not-private-dm",
      },
    );
  }
});

void test("a similarly named group or a nonnumeric member grants no media access", async () => {
  const result = await authorizeViktorMediaTelegramSender({
    cfg: {
      accessGroups: {
        [`${VIKTOR_MEDIA_ACCESS_GROUP}-other`]: {
          type: "message.senders",
          members: { telegram: ["7339717357"] },
        },
        [VIKTOR_MEDIA_ACCESS_GROUP]: {
          type: "message.senders",
          members: { telegram: ["@michelle"] },
        },
      },
    },
    channel: "telegram",
    senderId: "7339717357",
    chatId: "7339717357",
    isGroup: false,
    canonicalAuthorized: false,
  });
  assert.deepEqual(result, { allowed: false, reason: "not-authorized" });
});

void test("canonical authorization cannot cross into a non-Telegram channel", async () => {
  assert.deepEqual(
    await authorizeViktorMediaTelegramSender({
      cfg: config,
      channel: "discord",
      senderId: "7426409164",
      chatId: "7426409164",
      isGroup: false,
      canonicalAuthorized: true,
    }),
    { allowed: false, reason: "not-telegram" },
  );
});
