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
import LocalMarket from './localMarket';

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
  minIntervalSeconds: 1, // Min 1s between trade cycles - was 5s, far too slow
  maxIntervalSeconds: 3, // Max 3s between trade cycles - was 30s. (0.5-2s caused a 429 storm against devnet's public RPC)
  maxConcurrentTrades: 4, // Max 4 trades at once - was 3 (then 6, which was too much concurrent RPC load)
  priceImpactLimit: 5, // Max 5% price impact
  targetDailyVolume: 300, // Target 300 SOL daily volume - was 50, throttled activity to a crawl
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

// Devnet rehearsal should look like a coin being bought into, not sold off -
// "Market Making" (~50/50 buy/sell) and "Volume Spikes" (barely buy-leaning)
// can flip a whole session sell-heavy if picked by the random pattern
// rotation. Restrict rotation to the patterns that are genuinely buy-dominant.
const BUY_DOMINANT_PATTERNS = TRADING_PATTERNS.filter(p =>
  ['Organic Growth', 'Pump & Consolidate', 'Whale Accumulation'].includes(p.name)
);

// Genuine chop, deliberately - real charts have actual sideways "basing"
// zones between legs up, not just a single-candle wobble. Reused as-is
// during consolidation windows (see CONSOLIDATION_MAX_SECONDS etc. below).
const CONSOLIDATION_PATTERN = TRADING_PATTERNS.find(p => p.name === 'Market Making')!;

// ============================================================
// MAIN VOLUME SIMULATOR CLASS
// ============================================================

export class VolumeSimulator {
  private connection: Connection;
  private market: LocalMarket;
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

  // On mainnet, real outside strangers will also hold and sell this token -
  // selling pressure this bundler doesn't control. 80% of wallets trade
  // normally (buy-dominant, light selling, pushing price up); the other 20%
  // sit idle in reserve and only deploy - buying in fully, once each - when
  // selling picks up noticeably, defending the price instead of adding to
  // ordinary volume from the start. Gated by the same isPaused check as
  // everything else in the trading loop, so reserve wallets never buy in
  // during/after a real exit.
  private activeWallets: WalletInfo[] = [];
  private reserveWallets: WalletInfo[] = [];
  private triggeredReserveWallets: Set<string> = new Set();
  private recentSellTimestamps: number[] = [];
  private static readonly RESERVE_FRACTION = 0.2;
  private static readonly SELL_SPIKE_WINDOW_MS = 30000;
  private static readonly SELL_SPIKE_THRESHOLD = 3;

  // Real charts have genuine sideways "basing" zones between legs up, not
  // just brief single-candle wobbles inside an otherwise uniform staircase.
  // How many a given session gets (1-5) is randomized once at start so no
  // two sessions look identically patterned, matching how one real coin
  // might consolidate once and another five times.
  private inConsolidation: boolean = false;
  private consolidationEndsAt: number = 0;
  private consolidationBudget: number = 0;
  private static readonly MAX_CONSOLIDATIONS_PER_SESSION = 5;
  private static readonly CONSOLIDATION_MIN_SECONDS = 60;
  private static readonly CONSOLIDATION_MAX_SECONDS = 360; // "5 to 6 min" cap
  // Both trade sizing AND the price floor get widened during consolidation
  // specifically - the defaults are tuned for a tight band right after a
  // fresh peak, which pinned a whole consolidation window into an
  // unnaturally flat, mechanical-looking line instead of a real basing
  // pattern with visible range. Applied symmetrically to buys and sells so
  // it stays direction-neutral, not a bias toward selling.
  private static readonly CONSOLIDATION_SIZE_MULTIPLIER = 2.5;
  private static readonly CONSOLIDATION_FLOOR_RATIO = 0.85; // ~15% max pullback, vs the normal ~8%

  // Real traders take more profit right after a sharp run-up, not at a flat
  // random rate the whole time - this tracks recent price samples so sell
  // FREQUENCY (never size) can lean higher right after a strong climb,
  // without ever making an individual sell look like someone dumping.
  private priceSamples: Array<{ time: number; price: number }> = [];
  private static readonly MOMENTUM_WINDOW_MS = 60000;

  constructor(
    connection: Connection,
    market: LocalMarket,
    wallets: WalletInfo[],
    tokenMint: PublicKey,
    tokenDecimals: number = 9,
    config: Partial<VolumeConfig> = {}
  ) {
    this.connection = connection;
    this.market = market;
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

    const shuffled = shuffleArray(this.wallets);
    const activeCount = Math.max(1, Math.round(shuffled.length * (1 - VolumeSimulator.RESERVE_FRACTION)));
    this.activeWallets = shuffled.slice(0, activeCount);
    this.reserveWallets = shuffled.slice(activeCount);
    this.triggeredReserveWallets.clear();
    this.recentSellTimestamps = [];
    this.priceSamples = [];
    this.inConsolidation = false;
    this.consolidationBudget = randomInt(1, VolumeSimulator.MAX_CONSOLIDATIONS_PER_SESSION);

    // Select pattern - default to a buy-dominant one; an explicitly named
    // pattern (e.g. via VOLUME_PATTERN) is still honored even if it isn't.
    if (patternName) {
      const found = TRADING_PATTERNS.find(p =>
        p.name.toLowerCase() === patternName.toLowerCase()
      );
      this.pattern = found || randomItem(BUY_DOMINANT_PATTERNS);
    } else {
      this.pattern = randomItem(BUY_DOMINANT_PATTERNS);
    }

    // Get initial price
    this.updatePrice();

    logger.success('Volume simulation started', {
      pattern: this.pattern.name,
      description: this.pattern.description,
    });

    // Run the trading loop in the background - it must NOT be awaited here,
    // since it only resolves once stop() is called. Awaiting it would block
    // start() (and therefore the bundler's whole execute() chain) forever,
    // meaning Step 5 (monitoring/exit strategy/hotkey exit) would never run.
    this.tradingLoop().catch((error) => logger.error('Trading loop crashed', error));

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

        // Reserve wallets only ever get considered here, after the isPaused
        // gate above - pause() is always called before a real exit, so
        // reserve wallets can never buy in during/after "close all".
        await this.checkReserveDefense();

        this.samplePriceForMomentum();

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
      // Also bail on isPaused, not just isRunning - pause() is called right
      // before ExitStrategy snapshots balances for a mass sell-off, and a
      // trade batch already in progress could otherwise keep selling from a
      // wallet after that snapshot was taken, causing "insufficient funds"
      // when the real sell-off later tries to sell the stale, too-high amount.
      if (!this.isRunning || this.isPaused) break;

      try {
        // Select trade type based on pattern
        const tradeType = this.selectTradeType();
        const walletPair = this.selectWalletPair(availableWallets);

        if (!walletPair) continue;

        // Execute trade
        await this.executeTrade(walletPair.from, walletPair.to, tradeType);

        // Small delay between trades - was 0.5-2s, which serialized even a
        // same-cycle batch into multiple seconds of dead time
        await sleep(randomNumber(0.1, 0.3) * 1000);

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
    const tradeId = `${fromWallet.publicKey.slice(0, 8)}_${Date.now()}`;
    if (this.activeTrades.has(tradeId)) return;
    this.activeTrades.add(tradeId);

    try {
      let trade: Trade | null = null;
      let solVolume = 0;

      switch (type) {
        case 'buy': {
          let solAmount = this.calculateTradeAmount();

          // Consolidation windows need real, visible range to trade within -
          // the default sizing is tuned for a tight band right after a fresh
          // peak, which made a whole consolidation window look like a
          // pinned, unnaturally flat line instead of a real basing pattern.
          // Boosting both sides symmetrically (buy AND sell) keeps it
          // direction-neutral - wider chop, not a bias either way.
          if (this.inConsolidation) {
            solAmount *= VolumeSimulator.CONSOLIDATION_SIZE_MULTIPLIER;
          }

          // calculateTradeAmount() sizes off the CURVE's depth, with no idea
          // what this particular wallet actually has left - Step 3 already
          // deployed 70-95% of each wallet's balance into the bundled buy-in,
          // so a curve-relative buy can easily exceed what's left, failing
          // the transaction outright with nothing logged above debug level.
          // As more wallets ran dry this way, visible buy volume quietly
          // dwindled toward zero over the course of a session. Clamp to what
          // this wallet can actually afford instead of letting it fail silently.
          const walletBalance = await this.connection.getBalance(new PublicKey(fromWallet.publicKey)) / 1e9;
          const affordable = Math.max(0, walletBalance - 0.01);
          solAmount = Math.min(solAmount, affordable);

          if (solAmount < this.config.minTradeAmount) break;

          const result = await this.market.buy(fromWallet, solAmount);
          if (!result.success) {
            logger.debug(`Buy skipped for ${shortAddress(fromWallet.publicKey)}: ${result.error}`);
            break;
          }

          this.currentPrice = result.price;
          solVolume = result.solAmount;
          trade = {
            fromWallet,
            toWallet: fromWallet, // Self-trade for buys
            amount: result.tokenAmount,
            timestamp: Date.now(),
            type: 'buy',
            signature: result.signature,
          };
          break;
        }

        case 'sell': {
          const balance = await this.market.getTokenBalance(fromWallet);
          if (balance <= 0) break;

          // Sized off the curve's current token depth - same basis buys use
          // (a % of current SOL depth) - not off this wallet's own token
          // balance. Balance-relative sizing meant sells mechanically grew
          // in absolute size as a wallet accumulated more tokens over a long
          // session, while buys stayed capped by each wallet's shrinking
          // spare SOL - late in a session, sell power quietly outgrew buy
          // power and the price drifted down instead of continuing to climb.
          // Depth-relative sizing keeps both sides on equal footing for as
          // long as the session runs.
          const reserves = this.market.getReserves();
          const sellSizeMultiplier = this.inConsolidation ? VolumeSimulator.CONSOLIDATION_SIZE_MULTIPLIER : 1;
          const sellAmount = Math.min(balance, reserves.tokens * randomNumber(0.0015, 0.005) * sellSizeMultiplier);
          // Wider floor during consolidation - the default band is tuned for
          // right after a fresh peak, not for a real basing pattern that
          // needs room to actually move within.
          const floorRatio = this.inConsolidation ? VolumeSimulator.CONSOLIDATION_FLOOR_RATIO : undefined;
          const result = await this.market.sell(fromWallet, sellAmount, false, floorRatio);
          if (!result.success) {
            logger.debug(`Sell skipped for ${shortAddress(fromWallet.publicKey)}: ${result.error}`);
            break;
          }

          this.currentPrice = result.price;
          solVolume = result.solAmount;
          this.recentSellTimestamps.push(Date.now());
          trade = {
            fromWallet,
            toWallet: fromWallet, // Self-trade for sells
            amount: result.tokenAmount,
            timestamp: Date.now(),
            type: 'sell',
            signature: result.signature,
          };
          break;
        }

        case 'transfer': {
          const balance = await this.market.getTokenBalance(fromWallet);
          if (balance <= 0) break;

          const transferAmount = balance * randomNumber(0.02, 0.1);
          const result = await this.market.transfer(fromWallet, toWallet, transferAmount);
          if (!result.success) {
            logger.debug(`Transfer skipped: ${result.error}`);
            break;
          }

          // A transfer moves tokens directly between wallets - no SOL
          // changes hands, so there's no real SOL amount to report here.
          // This used to fake one as tokens * currentPrice and log/count it
          // exactly like a real buy/sell SOL amount, which never matched
          // what actually happened on-chain and inflated totalVolume with
          // a fictional number.
          solVolume = 0;
          trade = {
            fromWallet,
            toWallet,
            amount: result.tokenAmount,
            timestamp: Date.now(),
            type: 'transfer',
            signature: result.signature,
          };
          break;
        }
      }

      // Record trade
      if (trade) {
        this.tradeHistory.push(trade);
        this.stats.totalTrades++;
        this.stats.totalVolume += solVolume;

        // Transfers report the exact real token amount moved; buys/sells
        // report the exact real SOL amount that changed hands.
        const amountLabel = type === 'transfer'
          ? `${trade.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
          : formatSol(solVolume);

        // Buys/sells only ever involve one real wallet (trading against the
        // curve) - trade.toWallet is set to trade.fromWallet for those, so
        // log just the one wallet instead of a fake "from -> to" pair. Only
        // transfers genuinely move funds between two real wallets.
        const logMessage = type === 'transfer'
          ? `${type.toUpperCase()} ${amountLabel} from ${shortAddress(trade.fromWallet.publicKey)} ` +
            `to ${shortAddress(trade.toWallet.publicKey)}`
          : `${type.toUpperCase()} ${amountLabel} by ${shortAddress(trade.fromWallet.publicKey)}`;

        logger.trade(
          logMessage,
          {
            type,
            amount: amountLabel,
            from: shortAddress(trade.fromWallet.publicKey),
            to: type === 'transfer' ? shortAddress(trade.toWallet.publicKey) : undefined,
            signature: trade.signature ? shortAddress(trade.signature) : 'none',
          }
        );
      }

    } catch (error) {
      logger.error('Trade execution failed', error);
    } finally {
      this.activeTrades.delete(tradeId);
    }
  }

  // ============================================================
  // TRADE SELECTION HELPERS
  // ============================================================

  /**
   * Select trade type based on pattern
   */
  private selectTradeType(): 'buy' | 'sell' | 'transfer' {
    // Consolidation windows use a genuinely balanced pattern regardless of
    // whatever buy-dominant pattern is currently active - that's the whole
    // point of a real chop zone. No momentum boost layered on top of it;
    // it's already balanced.
    const activePattern = this.inConsolidation ? CONSOLIDATION_PATTERN : this.pattern;

    if (!activePattern) {
      return randomItem(['buy', 'sell', 'transfer']);
    }

    const weightedTypes: Array<'buy' | 'sell' | 'transfer'> = [];
    for (const trade of activePattern.trades) {
      for (let i = 0; i < trade.weight; i++) {
        weightedTypes.push(trade.type);
      }
    }

    if (!this.inConsolidation) {
      // Real traders take more profit right after a sharp run-up - lean
      // toward picking 'sell' MORE OFTEN after strong recent momentum,
      // without ever changing how big any individual sell is (that stays
      // whatever the pattern/curve-depth sizing already produces). Capped
      // so it can never flip the pool sell-dominant outright.
      const momentum = this.getRecentMomentum();
      if (momentum > 0.02) {
        const boost = clamp(momentum * 6, 0, 0.5); // up to +50% extra sell entries
        const extraSells = Math.round(weightedTypes.length * boost);
        for (let i = 0; i < extraSells; i++) weightedTypes.push('sell');
      }
    }

    return randomItem(weightedTypes);
  }

  /**
   * Take a lightweight price sample for momentum tracking - called once per
   * trading loop cycle, pruned to the last MOMENTUM_WINDOW_MS.
   */
  private samplePriceForMomentum(): void {
    if (this.currentPrice <= 0) return;
    const now = Date.now();
    this.priceSamples.push({ time: now, price: this.currentPrice });
    this.priceSamples = this.priceSamples.filter(
      s => now - s.time < VolumeSimulator.MOMENTUM_WINDOW_MS
    );
  }

  /**
   * Fractional price change over the recent window (e.g. 0.05 = +5%) -
   * only ever used to bias sell FREQUENCY, never sell size.
   */
  private getRecentMomentum(): number {
    if (this.priceSamples.length < 2) return 0;
    const oldest = this.priceSamples[0].price;
    const newest = this.priceSamples[this.priceSamples.length - 1].price;
    if (oldest <= 0) return 0;
    return (newest - oldest) / oldest;
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

    // Ordinary buy/sell/transfer trading only ever draws from the 80% active
    // pool - the 20% reserve stays idle until deployed by checkReserveDefense.
    const pool = this.activeWallets.length > 0 ? this.activeWallets : this.wallets;
    return pool.filter(w => !tradingAddresses.has(w.publicKey.slice(0, 8)));
  }

  /**
   * Calculate trade amount
   */
  private calculateTradeAmount(): number {
    // Scale with the curve's CURRENT real SOL depth, not a fixed absolute SOL
    // range. After Step 3's bundled buys deposit real capital, the curve's
    // reserve is far deeper than at launch - the same fixed-SOL buy that
    // moved price noticeably pre-entry becomes a shrinking, eventually
    // negligible fraction of the (now much larger) curve, which is exactly
    // why organic trading went flat/no-volume after the initial pump. Sizing
    // relative to current depth keeps buys visually meaningful throughout.
    const currentSolReserve = this.market.getReserves().sol;
    let amount = currentSolReserve * randomNumber(0.002, 0.008);

    // Scale based on current volume target
    const volumeScaling = this.getVolumeScaling();
    amount *= volumeScaling;

    // Floor at the configured minimum so a very shallow curve still trades;
    // no upper clamp - the point is letting this grow with real depth.
    return Math.max(this.config.minTradeAmount, amount);
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
   * Update current price from the bonding curve's live reserves
   */
  private updatePrice(): void {
    const price = this.market.getPrice();
    if (price > 0) {
      this.currentPrice = price;
      this.priceHistory.push(price);
      this.stats.currentPrice = price;
    }
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
      if (!this.isRunning || this.isPaused || this.inConsolidation) return;

      // Rotate pattern every 2-5 minutes
      const newPattern = randomItem(BUY_DOMINANT_PATTERNS);
      this.pattern = newPattern;

      logger.info('Trading pattern changed', {
        pattern: newPattern.name,
        description: newPattern.description,
      });

    }, randomNumber(120, 300) * 1000);

    this.startConsolidationScheduler();
  }

  /**
   * Checked far more often than pattern rotation (every ~20-40s) so up to
   * MAX_CONSOLIDATIONS_PER_SESSION windows can plausibly fit even in a
   * short devnet test, not just a multi-hour real session. Each check has a
   * modest independent chance to start one if budget remains; once
   * started, this loop just watches for it to end.
   */
  private startConsolidationScheduler(): void {
    const check = () => {
      if (!this.isRunning) return;

      if (!this.isPaused) {
        if (this.inConsolidation) {
          if (Date.now() >= this.consolidationEndsAt) {
            this.inConsolidation = false;
            logger.info('Consolidation ended, resuming bullish trend');
          }
        } else if (this.consolidationBudget > 0 && Math.random() < 0.25) {
          this.inConsolidation = true;
          this.consolidationBudget--;
          const durationSec = randomNumber(
            VolumeSimulator.CONSOLIDATION_MIN_SECONDS,
            VolumeSimulator.CONSOLIDATION_MAX_SECONDS
          );
          this.consolidationEndsAt = Date.now() + durationSec * 1000;
          logger.info('📊 Entering consolidation phase', {
            durationSec: Math.round(durationSec),
            remainingThisSession: this.consolidationBudget,
          });
        }
      }

      setTimeout(check, randomNumber(20, 40) * 1000);
    };

    setTimeout(check, randomNumber(20, 40) * 1000);
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
   * Deploy one reserve wallet's full balance as a defensive buy once selling
   * has picked up noticeably (SELL_SPIKE_THRESHOLD real sells within
   * SELL_SPIKE_WINDOW_MS). Escalates one wallet at a time per burst rather
   * than dumping all 20% in at once on the first sell - each additional
   * spike brings in one more, mirroring "buy in fully to help push price up"
   * only as pressure keeps building. Never mistaken for organic volume: this
   * is a full-balance buy, not the small sized trades everywhere else.
   */
  private async checkReserveDefense(): Promise<void> {
    if (this.reserveWallets.length === 0) return;

    const now = Date.now();
    this.recentSellTimestamps = this.recentSellTimestamps.filter(
      t => now - t < VolumeSimulator.SELL_SPIKE_WINDOW_MS
    );

    if (this.recentSellTimestamps.length < VolumeSimulator.SELL_SPIKE_THRESHOLD) return;

    const candidate = this.reserveWallets.find(
      w => !this.triggeredReserveWallets.has(w.publicKey)
    );
    if (!candidate) return;

    this.triggeredReserveWallets.add(candidate.publicKey);
    // Consume the spike that triggered this so the next reserve wallet needs
    // a fresh burst of selling, not the same one re-triggering repeatedly.
    this.recentSellTimestamps = [];

    try {
      const solBalance = await this.connection.getBalance(new PublicKey(candidate.publicKey)) / 1e9;
      const amount = Math.max(0, solBalance - 0.01) * randomNumber(0.8, 0.95);
      if (amount < 0.001) return;

      const result = await this.market.buy(candidate, amount);
      if (result.success) {
        this.currentPrice = result.price;
        this.stats.totalTrades++;
        this.stats.totalVolume += result.solAmount;
        logger.trade(`🛡️  RESERVE BUY ${formatSol(result.solAmount)} by ${shortAddress(candidate.publicKey)} - defending against rising sell pressure`);
      }
    } catch (error) {
      logger.debug('Reserve defense buy failed', error);
    }
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
    // Previously this compared a LIFETIME cumulative average
    // (totalVolume / elapsedSeconds) against a target and hard-stopped
    // trading entirely once it exceeded 1.5x - but a cumulative average only
    // decays slowly as elapsedSeconds grows, so one early burst of trades
    // (now larger, since buy size scales with the curve's real depth) could
    // trip the cutoff and then keep trading fully blocked for many minutes
    // with zero errors logged, exactly matching reports of long dead
    // stretches with no volume at all. A bundler session is short and meant
    // to trade continuously and buy-dominantly throughout - there's no real
    // need for a daily-volume-style throttle here at all, so just trade
    // steadily after a brief warm-up instead of gating on a fragile average.
    const WARMUP_SECONDS = 300;
    if (this.stats.elapsedSeconds < WARMUP_SECONDS) {
      return Math.random() < 0.7;
    }

    return Math.random() < 0.6;
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