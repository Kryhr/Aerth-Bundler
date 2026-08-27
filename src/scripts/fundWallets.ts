/**
 * Script to distribute SOL from main wallet to sub-wallets
 */

import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';

import { logger, log } from '../utils/logger';
import { WalletManager } from '../core/walletManager';
import { formatSol } from '../utils/helpers';

dotenv.config();

async function fundWallets() {
  log.section('💰 FUNDING WALLETS');

  const connection = new Connection(
    process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com',
    'confirmed'
  );

  const password = process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password';
  const walletFolder = process.env.WALLET_FOLDER || './wallets';

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
  
  if (funded.length === balances.length) {
    log.success('All wallets already funded!');
    return;
  }

  log.info(`Distributing SOL to ${balances.length} wallets...`);
  
  const minBuyAmount = parseFloat(process.env.MIN_BUY_AMOUNT || '0.05');
  const maxBuyAmount = parseFloat(process.env.MAX_BUY_AMOUNT || '0.5');
  
  const result = await walletManager.distributeSOL(
    'random',
    minBuyAmount * 2,
    maxBuyAmount * 2
  );

  log.success(`Distribution complete!`);
  console.log(`  Total distributed: ${formatSol(result.totalDistributed)}`);
  console.log(`  Transactions:      ${result.transactions.length}`);
  
  const newBalances = await walletManager.getAllBalances();
  const newFunded = newBalances.filter(w => w.isFunded);
  console.log(`  Now funded:        ${newFunded.length}/${newBalances.length}`);
}

fundWallets().catch(console.error);