declare global {
	namespace NodeJS {
	interface ProcessEnv {
		BOT_TOKEN?: string;
		TELEGRAM_BOT_TOKEN?: string;
		DEFAULT_INTERVAL?: string;
		NTFY_BASE_URL?: string;
		NTFY_TOPIC?: string;
		NTFY_AUTHORIZATION?: string;
		NTFY_TITLE?: string;
	}
	}
}

export { }
