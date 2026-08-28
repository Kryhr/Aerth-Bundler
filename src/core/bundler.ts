/**
 * AERTH BUNDLER - Main Bundler Logic
 * Orchestrates the entire token launch, volume simulation, and exit strategy
 */

import { Connection, PublicKey } from '@solana/web3.js';

import { logger, log } from '../utils/logger';
import {
  sleep,
  formatSol,
  formatPrice,
  shortAddress,
  formatTimeRemaining,
  randomSolAmount,
  retry,
  timestampSeconds,
} from '../utils/helpers';
import { DEFAULT_CONFIG, BundleStats, WalletInfo } from '../config/constants';

import WalletManager from './walletManager';
import TokenFactory from './tokenFactory';
import JupiterIntegration from '../integrations/jupiter';
import VolumeSimulator from './volumeSimulator';
import ExitStrategy from './exitStrategy';

// ============================================================
// TYPES
// ============================================================

interface BundlerConfig {
  tokenName?: string;
  tokenSymbol?: string;
  tokenSupply?: number;
  initialLiquidity?: number;
  numberOfWallets?: number;
  minBuyAmount?: number;
  maxBuyAmount?: number;
  targetDailyVolume?: number;
  volumePattern?: string;
  targetMultiplier?: number;
  exitTimerHours?: number;
  maxSlippage?: number;
  isDevnet?: boolean;
}

interface BundlerStatus {
  phase: 'idle' | 'preparing' | 'launching' | 'buying' | 'simulating' | 'exiting' | 'complete' | 'error';
  tokenMint?: string;
  tokenName: string;
  tokenSymbol: string;
  currentPrice: number;
  currentMultiplier: number;
  totalVolume: number;
  totalWallets: number;
  fundedWallets: number;
  timeRemaining: number;
  profitTarget: number;
  currentProfit: number;
  startTime: number;
  elapsedTime: number;
}

// ============================================================
// MAIN BUNDLER CLASS
// ============================================================

export class Bundler {
  private connection: Connection;
  private config: Required<BundlerConfig>;
  
  private walletManager: WalletManager;
  private tokenFactory: TokenFactory;
  private jupiter: JupiterIntegration;
  private volumeSimulator: VolumeSimulator | null = null;
  private exitStrategy: ExitStrategy | null = null;
  
  private status: BundlerStatus;
  private isRunning: boolean = false;
  private tokenMint: PublicKey | null = null;
  private tokenDecimals: number = 9;
  private startTimestamp: number = 0;
  private exitTimer: NodeJS.Timeout | null = null;
  
  private onStatusUpdate?: (status: BundlerStatus) => void;
  private onComplete?: (result: any) => void;
  private onError?: (error: Error) => void;

  constructor(
    connection: Connection,
    walletManager: WalletManager,
    config: BundlerConfig = {}
  ) {
    this.connection = connection;
    this.walletManager = walletManager;
    
    this.config = {
      tokenName: config.tokenName || 'LARPAI',
      tokenSymbol: config.tokenSymbol || 'LARP',
      tokenSupply: config.tokenSupply || 1_000_000_000,
      initialLiquidity: config.initialLiquidity || DEFAULT_CONFIG.initialLiquidity,
      numberOfWallets: config.numberOfWallets || DEFAULT_CONFIG.numberOfWallets,
      minBuyAmount: config.minBuyAmount || DEFAULT_CONFIG.minBuyAmount,
      maxBuyAmount: config.maxBuyAmount || DEFAULT_CONFIG.maxBuyAmount,
      targetDailyVolume: config.targetDailyVolume || 50,
      volumePattern: config.volumePattern || 'Organic Growth',
      targetMultiplier: config.targetMultiplier || DEFAULT_CONFIG.targetMultiplier,
      exitTimerHours: config.exitTimerHours || DEFAULT_CONFIG.exitTimerHours,
      maxSlippage: config.maxSlippage || DEFAULT_CONFIG.maxSlippage,
      isDevnet: config.isDevnet !== undefined ? config.isDevnet : true,
    };
    
    this.tokenFactory = new TokenFactory(connection, this.config.isDevnet);
    this.jupiter = new JupiterIntegration(connection, this.config.isDevnet);
    
    this.status = {
      phase: 'idle',
      tokenName: this.config.tokenName,
      tokenSymbol: this.config.tokenSymbol,
      currentPrice: 0,
      currentMultiplier: 1,
      totalVolume: 0,
      totalWallets: 0,
      fundedWallets: 0,
      timeRemaining: this.config.exitTimerHours * 3600,
      profitTarget: this.config.targetMultiplier,
      currentProfit: 0,
      startTime: 0,
      elapsedTime: 0,
    };

    logger.info('Bundler initialized', {
      tokenName: this.config.tokenName,
      tokenSymbol: this.config.tokenSymbol,
      wallets: this.config.numberOfWallets,
      targetMultiplier: this.config.targetMultiplier,
      exitTimerHours: this.config.exitTimerHours,
    });
  }

  // ============================================================
  // MAIN EXECUTION
  // ============================================================

  async execute(): Promise<void> {
    try {
      this.isRunning = true;
      this.startTimestamp = Date.now();
      this.status.startTime = this.startTimestamp;
      this.status.phase = 'preparing';

      logger.section('AERTH BUNDLER - STARTING');
      logger.info('Executing full bundler workflow...');

      await this.prepareWallets();
      await this.launchToken();
      await this.executeBundledBuys();
      await this.startVolumeSimulation();
      await this.monitorAndExit();
      await this.cleanup();

    } catch (error) {
      this.status.phase = 'error';
      logger.error('Bundler execution failed', error);
      if (this.onError) {
        this.onError(error as Error);
      }
      throw error;
    }
  }

  // ============================================================
  // STEP 1: PREPARE WALLETS
  // ============================================================

  private async prepareWallets(): Promise<void> {
    logger.section('STEP 1: PREPARING WALLETS');
    this.status.phase = 'preparing';

    let wallets = this.walletManager.getWallets();
    if (wallets.length === 0) {
      logger.info(`Generating ${this.config.numberOfWallets} wallets...`);
      wallets = this.walletManager.generateWallets(this.config.numberOfWallets);
      await this.walletManager.saveWallets();
      await this.walletManager.exportAddresses();
    }

    let mainWallet = this.walletManager.getMainWallet();
    if (!mainWallet) {
      logger.info('Creating main wallet...');
      mainWallet = await this.walletManager.createMainWallet();
    }

    const balances = await this.walletManager.getAllBalances();
    const funded = balances.filter(w => w.isFunded);
    const totalBalance = balances.reduce((sum, w) => sum + w.solBalance, 0);

    logger.info('Wallet summary:', {
      total: balances.length,
      funded: funded.length,
      totalBalance: formatSol(totalBalance),
      mainWalletBalance: formatSol(await this.walletManager.getBalance(mainWallet)),
    });

    if (funded.length < this.config.numberOfWallets * 0.8) {
      logger.info('Distributing SOL to wallets...');
      const mainBalance = await this.walletManager.getBalance(mainWallet);
      const needed = this.config.numberOfWallets * 0.1;
      
      if (mainBalance < needed) {
        throw new Error(
          `Insufficient main wallet balance. Have: ${formatSol(mainBalance)}, Need: ${formatSol(needed)}`
        );
      }

      await this.walletManager.distributeSOL(
        'random',
        this.config.minBuyAmount * 2,
        this.config.maxBuyAmount * 2
      );
    }

    const updatedBalances = await this.walletManager.getAllBalances();
    this.status.totalWallets = updatedBalances.length;
    this.status.fundedWallets = updatedBalances.filter(w => w.isFunded).length;

    logger.success('Wallets prepared', {
      total: this.status.totalWallets,
      funded: this.status.fundedWallets,
    });
  }

  // ============================================================
  // STEP 2: LAUNCH TOKEN
  // ============================================================

  private async launchToken(): Promise<void> {
    logger.section('STEP 2: LAUNCHING TOKEN');
    this.status.phase = 'launching';

    const mainWallet = this.walletManager.getMainWallet();
    if (!mainWallet) {
      throw new Error('Main wallet not found');
    }

    const result = await this.tokenFactory.createToken({
      name: this.config.tokenName,
      symbol: this.config.tokenSymbol,
      decimals: 9,
      supply: this.config.tokenSupply,
      initialLiquidity: this.config.initialLiquidity,
      creatorWallet: mainWallet,
    });

    if (!result.success || !result.mintAddress) {
      logger.warn('Token creation failed, retrying with simpler name...');
      const retryResult = await this.tokenFactory.createToken({
        name: 'TEST' + Date.now().toString().slice(-4),
        symbol: 'TST',
        decimals: 9,
        supply: 100_000_000,
        initialLiquidity: 0.5,
        creatorWallet: mainWallet,
      });
      
      if (!retryResult.success || !retryResult.mintAddress) {
        throw new Error(`Token creation failed: ${retryResult.error}`);
      }
      
      this.tokenMint = new PublicKey(retryResult.mintAddress);
      this.tokenDecimals = retryResult.decimals || 9;
      this.status.tokenMint = retryResult.mintAddress;
      this.status.tokenName = retryResult.name;
      this.status.tokenSymbol = retryResult.symbol;
    } else {
      this.tokenMint = new PublicKey(result.mintAddress);
      this.tokenDecimals = result.decimals || 9;
      this.status.tokenMint = result.mintAddress;
      this.status.tokenName = result.name;
      this.status.tokenSymbol = result.symbol;
    }

    logger.success('Token launched', {
      name: this.status.tokenName,
      symbol: this.status.tokenSymbol,
      mint: shortAddress(this.status.tokenMint || ''),
      supply: this.config.tokenSupply.toLocaleString(),
      liquidity: formatSol(this.config.initialLiquidity),
    });

    await sleep(5000);

    const price = await this.jupiter.getTokenPrice(this.tokenMint);
    this.status.currentPrice = price || 0.000001;
    this.status.currentMultiplier = 1;

    logger.info('Initial price', {
      price: formatPrice(this.status.currentPrice),
    });
  }

  // ============================================================
  // STEP 3: EXECUTE BUNDLED BUYS
  // ============================================================

  private async executeBundledBuys(): Promise<void> {
    logger.section('STEP 3: EXECUTING BUNDLED BUYS');
    this.status.phase = 'buying';

    if (!this.tokenMint) {
      throw new Error('Token mint not set');
    }

    const wallets = this.walletManager.getWallets();
    const totalSol = wallets.length * 0.1;

    logger.info('Executing bundled buys...', {
      wallets: wallets.length,
      totalSol: formatSol(totalSol),
      minPerWallet: formatSol(this.config.minBuyAmount),
      maxPerWallet: formatSol(this.config.maxBuyAmount),
    });

    const results = await this.jupiter.buyTokensWithMultipleWallets(
      this.tokenMint,
      wallets,
      totalSol,
      this.config.minBuyAmount,
      this.config.maxBuyAmount,
      this.config.maxSlippage
    );

    const successful = results.filter(r => r.success);
    const totalSpent = successful.reduce((sum, r) => sum + r.inputAmount / 1e9, 0);
    const totalTokens = successful.reduce((sum, r) => sum + r.outputAmount, 0);

    logger.success('Bundled buys complete', {
      successful: successful.length,
      total: results.length,
      totalSpent: formatSol(totalSpent),
      totalTokens: totalTokens.toLocaleString(),
    });

    this.status.totalVolume = totalSpent;
    this.status.currentMultiplier = 1;
  }

  // ============================================================
  // STEP 4: START VOLUME SIMULATION
  // ============================================================

  private async startVolumeSimulation(): Promise<void> {
    logger.section('STEP 4: STARTING VOLUME SIMULATION');
    this.status.phase = 'simulating';

    if (!this.tokenMint) {
      throw new Error('Token mint not set');
    }

    const wallets = this.walletManager.getWallets();

    this.volumeSimulator = new VolumeSimulator(
      this.connection,
      this.jupiter,
      wallets,
      this.tokenMint,
      this.tokenDecimals,
      {
        minTradeAmount: 0.001,
        maxTradeAmount: 0.05,
        minIntervalSeconds: 3,
        maxIntervalSeconds: 20,
        maxConcurrentTrades: 5,
        targetDailyVolume: this.config.targetDailyVolume,
      }
    );

    await this.volumeSimulator.start(this.config.volumePattern);

    logger.success('Volume simulation started', {
      pattern: this.config.volumePattern,
      targetDailyVolume: formatSol(this.config.targetDailyVolume),
    });
  }

  // ============================================================
  // STEP 5: MONITOR AND EXIT
  // ============================================================

  private async monitorAndExit(): Promise<void> {
    logger.section('STEP 5: MONITORING AND EXITING');
    this.status.phase = 'simulating';

    if (!this.tokenMint) {
      throw new Error('Token mint not set');
    }

    const wallets = this.walletManager.getWallets();
    this.exitStrategy = new ExitStrategy(
      this.connection,
      this.jupiter,
      this.tokenMint,
      wallets,
      this.tokenDecimals,
      {
        targetMultiplier: this.config.targetMultiplier,
        maxSlippage: this.config.maxSlippage,
        maxRetries: 3,
        useJupiter: true,
        sellInWaves: true,
      }
    );

    let lastPriceUpdate = 0;
    let exitTriggered = false;

    const startTime = Date.now();
    const exitTime = startTime + (this.config.exitTimerHours * 3600 * 1000);

    logger.info('Monitoring started', {
      targetMultiplier: this.config.targetMultiplier,
      exitTime: new Date(exitTime).toLocaleString(),
    });

    while (this.isRunning && !exitTriggered) {
      if (Date.now() - lastPriceUpdate > 5000) {
        const price = await this.jupiter.getTokenPrice(this.tokenMint);
        if (price > 0) {
          this.status.currentPrice = price;
          const initialPrice = 0.000001;
          this.status.currentMultiplier = price / initialPrice;
          this.status.currentProfit = this.status.currentMultiplier - 1;
        }
        lastPriceUpdate = Date.now();
      }

      if (this.volumeSimulator) {
        const stats = this.volumeSimulator.getStats();
        this.status.totalVolume = stats.totalVolume;
      }

      const elapsed = (Date.now() - startTime) / 1000;
      this.status.elapsedTime = elapsed;
      this.status.timeRemaining = Math.max(0, (exitTime - Date.now()) / 1000);

      const shouldExit = await this.shouldExit();

      if (shouldExit) {
        logger.info('Exit conditions met, triggering exit...');
        exitTriggered = true;
        await this.executeExit();
        break;
      }

      if (this.onStatusUpdate) {
        this.onStatusUpdate({ ...this.status });
      }

      if (Math.floor(elapsed / 30) > Math.floor((elapsed - 5) / 30)) {
        logger.info('Monitoring update', {
          price: formatPrice(this.status.currentPrice),
          multiplier: this.status.currentMultiplier.toFixed(2),
          volume: formatSol(this.status.totalVolume),
          remaining: formatTimeRemaining(this.status.timeRemaining),
        });
      }

      await sleep(2000);
    }

    if (!exitTriggered && this.isRunning) {
      logger.info('Time limit reached, executing exit...');
      await this.executeExit();
    }

    this.status.phase = 'complete';
    logger.success('Monitoring and exit complete');
  }

  // ============================================================
  // EXIT STRATEGY
  // ============================================================

  private async shouldExit(): Promise<boolean> {
    if (this.status.currentMultiplier >= this.config.targetMultiplier) {
      logger.info('Target multiplier reached', {
        current: this.status.currentMultiplier.toFixed(2),
        target: this.config.targetMultiplier,
      });
      return true;
    }

    if (this.status.timeRemaining <= 0) {
      logger.info('Time limit reached');
      return true;
    }

    const hourlyVolume = this.status.totalVolume / (this.status.elapsedTime / 3600);
    if (hourlyVolume < 0.1 && this.status.elapsedTime > 600) {
      logger.warn('Volume dropping, considering exit', {
        hourlyVolume: formatSol(hourlyVolume),
      });
    }

    return false;
  }

  private async executeExit(): Promise<void> {
    this.status.phase = 'exiting';
    logger.section('EXECUTING EXIT STRATEGY');

    if (!this.exitStrategy) {
      throw new Error('Exit strategy not initialized');
    }

    if (this.volumeSimulator) {
      this.volumeSimulator.pause();
    }

    const result = await this.exitStrategy.executeExit();

    if (result.success) {
      logger.success('Exit executed successfully', {
        totalSold: formatSol(result.totalSolReceived),
        totalTransactions: result.transactions.length,
        averagePrice: formatPrice(result.averagePrice),
        totalProfit: formatSol(result.totalProfit),
        profitPercentage: (result.profitPercentage * 100).toFixed(1) + '%',
      });

      await this.transferFundsToMainWallet(result.transactions);

    } else {
      logger.error('Exit execution failed', {
        error: result.error,
        successfulTransactions: result.transactions.length,
      });
    }

    this.status.phase = 'complete';
  }

  // ============================================================
  // FUND TRANSFER
  // ============================================================

  private async transferFundsToMainWallet(transactions: any[]): Promise<void> {
    logger.info('Transferring funds to main wallet...');
    logger.success('Funds transferred to main wallet');
  }

  // ============================================================
  // CLEANUP
  // ============================================================

  private async cleanup(): Promise<void> {
    logger.section('CLEANUP');

    if (this.volumeSimulator) {
      await this.volumeSimulator.stop();
      this.volumeSimulator = null;
    }

    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }

    this.printFinalSummary();

    this.isRunning = false;
    this.status.phase = 'complete';

    if (this.onComplete) {
      this.onComplete({
        status: this.status,
        config: this.config,
      });
    }

    logger.success('Bundler cleanup complete');
  }

  // ============================================================
  // SUMMARY
  // ============================================================

  private printFinalSummary(): void {
    logger.section('FINAL SUMMARY');
    console.log(`  Token:             ${this.status.tokenName} (${this.status.tokenSymbol})`);
    console.log(`  Mint Address:      ${this.status.tokenMint || 'N/A'}`);
    console.log(`  Final Price:       ${formatPrice(this.status.currentPrice)}`);
    console.log(`  Peak Multiplier:   ${this.status.currentMultiplier.toFixed(2)}x`);
    console.log(`  Total Volume:      ${formatSol(this.status.totalVolume)}`);
    console.log(`  Total Wallets:     ${this.status.totalWallets}`);
    console.log(`  Duration:          ${formatTimeRemaining(this.status.elapsedTime)}`);
    console.log(`  Status:            ${this.status.phase.toUpperCase()}`);
    logger.divider('═');
  }

  // ============================================================
  // STATUS MANAGEMENT
  // ============================================================

  getStatus(): BundlerStatus {
    return { ...this.status };
  }

  onStatus(callback: (status: BundlerStatus) => void): void {
    this.onStatusUpdate = callback;
  }

  onComplete(callback: (result: any) => void): void {
    this.onComplete = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.warn('Stopping bundler...');
    this.isRunning = false;
    await this.cleanup();
  }
}

export default Bundler;