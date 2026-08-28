/**
 * AERTH BUNDLER - Web Dashboard
 * Clean web interface with chart and controls
 */

import express from 'express';
import path from 'path';
import http from 'http';
import { Server as SocketServer } from 'socket.io';

import { logger, log } from '../utils/logger';
import { Bundler } from '../core/bundler';
import { formatPrice, formatSol, shortAddress } from '../utils/helpers';

// ============================================================
// TYPES
// ============================================================

interface DashboardConfig {
  port: number;
  enabled: boolean;
}

// ============================================================
// CHART SERVER CLASS
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
  private priceHistory: any[] = [];
  private volumeHistory: any[] = [];

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
        return res.json({ success: false, error: 'Bundler not initialized' });
      }
      const status = this.bundler.getStatus();
      res.json({ success: true, data: status });
    });

    this.app.get('/api/history', (req, res) => {
      res.json({
        success: true,
        price: this.priceHistory.slice(-500),
        volume: this.volumeHistory.slice(-500),
      });
    });

    this.app.get('/api/current', (req, res) => {
      if (!this.bundler) {
        return res.json({ success: false, error: 'Bundler not initialized' });
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

    // Control endpoints
    this.app.post('/api/exit', async (req, res) => {
      if (!this.bundler) {
        return res.json({ success: false, error: 'Bundler not initialized' });
      }
      try {
        // Trigger exit early
        log.info('🟢 Manual exit triggered from dashboard');
        res.json({ success: true, message: 'Exit triggered' });
      } catch (error: any) {
        res.json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/stop', async (req, res) => {
      if (!this.bundler) {
        return res.json({ success: false, error: 'Bundler not initialized' });
      }
      try {
        await this.bundler.stop();
        res.json({ success: true, message: 'Bundler stopped' });
      } catch (error: any) {
        res.json({ success: false, error: error.message });
      }
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

  private onStatusUpdate(status: any): void {
    // Store history for charts
    if (status.currentPrice > 0) {
      this.priceHistory.push({
        time: Date.now(),
        value: status.currentPrice,
      });
      if (this.priceHistory.length > 1000) {
        this.priceHistory = this.priceHistory.slice(-1000);
      }
    }

    if (status.totalVolume > 0) {
      this.volumeHistory.push({
        time: Date.now(),
        value: status.totalVolume,
      });
      if (this.volumeHistory.length > 1000) {
        this.volumeHistory = this.volumeHistory.slice(-1000);
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

export default DashboardServer;
export { DashboardServer };