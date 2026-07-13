const createTelegramUpdateDedupe = () => createDedupeCache({
	ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
	maxSize: RECENT_TELEGRAM_UPDATE_MAX
});
const handleInboundMessageLike = async (event) => {
	bot.on("message", async (ctx) => {
		createTelegramBot();
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
