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
  
  // Use 80% of main balance
  const totalToDistribute = mainBalance * 0.8;
  const perWallet = totalToDistribute / wallets.length;
  
  log.info(`Main balance: ${mainBalance.toFixed(4)} SOL`);
  log.info(`Keeping ${(mainBalance * 0.2).toFixed(4)} SOL in main wallet`);
  log.info(`Distributing ${totalToDistribute.toFixed(4)} SOL total`);
  
  // Generate realistic random amounts with WIDE variance
  // Some wallets get 0.2 SOL, some get 1.5 SOL - looks like real holders
  const amounts: number[] = [];
  let totalAssigned = 0;
  
  // Assign random percentages (5% to 20% of total)
  // This creates realistic wallet distribution like:
  // Wallet 1: 0.95 SOL (12%)
  // Wallet 2: 0.40 SOL (5%)
  // Wallet 3: 1.20 SOL (15%)
  // Wallet 4: 0.60 SOL (7.5%)
  // etc.
  for (let i = 0; i < wallets.length; i++) {
    // Random percentage between 5% and 20% of total
    const percent = (Math.random() * 0.15 + 0.05); // 5% to 20%
    const amount = totalToDistribute * percent;
    amounts.push(amount);
    totalAssigned += amount;
  }
  
  // Scale to exactly match totalToDistribute
  const scaleFactor = totalToDistribute / totalAssigned;
  amounts.forEach((a, i) => {
    amounts[i] = Math.round(a * scaleFactor * 1000) / 1000;
  });
  
  // Show distribution
  log.info('📊 Distribution plan:');
  amounts.forEach((amount, i) => {
    const percent = ((amount / totalToDistribute) * 100).toFixed(1);
    log.info(`  Wallet_${i + 1}: ${amount.toFixed(4)} SOL (${percent}%)`);
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
      log.error(`Failed for Wallet_${i + 1}: ${error?.message?.substring(0, 50) || 'unknown'}`);
    }
  }
  
  log.success(`✅ Distributed ${totalSent.toFixed(4)} SOL to ${successCount}/${wallets.length} wallets`);
  
  // Show final balances
  const newMainBalance = await wm.getBalance(mainWallet);
  log.info(`Main wallet remaining: ${newMainBalance.toFixed(4)} SOL`);
  
  log.info('📊 Final wallet balances:');
  for (let i = 0; i < wallets.length; i++) {
    const balance = await wm.getBalance(wallets[i]);
    log.info(`  Wallet_${i + 1}: ${balance.toFixed(4)} SOL`);
  }
}

redistribute().catch(console.error);