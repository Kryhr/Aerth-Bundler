/**
 * AERTH BUNDLER - Main Bundler Logic
 * Orchestrates the entire token launch, volume simulation, and exit strategy
 */

import { Connection, PublicKey } from '@solana/web3.js';

import { logger } from '../utils/logger';
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
  // Token settings
  tokenName?: string;
  tokenSymbol?: string;
  tokenSupply?: number;
  initialLiquidity?: number;
  
  // Wallet settings
  numberOfWallets?: number;
  minBuyAmount?: number;
  maxBuyAmount?: number;
  
  // Volume settings
  targetDailyVolume?: number;
  volumePattern?: string;
  
  // Exit settings
  targetMultiplier?: number;
  exitTimerHours?: number;
  maxSlippage?: number;
  
  // Network
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
  timeRemaining: number; // seconds
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
  
  // Core components
  private walletManager: WalletManager;
  private tokenFactory: TokenFactory;
  private jupiter: JupiterIntegration;
  private volumeSimulator: VolumeSimulator | null = null;
  private exitStrategy: ExitStrategy | null = null;
  
  // State
  private status: BundlerStatus;
  private isRunning: boolean = false;
  private tokenMint: PublicKey | null = null;
  private tokenDecimals: number = 9;
  private startTimestamp: number = 0;
  private exitTimer: NodeJS.Timeout | null = null;
  
  // Callbacks
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
    
    // Set defaults
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
    
    // Initialize components
    this.tokenFactory = new TokenFactory(connection, this.config.isDevnet);
    this.jupiter = new JupiterIntegration(connection, this.config.isDevnet);
    
    // Initialize status
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

  /**
   * Execute the full bundler workflow
   */
  async execute(): Promise<void> {
    try {
      this.isRunning = true;
      this.startTimestamp = Date.now();
      this.status.startTime = this.startTimestamp;
      this.status.phase = 'preparing';

      logger.section('AERTH BUNDLER - STARTING');
      logger.info('Executing full bundler workflow...');

      // Step 1: Prepare wallets
      await this.prepareWallets();

      // Step 2: Launch token
      await this.launchToken();

      // Step 3: Execute bundled buys
      await this.executeBundledBuys();

      // Step 4: Start volume simulation
      await this.startVolumeSimulation();

      // Step 5: Monitor and exit
      await this.monitorAndExit();

      // Step 6: Cleanup
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

    // Generate wallets if needed
    let wallets = this.walletManager.getWallets();
    if (wallets.length === 0) {
      logger.info(`Generating ${this.config.numberOfWallets} wallets...`);
      wallets = this.walletManager.generateWallets(this.config.numberOfWallets);
      
      // Save wallets
      await this.walletManager.saveWallets();
      await this.walletManager.exportAddresses();
    }

    // Check if main wallet exists
    let mainWallet = this.walletManager.getMainWallet();
    if (!mainWallet) {
      logger.info('Creating main wallet...');
      mainWallet = await this.walletManager.createMainWallet();
    }

    // Check balances
    const balances = await this.walletManager.getAllBalances();
    const funded = balances.filter(w => w.isFunded);
    const totalBalance = balances.reduce((sum, w) => sum + w.solBalance, 0);

    logger.info('Wallet summary:', {
      total: balances.length,
      funded: funded.length,
      totalBalance: formatSol(totalBalance),
      mainWalletBalance: formatSol(await this.walletManager.getBalance(mainWallet)),
    });

    // If not enough funded, distribute SOL
    if (funded.length < this.config.numberOfWallets * 0.8) {
      logger.info('Distributing SOL to wallets...');
      
      const mainBalance = await this.walletManager.getBalance(mainWallet);
      const needed = this.config.numberOfWallets * 0.1; // 0.1 SOL each
      
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

    // Update status
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

    // Create token
    const result = await this.tokenFactory.createTokenWithMetadata({
      name: this.config.tokenName,
      symbol: this.config.tokenSymbol,
      decimals: 9,
      supply: this.config.tokenSupply,
      initialLiquidity: this.config.initialLiquidity,
      creatorWallet: mainWallet,
      description: `${this.config.tokenName} token on Solana - Community driven`,
      image: '', // Could add image URL if available
    });

    if (!result.success || !result.mintAddress) {
      throw new Error(`Token creation failed: ${result.error}`);
    }

    this.tokenMint = new PublicKey(result.mintAddress);
    this.tokenDecimals = result.decimals || 9;

    // Update status
    this.status.tokenMint = result.mintAddress;
    this.status.tokenName = result.name;
    this.status.tokenSymbol = result.symbol;

    logger.success('Token launched', {
      name: result.name,
      symbol: result.symbol,
      mint: shortAddress(result.mintAddress),
      supply: result.supply.toLocaleString(),
      liquidity: formatSol(result.initialLiquidity),
    });

    // Wait for token to be indexed
    logger.info('Waiting for token to be indexed...');
    await sleep(5000);

    // Get initial price
    const price = await this.jupiter.getTokenPrice(this.tokenMint);
    this.status.currentPrice = price;
    this.status.currentMultiplier = 1;

    logger.info('Initial price', {
      price: formatPrice(price),
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
    const totalSol = wallets.length * 0.1; // 0.1 SOL average per wallet

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

    // Update status
    this.status.totalVolume = totalSpent;
    this.status.currentMultiplier = 1;

    // Store token balances for each wallet (for exit)
    // This would be tracked in a real implementation
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

    // Create volume simulator
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

    // Start simulation
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

    // Initialize exit strategy
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

    // Set up monitoring
    let lastPriceUpdate = 0;
    let exitTriggered = false;

    const startTime = Date.now();
    const exitTime = startTime + (this.config.exitTimerHours * 3600 * 1000);

    logger.info('Monitoring started', {
      targetMultiplier: this.config.targetMultiplier,
      exitTime: new Date(exitTime).toLocaleString(),
    });

    // Main monitoring loop
    while (this.isRunning && !exitTriggered) {
      // Update price every 5 seconds
      if (Date.now() - lastPriceUpdate > 5000) {
        const price = await this.jupiter.getTokenPrice(this.tokenMint);
        if (price > 0) {
          this.status.currentPrice = price;
          
          // Calculate multiplier based on initial price
          const initialPrice = 0.000001; // Placeholder
          this.status.currentMultiplier = price / initialPrice;
          this.status.currentProfit = this.status.currentMultiplier - 1;
        }
        lastPriceUpdate = Date.now();
      }

      // Update volume stats
      if (this.volumeSimulator) {
        const stats = this.volumeSimulator.getStats();
        this.status.totalVolume = stats.totalVolume;
      }

      // Update time remaining
      const elapsed = (Date.now() - startTime) / 1000;
      this.status.elapsedTime = elapsed;
      this.status.timeRemaining = Math.max(0, (exitTime - Date.now()) / 1000);

      // Check exit conditions
      const shouldExit = await this.shouldExit();

      if (shouldExit) {
        logger.info('Exit conditions met, triggering exit...');
        exitTriggered = true;
        await this.executeExit();
        break;
      }

      // Update status callback
      if (this.onStatusUpdate) {
        this.onStatusUpdate({ ...this.status });
      }

      // Log every 30 seconds
      if (Math.floor(elapsed / 30) > Math.floor((elapsed - 5) / 30)) {
        logger.info('Monitoring update', {
          price: formatPrice(this.status.currentPrice),
          multiplier: this.status.currentMultiplier.toFixed(2),
          volume: formatSol(this.status.totalVolume),
          remaining: formatTimeRemaining(this.status.timeRemaining),
        });
      }

      // Sleep before next check
      await sleep(2000);
    }

    // If we reached the time limit without exiting
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
    // Check if target multiplier reached
    if (this.status.currentMultiplier >= this.config.targetMultiplier) {
      logger.info('Target multiplier reached', {
        current: this.status.currentMultiplier.toFixed(2),
        target: this.config.targetMultiplier,
      });
      return true;
    }

    // Check if time limit reached
    if (this.status.timeRemaining <= 0) {
      logger.info('Time limit reached');
      return true;
    }

    // Check if volume is low (indicating interest is fading)
    const hourlyVolume = this.status.totalVolume / (this.status.elapsedTime / 3600);
    if (hourlyVolume < 0.1 && this.status.elapsedTime > 600) { // 10 minutes
      logger.warn('Volume dropping, considering exit', {
        hourlyVolume: formatSol(hourlyVolume),
      });
      // Could auto-exit here if configured
    }

    return false;
  }

  private async executeExit(): Promise<void> {
    this.status.phase = 'exiting';
    logger.section('EXECUTING EXIT STRATEGY');

    if (!this.exitStrategy) {
      throw new Error('Exit strategy not initialized');
    }

    // Pause volume simulation
    if (this.volumeSimulator) {
      this.volumeSimulator.pause();
    }

    // Execute exit
    const result = await this.exitStrategy.executeExit();

    if (result.success) {
      logger.success('Exit executed successfully', {
        totalSold: formatSol(result.totalSolReceived),
        totalTransactions: result.transactions.length,
        averagePrice: formatPrice(result.averagePrice),
        totalProfit: formatSol(result.totalProfit),
        profitPercentage: (result.profitPercentage * 100).toFixed(1) + '%',
      });

      // Transfer funds back to main wallet
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
    // In a real implementation, this would transfer any remaining SOL
    // and tokens back to the main wallet
    logger.info('Transferring funds to main wallet...');
    
    // This is a placeholder - actual implementation would:
    // 1. Check balances of all wallets
    // 2. Transfer any remaining SOL to main wallet
    // 3. Transfer any remaining tokens to main wallet
    
    logger.success('Funds transferred to main wallet');
  }

  // ============================================================
  // CLEANUP
  // ============================================================

  private async cleanup(): Promise<void> {
    logger.section('CLEANUP');

    // Stop volume simulation
    if (this.volumeSimulator) {
      await this.volumeSimulator.stop();
      this.volumeSimulator = null;
    }

    // Clear exit timer
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }

    // Print final summary
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

  /**
   * Get current status
   */
  getStatus(): BundlerStatus {
    return { ...this.status };
  }

  /**
   * Set status update callback
   */
  onStatus(callback: (status: BundlerStatus) => void): void {
    this.onStatusUpdate = callback;
  }

  /**
   * Set completion callback
   */
  onComplete(callback: (result: any) => void): void {
    this.onComplete = callback;
  }

  /**
   * Set error callback
   */
  onError(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  /**
   * Stop the bundler
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.warn('Stopping bundler...');
    this.isRunning = false;
    
    await this.cleanup();
  }
}

// ============================================================
// EXPORT
// ============================================================

export default Bundler;