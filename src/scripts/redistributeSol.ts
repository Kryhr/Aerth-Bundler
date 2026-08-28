import { Connection, PublicKey } from '@solana/web3.js';
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
  
  // ALWAYS fetch fresh balance from blockchain
  const mainBalance = await conn.getBalance(new PublicKey(mainWallet.publicKey)) / 1e9;
  const wallets = wm.getWallets();
  
  // Use 80% of main balance
  const totalToDistribute = mainBalance * 0.8;
  
  log.info(`Main balance: ${mainBalance.toFixed(4)} SOL`);
  log.info(`Keeping ${(mainBalance * 0.2).toFixed(4)} SOL in main wallet for fees`);
  log.info(`Distributing ${totalToDistribute.toFixed(4)} SOL total`);
  
  // Generate realistic random amounts with WIDE variance
  const amounts: number[] = [];
  let totalAssigned = 0;
  
  for (let i = 0; i < wallets.length; i++) {
    const percent = (Math.random() * 0.15 + 0.05);
    const amount = totalToDistribute * percent;
    amounts.push(amount);
    totalAssigned += amount;
  }
  
  const scaleFactor = totalToDistribute / totalAssigned;
  amounts.forEach((a, i) => {
    amounts[i] = Math.round(a * scaleFactor * 1000) / 1000;
  });
  
  log.info('📊 Distribution plan:');
  amounts.forEach((amount, i) => {
    const percent = ((amount / totalToDistribute) * 100).toFixed(1);
    log.info(`  Wallet_${i + 1}: ${amount.toFixed(4)} SOL (${percent}%)`);
  });
  
  let totalSent = 0;
  let successCount = 0;
  
  for (let i = 0; i < wallets.length; i++) {
    const amount = amounts[i];
    log.progress(i + 1, wallets.length, 'Distributing');
    
    try {
      await wm.sendTransactionWithRetry(mainWallet, wallets[i], amount);
      totalSent += amount;
      successCount++;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error: any) {
      log.error(`Failed for Wallet_${i + 1}: ${error?.message?.substring(0, 50) || 'unknown'}`);
    }
  }
  
  log.success(`✅ Distributed ${totalSent.toFixed(4)} SOL to ${successCount}/${wallets.length} wallets`);
  
  // ALWAYS fetch fresh balance from blockchain
  const newMainBalance = await conn.getBalance(new PublicKey(mainWallet.publicKey)) / 1e9;
  log.info(`Main wallet remaining: ${newMainBalance.toFixed(4)} SOL`);
  
  log.info('📊 Final wallet balances:');
  for (let i = 0; i < wallets.length; i++) {
    const balance = await conn.getBalance(new PublicKey(wallets[i].publicKey)) / 1e9;
    log.info(`  Wallet_${i + 1}: ${balance.toFixed(4)} SOL`);
  }
}

redistribute().catch(console.error);