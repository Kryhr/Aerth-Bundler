/**
 * AERTH BUNDLER - Constants & Configuration
 * All program IDs, endpoints, and default parameters
 */

import { PublicKey } from '@solana/web3.js';

// ============================================================
// NETWORK CONFIGURATION
// ============================================================

export const NETWORKS = {
  devnet: {
    endpoint: 'https://api.devnet.solana.com',
    wsEndpoint: 'wss://api.devnet.solana.com',
    name: 'devnet'
  },
  mainnet: {
    endpoint: 'https://api.mainnet-beta.solana.com',
    wsEndpoint: 'wss://api.mainnet-beta.solana.com',
    name: 'mainnet-beta'
  }
} as const;

export type Network = keyof typeof NETWORKS;

// ============================================================
// PROGRAM IDs (Solana Mainnet)
// ============================================================

// Raydium Program IDs
export const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
export const RAYDIUM_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

// Token Program IDs
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// System Program
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// ============================================================
// TOKEN LAUNCH PLATFORMS
// ============================================================

export const PLATFORMS = {
  raydium: {
    name: 'Raydium',
    programId: RAYDIUM_PROGRAM_ID,
    authority: RAYDIUM_AUTHORITY,
    // Fee structure
    feeRecipient: new PublicKey('7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5'),
    // Default pool creation fee (in SOL)
    poolCreationFee: 0.5
  },
  pumpfun: {
    name: 'Pump.fun',
    programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    // Not fully implemented yet, but placeholder
  }
} as const;

export type LaunchPlatform = keyof typeof PLATFORMS;

// ============================================================
// DEFAULT CONFIGURATION PARAMETERS
// ============================================================

export const DEFAULT_CONFIG = {
  // Wallet Settings
  numberOfWallets: 10,
  minBuyAmount: 0.05,     // SOL
  maxBuyAmount: 0.5,      // SOL
  
  // Token Settings
  tokenNamePrefix: 'LARP',  // Will generate LARP1, LARP2, etc.
  tokenSymbolPrefix: 'LP',  // Will generate LP1, LP2, etc.
  initialLiquidity: 1.0,    // SOL to add as initial liquidity
  
  // Trading Settings
  minTransactionAmount: 0.001,  // SOL (minimum trade)
  maxTransactionAmount: 0.1,    // SOL (maximum trade)
  volumeTradeInterval: 30000,   // Milliseconds between volume trades (30s)
  
  // Exit Strategy
  targetMultiplier: 3.0,    // 3x profit target
  exitTimerHours: 5,        // Auto-exit after 5 hours
  maxSlippage: 50,          // Percent (50% to ensure execution)
  
  // Transaction Settings
  priorityFee: 0.0001,      // SOL
  computeUnitLimit: 200000, // For complex transactions
  maxRetries: 3,
  
  // Logging
  logLevel: 'info' as const
} as const;

// ============================================================
// ERROR CODES
// ============================================================

export const ERROR_CODES = {
  WALLET_GENERATION_FAILED: 'WALLET_001',
  INSUFFICIENT_BALANCE: 'WALLET_002',
  TOKEN_CREATION_FAILED: 'TOKEN_001',
  LIQUIDITY_ADD_FAILED: 'TOKEN_002',
  SWAP_FAILED: 'SWAP_001',
  BUNDLE_BUY_FAILED: 'BUNDLE_001',
  BUNDLE_SELL_FAILED: 'BUNDLE_002',
  VOLUME_SIMULATION_FAILED: 'VOLUME_001',
  EXIT_FAILED: 'EXIT_001',
  RPC_CONNECTION_FAILED: 'RPC_001'
} as const;

// ============================================================
// TOKEN NAME PRESETS (Fallback when no API)
// ============================================================

export const TOKEN_NAME_PRESETS = [
  // LARP themed
  'LARPAI',
  'LARPER',
  'AILARPER',
  'LARPBOI',
  'LARPCHAD',
  'LARPGOAT',
  'LARPWIF',
  'LARPMOON',
  'LARPDEGEN',
  'LARPBRRR',
  
  // AI themed
  'AIGENT',
  'AIBOT',
  'AIMEME',
  'AICHAD',
  'AILORD',
  'AIPEPE',
  'AIGOAT',
  
  // Meme themed
  'DUMBAGENT',
  'BRAINROT',
  'VIRALBOI',
  'CHADWIF',
  'PEPEAUX',
  'MOONBOI',
  'DEGENX',
  'GOATWIF',
  'SMARTMONKEY',
  'DOGEWIF',
  'SHIBWIF',
  'FLOKIBOI',
  
  // Custom creative
  'ANONBOI',
  'MAXIBOI',
  'APEWIF',
  'COINWIF',
  'MEMEWIF',
  'STONKS',
  'HODLBOI',
  'WAGMI',
  'NGMI',
  'GMER',
  'FRENBOI',
  'CHILLGUY',
  'BASEDBOI',
  'RUGWIF'
];

// ============================================================
// WALLET GENERATION CONSTANTS
// ============================================================

export const WALLET_CONFIG = {
  // BIP39 mnemonic path
  derivationPath: "m/44'/501'/0'/0'",
  // Encryption salt (change this)
  encryptionSalt: 'AERTH_BUNDLER_SALT_2024',
  // Default wallet file extension
  walletFileExtension: '.json',
  // Wallet folder
  walletFolder: './wallets'
} as const;

// ============================================================
// DASHBOARD CONFIG
// ============================================================

export const DASHBOARD_CONFIG = {
  port: 3000,
  refreshInterval: 1000, // 1 second refresh
  enabled: true
} as const;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Get random token name from presets
 */
export function getRandomTokenName(): string {
  const randomIndex = Math.floor(Math.random() * TOKEN_NAME_PRESETS.length);
  return TOKEN_NAME_PRESETS[randomIndex];
}

/**
 * Generate token name with prefix
 */
export function generateTokenName(prefix: string = DEFAULT_CONFIG.tokenNamePrefix): string {
  const randomSuffix = Math.floor(Math.random() * 1000);
  const presetName = getRandomTokenName();
  
  // 70% chance to use preset name, 30% to generate with prefix
  if (Math.random() < 0.7) {
    return presetName;
  }
  
  return `${prefix}${randomSuffix}`;
}

/**
 * Generate token symbol
 */
export function generateTokenSymbol(prefix: string = DEFAULT_CONFIG.tokenSymbolPrefix): string {
  const randomSuffix = Math.floor(Math.random() * 100);
  return `${prefix}${randomSuffix}`;
}

// ============================================================
// TYPE DEFINITIONS
// ============================================================

export interface TokenConfig {
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  initialLiquidity: number;
}

export interface WalletInfo {
  publicKey: string;
  privateKey: string;
  seedPhrase?: string;  // For backup
  balance: number;      // In SOL
  tokenBalance: number; // In token units
  index: number;
  label?: string;
}

export interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
  timestamp: number;
}

export interface BundleStats {
  totalWallets: number;
  totalSolInvested: number;
  totalTokensHeld: number;
  currentPrice: number;
  currentMultiplier: number;
  liquidity: number;
  volume24h: number;
  timeRemaining: number; // In seconds
}