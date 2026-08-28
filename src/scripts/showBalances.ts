import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';

dotenv.config();

async function showBalances() {
  const conn = new Connection(process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com');
  const wm = new WalletManager(conn, process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password', './wallets');
  await wm.initialize();
  await wm.loadWallets();
  
  const mainWallet = wm.getMainWallet();
  // ALWAYS fetch fresh balance from blockchain
  const mainBalance = mainWallet ? await conn.getBalance(new PublicKey(mainWallet.publicKey)) / 1e9 : 0;
  
  log.info(`Main wallet: ${mainBalance.toFixed(4)} SOL`);
  
  const wallets = wm.getWallets();
  let total = 0;
  
  for (const wallet of wallets) {
    // ALWAYS fetch fresh balance from blockchain
    const balance = await conn.getBalance(new PublicKey(wallet.publicKey)) / 1e9;
    total += balance;
    console.log(`  ${wallet.label}: ${balance.toFixed(4)} SOL`);
  }
  
  log.info(`Total in sub-wallets: ${total.toFixed(4)} SOL`);
  log.info(`Grand total: ${(mainBalance + total).toFixed(4)} SOL`);
}

showBalances().catch(console.error);