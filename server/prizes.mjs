// Prize rounds: the pot and how it's split (changed from Telegram), who placed, and the wallet
// addresses winners send in. Paying is done by hand by whoever runs the server; nothing here
// moves money. Kept in DATA_DIR/prizes.json, written atomically (temp file + rename).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CLAIMS = 1000;
/** A winner has this long to send their wallet address. */
const CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const ORDINAL = ['1st', '2nd', '3rd'];

/** A Solana address: base58 that decodes to exactly 32 bytes (a public key). */
export function isSolanaAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes++;
  }
  return bytes === 32;
}

/** "$25" for a symbol, "2.5 SOL" for a word. */
export function money(amount, currency) {
  const n = String(Math.round(amount * 1e4) / 1e4);
  return /^[^A-Za-z0-9\s]{1,2}$/.test(currency) ? `${currency}${n}` : `${n} ${currency}`;
}

const hashToken = (token) => crypto.createHash('sha256').update(`claim:${token}`).digest('hex');

export class Prizes {
  constructor(dir, defaults) {
    this.file = path.join(dir, 'prizes.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = { settings: { ...defaults }, claims: [], nextId: 1 };
    if (fs.existsSync(this.file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...saved, settings: { ...defaults, ...saved.settings } };
      } catch (e) {
        const bad = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, bad);
        console.error(`prizes: could not read ${this.file} (${e.message}); moved it to ${bad}`);
      }
    }
    this.timer = null;
  }

  get settings() {
    return this.data.settings;
  }

  /** Change the pot, currency, split or minimum players. Returns the new settings. */
  update(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  /**
   * A prize round finished: one claim per paid place. `placed` is in finishing order:
   * [{ pid, name, reason }]. Returns [{ claim, token }] (the token goes only to that player).
   */
  award({ arena, map, amount, currency, split }, placed) {
    const out = [];
    placed.slice(0, split.length).forEach((p, i) => {
      const token = crypto.randomBytes(24).toString('base64url');
      const claim = {
        id: this.data.nextId++,
        at: Date.now(),
        arena,
        map,
        place: i + 1,
        name: p.name,
        pid: p.pid ?? null,
        reason: p.reason,
        share: split[i],
        // Percent of the pot, to the millionth (SOL amounts like 0.625 must not round to cents).
        amount: Math.round(amount * split[i] * 1e4) / 1e6,
        currency,
        tokenHash: hashToken(token),
        wallet: null,
        walletAt: 0,
      };
      this.data.claims.push(claim);
      out.push({ claim, token });
    });
    if (this.data.claims.length > MAX_CLAIMS) this.data.claims.splice(0, this.data.claims.length - MAX_CLAIMS);
    this.save();
    return out;
  }

  /** A winner sent their wallet. Returns { claim, updated } or { error }. */
  submit(token, wallet) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return { error: 'That prize link is not valid.' };
    const claim = this.data.claims.find((c) => c.tokenHash === hashToken(token));
    if (!claim) return { error: 'That prize link is not valid.' };
    if (Date.now() - claim.at > CLAIM_TTL_MS) return { error: 'This prize has expired.' };
    if (!isSolanaAddress(wallet)) return { error: 'That is not a Solana wallet address.' };
    const updated = !!claim.wallet && claim.wallet !== wallet;
    if (claim.wallet === wallet) return { claim, updated: false, same: true };
    claim.wallet = wallet;
    claim.walletAt = Date.now();
    this.save();
    return { claim, updated };
  }

  recent(n = 10) {
    return this.data.claims.slice(-n).reverse();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
