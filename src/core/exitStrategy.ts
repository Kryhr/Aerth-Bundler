/**
 * AERTH BUNDLER - Exit Strategy
 * Coordinates the sell-off of tokens across all wallets
 * Modified: ALL WALLETS SELL SIMULTANEOUSLY at target multiplier
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';

import { logger } from '../utils/logger';
import {
  sleep,
  retry,
  shortAddress,
  formatSol,
  formatPrice,
  clamp,
  shuffleArray,
  chunkArray,
} from '../utils/helpers';
import { WalletInfo } from '../config/constants';
import JupiterIntegration from '../integrations/jupiter';

// ============================================================
// TYPES
// ============================================================

interface ExitConfig {
  targetMultiplier: number; // 2.0 to 5.0
  maxSlippage: number;
  maxRetries: number;
  useJupiter: boolean;
  simultaneousSell: boolean; // ALWAYS TRUE
  minProfitThreshold: number; // Minimum profit % to trigger
  maxPriceImpact: number; // Max % price impact allowed
  fallbackToLimitOrders: boolean;
}

interface ExitResult {
  success: boolean;
  transactions: ExitTransaction[];
  totalSolReceived: number;
  totalTokensSold: number;
  averagePrice: number;
  totalProfit: number;
  profitPercentage: number;
  multiplierAchieved: number;
  error?: string;
  timestamp: number;
}

interface ExitTransaction {
  wallet: string;
  tokenAmount: number;
  solReceived: number;
  price: number;
  signature?: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

interface TokenBalance {
  wallet: WalletInfo;
  balance: number; // In token units
  usdValue: number;
}

// ============================================================
// DEFAULT CONFIG
// ============================================================

const DEFAULT_EXIT_CONFIG: ExitConfig = {
  targetMultiplier: 5.0, // Default to 5x
  maxSlippage: 50,
  maxRetries: 3,
  useJupiter: true,
  simultaneousSell: true, // ALL WALLETS AT ONCE
  minProfitThreshold: 2.0, // Minimum 2x before considering exit
  maxPriceImpact: 30, // Max 30% price impact
  fallbackToLimitOrders: false,
};

// ============================================================
// MAIN EXIT STRATEGY CLASS
// ============================================================

export class ExitStrategy {
  private connection: Connection;
  private jupiter: JupiterIntegration;
  private tokenMint: PublicKey;
  private wallets: WalletInfo[];
  private tokenDecimals: number;
  private config: ExitConfig;
  
  private isExecuting: boolean = false;
  private tokenBalances: TokenBalance[] = [];
  private currentPrice: number = 0;
  private startPrice: number = 0;
  private exitResults: ExitTransaction[] = [];
  private initialInvestment: number = 0;

  constructor(
    connection: Connection,
    jupiter: JupiterIntegration,
    tokenMint: PublicKey,
    wallets: WalletInfo[],
    tokenDecimals: number = 9,
    config: Partial<ExitConfig> = {}
  ) {
    this.connection = connection;
    this.jupiter = jupiter;
    this.tokenMint = tokenMint;
    this.wallets = wallets;
    this.tokenDecimals = tokenDecimals;
    this.config = { ...DEFAULT_EXIT_CONFIG, ...config };

    // Calculate initial investment (estimated from wallet funding)
    this.initialInvestment = wallets.length * 0.1; // 0.1 SOL average per wallet

    logger.info('ExitStrategy initialized - SIMULTANEOUS SELL MODE', {
      wallets: wallets.length,
      tokenMint: shortAddress(tokenMint.toBase58()),
      targetMultiplier: this.config.targetMultiplier,
      minProfitThreshold: this.config.minProfitThreshold,
      initialInvestment: formatSol(this.initialInvestment),
    });
  }

  // ============================================================
  // MAIN EXIT EXECUTION - SIMULTANEOUS SELL
  // ============================================================

  /**
   * Execute the exit strategy - ALL WALLETS AT ONCE
   */
  async executeExit(): Promise<ExitResult> {
    if (this.isExecuting) {
      logger.warn('Exit already in progress');
      return {
        success: false,
        transactions: [],
        totalSolReceived: 0,
        totalTokensSold: 0,
        averagePrice: 0,
        totalProfit: 0,
        profitPercentage: 0,
        multiplierAchieved: 0,
        error: 'Exit already in progress',
        timestamp: Date.now(),
      };
    }

    this.isExecuting = true;
    this.exitResults = [];

    logger.section('🚀 EXECUTING SIMULTANEOUS EXIT');
    logger.info(`Selling ALL ${this.wallets.length} wallets AT THE SAME TIME`);

    const startTime = Date.now();

    try {
      // Step 1: Get current price and balances
      await this.updatePrice();
      await this.getTokenBalances();

      // Step 2: Validate we have tokens to sell
      const totalTokens = this.tokenBalances.reduce((sum, tb) => sum + tb.balance, 0);
      if (totalTokens <= 0) {
        throw new Error('No tokens to sell');
      }

      // Step 3: Calculate expected returns
      const estimatedValue = totalTokens * this.currentPrice;
      const currentMultiplier = this.initialInvestment > 0 ? estimatedValue / this.initialInvestment : 1;

      logger.info('Exit preparation complete', {
        totalTokens: totalTokens.toLocaleString(),
        currentPrice: formatPrice(this.currentPrice),
        estimatedValue: formatSol(estimatedValue),
        currentMultiplier: currentMultiplier.toFixed(2) + 'x',
        targetMultiplier: this.config.targetMultiplier + 'x',
      });

      // Step 4: Check if we've reached target
      if (currentMultiplier < this.config.minProfitThreshold) {
        logger.warn('Minimum profit threshold not reached', {
          current: currentMultiplier.toFixed(2) + 'x',
          minRequired: this.config.minProfitThreshold + 'x',
        });
        // Continue anyway if target multiplier is higher
      }

      // Step 5: Execute SIMULTANEOUS sell across ALL wallets
      const transactions = await this.executeSimultaneousSell();

      // Step 6: Calculate results
      const totalSolReceived = transactions.reduce((sum, t) => sum + (t.success ? t.solReceived : 0), 0);
      const totalTokensSold = transactions.reduce((sum, t) => sum + (t.success ? t.tokenAmount : 0), 0);
      const averagePrice = totalTokensSold > 0 ? totalSolReceived / totalTokensSold : 0;
      
      const totalProfit = totalSolReceived - this.initialInvestment;
      const profitPercentage = this.initialInvestment > 0 ? totalProfit / this.initialInvestment : 0;
      const multiplierAchieved = this.initialInvestment > 0 ? totalSolReceived / this.initialInvestment : 1;

      const result: ExitResult = {
        success: true,
        transactions,
        totalSolReceived,
        totalTokensSold,
        averagePrice,
        totalProfit,
        profitPercentage,
        multiplierAchieved,
        timestamp: Date.now(),
      };

      // Step 7: Log results
      this.logExitResults(result);

      return result;

    } catch (error) {
      logger.error('Exit execution failed', error);
      
      return {
        success: false,
        transactions: this.exitResults,
        totalSolReceived: 0,
        totalTokensSold: 0,
        averagePrice: 0,
        totalProfit: 0,
        profitPercentage: 0,
        multiplierAchieved: 0,
        error: (error as Error).message,
        timestamp: Date.now(),
      };
    } finally {
      this.isExecuting = false;
    }
  }

  // ============================================================
  // SIMULTANEOUS SELL - ALL WALLETS AT ONCE
  // ============================================================

  /**
   * Execute sells for ALL wallets simultaneously
   * This is the key function - ALL wallets sell at the same time
   */
  private async executeSimultaneousSell(): Promise<ExitTransaction[]> {
    logger.info('🚀 EXECUTING SIMULTANEOUS SELL FOR ALL WALLETS');

    // Get balances for all wallets
    const balances = await this.getBalancesForWallets(this.wallets);
    
    // Filter wallets with tokens
    const walletsWithBalance = this.wallets.filter((w, i) => balances[i] > 0);
    const balancesWithBalance = balances.filter(b => b > 0);

    if (walletsWithBalance.length === 0) {
      logger.warn('No wallets have tokens to sell');
      return [];
    }

    logger.info(`Selling ${walletsWithBalance.length} wallets simultaneously...`, {
      totalWallets: this.wallets.length,
      walletsWithTokens: walletsWithBalance.length,
    });

    // Execute ALL sells in parallel using Promise.all
    // This is the key - ALL wallets sell at exactly the same time
    const startTime = Date.now();
    
    const sellPromises = walletsWithBalance.map((wallet, index) => {
      const balance = balancesWithBalance[index];
      return this.executeSingleSell(wallet, balance);
    });

    // Wait for ALL sells to complete
    const results = await Promise.all(sellPromises);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    logger.info(`Simultaneous sell complete in ${duration}s`, {
      successful: successful.length,
      failed: failed.length,
      total: results.length,
    });

    // If some failed, try to retry them individually
    if (failed.length > 0 && this.config.maxRetries > 0) {
      logger.info(`Retrying ${failed.length} failed sells...`);
      
      for (const failedTx of failed) {
        // Find the wallet and balance for this failed transaction
        const wallet = this.wallets.find(w => 
          shortAddress(w.publicKey) === failedTx.wallet
        );
        if (wallet) {
          const balance = await this.getTokenBalance(wallet);
          if (balance > 0) {
            const retryResult = await this.executeSingleSell(wallet, balance);
            // Replace the failed transaction with the retry result
            const index = results.indexOf(failedTx);
            if (index !== -1) {
              results[index] = retryResult;
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Execute a single wallet sell (used in simultaneous sell)
   */
  private async executeSingleSell(
    wallet: WalletInfo,
    tokenBalance: number
  ): Promise<ExitTransaction> {
    const startTime = Date.now();

    if (tokenBalance <= 0) {
      return {
        wallet: shortAddress(wallet.publicKey),
        tokenAmount: 0,
        solReceived: 0,
        price: 0,
        success: false,
        error: 'No tokens to sell',
        timestamp: startTime,
      };
    }

    try {
      // Get current price before selling
      await this.updatePrice();
      const price = this.currentPrice;

      // Expected SOL from sale
      const expectedSol = tokenBalance * price;

      logger.debug(`Selling ${tokenBalance.toLocaleString()} tokens from ${shortAddress(wallet.publicKey)}`, {
        expectedSol: formatSol(expectedSol),
        price: formatPrice(price),
      });

      // Execute sell with retry
      const result = await retry(
        async () => {
          const swapResult = await this.jupiter.sellTokens(
            this.tokenMint,
            tokenBalance,
            wallet,
            this.tokenDecimals,
            this.config.maxSlippage
          );

          if (!swapResult.success) {
            throw new Error(swapResult.error || 'Sell failed');
          }

          return swapResult;
        },
        this.config.maxRetries,
        2000
      );

      const solReceived = result.outputAmount / 1e9;

      logger.trade(
        `✅ SOLD ${tokenBalance.toLocaleString()} tokens from ${shortAddress(wallet.publicKey)} ` +
        `for ${formatSol(solReceived)}`,
        {
          wallet: shortAddress(wallet.publicKey),
          tokenAmount: tokenBalance,
          solReceived: solReceived,
          price: formatPrice(price),
          signature: result.signature ? shortAddress(result.signature) : 'none',
        }
      );

      return {
        wallet: shortAddress(wallet.publicKey),
        tokenAmount: tokenBalance,
        solReceived: solReceived,
        price: price,
        signature: result.signature,
        success: true,
        timestamp: Date.now(),
      };

    } catch (error) {
      logger.error(`❌ Sell failed for ${shortAddress(wallet.publicKey)}`, error);

      return {
        wallet: shortAddress(wallet.publicKey),
        tokenAmount: tokenBalance,
        solReceived: 0,
        price: 0,
        success: false,
        error: (error as Error).message,
        timestamp: Date.now(),
      };
    }
  }

  // ============================================================
  // BALANCE MANAGEMENT
  // ============================================================

  /**
   * Get token balances for all wallets
   */
  private async getTokenBalances(): Promise<TokenBalance[]> {
    const balances: TokenBalance[] = [];

    for (const wallet of this.wallets) {
      try {
        const balance = await this.getTokenBalance(wallet);
        const usdValue = balance * this.currentPrice;
        
        balances.push({
          wallet,
          balance,
          usdValue,
        });
      } catch (error) {
        logger.error(`Failed to get balance for ${shortAddress(wallet.publicKey)}`, error);
        balances.push({
          wallet,
          balance: 0,
          usdValue: 0,
        });
      }
    }

    this.tokenBalances = balances;
    return balances;
  }

  /**
   * Get token balance for a single wallet
   */
  private async getTokenBalance(wallet: WalletInfo): Promise<number> {
    try {
      const ata = await getAssociatedTokenAddress(
        this.tokenMint,
        new PublicKey(wallet.publicKey)
      );

      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / Math.pow(10, this.tokenDecimals);
      
    } catch (error) {
      // Account might not exist (no tokens)
      return 0;
    }
  }

  /**
   * Get balances for specific wallets
   */
  private async getBalancesForWallets(wallets: WalletInfo[]): Promise<number[]> {
    const balances: number[] = [];

    for (const wallet of wallets) {
      // Find balance in cached tokenBalances
      const cached = this.tokenBalances.find(tb => 
        tb.wallet.publicKey === wallet.publicKey
      );
      
      if (cached) {
        balances.push(cached.balance);
      } else {
        const balance = await this.getTokenBalance(wallet);
        balances.push(balance);
      }
    }

    return balances;
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
        if (this.startPrice === 0) {
          this.startPrice = price;
        }
        this.currentPrice = price;
      }
    } catch (error) {
      logger.error('Failed to update price', error);
    }
  }

  // ============================================================
  // LIQUIDITY CHECK
  // ============================================================

  /**
   * Check if there's enough liquidity to sell all tokens
   */
  async checkLiquidity(): Promise<{
    sufficient: boolean;
    totalTokens: number;
    estimatedValue: number;
    maxSellable: number;
    liquidityDepth: number;
  }> {
    await this.updatePrice();
    await this.getTokenBalances();

    const totalTokens = this.tokenBalances.reduce((sum, tb) => sum + tb.balance, 0);
    const estimatedValue = totalTokens * this.currentPrice;
    
    // Estimate liquidity depth (simplified)
    // In reality, you'd query the pool to get actual depth
    const liquidityDepth = estimatedValue * 0.8; // Assume 80% liquidity available
    
    const maxSellable = liquidityDepth / this.currentPrice;
    const sufficient = maxSellable >= totalTokens;

    return {
      sufficient,
      totalTokens,
      estimatedValue,
      maxSellable,
      liquidityDepth,
    };
  }

  // ============================================================
  // RESULTS LOGGING
  // ============================================================

  /**
   * Log exit results
   */
  private logExitResults(result: ExitResult): void {
    logger.section('🎯 EXIT RESULTS - SIMULTANEOUS SELL');

    const successful = result.transactions.filter(t => t.success);
    const failed = result.transactions.filter(t => !t.success);

    console.log(`  Status:              ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`  Total SOL Received:  ${formatSol(result.totalSolReceived)}`);
    console.log(`  Total Tokens Sold:   ${result.totalTokensSold.toLocaleString()}`);
    console.log(`  Average Price:       ${formatPrice(result.averagePrice)}`);
    console.log(`  Total Profit:        ${formatSol(result.totalProfit)}`);
    console.log(`  Profit %:            ${(result.profitPercentage * 100).toFixed(1)}%`);
    console.log(`  Multiplier:          ${result.multiplierAchieved.toFixed(2)}x`);
    console.log(`  Target Multiplier:   ${this.config.targetMultiplier}x`);
    console.log(`  Successful Txs:      ${successful.length}/${result.transactions.length}`);
    
    if (failed.length > 0) {
      console.log(`  Failed Wallets:      ${failed.map(t => t.wallet).join(', ')}`);
    }

    if (result.error) {
      console.log(`  Error:               ${result.error}`);
    }

    logger.divider('═');

    // Check if target was met
    const targetMet = result.multiplierAchieved >= this.config.targetMultiplier;
    console.log(`  ${targetMet ? '🎉' : '⚠️'} Target ${this.config.targetMultiplier}x: ${targetMet ? '✅ MET' : '❌ NOT MET'}`);
    
    // Check if minimum profit was met
    const minMet = result.multiplierAchieved >= this.config.minProfitThreshold;
    console.log(`  Minimum ${this.config.minProfitThreshold}x: ${minMet ? '✅ MET' : '⚠️ NOT MET'}`);
    
    logger.divider('═');
  }

  // ============================================================
  // UTILITY
  // ============================================================

  /**
   * Get estimated exit value
   */
  async getEstimatedExitValue(): Promise<{
    totalTokens: number;
    estimatedSol: number;
    estimatedPrice: number;
    profit: number;
    profitPercentage: number;
    multiplier: number;
  }> {
    await this.updatePrice();
    await this.getTokenBalances();

    const totalTokens = this.tokenBalances.reduce((sum, tb) => sum + tb.balance, 0);
    const estimatedSol = totalTokens * this.currentPrice;
    
    const profit = estimatedSol - this.initialInvestment;
    const profitPercentage = this.initialInvestment > 0 ? profit / this.initialInvestment : 0;
    const multiplier = this.initialInvestment > 0 ? estimatedSol / this.initialInvestment : 1;

    return {
      totalTokens,
      estimatedSol,
      estimatedPrice: this.currentPrice,
      profit,
      profitPercentage,
      multiplier,
    };
  }

  /**
   * Get current status
   */
  getStatus(): {
    isExecuting: boolean;
    currentPrice: number;
    totalTokens: number;
    estimatedValue: number;
    progress: number;
    currentMultiplier: number;
  } {
    const totalTokens = this.tokenBalances.reduce((sum, tb) => sum + tb.balance, 0);
    const totalSold = this.exitResults.reduce((sum, t) => sum + (t.success ? t.tokenAmount : 0), 0);
    const progress = totalTokens > 0 ? totalSold / totalTokens : 0;
    const estimatedValue = totalTokens * this.currentPrice;
    const currentMultiplier = this.initialInvestment > 0 ? estimatedValue / this.initialInvestment : 1;

    return {
      isExecuting: this.isExecuting,
      currentPrice: this.currentPrice,
      totalTokens,
      estimatedValue,
      progress,
      currentMultiplier,
    };
  }

  /**
   * Reset the exit strategy
   */
  reset(): void {
    this.tokenBalances = [];
    this.exitResults = [];
    this.isExecuting = false;
    this.currentPrice = 0;
    this.startPrice = 0;
    logger.info('ExitStrategy reset');
  }
}

// ============================================================
// EXPORT
// ============================================================

export default ExitStrategy;