/**
 * AERTH BUNDLER - Web Dashboard
 * Clean web interface with chart and controls
 */

import express from 'express';
import path from 'path';
import http from 'http';
import { Server as SocketServer } from 'socket.io';

import { logger } from '../utils/logger';
import { Bundler } from '../core/bundler';

// ============================================================
// TYPES
// ============================================================

interface DashboardConfig {
  port: number;
  enabled: boolean;
}

// ============================================================
// DASHBOARD SERVER CLASS
// ============================================================

export class DashboardServer {
  private app: express.Application;
  private server: http.Server | null = null;
  private io: SocketServer | null = null;
  private bundler: Bundler | null = null;
  private port: number;
  private enabled: boolean;
  private isRunning: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;
  private statusHistory: any[] = [];
  private priceTicks: { time: number; price: number; volume: number }[] = [];
  private lastTotalVolume: number = 0;

  // Matches the volume simulator's 2-8s trade cadence - a 2s bucket was
  // narrower than the average gap between trades, so most candles were
  // empty (no trade landed in that window) with only every ~3rd-5th candle
  // showing real volume. 5s comfortably catches at least one trade per bar.
  private static readonly CANDLE_INTERVAL_SECONDS = 5;
  private static readonly MAX_TICKS = 5000;

  constructor(config: Partial<DashboardConfig> = {}) {
    this.port = config.port || 3001;
    this.enabled = config.enabled !== false;
    
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    
    logger.debug('DashboardServer initialized');
  }

  // ============================================================
  // SETUP
  // ============================================================

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
  }

  private setupRoutes(): void {
    // Serve index.html
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // API endpoints
    this.app.get('/api/status', (req, res) => {
      if (!this.bundler) {
        res.json({ success: false, error: 'Bundler not initialized' });
        return;
      }
      const status = this.bundler.getStatus();
      res.json({ success: true, data: status });
    });

    this.app.get('/api/history', (req, res) => {
      res.json({
        success: true,
        candles: this.buildCandles(),
      });
    });

    this.app.get('/api/current', (req, res) => {
      if (!this.bundler) {
        res.json({ success: false, error: 'Bundler not initialized' });
        return;
      }
      const status = this.bundler.getStatus();
      res.json({
        success: true,
        data: {
          price: status.currentPrice || 0,
          multiplier: status.currentMultiplier || 1,
          volume: status.totalVolume || 0,
          phase: status.phase || 'idle',
          tokenName: status.tokenName || 'N/A',
          tokenSymbol: status.tokenSymbol || 'N/A',
          tokenMint: status.tokenMint || null,
          timeRemaining: status.timeRemaining || 0,
          profitTarget: status.profitTarget || 3,
        }
      });
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.isRunning ? 'ok' : 'stopped',
        port: this.port,
        enabled: this.enabled,
      });
    });
  }

  // ============================================================
  // START / STOP
  // ============================================================

  start(bundler: Bundler): void {
    if (!this.enabled) {
      logger.info('Dashboard disabled');
      return;
    }

    if (this.isRunning) {
      logger.warn('Dashboard already running');
      return;
    }

    this.bundler = bundler;
    
    // Set up bundler callbacks
    bundler.onStatus((status) => {
      this.onStatusUpdate(status);
    });

    // Create server
    this.server = http.createServer(this.app);
    
    // Setup Socket.IO for real-time updates
    this.io = new SocketServer(this.server, {
      cors: { origin: '*' },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket) => {
      logger.debug('Client connected to dashboard');
      
      // Send initial status
      const status = bundler.getStatus();
      socket.emit('status', status);
      
      socket.on('disconnect', () => {
        logger.debug('Client disconnected');
      });
    });

    // Start server
    this.server.listen(this.port, () => {
      this.isRunning = true;
      logger.success(`📊 Web dashboard: http://localhost:${this.port}`);
      logger.info(`   Press Ctrl+C to stop`);
    });

    // Start update loop
    this.startUpdateLoop();

    // Handle exit signals
    process.on('SIGINT', () => {
      this.stop();
    });
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.io) {
      this.io.close();
      this.io = null;
    }

    if (this.server) {
      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        logger.info('Dashboard stopped');
      });
    }
  }

  // ============================================================
  // UPDATE LOOP
  // ============================================================

  private startUpdateLoop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(() => {
      if (this.bundler && this.io) {
        try {
          const status = this.bundler.getStatus();
          this.io?.emit('status', status);
        } catch (error) {
          // Ignore
        }
      }
    }, 1000);
  }

  /**
   * Bucket recorded price ticks into OHLCV candles for the chart, plotted in
   * MARKET CAP (price * tokenSupply) rather than raw price. Raw token price
   * here is on the order of 1e-9 SOL - far below lightweight-charts' default
   * price-axis precision (2 decimals / 0.01 minMove), so every candle would
   * silently round to the same value and render as a flat, dead line. Market
   * cap is the same shape (just price times a fixed constant) but lands in a
   * normal, readable SOL range the chart can actually plot.
   */
  private buildCandles(): Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> {
    const interval = DashboardServer.CANDLE_INTERVAL_SECONDS;
    const tokenSupply = this.bundler?.getStatus().tokenSupply || 0;
    // Same fixed devnet display rate as the sidebar/ticker - keeps the
    // chart's own axis numbers consistent with the market cap stat instead
    // of one showing SOL and the other showing USD.
    const solUsdPrice = parseFloat(process.env.SOL_USD_PRICE || '150');
    const candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];

    for (const tick of this.priceTicks) {
      const marketCap = tick.price * tokenSupply * solUsdPrice;
      const bucketTime = Math.floor(tick.time / 1000 / interval) * interval;
      const last = candles[candles.length - 1];

      if (last && last.time === bucketTime) {
        last.high = Math.max(last.high, marketCap);
        last.low = Math.min(last.low, marketCap);
        last.close = marketCap;
        last.volume += tick.volume;
      } else {
        candles.push({
          time: bucketTime,
          open: last ? last.close : marketCap,
          high: marketCap,
          low: marketCap,
          close: marketCap,
          volume: tick.volume,
        });
      }
    }

    return candles;
  }

  private onStatusUpdate(status: any): void {
    // Store price/volume ticks for the candlestick chart
    if (status.currentPrice > 0) {
      const totalVolume = status.totalVolume || 0;
      const volumeDelta = Math.max(0, totalVolume - this.lastTotalVolume);
      this.lastTotalVolume = totalVolume;

      this.priceTicks.push({
        time: Date.now(),
        price: status.currentPrice,
        volume: volumeDelta,
      });
      if (this.priceTicks.length > DashboardServer.MAX_TICKS) {
        this.priceTicks = this.priceTicks.slice(-DashboardServer.MAX_TICKS);
      }
    }

    // Log phase changes
    if (this.statusHistory.length === 0 || 
        this.statusHistory[this.statusHistory.length - 1].phase !== status.phase) {
      logger.info(`📊 Phase: ${status.phase.toUpperCase()}`);
    }

    this.statusHistory.push(status);
    if (this.statusHistory.length > 100) {
      this.statusHistory = this.statusHistory.slice(-100);
    }
  }

  // ============================================================
  // STATUS
  // ============================================================

  isRunningCheck(): boolean {
    return this.isRunning;
  }

  getPort(): number {
    return this.port;
  }
}

// ============================================================
// EXPORT DEFAULT
// ============================================================

export default DashboardServer;