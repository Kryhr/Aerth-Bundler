/**
 * AERTH BUNDLER - Token Factory (Simplified Fixed Version)
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
  getMint,
} from '@solana/spl-token';

import { logger } from '../utils/logger';
import { sleep, retry, shortAddress, formatSol, randomTokenName, randomTokenSymbol } from '../utils/helpers';
import { DEFAULT_CONFIG, WalletInfo } from '../config/constants';

// ============================================================
// TYPES
// ============================================================

interface CreateTokenParams {
  name?: string;
  symbol?: string;
  decimals?: number;
  supply?: number;
  initialLiquidity?: number;
  creatorWallet: WalletInfo;
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
}

// ============================================================
// TOKEN FACTORY
// ============================================================

export class TokenFactory {
  private connection: Connection;
  private isDevnet: boolean;

  constructor(connection: Connection, isDevnet: boolean = true) {
    this.connection = connection;
    this.isDevnet = isDevnet;
    logger.debug('TokenFactory initialized', { isDevnet });
  }

  async createToken(params: CreateTokenParams): Promise<TokenCreationResult> {
    const {
      name = randomTokenName(DEFAULT_CONFIG.tokenNamePrefix),
      symbol = randomTokenSymbol(DEFAULT_CONFIG.tokenSymbolPrefix),
      decimals = 9,
      supply = 1_000_000_000,
      initialLiquidity = DEFAULT_CONFIG.initialLiquidity,
      creatorWallet,
    } = params;

    logger.info(`Creating token: ${name} (${symbol})`);
    logger.info(`Supply: ${supply.toLocaleString()} tokens`);
    logger.info(`Initial liquidity: ${formatSol(initialLiquidity)}`);

    const startTime = Date.now();

    try {
      // Generate mint keypair
      const mintKeypair = Keypair.generate();
      const mintAddress = mintKeypair.publicKey;

      logger.debug('Token mint keypair generated', {
        mint: shortAddress(mintAddress.toBase58()),
      });

      const creatorPublicKey = new PublicKey(creatorWallet.publicKey);
      const creatorKeypair = Keypair.fromSecretKey(
        Buffer.from(creatorWallet.privateKey, 'base64')
      );

      // Step 1: Create mint account
      const mintRent = await getMinimumBalanceForRentExemptMint(this.connection);
      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: creatorPublicKey,
        newAccountPubkey: mintAddress,
        space: mintRent,
        lamports: mintRent,
        programId: TOKEN_PROGRAM_ID,
      });

      // Step 2: Initialize mint
      const initMintIx = createInitializeMintInstruction(
        mintAddress,
        decimals,
        creatorPublicKey,
        creatorPublicKey,
        TOKEN_PROGRAM_ID
      );

      // Step 3: Get or create associated token account
      const ata = await getAssociatedTokenAddress(
        mintAddress,
        creatorPublicKey
      );

      const createAtaIx = createAssociatedTokenAccountInstruction(
        creatorPublicKey,
        ata,
        creatorPublicKey,
        mintAddress,
        TOKEN_PROGRAM_ID
      );

      // Step 4: Mint tokens to creator
      const mintAmount = supply * Math.pow(10, decimals);
      const mintToIx = createMintToInstruction(
        mintAddress,
        ata,
        creatorPublicKey,
        mintAmount,
        [],
        TOKEN_PROGRAM_ID
      );

      // Build transaction - SIMPLER: just create and initialize
      const transaction = new Transaction()
        .add(createAccountIx)
        .add(initMintIx)
        .add(createAtaIx)
        .add(mintToIx);

      // Get fresh blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = creatorPublicKey;

      // Send transaction
      logger.debug('Sending token creation transaction...');

      const signature = await retry(
        async () => {
          const txSig = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [creatorKeypair, mintKeypair],
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

      // Wait for indexing
      await sleep(3000);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.success(`Token ${name} deployed in ${duration}s`);

      return {
        success: true,
        mintAddress: mintAddress.toBase58(),
        name,
        symbol,
        decimals,
        supply,
        initialLiquidity,
        transactionSignature: signature,
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
      };
    }
  }

  async createTokenWithMetadata(params: CreateTokenParams & { description?: string; image?: string }): Promise<TokenCreationResult> {
    // Just create token without metadata for simplicity (metadata often fails on devnet)
    return this.createToken(params);
  }

  async getTokenInfo(mintAddress: PublicKey): Promise<any> {
    try {
      const mintInfo = await getMint(this.connection, mintAddress);
      return {
        mint: mintAddress,
        decimals: mintInfo.decimals,
        supply: Number(mintInfo.supply),
        authority: mintInfo.mintAuthority,
      };
    } catch (error) {
      logger.error('Failed to get token info', error);
      return null;
    }
  }
}

export default TokenFactory;