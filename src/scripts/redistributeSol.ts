import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';

dotenv.config();

async function redistribute() {
  const conn = new Connection(process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com');
  const wm = new WalletManager(conn, process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password', './wallets');
  await wm.initialize();
  await wm.loadWallets();
  
  const mainWallet = wm.getMainWallet();
  if (!mainWallet) {
    log.error('No main wallet found');
    return;
  }
  
  const mainBalance = await wm.getBalance(mainWallet);
  const wallets = wm.getWallets();
  
  // Use 80% of main balance (leave 20% for main wallet)
  const totalToDistribute = mainBalance * 0.8;
  const perWallet = totalToDistribute / wallets.length;
  
  log.info(`Main balance: ${mainBalance.toFixed(4)} SOL`);
  log.info(`Keeping ${(mainBalance * 0.2).toFixed(4)} SOL in main wallet for fees`);
  log.info(`Distributing ${totalToDistribute.toFixed(4)} SOL total (~${perWallet.toFixed(4)} SOL per wallet)`);
  
  const result = await wm.distributeSOL('random', perWallet * 0.8, perWallet * 1.2);
  log.success(`Distributed ${result.totalDistributed.toFixed(4)} SOL to ${result.transactions.length} wallets`);
  
  // Show final balances
  const newMainBalance = await wm.getBalance(mainWallet);
  log.info(`Main wallet remaining: ${newMainBalance.toFixed(4)} SOL`);
}

redistribute().catch(console.error);