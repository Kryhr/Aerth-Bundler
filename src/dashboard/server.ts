/**
 * AERTH BUNDLER - Dashboard Server
 * Real-time terminal dashboard for monitoring the bundler
 */

import blessed from 'blessed';

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
  refreshInterval: number;
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

  start(bundler: Bundler): void {
    if (this.isRunning) {
      logger.warn('Dashboard already running');
      return;
    }

    this.bundler = bundler;
    this.isRunning = true;

    this.createScreen();
    this.createUI();
    this.startRefreshLoop();
    this.screen?.render();

    logger.success('Dashboard started');
  }

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

    this.screen.on('resize', () => {
      this.resizeUI();
    });

    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop();
      process.exit(0);
    });

    this.screen.key(['r'], () => {
      this.refreshUI();
    });
  }

  // ============================================================
  // UI CREATION
  // ============================================================

  private createUI(): void {
    if (!this.screen) return;

    const screen = this.screen;
    const width = screen.width;
    const height = screen.height;

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

    screen.render();
  }

  // ============================================================
  // UI UPDATE
  // ============================================================

  private refreshUI(): void {
    if (!this.bundler || !this.screen) return;

    try {
      const status = this.bundler.getStatus();
      this.statusData = status;

      this.updateHeader(status);
      this.updateStatus(status);
      this.updateTokenInfo(status);
      this.updateWalletInfo(status);
      this.updatePriceChart(status);
      this.updateVolumeChart(status);
      this.updateExitInfo(status);
      this.updateLog();

      this.screen.render();

    } catch (error) {
      logger.error('Failed to refresh UI', error);
    }
  }

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

  private updateStatus(status: any): void {
    if (!this.elements.status) return;

    const statusColor = this.getStatusColor(status.phase);
    const statusText = this.getStatusText(status);

    this.elements.status.setContent(
      ` {${statusColor}-fg}●{/${statusColor}-fg} ${statusText}`
    );
  }

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

  private updatePriceChart(status: any): void {
    if (!this.elements.priceChart) return;

    if (status.currentPrice > 0) {
      this.priceHistory.push({
        timestamp: Date.now(),
        value: status.currentPrice,
      });
      
      if (this.priceHistory.length > this.config.maxHistoryItems) {
        this.priceHistory = this.priceHistory.slice(-this.config.maxHistoryItems);
      }
    }

    const chart = this.renderChart(this.priceHistory, 40, 6);
    this.elements.priceChart.setContent(chart);
  }

  private updateVolumeChart(status: any): void {
    if (!this.elements.volumeChart) return;

    if (status.totalVolume > 0) {
      this.volumeHistory.push({
        timestamp: Date.now(),
        value: status.totalVolume,
      });
      
      if (this.volumeHistory.length > this.config.maxHistoryItems) {
        this.volumeHistory = this.volumeHistory.slice(-this.config.maxHistoryItems);
      }
    }

    const chart = this.renderChart(this.volumeHistory, 40, 6);
    this.elements.volumeChart.setContent(chart);
  }

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

  private updateLog(): void {
    if (!this.elements.logBox) return;
  }

  // ============================================================
  // CHART RENDERING
  // ============================================================

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

  private renderProgressBar(progress: number, width: number): string {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  // ============================================================
  // HELPERS
  // ============================================================

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

  private formatProfit(status: any): string {
    const multiplier = status.currentMultiplier || 1;
    const profit = (multiplier - 1) * 100;
    const color = profit >= 100 ? 'green' : profit >= 0 ? 'yellow' : 'red';
    return `{${color}-fg}${profit.toFixed(1)}%{/${color}-fg}`;
  }

  private resizeUI(): void {
    this.createUI();
    this.refreshUI();
  }

  // ============================================================
  // REFRESH LOOP
  // ============================================================

  private startRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    setTimeout(() => this.refreshUI(), 100);

    this.refreshTimer = setInterval(() => {
      if (this.isRunning) {
        this.refreshUI();
      }
    }, this.config.refreshInterval);
  }

  // ============================================================
  // LOGGING
  // ============================================================

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

export class SimpleDashboard {
  private bundler: Bundler | null = null;
  private isRunning: boolean = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private config: DashboardConfig;

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = { ...DEFAULT_DASHBOARD_CONFIG, ...config };
  }

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

    process.on('SIGINT', () => {
      this.stop();
      process.exit(0);
    });
  }

  stop(): void {
    this.isRunning = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private refreshUI(): void {
    if (!this.bundler) return;

    try {
      const status = this.bundler.getStatus();
      
      process.stdout.write('\x1b[2J\x1b[H');
      
      console.log('═'.repeat(80));
      console.log(`  AERTH BUNDLER v1.0  |  ${status.phase.toUpperCase()}  |  ${new Date().toLocaleTimeString()}`);
      console.log('═'.repeat(80));
      console.log('');

      console.log('  📊 TOKEN INFORMATION');
      console.log(`    Name:        ${status.tokenName} (${status.tokenSymbol})`);
      console.log(`    Mint:        ${status.tokenMint ? shortAddress(status.tokenMint) : 'N/A'}`);
      console.log(`    Price:       ${formatPrice(status.currentPrice)}`);
      console.log(`    Multiplier:  ${status.currentMultiplier?.toFixed(2) || '1.00'}x`);
      console.log('');

      console.log('  👛 WALLET INFORMATION');
      console.log(`    Total Wallets:   ${status.totalWallets || 0}`);
      console.log(`    Funded Wallets:  ${status.fundedWallets || 0}`);
      console.log(`    Total Volume:    ${formatSol(status.totalVolume || 0)}`);
      console.log(`    Current Profit:  ${this.formatProfit(status)}`);
      console.log('');

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

      console.log('  📝 RECENT ACTIVITY');
      console.log('    Monitoring...');

      console.log('');
      console.log('═'.repeat(80));
      console.log('  [Ctrl+C] to exit  |  [R] to refresh');
      console.log('═'.repeat(80));

    } catch (error) {
      console.log('Error refreshing dashboard:', error);
    }
  }

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

  private formatProfit(status: any): string {
    const multiplier = status.currentMultiplier || 1;
    const profit = (multiplier - 1) * 100;
    return profit.toFixed(1) + '%';
  }

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

export default Dashboard;