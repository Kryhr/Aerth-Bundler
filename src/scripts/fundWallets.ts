/**
 * Script to distribute SOL from main wallet to sub-wallets
 * Distributes random percentages of total available SOL
 * Automatically scales for any amount of SOL
 */

import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

import { log } from '../utils/logger';
import { WalletManager } from '../core/walletManager';
import { formatSol } from '../utils/helpers';
import { resolveRpcEndpoint, resolveWalletFolder } from '../config/constants';

dotenv.config();

if (process.argv.includes('--mainnet')) {
  process.env.NETWORK = 'mainnet';
} else if (process.argv.includes('--devnet')) {
  process.env.NETWORK = 'devnet';
}

async function fundWallets() {
  log.section('💰 FUNDING WALLETS');

  const connection = new Connection(resolveRpcEndpoint(), 'confirmed');

  const password = process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password';
  const walletFolder = resolveWalletFolder();

  const walletManager = new WalletManager(connection, password, walletFolder);
  await walletManager.initialize();

  try {
    await walletManager.loadWallets();
  } catch (e) {
    log.error('No wallets found. Run generate-wallets first.');
    console.log('  npm run generate-wallets');
    return;
  }

  const mainWallet = walletManager.getMainWallet();
  if (!mainWallet) {
    log.error('No main wallet found');
    return;
  }

  const mainBalance = await walletManager.getBalance(mainWallet);
  log.info(`Main wallet balance: ${formatSol(mainBalance)}`);

  if (mainBalance < 0.5) {
    log.error('Main wallet balance too low!');
    console.log(`  Current: ${formatSol(mainBalance)}`);
    console.log(`  Minimum required: 0.5 SOL`);
    console.log(`  Please fund: ${mainWallet.publicKey}`);
    console.log(`  Get SOL from: https://solfaucet.com/`);
    return;
  }

  const balances = await walletManager.getAllBalances();
  const funded = balances.filter(w => w.isFunded);
  
  log.info(`Sub-wallets: ${funded.length}/${balances.length} funded`);
  
  // Calculate how much to distribute (use 80% of main balance, leave 20% for fees)
  const totalToDistribute = mainBalance * 0.8;
  const numWallets = balances.length;
  
  // Calculate min/max PERCENTAGES of total
  // Each wallet gets between 3% and 15% of the total distribution
  const minPercent = 0.03;  // 3% minimum
  const maxPercent = 0.15;  // 15% maximum
  
  // Convert to SOL amounts
  const minAmount = totalToDistribute * minPercent;
  const maxAmount = totalToDistribute * maxPercent;
  
  // Ensure minimum is at least 0.1 SOL per wallet
  const finalMin = Math.max(minAmount, 0.1);
  const finalMax = Math.max(maxAmount, 0.3);
  
  log.info(`Distributing ${formatSol(totalToDistribute)} total (80% of main balance)`);
  log.info(`Each wallet gets random amount between ${formatSol(finalMin)} - ${formatSol(finalMax)}`);
  
  const result = await walletManager.distributeSOL(
    'random',
    finalMin,
    finalMax
  );

  log.success(`Distribution complete!`);
  console.log(`  Total distributed: ${formatSol(result.totalDistributed)}`);
  console.log(`  Transactions:      ${result.transactions.length}`);
  
  // Show new balances
  const newBalances = await walletManager.getAllBalances();
  const newFunded = newBalances.filter(w => w.isFunded);
  console.log(`  Now funded:        ${newFunded.length}/${newBalances.length}`);
  
  console.log('\n💰 NEW WALLET BALANCES (Random amounts):');
  newBalances.forEach(w => {
    const status = w.isFunded ? '✅' : '❌';
    console.log(`  ${status} ${w.label}: ${formatSol(w.solBalance)}`);
  });
  
  // Show what's left in main wallet
  const remaining = await walletManager.getBalance(mainWallet);
  console.log(`\n📊 Remaining in main wallet: ${formatSol(remaining)} (for fees and misc)`);
  
  log.divider('═');
}

fundWallets().catch(console.error);