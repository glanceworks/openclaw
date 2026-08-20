import { createHmac, timingSafeEqual } from "node:crypto";

export function deriveActor(secret: string, trustedTelegramSenderId: string): string {
  const sender = trustedTelegramSenderId.trim();
  if (!sender) {
    throw new Error("A trusted Telegram sender is required.");
  }
  const digest = createHmac("sha256", secret)
    .update(`telegram:${sender}`, "utf8")
    .digest("base64url");
  return `v1.${digest}`;
}

export function timingSafeActorEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
