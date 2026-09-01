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

async function redistribute() {
  const conn = new Connection(resolveRpcEndpoint());
  const wm = new WalletManager(conn, process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password', resolveWalletFolder());
  await wm.initialize();
  await wm.loadWallets();
  
  const mainWallet = wm.getMainWallet();
  if (!mainWallet) {
    log.error('No main wallet found');
    return;
  }
  
  // If this runs shortly after reclaimSol.ts while devnet confirmations are
  // still settling, a single balance read can be stale - some reclaimed SOL
  // arrives after we've already computed and sent the 80/20 split, leaving
  // more than intended sitting in the main wallet with no error shown. Read
  // twice a few seconds apart and only proceed once it's stable.
  const mainWalletPubkey = new PublicKey(mainWallet.publicKey);
  let mainBalance = await conn.getBalance(mainWalletPubkey) / 1e9;
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const recheck = await conn.getBalance(mainWalletPubkey) / 1e9;
    if (recheck === mainBalance) break;
    log.info(`Balance still settling (${mainBalance.toFixed(4)} -> ${recheck.toFixed(4)} SOL), rechecking...`);
    mainBalance = recheck;
  }

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

  // Every wallet except the last one already got a 1.5s settle window before
  // the next loop iteration ran - the LAST wallet's transaction gets none,
  // so the "final balances" check below could read it before it's actually
  // confirmed and show a wrong, near-zero amount even though the real
  // transfer landed fine. Give it the same breathing room.
  await new Promise(resolve => setTimeout(resolve, 5000));

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