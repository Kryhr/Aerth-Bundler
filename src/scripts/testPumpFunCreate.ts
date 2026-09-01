/**
 * AERTH BUNDLER - Test real pump.fun token creation (mainnet only)
 *
 * Pump.fun doesn't exist on devnet, so this can only be meaningfully tested
 * against mainnet - which means real SOL and a real, permanent token if you
 * don't pass --dry-run. ALWAYS run with --dry-run first to confirm the
 * transaction simulates successfully before ever sending it for real.
 *
 * Usage:
 *   npx tsx src/scripts/testPumpFunCreate.ts --dry-run   (simulate only, sends nothing)
 *   npx tsx src/scripts/testPumpFunCreate.ts             (REAL - creates a real token)
 */
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { createPumpFunToken } from '../core/pumpFunTokenFactory';
import { log } from '../utils/logger';
import { resolveWalletFolder } from '../config/constants';

dotenv.config();
process.env.NETWORK = 'mainnet';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  if (!dryRun) {
    log.warn('⚠️  LIVE MODE - this will create a REAL pump.fun token with REAL SOL fees. Re-run with --dry-run first if you have not already.');
  }

  // Mainnet RPC only matters for a real (non-dry-run) send/simulate - both
  // still need SOME mainnet connection since pump.fun's program only exists
  // there.
  const rpcEndpoint = process.env.MAINNET_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcEndpoint, 'confirmed');

  const wm = new WalletManager(
    connection,
    process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password',
    resolveWalletFolder()
  );
  await wm.initialize();
  await wm.loadWallets();

  const mainWallet = wm.getMainWallet();
  if (!mainWallet) {
    log.error('No mainnet main wallet found. Run: npm run generate-wallets:mainnet');
    process.exitCode = 1;
    return;
  }

  // pump.fun's metadata upload rejects requests with no image outright
  // (confirmed by actually calling it: "400 Missing file") - it's not
  // optional the way some of their docs examples implied. Fail clearly here
  // instead of letting the API's 400 be the first anyone hears about it.
  if (!process.env.TOKEN_ICON_PATH) {
    log.error('TOKEN_ICON_PATH is not set in .env - pump.fun requires an image to create a listing. Set it to a path to an image file and try again.');
    process.exitCode = 1;
    return;
  }

  const result = await createPumpFunToken(
    connection,
    {
      name: process.env.TOKEN_NAME || 'TestToken',
      symbol: process.env.TOKEN_SYMBOL || 'TEST',
      description: process.env.TOKEN_DESCRIPTION,
      iconPath: process.env.TOKEN_ICON_PATH,
      twitter: process.env.TOKEN_TWITTER,
      telegram: process.env.TOKEN_TELEGRAM,
      website: process.env.TOKEN_WEBSITE,
      creatorWallet: mainWallet,
    },
    { dryRun }
  );

  if (result.success) {
    log.success(dryRun ? 'Dry run succeeded - safe to run for real' : 'Token created for real', {
      mint: result.mintAddress,
      metadataUri: result.metadataUri,
      signature: result.transactionSignature,
    });
    if (!dryRun) {
      console.log(`\nView on pump.fun: https://pump.fun/coin/${result.mintAddress}`);
    }
  } else {
    log.error('Failed', { error: result.error });
    process.exitCode = 1;
  }
}

// process.exitCode (not process.exit()) lets Node drain pending handles -
// fetch's underlying connection can still be mid-close when process.exit()
// forces an immediate teardown, which is what was crashing with a libuv
// assertion on Windows (UV_HANDLE_CLOSING) right after the metadata upload
// failed.
main().catch((error) => {
  log.error('Unexpected error', { error: error.message, stack: error.stack });
  process.exitCode = 1;
});
