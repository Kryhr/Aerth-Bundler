/**
 * AERTH BUNDLER - Helper Utilities
 * Common utility functions for the entire system
 */

import { PublicKey } from '@solana/web3.js';
import { logger } from './logger';

// ============================================================
// SOL / LAMPORT CONVERSIONS
// ============================================================

/**
 * Convert SOL to lamports (1 SOL = 1,000,000,000 lamports)
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * 1_000_000_000);
}

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: number): number {
  return lamports / 1_000_000_000;
}

/**
 * Format SOL with proper decimal places
 */
export function formatSol(amount: number): string {
  if (amount >= 1) {
    return `${amount.toFixed(2)} SOL`;
  } else if (amount >= 0.001) {
    return `${(amount * 1000).toFixed(2)} mSOL`;
  } else {
    return `${(amount * 1_000_000).toFixed(0)} µSOL`;
  }
}

/**
 * Format a USD amount the way Axiom/pump.fun style their market cap
 * ($16.2K, $1.4M) - devnet has no real price feed, so this is fed a fixed
 * assumed SOL/USD rate purely for realistic-looking display, never for
 * trading math.
 */
export function formatUsd(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Format token amount with proper decimals
 */
export function formatToken(amount: number, decimals: number = 9): string {
  const formatted = amount / Math.pow(10, decimals);
  if (formatted >= 1000) {
    return `${formatted.toFixed(2)} tokens`;
  } else if (formatted >= 1) {
    return `${formatted.toFixed(2)} tokens`;
  } else if (formatted >= 0.001) {
    return `${formatted.toFixed(4)} tokens`;
  } else {
    return `${formatted.toFixed(6)} tokens`;
  }
}

/**
 * Format price with $ sign
 */
export function formatPrice(price: number): string {
  if (price < 0.000001) {
    return `$${price.toFixed(9)}`;
  } else if (price < 0.001) {
    return `$${price.toFixed(6)}`;
  } else if (price < 1) {
    return `$${price.toFixed(4)}`;
  } else if (price < 1000) {
    return `$${price.toFixed(2)}`;
  } else {
    return `$${price.toFixed(0)}`;
  }
}

// ============================================================
// RANDOM NUMBER GENERATION
// ============================================================

/**
 * Generate random number between min and max (inclusive)
 */
export function randomNumber(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Generate random integer between min and max (inclusive)
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(randomNumber(min, max + 1));
}

/**
 * Generate random SOL amount for buys (between min and max)
 */
export function randomSolAmount(min: number, max: number): number {
  // Use 2 decimal places for realistic amounts
  return Math.round(randomNumber(min, max) * 100) / 100;
}

/**
 * Generate random percentage (0-100)
 */
export function randomPercentage(): number {
  return Math.round(randomNumber(0, 100));
}

/**
 * Generate random multiplier (1-10)
 */
export function randomMultiplier(min: number = 1, max: number = 10): number {
  return Math.round(randomNumber(min, max) * 10) / 10;
}

// ============================================================
// DELAY / SLEEP FUNCTIONS
// ============================================================

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sleep with random delay between min and max milliseconds
 */
export function sleepRandom(min: number, max: number): Promise<void> {
  return sleep(randomInt(min, max));
}

/**
 * Delay with progress logging
 */
export async function sleepWithProgress(
  ms: number, 
  label: string = 'Waiting', 
  step: number = 1000
): Promise<void> {
  const steps = Math.floor(ms / step);
  for (let i = 0; i < steps; i++) {
    const remaining = ((steps - i) * step) / 1000;
    if (i % 5 === 0) {
      logger.debug(`${label}: ${remaining.toFixed(0)}s remaining`);
    }
    await sleep(step);
  }
  // Sleep remaining time
  const remaining = ms % step;
  if (remaining > 0) {
    await sleep(remaining);
  }
}

// ============================================================
// RETRY LOGIC
// ============================================================

/**
 * Retry an async function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000,
  backoffFactor: number = 2
): Promise<T> {
  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxRetries) {
        break;
      }

      logger.debug(`Retry ${attempt}/${maxRetries} failed, waiting ${delay}ms`, {
        error: lastError.message
      });

      await sleep(delay);
      delay *= backoffFactor;
    }
  }

  throw lastError!;
}

/**
 * Retry with exponential backoff and jitter
 */
export async function retryWithJitter<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000,
  maxDelay: number = 30000
): Promise<T> {
  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxRetries) {
        break;
      }

      // Add jitter to prevent thundering herd
      const jitter = randomNumber(0.8, 1.2);
      const actualDelay = Math.min(delay * jitter, maxDelay);
      
      logger.debug(`Retry ${attempt}/${maxRetries} failed, waiting ${actualDelay.toFixed(0)}ms`, {
        error: lastError.message
      });

      await sleep(actualDelay);
      delay *= 2;
    }
  }

  throw lastError!;
}

// ============================================================
// ADDRESS VALIDATION
// ============================================================

/**
 * Validate if string is a valid Solana public key
 */
export function isValidAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Truncate address for display
 */
export function truncateAddress(address: string, length: number = 6): string {
  if (address.length <= length * 2 + 2) {
    return address;
  }
  return `${address.slice(0, length)}...${address.slice(-length)}`;
}

/**
 * Shorten address with format: 7F9...3A1
 */
export function shortAddress(address: string): string {
  return truncateAddress(address, 4);
}

// ============================================================
// ARRAY HELPERS
// ============================================================

/**
 * Shuffle array (Fisher-Yates algorithm)
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Split array into chunks
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Get random item from array
 */
export function randomItem<T>(array: T[]): T {
  return array[randomInt(0, array.length - 1)];
}

/**
 * Get random items from array (n items)
 */
export function randomItems<T>(array: T[], n: number): T[] {
  const shuffled = shuffleArray(array);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

/**
 * Remove duplicates from array
 */
export function uniqueItems<T>(array: T[]): T[] {
  return [...new Set(array)];
}

/**
 * Group array by key
 */
export function groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
  return array.reduce((groups, item) => {
    const groupKey = String(item[key]);
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}

// ============================================================
// NUMBER HELPERS
// ============================================================

/**
 * Clamp number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Round to decimal places
 */
export function roundTo(value: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Check if number is within range
 */
export function isInRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Convert percentage to decimal
 */
export function percentToDecimal(percent: number): number {
  return percent / 100;
}

/**
 * Convert decimal to percentage
 */
export function decimalToPercent(decimal: number): number {
  return decimal * 100;
}

// ============================================================
// STRING HELPERS
// ============================================================

/**
 * Capitalize first letter
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Truncate string with ellipsis
 */
export function truncateString(str: string, length: number = 50): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + '...';
}

/**
 * Generate random string
 */
export function randomString(length: number = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(randomInt(0, chars.length - 1));
  }
  return result;
}

/**
 * Generate random token symbol
 */
export function randomTokenSymbol(prefix: string = 'LP'): string {
  const suffix = randomString(3).toUpperCase();
  return `${prefix}${suffix}`;
}

/**
 * Generate random token name
 */
export function randomTokenName(prefix: string = 'LARP'): string {
  const suffixes = [
    'AI', 'BOI', 'CHAD', 'GOAT', 'WIF', 'MOON', 'DEGEN', 
    'BRRR', 'PEPE', 'DOGE', 'SHIB', 'FLOKI', 'ANON', 'MAXI',
    'APE', 'STONK', 'HODL', 'WAGMI', 'FREN', 'BASED', 'RUG'
  ];
  const suffix = randomItem(suffixes);
  return `${prefix}${suffix}`;
}

// ============================================================
// TIME HELPERS
// ============================================================

/**
 * Get current timestamp in seconds
 */
export function timestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Get current timestamp in milliseconds
 */
export function timestampMillis(): number {
  return Date.now();
}

/**
 * Format time remaining
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds < 0) return '0s';
  
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Format date
 */
export function formatDate(date: Date = new Date()): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Calculate time difference in seconds
 */
export function timeDifferenceSeconds(start: number, end: number = Date.now()): number {
  return Math.floor((end - start) / 1000);
}

// ============================================================
// MEMORY HELPERS
// ============================================================

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Get memory usage
 */
export function getMemoryUsage(): string {
  const used = process.memoryUsage();
  return `Heap: ${formatBytes(used.heapUsed)} / ${formatBytes(used.heapTotal)}`;
}

// ============================================================
// FILE HELPERS
// ============================================================

/**
 * Ensure directory exists (async)
 */
import fs from 'fs/promises';

export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if ((error as any).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Check if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// BATCH PROCESSING
// ============================================================

/**
 * Process array in batches with delay between batches
 */
export async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  batchSize: number = 10,
  delayMs: number = 1000
): Promise<R[]> {
  const results: R[] = [];
  const chunks = chunkArray(items, batchSize);

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    logger.debug(`Processing batch ${i + 1}/${chunks.length} (${batch.length} items)`);
    
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    
    if (i < chunks.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return results;
}

// ============================================================
// RATE LIMITING
// ============================================================

/**
 * Simple rate limiter
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token
   */
  async consume(): Promise<boolean> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Consume a token or wait until available
   */
  async consumeOrWait(): Promise<void> {
    while (!(await this.consume())) {
      await sleep(100);
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refillAmount = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;
  }

  /**
   * Get current token count
   */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}

// ============================================================
// EXPORT ALL FUNCTIONS
// ============================================================

export default {
  // SOL conversions
  solToLamports,
  lamportsToSol,
  formatSol,
  formatToken,
  formatPrice,
  
  // Random
  randomNumber,
  randomInt,
  randomSolAmount,
  randomPercentage,
  randomMultiplier,
  
  // Delay
  sleep,
  sleepRandom,
  sleepWithProgress,
  
  // Retry
  retry,
  retryWithJitter,
  
  // Address
  isValidAddress,
  truncateAddress,
  shortAddress,
  
  // Array
  shuffleArray,
  chunkArray,
  randomItem,
  randomItems,
  uniqueItems,
  groupBy,
  
  // Number
  clamp,
  roundTo,
  isInRange,
  percentToDecimal,
  decimalToPercent,
  
  // String
  capitalize,
  truncateString,
  randomString,
  randomTokenSymbol,
  randomTokenName,
  
  // Time
  timestampSeconds,
  timestampMillis,
  formatTimeRemaining,
  formatDate,
  timeDifferenceSeconds,
  
  // Memory
  formatBytes,
  getMemoryUsage,
  
  // File
  ensureDirectory,
  fileExists,
  
  // Batch
  processBatch,
  
  // Rate Limiting
  RateLimiter
};