const createTelegramUpdateDedupe = () => createDedupeCache({
	ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
	maxSize: RECENT_TELEGRAM_UPDATE_MAX
});
const TELEGRAM_MEDIA_GATE_PATCH_MARKER = "OPENCLAW_TELEGRAM_MEDIA_GATE_PATCH_V2";
const TELEGRAM_MEDIA_GATE_MODULE_URL = "file:///opt/openclaw-telegram-media-gate/scripts/telegram-media-gate.mjs";
let telegramMediaGateModulePromise = null;
async function loadTelegramMediaGateModule() {
	telegramMediaGateModulePromise ??= import(TELEGRAM_MEDIA_GATE_MODULE_URL);
	return await telegramMediaGateModulePromise;
}
async function evaluateTelegramMediaGateDecision(params) {
	try {
		const mod = await loadTelegramMediaGateModule();
		if (!mod || typeof mod.evaluateTelegramMediaAccess !== "function") return null;
		return mod.evaluateTelegramMediaAccess({
			provider: "telegram",
			senderId: params.senderId,
			chatId: params.chatId,
			text: params.text,
			botUsername: params.botUsername
		});
	} catch (err) {
		params.runtime?.error?.(danger("telegram media gate load failed: " + String(err)));
		return null;
	}
}
async function applyTelegramMediaGateDecision(params) {
	const decision = await evaluateTelegramMediaGateDecision({
		chatId: params.chatId,
		senderId: params.senderId,
		text: params.text,
		botUsername: params.bot?.botInfo?.username ?? null,
		runtime: params.runtime
	});
	if (!decision) return false;
	if (decision.decision === "continue_normal") return false;
	if (decision.decision === "intercept_media_only" || decision.decision === "deny") {
		if (decision.responseText) await withTelegramApiErrorLogging({
			operation: "sendMessage",
			runtime: params.runtime,
			fn: () => params.bot.api.sendMessage(params.chatId, decision.responseText, params.threadParams)
		});
		return true;
	}
	if (decision.decision === "ignore") return true;
	return false;
}
const handleInboundMessageLike = async (event) => {
	bot.on("message", async (ctx) => {
		createTelegramBot();
			if (await applyTelegramMediaGateDecision({
				bot,
				runtime,
				chatId: event.chatId,
				senderId: event.senderId,
				text: event.msg.text ?? event.msg.caption ?? "",
				threadParams: buildTelegramThreadParams(resolveTelegramThreadSpec({
					isGroup: event.isGroup,
					isForum: event.isForum,
					messageThreadId: event.messageThreadId
				}))
			})) return;
			await processInboundMessage({
				ctx: event.ctx,
				msg: event.msg,
				chatId: event.chatId,
				resolvedThreadId,
				dmThreadId,
				storeAllowFrom,
				sendOversizeWarning: event.sendOversizeWarning,
				oversizeLogMessage: event.oversizeLogMessage
			});
	});
};
