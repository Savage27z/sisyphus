import { apiUrl } from './endpoint';
import { ORDINAL } from './money';

/** A prize this browser won in a prize round. Kept a week, so it can still be claimed later. */
export interface Prize {
  /** One-time secret from the server that proves this browser placed. */
  token: string;
  place: number;
  share: number;
  /** The amount, formatted ("1.5 SOL"). */
  label: string;
  pot: string;
  map: string;
  at: number;
  /** The address sent in, once it's been accepted. */
  wallet?: string;
  /** When it was first sent (it can be corrected for a short while after). */
  walletAt?: number;
}

const KEY = 'sisyphus.prizes.v1';
const TTL_MS = 7 * 24 * 3600 * 1000;
/** Matches the server: an address can be corrected for 15 minutes, then it's final. */
const EDIT_MS = 15 * 60 * 1000;
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

function load(): Prize[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Prize[];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.token === 'string' && Date.now() - p.at < TTL_MS) : [];
  } catch {
    return [];
  }
}

function store(list: Prize[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-20)));
  } catch {
    /* storage unavailable: the prize page still works for this visit */
  }
}

/** Why this can't be sent as a wallet address, or null when it looks like one. Secrets never leave the page. */
export function walletProblem(text: string): string | null {
  const s = text.trim();
  if (!s) return 'Paste your Solana wallet address first.';
  if (s.split(/\s+/).length >= 12) return 'That looks like a seed phrase. Never share it with anyone! Paste your wallet’s public address instead.';
  if (s.startsWith('[') || /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(s)) return 'That looks like a private key. Never share it! Paste your wallet’s public address instead.';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return 'That isn’t a Solana address. Copy it from Phantom, Solflare or Backpack (32 to 44 letters and numbers).';
  return null;
}

/** The prize page: someone who placed in a prize round sends the Solana address for their prize. */
export class Claims {
  /** Something changed (a new prize, a wallet sent): refresh the "claim your prize" buttons. */
  onChange: () => void = () => {};
  private current: Prize | null = null;
  private busy = false;
  private readonly input = $('claimWallet') as HTMLInputElement;

  constructor() {
    $('claimClose').addEventListener('click', () => this.close());
    $('claimLater').addEventListener('click', () => this.close());
    $('claimDoneBtn').addEventListener('click', () => this.close());
    $('claimSend').addEventListener('click', () => void this.send());
    $('claimChange').addEventListener('click', () => this.showForm(true));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.send();
    });
    this.input.addEventListener('input', () => ($('claimStatus').textContent = ''));
  }

  all(): Prize[] {
    return load().sort((a, b) => b.at - a.at);
  }

  unclaimed(): Prize[] {
    return this.all().filter((p) => !p.wallet);
  }

  get isOpen(): boolean {
    return !$('claim').classList.contains('hidden');
  }

  /** The server says we placed: keep the prize and ask for the wallet straight away. */
  won(p: Prize): void {
    store([...load().filter((q) => q.token !== p.token), p]);
    this.open(p.token);
    this.onChange();
  }

  /** Show a prize (the newest unclaimed one if none is named). */
  open(token?: string): void {
    const p = token ? load().find((q) => q.token === token) : this.unclaimed()[0];
    if (!p) return;
    this.current = p;
    const badge = $('claimBadge');
    badge.textContent = (ORDINAL[p.place - 1] ?? `#${p.place}`).toUpperCase();
    badge.dataset.place = String(p.place);
    $('claimTitle').textContent = p.place === 1 ? 'YOU WON!' : `${(ORDINAL[p.place - 1] ?? '').toUpperCase()} PLACE!`;
    $('claimPrize').innerHTML = `Your prize: <b>${esc(p.label)}</b>`;
    $('claimSub').textContent = `${p.share}% of the ${p.pot} pot`;
    $('claimStatus').textContent = '';
    this.input.value = p.wallet ?? '';
    this.showForm(!p.wallet);
    $('claim').classList.remove('hidden');
  }

  close(): void {
    $('claim').classList.add('hidden');
    this.current = null;
    this.onChange();
  }

  private showForm(on: boolean): void {
    $('claimForm').classList.toggle('hidden', !on);
    $('claimDone').classList.toggle('hidden', on);
    if (!on && this.current?.wallet) {
      const editable = Date.now() - (this.current.walletAt ?? 0) < EDIT_MS;
      $('claimDoneText').innerHTML =
        `Your prize goes to <b>${esc(short(this.current.wallet))}</b>. Prizes are sent by hand, so give it a little while.` +
        (editable ? ' You can still fix a typo for 15 minutes.' : '');
      $('claimChange').classList.toggle('hidden', !editable);
    }
    if (on) setTimeout(() => this.input.focus(), 50);
  }

  private async send(): Promise<void> {
    const p = this.current;
    if (!p || this.busy) return;
    const wallet = this.input.value.trim();
    const problem = walletProblem(wallet);
    if (problem) {
      $('claimStatus').textContent = problem;
      if (/seed phrase|private key/.test(problem)) this.input.value = '';
      return;
    }
    this.busy = true;
    $('claimSend').setAttribute('disabled', '');
    $('claimStatus').textContent = 'Sending…';
    try {
      const res = await fetch(apiUrl('/api/claim'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: p.token, wallet }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        $('claimStatus').textContent = body.error ?? 'Couldn’t send it. Check your connection and try again.';
        return;
      }
      p.wallet = wallet;
      p.walletAt ??= Date.now();
      store(load().map((q) => (q.token === p.token ? { ...q, wallet, walletAt: p.walletAt } : q)));
      $('claimStatus').textContent = '';
      this.showForm(false);
      this.onChange();
    } catch {
      $('claimStatus').textContent = 'Couldn’t reach the server. Try again in a moment.';
    } finally {
      this.busy = false;
      $('claimSend').removeAttribute('disabled');
    }
  }
}
