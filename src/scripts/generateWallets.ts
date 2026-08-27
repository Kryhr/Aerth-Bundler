/**
 * Script to generate wallets and export addresses for funding
 */

import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

import { logger, log } from '../utils/logger';
import { WalletManager } from '../core/walletManager';

dotenv.config();

async function generateWallets() {
  log.section('🔑 GENERATING WALLETS');

  const connection = new Connection(
    process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com',
    'confirmed'
  );

  const password = process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password';
  const walletFolder = process.env.WALLET_FOLDER || './wallets';
  const numWallets = parseInt(process.env.NUMBER_OF_WALLETS || '10');

  const walletManager = new WalletManager(connection, password, walletFolder);
  await walletManager.initialize();

  const existingWallets = walletManager.getWallets();
  
  if (existingWallets.length > 0) {
    log.info(`Found ${existingWallets.length} existing wallets`);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question('Delete existing wallets and generate new ones? (y/n): ', resolve);
    });
    rl.close();
    
    if (answer.toLowerCase() === 'y') {
      const walletFile = path.join(walletFolder, 'wallets.json');
      try {
        await fs.unlink(walletFile);
        log.info('Deleted existing wallet file');
      } catch (e) {}
    } else {
      log.info('Keeping existing wallets');
      await printWalletInfo(walletManager);
      return;
    }
  }

  log.info('Creating main wallet...');
  const mainWallet = await walletManager.createMainWallet();
  log.success('Main wallet created!');
  log.wallet(`Address: ${mainWallet.publicKey}`);
  log.wallet(`Private Key: ${mainWallet.privateKey}`);

  const envPath = path.join(process.cwd(), '.env');
  try {
    let envContent = await fs.readFile(envPath, 'utf-8');
    envContent = envContent.replace(
      /MAIN_WALLET_PRIVATE_KEY=.*/,
      `MAIN_WALLET_PRIVATE_KEY=${mainWallet.privateKey}`
    );
    await fs.writeFile(envPath, envContent);
    log.success('Main wallet private key saved to .env');
  } catch (e) {
    log.warn('Could not update .env file. Please add MAIN_WALLET_PRIVATE_KEY manually.');
  }

  log.info(`Generating ${numWallets} sub-wallets...`);
  const wallets = walletManager.generateWallets(numWallets);
  await walletManager.saveWallets();
  await walletManager.exportAddresses();
  
  log.success(`Generated ${wallets.length} wallets`);
  await printWalletInfo(walletManager);
  
  log.section('📋 NEXT STEPS');
  console.log(`
  1. Fund your MAIN wallet with Devnet SOL:
     Address: ${mainWallet.publicKey}
     Get SOL from: https://solfaucet.com/
     
  2. Fund your SUB-WALLETS:
     Run: npm run fund
     
  3. Once funded, run the bundler:
     npm start -- --devnet
  `);
}

async function printWalletInfo(walletManager: WalletManager) {
  const mainWallet = walletManager.getMainWallet();
  const wallets = walletManager.getWallets();
  
  console.log('\n📊 WALLET SUMMARY');
  console.log(`  Main Wallet:  ${mainWallet?.publicKey}`);
  console.log(`  Sub-Wallets:  ${wallets.length}`);
  console.log('\n  SUB-WALLET ADDRESSES:');
  wallets.forEach((w, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${w.publicKey}`);
  });
  console.log('');
}

generateWallets().catch(console.error);