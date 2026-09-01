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
  randomNumber,
  chunkArray,
  shuffleArray,
  retry,
  timestampSeconds,
} from '../utils/helpers';
import { DEFAULT_CONFIG, BundleStats, WalletInfo } from '../config/constants';

import WalletManager from './walletManager';
import TokenFactory from './tokenFactory';
import LocalMarket from './localMarket';
import VolumeSimulator from './volumeSimulator';
import ExitStrategy from './exitStrategy';
import NpcSimulator from './npcSimulator';

// ============================================================
// TYPES
// ============================================================

interface BundlerConfig {
  tokenName?: string;
  tokenSymbol?: string;
  tokenIconPath?: string;
  tokenDescription?: string;
  tokenTwitter?: string;
  tokenTelegram?: string;
  tokenWebsite?: string;
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
  tokenSupply: number;
  currentPrice: number;
  currentMultiplier: number;
  totalVolume: number;
  totalWallets: number;
  fundedWallets: number;
  timeRemaining: number;
  profitTarget: number;
  currentProfit: number;
  profitSol: number;
  totalInvested: number;
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
  private market: LocalMarket | null = null;
  private volumeSimulator: VolumeSimulator | null = null;
  private exitStrategy: ExitStrategy | null = null;

  private status: BundlerStatus;
  private isRunning: boolean = false;
  private tokenMint: PublicKey | null = null;
  private tokenDecimals: number = 9;
  private initialPrice: number = 0;
  private totalBuyVolume: number = 0;
  private startTimestamp: number = 0;
  private exitTimer: NodeJS.Timeout | null = null;
  private forceExitRequested: boolean = false;
  private positionsClosed: boolean = false;
  private exitPromise: Promise<void> | null = null;
  // Tracked separately from status.currentMultiplier/currentPrice, which get
  // overwritten with the post-exit value once the sell-off completes -
  // without this, "Peak Multiplier" in the final summary was silently
  // showing the FINAL multiplier instead of the real historical peak.
  private peakMultiplier: number = 1;
  private peakPrice: number = 0;
  
  private onStatusUpdate?: (status: BundlerStatus) => void;
  private onCompleteCallback?: (result: any) => void;
  private onErrorCallback?: (error: Error) => void;

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
      tokenIconPath: config.tokenIconPath || '',
      tokenDescription: config.tokenDescription || '',
      tokenTwitter: config.tokenTwitter || '',
      tokenTelegram: config.tokenTelegram || '',
      tokenWebsite: config.tokenWebsite || '',
      tokenSupply: config.tokenSupply || 1_000_000_000,
      initialLiquidity: config.initialLiquidity || DEFAULT_CONFIG.initialLiquidity,
      numberOfWallets: config.numberOfWallets || DEFAULT_CONFIG.numberOfWallets,
      minBuyAmount: config.minBuyAmount || DEFAULT_CONFIG.minBuyAmount,
      maxBuyAmount: config.maxBuyAmount || DEFAULT_CONFIG.maxBuyAmount,
      targetDailyVolume: config.targetDailyVolume || 500,
      volumePattern: config.volumePattern || 'Organic Growth',
      targetMultiplier: config.targetMultiplier || DEFAULT_CONFIG.targetMultiplier,
      exitTimerHours: config.exitTimerHours || DEFAULT_CONFIG.exitTimerHours,
      maxSlippage: config.maxSlippage || DEFAULT_CONFIG.maxSlippage,
      isDevnet: config.isDevnet !== undefined ? config.isDevnet : true,
    };
    
    this.tokenFactory = new TokenFactory(connection, this.config.isDevnet);

    this.status = {
      phase: 'idle',
      tokenName: this.config.tokenName,
      tokenSymbol: this.config.tokenSymbol,
      tokenSupply: this.config.tokenSupply,
      currentPrice: 0,
      currentMultiplier: 1,
      totalVolume: 0,
      totalWallets: 0,
      fundedWallets: 0,
      timeRemaining: this.config.exitTimerHours * 3600,
      profitTarget: this.config.targetMultiplier,
      currentProfit: 0,
      profitSol: 0,
      totalInvested: 0,
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
      if (this.onErrorCallback) {
        this.onErrorCallback(error as Error);
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
      iconPath: this.config.tokenIconPath,
      description: this.config.tokenDescription,
      twitter: this.config.tokenTwitter,
      telegram: this.config.tokenTelegram,
      website: this.config.tokenWebsite,
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
      this.status.tokenSupply = retryResult.supply;

      this.market = new LocalMarket(
        this.connection, this.tokenMint, this.tokenDecimals,
        mainWallet, Bundler.VIRTUAL_SOL_RESERVE, retryResult.supply
      );
    } else {
      this.tokenMint = new PublicKey(result.mintAddress);
      this.tokenDecimals = result.decimals || 9;
      this.status.tokenMint = result.mintAddress;
      this.status.tokenName = result.name;
      this.status.tokenSymbol = result.symbol;
      this.status.tokenSupply = result.supply;

      this.market = new LocalMarket(
        this.connection, this.tokenMint, this.tokenDecimals,
        mainWallet, Bundler.VIRTUAL_SOL_RESERVE, result.supply
      );
    }

    logger.success('Token launched', {
      name: this.status.tokenName,
      symbol: this.status.tokenSymbol,
      mint: shortAddress(this.status.tokenMint || ''),
      supply: this.config.tokenSupply.toLocaleString(),
      liquidity: formatSol(this.config.initialLiquidity),
    });

    this.initialPrice = this.market.getPrice();
    this.status.currentPrice = this.initialPrice;
    this.status.currentMultiplier = 1;

    logger.info('Initial price (bonding curve)', {
      price: formatPrice(this.status.currentPrice),
    });

    // Emit the true starting baseline immediately, before any buys happen -
    // without this, the chart's first candle(s) have no data point until the
    // first buy lands, showing as empty/no-volume even though a real
    // starting price already exists from the virtual reserve.
    if (this.onStatusUpdate) {
      this.onStatusUpdate({ ...this.status });
    }

    // Devnet-only rehearsal aid: a couple of wallets deliberately separate
    // from the bundled set, simulating real outside buyers discovering the
    // token. Fire-and-forget on purpose - it runs on its own independent
    // timeline in the background and must never block or be awaited by the
    // real bundler flow. NpcSimulator itself hard-gates on devnet again
    // internally, so isDevnet being wrong here still can't enable it on a
    // real mainnet run.
    if (this.config.isDevnet && this.market) {
      new NpcSimulator(
        this.connection,
        this.market,
        this.config.isDevnet,
        process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password'
      ).start().catch((error) => logger.debug('NPC simulator failed', error));
    }
  }

  // ============================================================
  // STEP 3: EXECUTE BUNDLED BUYS
  // ============================================================

  // Wallets enter in waves of roughly this size (last wave takes the
  // remainder) instead of one flat sequential pass - each wave buys in
  // quickly (seconds apart), a minority of that wave takes a small profit
  // shortly after (most hold), then there's a longer gap before the next
  // wave. Scales naturally to however many wallets actually exist.
  private static readonly BUY_WAVE_SIZE = 5;

  private async executeBundledBuys(): Promise<void> {
    logger.section('STEP 3: EXECUTING BUNDLED BUYS');
    this.status.phase = 'buying';

    if (!this.tokenMint || !this.market) {
      throw new Error('Token mint / market not set');
    }

    const wallets = shuffleArray(this.walletManager.getWallets());
    const waves = chunkArray(wallets, Bundler.BUY_WAVE_SIZE);
    const FEE_RESERVE_SOL = 0.01; // leave room for tx fees / rent

    logger.info('Executing bundled buys in waves...', {
      wallets: wallets.length,
      waves: waves.length,
      waveSize: Bundler.BUY_WAVE_SIZE,
    });

    let successful = 0;
    let totalSpent = 0;
    let totalTokens = 0;
    let walletsProcessed = 0;

    // The first wave is pure buy pressure - no selling at all, so the opening
    // candles read as unambiguous green momentum with nothing fighting it.
    // From the second wave on, a small minority takes a very small profit
    // shortly after buying - real consolidation dips mixed into the
    // continued climb, not a flat one-directional staircase. The
    // organic-trading price floor (LocalMarket's FLOOR_RATIO, not bypassed
    // here) already caps how deep any of these dips can go, so this can
    // never read as "huge huge red" - just bullish-with-consolidation.
    const walletsBoughtThisWave: Array<{ wallet: WalletInfo; tokenAmount: number }> = [];

    for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
      const wave = waves[waveIndex];
      walletsBoughtThisWave.length = 0;

      for (const wallet of wave) {
        walletsProcessed++;
        // Deploy less than half of what's actually sitting in this wallet -
        // was 70-95%, which front-loaded nearly the ENTIRE session's price
        // movement into this one fast entry phase, leaving each wallet with
        // almost no spare SOL for Step 4 to keep buying with afterward. That
        // produced a huge instant pump followed by flat sideways chop, since
        // organic trading had no real capital left to sustain a continued
        // climb. Holding back most of each wallet's balance here means the
        // initial move is smaller and gentler, and there's real capital left
        // for the rest of the session to keep trending up with - which also
        // matters for a real mainnet launch: dumping most of your own
        // capital in within the first minute leaves no room for outside
        // buyers to get a good entry before it's already pumped.
        const balance = await this.walletManager.getBalance(wallet);
        const affordable = Math.max(0, balance - FEE_RESERVE_SOL);
        const amount = affordable * randomNumber(0.35, 0.55);

        if (amount < 0.001) {
          logger.warn(`Skipping buy for ${shortAddress(wallet.publicKey)}: insufficient balance (${formatSol(balance)})`);
          logger.progress(walletsProcessed, wallets.length, 'Bundled buys');
          continue;
        }

        const result = await this.market.buy(wallet, amount);

        if (result.success) {
          successful++;
          totalSpent += result.solAmount;
          totalTokens += result.tokenAmount;
          walletsBoughtThisWave.push({ wallet, tokenAmount: result.tokenAmount });
        } else {
          logger.warn(`Buy failed for ${shortAddress(wallet.publicKey)}: ${result.error}`);
        }

        logger.progress(walletsProcessed, wallets.length, 'Bundled buys');

        // Report live after every buy - previously this only happened once,
        // after the entire multi-minute wave sequence finished, so the chart
        // and terminal ticker sat frozen on a stale price/multiplier the
        // whole time even though the curve was genuinely moving underneath.
        if (result.success && this.market) {
          this.status.currentPrice = this.market.getPrice();
          this.status.totalVolume = totalSpent;
          const realizableValue = this.market.estimateSellProceeds(totalTokens);
          this.status.currentMultiplier = totalSpent > 0 ? realizableValue / totalSpent : 1;
          this.status.currentProfit = this.status.currentMultiplier - 1;
          this.status.totalInvested = totalSpent;
          this.status.profitSol = realizableValue - totalSpent;
          this.trackPeak();
          if (this.onStatusUpdate) {
            this.onStatusUpdate({ ...this.status });
          }
        }

        // Fractions of a second apart within a wave - real memecoin pumps
        // move in seconds, not minutes (was 1-4s, far too slow for that).
        await sleep(randomNumber(0.2, 0.6) * 1000);
      }

      // From the second wave on, a small minority takes a very small profit
      // shortly after buying - most still hold. This is deliberately smaller
      // (fewer sellers, smaller %) than the old version that caused real
      // dumps right at launch - the goal here is visible consolidation
      // texture, not a real pullback.
      if (waveIndex > 0 && walletsBoughtThisWave.length > 0 && this.market) {
        const sellerCount = Math.max(1, Math.round(walletsBoughtThisWave.length * randomNumber(0.1, 0.2)));
        const sellers = shuffleArray(walletsBoughtThisWave).slice(0, sellerCount);

        for (const { wallet, tokenAmount } of sellers) {
          await sleep(randomNumber(0.3, 1) * 1000);
          const sellAmount = tokenAmount * randomNumber(0.03, 0.08);
          const sellResult = await this.market.sell(wallet, sellAmount);
          if (sellResult.success) {
            totalTokens -= sellResult.tokenAmount;
            totalSpent -= sellResult.solAmount;

            this.status.currentPrice = this.market.getPrice();
            this.status.totalVolume = totalSpent;
            const realizableValue = this.market.estimateSellProceeds(totalTokens);
            this.status.currentMultiplier = totalSpent > 0 ? realizableValue / totalSpent : 1;
            this.status.currentProfit = this.status.currentMultiplier - 1;
            this.status.totalInvested = totalSpent;
            this.status.profitSol = realizableValue - totalSpent;
            if (this.onStatusUpdate) {
              this.onStatusUpdate({ ...this.status });
            }
          }
        }
      }

      // Short gap between waves so the chart still shows distinct
      // buy-pressure clusters, without dragging the whole entry out (was
      // 5-15s per gap - with several waves that alone was over a minute).
      if (waveIndex < waves.length - 1) {
        await sleep(randomNumber(1, 3) * 1000);
      }
    }

    logger.success('Bundled buys complete', {
      successful,
      total: wallets.length,
      waves: waves.length,
      totalSpent: formatSol(totalSpent),
      totalTokens: totalTokens.toLocaleString(),
    });

    this.totalBuyVolume = totalSpent;
    this.status.totalVolume = totalSpent;
    this.status.currentPrice = this.market.getPrice();

    // Real, slippage-aware proceeds from selling everything right now - same
    // calculation ExitStrategy uses once it exists (isn't constructed until
    // Step 5, so this is the same formula computed inline here via the
    // market directly).
    const realizableValue = this.market.estimateSellProceeds(totalTokens);
    this.status.currentMultiplier = totalSpent > 0 ? realizableValue / totalSpent : 1;
    this.status.currentProfit = this.status.currentMultiplier - 1;
    this.status.totalInvested = totalSpent;
    this.status.profitSol = realizableValue - totalSpent;
    this.trackPeak();

    // Emit now so the chart captures the initial buy-in pump, not just
    // whatever the price happens to be once Step 5's monitor loop starts.
    if (this.onStatusUpdate) {
      this.onStatusUpdate({ ...this.status });
    }
  }

  // ============================================================
  // STEP 4: START VOLUME SIMULATION
  // ============================================================

  private async startVolumeSimulation(): Promise<void> {
    logger.section('STEP 4: STARTING VOLUME SIMULATION');
    this.status.phase = 'simulating';

    if (!this.tokenMint || !this.market) {
      throw new Error('Token mint / market not set');
    }

    const wallets = this.walletManager.getWallets();

    // Only override the trade-size floor here - minIntervalSeconds/
    // maxIntervalSeconds/maxConcurrentTrades used to be hardcoded to stale
    // pre-speed-tuning values (2-8s, 5 concurrent) that silently overrode
    // VolumeSimulator's own tuned DEFAULT_VOLUME_CONFIG. Let those inherit
    // the tuned defaults instead of being pinned here.
    this.volumeSimulator = new VolumeSimulator(
      this.connection,
      this.market,
      wallets,
      this.tokenMint,
      this.tokenDecimals,
      {
        minTradeAmount: 0.001,
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

  /**
   * Construct ExitStrategy if it doesn't exist yet. Normally happens once at
   * the start of Step 5, but forceExitNow() (the 'c' hotkey) can fire earlier
   * - e.g. mid-way through bundled buys - and should still be able to sell
   * off whatever's been bought so far rather than throwing.
   */
  private trackPeak(): void {
    this.peakMultiplier = Math.max(this.peakMultiplier, this.status.currentMultiplier);
    this.peakPrice = Math.max(this.peakPrice, this.status.currentPrice);
  }

  private ensureExitStrategy(): void {
    if (this.exitStrategy || !this.tokenMint || !this.market) return;

    const wallets = this.walletManager.getWallets();
    this.exitStrategy = new ExitStrategy(
      this.connection,
      this.market,
      this.tokenMint,
      wallets,
      this.tokenDecimals,
      {
        targetMultiplier: this.config.targetMultiplier,
        maxSlippage: this.config.maxSlippage,
        maxRetries: 3,
        simultaneousSell: true,
      },
      this.totalBuyVolume
    );
  }

  private async monitorAndExit(): Promise<void> {
    logger.section('STEP 5: MONITORING AND EXITING');
    this.status.phase = 'simulating';

    if (!this.tokenMint || !this.market) {
      throw new Error('Token mint / market not set');
    }

    this.ensureExitStrategy();

    let lastPriceUpdate = 0;
    let exitTriggered = false;

    const startTime = Date.now();
    const exitTime = startTime + (this.config.exitTimerHours * 3600 * 1000);

    logger.info('Monitoring started', {
      targetMultiplier: this.config.targetMultiplier,
      exitTime: new Date(exitTime).toLocaleString(),
    });

    while (this.isRunning && !exitTriggered) {
      if (this.forceExitRequested) {
        logger.info('Force exit was already handled - waiting for it to finish');
        exitTriggered = true;
        // forceExitNow() kicked off its own executeExit() on a separate call
        // stack (from the 'c' hotkey handler) - without this await, this
        // loop would break and let execute() race straight into cleanup()
        // while the real sell-off was still in flight, printing a false
        // "stopped without closing positions" summary before the actual
        // results were even in.
        if (this.exitPromise) {
          await this.exitPromise;
        }
        break;
      }

      if (Date.now() - lastPriceUpdate > 6000 && this.exitStrategy) {
        // Real return-on-capital: wallets' current holdings valued at the
        // live price, divided by what was actually spent - NOT a raw price
        // ratio from the curve's artificial starting point. This is the same
        // number ExitStrategy itself uses to decide whether to sell, so the
        // dashboard and the actual exit trigger never disagree.
        const estimate = await this.exitStrategy.getEstimatedExitValue();
        if (estimate.estimatedPrice > 0) {
          this.status.currentPrice = estimate.estimatedPrice;
          this.status.currentMultiplier = estimate.multiplier;
          this.status.currentProfit = estimate.profitPercentage;
          this.status.profitSol = estimate.profit;
          this.status.totalInvested = this.totalBuyVolume;
          this.trackPeak();
        }
        lastPriceUpdate = Date.now();
      }

      if (this.volumeSimulator) {
        const stats = this.volumeSimulator.getStats();
        this.status.totalVolume = this.totalBuyVolume + stats.totalVolume;
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

  // Minimum time the monitor loop must run before the target-multiplier
  // condition alone is allowed to trigger an automatic exit. Without this,
  // organic trading barely gets started before a fast-moving multiplier
  // auto-closes everything, leaving a chart with almost no history. Manual
  // close via the 'c' hotkey always works instantly regardless of this gate.
  private static readonly MIN_AUTO_EXIT_SECONDS = 180;

  // Pump.fun's real, documented bonding-curve constant. This is a virtual
  // seed for price-sensitivity math only - it never needs to physically sit
  // in the vault (a constant-product curve can only ever pay out real SOL
  // up to what was actually deposited via real buys, regardless of how deep
  // the virtual seed is). Seeding with only ~1 SOL of real liquidity (the
  // old behavior) made the curve absurdly shallow, so a few SOL of bundled
  // buys sent price/market cap into wild double-digit swings instead of the
  // gentle, realistic climb a real launch has.
  private static readonly VIRTUAL_SOL_RESERVE = 30;

  private async shouldExit(): Promise<boolean> {
    if (
      this.status.currentMultiplier >= this.config.targetMultiplier &&
      this.status.elapsedTime >= Bundler.MIN_AUTO_EXIT_SECONDS
    ) {
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

    this.ensureExitStrategy();
    if (!this.exitStrategy) {
      logger.warn('Nothing to exit yet - token/market not set up');
      return;
    }

    if (this.volumeSimulator) {
      this.volumeSimulator.pause();
    }

    const result = await this.exitStrategy.executeExit();

    // executeSimultaneousSell can take many seconds (real on-chain sells +
    // RPC retries), and nothing updated this.status while it ran - the
    // ticker/dashboard sat frozen on the pre-sell snapshot the whole time,
    // making it look like the price "never dropped" even though the real
    // sell-off (correctly bypassing the organic-trading floor) did happen.
    // Refresh with the real post-sell numbers now.
    if (this.market) {
      this.status.currentPrice = this.market.getPrice();
    }
    this.status.currentMultiplier = result.multiplierAchieved;
    this.status.currentProfit = result.profitPercentage;
    this.status.profitSol = result.totalProfit;
    if (this.onStatusUpdate) {
      this.onStatusUpdate({ ...this.status });
    }

    // Explicit, undeniable before/after so the crash is visible in the log
    // itself, not just inferred from a ticker line that looks the same as
    // the moment before (nothing else moves price during the sweep phase
    // that follows, so the ticker legitimately holds steady afterward).
    if (this.peakPrice > 0) {
      const dropPct = ((this.peakPrice - this.status.currentPrice) / this.peakPrice) * 100;
      logger.warn(`📉 Price crashed from peak: ${formatPrice(this.peakPrice)} -> ${formatPrice(this.status.currentPrice)} (-${dropPct.toFixed(1)}%)`);
    }

    if (result.success) {
      logger.success('Exit executed successfully', {
        totalSold: formatSol(result.totalSolReceived),
        totalTransactions: result.transactions.length,
        averagePrice: formatPrice(result.averagePrice),
        totalProfit: formatSol(result.totalProfit),
        profitPercentage: (result.profitPercentage * 100).toFixed(1) + '%',
      });

      this.positionsClosed = true;

      // Give the simultaneous sell's RPC burst a moment to clear devnet's
      // rate-limit window before immediately hammering it again with 10 more
      // sequential sweep transactions - back-to-back was compounding the 429
      // storm rather than easing it.
      await sleep(3000);
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

  private async transferFundsToMainWallet(_transactions: any[]): Promise<void> {
    logger.section('SWEEPING FUNDS BACK TO MAIN WALLET');

    const mainWallet = this.walletManager.getMainWallet();
    if (!mainWallet) {
      logger.warn('No main wallet found, skipping sweep');
      return;
    }

    const wallets = this.walletManager.getWallets();
    const RESERVE_SOL = 0.005; // leave a little for rent-exemption/future fees
    let totalSwept = 0;
    let successCount = 0;

    // One batched call instead of N individual getBalance RPC calls -
    // right after a 10-way simultaneous sell already burst devnet's rate
    // limit, this was adding 10 more avoidable calls on top of it.
    const balances = await this.walletManager.getAllBalances();

    for (const walletWithBalance of balances) {
      const wallet = wallets.find(w => w.publicKey === walletWithBalance.publicKey);
      if (!wallet) continue;

      try {
        const amount = walletWithBalance.solBalance - RESERVE_SOL;

        if (amount < 0.001) continue;

        await this.walletManager.sendTransactionWithRetry(wallet, mainWallet, amount);
        totalSwept += amount;
        successCount++;
      } catch (error) {
        logger.warn(`Failed to sweep funds from ${shortAddress(wallet.publicKey)}`, error);
      }

      // Pace sends like redistributeSol.ts does - sweeping right after a
      // 10-way simultaneous sell with zero delay between wallets was hammering
      // devnet's rate limit and causing a wall of 429 retries.
      await sleep(2500);
    }

    logger.success(`Swept ${formatSol(totalSwept)} back to main wallet from ${successCount}/${wallets.length} wallets`);
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

    if (this.onCompleteCallback) {
      this.onCompleteCallback({
        status: this.status,
        config: this.config,
        positionsClosed: this.positionsClosed,
      });
    }

    logger.success('Bundler cleanup complete');
  }

  // ============================================================
  // SUMMARY
  // ============================================================

  private printFinalSummary(): void {
    if (!this.positionsClosed) {
      logger.section('⚠️  STOPPED WITHOUT CLOSING POSITIONS');
      console.log(`  Token:             ${this.status.tokenName} (${this.status.tokenSymbol})`);
      console.log(`  Mint Address:      ${this.status.tokenMint || 'N/A'}`);
      console.log(`  Nothing was sold or swept back - wallets still hold their tokens.`);
      console.log(`  Run again and press [C] (or wait for auto-exit) to actually close positions.`);
      logger.divider('═');
      return;
    }

    logger.section('FINAL SUMMARY');
    console.log(`  Token:             ${this.status.tokenName} (${this.status.tokenSymbol})`);
    console.log(`  Mint Address:      ${this.status.tokenMint || 'N/A'}`);
    console.log(`  Peak Price:        ${formatPrice(this.peakPrice)}`);
    console.log(`  Final Price:       ${formatPrice(this.status.currentPrice)}`);
    console.log(`  Peak Multiplier:   ${this.peakMultiplier.toFixed(2)}x`);
    console.log(`  Final Multiplier:  ${this.status.currentMultiplier.toFixed(2)}x`);
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
    this.onCompleteCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.warn('Stopping bundler...');
    this.isRunning = false;
    await this.cleanup();
  }

  /**
   * Immediately sell every wallet's position, bypassing the target
   * multiplier / exit timer - the "close all positions now" control.
   * Returns whether positions actually ended up closed, so callers (the 'c'
   * hotkey) can report the real outcome instead of assuming success.
   */
  async forceExitNow(): Promise<boolean> {
    if (!this.isRunning) {
      logger.warn('Bundler is not running, nothing to exit');
      return this.positionsClosed;
    }
    if (this.forceExitRequested) {
      logger.warn('Force exit already in progress - waiting for it to finish');
      // A second 'c' press (or any other caller) must wait for the real
      // exit to actually finish, not just return immediately - returning
      // early here let the caller (app.ts's hotkey handler) race ahead into
      // shutdown()/cleanup() while the first exit was still retrying sells,
      // printing a false "stopped without closing positions" a second time.
      if (this.exitPromise) {
        await this.exitPromise;
      }
      return this.positionsClosed;
    }

    this.forceExitRequested = true;
    logger.warn('🔴 MANUAL EXIT TRIGGERED - closing all positions now');
    this.exitPromise = this.executeExit();
    await this.exitPromise;
    return this.positionsClosed;
  }

  pauseVolume(): void {
    this.volumeSimulator?.pause();
  }

  resumeVolume(): void {
    this.volumeSimulator?.resume();
  }
}

export default Bundler;