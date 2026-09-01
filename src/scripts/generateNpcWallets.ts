/**
 * AERTH BUNDLER - Generate NPC (simulated outside buyer) wallets
 *
 * These are DELIBERATELY separate from the bundled wallet set (./wallets) -
 * they represent random "real" outside buyers for devnet rehearsal only, not
 * wallets the bundler itself controls or sweeps. Stored in their own folder
 * so there's no chance of them ever being touched by the bundled-wallet exit
 * logic, which only ever reads from ./wallets.
 *
 * Usage:
 *   npx tsx src/scripts/generateNpcWallets.ts            create the initial set (default 2)
 *   npx tsx src/scripts/generateNpcWallets.ts --add 2     add 2 MORE wallets, keeping existing ones
 *
 * After running, fund the printed addresses yourself via a devnet faucet
 * (2-5 SOL each, as planned) - this script only generates them.
 */
import dotenv from 'dotenv';
import { WalletManager } from '../core/walletManager';
import { log } from '../utils/logger';
import { WalletInfo } from '../config/constants';

dotenv.config();

const NPC_WALLET_FOLDER = './npc-wallets';

async function generateNpcWallets() {
  const wm = new WalletManager(
    null as any,
    process.env.WALLET_ENCRYPTION_PASSWORD || 'default_password',
    NPC_WALLET_FOLDER
  );
  await wm.initialize();

  const addIndex = process.argv.indexOf('--add');
  const addCount = addIndex !== -1 ? parseInt(process.argv[addIndex + 1] || '2', 10) : null;

  let existing: WalletInfo[] = [];
  try {
    existing = await wm.loadWallets();
  } catch {
    // No existing file yet - fine, this is the first run.
  }

  if (addCount === null && existing.length > 0) {
    log.warn(`${existing.length} NPC wallet(s) already exist in ${NPC_WALLET_FOLDER}/ - re-run with --add <count> to add more without touching them (this command doesn't overwrite by default anymore).`);
    return;
  }

  const countToCreate = addCount !== null ? addCount : 2;
  const startIndex = existing.length;

  const newWallets: WalletInfo[] = [];
  for (let i = 0; i < countToCreate; i++) {
    const idx = startIndex + i;
    newWallets.push(wm.generateWallet(idx, `NPC_Buyer_${idx + 1}`));
  }

  // getWallets() returns the manager's live array - append rather than
  // replace it, so existing wallets (and whatever's already funded into
  // them) are never lost.
  wm.getWallets().push(...newWallets);

  await wm.saveWallets();
  await wm.exportAddresses();

  log.success(`${addCount !== null ? 'Added' : 'Generated'} ${newWallets.length} NPC wallet(s) - ${wm.getWallets().length} total in ${NPC_WALLET_FOLDER}/`);
  newWallets.forEach((w) => {
    console.log(`  ${w.label}: ${w.publicKey}`);
  });
  console.log('\nFund these with devnet SOL (2-5 each) - the NPC simulator picks up whatever balance exists automatically on the next launch.');
}

generateNpcWallets().catch(console.error);
