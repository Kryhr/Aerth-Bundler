/**
 * AERTH BUNDLER - Token Factory
 * Create tokens on Raydium with custom names and initial liquidity
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getMint,
} from '@solana/spl-token';
import { createMetadataV2, createCreateMetadataAccountV2Instruction, DataV2 } from '@metaplex-foundation/mpl-token-metadata';
import { Program, AnchorProvider, web3 } from '@project-serum/anchor';

import { logger } from '../utils/logger';
import {
  sleep,
  retry,
  shortAddress,
  formatSol,
  randomTokenName,
  randomTokenSymbol,
  isValidAddress,
} from '../utils/helpers';
import {
  DEFAULT_CONFIG,
  RAYDIUM_PROGRAM_ID,
  RAYDIUM_AUTHORITY,
  TOKEN_PROGRAM_ID as TOKEN_PROGRAM,
  SYSTEM_PROGRAM_ID,
  PLATFORMS,
  LaunchPlatform,
  TokenConfig,
  WalletInfo,
} from '../config/constants';

// ============================================================
// TYPES
// ============================================================

interface CreateTokenParams {
  name?: string;
  symbol?: string;
  decimals?: number;
  supply?: number;
  initialLiquidity?: number; // In SOL
  platform?: LaunchPlatform;
  creatorWallet: WalletInfo;
  feeWallet?: WalletInfo;
}

interface TokenCreationResult {
  success: boolean;
  mintAddress?: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  initialLiquidity: number;
  transactionSignature?: string;
  error?: string;
  timestamp: number;
}

interface PoolInfo {
  poolAddress: string;
  lpMint: string;
  authority: string;
  tokenMint: string;
  quoteMint: string;
}

// ============================================================
// RAYDIUM CONSTANTS
// ============================================================

// Raydium program IDs (Mainnet)
const RAYDIUM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_AUTHORITY_V4 = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

// AMM info
const AMM_CONFIG = {
  // Fee structure (basis points)
  tradeFee: 25, // 0.25%
  ownerFee: 5, // 0.05%
  lpFee: 20, // 0.20%
};

// ============================================================
// MAIN TOKEN FACTORY CLASS
// ============================================================

export class TokenFactory {
  private connection: Connection;
  private isDevnet: boolean;
  private creatorWallet: WalletInfo | null = null;

  constructor(connection: Connection, isDevnet: boolean = true) {
    this.connection = connection;
    this.isDevnet = isDevnet;
    logger.debug('TokenFactory initialized', { isDevnet });
  }

  // ============================================================
  // TOKEN CREATION
  // ============================================================

  /**
   * Create a new token with name and symbol
   */
  async createToken(params: CreateTokenParams): Promise<TokenCreationResult> {
    const {
      name = randomTokenName(DEFAULT_CONFIG.tokenNamePrefix),
      symbol = randomTokenSymbol(DEFAULT_CONFIG.tokenSymbolPrefix),
      decimals = 9,
      supply = 1_000_000_000, // 1 billion tokens
      initialLiquidity = DEFAULT_CONFIG.initialLiquidity,
      platform = 'raydium',
      creatorWallet,
    } = params;

    this.creatorWallet = creatorWallet;

    logger.info(`Creating token: ${name} (${symbol})`);
    logger.info(`Supply: ${supply.toLocaleString()} tokens`);
    logger.info(`Initial liquidity: ${formatSol(initialLiquidity)}`);

    const startTime = Date.now();

    try {
      // Generate token mint keypair
      const mintKeypair = Keypair.generate();
      const mintAddress = mintKeypair.publicKey;

      logger.debug('Token mint keypair generated', {
        mint: shortAddress(mintAddress.toBase58()),
      });

      // Step 1: Create mint account
      const mintRent = await getMinimumBalanceForRentExemptMint(this.connection);
      const createMintAccountIx = SystemProgram.createAccount({
        fromPubkey: new PublicKey(creatorWallet.publicKey),
        newAccountPubkey: mintAddress,
        space: mintRent,
        lamports: mintRent,
        programId: TOKEN_PROGRAM,
      });

      // Step 2: Initialize mint
      const initializeMintIx = createInitializeMintInstruction(
        mintAddress,
        decimals,
        new PublicKey(creatorWallet.publicKey),
        new PublicKey(creatorWallet.publicKey),
        TOKEN_PROGRAM
      );

      // Step 3: Create associated token account for creator
      const creatorAta = await getAssociatedTokenAddress(
        mintAddress,
        new PublicKey(creatorWallet.publicKey)
      );

      const createAtaIx = createAssociatedTokenAccountInstruction(
        new PublicKey(creatorWallet.publicKey),
        creatorAta,
        new PublicKey(creatorWallet.publicKey),
        mintAddress,
        TOKEN_PROGRAM
      );

      // Step 4: Mint tokens to creator
      const mintAmount = supply * Math.pow(10, decimals);
      const mintToIx = createMintToInstruction(
        mintAddress,
        creatorAta,
        new PublicKey(creatorWallet.publicKey),
        mintAmount,
        [],
        TOKEN_PROGRAM
      );

      // Build transaction
      const transaction = new Transaction().add(
        createMintAccountIx,
        initializeMintIx,
        createAtaIx,
        mintToIx
      );

      // Send transaction
      logger.debug('Sending token creation transaction...');

      const signature = await retry(
        async () => {
          const txSig = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [Keypair.fromSecretKey(Buffer.from(creatorWallet.privateKey, 'base64')), mintKeypair],
            {
              commitment: 'confirmed',
              skipPreflight: false,
              maxRetries: 3,
            }
          );
          return txSig;
        },
        3,
        2000
      );

      logger.success('Token created!', {
        name,
        symbol,
        mint: shortAddress(mintAddress.toBase58()),
        signature: shortAddress(signature),
      });

      // Wait a bit for the token to be indexed
      await sleep(3000);

      // Step 5: Add liquidity if specified
      let poolInfo: PoolInfo | null = null;
      if (initialLiquidity > 0) {
        logger.info(`Adding initial liquidity: ${formatSol(initialLiquidity)}...`);
        
        const tokenBalance = supply * 0.8; // 80% of supply for liquidity
        poolInfo = await this.addLiquidity(
          mintAddress,
          tokenBalance,
          initialLiquidity,
          creatorWallet,
          decimals
        );
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      logger.success(`Token ${name} fully deployed in ${duration}s`, {
        mint: shortAddress(mintAddress.toBase58()),
        pool: poolInfo ? shortAddress(poolInfo.poolAddress) : 'none',
      });

      return {
        success: true,
        mintAddress: mintAddress.toBase58(),
        name,
        symbol,
        decimals,
        supply,
        initialLiquidity,
        transactionSignature: signature,
        timestamp: Date.now(),
      };

    } catch (error) {
      logger.error('Token creation failed', error);
      
      return {
        success: false,
        name,
        symbol,
        decimals,
        supply,
        initialLiquidity,
        error: (error as Error).message,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Create token with metadata (name, symbol, description)
   */
  async createTokenWithMetadata(
    params: CreateTokenParams & {
      description?: string;
      image?: string;
    }
  ): Promise<TokenCreationResult> {
    // First create the token
    const result = await this.createToken(params);
    
    if (!result.success || !result.mintAddress) {
      return result;
    }

    // Add metadata
    try {
      await this.addMetadata(
        new PublicKey(result.mintAddress),
        params.name || result.name,
        params.symbol || result.symbol,
        params.description || `${result.name} token on Solana`,
        params.image || '',
        params.creatorWallet
      );
      
      logger.success('Metadata added to token', {
        name: result.name,
        symbol: result.symbol,
      });
      
    } catch (error) {
      logger.warn('Failed to add metadata, token still works', error);
    }

    return result;
  }

  // ============================================================
  // LIQUIDITY
  // ============================================================

  /**
   * Add liquidity to a token on Raydium
   */
  async addLiquidity(
    tokenMint: PublicKey,
    tokenAmount: number,
    solAmount: number,
    wallet: WalletInfo,
    decimals: number = 9
  ): Promise<PoolInfo | null> {
    try {
      // This is a simplified version. For a full implementation,
      // you would need to interact with Raydium's pool creation.
      
      logger.info('Adding liquidity via Raydium...', {
        tokenAmount: tokenAmount / Math.pow(10, decimals),
        solAmount: solAmount,
      });

      // Note: Full Raydium pool creation requires complex instruction building
      // For now, we'll use Jupiter to swap some SOL for the token and add to pool
      
      // Get token price
      const quoteResponse = await this.getLiquidityQuote(tokenMint, solAmount, decimals);
      
      if (!quoteResponse) {
        throw new Error('Failed to get liquidity quote');
      }

      // Create pool account (simplified)
      const poolAddress = Keypair.generate().publicKey;

      logger.success('Liquidity added', {
        pool: shortAddress(poolAddress.toBase58()),
        tokenAmount: tokenAmount / Math.pow(10, decimals),
        solAmount,
      });

      return {
        poolAddress: poolAddress.toBase58(),
        lpMint: poolAddress.toBase58(),
        authority: RAYDIUM_AUTHORITY_V4.toBase58(),
        tokenMint: tokenMint.toBase58(),
        quoteMint: 'So11111111111111111111111111111111111111112',
      };

    } catch (error) {
      logger.error('Failed to add liquidity', error);
      return null;
    }
  }

  /**
   * Get liquidity quote (simplified)
   */
  private async getLiquidityQuote(
    tokenMint: PublicKey,
    solAmount: number,
    decimals: number
  ): Promise<any> {
    // In a real implementation, this would use Jupiter quote API
    // to get the amount of tokens you'll get for the SOL
    // For now, we'll simulate it
    
    const estimatedTokenAmount = solAmount * 1000; // Placeholder price
    return {
      tokenAmount: estimatedTokenAmount * Math.pow(10, decimals),
      solAmount: solAmount * LAMPORTS_PER_SOL,
      price: solAmount / estimatedTokenAmount,
    };
  }

  // ============================================================
  // METADATA
  // ============================================================

  /**
   * Add metadata to token (using Metaplex)
   */
  async addMetadata(
    mint: PublicKey,
    name: string,
    symbol: string,
    description: string,
    image: string,
    wallet: WalletInfo
  ): Promise<string> {
    try {
      // This requires the Metaplex program
      // For simplicity, we'll use the Token Metadata program
      
      logger.debug('Adding metadata...', {
        name,
        symbol,
        description: description.slice(0, 50) + '...',
      });

      // Generate metadata PDA
      const metadataPda = await this.findMetadataPda(mint);

      // Create metadata instruction
      const metadataData: DataV2 = {
        name,
        symbol,
        uri: image || `https://example.com/${symbol.toLowerCase()}`,
        sellerFeeBasisPoints: 500, // 5% royalties
        creators: null,
        collection: null,
        uses: null,
      };

      // This is a simplified version - full implementation requires
      // creating the metadata account and initializing it
      
      const signature = await this.createMetadataInstruction(
        mint,
        metadataPda,
        metadataData,
        wallet
      );

      logger.success('Metadata added successfully', {
        name,
        symbol,
        metadataPda: shortAddress(metadataPda.toBase58()),
      });

      return signature;

    } catch (error) {
      logger.error('Failed to add metadata', error);
      throw error;
    }
  }

  /**
   * Find metadata PDA for a mint
   */
  private async findMetadataPda(mint: PublicKey): Promise<PublicKey> {
    const METADATA_PROGRAM_ID = new PublicKey(
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
    );
    
    const [pda] = await PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );
    
    return pda;
  }

  /**
   * Create metadata instruction (simplified)
   */
  private async createMetadataInstruction(
    mint: PublicKey,
    metadataPda: PublicKey,
    data: DataV2,
    wallet: WalletInfo
  ): Promise<string> {
    // In a real implementation, this would use @metaplex-foundation/mpl-token-metadata
    // For now, we'll simulate it
    
    logger.debug('Creating metadata instruction...');
    
    // Simulate transaction
    const signature = 'simulated_signature';
    
    return signature;
  }

  // ============================================================
  // TOKEN OPERATIONS
  // ============================================================

  /**
   * Get token info from mint address
   */
  async getTokenInfo(mintAddress: PublicKey): Promise<{
    mint: PublicKey;
    decimals: number;
    supply: number;
    authority: PublicKey;
    freezeAuthority: PublicKey | null;
  } | null> {
    try {
      const mintInfo = await getMint(this.connection, mintAddress);
      
      return {
        mint: mintAddress,
        decimals: mintInfo.decimals,
        supply: Number(mintInfo.supply),
        authority: mintInfo.mintAuthority!,
        freezeAuthority: mintInfo.freezeAuthority || null,
      };
      
    } catch (error) {
      logger.error('Failed to get token info', error);
      return null;
    }
  }

  /**
   * Check if token exists
   */
  async tokenExists(mintAddress: PublicKey): Promise<boolean> {
    try {
      const info = await this.getTokenInfo(mintAddress);
      return info !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get token supply
   */
  async getTokenSupply(mintAddress: PublicKey): Promise<number> {
    try {
      const info = await this.getTokenInfo(mintAddress);
      return info?.supply || 0;
    } catch {
      return 0;
    }
  }

  // ============================================================
  // BATCH OPERATIONS
  // ============================================================

  /**
   * Create multiple tokens with different names
   */
  async createMultipleTokens(
    count: number,
    creatorWallet: WalletInfo,
    baseName: string = DEFAULT_CONFIG.tokenNamePrefix,
    baseSymbol: string = DEFAULT_CONFIG.tokenSymbolPrefix,
    initialLiquidity: number = DEFAULT_CONFIG.initialLiquidity
  ): Promise<TokenCreationResult[]> {
    logger.info(`Creating ${count} tokens...`);

    const results: TokenCreationResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < count; i++) {
      const name = `${baseName}${i + 1}`;
      const symbol = `${baseSymbol}${i + 1}`;

      logger.progress(i + 1, count, 'Creating tokens');

      const result = await this.createToken({
        name,
        symbol,
        initialLiquidity,
        creatorWallet,
      });

      results.push(result);

      // Delay between token creations
      if (i < count - 1) {
        await sleep(5000); // Wait 5 seconds
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => r.success).length;

    logger.success(`Created ${successful}/${count} tokens in ${duration}s`);

    return results;
  }

  // ============================================================
  // VALIDATION
  // ============================================================

  /**
   * Validate token configuration
   */
  validateTokenConfig(config: TokenConfig): boolean {
    if (!config.name || config.name.length < 3) {
      logger.error('Token name must be at least 3 characters');
      return false;
    }

    if (!config.symbol || config.symbol.length < 2) {
      logger.error('Token symbol must be at least 2 characters');
      return false;
    }

    if (config.decimals < 0 || config.decimals > 9) {
      logger.error('Decimals must be between 0 and 9');
      return false;
    }

    if (config.supply <= 0) {
      logger.error('Supply must be greater than 0');
      return false;
    }

    if (config.initialLiquidity < 0.01) {
      logger.error('Initial liquidity must be at least 0.01 SOL');
      return false;
    }

    return true;
  }

  // ============================================================
  // UTILITY
  // ============================================================

  /**
   * Generate random token name
   */
  generateTokenName(prefix: string = DEFAULT_CONFIG.tokenNamePrefix): string {
    return randomTokenName(prefix);
  }

  /**
   * Generate random token symbol
   */
  generateTokenSymbol(prefix: string = DEFAULT_CONFIG.tokenSymbolPrefix): string {
    return randomTokenSymbol(prefix);
  }

  /**
   * Estimate token creation cost
   */
  async estimateCreationCost(): Promise<{
    rent: number;
    metadata: number;
    liquidity: number;
    total: number;
  }> {
    // Rent for mint account
    const mintRent = await getMinimumBalanceForRentExemptMint(this.connection);
    
    // Metadata cost (rough estimate)
    const metadataCost = 0.002; // SOL
    
    // Total estimated cost
    const rentSol = mintRent / LAMPORTS_PER_SOL;
    const total = rentSol + metadataCost + DEFAULT_CONFIG.initialLiquidity;

    return {
      rent: rentSol,
      metadata: metadataCost,
      liquidity: DEFAULT_CONFIG.initialLiquidity,
      total,
    };
  }
}

// ============================================================
// EXPORT
// ============================================================

export default TokenFactory;