/**
 * Script to generate wallets and export addresses for funding
 */

import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

import { log } from '../utils/logger';
import { WalletManager } from '../core/walletManager';
import { resolveRpcEndpoint, resolveWalletFolder } from '../config/constants';

dotenv.config();

// --devnet/--mainnet picks the network-specific wallet folder (see
// resolveWalletFolder) - set NETWORK before anything else resolves off it.
if (process.argv.includes('--mainnet')) {
  process.env.NETWORK = 'mainnet';
} else if (process.argv.includes('--devnet')) {
  process.env.NETWORK = 'devnet';
}
const isMainnet = process.env.NETWORK === 'mainnet';

async function generateWallets() {
  log.section(isMainnet ? '🔑 GENERATING MAINNET WALLETS' : '🔑 GENERATING DEVNET WALLETS');
  if (isMainnet) {
    log.warn('⚠️  MAINNET - these wallets will hold real SOL. A plaintext seed phrase backup will be written for recovery.');
  }

  const connection = new Connection(resolveRpcEndpoint(), 'confirmed');

  const password = process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password';
  const walletFolder = resolveWalletFolder();
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

  if (isMainnet) {
    await writeSeedPhraseBackup(walletFolder, mainWallet, wallets);
  }

  log.success(`Generated ${wallets.length} wallets`);
  await printWalletInfo(walletManager);

  log.section('📋 NEXT STEPS');
  console.log(isMainnet ? `
  1. Fund your MAIN wallet with REAL SOL:
     Address: ${mainWallet.publicKey}

  2. Fund your SUB-WALLETS (real SOL - double check amounts):
     Run: npm run fund -- --mainnet

  3. Once funded, run the bundler:
     npm run start:mainnet
  ` : `
  1. Fund your MAIN wallet with Devnet SOL:
     Address: ${mainWallet.publicKey}
     Get SOL from: https://solfaucet.com/

  2. Fund your SUB-WALLETS:
     Run: npm run fund

  3. Once funded, run the bundler:
     npm run start:devnet
  `);
}

/**
 * Plaintext seed phrases for every wallet, mainnet only. The app's own
 * runtime only ever needs the encrypted wallets.json - this is purely a
 * manual recovery backup so real funds are never unrecoverable because of
 * a lost password or corrupted wallet file. Move this file to secure
 * offline storage after generating - it's gitignored, but it's still a
 * plaintext copy of every key sitting on this machine.
 */
async function writeSeedPhraseBackup(
  walletFolder: string,
  mainWallet: { publicKey: string; seedPhrase?: string; privateKey: string },
  wallets: Array<{ publicKey: string; seedPhrase?: string; privateKey: string; label?: string }>
): Promise<void> {
  let output = '===== MAINNET SEED PHRASE BACKUP - KEEP THIS OFFLINE AND SECRET =====\n\n';
  output += 'Anyone with these seed phrases/keys can take everything. Do not share,\n';
  output += 'commit, or upload this file anywhere. Move it to secure offline\n';
  output += 'storage (e.g. an encrypted USB drive) once saved.\n\n';

  output += `MAIN WALLET\n`;
  output += `  Address: ${mainWallet.publicKey}\n`;
  output += mainWallet.seedPhrase
    ? `  Seed Phrase: ${mainWallet.seedPhrase}\n\n`
    : `  Private Key: ${mainWallet.privateKey}\n  (no seed phrase - this wallet was freshly generated with one, so this shouldn't happen; if it did, the private key above is the only recovery path)\n\n`;

  output += `SUB WALLETS (${wallets.length})\n`;
  wallets.forEach((w, i) => {
    output += `  ${i + 1}. ${w.publicKey}${w.label ? ` (${w.label})` : ''}\n`;
    output += `     Seed Phrase: ${w.seedPhrase || '(none - private key: ' + w.privateKey + ')'}\n`;
  });

  const backupPath = path.join(walletFolder, 'SEED_PHRASES_BACKUP.txt');
  await fs.writeFile(backupPath, output);
  log.warn(`⚠️  Plaintext seed phrase backup written to ${backupPath} - move it offline once you've saved it elsewhere.`);
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