import * as grammy from "grammy";
import "dotenv/config";
import { FileAdapter } from "@grammyjs/storage-file";
import { glob } from "glob";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as http2 from "node:http2";
import path from "node:path";

const BASE_ENDPOINT = "https://chat.ktalk.ru";
const NOTIFICATION_COUNT_PATH = "_matrix/client/read/api/v1/talk_notifications";
const DEFAULT_INTERVAL = parsePositiveIntegerOrFallback(process.env.DEFAULT_INTERVAL, 60_000);
const TELEGRAM_POLL_TIMEOUT = Math.max(1, Math.floor(DEFAULT_INTERVAL / 1000));
const SHARED_SESSION_KEY = "shared";

type NotificationsCount = {
    rooms_count: number;
};

type NotifierState = {
    count: NotificationsCount;
    options: {
        token: string | null;
        referer: string | null;
        interval: number;
        allowZeroMessages: boolean;
        polling: boolean;
        pollingOnBoot: boolean;
    };
};

type SessionEndpoint = {
    providerName: string;
    targetId: string;
};

type StoredSessionRecord = {
    state?: Partial<NotifierState>;
    endpoints?: SessionEndpoint[];
};

type CommandSummary = {
    name: string;
    description: string;
    usage?: string;
};

type CommandContext = {
    providerName: string;
    targetId: string;
    args: string;
    session: NotifierState;
    notifier: Notifier;
    reply: (message: string) => Promise<void>;
    handleNotificationCount: (count: NotificationsCount, showIfZero?: boolean) => Promise<void>;
    resetSession: () => Promise<void>;
    commands: readonly CommandSummary[];
};

type CommandDefinition = CommandSummary & {
    run: (ctx: CommandContext) => Promise<void>;
};

type InboundCommand = {
    providerName: string;
    targetId: string;
    name: string;
    args: string;
    reply: (message: string) => Promise<void>;
};

type MessagingProvider = {
    readonly name: string;
    readonly label: string;
    start: (onCommand: (command: InboundCommand) => Promise<void>) => Promise<void>;
    sendMessage: (targetId: string, message: string) => Promise<void>;
};

type NotifierBinding = {
    key: string;
    getSession: () => NotifierState;
    reply: (message: string) => Promise<void>;
    handleNotificationCount: (count: NotificationsCount) => Promise<void>;
};

type NtfyEvent = {
    event?: string;
    message?: string;
    topic?: string;
};

class InvalidError extends Error {
    public readonly entity: string;

    constructor(entity: string) {
        super(`${entity} must be set`);
        this.entity = entity;
    }
}

function ensureError(input: unknown) {
    if (input instanceof Error) {
        return input;
    }

    return new Error(String(input));
}

function formatError(error: Error) {
    return `${error.name}: ${error.message}`;
}

function isAbortError(error: Error) {
    return error.name === "AbortError";
}

function parsePositiveIntegerOrFallback(input: string | undefined, fallback: number) {
    const value = Number(input);

    if (Number.isInteger(value) && value > 0) {
        return value;
    }

    return fallback;
}

function parsePositiveInteger(input: string, label: string) {
    const value = Number(input);

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }

    return value;
}

function parseBooleanInput(input?: string) {
    const value = input ?? "true";
    const normalized = value.trim().toLowerCase();

    if (!normalized) {
        return true;
    }

    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }

    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }

    throw new Error("Allow must be one of: true, false, on, off, 1, 0");
}

function maskSecret(secret: string | null) {
    if (!secret) {
        return "unset";
    }

    if (secret.length <= 8) {
        return `${secret[0]}***${secret[secret.length - 1]}`;
    }

    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

function requireTextArg(input: string, label: string) {
    const value = input.trim();

    if (!value) {
        throw new InvalidError(label);
    }

    return value;
}

function parseCommandText(text: string) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
        return null;
    }

    const withoutSlash = trimmed.slice(1);
    if (!withoutSlash) {
        return null;
    }

    const [rawName, ...rest] = withoutSlash.split(/\s+/);
    const name = rawName.split("@")[0]?.toLowerCase();
    if (!name) {
        return null;
    }

    return {
        name,
        args: rest.join(" ").trim(),
    };
}

function createTopicUrl(baseUrl: string, topic: string, suffix = "") {
    const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(`${encodeURIComponent(topic)}${suffix}`, normalized).toString();
}

function sessionProxy<T extends object>(obj: T, trigger: () => void): T {
    return new Proxy<T>(obj, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);

            if (value && typeof value === "object") {
                return sessionProxy(value as object, trigger);
            }

            return value;
        },
        set(target, property, newValue, receiver) {
            const result = Reflect.set(target, property, newValue, receiver);
            trigger();

            return result;
        },
        deleteProperty(target, property) {
            const result = Reflect.deleteProperty(target, property);
            trigger();

            return result;
        },
    });
}

const DEFAULT_NOTIFIER_STATE: NotifierState = {
    count: {
        rooms_count: 0,
    },
    options: {
        token: null,
        referer: null,
        interval: DEFAULT_INTERVAL,
        allowZeroMessages: false,
        polling: false,
        pollingOnBoot: false,
    },
};

function createNotifierState() {
    return structuredClone(DEFAULT_NOTIFIER_STATE);
}

function isStoredSessionRecord(input: unknown): input is StoredSessionRecord {
    return input !== null && typeof input === "object" && ("state" in input || "endpoints" in input);
}

function normalizeSessionEndpoints(input: SessionEndpoint[] | undefined) {
    if (!input) {
        return [];
    }

    const endpoints = new Map<string, SessionEndpoint>();

    for (const endpoint of input) {
        if (typeof endpoint?.providerName !== "string" || typeof endpoint?.targetId !== "string") {
            continue;
        }

        const providerName = endpoint.providerName.trim();
        const targetId = endpoint.targetId.trim();
        if (!providerName || !targetId) {
            continue;
        }

        endpoints.set(`${providerName}:${targetId}`, {
            providerName,
            targetId,
        });
    }

    return Array.from(endpoints.values());
}

function normalizeNotifierState(input: Partial<NotifierState> | undefined) {
    const state = createNotifierState();

    if (!input) {
        return state;
    }

    if (typeof input.count?.rooms_count === "number" && Number.isFinite(input.count.rooms_count)) {
        state.count.rooms_count = input.count.rooms_count;
    }

    if (!input.options) {
        return state;
    }

    if (typeof input.options.token === "string" || input.options.token === null) {
        state.options.token = input.options.token;
    }

    if (typeof input.options.referer === "string" || input.options.referer === null) {
        state.options.referer = input.options.referer;
    }

    if (typeof input.options.interval === "number" && Number.isInteger(input.options.interval) && input.options.interval > 0) {
        state.options.interval = input.options.interval;
    }

    if (typeof input.options.allowZeroMessages === "boolean") {
        state.options.allowZeroMessages = input.options.allowZeroMessages;
    }

    if (typeof input.options.polling === "boolean") {
        state.options.polling = input.options.polling;
    }

    if (typeof input.options.pollingOnBoot === "boolean") {
        state.options.pollingOnBoot = input.options.pollingOnBoot;
    }

    return state;
}

class SessionFileAdapter<T> extends FileAdapter<T> {
    private readonly dir: string;

    constructor(dirName = "sessions") {
        super({ dirName });
        this.dir = dirName;
    }

    async getKeys() {
        const resolved = path.resolve(this.dir, "**/*.json");
        const files = await glob(resolved);

        return files.map((file) => path.basename(file, ".json"));
    }
}

class SessionStore {
    private readonly storage = new SessionFileAdapter<StoredSessionRecord | Partial<NotifierState>>("sessions");

    private parseLegacyKey(key: string) {
        const separator = key.indexOf("__");
        if (separator === -1) {
            return {
                providerName: "telegram",
                targetId: key,
            };
        }

        return {
            providerName: key.slice(0, separator),
            targetId: decodeURIComponent(key.slice(separator + 2)),
        };
    }

    private async readLegacy() {
        const keys = (await this.storage.getKeys()).filter((key) => key !== SHARED_SESSION_KEY);
        if (keys.length === 0) {
            return null;
        }

        const entries = await Promise.all(keys.map(async (key) => {
            const stored = await this.storage.read(key);

            return {
                endpoint: this.parseLegacyKey(key),
                state: normalizeNotifierState(isStoredSessionRecord(stored) ? stored.state : stored),
            };
        }));
        const preferred = entries.find((entry) => entry.endpoint.providerName === "telegram") ?? entries[0];

        return {
            state: preferred.state,
            endpoints: normalizeSessionEndpoints(entries.map((entry) => entry.endpoint)),
        };
    }

    async read() {
        const stored = await this.storage.read(SHARED_SESSION_KEY);
        if (stored) {
            if (isStoredSessionRecord(stored)) {
                return {
                    state: normalizeNotifierState(stored.state),
                    endpoints: normalizeSessionEndpoints(stored.endpoints),
                };
            }

            return {
                state: normalizeNotifierState(stored),
                endpoints: [],
            };
        }

        const migrated = await this.readLegacy();
        if (!migrated) {
            return {
                state: createNotifierState(),
                endpoints: [],
            };
        }

        await this.write(migrated);
        return migrated;
    }

    async write(record: StoredSessionRecord) {
        await this.storage.write(SHARED_SESSION_KEY, {
            state: normalizeNotifierState(record.state),
            endpoints: normalizeSessionEndpoints(record.endpoints),
        });
    }
}

class Notifier {
    private controller = new AbortController();
    private binding: NotifierBinding;

    constructor(binding: NotifierBinding) {
        this.binding = binding;
    }

    private get session() {
        return this.binding.getSession();
    }

    public updateBinding(binding: NotifierBinding) {
        this.binding = binding;
    }

    public async getNotificationCount(): Promise<NotificationsCount> {
        const referer = this.session.options.referer;
        const token = this.session.options.token;

        if (!referer) {
            throw new InvalidError("referer");
        }

        if (!token) {
            throw new InvalidError("token");
        }

        const response = await fetch(`${BASE_ENDPOINT}/${NOTIFICATION_COUNT_PATH}`, {
            headers: {
                Referer: referer,
                Origin: referer,
                "Talk-Token": token,
            },
            signal: this.controller.signal,
        });

        if (response.status !== 200) {
            throw new Error(`Got ${response.status} response status`);
        }

        const data = await response.json() as Partial<NotificationsCount>;
        if (typeof data.rooms_count !== "number" || !Number.isFinite(data.rooms_count)) {
            throw new Error("Invalid notifications count response");
        }

        return {
            rooms_count: data.rooms_count,
        };
    }

    public startPollingNotifications(force = false) {
        if (this.session.options.polling && !force) {
            console.warn(`[${this.binding.key}] already polling`);
            return false;
        }

        this.controller.abort();
        this.controller = new AbortController();
        this.session.options.polling = true;
        this.session.options.pollingOnBoot = true;

        void this.poll();

        return true;
    }

    private async poll(): Promise<void> {
        if (!this.session.options.polling) {
            return;
        }

        try {
            const data = await this.getNotificationCount();
            const hasChanged = data.rooms_count !== this.session.count.rooms_count;

            this.session.count = data;

            if (hasChanged) {
                await this.binding.handleNotificationCount(data);
            }
        } catch (error) {
            const resolved = ensureError(error);
            if (isAbortError(resolved) && !this.session.options.polling) {
                return;
            }

            this.stopPollingNotifications(false);
            await this.binding.reply(formatError(resolved));
            return;
        }

        if (!this.session.options.polling) {
            return;
        }

        setTimeout(() => {
            void this.poll();
        }, this.session.options.interval);
    }

    public stopPollingNotifications(commit = true) {
        const wasPolling = this.session.options.polling;

        if (commit) {
            this.session.options.pollingOnBoot = false;
        }

        this.session.options.polling = false;
        this.controller.abort();
        this.controller = new AbortController();

        return wasPolling;
    }
}

class NotifierFactory {
    private static readonly registry = new Map<string, Notifier>();

    static create(binding: NotifierBinding) {
        if (!this.registry.has(binding.key)) {
            const notifier = new Notifier(binding);
            this.registry.set(binding.key, notifier);

            if (binding.getSession().options.pollingOnBoot) {
                console.log(`[${binding.key}] restoring polling after reboot`);
                notifier.startPollingNotifications(true);
                void binding.reply("Continue polling after reboot");
            }
        }

        const notifier = this.registry.get(binding.key)!;
        notifier.updateBinding(binding);

        return notifier;
    }
}

class Conversation {
    private rawSession: NotifierState;
    private proxiedSession: NotifierState;
    private saveQueue: Promise<void> = Promise.resolve();
    private providers: Map<string, MessagingProvider>;
    private readonly endpoints = new Map<string, SessionEndpoint>();

    public readonly key = SHARED_SESSION_KEY;
    public readonly notifier: Notifier;

    constructor(
        initialState: NotifierState,
        initialEndpoints: SessionEndpoint[],
        private readonly store: SessionStore,
        providers: Map<string, MessagingProvider>,
    ) {
        this.rawSession = initialState;
        this.proxiedSession = this.createSessionProxy();
        this.providers = providers;

        for (const endpoint of initialEndpoints) {
            this.endpoints.set(this.createEndpointKey(endpoint.providerName, endpoint.targetId), endpoint);
        }

        this.notifier = NotifierFactory.create(this.createBinding());
    }

    private createEndpointKey(providerName: string, targetId: string) {
        return `${providerName}:${targetId}`;
    }

    private createSessionProxy() {
        return sessionProxy(this.rawSession, () => {
            void this.persist();
        });
    }

    private createBinding(): NotifierBinding {
        return {
            key: this.key,
            getSession: () => this.session,
            reply: (message) => this.reply(message),
            handleNotificationCount: (count) => this.handleNotificationCount(count),
        };
    }

    private async persist() {
        const snapshot: StoredSessionRecord = {
            state: structuredClone(this.rawSession),
            endpoints: Array.from(this.endpoints.values()),
        };

        this.saveQueue = this.saveQueue
            .catch(() => undefined)
            .then(async () => {
                await this.store.write(snapshot);
            });

        await this.saveQueue;
    }

    public updateProviders(providers: Map<string, MessagingProvider>) {
        this.providers = providers;
        this.notifier.updateBinding(this.createBinding());
    }

    public hasEndpoints() {
        return this.endpoints.size > 0;
    }

    public async connect(providerName: string, targetId: string) {
        const key = this.createEndpointKey(providerName, targetId);
        if (this.endpoints.has(key)) {
            return;
        }

        this.endpoints.set(key, { providerName, targetId });
        await this.persist();
    }

    public get session() {
        return this.proxiedSession;
    }

    public async reply(message: string) {
        const endpoints = Array.from(this.endpoints.values());
        if (endpoints.length === 0) {
            return;
        }

        const results = await Promise.allSettled(endpoints.map((endpoint) => this.replyTo(endpoint.providerName, endpoint.targetId, message)));
        for (const result of results) {
            if (result.status === "fulfilled") {
                continue;
            }

            console.error(`[session] ${formatError(ensureError(result.reason))}`);
        }
    }

    public async replyTo(providerName: string, targetId: string, message: string) {
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Provider "${providerName}" is not configured`);
        }

        await provider.sendMessage(targetId, message);
    }

    public async handleNotificationCount(count: NotificationsCount, showIfZero = false) {
        if (!showIfZero && !this.session.options.allowZeroMessages && count.rooms_count === 0) {
            return;
        }

        await this.reply(`${count.rooms_count} rooms have new messages`);
    }

    public async resetSession() {
        this.notifier.stopPollingNotifications(false);
        this.rawSession = createNotifierState();
        this.proxiedSession = this.createSessionProxy();
        this.notifier.updateBinding(this.createBinding());
        await this.persist();
    }
}

class ConversationManager {
    private conversation: Conversation | null = null;

    constructor(
        private readonly store: SessionStore,
        private readonly providers: Map<string, MessagingProvider>,
    ) {}

    private async ensureConversation() {
        if (!this.conversation) {
            const stored = await this.store.read();
            const validEndpoints = stored.endpoints.filter((endpoint) => this.providers.get(endpoint.providerName));
            this.conversation = new Conversation(stored.state, validEndpoints, this.store, this.providers);
        }

        this.conversation.updateProviders(this.providers);
        return this.conversation;
    }

    async get(providerName: string, targetId: string) {
        const provider = this.providers.get(providerName);

        if (!provider) {
            throw new Error(`Provider \"${providerName}\" is not configured`);
        }

        const conversation = await this.ensureConversation();
        await conversation.connect(providerName, targetId);

        return conversation;
    }

    async restoreAll() {
        const conversation = await this.ensureConversation();
        if (!conversation.hasEndpoints()) {
            return [];
        }

        return [conversation];
    }
}

class CommandRouter {
    private readonly commandMap = new Map<string, CommandDefinition>();
    private readonly commands: readonly CommandSummary[];

    constructor(
        private readonly conversations: ConversationManager,
        commands: readonly CommandDefinition[],
    ) {
        this.commands = commands.map(({ name, description, usage }) => ({
            name,
            description,
            usage,
        }));

        for (const command of commands) {
            this.commandMap.set(command.name, command);
        }
    }

    async handle(inbound: InboundCommand) {
        const command = this.commandMap.get(inbound.name);
        if (!command) {
            await inbound.reply(`Unknown command: /${inbound.name}. Send /start for help.`);
            return;
        }

        try {
            const conversation = await this.conversations.get(inbound.providerName, inbound.targetId);

            await command.run({
                providerName: inbound.providerName,
                targetId: inbound.targetId,
                args: inbound.args,
                session: conversation.session,
                notifier: conversation.notifier,
                reply: (message) => conversation.replyTo(inbound.providerName, inbound.targetId, message),
                handleNotificationCount: (count, showIfZero = false) => conversation.handleNotificationCount(count, showIfZero),
                resetSession: () => conversation.resetSession(),
                commands: this.commands,
            });
        } catch (error) {
            await inbound.reply(formatError(ensureError(error)));
        }
    }
}

class TelegramProvider implements MessagingProvider {
    public readonly name = "telegram";
    public readonly label = "Telegram";

    private readonly bot: grammy.Bot;
    private readonly commands: readonly CommandSummary[];

    constructor(token: string, commands: readonly CommandSummary[], proxyUrl?: string) {
        const client: grammy.ApiClientOptions | undefined = proxyUrl
            ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } }
            : undefined;
        this.bot = new grammy.Bot(token, { client });
        this.commands = commands;
    }

    async start(onCommand: (command: InboundCommand) => Promise<void>) {
        this.bot.on("message:text", async (ctx) => {
            if (!ctx.chatId) {
                return;
            }

            const command = parseCommandText(ctx.message.text);
            if (!command) {
                return;
            }

            await onCommand({
                providerName: this.name,
                targetId: String(ctx.chatId),
                name: command.name,
                args: command.args,
                reply: async (message) => {
                    await ctx.reply(message);
                },
            });
        });

        this.bot.catch(async (error) => {
            console.error(error.error);

            if (!error.ctx.chatId) {
                return;
            }

            await this.sendMessage(String(error.ctx.chatId), formatError(ensureError(error.error)));
        });

        await this.bot.api.setMyCommands(this.commands.map(({ name, description }) => ({
            command: name,
            description,
        })));

        void this.bot.start({
            timeout: TELEGRAM_POLL_TIMEOUT,
        }).catch((error) => {
            console.error(formatError(ensureError(error)));
        });
    }

    async sendMessage(targetId: string, message: string) {
        await this.bot.api.sendMessage(Number(targetId), message);
    }
}

type NtfyProviderOptions = {
    baseUrl: string;
    topic: string;
    title: string;
    authorization: string | null;
    reconnectDelayMs: number;
    idleTimeoutMs: number;
};

class NtfyProvider implements MessagingProvider {
    public readonly name = "ntfy";
    public readonly label = "ntfy";

    constructor(private readonly options: NtfyProviderOptions) {}

    private log(message: string) {
        console.log(`[ntfy:${this.options.topic}] ${message}`);
    }

    private createHeaders(extra: Record<string, string> = {}) {
        const headers = new Headers(extra);

        if (this.options.authorization) {
            headers.set("Authorization", this.options.authorization);
        }

        return headers;
    }

    private async handleLine(line: string, onCommand: (command: InboundCommand) => Promise<void>) {
        let event: NtfyEvent;

        try {
            event = JSON.parse(line) as NtfyEvent;
        } catch (error) {
            this.log(`ignoring malformed event: ${formatError(ensureError(error))}`);
            return;
        }

        if (event.event !== "message" || typeof event.message !== "string" || typeof event.topic !== "string") {
            return;
        }

        const command = parseCommandText(event.message);
        if (!command) {
            return;
        }

        const topic = event.topic;

        await onCommand({
            providerName: this.name,
            targetId: topic,
            name: command.name,
            args: command.args,
            reply: (message) => this.sendMessage(topic, message),
        });
    }

    private createSubscribeHeaders(url: URL) {
        const headers: Record<string, string> = {
            ":method": "GET",
            ":path": `${url.pathname}${url.search}`,
        };

        if (this.options.authorization) {
            headers.authorization = this.options.authorization;
        }

        return headers;
    }

    private createIdleMonitor(request: http2.ClientHttp2Stream, session: http2.ClientHttp2Session) {
        let timeout: NodeJS.Timeout | null = null;

        const refresh = () => {
            if (timeout) {
                clearTimeout(timeout);
            }

            timeout = setTimeout(() => {
                const error = new Error(`ntfy stream health check failed after ${this.options.idleTimeoutMs} ms without activity`);
                request.destroy(error);
                session.destroy();
            }, this.options.idleTimeoutMs);
            timeout.unref();
        };

        const stop = () => {
            if (!timeout) {
                return;
            }

            clearTimeout(timeout);
            timeout = null;
        };

        refresh();

        return {
            refresh,
            stop,
        };
    }

    private async consumeStream(onCommand: (command: InboundCommand) => Promise<void>) {
        const streamUrl = new URL(createTopicUrl(this.options.baseUrl, this.options.topic, "/json"));
        const session = http2.connect(streamUrl.origin);
        const request = session.request(this.createSubscribeHeaders(streamUrl));

        session.on("error", (error) => {
            request.destroy(ensureError(error));
        });

        request.setEncoding("utf8");

        const status = await new Promise<number>((resolve, reject) => {
            request.once("response", (headers) => {
                resolve(Number(headers[":status"] ?? 0));
            });
            request.once("error", reject);
            session.once("error", reject);
        });

        if (status < 200 || status >= 300) {
            request.close();
            session.close();
            throw new Error(`ntfy subscribe failed with ${status || "unknown status"}`);
        }

        this.log("subscription connected");

        const idleMonitor = this.createIdleMonitor(request, session);
        let buffer = "";

        try {
            for await (const chunk of request) {
                idleMonitor.refresh();
                buffer += chunk;

                let newlineIndex = buffer.indexOf("\n");
                while (newlineIndex !== -1) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);

                    if (line) {
                        await this.handleLine(line, onCommand);
                    }

                    newlineIndex = buffer.indexOf("\n");
                }
            }
        } finally {
            idleMonitor.stop();
            request.close();
            session.close();
        }

        const remainder = buffer.trim();
        if (remainder) {
            await this.handleLine(remainder, onCommand);
        }
    }

    private async listen(onCommand: (command: InboundCommand) => Promise<void>) {
        while (true) {
            try {
                await this.consumeStream(onCommand);
                this.log(`subscription closed, reconnecting in ${this.options.reconnectDelayMs} ms`);
            } catch (error) {
                this.log(`${formatError(ensureError(error))}; reconnecting in ${this.options.reconnectDelayMs} ms`);
            }

            await sleep(this.options.reconnectDelayMs);
        }
    }

    async start(onCommand: (command: InboundCommand) => Promise<void>) {
        void this.listen(onCommand);
    }

    async sendMessage(targetId: string, message: string) {
        const response = await fetch(createTopicUrl(this.options.baseUrl, targetId), {
            method: "POST",
            headers: this.createHeaders({
                Title: this.options.title,
            }),
            body: message,
        });

        if (!response.ok) {
            throw new Error(`ntfy publish failed with ${response.status}`);
        }
    }
}

function createHelpMessage(commands: readonly CommandSummary[]) {
    const lines = commands.map((command) => {
        const usage = command.usage ? ` ${command.usage}` : "";
        return `/${command.name}${usage} - ${command.description}`;
    });

    return ["Available commands:", ...lines].join("\n");
}

function formatSettings(ctx: CommandContext) {
    return [
        `Provider: ${ctx.providerName}`,
        `Target: ${ctx.targetId}`,
        `Referer: ${ctx.session.options.referer ?? "unset"}`,
        `Token: ${maskSecret(ctx.session.options.token)}`,
        `Interval: ${ctx.session.options.interval} ms`,
        `Allow zero messages: ${ctx.session.options.allowZeroMessages}`,
        `Polling: ${ctx.session.options.polling}`,
        `Polling on boot: ${ctx.session.options.pollingOnBoot}`,
    ].join("\n");
}

async function validateNotifierConfiguration(ctx: CommandContext) {
    if (ctx.session.options.token && ctx.session.options.referer) {
        await ctx.notifier.getNotificationCount();
    }
}

function createCommands(): CommandDefinition[] {
    return [
        {
            name: "start",
            description: "Show available commands",
            run: async (ctx) => {
                await ctx.reply(createHelpMessage(ctx.commands));
            },
        },
        {
            name: "check",
            description: "Check notifications right now",
            run: async (ctx) => {
                const count = await ctx.notifier.getNotificationCount();
                ctx.session.count = count;
                await ctx.handleNotificationCount(count, true);
            },
        },
        {
            name: "poll",
            description: "Start notifications polling",
            run: async (ctx) => {
                const started = ctx.notifier.startPollingNotifications();
                await ctx.reply(started ? "Polling started" : "Polling is already running");
            },
        },
        {
            name: "stop",
            description: "Stop notifications polling",
            run: async (ctx) => {
                const stopped = ctx.notifier.stopPollingNotifications();
                await ctx.reply(stopped ? "Polling stopped" : "Polling is already stopped");
            },
        },
        {
            name: "interval",
            description: "Change polling interval",
            usage: "<ms>",
            run: async (ctx) => {
                ctx.session.options.interval = parsePositiveInteger(requireTextArg(ctx.args, "interval"), "interval");
                await ctx.reply(`Interval successfully set to ${ctx.session.options.interval} ms`);
            },
        },
        {
            name: "token",
            description: "Change token used for polling",
            usage: "<value>",
            run: async (ctx) => {
                const token = requireTextArg(ctx.args, "token");
                const previous = ctx.session.options.token;

                ctx.session.options.token = token;

                try {
                    await validateNotifierConfiguration(ctx);
                } catch (error) {
                    ctx.session.options.token = previous;
                    throw error;
                }

                await ctx.reply("Token successfully set");
            },
        },
        {
            name: "referer",
            description: "Change referer used for polling",
            usage: "<url>",
            run: async (ctx) => {
                const referer = requireTextArg(ctx.args, "referer");
                const previous = ctx.session.options.referer;

                ctx.session.options.referer = referer;

                try {
                    await validateNotifierConfiguration(ctx);
                } catch (error) {
                    ctx.session.options.referer = previous;
                    throw error;
                }

                await ctx.reply("Referer successfully set");
            },
        },
        {
            name: "allow",
            description: "Show zero count messages during polling",
            usage: "[true|false]",
            run: async (ctx) => {
                ctx.session.options.allowZeroMessages = parseBooleanInput(ctx.args);
                await ctx.reply(`Allow zero messages successfully set to ${ctx.session.options.allowZeroMessages}`);
            },
        },
        {
            name: "settings",
            description: "Show current settings",
            run: async (ctx) => {
                await ctx.reply(formatSettings(ctx));
            },
        },
        {
            name: "clear",
            description: "Clear your session",
            run: async (ctx) => {
                await ctx.resetSession();
                await ctx.reply("Successfully cleared session");
            },
        },
    ];
}

function createProviders(commands: readonly CommandSummary[]) {
    const providers: MessagingProvider[] = [];
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
    const ntfyTopic = process.env.NTFY_TOPIC?.trim();

if (telegramToken) {
        const proxyUrl = process.env.TELEGRAM_PROXY?.trim();
        providers.push(new TelegramProvider(telegramToken, commands, proxyUrl));
    }
    if (ntfyTopic && parseBooleanInput(process.env.NTFY_ENABLED)) {
        providers.push(new NtfyProvider({
            baseUrl: process.env.NTFY_BASE_URL?.trim() || "https://ntfy.sh",
            topic: ntfyTopic,
            title: process.env.NTFY_TITLE?.trim() || "KTalk Push",
            authorization: process.env.NTFY_AUTHORIZATION?.trim() || null,
            reconnectDelayMs: 3_000,
            idleTimeoutMs: 120_000,
        }));
    }

    if (providers.length === 0) {
        throw new Error("Configure at least one provider: TELEGRAM_BOT_TOKEN/BOT_TOKEN or NTFY_TOPIC");
    }

    return providers;
}

async function main() {
    const commands = createCommands();
    const commandSummaries = commands.map(({ name, description, usage }) => ({
        name,
        description,
        usage,
    }));
    const providers = createProviders(commandSummaries);
    const providerMap = new Map(providers.map((provider) => [provider.name, provider]));
    const store = new SessionStore();
    const conversations = new ConversationManager(store, providerMap);
    const router = new CommandRouter(conversations, commands);

    for (const provider of providers) {
        await provider.start((command) => router.handle(command));
    }

    for (const conversation of await conversations.restoreAll()) {
        await conversation.reply("Service booted");
    }
}

void main().catch((error) => {
    console.error(formatError(ensureError(error)));
    process.exitCode = 1;
});
