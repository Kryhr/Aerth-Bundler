/**
 * AERTH BUNDLER - Dashboard Server
 * Real-time terminal dashboard for monitoring the bundler
 */

import blessed from 'blessed';
import { format } from 'util';

import { logger } from '../utils/logger';
import {
  formatSol,
  formatPrice,
  shortAddress,
  formatTimeRemaining,
  formatDate,
} from '../utils/helpers';
import { Bundler } from '../core/bundler';

// ============================================================
// TYPES
// ============================================================

interface DashboardConfig {
  refreshInterval: number; // milliseconds
  showPriceChart: boolean;
  showVolumeChart: boolean;
  maxHistoryItems: number;
  colors: {
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    error: string;
    highlight: string;
    dim: string;
  };
}

interface ChartData {
  timestamp: number;
  value: number;
}

// ============================================================
// DEFAULT CONFIG
// ============================================================

const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  refreshInterval: 1000,
  showPriceChart: true,
  showVolumeChart: true,
  maxHistoryItems: 100,
  colors: {
    primary: 'cyan',
    secondary: 'blue',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    highlight: 'white',
    dim: 'gray',
  },
};

// ============================================================
// MAIN DASHBOARD CLASS
// ============================================================

export class Dashboard {
  private screen: blessed.Screen | null = null;
  private bundler: Bundler | null = null;
  private config: DashboardConfig;
  private isRunning: boolean = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  
  // UI Elements
  private elements: {
    header?: blessed.Box;
    status?: blessed.Box;
    tokenInfo?: blessed.Box;
    walletInfo?: blessed.Box;
    priceChart?: blessed.Box;
    volumeChart?: blessed.Box;
    exitInfo?: blessed.Box;
    logBox?: blessed.Log;
    footer?: blessed.Box;
  } = {};
  
  // Data
  private priceHistory: ChartData[] = [];
  private volumeHistory: ChartData[] = [];
  private logMessages: string[] = [];
  private statusData: any = {};

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = { ...DEFAULT_DASHBOARD_CONFIG, ...config };
    logger.debug('Dashboard initialized');
  }

  // ============================================================
  // START / STOP
  // ============================================================

  /**
   * Start the dashboard
   */
  start(bundler: Bundler): void {
    if (this.isRunning) {
      logger.warn('Dashboard already running');
      return;
    }

    this.bundler = bundler;
    this.isRunning = true;

    // Create screen
    this.createScreen();
    
    // Create UI elements
    this.createUI();
    
    // Start refresh loop
    this.startRefreshLoop();
    
    // Render
    this.screen?.render();

    logger.success('Dashboard started');
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    this.isRunning = false;
    
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
    
    logger.info('Dashboard stopped');
  }

  // ============================================================
  // SCREEN CREATION
  // ============================================================

  /**
   * Create blessed screen
   */
  private createScreen(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'AERTH BUNDLER - Dashboard',
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: null,
      },
      log: true,
      fullUnicode: true,
      dockBorders: true,
      ignoreDockContrast: true,
      useBCE: true,
    });

    // Handle resize
    this.screen.on('resize', () => {
      this.resizeUI();
    });

    // Handle exit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop();
      process.exit(0);
    });

    // Handle refresh
    this.screen.key(['r'], () => {
      this.refreshUI();
    });
  }

  // ============================================================
  // UI CREATION
  // ============================================================

  /**
   * Create all UI elements
   */
  private createUI(): void {
    if (!this.screen) return;

    const screen = this.screen;
    const width = screen.width;
    const height = screen.height;

    // ────────────────────────────────────────────────────────
    // HEADER
    // ────────────────────────────────────────────────────────
    
    this.elements.header = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      style: {
        fg: this.config.colors.primary,
        bg: 'black',
        bold: true,
      },
      tags: true,
      content: ' AERTH BUNDLER v1.0  [Ctrl+C to exit]  [R to refresh]',
      border: {
        type: 'line',
        fg: this.config.colors.primary,
      },
    });

    // ────────────────────────────────────────────────────────
    // STATUS BAR
    // ────────────────────────────────────────────────────────

    this.elements.status = blessed.box({
      parent: screen,
      top: 3,
      left: 0,
      width: '100%',
      height: 3,
      style: {
        fg: this.config.colors.secondary,
        bg: 'black',
      },
      tags: true,
      content: ' Loading... ',
      border: {
        type: 'line',
        fg: this.config.colors.secondary,
      },
    });

    // ────────────────────────────────────────────────────────
    // TOKEN INFO
    // ────────────────────────────────────────────────────────

    this.elements.tokenInfo = blessed.box({
      parent: screen,
      top: 6,
      left: 0,
      width: '50%',
      height: 8,
      style: {
        fg: this.config.colors.highlight,
        bg: 'black',
      },
      tags: true,
      label: ' Token Information ',
      border: {
        type: 'line',
        fg: this.config.colors.secondary,
      },
    });

    // ────────────────────────────────────────────────────────
    // WALLET INFO
    // ────────────────────────────────────────────────────────

    this.elements.walletInfo = blessed.box({
      parent: screen,
      top: 6,
      left: '50%',
      width: '50%',
      height: 8,
      style: {
        fg: this.config.colors.highlight,
        bg: 'black',
      },
      tags: true,
      label: ' Wallet Information ',
      border: {
        type: 'line',
        fg: this.config.colors.secondary,
      },
    });

    // ────────────────────────────────────────────────────────
    // PRICE CHART
    // ────────────────────────────────────────────────────────

    if (this.config.showPriceChart) {
      this.elements.priceChart = blessed.box({
        parent: screen,
        top: 14,
        left: 0,
        width: '50%',
        height: 10,
        style: {
          fg: this.config.colors.success,
          bg: 'black',
        },
        tags: true,
        label: ' Price Chart ',
        border: {
          type: 'line',
          fg: this.config.colors.success,
        },
      });
    }

    // ────────────────────────────────────────────────────────
    // VOLUME CHART
    // ────────────────────────────────────────────────────────

    if (this.config.showVolumeChart) {
      this.elements.volumeChart = blessed.box({
        parent: screen,
        top: 14,
        left: '50%',
        width: '50%',
        height: 10,
        style: {
          fg: this.config.colors.warning,
          bg: 'black',
        },
        tags: true,
        label: ' Volume Chart ',
        border: {
          type: 'line',
          fg: this.config.colors.warning,
        },
      });
    }

    // ────────────────────────────────────────────────────────
    // EXIT INFO
    // ────────────────────────────────────────────────────────

    this.elements.exitInfo = blessed.box({
      parent: screen,
      top: 24,
      left: 0,
      width: '50%',
      height: 6,
      style: {
        fg: this.config.colors.highlight,
        bg: 'black',
      },
      tags: true,
      label: ' Exit Information ',
      border: {
        type: 'line',
        fg: this.config.colors.warning,
      },
    });

    // ────────────────────────────────────────────────────────
    // LOG BOX
    // ────────────────────────────────────────────────────────

    this.elements.logBox = blessed.log({
      parent: screen,
      top: 24,
      left: '50%',
      width: '50%',
      height: 6,
      style: {
        fg: this.config.colors.dim,
        bg: 'black',
      },
      tags: true,
      label: ' Activity Log ',
      border: {
        type: 'line',
        fg: this.config.colors.dim,
      },
      scrollable: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'black',
        },
        style: {
          inverse: true,
        },
      },
      keys: true,
      vi: true,
      mouse: true,
    });

    // ────────────────────────────────────────────────────────
    // FOOTER
    // ────────────────────────────────────────────────────────

    this.elements.footer = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        fg: this.config.colors.dim,
        bg: 'black',
      },
      tags: true,
      content: ' {gray-fg}Press [Q] to quit  |  [R] to refresh  |  [E] to exit early{/gray-fg}',
    });

    // Initial render
    screen.render();
  }

  // ============================================================
  // UI UPDATE
  // ============================================================

  /**
   * Refresh all UI elements
   */
  private refreshUI(): void {
    if (!this.bundler || !this.screen) return;

    try {
      const status = this.bundler.getStatus();
      this.statusData = status;

      // Update each section
      this.updateHeader(status);
      this.updateStatus(status);
      this.updateTokenInfo(status);
      this.updateWalletInfo(status);
      this.updatePriceChart(status);
      this.updateVolumeChart(status);
      this.updateExitInfo(status);
      this.updateLog();

      // Render
      this.screen.render();

    } catch (error) {
      logger.error('Failed to refresh UI', error);
    }
  }

  /**
   * Update header
   */
  private updateHeader(status: any): void {
    if (!this.elements.header) return;

    const phaseIcon = this.getPhaseIcon(status.phase);
    const phaseName = status.phase.toUpperCase();
    
    this.elements.header.setContent(
      ` {bold}${phaseIcon} AERTH BUNDLER v1.0{/bold}  ` +
      `[${phaseName}]  ` +
      `{gray-fg}${formatDate()}{/gray-fg}`
    );
  }

  /**
   * Update status bar
   */
  private updateStatus(status: any): void {
    if (!this.elements.status) return;

    const statusColor = this.getStatusColor(status.phase);
    const statusText = this.getStatusText(status);

    this.elements.status.setContent(
      ` {${statusColor}-fg}●{/${statusColor}-fg} ${statusText}`
    );
  }

  /**
   * Update token info
   */
  private updateTokenInfo(status: any): void {
    if (!this.elements.tokenInfo) return;

    const lines = [
      ` {bold}Name:{/bold}       ${status.tokenName} (${status.tokenSymbol})`,
      ` {bold}Mint:{/bold}       ${status.tokenMint ? shortAddress(status.tokenMint) : 'N/A'}`,
      ` {bold}Price:{/bold}      ${formatPrice(status.currentPrice)}`,
      ` {bold}Multiplier:{/bold} ${status.currentMultiplier?.toFixed(2) || '1.00'}x`,
    ];

    this.elements.tokenInfo.setContent(lines.join('\n'));
  }

  /**
   * Update wallet info
   */
  private updateWalletInfo(status: any): void {
    if (!this.elements.walletInfo) return;

    const lines = [
      ` {bold}Total Wallets:{/bold}   ${status.totalWallets || 0}`,
      ` {bold}Funded Wallets:{/bold}  ${status.fundedWallets || 0}`,
      ` {bold}Total Volume:{/bold}    ${formatSol(status.totalVolume || 0)}`,
      ` {bold}Current Profit:{/bold}  ${this.formatProfit(status)}`,
    ];

    this.elements.walletInfo.setContent(lines.join('\n'));
  }

  /**
   * Update price chart
   */
  private updatePriceChart(status: any): void {
    if (!this.elements.priceChart) return;

    // Store price history
    if (status.currentPrice > 0) {
      this.priceHistory.push({
        timestamp: Date.now(),
        value: status.currentPrice,
      });
      
      if (this.priceHistory.length > this.config.maxHistoryItems) {
        this.priceHistory = this.priceHistory.slice(-this.config.maxHistoryItems);
      }
    }

    // Render chart
    const chart = this.renderChart(this.priceHistory, 40, 6);
    this.elements.priceChart.setContent(chart);
  }

  /**
   * Update volume chart
   */
  private updateVolumeChart(status: any): void {
    if (!this.elements.volumeChart) return;

    // Store volume history
    if (status.totalVolume > 0) {
      this.volumeHistory.push({
        timestamp: Date.now(),
        value: status.totalVolume,
      });
      
      if (this.volumeHistory.length > this.config.maxHistoryItems) {
        this.volumeHistory = this.volumeHistory.slice(-this.config.maxHistoryItems);
      }
    }

    // Render chart
    const chart = this.renderChart(this.volumeHistory, 40, 6);
    this.elements.volumeChart.setContent(chart);
  }

  /**
   * Update exit info
   */
  private updateExitInfo(status: any): void {
    if (!this.elements.exitInfo) return;

    const timeRemaining = status.timeRemaining || 0;
    const progress = status.currentMultiplier && status.profitTarget
      ? Math.min((status.currentMultiplier / status.profitTarget) * 100, 100)
      : 0;

    const lines = [
      ` {bold}Target:{/bold}        ${status.profitTarget || 3.0}x`,
      ` {bold}Progress:{/bold}      ${progress.toFixed(1)}% [${this.renderProgressBar(progress, 20)}]`,
      ` {bold}Time Remaining:{/bold} ${formatTimeRemaining(timeRemaining)}`,
      ` {bold}Status:{/bold}        ${this.getExitStatus(status)}`,
    ];

    this.elements.exitInfo.setContent(lines.join('\n'));
  }

  /**
   * Update log
   */
  private updateLog(): void {
    if (!this.elements.logBox) return;

    // Add new log messages if any
    // This would be populated from the logger
  }

  // ============================================================
  // CHART RENDERING
  // ============================================================

  /**
   * Render ASCII chart
   */
  private renderChart(data: ChartData[], width: number, height: number): string {
    if (data.length === 0) {
      return ' No data yet...';
    }

    const values = data.map(d => d.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    let chart = '';
    const step = Math.max(1, Math.floor(data.length / width));

    for (let row = height; row >= 0; row--) {
      const threshold = min + (range * row / height);
      let line = '';
      
      for (let col = 0; col < width; col++) {
        const index = Math.min(col * step, data.length - 1);
        const value = data[index]?.value || 0;
        
        if (value >= threshold) {
          line += '█';
        } else {
          line += ' ';
        }
      }
      
      chart += line + '\n';
    }

    return chart;
  }

  /**
   * Render progress bar
   */
  private renderProgressBar(progress: number, width: number): string {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Get phase icon
   */
  private getPhaseIcon(phase: string): string {
    const icons: Record<string, string> = {
      idle: '⏸️',
      preparing: '⚙️',
      launching: '🚀',
      buying: '💎',
      simulating: '📊',
      exiting: '🔥',
      complete: '🎉',
      error: '❌',
    };
    return icons[phase] || '⏳';
  }

  /**
   * Get status color
   */
  private getStatusColor(phase: string): string {
    const colors: Record<string, string> = {
      idle: 'gray',
      preparing: 'blue',
      launching: 'cyan',
      buying: 'green',
      simulating: 'yellow',
      exiting: 'red',
      complete: 'green',
      error: 'red',
    };
    return colors[phase] || 'gray';
  }

  /**
   * Get status text
   */
  private getStatusText(status: any): string {
    const phase = status.phase;
    const texts: Record<string, string> = {
      idle: 'Ready and waiting...',
      preparing: 'Preparing wallets...',
      launching: 'Launching token...',
      buying: 'Executing bundled buys...',
      simulating: 'Volume simulation running...',
      exiting: '⚠️ EXITING - Selling all wallets!',
      complete: '✅ Complete!',
      error: '❌ Error occurred',
    };
    return texts[phase] || 'Unknown status';
  }

  /**
   * Get exit status
   */
  private getExitStatus(status: any): string {
    if (status.phase === 'exiting') {
      return '🔥 EXECUTING EXIT';
    }
    if (status.phase === 'complete') {
      return '✅ COMPLETE';
    }
    
    const multiplier = status.currentMultiplier || 1;
    const target = status.profitTarget || 3;
    
    if (multiplier >= target) {
      return '🎯 TARGET REACHED - Ready to exit';
    }
    return `📈 Building... ${multiplier.toFixed(2)}x / ${target}x`;
  }

  /**
   * Format profit
   */
  private formatProfit(status: any): string {
    const multiplier = status.currentMultiplier || 1;
    const profit = (multiplier - 1) * 100;
    const color = profit >= 100 ? 'green' : profit >= 0 ? 'yellow' : 'red';
    return `{${color}-fg}${profit.toFixed(1)}%{/${color}-fg}`;
  }

  /**
   * Resize UI
   */
  private resizeUI(): void {
    // Recreate UI with new dimensions
    this.createUI();
    this.refreshUI();
  }

  // ============================================================
  // REFRESH LOOP
  // ============================================================

  /**
   * Start refresh loop
   */
  private startRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Initial refresh
    setTimeout(() => this.refreshUI(), 100);

    // Periodic refresh
    this.refreshTimer = setInterval(() => {
      if (this.isRunning) {
        this.refreshUI();
      }
    }, this.config.refreshInterval);
  }

  // ============================================================
  // LOGGING
  // ============================================================

  /**
   * Add log message
   */
  addLog(message: string, level: string = 'info'): void {
    const timestamp = new Date().toLocaleTimeString();
    const colors: Record<string, string> = {
      info: this.config.colors.primary,
      success: this.config.colors.success,
      warning: this.config.colors.warning,
      error: this.config.colors.error,
      debug: this.config.colors.dim,
    };
    
    const color = colors[level] || this.config.colors.dim;
    const formatted = `{${color}-fg}[${timestamp}] ${message}{/${color}-fg}`;
    
    this.logMessages.push(formatted);
    if (this.logMessages.length > 100) {
      this.logMessages = this.logMessages.slice(-100);
    }

    if (this.elements.logBox) {
      this.elements.logBox.add(formatted);
    }
  }
}

// ============================================================
// SIMPLE TERMINAL DASHBOARD (Alternative)
// ============================================================

/**
 * Simple terminal dashboard without blessed
 * Useful for systems without full TTY support
 */
export class SimpleDashboard {
  private bundler: Bundler | null = null;
  private isRunning: boolean = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private config: DashboardConfig;

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = { ...DEFAULT_DASHBOARD_CONFIG, ...config };
  }

  /**
   * Start the dashboard
   */
  start(bundler: Bundler): void {
    this.bundler = bundler;
    this.isRunning = true;

    console.clear();
    console.log('═'.repeat(80));
    console.log('  AERTH BUNDLER - Terminal Dashboard');
    console.log('═'.repeat(80));
    console.log('');

    this.refreshUI();
    this.startRefreshLoop();

    // Handle exit
    process.on('SIGINT', () => {
      this.stop();
      process.exit(0);
    });
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    this.isRunning = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Refresh UI
   */
  private refreshUI(): void {
    if (!this.bundler) return;

    try {
      const status = this.bundler.getStatus();
      
      // Clear screen and move cursor home
      process.stdout.write('\x1b[2J\x1b[H');
      
      // Header
      console.log('═'.repeat(80));
      console.log(`  AERTH BUNDLER v1.0  |  ${status.phase.toUpperCase()}  |  ${new Date().toLocaleTimeString()}`);
      console.log('═'.repeat(80));
      console.log('');

      // Token Info
      console.log('  📊 TOKEN INFORMATION');
      console.log(`    Name:        ${status.tokenName} (${status.tokenSymbol})`);
      console.log(`    Mint:        ${status.tokenMint ? shortAddress(status.tokenMint) : 'N/A'}`);
      console.log(`    Price:       ${formatPrice(status.currentPrice)}`);
      console.log(`    Multiplier:  ${status.currentMultiplier?.toFixed(2) || '1.00'}x`);
      console.log('');

      // Wallet Info
      console.log('  👛 WALLET INFORMATION');
      console.log(`    Total Wallets:   ${status.totalWallets || 0}`);
      console.log(`    Funded Wallets:  ${status.fundedWallets || 0}`);
      console.log(`    Total Volume:    ${formatSol(status.totalVolume || 0)}`);
      console.log(`    Current Profit:  ${this.formatProfit(status)}`);
      console.log('');

      // Exit Info
      console.log('  🎯 EXIT INFORMATION');
      const progress = status.currentMultiplier && status.profitTarget
        ? Math.min((status.currentMultiplier / status.profitTarget) * 100, 100)
        : 0;
      const bar = '█'.repeat(Math.round(progress / 2)) + '░'.repeat(50 - Math.round(progress / 2));
      console.log(`    Target:        ${status.profitTarget || 3.0}x`);
      console.log(`    Progress:      ${progress.toFixed(1)}% [${bar}]`);
      console.log(`    Time Left:     ${formatTimeRemaining(status.timeRemaining || 0)}`);
      console.log(`    Status:        ${this.getExitStatus(status)}`);
      console.log('');

      // Recent Activity (from log)
      console.log('  📝 RECENT ACTIVITY');
      // This would show recent logs
      console.log('    Monitoring...');

      console.log('');
      console.log('═'.repeat(80));
      console.log('  [Ctrl+C] to exit  |  [R] to refresh');
      console.log('═'.repeat(80));

    } catch (error) {
      console.log('Error refreshing dashboard:', error);
    }
  }

  /**
   * Start refresh loop
   */
  private startRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(() => {
      if (this.isRunning) {
        this.refreshUI();
      }
    }, this.config.refreshInterval);
  }

  /**
   * Format profit
   */
  private formatProfit(status: any): string {
    const multiplier = status.currentMultiplier || 1;
    const profit = (multiplier - 1) * 100;
    return profit.toFixed(1) + '%';
  }

  /**
   * Get exit status
   */
  private getExitStatus(status: any): string {
    if (status.phase === 'exiting') {
      return '🔥 EXECUTING EXIT';
    }
    if (status.phase === 'complete') {
      return '✅ COMPLETE';
    }
    
    const multiplier = status.currentMultiplier || 1;
    const target = status.profitTarget || 3;
    
    if (multiplier >= target) {
      return '🎯 TARGET REACHED - Ready to exit';
    }
    return `📈 Building... ${multiplier.toFixed(2)}x / ${target}x`;
  }
}

// ============================================================
// EXPORT
// ============================================================

export default Dashboard;
export { SimpleDashboard };