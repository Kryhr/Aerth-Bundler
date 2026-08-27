/**
 * AERTH BUNDLER - Volume Simulator
 * Creates realistic trading volume and price action between wallets
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

import { logger } from '../utils/logger';
import {
  sleep,
  randomNumber,
  randomInt,
  randomSolAmount,
  randomItem,
  shuffleArray,
  clamp,
  formatSol,
  formatPrice,
  shortAddress,
  retry,
} from '../utils/helpers';
import { WalletInfo } from '../config/constants';
import JupiterIntegration from '../integrations/jupiter';

// ============================================================
// TYPES
// ============================================================

interface Trade {
  fromWallet: WalletInfo;
  toWallet: WalletInfo;
  amount: number; // In token units
  timestamp: number;
  type: 'buy' | 'sell' | 'transfer';
  signature?: string;
}

interface TradingPattern {
  name: string;
  description: string;
  trades: Array<{
    type: 'buy' | 'sell' | 'transfer';
    amountMultiplier: number; // 0-1
    weight: number; // Probability weight
  }>;
}

interface VolumeConfig {
  minTradeAmount: number; // In SOL
  maxTradeAmount: number; // In SOL
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  maxConcurrentTrades: number;
  priceImpactLimit: number; // Max % price impact
  targetDailyVolume: number; // Target volume in SOL
  spreadMultiplier: number; // For market making
}

interface SimulationStats {
  totalTrades: number;
  totalVolume: number;
  averageTradeSize: number;
  uniqueWalletsTrading: number;
  startTime: number;
  elapsedSeconds: number;
  currentPrice: number;
  volumePerHour: number;
}

// ============================================================
// DEFAULT CONFIGURATION
// ============================================================

const DEFAULT_VOLUME_CONFIG: VolumeConfig = {
  minTradeAmount: 0.001, // 0.001 SOL minimum trade
  maxTradeAmount: 0.1, // 0.1 SOL maximum trade
  minIntervalSeconds: 5, // Min 5 seconds between trades
  maxIntervalSeconds: 30, // Max 30 seconds between trades
  maxConcurrentTrades: 3, // Max 3 trades at once
  priceImpactLimit: 5, // Max 5% price impact
  targetDailyVolume: 50, // Target 50 SOL daily volume
  spreadMultiplier: 1.002, // 0.2% spread for market making
};

// ============================================================
// TRADING PATTERNS
// ============================================================

const TRADING_PATTERNS: TradingPattern[] = [
  {
    name: 'Organic Growth',
    description: 'Slow, steady buying pressure with occasional sell-offs',
    trades: [
      { type: 'buy', amountMultiplier: 0.5, weight: 40 },
      { type: 'buy', amountMultiplier: 0.3, weight: 30 },
      { type: 'sell', amountMultiplier: 0.4, weight: 15 },
      { type: 'sell', amountMultiplier: 0.2, weight: 10 },
      { type: 'transfer', amountMultiplier: 0.1, weight: 5 },
    ],
  },
  {
    name: 'Pump & Consolidate',
    description: 'Aggressive buys followed by consolidation',
    trades: [
      { type: 'buy', amountMultiplier: 0.8, weight: 35 },
      { type: 'buy', amountMultiplier: 0.6, weight: 25 },
      { type: 'sell', amountMultiplier: 0.3, weight: 20 },
      { type: 'sell', amountMultiplier: 0.5, weight: 15 },
      { type: 'transfer', amountMultiplier: 0.2, weight: 5 },
    ],
  },
  {
    name: 'Whale Accumulation',
    description: 'Large buys from multiple wallets, small sells',
    trades: [
      { type: 'buy', amountMultiplier: 0.9, weight: 50 },
      { type: 'buy', amountMultiplier: 0.7, weight: 30 },
      { type: 'sell', amountMultiplier: 0.2, weight: 10 },
      { type: 'sell', amountMultiplier: 0.1, weight: 5 },
      { type: 'transfer', amountMultiplier: 0.1, weight: 5 },
    ],
  },
  {
    name: 'Volume Spikes',
    description: 'Periods of high activity followed by quiet periods',
    trades: [
      { type: 'buy', amountMultiplier: 0.6, weight: 30 },
      { type: 'buy', amountMultiplier: 0.4, weight: 25 },
      { type: 'sell', amountMultiplier: 0.5, weight: 20 },
      { type: 'sell', amountMultiplier: 0.3, weight: 15 },
      { type: 'transfer', amountMultiplier: 0.3, weight: 10 },
    ],
  },
  {
    name: 'Market Making',
    description: 'Consistent small trades to create liquidity',
    trades: [
      { type: 'buy', amountMultiplier: 0.3, weight: 30 },
      { type: 'sell', amountMultiplier: 0.3, weight: 30 },
      { type: 'transfer', amountMultiplier: 0.2, weight: 20 },
      { type: 'buy', amountMultiplier: 0.5, weight: 10 },
      { type: 'sell', amountMultiplier: 0.5, weight: 10 },
    ],
  },
];

// ============================================================
// MAIN VOLUME SIMULATOR CLASS
// ============================================================

export class VolumeSimulator {
  private connection: Connection;
  private jupiter: JupiterIntegration;
  private wallets: WalletInfo[];
  private tokenMint: PublicKey;
  private tokenDecimals: number;
  private config: VolumeConfig;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  
  private stats: SimulationStats;
  private tradeHistory: Trade[] = [];
  private activeTrades: Set<string> = new Set();
  private currentPrice: number = 0;
  private priceHistory: number[] = [];
  
  private pattern: TradingPattern | null = null;
  private patternTimer: NodeJS.Timeout | null = null;
  private tradeTimer: NodeJS.Timeout | null = null;

  constructor(
    connection: Connection,
    jupiter: JupiterIntegration,
    wallets: WalletInfo[],
    tokenMint: PublicKey,
    tokenDecimals: number = 9,
    config: Partial<VolumeConfig> = {}
  ) {
    this.connection = connection;
    this.jupiter = jupiter;
    this.wallets = wallets;
    this.tokenMint = tokenMint;
    this.tokenDecimals = tokenDecimals;
    this.config = { ...DEFAULT_VOLUME_CONFIG, ...config };
    
    this.stats = {
      totalTrades: 0,
      totalVolume: 0,
      averageTradeSize: 0,
      uniqueWalletsTrading: 0,
      startTime: Date.now(),
      elapsedSeconds: 0,
      currentPrice: 0,
      volumePerHour: 0,
    };

    logger.info('VolumeSimulator initialized', {
      wallets: wallets.length,
      tokenMint: shortAddress(tokenMint.toBase58()),
    });
  }

  // ============================================================
  // START / STOP
  // ============================================================

  /**
   * Start volume simulation
   */
  async start(patternName?: string): Promise<void> {
    if (this.isRunning) {
      logger.warn('Volume simulation already running');
      return;
    }

    this.isRunning = true;
    this.stats.startTime = Date.now();
    this.tradeHistory = [];

    // Select pattern
    if (patternName) {
      const found = TRADING_PATTERNS.find(p => 
        p.name.toLowerCase() === patternName.toLowerCase()
      );
      this.pattern = found || randomItem(TRADING_PATTERNS);
    } else {
      this.pattern = randomItem(TRADING_PATTERNS);
    }

    // Get initial price
    await this.updatePrice();

    logger.success('Volume simulation started', {
      pattern: this.pattern.name,
      description: this.pattern.description,
    });

    // Start trading loop
    await this.tradingLoop();

    // Start pattern rotation
    this.startPatternRotation();
  }

  /**
   * Stop volume simulation
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.tradeTimer) {
      clearTimeout(this.tradeTimer);
      this.tradeTimer = null;
    }
    
    if (this.patternTimer) {
      clearTimeout(this.patternTimer);
      this.patternTimer = null;
    }

    this.activeTrades.clear();

    logger.success('Volume simulation stopped', {
      totalTrades: this.stats.totalTrades,
      totalVolume: this.stats.totalVolume,
      duration: this.stats.elapsedSeconds,
    });
  }

  /**
   * Pause simulation
   */
  pause(): void {
    if (!this.isRunning) return;
    this.isPaused = true;
    logger.info('Volume simulation paused');
  }

  /**
   * Resume simulation
   */
  resume(): void {
    if (!this.isRunning) return;
    this.isPaused = false;
    logger.info('Volume simulation resumed');
  }

  // ============================================================
  // TRADING LOOP
  // ============================================================

  /**
   * Main trading loop
   */
  private async tradingLoop(): Promise<void> {
    while (this.isRunning) {
      if (this.isPaused) {
        await sleep(1000);
        continue;
      }

      try {
        // Check if we should trade
        if (this.shouldTrade()) {
          await this.executeTrades();
        }

        // Update stats
        this.updateStats();

        // Sleep before next trade cycle
        const interval = this.getTradeInterval();
        await sleep(interval * 1000);

      } catch (error) {
        logger.error('Trading loop error', error);
        await sleep(5000);
      }
    }
  }

  /**
   * Execute trades
   */
  private async executeTrades(): Promise<void> {
    // Determine how many trades to execute
    const numTrades = randomInt(1, this.config.maxConcurrentTrades);
    const availableWallets = this.getAvailableWallets();

    if (availableWallets.length < 2) {
      return;
    }

    for (let i = 0; i < numTrades; i++) {
      if (!this.isRunning) break;

      try {
        // Select trade type based on pattern
        const tradeType = this.selectTradeType();
        const walletPair = this.selectWalletPair(availableWallets);

        if (!walletPair) continue;

        // Execute trade
        await this.executeTrade(walletPair.from, walletPair.to, tradeType);

        // Small delay between trades
        await sleep(randomNumber(0.5, 2) * 1000);

      } catch (error) {
        logger.error('Failed to execute trade', error);
      }
    }
  }

  /**
   * Execute a single trade
   */
  private async executeTrade(
    fromWallet: WalletInfo,
    toWallet: WalletInfo,
    type: 'buy' | 'sell' | 'transfer'
  ): Promise<void> {
    try {
      const tradeId = `${fromWallet.publicKey.slice(0, 8)}_${Date.now()}`;
      if (this.activeTrades.has(tradeId)) return;
      this.activeTrades.add(tradeId);

      // Calculate trade amount
      const tradeAmount = this.calculateTradeAmount();

      if (tradeAmount < this.config.minTradeAmount) {
        this.activeTrades.delete(tradeId);
        return;
      }

      const tokenAmount = tradeAmount * 10; // Rough estimate of tokens per SOL
      const tokenAmountWithDecimals = tokenAmount * Math.pow(10, this.tokenDecimals);

      let result;
      let trade: Trade;

      switch (type) {
        case 'buy':
          // Buy from Jupiter
          result = await this.jupiter.buyTokens(
            this.tokenMint,
            tradeAmount,
            fromWallet,
            Math.min(this.config.priceImpactLimit * 10, 50)
          );

          trade = {
            fromWallet,
            toWallet: fromWallet, // Self-trade for buys
            amount: result.outputAmount || 0,
            timestamp: Date.now(),
            type: 'buy',
            signature: result.signature,
          };
          break;

        case 'sell':
          // Sell to Jupiter
          result = await this.jupiter.sellTokens(
            this.tokenMint,
            tokenAmount,
            fromWallet,
            this.tokenDecimals,
            Math.min(this.config.priceImpactLimit * 10, 50)
          );

          trade = {
            fromWallet,
            toWallet: fromWallet, // Self-trade for sells
            amount: result.inputAmount || 0,
            timestamp: Date.now(),
            type: 'sell',
            signature: result.signature,
          };
          break;

        case 'transfer':
          // Transfer between wallets (simulated)
          trade = {
            fromWallet,
            toWallet,
            amount: tokenAmountWithDecimals,
            timestamp: Date.now(),
            type: 'transfer',
          };
          break;
      }

      // Record trade
      if (trade) {
        this.tradeHistory.push(trade);
        this.stats.totalTrades++;
        this.stats.totalVolume += tradeAmount;

        // Log trade
        logger.trade(
          `${type.toUpperCase()} ${formatSol(tradeAmount)} from ${shortAddress(fromWallet.publicKey)} ` +
          `to ${shortAddress(toWallet.publicKey)}`,
          {
            type,
            amount: formatSol(tradeAmount),
            from: shortAddress(fromWallet.publicKey),
            to: shortAddress(toWallet.publicKey),
            signature: trade.signature ? shortAddress(trade.signature) : 'none',
          }
        );
      }

      // Update price
      await this.updatePrice();

      // Cleanup
      this.activeTrades.delete(tradeId);

    } catch (error) {
      logger.error('Trade execution failed', error);
    }
  }

  // ============================================================
  // TRADE SELECTION HELPERS
  // ============================================================

  /**
   * Select trade type based on pattern
   */
  private selectTradeType(): 'buy' | 'sell' | 'transfer' {
    if (!this.pattern) {
      return randomItem(['buy', 'sell', 'transfer']);
    }

    const weightedTypes: Array<'buy' | 'sell' | 'transfer'> = [];
    for (const trade of this.pattern.trades) {
      for (let i = 0; i < trade.weight; i++) {
        weightedTypes.push(trade.type);
      }
    }

    return randomItem(weightedTypes);
  }

  /**
   * Select wallet pair for trade
   */
  private selectWalletPair(
    availableWallets: WalletInfo[]
  ): { from: WalletInfo; to: WalletInfo } | null {
    if (availableWallets.length < 2) return null;

    const shuffled = shuffleArray(availableWallets);
    const from = shuffled[0];
    const to = shuffled[1];

    return { from, to };
  }

  /**
   * Get available wallets (not currently trading)
   */
  private getAvailableWallets(): WalletInfo[] {
    const tradingAddresses = new Set();
    for (const tradeId of this.activeTrades) {
      // Extract address from tradeId
      const address = tradeId.split('_')[0];
      if (address) tradingAddresses.add(address);
    }

    return this.wallets.filter(w => !tradingAddresses.has(w.publicKey.slice(0, 8)));
  }

  /**
   * Calculate trade amount
   */
  private calculateTradeAmount(): number {
    // Random amount within config bounds
    let amount = randomSolAmount(
      this.config.minTradeAmount,
      this.config.maxTradeAmount
    );

    // Scale based on current volume target
    const volumeScaling = this.getVolumeScaling();
    amount *= volumeScaling;

    // Clamp to bounds
    return clamp(amount, this.config.minTradeAmount, this.config.maxTradeAmount);
  }

  /**
   * Get volume scaling based on target
   */
  private getVolumeScaling(): number {
    const elapsedHours = (Date.now() - this.stats.startTime) / (1000 * 60 * 60);
    if (elapsedHours < 1) return 0.5;

    const currentVolumePerHour = this.stats.volumePerHour || 0.1;
    const targetPerHour = this.config.targetDailyVolume / 24;

    if (currentVolumePerHour < targetPerHour * 0.5) {
      return 1.5; // Increase volume
    } else if (currentVolumePerHour > targetPerHour * 1.5) {
      return 0.7; // Decrease volume
    }

    return 1.0;
  }

  /**
   * Get trade interval
   */
  private getTradeInterval(): number {
    const baseInterval = randomNumber(
      this.config.minIntervalSeconds,
      this.config.maxIntervalSeconds
    );

    // Add some randomness based on volume target
    const targetPerHour = this.config.targetDailyVolume / 24;
    const currentPerHour = this.stats.volumePerHour || 0.1;

    if (currentPerHour < targetPerHour * 0.7) {
      return baseInterval * 0.7; // Trade more frequently
    } else if (currentPerHour > targetPerHour * 1.3) {
      return baseInterval * 1.3; // Trade less frequently
    }

    return baseInterval;
  }

  // ============================================================
  // PRICE MANAGEMENT
  // ============================================================

  /**
   * Update current price
   */
  private async updatePrice(): Promise<void> {
    try {
      const price = await this.jupiter.getTokenPrice(this.tokenMint);
      if (price > 0) {
        this.currentPrice = price;
        this.priceHistory.push(price);
        this.stats.currentPrice = price;
      }
    } catch (error) {
      // Keep using last known price
    }
  }

  /**
   * Apply price impact from trade
   */
  private applyPriceImpact(tradeAmount: number, type: 'buy' | 'sell'): void {
    if (this.currentPrice === 0) return;

    const impact = (tradeAmount / this.getTotalLiquidity()) * 100;
    const maxImpact = this.config.priceImpactLimit;

    if (impact > 0.01) {
      const impactMultiplier = Math.min(impact / maxImpact, 1);
      const priceChange = this.currentPrice * impactMultiplier * 0.01;

      if (type === 'buy') {
        this.currentPrice += priceChange;
      } else {
        this.currentPrice -= priceChange;
      }

      // Add random walk
      this.currentPrice += (Math.random() - 0.5) * this.currentPrice * 0.001;
      this.currentPrice = Math.max(this.currentPrice, 0.0000001);
    }
  }

  /**
   * Get total liquidity (estimated)
   */
  private getTotalLiquidity(): number {
    // Estimate based on total volume and price
    if (this.currentPrice === 0) return 100;
    
    const estimatedLiquidity = this.stats.totalVolume / this.currentPrice / 1000;
    return Math.max(estimatedLiquidity, 10);
  }

  // ============================================================
  // PATTERN MANAGEMENT
  // ============================================================

  /**
   * Start pattern rotation
   */
  private startPatternRotation(): void {
    if (this.patternTimer) return;

    this.patternTimer = setInterval(() => {
      if (!this.isRunning || this.isPaused) return;

      // Rotate pattern every 2-5 minutes
      const newPattern = randomItem(TRADING_PATTERNS);
      this.pattern = newPattern;

      logger.info('Trading pattern changed', {
        pattern: newPattern.name,
        description: newPattern.description,
      });

    }, randomNumber(120, 300) * 1000);
  }

  // ============================================================
  // STATISTICS
  // ============================================================

  /**
   * Update statistics
   */
  private updateStats(): void {
    this.stats.elapsedSeconds = (Date.now() - this.stats.startTime) / 1000;
    this.stats.averageTradeSize = this.stats.totalTrades > 0
      ? this.stats.totalVolume / this.stats.totalTrades
      : 0;
    this.stats.volumePerHour = this.stats.elapsedSeconds > 0
      ? (this.stats.totalVolume / this.stats.elapsedSeconds) * 3600
      : 0;
    this.stats.uniqueWalletsTrading = new Set(
      this.tradeHistory.map(t => t.fromWallet.publicKey)
    ).size;
  }

  /**
   * Get current stats
   */
  getStats(): SimulationStats {
    this.updateStats();
    return { ...this.stats };
  }

  /**
   * Get price history
   */
  getPriceHistory(): number[] {
    return [...this.priceHistory];
  }

  /**
   * Get trade history
   */
  getTradeHistory(limit: number = 100): Trade[] {
    return this.tradeHistory.slice(-limit);
  }

  /**
   * Check if trading should happen
   */
  private shouldTrade(): boolean {
    // Don't trade if we've exceeded target
    const targetPerHour = this.config.targetDailyVolume / 24;
    if (this.stats.volumePerHour > targetPerHour * 1.5) {
      return false;
    }

    // Random chance based on current activity
    const activityLevel = this.stats.volumePerHour / targetPerHour;
    const chance = clamp(0.3 + activityLevel * 0.5, 0.3, 0.9);
    
    return Math.random() < chance;
  }

  // ============================================================
  // SUMMARY
  // ============================================================

  /**
   * Print summary
   */
  printSummary(): void {
    const stats = this.getStats();
    
    logger.section('VOLUME SIMULATION SUMMARY');
    console.log(`  Status:            ${this.isRunning ? '🟢 Running' : '🔴 Stopped'}`);
    console.log(`  Pattern:           ${this.pattern?.name || 'None'}`);
    console.log(`  Total Trades:      ${stats.totalTrades}`);
    console.log(`  Total Volume:      ${formatSol(stats.totalVolume)}`);
    console.log(`  Avg Trade Size:    ${formatSol(stats.averageTradeSize)}`);
    console.log(`  Volume/Hour:       ${formatSol(stats.volumePerHour)}`);
    console.log(`  Active Wallets:    ${stats.uniqueWalletsTrading}`);
    console.log(`  Current Price:     ${formatPrice(stats.currentPrice)}`);
    console.log(`  Elapsed Time:      ${Math.floor(stats.elapsedSeconds / 60)}m ${Math.floor(stats.elapsedSeconds % 60)}s`);
    logger.divider('═');
  }
}

// ============================================================
// EXPORT
// ============================================================

export default VolumeSimulator;