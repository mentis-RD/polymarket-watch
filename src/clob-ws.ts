import { WebSocket } from "undici";
import { EventEmitter } from "node:events";
import { log, err } from "./log.js";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface TradeEvent {
  asset_id: string;
  market: string; // condition_id, 0x...
  price: number;
  size: number;
  side: "BUY" | "SELL";
  ts: number; // ms since epoch
  fee_rate_bps?: number;
}

interface RawTrade {
  event_type: "last_trade_price";
  asset_id?: string;
  market?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
  timestamp?: string;
  fee_rate_bps?: string;
}

export interface ClobWSEvents {
  trade: (t: TradeEvent) => void;
  open: () => void;
  close: () => void;
  error: (e: Error) => void;
}

/**
 * Single WebSocket connection to Polymarket's CLOB market channel.
 * Auto-reconnects with exponential backoff. Re-subscribes to current asset_ids on each open.
 */
export class ClobWS extends EventEmitter {
  private ws: WebSocket | null = null;
  private assetIds = new Set<string>();
  private closed = false;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 60_000;
  private pingTimer: NodeJS.Timeout | null = null;

  emit<K extends keyof ClobWSEvents>(event: K, ...args: Parameters<ClobWSEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof ClobWSEvents>(event: K, listener: ClobWSEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  setAssetIds(ids: string[]): void {
    const next = new Set(ids);
    const sameSize = next.size === this.assetIds.size;
    const sameAll = sameSize && [...next].every((id) => this.assetIds.has(id));
    this.assetIds = next;
    if (sameAll) return;
    log("clob-ws", `asset_ids updated (${next.size}); reconnecting`);
    this.reconnect();
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private reconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (!this.closed) this.connect();
  }

  private connect(): void {
    if (this.assetIds.size === 0) {
      log("clob-ws", "no asset_ids subscribed; idle");
      return;
    }
    log("clob-ws", `connecting (${this.assetIds.size} assets)`);
    const ws = new WebSocket(URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      log("clob-ws", "open");
      this.backoffMs = 1000;
      const sub = {
        assets_ids: [...this.assetIds],
        type: "market",
        custom_feature_enabled: false,
      };
      try {
        ws.send(JSON.stringify(sub));
      } catch (e) {
        err("clob-ws", "subscribe send failed", e);
      }
      this.emit("open");

      // App-level keepalive: many WS proxies idle-close after ~60s without traffic.
      this.pingTimer = setInterval(() => {
        try {
          if (ws.readyState === 1) ws.send("PING");
        } catch {
          /* ignore */
        }
      }, 30_000);
    });

    ws.addEventListener("message", (ev) => {
      try {
        const txt = typeof ev.data === "string" ? ev.data : ev.data.toString();
        if (txt === "PONG" || txt === "PING") return;
        const data: unknown = JSON.parse(txt);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          this.handleMessage(item as Record<string, unknown>);
        }
      } catch (e) {
        err("clob-ws", "parse message failed", e);
      }
    });

    ws.addEventListener("close", () => {
      log("clob-ws", `close (backoff ${this.backoffMs}ms)`);
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.ws = null;
      this.emit("close");
      if (!this.closed && this.assetIds.size > 0) {
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      }
    });

    ws.addEventListener("error", (ev) => {
      const e = (ev as unknown as { error?: Error }).error || new Error("ws error");
      err("clob-ws", "error", e.message);
      this.emit("error", e);
    });
  }

  private handleMessage(item: Record<string, unknown>): void {
    if (item.event_type !== "last_trade_price") return;
    const r = item as unknown as RawTrade;
    const price = Number(r.price);
    const size = Number(r.size);
    const ts = Number(r.timestamp);
    if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) return;
    if (!r.asset_id || !r.market || !r.side) return;
    const trade: TradeEvent = {
      asset_id: r.asset_id,
      market: r.market,
      price,
      size,
      side: r.side,
      ts,
      fee_rate_bps: r.fee_rate_bps ? Number(r.fee_rate_bps) : undefined,
    };
    this.emit("trade", trade);
  }
}
