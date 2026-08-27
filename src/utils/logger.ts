/**
 * AERTH BUNDLER - Logger Utility
 * Colored, structured logging for terminal and file
 */

import chalk from 'chalk';
import winston from 'winston';
import { format } from 'winston';

// ============================================================
// COLOR THEMES
// ============================================================

const COLORS = {
  info: chalk.cyan,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  debug: chalk.magenta,
  highlight: chalk.bold.green,
  dim: chalk.dim,
  bold: chalk.bold,
  // Special status colors
  status: {
    ready: chalk.bgGreen.black,
    running: chalk.bgBlue.black,
    warning: chalk.bgYellow.black,
    error: chalk.bgRed.black,
    holding: chalk.bgCyan.black,
    selling: chalk.bgMagenta.black,
  }
};

// ============================================================
// EMOJI ICONS
// ============================================================

const ICONS = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  debug: '🐞',
  wallet: '👛',
  token: '🪙',
  chart: '📊',
  rocket: '🚀',
  fire: '🔥',
  rug: '🧹',
  timer: '⏱️',
  ready: '🟢',
  running: '🔵',
  holding: '🟡',
  selling: '🔴',
  lightning: '⚡',
  diamond: '💎',
  hands: '🙌',
  moon: '🌙',
  launch: '🚀',
  trade: '🔄',
  pool: '🏊',
  wallet_generated: '📝',
  config: '⚙️',
  dashboard: '📺',
  start: '▶️',
  stop: '⏹️',
  waiting: '⏳',
  complete: '🎉'
};

// ============================================================
// LOG LEVELS
// ============================================================

const LOG_LEVELS = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    success: 3,
    debug: 4,
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'cyan',
    success: 'green',
    debug: 'magenta',
  }
};

// ============================================================
// MAIN LOGGER CLASS
// ============================================================

export class Logger {
  private static instance: Logger;
  private winstonLogger: winston.Logger;
  private logLevel: string;
  private isDebugMode: boolean;

  private constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.isDebugMode = this.logLevel === 'debug';
    
    // Configure Winston
    this.winstonLogger = winston.createLogger({
      levels: LOG_LEVELS.levels,
      level: this.logLevel,
      format: format.combine(
        format.timestamp({
          format: 'YYYY-MM-DD HH:mm:ss'
        }),
        format.errors({ stack: true }),
        format.splat(),
        format.json()
      ),
      transports: [
        // Console transport with colors
        new winston.transports.Console({
          format: format.combine(
            format.colorize({
              all: true,
              colors: LOG_LEVELS.colors
            }),
            format.printf(({ timestamp, level, message, ...meta }) => {
              const metaStr = Object.keys(meta).length ? 
                ` ${chalk.dim(JSON.stringify(meta))}` : '';
              return `${chalk.dim(timestamp)} [${level}] ${message}${metaStr}`;
            })
          )
        }),
        // File transport for debugging
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          format: format.combine(
            format.timestamp(),
            format.json()
          )
        }),
        new winston.transports.File({
          filename: 'logs/combined.log',
          format: format.combine(
            format.timestamp(),
            format.json()
          )
        })
      ]
    });
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  // ============================================================
  // PUBLIC LOGGING METHODS
  // ============================================================

  /**
   * Standard info log
   */
  info(message: string, meta?: any): void {
    this.winstonLogger.info(this.formatMessage(message, ICONS.info), meta);
    if (this.isDebugMode) {
      console.log(chalk.dim(`  └─ ${JSON.stringify(meta || {})}`));
    }
  }

  /**
   * Success log
   */
  success(message: string, meta?: any): void {
    this.winstonLogger.info(this.formatMessage(message, ICONS.success, 'success'), meta);
  }

  /**
   * Warning log
   */
  warn(message: string, meta?: any): void {
    this.winstonLogger.warn(this.formatMessage(message, ICONS.warning), meta);
  }

  /**
   * Error log
   */
  error(message: string, meta?: any): void {
    this.winstonLogger.error(this.formatMessage(message, ICONS.error), meta);
    // Print stack trace in debug mode
    if (this.isDebugMode && meta?.stack) {
      console.error(chalk.red(meta.stack));
    }
  }

  /**
   * Debug log (only shows in debug mode)
   */
  debug(message: string, meta?: any): void {
    if (this.isDebugMode) {
      this.winstonLogger.debug(this.formatMessage(message, ICONS.debug), meta);
    }
  }

  /**
   * Custom colored log with any icon
   */
  custom(message: string, icon: string = ICONS.info, color: string = 'cyan'): void {
    const coloredMessage = chalk[color as keyof typeof chalk]?.(message) || message;
    console.log(`${icon} ${coloredMessage}`);
  }

  // ============================================================
  // SPECIALIZED LOGGING METHODS
  // ============================================================

  /**
   * Wallet related log
   */
  wallet(message: string, meta?: any): void {
    this.custom(`${ICONS.wallet} ${message}`, '', 'cyan');
    if (meta && this.isDebugMode) {
      console.log(chalk.dim(`  └─ ${JSON.stringify(meta)}`));
    }
  }

  /**
   * Token related log
   */
  token(message: string, meta?: any): void {
    this.custom(`${ICONS.token} ${message}`, '', 'green');
    if (meta && this.isDebugMode) {
      console.log(chalk.dim(`  └─ ${JSON.stringify(meta)}`));
    }
  }

  /**
   * Trade related log
   */
  trade(message: string, meta?: any): void {
    this.custom(`${ICONS.trade} ${message}`, '', 'magenta');
    if (meta && this.isDebugMode) {
      console.log(chalk.dim(`  └─ ${JSON.stringify(meta)}`));
    }
  }

  /**
   * Chart/volume related log
   */
  chart(message: string, meta?: any): void {
    this.custom(`${ICONS.chart} ${message}`, '', 'blue');
    if (meta && this.isDebugMode) {
      console.log(chalk.dim(`  └─ ${JSON.stringify(meta)}`));
    }
  }

  /**
   * Status update log
   */
  status(message: string, status: 'ready' | 'running' | 'warning' | 'error' | 'holding' | 'selling'): void {
    const colorFn = COLORS.status[status];
    const icon = status === 'ready' ? ICONS.ready :
                status === 'running' ? ICONS.running :
                status === 'warning' ? ICONS.warning :
                status === 'error' ? ICONS.error :
                status === 'holding' ? ICONS.holding :
                ICONS.selling;
    console.log(`${icon} ${colorFn(` ${status.toUpperCase()} `)} ${message}`);
  }

  /**
   * Progress bar log
   */
  progress(current: number, total: number, label: string = 'Progress'): void {
    const percentage = Math.round((current / total) * 100);
    const barLength = 30;
    const filled = Math.round((percentage / 100) * barLength);
    const empty = barLength - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    
    console.log(
      `${chalk.cyan(label)}: ${chalk.bold.white(`[${bar}]`)} ${chalk.yellow(`${percentage}%`)} ${chalk.dim(`(${current}/${total})`)}`
    );
  }

  /**
   * Divider line for visual separation
   */
  divider(char: string = '═', length: number = 80, color: string = 'dim'): void {
    const line = char.repeat(length);
    const colorFn = chalk[color as keyof typeof chalk] || chalk.dim;
    console.log(colorFn(line));
  }

  /**
   * Section header
   */
  section(title: string): void {
    this.divider('═', 80);
    console.log(chalk.bold.cyan(`  ${title}`));
    this.divider('═', 80);
  }

  /**
   * Table-like row
   */
  tableRow(columns: Array<{ text: string; width: number; align?: 'left' | 'right' | 'center' }>): void {
    let row = '';
    columns.forEach(col => {
      let text = col.text;
      const width = col.width;
      const align = col.align || 'left';
      
      if (text.length > width) {
        text = text.slice(0, width - 3) + '...';
      }
      
      const padding = width - text.length;
      if (align === 'right') {
        row += ' '.repeat(padding) + text;
      } else if (align === 'center') {
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        row += ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
      } else {
        row += text + ' '.repeat(padding);
      }
      row += ' │ ';
    });
    console.log(`│ ${row.slice(0, -3)} │`);
  }

  /**
   * Clean exit message
   */
  goodbye(): void {
    this.divider('═', 80);
    console.log(chalk.bold.green('\n  🎉 AERTH BUNDLER COMPLETE\n'));
    console.log(chalk.dim('  All wallets have been sold. Funds transferred to main wallet.'));
    console.log(chalk.dim(`  Run ${chalk.white('npm run dashboard')} to view final report.\n`));
    this.divider('═', 80);
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private formatMessage(message: string, icon: string, level: string = 'info'): string {
    return `${icon} ${message}`;
  }

  /**
   * Format SOL amounts with proper decimals
   */
  public formatSol(amount: number): string {
    if (amount >= 1) {
      return `${amount.toFixed(2)} SOL`;
    } else if (amount >= 0.001) {
      return `${(amount * 1000).toFixed(2)} mSOL`;
    } else {
      return `${(amount * 1_000_000).toFixed(0)} µSOL`;
    }
  }

  /**
   * Format token amounts with proper decimals
   */
  public formatToken(amount: number, decimals: number = 9): string {
    const formatted = amount / Math.pow(10, decimals);
    if (formatted >= 1000) {
      return `${formatted.toFixed(2)} tokens`;
    } else if (formatted >= 1) {
      return `${formatted.toFixed(2)} tokens`;
    } else {
      return `${formatted.toFixed(4)} tokens`;
    }
  }

  /**
   * Format price with $ sign
   */
  public formatPrice(price: number): string {
    if (price < 0.000001) {
      return `$${price.toFixed(9)}`;
    } else if (price < 0.001) {
      return `$${price.toFixed(6)}`;
    } else if (price < 1) {
      return `$${price.toFixed(4)}`;
    } else {
      return `$${price.toFixed(2)}`;
    }
  }
}

// ============================================================
// EXPORT SINGLETON INSTANCE
// ============================================================

export const logger = Logger.getInstance();

// ============================================================
// QUICK ACCESS FUNCTIONS (for convenience)
// ============================================================

export const log = {
  info: (msg: string, meta?: any) => logger.info(msg, meta),
  success: (msg: string, meta?: any) => logger.success(msg, meta),
  warn: (msg: string, meta?: any) => logger.warn(msg, meta),
  error: (msg: string, meta?: any) => logger.error(msg, meta),
  debug: (msg: string, meta?: any) => logger.debug(msg, meta),
  wallet: (msg: string, meta?: any) => logger.wallet(msg, meta),
  token: (msg: string, meta?: any) => logger.token(msg, meta),
  trade: (msg: string, meta?: any) => logger.trade(msg, meta),
  chart: (msg: string, meta?: any) => logger.chart(msg, meta),
  status: (msg: string, status: any) => logger.status(msg, status),
  progress: (current: number, total: number, label?: string) => logger.progress(current, total, label),
  divider: (char?: string, length?: number) => logger.divider(char, length),
  section: (title: string) => logger.section(title),
  tableRow: (columns: any[]) => logger.tableRow(columns),
  formatSol: (amount: number) => logger.formatSol(amount),
  formatToken: (amount: number, decimals?: number) => logger.formatToken(amount, decimals),
  formatPrice: (price: number) => logger.formatPrice(price),
};

// ============================================================
// EXPORT ICONS FOR REUSE
// ============================================================

export { ICONS };

// ============================================================
// DEFAULT EXPORT
// ============================================================

export default logger;