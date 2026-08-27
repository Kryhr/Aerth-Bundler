/**
 * AERTH BUNDLER - Main Application Entry Point
 * Initializes all components and starts the bundler
 */

import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

import { logger, log } from './utils/logger';
import {
  sleep,
  formatSol,
  formatPrice,
  shortAddress,
  ensureDirectory,
  fileExists,
} from './utils/helpers';
import { DEFAULT_CONFIG, NETWORKS } from './config/constants';

import WalletManager from './core/walletManager';
import TokenFactory from './core/tokenFactory';
import JupiterIntegration from './integrations/jupiter';
import Bundler from './core/bundler';
import Dashboard, { SimpleDashboard } from './dashboard/server';

// ============================================================
// TYPES
// ============================================================

interface AppConfig {
  // Network
  rpcEndpoint: string;
  wsEndpoint: string;
  isDevnet: boolean;
  
  // Wallet
  walletPassword: string;
  walletFolder: string;
  mainWalletPrivateKey?: string;
  
  // Token
  tokenName: string;
  tokenSymbol: string;
  tokenSupply: number;
  initialLiquidity: number;
  
  // Bundler
  numberOfWallets: number;
  minBuyAmount: number;
  maxBuyAmount: number;
  targetMultiplier: number;
  exitTimerHours: number;
  maxSlippage: number;
  targetDailyVolume: number;
  volumePattern: string;
  
  // Dashboard
  dashboardEnabled: boolean;
  dashboardType: 'full' | 'simple';
  refreshInterval: number;
}

// ============================================================
// DEFAULT APP CONFIG
// ============================================================

const DEFAULT_APP_CONFIG: AppConfig = {
  rpcEndpoint: 'https://api.devnet.solana.com',
  wsEndpoint: 'wss://api.devnet.solana.com',
  isDevnet: true,
  walletPassword: 'change_me_secure_password',
  walletFolder: './wallets',
  mainWalletPrivateKey: undefined,
  tokenName: 'LARPAI',
  tokenSymbol: 'LARP',
  tokenSupply: 1_000_000_000,
  initialLiquidity: 1.0,
  numberOfWallets: 10,
  minBuyAmount: 0.05,
  maxBuyAmount: 0.5,
  targetMultiplier: 5.0,
  exitTimerHours: 5,
  maxSlippage: 50,
  targetDailyVolume: 50,
  volumePattern: 'Organic Growth',
  dashboardEnabled: true,
  dashboardType: 'full',
  refreshInterval: 1000,
};

// ============================================================
// MAIN APPLICATION CLASS
// ============================================================

export class App {
  private config: AppConfig;
  private connection: Connection;
  private walletManager: WalletManager;
  private bundler: Bundler | null = null;
  private dashboard: Dashboard | SimpleDashboard | null = null;
  private isRunning: boolean = false;
  private shutdownRequested: boolean = false;

  constructor(config: Partial<AppConfig> = {}) {
    this.config = { ...DEFAULT_APP_CONFIG, ...config };
    
    // Create connection
    this.connection = new Connection(
      this.config.rpcEndpoint,
      {
        commitment: 'confirmed',
        wsEndpoint: this.config.wsEndpoint,
      }
    );
    
    // Initialize wallet manager
    this.walletManager = new WalletManager(
      this.connection,
      this.config.walletPassword,
      this.config.walletFolder
    );
    
    logger.info('App initialized', {
      network: this.config.isDevnet ? 'devnet' : 'mainnet',
      rpc: this.config.rpcEndpoint,
      token: `${this.config.tokenName} (${this.config.tokenSymbol})`,
      wallets: this.config.numberOfWallets,
      targetMultiplier: this.config.targetMultiplier + 'x',
    });
  }

  // ============================================================
  // MAIN RUN
  // ============================================================

  /**
   * Run the application
   */
  async run(): Promise<void> {
    try {
      this.isRunning = true;
      
      log.section('🚀 AERTH BUNDLER v1.0');
      log.info('Starting application...');
      
      // Step 1: Initialize wallet manager
      await this.initWalletManager();
      
      // Step 2: Create or load wallets
      await this.prepareWallets();
      
      // Step 3: Create bundler
      this.bundler = this.createBundler();
      
      // Step 4: Setup dashboard
      if (this.config.dashboardEnabled) {
        await this.setupDashboard();
      }
      
      // Step 5: Start bundler
      await this.startBundler();
      
      // Step 6: Wait for completion
      await this.waitForCompletion();
      
    } catch (error) {
      log.error('Application error', error);
      await this.shutdown();
      throw error;
    }
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  /**
   * Initialize wallet manager
   */
  private async initWalletManager(): Promise<void> {
    log.info('Initializing wallet manager...');
    
    await this.walletManager.initialize();
    
    // Check if wallet file exists
    const walletFile = path.join(this.config.walletFolder, 'wallets.json');
    if (await fileExists(walletFile)) {
      log.info('Loading existing wallets...');
      await this.walletManager.loadWallets();
    }
    
    // Create main wallet if needed
    let mainWallet = this.walletManager.getMainWallet();
    if (!mainWallet) {
      log.info('Creating main wallet...');
      mainWallet = await this.walletManager.createMainWallet(
        this.config.mainWalletPrivateKey
      );
      log.wallet('Main wallet created', {
        address: shortAddress(mainWallet.publicKey),
      });
    } else {
      log.wallet('Main wallet loaded', {
        address: shortAddress(mainWallet.publicKey),
      });
    }
    
    // Check main wallet balance
    const balance = await this.walletManager.getBalance(mainWallet);
    log.info(`Main wallet balance: ${formatSol(balance)}`);
    
    if (balance < 0.5) {
      log.warn('Main wallet has low balance. Please fund it first.', {
        current: formatSol(balance),
        recommended: '0.5 SOL minimum',
      });
      
      if (this.config.isDevnet) {
        log.info('On devnet - you can get SOL from a faucet');
        log.info(`Address: ${mainWallet.publicKey}`);
      }
    }
  }

  /**
   * Prepare wallets
   */
  private async prepareWallets(): Promise<void> {
    log.info('Preparing wallets...');
    
    let wallets = this.walletManager.getWallets();
    
    if (wallets.length === 0) {
      log.info(`Generating ${this.config.numberOfWallets} wallets...`);
      wallets = this.walletManager.generateWallets(this.config.numberOfWallets);
      await this.walletManager.saveWallets();
      await this.walletManager.exportAddresses();
      log.success(`Generated ${wallets.length} wallets`);
    } else {
      log.info(`Loaded ${wallets.length} existing wallets`);
    }
    
    // Check funding status
    const balances = await this.walletManager.getAllBalances();
    const funded = balances.filter(w => w.isFunded);
    
    log.info('Wallet funding status', {
      total: balances.length,
      funded: funded.length,
      totalBalance: formatSol(balances.reduce((sum, w) => sum + w.solBalance, 0)),
    });
    
    // Warn if not enough funded wallets
    if (funded.length < wallets.length * 0.5) {
      log.warn('Many wallets are not funded. Run distribute command first.');
      log.info('To fund wallets, use: npm run fund');
    }
  }

  // ============================================================
  // BUNDLER CREATION
  // ============================================================

  /**
   * Create bundler instance
   */
  private createBundler(): Bundler {
    log.info('Creating bundler...');
    
    const bundler = new Bundler(
      this.connection,
      this.walletManager,
      {
        tokenName: this.config.tokenName,
        tokenSymbol: this.config.tokenSymbol,
        tokenSupply: this.config.tokenSupply,
        initialLiquidity: this.config.initialLiquidity,
        numberOfWallets: this.config.numberOfWallets,
        minBuyAmount: this.config.minBuyAmount,
        maxBuyAmount: this.config.maxBuyAmount,
        targetMultiplier: this.config.targetMultiplier,
        exitTimerHours: this.config.exitTimerHours,
        maxSlippage: this.config.maxSlippage,
        targetDailyVolume: this.config.targetDailyVolume,
        volumePattern: this.config.volumePattern,
        isDevnet: this.config.isDevnet,
      }
    );
    
    // Set up callbacks
    bundler.onStatus((status) => {
      this.onStatusUpdate(status);
    });
    
    bundler.onComplete((result) => {
      this.onComplete(result);
    });
    
    bundler.onError((error) => {
      this.onError(error);
    });
    
    log.success('Bundler created');
    return bundler;
  }

  // ============================================================
  // DASHBOARD
  // ============================================================

  /**
   * Setup dashboard
   */
  private async setupDashboard(): Promise<void> {
    if (!this.bundler) {
      throw new Error('Bundler must be created before dashboard');
    }
    
    log.info('Starting dashboard...');
    
    if (this.config.dashboardType === 'full') {
      this.dashboard = new Dashboard({
        refreshInterval: this.config.refreshInterval,
        showPriceChart: true,
        showVolumeChart: true,
      });
    } else {
      this.dashboard = new SimpleDashboard({
        refreshInterval: this.config.refreshInterval,
      });
    }
    
    this.dashboard.start(this.bundler);
    log.success('Dashboard started');
    
    // Small delay for dashboard to render
    await sleep(500);
  }

  // ============================================================
  // BUNDLER EXECUTION
  // ============================================================

  /**
   * Start bundler
   */
  private async startBundler(): Promise<void> {
    if (!this.bundler) {
      throw new Error('Bundler not created');
    }
    
    log.section('🚀 STARTING BUNDLER');
    log.info('Configuration:');
    console.log(`  Token:           ${this.config.tokenName} (${this.config.tokenSymbol})`);
    console.log(`  Wallets:         ${this.config.numberOfWallets}`);
    console.log(`  Target:          ${this.config.targetMultiplier}x`);
    console.log(`  Max Duration:    ${this.config.exitTimerHours}h`);
    console.log(`  Volume Pattern:  ${this.config.volumePattern}`);
    console.log(`  Network:         ${this.config.isDevnet ? 'Devnet' : 'Mainnet'}`);
    log.divider('═');
    
    // Ask for confirmation if on mainnet
    if (!this.config.isDevnet) {
      const confirmed = await this.confirmMainnet();
      if (!confirmed) {
        log.warn('Operation cancelled by user');
        await this.shutdown();
        process.exit(0);
      }
    }
    
    log.info('Starting bundler execution...');
    
    // Start in background
    this.bundler.execute().catch((error) => {
      log.error('Bundler execution failed', error);
    });
  }

  /**
   * Wait for completion
   */
  private async waitForCompletion(): Promise<void> {
    log.info('Bundler running. Waiting for completion...');
    log.info('Press Ctrl+C to stop gracefully');
    
    // Wait indefinitely - bundler will handle completion
    while (this.isRunning && !this.shutdownRequested) {
      await sleep(1000);
    }
  }

  // ============================================================
  // CALLBACKS
  // ============================================================

  /**
   * Status update callback
   */
  private onStatusUpdate(status: any): void {
    // Dashboard handles this
  }

  /**
   * Completion callback
   */
  private onComplete(result: any): void {
    log.section('🎉 BUNDLER COMPLETE');
    log.success('All operations completed successfully');
    
    if (result.status) {
      console.log(`  Final Price:     ${formatPrice(result.status.currentPrice)}`);
      console.log(`  Multiplier:      ${result.status.currentMultiplier?.toFixed(2) || '1.00'}x`);
      console.log(`  Total Volume:    ${formatSol(result.status.totalVolume || 0)}`);
      console.log(`  Duration:        ${formatTimeRemaining(result.status.elapsedTime || 0)}`);
    }
    
    log.divider('═');
    
    // Keep dashboard alive
    if (this.dashboard) {
      log.info('Dashboard will remain open. Press Q to quit.');
    }
  }

  /**
   * Error callback
   */
  private onError(error: Error): void {
    log.error('Bundler error', error);
  }

  // ============================================================
  // SHUTDOWN
  // ============================================================

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    
    log.info('Shutting down...');
    
    // Stop dashboard
    if (this.dashboard) {
      this.dashboard.stop();
      this.dashboard = null;
    }
    
    // Stop bundler
    if (this.bundler) {
      await this.bundler.stop();
      this.bundler = null;
    }
    
    this.isRunning = false;
    log.success('Shutdown complete');
  }

  // ============================================================
  // UTILITY
  // ============================================================

  /**
   * Confirm mainnet operation
   */
  private async confirmMainnet(): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    return new Promise((resolve) => {
      rl.question(
        '\n⚠️  WARNING: You are running on MAINNET!\n' +
        'This will use real funds. Are you sure? (yes/no): ',
        (answer) => {
          rl.close();
          resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
        }
      );
    });
  }
}

// ============================================================
// COMMAND LINE INTERFACE
// ============================================================

/**
 * Parse command line arguments
 */
function parseArgs(): Partial<AppConfig> {
  const args = process.argv.slice(2);
  const config: Partial<AppConfig> = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--devnet':
        config.isDevnet = true;
        config.rpcEndpoint = 'https://api.devnet.solana.com';
        config.wsEndpoint = 'wss://api.devnet.solana.com';
        break;
        
      case '--mainnet':
        config.isDevnet = false;
        config.rpcEndpoint = 'https://api.mainnet-beta.solana.com';
        config.wsEndpoint = 'wss://api.mainnet-beta.solana.com';
        break;
        
      case '--rpc':
        config.rpcEndpoint = args[++i];
        break;
        
      case '--wallets':
        config.numberOfWallets = parseInt(args[++i]);
        break;
        
      case '--target':
        config.targetMultiplier = parseFloat(args[++i]);
        break;
        
      case '--name':
        config.tokenName = args[++i];
        break;
        
      case '--symbol':
        config.tokenSymbol = args[++i];
        break;
        
      case '--pattern':
        config.volumePattern = args[++i];
        break;
        
      case '--no-dashboard':
        config.dashboardEnabled = false;
        break;
        
      case '--help':
        printHelp();
        process.exit(0);
        break;
    }
  }
  
  return config;
}

/**
 * Print help
 */
function printHelp(): void {
  console.log(`
AERTH BUNDLER v1.0 - Command Line Interface

Usage:
  npm start [options]

Options:
  --devnet              Use devnet (default)
  --mainnet             Use mainnet (requires real funds)
  --rpc <url>           Custom RPC endpoint
  --wallets <number>    Number of wallets to use
  --target <number>     Target multiplier (e.g. 5.0 for 5x)
  --name <name>         Token name
  --symbol <symbol>     Token symbol
  --pattern <name>      Volume pattern: Organic Growth | Pump & Consolidate | Whale Accumulation | Volume Spikes | Market Making
  --no-dashboard        Disable dashboard UI
  --help                Show this help

Examples:
  npm start -- --devnet --wallets 10 --target 5.0
  npm start -- --mainnet --wallets 25 --target 3.0 --name LARPAI --symbol LARP
  `);
}

// ============================================================
// ENTRY POINT
// ============================================================

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Load .env file
  dotenv.config();
  
  // Parse command line args
  const cliConfig = parseArgs();
  
  // Build configuration
  const config: Partial<AppConfig> = {
    rpcEndpoint: process.env.RPC_ENDPOINT || cliConfig.rpcEndpoint,
    wsEndpoint: process.env.WS_ENDPOINT || cliConfig.wsEndpoint,
    isDevnet: process.env.NETWORK !== 'mainnet' && cliConfig.isDevnet !== false,
    walletPassword: process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password_change_me',
    walletFolder: process.env.WALLET_FOLDER || './wallets',
    mainWalletPrivateKey: process.env.MAIN_WALLET_PRIVATE_KEY,
    tokenName: process.env.TOKEN_NAME || cliConfig.tokenName,
    tokenSymbol: process.env.TOKEN_SYMBOL || cliConfig.tokenSymbol,
    tokenSupply: parseInt(process.env.TOKEN_SUPPLY || '1000000000'),
    initialLiquidity: parseFloat(process.env.INITIAL_LIQUIDITY || '1.0'),
    numberOfWallets: parseInt(process.env.NUMBER_OF_WALLETS || String(cliConfig.numberOfWallets || 10)),
    minBuyAmount: parseFloat(process.env.MIN_BUY_AMOUNT || '0.05'),
    maxBuyAmount: parseFloat(process.env.MAX_BUY_AMOUNT || '0.5'),
    targetMultiplier: parseFloat(process.env.TARGET_MULTIPLIER || String(cliConfig.targetMultiplier || 5.0)),
    exitTimerHours: parseFloat(process.env.EXIT_TIMER_HOURS || '5'),
    maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '50'),
    targetDailyVolume: parseFloat(process.env.TARGET_DAILY_VOLUME || '50'),
    volumePattern: process.env.VOLUME_PATTERN || cliConfig.volumePattern || 'Organic Growth',
    dashboardEnabled: process.env.DASHBOARD_ENABLED !== 'false' && cliConfig.dashboardEnabled !== false,
    dashboardType: process.env.DASHBOARD_TYPE === 'simple' ? 'simple' : 'full',
    refreshInterval: parseInt(process.env.REFRESH_INTERVAL || '1000'),
  };
  
  // Validate config
  if (config.numberOfWallets && config.numberOfWallets < 2) {
    console.error('Error: At least 2 wallets required');
    process.exit(1);
  }
  
  if (config.targetMultiplier && config.targetMultiplier < 2) {
    console.error('Error: Target multiplier must be at least 2x');
    process.exit(1);
  }
  
  // Create and run app
  const app = new App(config);
  
  // Handle signals
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Shutting down gracefully...');
    await app.shutdown();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM. Shutting down gracefully...');
    await app.shutdown();
    process.exit(0);
  });
  
  process.on('uncaughtException', async (error) => {
    log.error('Uncaught exception', error);
    await app.shutdown();
    process.exit(1);
  });
  
  process.on('unhandledRejection', async (error) => {
    log.error('Unhandled rejection', error);
    await app.shutdown();
    process.exit(1);
  });
  
  // Run app
  try {
    await app.run();
  } catch (error) {
    log.error('Application failed', error);
    await app.shutdown();
    process.exit(1);
  }
}

// ============================================================
// RUN
// ============================================================

// Only run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// ============================================================
// EXPORT
// ============================================================

export default App;