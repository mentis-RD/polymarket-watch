/**
 * Shared formatting helpers for Telegram alerts.
 *
 * Conventions across all signals:
 * - Market/event title is the clickable heading (no separate raw URL)
 * - Wallet addresses shown as `0xab12…cd34` and clickable to polygonscan
 * - Notionals comma-formatted; thousands abbreviated with k/M when terse
 * - Side labels uppercased + bold (*YES* / *NO*) — visually distinct from
 *   prices and slugs
 * - Date suffix is YYYY-MM-DD only (no time, no TZ)
 *
 * All helpers assume `parseMode: "Markdown"` (legacy MarkdownV1). The
 * label argument is the responsibility of the caller to pre-escape via
 * escapeMd if it contains user-controlled text like a market question.
 */

/**
 * Near-certain price threshold. A BUY at >= this price means the market
 * has already priced the outcome in — no informational edge, so we drop
 * such trades from ALL signals (fresh-wallet, cluster, cross-market,
 * volume-spike). Only the high end is filtered: a cheap buy (<=5c) is a
 * long-shot / contrarian position that CAN carry signal, so it stays.
 */
export const EXTREME_PRICE_HIGH = 0.95;

/** "0xab12…cd34" short form. */
export function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** `[0xab12…cd34](https://polygonscan.com/address/0xfull...)` clickable. */
export function walletLink(addr: string): string {
  return `[${shortAddr(addr)}](https://polygonscan.com/address/${addr})`;
}

/** Explorer per chain id (EVM chain ids + Relay's synthetic non-EVM ids). */
const EXPLORER: Record<number, { name: string; url: (a: string) => string }> = {
  1: { name: "Ethereum", url: (a) => `https://etherscan.io/address/${a}` },
  137: { name: "Polygon", url: (a) => `https://polygonscan.com/address/${a}` },
  8453: { name: "Base", url: (a) => `https://basescan.org/address/${a}` },
  42161: { name: "Arbitrum", url: (a) => `https://arbiscan.io/address/${a}` },
  43114: { name: "Avalanche", url: (a) => `https://snowtrace.io/address/${a}` },
  792703809: { name: "Solana", url: (a) => `https://solscan.io/account/${a}` },
  728126428: { name: "Tron", url: (a) => `https://tronscan.org/#/address/${a}` },
};

/**
 * Link a cross-chain funding ORIGIN to the RIGHT explorer + return its chain
 * name. `bridge_origin_wallet` can live on Solana/Tron (base58, case-sensitive)
 * or an EVM source chain — `walletLink` hardcodes polygonscan, which yields a
 * broken link to a non-Polygon / non-hex address (the "faxwn6…3w5b on
 * polygonscan" bug). Falls back to a non-linked code span for an unknown
 * non-EVM chain rather than fabricating a wrong link.
 */
export function originLink(addr: string, chainId: number | null): { link: string; chain: string } {
  const e = chainId != null ? EXPLORER[chainId] : undefined;
  if (e) return { link: `[${shortAddr(addr)}](${e.url(addr)})`, chain: e.name };
  if (addr.startsWith("0x")) return { link: walletLink(addr), chain: chainId ? `chain:${chainId}` : "" };
  return { link: `\`${shortAddr(addr)}\``, chain: chainId ? `chain:${chainId}` : "non-EVM" };
}

/** `[label](https://polymarket.com/event/<slug>)`. Caller must pre-escape label. */
export function eventLink(slug: string, label: string): string {
  return `[${label}](https://polymarket.com/event/${slug})`;
}

/** `[label](https://polymarket.com/market/<slug>)`. Caller must pre-escape label. */
export function marketLink(slug: string, label: string): string {
  return `[${label}](https://polymarket.com/market/${slug})`;
}

/** "$1,234". Always integer rounded. */
export function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** "$1.2k" / "$1.2M" / "$345". Terser for inline use. */
export function fmtMoneyShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** Bold-uppercase side label: `*YES*` or `*NO*` from outcome index (0=Yes). */
export function sideLabel(idx: 0 | 1): string {
  return idx === 0 ? "*YES*" : "*NO*";
}

/** First 10 chars of ISO date string. Safe on empty/null. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}
