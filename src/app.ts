/**
 * AERTH BUNDLER - Main Application Entry Point
 * Clean version with web dashboard only (no blessed)
 */

import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

import { logger, log } from './utils/logger';
import { WalletManager } from './core/walletManager';
import Bundler from './core/bundler';
import { DashboardServer } from './dashboard/server';
import { sleep } from './utils/helpers';

dotenv.config();

// ============================================================
// CONFIG
// ============================================================

interface AppConfig {
  rpcEndpoint: string;
  wsEndpoint: string;
  isDevnet: boolean;
  walletPassword: string;
  walletFolder: string;
  tokenName: string;
  tokenSymbol: string;
  tokenSupply: number;
  initialLiquidity: number;
  numberOfWallets: number;
  minBuyAmount: number;
  maxBuyAmount: number;
  targetMultiplier: number;
  exitTimerHours: number;
  maxSlippage: number;
  targetDailyVolume: number;
  volumePattern: string;
  dashboardEnabled: boolean;
  dashboardPort: number;
}

// ============================================================
// DEFAULT CONFIG
// ============================================================

const DEFAULT_CONFIG: AppConfig = {
  rpcEndpoint: 'https://api.devnet.solana.com',
  wsEndpoint: 'wss://api.devnet.solana.com',
  isDevnet: true,
  walletPassword: 'default_password_change_me',
  walletFolder: './wallets',
  tokenName: 'LARPAI',
  tokenSymbol: 'LARP',
  tokenSupply: 1000000000,
  initialLiquidity: 1.0,
  numberOfWallets: 10,
  minBuyAmount: 0.05,
  maxBuyAmount: 0.5,
  targetMultiplier: 3.0,
  exitTimerHours: 5,
  maxSlippage: 50,
  targetDailyVolume: 50,
  volumePattern: 'Organic Growth',
  dashboardEnabled: true,
  dashboardPort: 3001,
};

// ============================================================
// MAIN APP CLASS
// ============================================================

export class App {
  private config: AppConfig;
  private connection: Connection;
  private walletManager: WalletManager;
  private bundler: Bundler | null = null;
  private dashboard: DashboardServer | null = null;
  private isRunning: boolean = false;
  private shutdownRequested: boolean = false;

  constructor(config: Partial<AppConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create connection
    this.connection = new Connection(this.config.rpcEndpoint, {
      commitment: 'confirmed',
      wsEndpoint: this.config.wsEndpoint,
    });

    // Initialize wallet manager
    this.walletManager = new WalletManager(
      this.connection,
      this.config.walletPassword,
      this.config.walletFolder
    );

    log.info('App initialized', {
      network: this.config.isDevnet ? 'devnet' : 'mainnet',
      rpc: this.config.rpcEndpoint,
      token: `${this.config.tokenName} (${this.config.tokenSymbol})`,
      wallets: this.config.numberOfWallets,
      targetMultiplier: `${this.config.targetMultiplier}x`,
    });
  }

  // ============================================================
  // RUN
  // ============================================================

  async run(): Promise<void> {
    try {
      this.isRunning = true;

      log.section('🚀 AERTH BUNDLER v1.0');
      log.info('Starting application...');

      // Step 1: Init wallet manager
      await this.initWalletManager();

      // Step 2: Prepare wallets
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
  // INIT WALLET MANAGER
  // ============================================================

  private async initWalletManager(): Promise<void> {
    log.info('Initializing wallet manager...');
    await this.walletManager.initialize();

    try {
      await this.walletManager.loadWallets();
      log.info(`Loaded ${this.walletManager.getWallets().length} wallets`);
    } catch (e) {
      log.warn('No wallets found. Run generate-wallets first.');
      log.info('  npm run generate-wallets');
      return;
    }

    const mainWallet = this.walletManager.getMainWallet();
    if (mainWallet) {
      const balance = await this.walletManager.getBalance(mainWallet);
      log.info(`Main wallet balance: ${balance.toFixed(4)} SOL`);
    }
  }

  // ============================================================
  // PREPARE WALLETS
  // ============================================================

  private async prepareWallets(): Promise<void> {
    log.info('Preparing wallets...');

    const wallets = this.walletManager.getWallets();
    if (wallets.length === 0) {
      log.warn('No wallets found. Run: npm run generate-wallets');
      return;
    }

    log.info(`Loaded ${wallets.length} existing wallets`);

    const balances = await this.walletManager.getAllBalances();
    const funded = balances.filter(w => w.isFunded);
    const totalBalance = balances.reduce((sum, w) => sum + w.solBalance, 0);

    log.info('Wallet funding status', {
      total: balances.length,
      funded: funded.length,
      totalBalance: `${totalBalance.toFixed(4)} SOL`,
    });
  }

  // ============================================================
  // CREATE BUNDLER
  // ============================================================

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

    bundler.onComplete((result) => {
      log.section('🎉 BUNDLER COMPLETE');
      console.log(`  Status:      ${result.status.phase}`);
      console.log(`  Multiplier:  ${result.status.currentMultiplier?.toFixed(2) || '1.00'}x`);
      console.log(`  Volume:      ${result.status.totalVolume?.toFixed(2) || '0.00'} SOL`);
    });

    bundler.onError((error) => {
      log.error('Bundler error', error);
    });

    log.success('Bundler created');
    return bundler;
  }

  // ============================================================
  // SETUP DASHBOARD
  // ============================================================

  private async setupDashboard(): Promise<void> {
    if (!this.bundler) {
      throw new Error('Bundler must be created before dashboard');
    }

    log.info('Starting dashboard...');

    try {
      this.dashboard = new DashboardServer({
        port: this.config.dashboardPort,
        enabled: this.config.dashboardEnabled,
      });

      this.dashboard.start(this.bundler);
      log.success(`📊 Dashboard: http://localhost:${this.config.dashboardPort}`);

    } catch (error) {
      log.warn('Dashboard failed to start', error);
      this.dashboard = null;
    }

    await sleep(500);
  }

  // ============================================================
  // START BUNDLER
  // ============================================================

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
    console.log(`  Network:         ${this.config.isDevnet ? 'Devnet' : 'Mainnet'}`);
    log.divider('═');

    log.info('Starting bundler execution...');
    log.info(`📊 Dashboard: http://localhost:${this.config.dashboardPort}`);

    // Start in background
    this.bundler.execute().catch((error) => {
      log.error('Bundler execution failed', error);
    });
  }

  // ============================================================
  // WAIT FOR COMPLETION
  // ============================================================

  private async waitForCompletion(): Promise<void> {
    log.info('Bundler running. Press Ctrl+C to stop gracefully');

    while (this.isRunning && !this.shutdownRequested) {
      await sleep(1000);
    }
  }

  // ============================================================
  // SHUTDOWN
  // ============================================================

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    log.info('Shutting down...');

    if (this.dashboard) {
      this.dashboard.stop();
      this.dashboard = null;
    }

    if (this.bundler) {
      await this.bundler.stop();
      this.bundler = null;
    }

    this.isRunning = false;
    log.success('Shutdown complete');
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  const isDevnet = process.env.NETWORK !== 'mainnet';

  const config: AppConfig = {
    rpcEndpoint: process.env.RPC_ENDPOINT || 
      (isDevnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'),
    wsEndpoint: process.env.WS_ENDPOINT || 
      (isDevnet ? 'wss://api.devnet.solana.com' : 'wss://api.mainnet-beta.solana.com'),
    isDevnet: isDevnet,
    walletPassword: process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password_change_me',
    walletFolder: process.env.WALLET_FOLDER || './wallets',
    tokenName: process.env.TOKEN_NAME || 'LARPAI',
    tokenSymbol: process.env.TOKEN_SYMBOL || 'LARP',
    tokenSupply: parseInt(process.env.TOKEN_SUPPLY || '1000000000'),
    initialLiquidity: parseFloat(process.env.INITIAL_LIQUIDITY || '1.0'),
    numberOfWallets: parseInt(process.env.NUMBER_OF_WALLETS || '10'),
    minBuyAmount: parseFloat(process.env.MIN_BUY_AMOUNT || '0.05'),
    maxBuyAmount: parseFloat(process.env.MAX_BUY_AMOUNT || '0.5'),
    targetMultiplier: parseFloat(process.env.TARGET_MULTIPLIER || '3.0'),
    exitTimerHours: parseFloat(process.env.EXIT_TIMER_HOURS || '5'),
    maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '50'),
    targetDailyVolume: parseFloat(process.env.TARGET_DAILY_VOLUME || '50'),
    volumePattern: process.env.VOLUME_PATTERN || 'Organic Growth',
    dashboardEnabled: process.env.DASHBOARD_ENABLED !== 'false',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3001'),
  };

  // Parse command line args
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg === '--devnet') {
      config.isDevnet = true;
      config.rpcEndpoint = 'https://api.devnet.solana.com';
    } else if (arg === '--mainnet') {
      config.isDevnet = false;
      config.rpcEndpoint = 'https://api.mainnet-beta.solana.com';
    } else if (arg === '--no-dashboard') {
      config.dashboardEnabled = false;
    }
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

  // Run
  try {
    await app.run();
  } catch (error) {
    log.error('Application failed', error);
    await app.shutdown();
    process.exit(1);
  }
}

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default App;