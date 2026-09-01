/**
 * AERTH BUNDLER - Local Bonding Curve Market
 *
 * Devnet has no DEX aggregator (Jupiter/Raydium only index real mainnet
 * liquidity), so there is no way to get a real price or execute a real swap
 * for a token that only exists on devnet. This module replaces that
 * dependency with our own constant-product bonding curve so buys/sells are
 * still REAL on-chain transfers (real SOL, real SPL tokens, real wallets),
 * just priced by our own reserve math instead of an external aggregator.
 *
 * The token's creator wallet (the "vault") already holds the entire minted
 * supply and the SOL earmarked as initial liquidity after TokenFactory runs,
 * so no extra seeding transfer is needed - the curve's starting reserves are
 * exactly what's already sitting in that wallet.
 *
 * This is intentionally network-agnostic: it's plain @solana/web3.js and
 * @solana/spl-token calls, so the same code runs unchanged against devnet or
 * mainnet. (Actually launching on pump.fun itself with real SOL is a
 * separate, not-yet-built integration with pump.fun's real on-chain program.)
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { logger } from '../utils/logger';
import { retry, shortAddress } from '../utils/helpers';
import { WalletInfo } from '../config/constants';

// ============================================================
// TYPES
// ============================================================

export interface TradeResult {
  success: boolean;
  solAmount: number;
  tokenAmount: number;
  price: number;
  signature?: string;
  error?: string;
}

// `retry()` only retries on rejection - if the wrapped call hangs instead of
// resolving/rejecting (seen in practice with devnet's confirmation subscription
// getting rate-limited), it never returns. Since buy/sell/transfer are
// serialized through one shared queue, a single hung call would otherwise
// wedge every trade queued behind it forever with no error logged anywhere.
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

// ============================================================
// LOCAL BONDING CURVE MARKET
// ============================================================

export class LocalMarket {
  private connection: Connection;
  private tokenMint: PublicKey;
  private tokenDecimals: number;
  private vault: WalletInfo;
  private vaultKeypair: Keypair;
  private vaultAta: PublicKey | null = null;

  private solReserve: number;
  private tokenReserve: number;

  // Buys/sells mutate shared reserve state and can be fired concurrently
  // (e.g. ExitStrategy sells all wallets at once via Promise.all), so they're
  // serialized through this queue to keep the curve math consistent - each
  // trade still lands as its own real, independent on-chain transaction.
  private queue: Promise<unknown> = Promise.resolve();

  // A blockhash stays valid for ~60-90 seconds, but many trades land within
  // that window during volume simulation - fetching a fresh one for every
  // single trade was a real contributor to 429 rate-limiting. Cache and
  // reuse for up to 30s (comfortably inside the real validity window).
  private cachedBlockhash: { blockhash: string; fetchedAt: number } | null = null;
  private static readonly BLOCKHASH_CACHE_MS = 30000;

  // Highest price ever reached. Sells can only pull price down to
  // FLOOR_RATIO below this - never below where the curve has already been.
  // This is what makes "never trade down, ever" actually true overall while
  // still allowing real, visible red candles within that band, instead of
  // organic sells being able to drag price below its own prior lows.
  private priceHighWaterMark: number;
  // Was 0.96 (max ~4% pullback) - too thin: once price sat right at its
  // peak with no fresh highs, sells had almost no room and got clamped to
  // near-zero, contributing to long stretches with no visible trades at all.
  private static readonly FLOOR_RATIO = 0.92; // max ~8% pullback from the peak

  constructor(
    connection: Connection,
    tokenMint: PublicKey,
    tokenDecimals: number,
    vault: WalletInfo,
    initialSolReserve: number,
    initialTokenReserve: number
  ) {
    this.connection = connection;
    this.tokenMint = tokenMint;
    this.tokenDecimals = tokenDecimals;
    this.vault = vault;
    this.vaultKeypair = Keypair.fromSecretKey(Buffer.from(vault.privateKey, 'base64'));
    this.solReserve = initialSolReserve;
    this.tokenReserve = initialTokenReserve;
    this.priceHighWaterMark = this.getPrice();

    logger.info('LocalMarket (bonding curve) initialized', {
      vault: shortAddress(vault.publicKey),
      solReserve: initialSolReserve,
      tokenReserve: initialTokenReserve,
      startPrice: this.getPrice(),
    });
  }

  // ============================================================
  // PRICING
  // ============================================================

  getPrice(): number {
    return this.tokenReserve > 0 ? this.solReserve / this.tokenReserve : 0;
  }

  /**
   * How much SOL a sell of this size would actually yield right now,
   * accounting for the curve's own slippage - NOT `tokenAmount * getPrice()`.
   * Valuing a large position at the current spot price silently assumes it
   * could be sold with zero price impact, which is never true for a real
   * constant-product curve. This can never exceed the real solReserve, since
   * that's a hard cap on how much SOL the curve has ever actually received.
   */
  estimateSellProceeds(tokenAmount: number): number {
    if (tokenAmount <= 0) return 0;
    const k = this.solReserve * this.tokenReserve;
    const newSolReserve = k / (this.tokenReserve + tokenAmount);
    return Math.max(0, this.solReserve - newSolReserve);
  }

  getReserves(): { sol: number; tokens: number } {
    return { sol: this.solReserve, tokens: this.tokenReserve };
  }

  // ============================================================
  // BALANCES
  // ============================================================

  async getTokenBalance(wallet: WalletInfo): Promise<number> {
    try {
      const ata = await getAssociatedTokenAddress(this.tokenMint, new PublicKey(wallet.publicKey));
      const account = await withTimeout(getAccount(this.connection, ata), 10000, 'getTokenBalance timed out');
      return Number(account.amount) / Math.pow(10, this.tokenDecimals);
    } catch {
      return 0;
    }
  }

  // ============================================================
  // TRADES
  // ============================================================

  /**
   * Buy tokens from the curve with real SOL (buyer -> vault),
   * curve pays out real tokens (vault -> buyer).
   */
  buy(buyer: WalletInfo, solAmount: number): Promise<TradeResult> {
    return this.enqueue(() => this.buyImpl(buyer, solAmount));
  }

  private async buyImpl(buyer: WalletInfo, solAmount: number): Promise<TradeResult> {
    if (solAmount <= 0) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: 'invalid amount' };
    }

    const k = this.solReserve * this.tokenReserve;
    const newSolReserve = this.solReserve + solAmount;
    const newTokenReserve = k / newSolReserve;
    const tokensOut = this.tokenReserve - newTokenReserve;

    if (!(tokensOut > 0) || tokensOut >= this.tokenReserve) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: 'insufficient curve liquidity' };
    }

    try {
      const buyerKeypair = Keypair.fromSecretKey(Buffer.from(buyer.privateKey, 'base64'));
      const buyerAta = await getAssociatedTokenAddress(this.tokenMint, buyerKeypair.publicKey);
      const vaultAta = await this.getVaultAta();

      const tx = new Transaction();

      const buyerAtaInfo = await withTimeout(this.connection.getAccountInfo(buyerAta), 10000, 'getAccountInfo timed out');
      if (!buyerAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          buyerKeypair.publicKey, buyerAta, buyerKeypair.publicKey, this.tokenMint, TOKEN_PROGRAM_ID
        ));
      }

      tx.add(SystemProgram.transfer({
        fromPubkey: buyerKeypair.publicKey,
        toPubkey: this.vaultKeypair.publicKey,
        lamports: Math.round(solAmount * 1e9),
      }));

      const rawTokensOut = BigInt(Math.floor(tokensOut * Math.pow(10, this.tokenDecimals)));
      tx.add(createTransferInstruction(
        vaultAta, buyerAta, this.vaultKeypair.publicKey, rawTokensOut, [], TOKEN_PROGRAM_ID
      ));

      tx.feePayer = buyerKeypair.publicKey;

      // Fetch (or reuse the cache) fresh on every retry attempt, not once
      // before the retry loop - a blockhash baked in once can go stale by the
      // time a later retry actually fires (each retry waits 1500ms+), and
      // resending the SAME stale blockhash just fails again with the same
      // "block height exceeded" error. This was the actual "block cache"
      // failure being reported alongside the 429 storm.
      const signature = await withTimeout(
        retry(
          async () => {
            tx.recentBlockhash = await this.getRecentBlockhash();
            return sendAndConfirmTransaction(this.connection, tx, [buyerKeypair, this.vaultKeypair], { commitment: 'confirmed' });
          },
          3,
          1500
        ),
        20000,
        'confirmation timed out'
      );

      this.solReserve = newSolReserve;
      this.tokenReserve = newTokenReserve;
      this.priceHighWaterMark = Math.max(this.priceHighWaterMark, this.getPrice());

      return { success: true, solAmount, tokenAmount: tokensOut, price: this.getPrice(), signature };

    } catch (error) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: (error as Error).message };
    }
  }

  /**
   * Sell tokens back to the curve for real SOL (seller -> vault),
   * curve pays out real SOL (vault -> seller).
   */
  // `ignoreFloor` is for the deliberate, real exit sell-off only (ExitStrategy)
  // - the whole point of pressing "close all" is to actually dump back down to
  // wherever the real capital supports, which is exactly what the floor
  // exists to prevent during ordinary organic trading. Applying the floor to
  // the exit itself made "close all positions" partially unable to sell at
  // all.
  // `floorRatio` lets a caller use a wider (or narrower) band than the
  // default FLOOR_RATIO for this specific sell - e.g. volume simulator
  // consolidation windows want real, visible range to trade within, not
  // the same tight band normal buy-dominant trading uses right after a
  // fresh peak.
  sell(seller: WalletInfo, tokenAmount: number, ignoreFloor: boolean = false, floorRatio?: number): Promise<TradeResult> {
    return this.enqueue(() => this.sellImpl(seller, tokenAmount, ignoreFloor, floorRatio));
  }

  private async sellImpl(
    seller: WalletInfo,
    tokenAmount: number,
    ignoreFloor: boolean = false,
    floorRatio: number = LocalMarket.FLOOR_RATIO
  ): Promise<TradeResult> {
    if (tokenAmount <= 0) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: 'invalid amount' };
    }

    const k = this.solReserve * this.tokenReserve;

    if (!ignoreFloor) {
      // Never let an organic sell push price below floorRatio of the
      // all-time high - clamp the amount actually sold down to whatever
      // keeps price at the floor. Solved directly from the curve invariant:
      // at the floor, newSolReserve/newTokenReserve = floor and
      // newSolReserve = k/newTokenReserve, so newTokenReserve = sqrt(k / floor).
      const floor = this.priceHighWaterMark * floorRatio;
      const maxTokenReserveAtFloor = Math.sqrt(k / floor);
      const maxSellTokenAmount = Math.max(0, maxTokenReserveAtFloor - this.tokenReserve);
      tokenAmount = Math.min(tokenAmount, maxSellTokenAmount);

      if (tokenAmount <= 0) {
        return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: 'price floor reached, sell blocked' };
      }
    }

    const newTokenReserve = this.tokenReserve + tokenAmount;
    const newSolReserve = k / newTokenReserve;
    const solOut = this.solReserve - newSolReserve;

    if (!(solOut > 0) || solOut >= this.solReserve) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: 'insufficient curve liquidity' };
    }

    try {
      const sellerKeypair = Keypair.fromSecretKey(Buffer.from(seller.privateKey, 'base64'));
      const sellerAta = await getAssociatedTokenAddress(this.tokenMint, sellerKeypair.publicKey);
      const vaultAta = await this.getVaultAta();

      const tx = new Transaction();

      const rawTokenAmount = BigInt(Math.floor(tokenAmount * Math.pow(10, this.tokenDecimals)));
      tx.add(createTransferInstruction(
        sellerAta, vaultAta, sellerKeypair.publicKey, rawTokenAmount, [], TOKEN_PROGRAM_ID
      ));

      tx.add(SystemProgram.transfer({
        fromPubkey: this.vaultKeypair.publicKey,
        toPubkey: sellerKeypair.publicKey,
        lamports: Math.round(solOut * 1e9),
      }));

      tx.feePayer = sellerKeypair.publicKey;

      const signature = await withTimeout(
        retry(
          async () => {
            tx.recentBlockhash = await this.getRecentBlockhash();
            return sendAndConfirmTransaction(this.connection, tx, [sellerKeypair, this.vaultKeypair], { commitment: 'confirmed' });
          },
          3,
          1500
        ),
        20000,
        'confirmation timed out'
      );

      this.solReserve = newSolReserve;
      this.tokenReserve = newTokenReserve;

      return { success: true, solAmount: solOut, tokenAmount, price: this.getPrice(), signature };

    } catch (error) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: (error as Error).message };
    }
  }

  /**
   * Sell MANY wallets' positions at once - the real "close all positions"
   * mass exit. Ordinary sell() intentionally serializes through the queue so
   * each trade's price impact reflects a real, already-confirmed prior trade
   * - correct for organic trading, but it means N sequential full on-chain
   * confirmations (each a real network round trip) before the Nth wallet's
   * sell even starts, stacking into 20-30+ seconds for 10 wallets. Since
   * this bonding curve is a purely local, off-chain simulation (not a real
   * on-chain program), there's no actual need to wait for one sell's
   * confirmation before deciding the next one's price impact - the whole
   * batch's cascading outcome can be decided instantly, in-memory, then
   * every wallet's real on-chain transaction fires at once. Total wall-clock
   * time becomes bounded by the slowest single confirmation, not the sum of
   * all of them.
   */
  sellBatch(
    sells: Array<{ seller: WalletInfo; tokenAmount: number }>,
    ignoreFloor: boolean = false
  ): Promise<TradeResult[]> {
    return this.enqueue(() => this.sellBatchImpl(sells, ignoreFloor));
  }

  private async sellBatchImpl(
    sells: Array<{ seller: WalletInfo; tokenAmount: number }>,
    ignoreFloor: boolean
  ): Promise<TradeResult[]> {
    // Phase 1: decide the ENTIRE batch's cascading price impact up front,
    // synchronously, with zero network I/O - this is what makes it "all at
    // once" instead of one-confirmation-at-a-time.
    type Plan = { seller: WalletInfo; tokenAmount: number; solOut: number } | null;
    const plan: Plan[] = [];

    for (const { seller, tokenAmount: requested } of sells) {
      if (requested <= 0) { plan.push(null); continue; }

      const k = this.solReserve * this.tokenReserve;
      let tokenAmount = requested;

      if (!ignoreFloor) {
        const floor = this.priceHighWaterMark * LocalMarket.FLOOR_RATIO;
        const maxTokenReserveAtFloor = Math.sqrt(k / floor);
        const maxSellTokenAmount = Math.max(0, maxTokenReserveAtFloor - this.tokenReserve);
        tokenAmount = Math.min(tokenAmount, maxSellTokenAmount);
      }
      if (tokenAmount <= 0) { plan.push(null); continue; }

      const newTokenReserve = this.tokenReserve + tokenAmount;
      const newSolReserve = k / newTokenReserve;
      const solOut = this.solReserve - newSolReserve;

      if (!(solOut > 0) || solOut >= this.solReserve) { plan.push(null); continue; }

      // Commit immediately - this IS the cascading price impact of selling
      // in this order, just computed up front instead of interleaved with
      // network waits.
      this.solReserve = newSolReserve;
      this.tokenReserve = newTokenReserve;
      plan.push({ seller, tokenAmount, solOut });
    }

    const vaultAta = await this.getVaultAta();
    const priceAfterBatch = this.getPrice();

    const sendOne = async (item: Plan): Promise<TradeResult> => {
      if (!item) {
        return { success: false, solAmount: 0, tokenAmount: 0, price: priceAfterBatch, error: 'skipped (floor or insufficient liquidity)' };
      }
      const { seller, tokenAmount, solOut } = item;

      try {
        const sellerKeypair = Keypair.fromSecretKey(Buffer.from(seller.privateKey, 'base64'));
        const sellerAta = await getAssociatedTokenAddress(this.tokenMint, sellerKeypair.publicKey);

        const tx = new Transaction();
        const rawTokenAmount = BigInt(Math.floor(tokenAmount * Math.pow(10, this.tokenDecimals)));
        tx.add(createTransferInstruction(
          sellerAta, vaultAta, sellerKeypair.publicKey, rawTokenAmount, [], TOKEN_PROGRAM_ID
        ));
        tx.add(SystemProgram.transfer({
          fromPubkey: this.vaultKeypair.publicKey,
          toPubkey: sellerKeypair.publicKey,
          lamports: Math.round(solOut * 1e9),
        }));
        tx.feePayer = sellerKeypair.publicKey;

        const signature = await withTimeout(
          retry(
            async () => {
              tx.recentBlockhash = await this.getRecentBlockhash();
              return sendAndConfirmTransaction(this.connection, tx, [sellerKeypair, this.vaultKeypair], { commitment: 'confirmed' });
            },
            3,
            1500
          ),
          20000,
          'confirmation timed out'
        );

        return { success: true, solAmount: solOut, tokenAmount, price: priceAfterBatch, signature };
      } catch (error) {
        return { success: false, solAmount: 0, tokenAmount: 0, price: priceAfterBatch, error: (error as Error).message };
      }
    };

    // Phase 2: fire on-chain transactions in small concurrent groups rather
    // than all 10 at the exact same instant. Each sell fully confirming
    // involves several RPC calls (send + repeated confirmation polling), so
    // 10 truly simultaneous sends can spike well past even a dedicated
    // provider's free-tier rate limit in the first second - which was
    // actually making the exit SLOWER (429 backoff) than a controlled
    // burst would be. The price impact was already decided as one instant,
    // atomic batch above; this only paces the real network sends, and is
    // still far faster than the old fully-sequential version.
    const GROUP_SIZE = 4;
    const results: TradeResult[] = [];
    for (let i = 0; i < plan.length; i += GROUP_SIZE) {
      const group = plan.slice(i, i + GROUP_SIZE);
      const groupResults = await Promise.all(group.map(sendOne));
      results.push(...groupResults);
      if (i + GROUP_SIZE < plan.length) {
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    return results;
  }

  /**
   * Plain wallet-to-wallet token transfer - no curve/price impact,
   * used for the "organic transfer" trade pattern.
   */
  async transfer(from: WalletInfo, to: WalletInfo, tokenAmount: number): Promise<TradeResult> {
    if (tokenAmount <= 0) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: 'invalid amount' };
    }

    try {
      const fromKeypair = Keypair.fromSecretKey(Buffer.from(from.privateKey, 'base64'));
      const toPublicKey = new PublicKey(to.publicKey);

      const fromAta = await getAssociatedTokenAddress(this.tokenMint, fromKeypair.publicKey);
      const toAta = await getAssociatedTokenAddress(this.tokenMint, toPublicKey);

      const tx = new Transaction();

      const toAtaInfo = await withTimeout(this.connection.getAccountInfo(toAta), 10000, 'getAccountInfo timed out');
      if (!toAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          fromKeypair.publicKey, toAta, toPublicKey, this.tokenMint, TOKEN_PROGRAM_ID
        ));
      }

      const rawAmount = BigInt(Math.floor(tokenAmount * Math.pow(10, this.tokenDecimals)));
      tx.add(createTransferInstruction(fromAta, toAta, fromKeypair.publicKey, rawAmount, [], TOKEN_PROGRAM_ID));

      tx.feePayer = fromKeypair.publicKey;

      const signature = await withTimeout(
        retry(
          async () => {
            tx.recentBlockhash = await this.getRecentBlockhash();
            return sendAndConfirmTransaction(this.connection, tx, [fromKeypair], { commitment: 'confirmed' });
          },
          3,
          1500
        ),
        20000,
        'confirmation timed out'
      );

      return { success: true, solAmount: 0, tokenAmount, price: this.getPrice(), signature };

    } catch (error) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: this.getPrice(), error: (error as Error).message };
    }
  }

  // ============================================================
  // INTERNAL
  // ============================================================

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    // Swallow errors in the chain itself so one failed trade doesn't wedge the queue
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async getRecentBlockhash(): Promise<string> {
    const now = Date.now();
    if (this.cachedBlockhash && now - this.cachedBlockhash.fetchedAt < LocalMarket.BLOCKHASH_CACHE_MS) {
      return this.cachedBlockhash.blockhash;
    }
    const { blockhash } = await withTimeout(this.connection.getLatestBlockhash('confirmed'), 10000, 'getLatestBlockhash timed out');
    this.cachedBlockhash = { blockhash, fetchedAt: now };
    return blockhash;
  }

  private async getVaultAta(): Promise<PublicKey> {
    if (!this.vaultAta) {
      this.vaultAta = await getAssociatedTokenAddress(this.tokenMint, this.vaultKeypair.publicKey);
    }
    return this.vaultAta;
  }
}

export default LocalMarket;
