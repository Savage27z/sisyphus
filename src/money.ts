/** "$25" for a symbol currency, "2.5 SOL" for a named one (the server picks the currency). */
export function money(amount: number, currency: string): string {
  const n = String(Math.round(amount * 1e4) / 1e4);
  return isSymbol(currency) ? `${currency}${n}` : `${n} ${currency}`;
}

export const isSymbol = (currency: string): boolean => /^[^A-Za-z0-9\s]{1,2}$/.test(currency);

export const ORDINAL = ['1st', '2nd', '3rd'];

/** 1st, 2nd, 3rd, 4th … 11th, 12th … 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}
