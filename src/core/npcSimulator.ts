/**
 * AERTH BUNDLER - NPC (simulated outside buyer) Simulator
 *
 * Devnet-only rehearsal aid: a couple of wallets deliberately NOT part of
 * the bundled wallet set, generated separately (see
 * scripts/generateNpcWallets.ts) and funded by hand. Each one randomly buys
 * in within the first minute or two, then independently and randomly either
 * holds forever or sells later - standing in for a real outside buyer
 * discovering the token, so a devnet rehearsal isn't only ever the
 * bundler's own wallets trading with themselves.
 *
 * Because a buy sends real SOL to the vault (the main wallet) in exchange
 * for tokens, whatever these wallets buy in with is already real profit
 * sitting in the main wallet regardless of what they do afterward - no
 * special accounting needed for "if they hold and we close out, we keep
 * their SOL." If an NPC wallet later sells, that's a real, ordinary sell
 * like any other - it's simply never included in the bundled wallets'
 * mass-exit sell-off, since ExitStrategy only ever reads from the bundled
 * wallet set.
 *
 * HARD gated to devnet: this must never run against mainnet, where "a random
 * person buying in" would mean spending real SOL that isn't actually a real
 * outside buyer. Checked both by the isDevnet flag passed in AND directly
 * against NETWORK, so a wrong flag upstream can't accidentally enable this
 * on a real run.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { WalletManager } from './walletManager';
import LocalMarket from './localMarket';
import { logger } from '../utils/logger';
import { randomNumber, shortAddress, formatSol, fileExists } from '../utils/helpers';
import { WalletInfo } from '../config/constants';

const NPC_WALLET_FOLDER = './npc-wallets';

export class NpcSimulator {
  private connection: Connection;
  private market: LocalMarket;
  private isDevnet: boolean;
  private encryptionPassword: string;

  constructor(connection: Connection, market: LocalMarket, isDevnet: boolean, encryptionPassword: string) {
    this.connection = connection;
    this.market = market;
    this.isDevnet = isDevnet;
    this.encryptionPassword = encryptionPassword;
  }

  /**
   * Fire-and-forget - deliberately not awaited by the caller, since this is
   * a background rehearsal aid, not a step the real bundler flow depends on.
   */
  async start(): Promise<void> {
    if (!this.isDevnet || process.env.NETWORK === 'mainnet') {
      logger.debug('NPC simulator skipped - not a devnet run');
      return;
    }

    const walletsFile = `${NPC_WALLET_FOLDER}/wallets.json`;
    if (!(await fileExists(walletsFile))) {
      // Feature is entirely opt-in by presence of this file - most runs
      // won't have it, and that's fine, silently do nothing.
      return;
    }

    let wallets: WalletInfo[];
    try {
      const wm = new WalletManager(this.connection, this.encryptionPassword, NPC_WALLET_FOLDER);
      await wm.initialize();
      wallets = await wm.loadWallets();
    } catch (error) {
      logger.debug('NPC simulator: failed to load npc-wallets', error);
      return;
    }

    if (wallets.length === 0) return;

    logger.info(`NPC simulator active - ${wallets.length} simulated outside buyer(s) (devnet only)`);

    for (const wallet of wallets) {
      // Independent per-wallet timeline - each buys in at its own random
      // moment within the first 1-2 minutes, not all at once.
      this.runOne(wallet).catch((error) =>
        logger.debug(`NPC wallet ${shortAddress(wallet.publicKey)} errored`, error)
      );
    }
  }

  private async runOne(wallet: WalletInfo): Promise<void> {
    await this.sleep(randomNumber(5, 120) * 1000);

    const solBalance = await this.connection.getBalance(new PublicKey(wallet.publicKey)) / 1e9;

    const affordable = Math.max(0, solBalance - 0.01);
    if (affordable < 0.01) {
      logger.debug(`NPC wallet ${shortAddress(wallet.publicKey)} has no funded balance, skipping`);
      return;
    }

    const buyAmount = affordable * randomNumber(0.5, 0.9);
    const result = await this.market.buy(wallet, buyAmount);
    if (!result.success) {
      logger.debug(`NPC buy failed for ${shortAddress(wallet.publicKey)}: ${result.error}`);
      return;
    }

    logger.trade(`🧑 NPC BUY ${formatSol(result.solAmount)} by ${shortAddress(wallet.publicKey)} (simulated outside buyer)`);

    // Randomly hold forever, or sell later - genuinely doesn't matter which,
    // this is just meant to look like independent, unpredictable behavior.
    if (Math.random() < 0.5) {
      return; // holds
    }

    await this.sleep(randomNumber(30, 300) * 1000);

    const tokenBalance = await this.market.getTokenBalance(wallet);
    if (tokenBalance <= 0) return;

    const sellAmount = tokenBalance * randomNumber(0.3, 1);
    const sellResult = await this.market.sell(wallet, sellAmount);
    if (sellResult.success) {
      logger.trade(`🧑 NPC SELL ${formatSol(sellResult.solAmount)} by ${shortAddress(wallet.publicKey)} (simulated outside buyer)`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default NpcSimulator;
