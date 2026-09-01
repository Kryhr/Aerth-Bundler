/**
 * AERTH BUNDLER - Real pump.fun market (mainnet only)
 *
 * Same public shape as LocalMarket (buy/sell/sellBatch/getPrice/
 * getReserves/estimateSellProceeds/getTokenBalance) so Bundler/
 * VolumeSimulator/ExitStrategy can use either interchangeably - but this
 * one reads real on-chain bonding curve state and sends real buy_v2/sell_v2
 * transactions via pump.fun's official SDK, instead of maintaining its own
 * copy of the numbers.
 *
 * ⚠️ UNVERIFIED AGAINST A LIVE COIN. Built from the SDK's actual shipped
 * type definitions (verified directly against the installed package, not
 * its README - which disagreed with its own types more than once while
 * building this). No real SOL has been available to create a real coin or
 * send a real transaction through this yet. Run a dry run (see
 * testPumpFunCreate.ts's pattern - simulateTransaction, not send) against a
 * real coin before ever trusting this with real capital.
 *
 * Pump.fun coins are Token-2022, 6 decimals, SOL-paired (quoteMint =
 * default/native SOL) - fixed by the protocol, not configurable here.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import {
  PUMP_SDK,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  type Global,
  type FeeConfig,
  type BondingCurve,
} from '@pump-fun/pump-sdk';
import { logger } from '../utils/logger';
import { WalletInfo } from '../config/constants';
import type { TradeResult } from './localMarket';

const TOKEN_DECIMALS = 6;
const QUOTE_DECIMALS = 9; // SOL

export class PumpFunMarket {
  private connection: Connection;
  private onlineSdk: OnlinePumpSdk;
  private tokenMint: PublicKey;

  private cachedGlobal: Global | null = null;
  private cachedFeeConfig: FeeConfig | null = null;

  // No `creator` param needed - buyV2Instructions/sellV2Instructions derive
  // the creator_vault PDA from the live bondingCurve.creator field
  // themselves (we always pass the freshly-fetched bondingCurve object in).
  constructor(connection: Connection, tokenMint: PublicKey) {
    this.connection = connection;
    this.onlineSdk = new OnlinePumpSdk(connection);
    this.tokenMint = tokenMint;
  }

  // ============================================================
  // LIVE STATE
  // ============================================================

  private async getGlobal(): Promise<Global> {
    if (!this.cachedGlobal) {
      this.cachedGlobal = await this.onlineSdk.fetchGlobal();
    }
    return this.cachedGlobal;
  }

  private async getFeeConfig(): Promise<FeeConfig> {
    if (!this.cachedFeeConfig) {
      this.cachedFeeConfig = await this.onlineSdk.fetchFeeConfig();
    }
    return this.cachedFeeConfig;
  }

  private async fetchCurrentBondingCurve(): Promise<BondingCurve> {
    return this.onlineSdk.fetchBondingCurve(this.tokenMint);
  }

  /**
   * Real current price, read live from the chain - not maintained locally.
   */
  async getPrice(): Promise<number> {
    const curve = await this.fetchCurrentBondingCurve();
    const sol = curve.virtualQuoteReserves.toNumber() / Math.pow(10, QUOTE_DECIMALS);
    const tokens = curve.virtualTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS);
    return tokens > 0 ? sol / tokens : 0;
  }

  async getReserves(): Promise<{ sol: number; tokens: number }> {
    const curve = await this.fetchCurrentBondingCurve();
    return {
      sol: curve.virtualQuoteReserves.toNumber() / Math.pow(10, QUOTE_DECIMALS),
      tokens: curve.virtualTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS),
    };
  }

  /**
   * Real, slippage-aware proceeds from selling this many tokens right now -
   * uses pump.fun's OWN math (getSellSolAmountFromTokenAmount), not a
   * reimplementation of their curve formula.
   */
  async estimateSellProceeds(tokenAmount: number): Promise<number> {
    if (tokenAmount <= 0) return 0;
    const [global, feeConfig, curve] = await Promise.all([
      this.getGlobal(),
      this.getFeeConfig(),
      this.fetchCurrentBondingCurve(),
    ]);
    const rawAmount = new BN(Math.floor(tokenAmount * Math.pow(10, TOKEN_DECIMALS)));
    const solOut = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: rawAmount,
    });
    return solOut.toNumber() / Math.pow(10, QUOTE_DECIMALS);
  }

  /**
   * Mainnet-only concept: real liquidity depth vs. our own position size,
   * so a mass exit can be judged BEFORE it happens instead of finding out
   * mid-sell that the curve couldn't actually absorb it. "Real" here means
   * pump.fun's own real (non-virtual) reserves - the actual SOL/tokens that
   * have moved through real trades, as opposed to the protocol's fixed
   * virtual seed. Devnet's LocalMarket has no such split (there's no
   * outside trading to separate from), which is exactly why this only
   * makes sense here.
   *
   * `ourTokenHoldings` should be the sum of every bundled wallet's current
   * real token balance (call getTokenBalance for each and add them up).
   */
  async getLiquiditySnapshot(ourTokenHoldings: number): Promise<{
    realSolLiquidity: number;
    realTokenLiquidity: number;
    ourTokenHoldings: number;
    ourShareOfRealSupply: number;
    ourFullExitValue: number;
    fullyExitable: boolean;
  }> {
    const [global, feeConfig, curve] = await Promise.all([
      this.getGlobal(),
      this.getFeeConfig(),
      this.fetchCurrentBondingCurve(),
    ]);

    const realSolLiquidity = curve.realQuoteReserves.toNumber() / Math.pow(10, QUOTE_DECIMALS);
    const realTokenLiquidity = curve.realTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS);

    const rawHoldings = new BN(Math.floor(ourTokenHoldings * Math.pow(10, TOKEN_DECIMALS)));
    const ourFullExitValue = ourTokenHoldings > 0
      ? getSellSolAmountFromTokenAmount({
          global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: rawHoldings,
        }).toNumber() / Math.pow(10, QUOTE_DECIMALS)
      : 0;

    // Real proceeds can never exceed real reserves - that's the AMM
    // guarantee. "Comfortably exitable" means dumping our whole position
    // wouldn't itself consume most of the real liquidity that's there -
    // i.e. there's real headroom from actual outside trading, not just
    // enough to barely scrape out what the math allows.
    const fullyExitable = realSolLiquidity > 0 && (ourFullExitValue / realSolLiquidity) < 0.5;

    return {
      realSolLiquidity,
      realTokenLiquidity,
      ourTokenHoldings,
      ourShareOfRealSupply: realTokenLiquidity > 0 ? ourTokenHoldings / (realTokenLiquidity + ourTokenHoldings) : 0,
      ourFullExitValue,
      fullyExitable,
    };
  }

  async getTokenBalance(wallet: WalletInfo): Promise<number> {
    try {
      const ata = await getAssociatedTokenAddress(this.tokenMint, new PublicKey(wallet.publicKey), false, TOKEN_2022_PROGRAM_ID);
      const account = await getAccount(this.connection, ata, undefined, TOKEN_2022_PROGRAM_ID);
      return Number(account.amount) / Math.pow(10, TOKEN_DECIMALS);
    } catch {
      return 0;
    }
  }

  // ============================================================
  // TRADES
  // ============================================================

  async buy(buyer: WalletInfo, solAmount: number): Promise<TradeResult> {
    if (solAmount <= 0) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: await this.getPrice(), error: 'invalid amount' };
    }

    try {
      const buyerKeypair = Keypair.fromSecretKey(Buffer.from(buyer.privateKey, 'base64'));
      const [global, feeConfig] = await Promise.all([this.getGlobal(), this.getFeeConfig()]);
      const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
        await this.onlineSdk.fetchBuyState(this.tokenMint, buyerKeypair.publicKey, TOKEN_2022_PROGRAM_ID);

      const quoteAmount = new BN(Math.round(solAmount * Math.pow(10, QUOTE_DECIMALS)));
      const amount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: quoteAmount,
        quoteMint: bondingCurve.quoteMint,
      });

      const ixs = await PUMP_SDK.buyV2Instructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint: this.tokenMint,
        user: buyerKeypair.publicKey,
        amount,
        quoteAmount,
        slippage: 1, // 1% - real slippage protection enforced on-chain, unlike LocalMarket's fake curve
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });

      const tx = new Transaction().add(...ixs);
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = buyerKeypair.publicKey;

      const signature = await sendAndConfirmTransaction(this.connection, tx, [buyerKeypair], { commitment: 'confirmed' });

      const tokenAmount = amount.toNumber() / Math.pow(10, TOKEN_DECIMALS);
      const newPrice = await this.getPrice();

      return { success: true, solAmount, tokenAmount, price: newPrice, signature };
    } catch (error) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: await this.getPrice(), error: (error as Error).message };
    }
  }

  async sell(seller: WalletInfo, tokenAmount: number, _ignoreFloor: boolean = false): Promise<TradeResult> {
    // No local price floor here - the real curve's own slippage protection
    // (the `slippage` param below) is what guards a real sell, not an
    // in-memory floor like LocalMarket's organic-trading protection. Real
    // "never trade down" behavior on mainnet would need to be enforced by
    // choosing NOT to submit a sell in the first place based on live price
    // history, not by clamping amount post-hoc against fake reserves.
    if (tokenAmount <= 0) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: await this.getPrice(), error: 'invalid amount' };
    }

    try {
      const sellerKeypair = Keypair.fromSecretKey(Buffer.from(seller.privateKey, 'base64'));
      const [global, feeConfig] = await Promise.all([this.getGlobal(), this.getFeeConfig()]);
      const { bondingCurveAccountInfo, bondingCurve } =
        await this.onlineSdk.fetchSellState(this.tokenMint, sellerKeypair.publicKey, TOKEN_2022_PROGRAM_ID);

      const rawAmount = new BN(Math.floor(tokenAmount * Math.pow(10, TOKEN_DECIMALS)));
      const quoteAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: rawAmount,
      });

      const ixs = await PUMP_SDK.sellV2Instructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        mint: this.tokenMint,
        user: sellerKeypair.publicKey,
        amount: rawAmount,
        quoteAmount,
        slippage: 1,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });

      const tx = new Transaction().add(...ixs);
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = sellerKeypair.publicKey;

      const signature = await sendAndConfirmTransaction(this.connection, tx, [sellerKeypair], { commitment: 'confirmed' });

      const solOut = quoteAmount.toNumber() / Math.pow(10, QUOTE_DECIMALS);
      const newPrice = await this.getPrice();

      return { success: true, solAmount: solOut, tokenAmount, price: newPrice, signature };
    } catch (error) {
      return { success: false, solAmount: 0, tokenAmount: 0, price: await this.getPrice(), error: (error as Error).message };
    }
  }

  /**
   * Real sell-off for "close all positions." Unlike LocalMarket's
   * sellBatch, there's no local reserve state to pre-compute against - the
   * real bonding curve on-chain IS the sequencing, and each real
   * transaction's own slippage bound is what protects it. Fires in small
   * concurrent groups (not all at once) for the same reason LocalMarket's
   * batch does - real transactions still mean real RPC load per send +
   * confirmation poll.
   */
  async sellBatch(
    sells: Array<{ seller: WalletInfo; tokenAmount: number }>,
    ignoreFloor: boolean = false
  ): Promise<TradeResult[]> {
    const GROUP_SIZE = 4;
    const results: TradeResult[] = [];
    for (let i = 0; i < sells.length; i += GROUP_SIZE) {
      const group = sells.slice(i, i + GROUP_SIZE);
      const groupResults = await Promise.all(
        group.map(({ seller, tokenAmount }) => this.sell(seller, tokenAmount, ignoreFloor))
      );
      results.push(...groupResults);
      if (i + GROUP_SIZE < sells.length) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    return results;
  }

  async transfer(from: WalletInfo, to: WalletInfo, tokenAmount: number): Promise<TradeResult> {
    // Not yet implemented for the real market - VolumeSimulator's organic
    // "transfer" trade type has no equivalent need here yet (it's cosmetic
    // wallet-to-wallet movement for devnet rehearsal texture). Skips safely
    // rather than pretending to succeed.
    logger.debug('PumpFunMarket.transfer: not implemented, skipping', {
      from: from.publicKey, to: to.publicKey, tokenAmount,
    });
    return { success: false, solAmount: 0, tokenAmount: 0, price: await this.getPrice(), error: 'transfer not implemented for real market' };
  }
}

export default PumpFunMarket;
