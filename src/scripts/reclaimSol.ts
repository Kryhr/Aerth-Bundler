import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';

dotenv.config();

async function reclaim() {
  const conn = new Connection(process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com');
  const wm = new WalletManager(conn, process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password', './wallets');
  await wm.initialize();
  await wm.loadWallets();
  
  const result = await wm.reclaimSOL(0.001);
  
  // Fetch fresh balance to show
  const mainWallet = wm.getMainWallet();
  if (mainWallet) {
    const balance = await conn.getBalance(new PublicKey(mainWallet.publicKey)) / 1e9;
    log.success(`Main wallet now has: ${balance.toFixed(4)} SOL`);
  }
  
  log.success(`Reclaimed ${result.totalReclaimed.toFixed(4)} SOL from ${result.transactions.length} wallets`);
}

reclaim().catch(console.error);