/**
 * AERTH BUNDLER - Chart API
 * In-memory OHLCV candle store fed by the volume simulator, exposed as an Express router
 */

import { Router, Request, Response } from 'express';

// ============================================================
// TYPES
// ============================================================

export interface Candle {
  time: number; // unix seconds, aligned to bucket start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceTick {
  price: number;
  volume?: number;
  timestamp?: number; // ms, defaults to now
}

// ============================================================
// CANDLE STORE
// ============================================================

const CANDLE_INTERVAL_SECONDS = 5;
const MAX_CANDLES = 2000;

export class CandleStore {
  private candles: Candle[] = [];
  private tokenMint: string | null = null;
  private tokenSymbol: string = 'TOKEN';
  private lastPrice: number = 0;

  setToken(mint: string, symbol: string): void {
    this.tokenMint = mint;
    this.tokenSymbol = symbol;
  }

  getToken(): { mint: string | null; symbol: string } {
    return { mint: this.tokenMint, symbol: this.tokenSymbol };
  }

  /**
   * Record a price tick, folding it into the current or a new candle bucket
   */
  recordTick(tick: PriceTick): Candle {
    const timestampMs = tick.timestamp ?? Date.now();
    const bucketStart = Math.floor(timestampMs / 1000 / CANDLE_INTERVAL_SECONDS) * CANDLE_INTERVAL_SECONDS;
    const volume = tick.volume ?? 0;

    this.lastPrice = tick.price;

    const last = this.candles[this.candles.length - 1];

    if (last && last.time === bucketStart) {
      last.high = Math.max(last.high, tick.price);
      last.low = Math.min(last.low, tick.price);
      last.close = tick.price;
      last.volume += volume;
      return last;
    }

    const candle: Candle = {
      time: bucketStart,
      open: last ? last.close : tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume,
    };

    this.candles.push(candle);
    if (this.candles.length > MAX_CANDLES) {
      this.candles = this.candles.slice(-MAX_CANDLES);
    }

    return candle;
  }

  getCurrentPrice(): number {
    return this.lastPrice;
  }

  getHistory(limit: number = MAX_CANDLES): Candle[] {
    return this.candles.slice(-limit);
  }

  reset(): void {
    this.candles = [];
    this.lastPrice = 0;
  }
}

// Single shared store for the process
export const candleStore = new CandleStore();

// ============================================================
// ROUTER
// ============================================================

export function createChartApiRouter(): Router {
  const router = Router();

  router.get('/current', (_req: Request, res: Response) => {
    const { mint, symbol } = candleStore.getToken();
    res.json({
      price: candleStore.getCurrentPrice(),
      tokenMint: mint,
      tokenSymbol: symbol,
      timestamp: Date.now(),
    });
  });

  router.get('/price', (_req: Request, res: Response) => {
    res.json({ price: candleStore.getCurrentPrice() });
  });

  router.get('/history', (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    res.json({ candles: candleStore.getHistory(limit) });
  });

  router.post('/tick', (req: Request, res: Response) => {
    const { price, volume, timestamp } = req.body || {};
    if (typeof price !== 'number' || price <= 0) {
      res.status(400).json({ error: 'price must be a positive number' });
      return;
    }
    const candle = candleStore.recordTick({ price, volume, timestamp });
    res.json({ candle });
  });

  return router;
}
