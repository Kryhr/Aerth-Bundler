/**
 * AERTH BUNDLER - Chart Dashboard Server
 * Serves a local TradingView-style chart fed by the volume simulator's price ticks
 */

import express, { Express } from 'express';
import http from 'http';
import path from 'path';

import { logger } from '../../utils/logger';
import { createChartApiRouter, candleStore, PriceTick } from './api';

const DEFAULT_CHART_PORT = 3001;

export class ChartServer {
  private app: Express;
  private server: http.Server | null = null;
  private port: number;

  constructor(port: number = DEFAULT_CHART_PORT) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use('/api', createChartApiRouter());
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.success(`Chart dashboard running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null as unknown as http.Server;
    });
  }

  /**
   * Register the token being tracked (called once the bundler mints it)
   */
  setToken(mint: string, symbol: string): void {
    candleStore.setToken(mint, symbol);
  }

  /**
   * Push a price tick from the volume simulator into the candle store
   */
  pushTick(tick: PriceTick): void {
    candleStore.recordTick(tick);
  }
}

export default ChartServer;
