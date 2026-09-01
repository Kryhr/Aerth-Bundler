/**
 * AERTH BUNDLER - Real pump.fun token creation (mainnet only)
 *
 * Uses pump.fun's official SDK (@pump-fun/pump-sdk) to call their actual
 * on-chain `create_v2` instruction - this is what makes a token a real,
 * discoverable pump.fun listing, unlike TokenFactory.createToken() (used for
 * devnet rehearsal), which just mints a bare, anonymous SPL token nobody can
 * find. See PUMPFUN_INTEGRATION.md for the full picture.
 *
 * NOT yet wired into the main Bundler flow - trading (Step 3/4/5) still
 * needs a real "PumpFunMarket" replacing LocalMarket's fake curve before
 * this is safe to run end-to-end (creating a real listing but then trading
 * against a disconnected fake curve would be actively broken, not just
 * incomplete). This module is standalone and independently testable via
 * src/scripts/testPumpFunCreate.ts until that exists.
 */
import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { PUMP_SDK } from '@pump-fun/pump-sdk';
import { logger } from '../utils/logger';
import { WalletInfo } from '../config/constants';
import { uploadPumpFunMetadata, PumpFunMetadataParams } from './pumpFunMetadata';

export interface CreatePumpFunTokenParams {
  name: string;
  symbol: string;
  description?: string;
  iconPath?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  creatorWallet: WalletInfo;
}

export interface CreatePumpFunTokenResult {
  success: boolean;
  mintAddress?: string;
  metadataUri?: string;
  transactionSignature?: string;
  error?: string;
}

export async function createPumpFunToken(
  connection: Connection,
  params: CreatePumpFunTokenParams,
  options: { dryRun?: boolean } = {}
): Promise<CreatePumpFunTokenResult> {
  const metadataParams: PumpFunMetadataParams = {
    name: params.name,
    symbol: params.symbol,
    description: params.description,
    iconPath: params.iconPath,
    twitter: params.twitter,
    telegram: params.telegram,
    website: params.website,
  };

  const metadataResult = await uploadPumpFunMetadata(metadataParams);
  if (!metadataResult.success || !metadataResult.metadataUri) {
    return { success: false, error: `Metadata upload failed: ${metadataResult.error}` };
  }

  try {
    const creatorKeypair = Keypair.fromSecretKey(Buffer.from(params.creatorWallet.privateKey, 'base64'));
    const mintKeypair = Keypair.generate();

    logger.info('Building pump.fun create_v2 instruction...', {
      mint: mintKeypair.publicKey.toBase58(),
      name: params.name,
      symbol: params.symbol,
    });

    const createIx = await PUMP_SDK.createV2Instruction({
      mint: mintKeypair.publicKey,
      name: params.name,
      symbol: params.symbol,
      uri: metadataResult.metadataUri,
      creator: creatorKeypair.publicKey,
      user: creatorKeypair.publicKey,
      mayhemMode: false,
      cashback: false,
    });

    const tx = new Transaction().add(createIx);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = creatorKeypair.publicKey;
    tx.sign(creatorKeypair, mintKeypair);

    if (options.dryRun) {
      const simResult = await connection.simulateTransaction(tx);
      if (simResult.value.err) {
        return {
          success: false,
          mintAddress: mintKeypair.publicKey.toBase58(),
          metadataUri: metadataResult.metadataUri,
          error: `Simulation failed: ${JSON.stringify(simResult.value.err)}\nLogs:\n${(simResult.value.logs || []).join('\n')}`,
        };
      }
      logger.success('DRY RUN: simulation succeeded, nothing was sent', {
        mint: mintKeypair.publicKey.toBase58(),
        logs: simResult.value.logs,
      });
      return {
        success: true,
        mintAddress: mintKeypair.publicKey.toBase58(),
        metadataUri: metadataResult.metadataUri,
      };
    }

    const signature = await sendAndConfirmTransaction(connection, tx, [creatorKeypair, mintKeypair], {
      commitment: 'confirmed',
    });

    logger.success('Real pump.fun token created!', {
      mint: mintKeypair.publicKey.toBase58(),
      signature,
    });

    return {
      success: true,
      mintAddress: mintKeypair.publicKey.toBase58(),
      metadataUri: metadataResult.metadataUri,
      transactionSignature: signature,
    };

  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
