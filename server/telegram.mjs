// Telegram bot for whoever runs the server: change the prize pot and split, see who placed, and
// receive winners' wallet addresses. Long polling, so there's no webhook to set up.
//   TELEGRAM_BOT_TOKEN   from @BotFather
//   TELEGRAM_ADMIN_IDS   comma-separated Telegram user ids allowed to use it (message the bot
//                        once and it replies with your id)

// Overridable only so tests can point the bot at a stand-in for Telegram.
const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);

export class TelegramBot {
  /** `onCommand(name, args)` returns the reply text (HTML) for an admin's command. */
  constructor({ token, admins, onCommand, commands }) {
    this.token = token || '';
    this.admins = new Set(admins.filter(Boolean).map(String));
    this.onCommand = onCommand;
    this.commands = commands;
    this.offset = 0;
    this.running = false;
  }

  get enabled() {
    return !!this.token;
  }

  async call(method, body, timeoutMs = 15000) {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    if (!this.admins.size) console.warn('telegram: no TELEGRAM_ADMIN_IDS set; the bot will only tell people their id');
    this.call('setMyCommands', { commands: this.commands }).catch((e) => console.warn(`telegram: ${e.message}`));
    void this.loop();
    console.log(`telegram: bot running for ${this.admins.size} admin(s)`);
  }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] }, 65000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u.message);
        }
      } catch (e) {
        console.warn(`telegram: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  async handle(msg) {
    if (!msg?.text || !msg.from || msg.chat?.type !== 'private') return;
    const from = String(msg.from.id);
    if (!this.admins.has(from)) {
      await this.reply(msg.chat.id, `This bot is private.\nYour Telegram id is <code>${from}</code>.`);
      return;
    }
    const [cmd, ...args] = msg.text.trim().split(/\s+/);
    const name = cmd.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
    let text;
    try {
      text = await this.onCommand(name, args);
    } catch (e) {
      text = `Something went wrong: ${esc(e.message)}`;
    }
    if (text) await this.reply(msg.chat.id, text);
  }

  async reply(chatId, text) {
    try {
      await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.warn(`telegram: ${e.message}`);
    }
  }

  /** To every admin (each must have messaged the bot once, or Telegram won't deliver). */
  notify(text) {
    if (!this.enabled) return;
    for (const id of this.admins) void this.reply(id, text);
  }
}
