import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';

dotenv.config();

async function redistribute() {
  const conn = new Connection(
    process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com',
    'confirmed'
  );
  
  const password = process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password';
  const walletFolder = process.env.WALLET_FOLDER || './wallets';
  
  const wm = new WalletManager(conn, password, walletFolder);
  await wm.initialize();
  await wm.loadWallets();
  
  const mainWallet = wm.getMainWallet();
  if (!mainWallet) {
    log.error('No main wallet found');
    return;
  }
  
  const mainBalance = await wm.getBalance(mainWallet);
  log.info(`Main wallet balance: ${mainBalance.toFixed(4)} SOL`);
  
  const wallets = wm.getWallets();
  
  // Use 90% of main balance (leave 10% for fees)
  const totalToDistribute = mainBalance * 0.9;
  const perWallet = totalToDistribute / wallets.length;
  
  log.info(`Distributing ${totalToDistribute.toFixed(4)} SOL total to ${wallets.length} wallets`);
  log.info(`~${perWallet.toFixed(4)} SOL per wallet (randomized)`);
  
  // Calculate random amounts for each wallet
  const amounts = wallets.map(() => {
    const min = perWallet * 0.8;
    const max = perWallet * 1.2;
    return Math.round((Math.random() * (max - min) + min) * 1000) / 1000;
  });
  
  // Send individually
  let totalSent = 0;
  let successCount = 0;
  
  for (let i = 0; i < wallets.length; i++) {
    const amount = amounts[i];
    log.progress(i + 1, wallets.length, 'Distributing');
    
    try {
      await wm.sendTransactionWithRetry(mainWallet, wallets[i], amount);
      totalSent += amount;
      successCount++;
      wallets[i].balance += amount;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error: any) {
      log.error(`Failed for ${wallets[i].label}: ${error?.message?.substring(0, 50) || 'unknown'}`);
    }
  }
  
  log.success(`✅ Distributed ${totalSent.toFixed(4)} SOL to ${successCount}/${wallets.length} wallets`);
  
  // Show final balances
  log.info('📊 Final balances:');
  for (const wallet of wallets) {
    const balance = await wm.getBalance(wallet);
    log.info(`  ${wallet.label}: ${balance.toFixed(4)} SOL`);
  }
}

redistribute().catch(console.error);