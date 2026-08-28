import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';

dotenv.config();

async function reclaim() {
  const conn = new Connection('https://api.devnet.solana.com');
  const wm = new WalletManager(conn, process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password', './wallets');
  await wm.initialize();
  await wm.loadWallets();
  const result = await wm.reclaimSOL(0.001);
  log.success(`Reclaimed ${result.totalReclaimed} SOL from ${result.transactions.length} wallets`);
}

reclaim().catch(console.error);