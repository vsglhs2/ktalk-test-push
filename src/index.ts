import EventEmitter from "node:events";
import * as grammy from "grammy";
import 'dotenv/config';
import { FileAdapter } from "@grammyjs/storage-file";
import type { Update, UserFromGetMe } from "grammy/types";
import { glob } from "glob";
import path from "node:path";

// import * as conversations from "@grammyjs/conversations";

// const o = globalThis.fetch;

// globalThis.fetch = function (...args) {
//     if (typeof args[0] === 'string' && args[0].includes(NOTIFICATION_COUNT_PATH)) {
//         return Promise.resolve(new Response(JSON.stringify({
//             rooms_count: 1,
//         }), {
//             headers: {
//                 'Content-Type': 'application/json',
//             }
//         }));
//     }

//     return o.apply(this, args);
// }

const { Bot } = grammy;

function ensureError(input: unknown) {
    if (input instanceof Error) {
        return input;
    }

    const message = String(input);
    return new Error(message);
}

function formatError(error: Error) {
    return `${error.name}: ${error.message}`;
}

class InvalidError extends Error {
    public readonly entity: string;

    constructor(entity: string) {
        super(`${entity} must be set`);

        this.entity = entity;
    }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    throw new InvalidError("bot token");
}

const BASE_ENDPOINT = 'https://chat.ktalk.ru';
const NOTIFICATION_COUNT_PATH = `_matrix/client/strangler/api/v1/talk_notifications`;

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

type EventMap = {
    'stop': [void];
    'start': [void];
    'error': [Error];
    'poll': [boolean];
    'notification-count': [NotificationsCount];
    'notification-count:changed': [NotificationsCount];
    'state:changed': [NotifierState];
};

class NotifierFactory {
    static registry = new Map<number, Notifier>();

    static create(ctx: NotifierContext) {
        if (!ctx.chatId) {
            throw new InvalidError('chat id');
        }

        function getSession() {
            return sessionProxy(ctx.session, () => {
                if (!ctx.chatId) {
                    return;
                }

                storage.write(ctx.chatId.toString(), ctx.session);
            });
        }

        if (!this.registry.has(ctx.chatId)) {
            const notifier = new Notifier(getSession);
            this.registry.set(ctx.chatId, notifier);

            if (ctx.session.options.pollingOnBoot) {
                console.log('Polling enabled in session. Started to poll');
                notifier.startPollingNotifications(true);

                bot.api.sendMessage(ctx.chatId, 'Continue polling after reboot');
            }

            notifier.emitter.on('error', async (error) => {
                notifier.stopPollingNotifications(false);

                await ctx.reply(formatError(error));
            });

            notifier.emitter.on('notification-count', async (count) => {
                ctx.handleNotificationCount(count);
            });
        }

        const notifier = this.registry.get(ctx.chatId)!;
        notifier.updateSession(getSession);

        return notifier;
    }
}

function sessionProxy<T extends Record<string, unknown>>(obj: T, trigger: () => void) {
    return new Proxy<T>(obj, {
        get(target, p, receiver) {
            if (target[p as string] instanceof Object) {
                return sessionProxy(target[p as string] as Record<string, unknown>, trigger);
            }
            
            return Reflect.get(target, p, receiver);
        },
        set(target, p, newValue, receiver) {
            const result = Reflect.set(target, p, newValue, receiver);
            trigger();

            return result;
        },
    });
}

class Notifier {
    private controller: AbortController;
    private getSession: () => NotifierState;

    private get session() {
        return this.getSession();
    }

    public readonly emitter: EventEmitter<EventMap>;

    constructor(getSession: () => NotifierState) {
        this.controller = new AbortController();
        this.getSession = getSession;

        this.emitter = new EventEmitter();

        this.emitter.on('notification-count:changed', () => {
            this.emitter.emit('state:changed', this.session);
        });
    }

    public updateSession(getSession: () => NotifierState) {
        this.getSession = getSession;
    }

    public async getNotificationCount(): Promise<NotificationsCount> {
        const url = `${BASE_ENDPOINT}/${NOTIFICATION_COUNT_PATH}`;
        const referer = this.session.options.referer;

        if (!referer) {
            throw new InvalidError('referer');
        }

        if (!this.session.options.token) {
            throw new InvalidError('token');
        }

        try {
            const response = await fetch(url, {
                headers: {
                    'Referer': referer,
                    'Origin': referer,
                    'Talk-Token': this.session.options.token,
                },
                signal: this.controller.signal,
            });

            if (response.status !== 200) {
                throw new Error('Got non 200 response status');
            }

            return response.json() as Promise<NotificationsCount>;
        } catch (error) {
            // TODO: handle network issues here
            throw error;
        }
    }

    public startPollingNotifications(force = false) {
        if (this.session.options.polling && !force) {
            console.warn('Already polling for notifications');

            return;
        }

        this.controller = new AbortController();
        this.session.options.polling = true;
        this.session.options.pollingOnBoot = true;

        const poll = async () => {
            if (!this.session.options.polling) {
                return;
            }

            try {
                const data = await this.getNotificationCount();
                console.log('polled', data);
                this.emitter.emit('notification-count', data);
                
                if (data.rooms_count != this.session.count.rooms_count) {
                    this.emitter.emit('notification-count:changed', data);
                }

                this.session.count = data;

                setTimeout(poll, this.session.options.interval);
            } catch (error) {
                this.emitter.emit('error', ensureError(error));
            }
        }

        poll();
        this.emitter.emit('poll', true);

        this.emitter.once('poll', (polling: boolean) => {
            if (polling) {
                return;
            }

            this.session.options.polling = false;
        });
    }

    public stopPollingNotifications(commit = true) {
        if (commit) {
            this.session.options.pollingOnBoot = false;
        }

        this.session.options.polling = false;

        this.controller.abort();
        this.controller = new AbortController();

        this.emitter.emit('poll', false);
    }
}

class NotifierContext extends grammy.Context implements grammy.SessionFlavor<NotifierState> {
    #notifier: Notifier | null;

    public get notifier() {
        if (!this.#notifier) {
            throw new InvalidError('notifier');
        }

        return this.#notifier;
    }

    constructor(update: Update, api: grammy.Api, me: UserFromGetMe) {
        super(update, api, me);

        this.#notifier = null;
    }

    get session(): NotifierState {
        // @ts-ignore
        return super.session;
    }

    set session(session: NotifierState) {
        // @ts-ignore
        super.session = session;
    }

    initialize() {
        this.#notifier = NotifierFactory.create(this);
    }

    async handleNotificationCount(
        count: NotificationsCount,
        showIfZero = false
    ) {
        if (!showIfZero && !this.session.options.allowZeroMessages && count.rooms_count === 0) {
            return;
        }

        const message = `${count.rooms_count} rooms have new messages`;
        await this.reply(message);
    }

}

const DEFAULT_NOTIFIER_STATE: NotifierState = {
    count: {
        rooms_count: 0,
    },
    options: {
        token: null,
        referer: null,
        interval: 60_000,
        allowZeroMessages: false,
        polling: false,
        pollingOnBoot: false,
    },
};

function createNotifierState() {
    return structuredClone(DEFAULT_NOTIFIER_STATE);
}

const bot = new Bot<NotifierContext>(BOT_TOKEN, {
    ContextConstructor: NotifierContext,
});

class CustomFileAdapter<T> extends FileAdapter<T> {
    private dir: string;

    constructor(opts?: ConstructorParameters<typeof FileAdapter<T>>[0]) {
        super(opts);

        this.dir = opts?.dirName ?? 'sessions';
    }

    async getKeys() {
        const resolved = path.resolve(this.dir, '**/*.json');
        const files =  await glob(resolved);

        return files.map(file => file.split('/').at(-1)!.slice(0, -5));
    }
}

const storage = new CustomFileAdapter<NotifierState>({
    dirName: 'sessions',
});

const keys = await storage.getKeys();
for (const key of keys) {
    const session = await storage.read(key);
    const chatId = Number(key);

    const ctx = new NotifierContext({
        update_id: 0,
        message: {
            message_id: 0,
            date: 0,
            chat: {
                id: chatId,
                type:'private',
                title: undefined,
                first_name: '',
            },
            from: {
                id: 0,
                is_bot: false,
                first_name: '',
            },
        },
    }, bot.api, {
        id: 0,
        is_bot: true,
        username: '',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: true,
        can_connect_to_business: false,
        has_main_web_app: false,
        first_name: '',
    });
    ctx.session = session;

    NotifierFactory.create(ctx);

    await bot.api.sendMessage(chatId, 'Bot booted');
}

bot.use(grammy.session({
    initial: createNotifierState,
    storage: storage,
}))

bot.use(async (ctx: NotifierContext, next: grammy.NextFunction) => {
    ctx.initialize();

    next();
});

bot.command(['token'], async (ctx) => {
    ctx.session.options.token = ctx.match;

    await ctx.notifier.getNotificationCount();
    await ctx.reply('Token successfully set');
});

bot.command(['referer'], async (ctx) => {
    ctx.session.options.referer = ctx.match;

    await ctx.reply('Referer successfully set');
});

bot.command(['allow'], async (ctx) => {
    ctx.session.options.allowZeroMessages = Boolean(ctx.match);

    await ctx.reply('Allow zero messages successfully set');
});

bot.command(['interval'], async (ctx) => {
    const interval = Number(ctx.match);
    if (Number.isNaN(interval) && interval > 0) {
        throw new Error('Interval must be a non negative number > 0');
    }

    ctx.session.options.interval = interval;

    await ctx.reply('Interval successfully set');
});

bot.command(['check'], async (ctx) => {
    const count = await ctx.notifier.getNotificationCount();
    ctx.session.count.rooms_count = count.rooms_count;
    
    await ctx.handleNotificationCount(count, true);
});

bot.command(['start'], async (ctx) => {
    const keyboard = new grammy.InlineKeyboard()
        .text("Check", "check-p")
        .text("Settings", "settings-p");

    await ctx.reply('Hello', {
        reply_markup: keyboard,
    });

});

// bot.use(conversations.conversations());

// bot.use(conversations.createConversation(settings));

// async function handleSettingChange(
//     conversation: conversations.Conversation<NotifierContext, NotifierContext>,
//     ctx: NotifierContext,
//     key: keyof NotifierState['options'],
// ) {
//     const session = await conversation.external(() => {
//         return ctx.session;
//     })
//     await ctx.editMessageText(`${key}: [${session.options[key]}]`);

//     await ctx.editMessageReplyMarkup({
//         reply_markup: undefined,
//     });

//     const { message } = await conversation.waitFor('message');
//     console.log(message.text);
// }

// async function settings(
//     conversation: conversations.Conversation<NotifierContext, NotifierContext>,
//     ctx: NotifierContext
// ) {
//     const keyboard = new grammy.InlineKeyboard()
//         .text("Interval", "set-interval")
//         .text("Referer", "set-referer")
//         .text("Token", "set-token").row()
//         .text("Allow showing zero messages", "set-showZeroMessages");

//     await ctx.editMessageText("Settings");

//     await ctx.editMessageReplyMarkup({
//         reply_markup: keyboard,
//     });

//     const ctx2 = await conversation.waitForCallbackQuery(/set-.+/);
//     ctx2.reply(ctx2.match.toString());

//     const key = ctx2.match.toString().split('set-')[1] as keyof NotifierState['options'];
//     await handleSettingChange(conversation, ctx, key);

//     await ctx.editMessageText("Settings");

//     await ctx.editMessageReplyMarkup({
//         reply_markup: keyboard,
//     });
// }

// bot.callbackQuery("set-show-zero-messages-true", async (ctx) => {
//     ctx.session.options.allowZeroMessages = true;

//     await ctx.answerCallbackQuery({
//         text: "Done!",
//     });
// });

// bot.callbackQuery("set-show-zero-messages-false", async (ctx) => {
//     ctx.session.options.allowZeroMessages = false;

//     await ctx.answerCallbackQuery({
//         text: "Done!",
//     });
// });

// bot.callbackQuery("set-show-zero-messages", async (ctx) => {
//     const keyboard = new grammy.InlineKeyboard()
//         .text("True", "set-show-zero-messages-true")
//         .text("False", "set-show-zero-messages-false");

//     await ctx.editMessageText("Set show zero messages: " + ctx.session.options.allowZeroMessages);

//     await ctx.editMessageReplyMarkup({
//         reply_markup: keyboard,
//     });

//     // await ctx.answerCallbackQuery({
//     //     text: "",
//     // });
// });

// bot.callbackQuery("check-p", async (ctx) => {
//     const count = await ctx.notifier.getNotificationCount();
//     await ctx.handleNotificationCount(count, true);
//     await ctx.answerCallbackQuery({
//         text: "Done!",
//     });
// });

// bot.callbackQuery("settings-p", async (ctx) => {
//     await ctx.conversation.enter('settings');
//     const count = await ctx.notifier.getNotificationCount();
//     await ctx.handleNotificationCount(count, true);
//     await ctx.answerCallbackQuery({
//         text: "Done!",
//     });
// });

bot.command(['poll'], async (ctx) => {
    ctx.notifier.startPollingNotifications();
});

bot.command(['stop'], async (ctx) => {
    ctx.notifier.stopPollingNotifications();
});

bot.command(['settings'], async (ctx) => {
    ctx.reply(`Referer: ${ctx.session.options.referer}\Token: ${ctx.session.options.token}\Interval: ${ctx.session.options.interval}\nPolling: ${ctx.session.options.polling}`);
});

bot.command('clear', async (ctx) => {
    ctx.session = createNotifierState();

    ctx.reply('Successfully cleared session');
});

bot.api.setMyCommands([
    { command: 'poll', description: 'Start notifications polling' },
    { command: 'stop', description: 'Stop notifications polling' },
    { command: 'interval', description: 'Change interval of notifications polling' },
    { command: 'token', description: 'Change token using with the notifications polling' },
    { command: 'referer', description: 'Change referer using with the notifications polling' },
    { command: 'settings', description: 'Show current settings' },
    { command: 'clear', description: 'Clear your session' },
    { command: 'allow', description: 'Show zero count messages during the notifications polling' },
]);

bot.start({
    timeout: process.env.DEFAULT_INTERVAL ?? 60_000,
});

bot.catch(async (error) => {
    if (!error.ctx.chatId) {
        return;
    }

    await error.ctx.reply(formatError(error));
});
