declare global {
	namespace NodeJS {
		interface ProcessEnv {
			BOT_TOKEN: string;
			DEFAULT_INTERVAL?: number;
		}
	}
}

export { }