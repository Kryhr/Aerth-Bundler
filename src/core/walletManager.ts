/**
 * AERTH BUNDLER - Wallet Manager
 * Generate, store, and manage all wallets for the bundler
 */

import { 
  Keypair, 
  PublicKey, 
  Connection, 
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

import { logger } from '../utils/logger';
import { 
  sleep, 
  randomSolAmount, 
  retry, 
  shortAddress,
  ensureDirectory,
  fileExists,
  formatSol
} from '../utils/helpers';
import { DEFAULT_CONFIG, WALLET_CONFIG, WalletInfo } from '../config/constants';

// ============================================================
// TYPES
// ============================================================

interface EncryptedWalletData {
  publicKey: string;
  encryptedPrivateKey: string;
  encryptedSeedPhrase?: string;
  index: number;
  label?: string;
  createdAt: number;
  version: string;
}

interface WalletFile {
  wallets: EncryptedWalletData[];
  totalWallets: number;
  mainWallet?: EncryptedWalletData;
  createdAt: number;
  updatedAt: number;
}

interface WalletWithBalance extends WalletInfo {
  solBalance: number;
  tokenBalance?: number;
  isFunded: boolean;
}

// ============================================================
// MAIN WALLET MANAGER CLASS
// ============================================================

export class WalletManager {
  private connection: Connection;
  private wallets: WalletInfo[] = [];
  private mainWallet: WalletInfo | null = null;
  private walletFolder: string;
  private encryptionPassword: string;
  private isInitialized: boolean = false;

  constructor(
    connection: Connection,
    encryptionPassword: string,
    walletFolder: string = WALLET_CONFIG.walletFolder
  ) {
    this.connection = connection;
    this.encryptionPassword = encryptionPassword;
    this.walletFolder = walletFolder;
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    await ensureDirectory(this.walletFolder);
    this.isInitialized = true;
    logger.success('Wallet Manager initialized', { 
      folder: this.walletFolder 
    });
  }

  // ============================================================
  // WALLET GENERATION - FIXED
  // ============================================================

  generateWallet(index: number, label?: string): WalletInfo {
    // Generate mnemonic (12 words)
    const mnemonic = generateMnemonic(128);
    const seed = mnemonicToSeedSync(mnemonic);
    
    // Derive keypair from seed - FIXED PATH FORMAT
    const path = `m/44'/501'/${index}'/0'`;
    const derivedSeed = derivePath(path, seed.toString('hex')).key;
    const keypair = Keypair.fromSeed(derivedSeed);
    
    const wallet: WalletInfo = {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: Buffer.from(keypair.secretKey).toString('base64'),
      seedPhrase: mnemonic,
      balance: 0,
      tokenBalance: 0,
      index,
      label: label || `Wallet_${index + 1}`
    };
    
    return wallet;
  }

  generateWallets(count: number = DEFAULT_CONFIG.numberOfWallets): WalletInfo[] {
    logger.info(`Generating ${count} wallets...`);
    
    const wallets: WalletInfo[] = [];
    const startTime = Date.now();
    
    for (let i = 0; i < count; i++) {
      const wallet = this.generateWallet(i);
      wallets.push(wallet);
      
      if ((i + 1) % 10 === 0 || i === count - 1) {
        logger.progress(i + 1, count, 'Generating wallets');
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.success(`Generated ${count} wallets in ${duration}s`);
    
    this.wallets = wallets;
    return wallets;
  }

  generateWalletsWithLabels(count: number, labels: string[]): WalletInfo[] {
    const wallets = this.generateWallets(count);
    wallets.forEach((wallet, index) => {
      if (index < labels.length) {
        wallet.label = labels[index];
      }
    });
    this.wallets = wallets;
    return wallets;
  }

  importWallet(privateKeyBase64: string, index: number, label?: string): WalletInfo {
    const secretKey = Buffer.from(privateKeyBase64, 'base64');
    const keypair = Keypair.fromSecretKey(secretKey);
    
    const wallet: WalletInfo = {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: privateKeyBase64,
      balance: 0,
      tokenBalance: 0,
      index,
      label: label || `Imported_Wallet_${index + 1}`
    };
    
    this.wallets.push(wallet);
    return wallet;
  }

  importWalletFromSeed(seedPhrase: string, index: number, label?: string): WalletInfo {
    if (!validateMnemonic(seedPhrase)) {
      throw new Error('Invalid seed phrase');
    }
    
    const seed = mnemonicToSeedSync(seedPhrase);
    // FIXED PATH FORMAT
    const path = `m/44'/501'/${index}'/0'`;
    const derivedSeed = derivePath(path, seed.toString('hex')).key;
    const keypair = Keypair.fromSeed(derivedSeed);
    
    const wallet: WalletInfo = {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: Buffer.from(keypair.secretKey).toString('base64'),
      seedPhrase: seedPhrase,
      balance: 0,
      tokenBalance: 0,
      index,
      label: label || `Imported_Wallet_${index + 1}`
    };
    
    this.wallets.push(wallet);
    return wallet;
  }

  async createMainWallet(privateKeyBase64?: string): Promise<WalletInfo> {
    if (privateKeyBase64) {
      const wallet = this.importWallet(privateKeyBase64, -1, 'Main_Wallet');
      this.mainWallet = wallet;
      logger.success('Main wallet imported', { 
        address: shortAddress(wallet.publicKey) 
      });
      return wallet;
    }
    
    // Generate new main wallet - FIXED: use index -1 but proper path
    const mnemonic = generateMnemonic(128);
    const seed = mnemonicToSeedSync(mnemonic);
    const path = `m/44'/501'/0'/0'`;  // Main wallet uses index 0
    const derivedSeed = derivePath(path, seed.toString('hex')).key;
    const keypair = Keypair.fromSeed(derivedSeed);
    
    const wallet: WalletInfo = {
      publicKey: keypair.publicKey.toBase58(),
      privateKey: Buffer.from(keypair.secretKey).toString('base64'),
      seedPhrase: mnemonic,
      balance: 0,
      tokenBalance: 0,
      index: -1,
      label: 'Main_Wallet'
    };
    
    this.mainWallet = wallet;
    logger.success('Main wallet generated', { 
      address: shortAddress(wallet.publicKey)
    });
    return wallet;
  }

  // ============================================================
  // ENCRYPTION
  // ============================================================

  private encryptData(data: string): string {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(
      this.encryptionPassword,
      salt,
      100000,
      32,
      'sha256'
    );
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    const combined = Buffer.concat([
      salt,
      iv,
      Buffer.from(encrypted, 'base64')
    ]);
    
    return combined.toString('base64');
  }

  private decryptData(encryptedData: string): string {
    const combined = Buffer.from(encryptedData, 'base64');
    
    const salt = combined.subarray(0, 16);
    const iv = combined.subarray(16, 32);
    const encrypted = combined.subarray(32);
    
    const key = crypto.pbkdf2Sync(
      this.encryptionPassword,
      salt,
      100000,
      32,
      'sha256'
    );
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decrypted = decipher.update(encrypted.toString('base64'), 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  private encryptWallet(wallet: WalletInfo): EncryptedWalletData {
    return {
      publicKey: wallet.publicKey,
      encryptedPrivateKey: this.encryptData(wallet.privateKey),
      encryptedSeedPhrase: wallet.seedPhrase ? this.encryptData(wallet.seedPhrase) : undefined,
      index: wallet.index,
      label: wallet.label,
      createdAt: Date.now(),
      version: '1.0.0'
    };
  }

  private decryptWallet(encrypted: EncryptedWalletData): WalletInfo {
    return {
      publicKey: encrypted.publicKey,
      privateKey: this.decryptData(encrypted.encryptedPrivateKey),
      seedPhrase: encrypted.encryptedSeedPhrase ? this.decryptData(encrypted.encryptedSeedPhrase) : undefined,
      balance: 0,
      tokenBalance: 0,
      index: encrypted.index,
      label: encrypted.label
    };
  }

  // ============================================================
  // STORAGE
  // ============================================================

  async saveWallets(filename: string = 'wallets.json'): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const filePath = path.join(this.walletFolder, filename);
    
    const encryptedWallets = this.wallets.map(w => this.encryptWallet(w));
    const encryptedMainWallet = this.mainWallet ? this.encryptWallet(this.mainWallet) : undefined;
    
    const data: WalletFile = {
      wallets: encryptedWallets,
      totalWallets: encryptedWallets.length,
      mainWallet: encryptedMainWallet,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    logger.success(`Wallets saved to ${filePath}`, {
      count: data.totalWallets
    });
  }

  async loadWallets(filename: string = 'wallets.json'): Promise<WalletInfo[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const filePath = path.join(this.walletFolder, filename);
    
    if (!await fileExists(filePath)) {
      throw new Error(`Wallet file not found: ${filePath}`);
    }
    
    const content = await fs.readFile(filePath, 'utf-8');
    const data: WalletFile = JSON.parse(content);
    
    const wallets = data.wallets.map(w => this.decryptWallet(w));
    this.wallets = wallets;
    
    if (data.mainWallet) {
      this.mainWallet = this.decryptWallet(data.mainWallet);
    }
    
    logger.success(`Wallets loaded from ${filePath}`, {
      count: wallets.length
    });
    
    return wallets;
  }

  async exportAddresses(filename: string = 'addresses.txt'): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const filePath = path.join(this.walletFolder, filename);
    
    let output = '===== AERTH BUNDLER - WALLET ADDRESSES =====\n\n';
    output += `Generated: ${new Date().toLocaleString()}\n`;
    output += `Total Wallets: ${this.wallets.length}\n\n`;
    
    if (this.mainWallet) {
      output += `MAIN WALLET:\n`;
      output += `  Address: ${this.mainWallet.publicKey}\n`;
      output += `  Label: ${this.mainWallet.label}\n\n`;
    }
    
    output += `SUB WALLETS (${this.wallets.length}):\n`;
    this.wallets.forEach((wallet, index) => {
      output += `${index + 1}. ${wallet.publicKey}`;
      if (wallet.label) output += ` (${wallet.label})`;
      output += '\n';
    });
    
    output += '\n===== END =====\n';
    
    await fs.writeFile(filePath, output);
    logger.success(`Addresses exported to ${filePath}`, {
      count: this.wallets.length
    });
  }

  // ============================================================
  // BALANCE CHECKING
  // ============================================================

  async getBalance(wallet: WalletInfo): Promise<number> {
    try {
      const publicKey = new PublicKey(wallet.publicKey);
      const balance = await this.connection.getBalance(publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error(`Failed to get balance for ${shortAddress(wallet.publicKey)}`, error);
      return 0;
    }
  }

  async getAllBalances(): Promise<WalletWithBalance[]> {
    const results: WalletWithBalance[] = [];
    
    for (const wallet of this.wallets) {
      const solBalance = await this.getBalance(wallet);
      results.push({
        ...wallet,
        solBalance,
        tokenBalance: wallet.tokenBalance || 0,
        isFunded: solBalance > 0.001
      });
    }
    
    return results;
  }

  async checkAllFunded(minBalance: number = 0.001): Promise<boolean> {
    const balances = await this.getAllBalances();
    const unfunded = balances.filter(w => w.solBalance < minBalance);
    
    if (unfunded.length === 0) {
      logger.success('All wallets are funded');
      return true;
    }
    
    logger.warn(`${unfunded.length} wallets are not funded`, {
      minRequired: minBalance,
      unfunded: unfunded.map(w => ({
        address: shortAddress(w.publicKey),
        balance: w.solBalance
      }))
    });
    
    return false;
  }

  // ============================================================
  // FUNDING
  // ============================================================

  async distributeSOL(
    amountPerWallet: number | 'random' = 'random',
    minAmount: number = 0.05,
    maxAmount: number = 0.5
  ): Promise<{
    totalDistributed: number;
    transactions: Array<{ wallet: string; amount: number; signature: string }>;
  }> {
    if (!this.mainWallet) {
      throw new Error('Main wallet not set. Call createMainWallet() first.');
    }
    
    if (this.wallets.length === 0) {
      throw new Error('No sub wallets to fund. Generate wallets first.');
    }
    
    const mainBalance = await this.getBalance(this.mainWallet);
    const totalNeeded = this.wallets.length * (typeof amountPerWallet === 'number' ? amountPerWallet : maxAmount);
    
    if (mainBalance < totalNeeded) {
      throw new Error(
        `Insufficient balance in main wallet. ` +
        `Have: ${formatSol(mainBalance)}, Need: ${formatSol(totalNeeded)}`
      );
    }
    
    logger.info(`Distributing SOL to ${this.wallets.length} wallets...`);
    logger.info(`Main wallet balance: ${formatSol(mainBalance)}`);
    
    const transactions: Array<{ wallet: string; amount: number; signature: string }> = [];
    let totalDistributed = 0;
    
    const batchSize = 5;
    const batches = [];
    for (let i = 0; i < this.wallets.length; i += batchSize) {
      batches.push(this.wallets.slice(i, i + batchSize));
    }
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      logger.progress(
        batchIndex * batchSize + 1,
        this.wallets.length,
        'Distributing SOL'
      );
      
      for (const wallet of batch) {
        let amount: number;
        if (amountPerWallet === 'random') {
          amount = randomSolAmount(minAmount, maxAmount);
        } else {
          amount = amountPerWallet;
        }
        
        const remaining = mainBalance - totalDistributed;
        if (amount > remaining * 0.8) {
          amount = remaining * 0.8 / (this.wallets.length - transactions.length);
        }
        
        try {
          const signature = await this.sendTransaction(
            this.mainWallet,
            wallet,
            amount
          );
          
          transactions.push({
            wallet: shortAddress(wallet.publicKey),
            amount,
            signature
          });
          
          totalDistributed += amount;
          wallet.balance += amount;
          
          logger.debug(`Sent ${formatSol(amount)} to ${shortAddress(wallet.publicKey)}`);
          await sleep(500);
          
        } catch (error) {
          logger.error(`Failed to send SOL to ${shortAddress(wallet.publicKey)}`, error);
        }
      }
      
      if (batchIndex < batches.length - 1) {
        await sleep(2000);
      }
    }
    
    logger.success(`Distributed ${formatSol(totalDistributed)} to ${transactions.length} wallets`);
    
    return {
      totalDistributed,
      transactions
    };
  }

  private async sendTransaction(
    from: WalletInfo,
    to: WalletInfo,
    amount: number
  ): Promise<string> {
    const fromKeypair = Keypair.fromSecretKey(
      Buffer.from(from.privateKey, 'base64')
    );
    const toPublicKey = new PublicKey(to.publicKey);
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: toPublicKey,
        lamports: amount * LAMPORTS_PER_SOL
      })
    );
    
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [fromKeypair]
    );
    
    return signature;
  }

  // ============================================================
  // UTILITY FUNCTIONS
  // ============================================================

  getAddresses(): string[] {
    return this.wallets.map(w => w.publicKey);
  }

  getWallets(): WalletInfo[] {
    return this.wallets;
  }

  getWalletByIndex(index: number): WalletInfo | undefined {
    return this.wallets.find(w => w.index === index);
  }

  getWalletByAddress(address: string): WalletInfo | undefined {
    return this.wallets.find(w => w.publicKey === address);
  }

  getMainWallet(): WalletInfo | null {
    return this.mainWallet;
  }

  getTotalWallets(): number {
    return this.wallets.length;
  }

  clearWallets(): void {
    this.wallets = [];
    logger.info('Wallets cleared from memory');
  }

  async deleteWalletFile(filename: string = 'wallets.json'): Promise<void> {
    const filePath = path.join(this.walletFolder, filename);
    if (await fileExists(filePath)) {
      await fs.unlink(filePath);
      logger.warn(`Wallet file deleted: ${filePath}`);
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================

  async getSummary(): Promise<{
    totalWallets: number;
    mainWallet: string | null;
    fundedWallets: number;
    totalBalance: number;
    averageBalance: number;
  }> {
    const balances = await this.getAllBalances();
    const funded = balances.filter(w => w.isFunded);
    const totalBalance = balances.reduce((sum, w) => sum + w.solBalance, 0);
    
    return {
      totalWallets: this.wallets.length,
      mainWallet: this.mainWallet?.publicKey || null,
      fundedWallets: funded.length,
      totalBalance,
      averageBalance: this.wallets.length > 0 ? totalBalance / this.wallets.length : 0
    };
  }

  async printSummary(): Promise<void> {
    const summary = await this.getSummary();
    
    logger.section('WALLET SUMMARY');
    console.log(`  Total Wallets:    ${summary.totalWallets}`);
    console.log(`  Funded Wallets:   ${summary.fundedWallets}`);
    console.log(`  Total Balance:    ${formatSol(summary.totalBalance)}`);
    console.log(`  Average Balance:  ${formatSol(summary.averageBalance)}`);
    if (summary.mainWallet) {
      console.log(`  Main Wallet:      ${shortAddress(summary.mainWallet)}`);
    }
    logger.divider('═');
  }
}

export default WalletManager;