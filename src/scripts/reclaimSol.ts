import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';
import { resolveRpcEndpoint, resolveWalletFolder } from '../config/constants';

dotenv.config();

if (process.argv.includes('--mainnet')) {
  process.env.NETWORK = 'mainnet';
} else if (process.argv.includes('--devnet')) {
  process.env.NETWORK = 'devnet';
}

async function reclaim() {
  const conn = new Connection(resolveRpcEndpoint());
  const wm = new WalletManager(conn, process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password', resolveWalletFolder());
  await wm.initialize();
  await wm.loadWallets();
  
  const result = await wm.reclaimSOL(0.001);

  // The last wallet's reclaim transaction may not have fully confirmed yet -
  // give it the same settle window redistributeSol.ts uses, so the balance
  // check below doesn't read a stale, too-low amount.
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Fetch fresh balance to show
  const mainWallet = wm.getMainWallet();
  if (mainWallet) {
    const balance = await conn.getBalance(new PublicKey(mainWallet.publicKey)) / 1e9;
    log.success(`Main wallet now has: ${balance.toFixed(4)} SOL`);
  }
  
  log.success(`Reclaimed ${result.totalReclaimed.toFixed(4)} SOL from ${result.transactions.length} wallets`);
}

reclaim().catch(console.error);