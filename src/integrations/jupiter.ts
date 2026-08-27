/**
 * AERTH BUNDLER - Jupiter Integration
 * Swap aggregation for buying/selling tokens
 */

import { 
  Connection, 
  PublicKey, 
  Transaction, 
  Keypair,
  sendAndConfirmTransaction,
  VersionedTransaction,
  ComputeBudgetProgram
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fetch from 'node-fetch';

import { logger } from '../utils/logger';
import { 
  sleep, 
  retry, 
  shortAddress, 
  formatSol,
  formatPrice,
  randomSolAmount,
  clamp,
  RateLimiter
} from '../utils/helpers';
import { DEFAULT_CONFIG, WalletInfo } from '../config/constants';

// ============================================================
// TYPES
// ============================================================

interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  price: number;
  slippageBps: number;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  computeUnitPrice: number;
}

interface SwapParams {
  inputMint: string;
  outputMint: string;
  amount: number; // In lamports
  slippageBps?: number;
  wallet: WalletInfo;
  priorityFee?: number;
}

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  supply: number;
  price: number;
  priceChange24h: number;
}

interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount: number;
  price: number;
  slippage: number;
  error?: string;
}

// ============================================================
// JUPITER API CONSTANTS
// ============================================================

const JUPITER_API = {
  MAINNET: 'https://quote-api.jup.ag/v6',
  DEVNET: 'https://quote-api.jup.ag/v6', // Jupiter doesn't have devnet, use mainnet for quotes
};

const DEFAULT_SLIPPAGE = 50; // 50% for aggressive execution
const MAX_RETRIES = 3;
const RATE_LIMIT_TOKENS = 10; // 10 requests per second
const RATE_LIMIT_REFILL = 10;

// ============================================================
// MAIN JUPITER INTEGRATION CLASS
// ============================================================

export class JupiterIntegration {
  private connection: Connection;
  private rateLimiter: RateLimiter;
  private isDevnet: boolean;
  private quoteApi: string;

  constructor(connection: Connection, isDevnet: boolean = true) {
    this.connection = connection;
    this.isDevnet = isDevnet;
    this.quoteApi = JUPITER_API.MAINNET; // Always use mainnet for quotes
    this.rateLimiter = new RateLimiter(RATE_LIMIT_TOKENS, RATE_LIMIT_REFILL);
    
    logger.debug('JupiterIntegration initialized', { 
      isDevnet,
      api: this.quoteApi 
    });
  }

  // ============================================================
  // QUOTE FUNCTIONS
  // ============================================================

  /**
   * Get swap quote
   */
  async getQuote(
    inputMint: string | PublicKey,
    outputMint: string | PublicKey,
    amount: number, // In lamports
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<QuoteResponse> {
    await this.rateLimiter.consumeOrWait();

    const inputMintStr = inputMint.toString();
    const outputMintStr = outputMint.toString();

    const url = `${this.quoteApi}/quote?` + new URLSearchParams({
      inputMint: inputMintStr,
      outputMint: outputMintStr,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
    });

    logger.debug('Fetching quote...', {
      inputMint: shortAddress(inputMintStr),
      outputMint: shortAddress(outputMintStr),
      amount: amount / 1e9, // Convert to SOL for display
    });

    const response = await retry(
      async () => {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json();
      },
      MAX_RETRIES,
      1000
    );

    logger.debug('Quote received', {
      price: response.price,
      outAmount: response.outAmount / 1e9,
    });

    return response;
  }

  /**
   * Get quote with SOL to token (buy)
   */
  async getBuyQuote(
    tokenMint: string | PublicKey,
    solAmount: number, // In SOL
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<QuoteResponse> {
    const solLamports = solAmount * 1_000_000_000;
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC on Solana
    
    // First get quote from SOL to USDC (or use SOL directly)
    return this.getQuote(
      'So11111111111111111111111111111111111111112', // SOL mint
      tokenMint.toString(),
      solLamports,
      slippageBps
    );
  }

  /**
   * Get quote with token to SOL (sell)
   */
  async getSellQuote(
    tokenMint: string | PublicKey,
    tokenAmount: number, // In token units (not lamports)
    decimals: number = 9,
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<QuoteResponse> {
    const tokenLamports = tokenAmount * Math.pow(10, decimals);
    
    return this.getQuote(
      tokenMint.toString(),
      'So11111111111111111111111111111111111111112', // SOL mint
      tokenLamports,
      slippageBps
    );
  }

  // ============================================================
  // SWAP EXECUTION
  // ============================================================

  /**
   * Execute swap (buy or sell)
   */
  async executeSwap(params: SwapParams): Promise<SwapResult> {
    const {
      inputMint,
      outputMint,
      amount,
      slippageBps = DEFAULT_SLIPPAGE,
      wallet,
      priorityFee = DEFAULT_CONFIG.priorityFee
    } = params;

    try {
      // Get quote first
      const quote = await this.getQuote(
        inputMint,
        outputMint,
        amount,
        slippageBps
      );

      logger.debug('Executing swap...', {
        wallet: shortAddress(wallet.publicKey),
        inputMint: shortAddress(inputMint.toString()),
        outputMint: shortAddress(outputMint.toString()),
        amount: amount / 1e9,
        price: quote.price,
      });

      // Get swap transaction
      const swapResponse = await this.getSwapTransaction(
        quote,
        wallet,
        priorityFee
      );

      // Sign and send transaction
      const signature = await this.sendSwapTransaction(
        swapResponse,
        wallet
      );

      // Wait for confirmation
      await this.connection.confirmTransaction(signature, 'confirmed');

      // Parse output amount from quote
      const outputAmount = parseFloat(quote.outAmount);

      logger.success('Swap executed', {
        wallet: shortAddress(wallet.publicKey),
        signature: shortAddress(signature),
        inputAmount: amount / 1e9,
        outputAmount: outputAmount / 1e9,
        price: quote.price,
      });

      return {
        success: true,
        signature,
        inputAmount: amount,
        outputAmount,
        price: quote.price,
        slippage: slippageBps / 100,
      };

    } catch (error) {
      logger.error('Swap failed', {
        wallet: shortAddress(wallet.publicKey),
        error: (error as Error).message,
      });

      return {
        success: false,
        inputAmount: amount,
        outputAmount: 0,
        price: 0,
        slippage: slippageBps / 100,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get swap transaction from Jupiter
   */
  private async getSwapTransaction(
    quote: QuoteResponse,
    wallet: WalletInfo,
    priorityFee: number
  ): Promise<SwapResponse> {
    await this.rateLimiter.consumeOrWait();

    const url = `${this.quoteApi}/swap`;
    
    const payload = {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFee * 1_000_000_000,
    };

    const response = await retry(
      async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        
        return res.json();
      },
      MAX_RETRIES,
      1000
    );

    return response;
  }

  /**
   * Send swap transaction
   */
  private async sendSwapTransaction(
    swapResponse: SwapResponse,
    wallet: WalletInfo
  ): Promise<string> {
    const keypair = Keypair.fromSecretKey(
      Buffer.from(wallet.privateKey, 'base64')
    );

    // Deserialize the transaction
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapResponse.swapTransaction, 'base64')
    );

    // Sign the transaction
    transaction.sign([keypair]);

    // Send the transaction
    const signature = await this.connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    return signature;
  }

  // ============================================================
  // BUY TOKENS
  // ============================================================

  /**
   * Buy tokens with SOL
   */
  async buyTokens(
    tokenMint: string | PublicKey,
    solAmount: number,
    wallet: WalletInfo,
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<SwapResult> {
    const solMint = 'So11111111111111111111111111111111111111112';
    const solLamports = solAmount * 1_000_000_000;

    return this.executeSwap({
      inputMint: solMint,
      outputMint: tokenMint.toString(),
      amount: solLamports,
      slippageBps,
      wallet,
    });
  }

  /**
   * Buy tokens with multiple wallets
   */
  async buyTokensWithMultipleWallets(
    tokenMint: string | PublicKey,
    wallets: WalletInfo[],
    totalSolAmount: number,
    minBuyAmount: number = 0.05,
    maxBuyAmount: number = 0.5,
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<SwapResult[]> {
    logger.info(`Buying tokens with ${wallets.length} wallets...`);
    logger.info(`Total SOL: ${formatSol(totalSolAmount)}`);

    const results: SwapResult[] = [];
    const startTime = Date.now();

    // Distribute SOL across wallets randomly
    let remainingSol = totalSolAmount;
    
    for (let i = 0; i < wallets.length; i++) {
      const isLast = i === wallets.length - 1;
      
      // Calculate amount for this wallet
      let amount: number;
      if (isLast) {
        amount = remainingSol;
      } else {
        const maxAmount = Math.min(maxBuyAmount, remainingSol / (wallets.length - i) * 1.5);
        const minAmount = Math.min(minBuyAmount, maxAmount);
        amount = randomSolAmount(minAmount, maxAmount);
        remainingSol -= amount;
      }

      // Ensure we don't go below min
      if (amount < 0.001) {
        logger.warn(`Skipping wallet ${i + 1}: amount too small (${formatSol(amount)})`);
        continue;
      }

      // Execute buy
      const result = await this.buyTokens(
        tokenMint,
        amount,
        wallets[i],
        slippageBps
      );

      results.push(result);

      // Log progress
      if ((i + 1) % 5 === 0 || i === wallets.length - 1) {
        logger.progress(i + 1, wallets.length, 'Buying tokens');
      }

      // Random delay between buys (to look organic)
      await sleep(randomSolAmount(0.5, 3) * 1000);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => r.success).length;
    
    logger.success(`Bought tokens with ${successful}/${results.length} wallets in ${duration}s`);

    return results;
  }

  // ============================================================
  // SELL TOKENS
  // ============================================================

  /**
   * Sell tokens for SOL
   */
  async sellTokens(
    tokenMint: string | PublicKey,
    tokenAmount: number,
    wallet: WalletInfo,
    decimals: number = 9,
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<SwapResult> {
    const tokenLamports = tokenAmount * Math.pow(10, decimals);

    return this.executeSwap({
      inputMint: tokenMint.toString(),
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: tokenLamports,
      slippageBps,
      wallet,
    });
  }

  /**
   * Sell all tokens from a wallet
   */
  async sellAllTokens(
    tokenMint: string | PublicKey,
    wallet: WalletInfo,
    tokenBalance: number,
    decimals: number = 9,
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<SwapResult> {
    if (tokenBalance <= 0) {
      logger.warn(`No tokens to sell in wallet ${shortAddress(wallet.publicKey)}`);
      return {
        success: false,
        inputAmount: 0,
        outputAmount: 0,
        price: 0,
        slippage: slippageBps / 100,
        error: 'No tokens to sell',
      };
    }

    return this.sellTokens(
      tokenMint,
      tokenBalance,
      wallet,
      decimals,
      slippageBps
    );
  }

  /**
   * Sell tokens from multiple wallets
   */
  async sellTokensFromMultipleWallets(
    tokenMint: string | PublicKey,
    wallets: WalletInfo[],
    tokenBalances: number[],
    decimals: number = 9,
    slippageBps: number = DEFAULT_SLIPPAGE
  ): Promise<SwapResult[]> {
    logger.info(`Selling tokens from ${wallets.length} wallets...`);

    const results: SwapResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < wallets.length; i++) {
      const balance = tokenBalances[i] || 0;
      
      if (balance <= 0) {
        logger.warn(`Skipping wallet ${i + 1}: no tokens to sell`);
        continue;
      }

      // Execute sell
      const result = await this.sellAllTokens(
        tokenMint,
        wallets[i],
        balance,
        decimals,
        slippageBps
      );

      results.push(result);

      // Log progress
      if ((i + 1) % 5 === 0 || i === wallets.length - 1) {
        logger.progress(i + 1, wallets.length, 'Selling tokens');
      }

      // Random delay between sells (to look organic)
      await sleep(randomSolAmount(0.5, 2) * 1000);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => r.success).length;
    
    logger.success(`Sold tokens from ${successful}/${results.length} wallets in ${duration}s`);

    return results;
  }

  // ============================================================
  // PRICE FETCHING
  // ============================================================

  /**
   * Get token price from Jupiter
   */
  async getTokenPrice(
    tokenMint: string | PublicKey
  ): Promise<number> {
    try {
      await this.rateLimiter.consumeOrWait();

      const url = `${this.quoteApi}/price?` + new URLSearchParams({
        ids: tokenMint.toString(),
      });

      const response = await retry(
        async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          return res.json();
        },
        MAX_RETRIES,
        1000
      );

      const price = response.data?.[tokenMint.toString()]?.price || 0;
      return price;

    } catch (error) {
      logger.error(`Failed to get token price for ${shortAddress(tokenMint.toString())}`, error);
      return 0;
    }
  }

  /**
   * Get multiple token prices
   */
  async getTokenPrices(
    tokenMints: (string | PublicKey)[]
  ): Promise<Record<string, number>> {
    try {
      await this.rateLimiter.consumeOrWait();

      const ids = tokenMints.map(m => m.toString()).join(',');
      const url = `${this.quoteApi}/price?` + new URLSearchParams({
        ids,
      });

      const response = await retry(
        async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          return res.json();
        },
        MAX_RETRIES,
        1000
      );

      const prices: Record<string, number> = {};
      for (const mint of tokenMints) {
        const mintStr = mint.toString();
        prices[mintStr] = response.data?.[mintStr]?.price || 0;
      }

      return prices;

    } catch (error) {
      logger.error('Failed to get token prices', error);
      return {};
    }
  }

  // ============================================================
  // UTILITY
  // ============================================================

  /**
   * Get token info (metadata)
   */
  async getTokenInfo(
    tokenMint: string | PublicKey
  ): Promise<TokenInfo | null> {
    try {
      await this.rateLimiter.consumeOrWait();

      const mintStr = tokenMint.toString();
      const url = `${this.quoteApi}/tokens?` + new URLSearchParams({
        ids: mintStr,
      });

      const response = await retry(
        async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          return res.json();
        },
        MAX_RETRIES,
        1000
      );

      const tokenData = response.data?.[mintStr];
      if (!tokenData) return null;

      return {
        address: mintStr,
        symbol: tokenData.symbol || 'UNKNOWN',
        name: tokenData.name || 'Unknown Token',
        decimals: tokenData.decimals || 9,
        supply: tokenData.supply || 0,
        price: tokenData.price || 0,
        priceChange24h: tokenData.priceChange24h || 0,
      };

    } catch (error) {
      logger.error(`Failed to get token info for ${shortAddress(tokenMint.toString())}`, error);
      return null;
    }
  }

  /**
   * Get compute units for a swap
   */
  async getSwapComputeUnits(
    inputMint: string | PublicKey,
    outputMint: string | PublicKey,
    amount: number
  ): Promise<number> {
    try {
      const quote = await this.getQuote(
        inputMint,
        outputMint,
        amount,
        50
      );

      // Estimate compute units based on route complexity
      const routeComplexity = quote.routePlan?.length || 1;
      const baseUnits = 150000;
      const additionalUnits = routeComplexity * 50000;
      
      return Math.min(baseUnits + additionalUnits, 1000000);
      
    } catch (error) {
      logger.error('Failed to get compute units', error);
      return 200000; // Default
    }
  }
}

// ============================================================
// EXPORT
// ============================================================

export default JupiterIntegration;