# AERTH BUNDLER

> Automated token launch, volume simulation, and coordinated exit on Solana

## ⚠️ DISCLAIMER

**This software is for educational purposes only.** Using this tool may violate terms of service of various platforms and could be illegal in your jurisdiction. Use at your own risk. The authors assume no liability for any misuse of this software.

## Devnet vs Mainnet - separate everything, on purpose

This app runs against **devnet** (fake SOL, safe rehearsal) or **mainnet**
(real SOL) via two distinct commands, and each network gets its own
**completely separate wallet folder** so a mainnet run can never touch your
devnet test wallets, or vice versa:

| Network | Command                | Wallet folder     |
| ------- | ---------------------- | ------------------ |
| Devnet  | `npm run start:devnet` | `./wallets`         |
| Mainnet | `npm run start:mainnet`| `./wallets-mainnet` |

You need **separate wallets for each network** - devnet wallets hold fake
SOL and are worthless on mainnet; you must generate a fresh set for a real
launch (see below). Keep testing on devnet as much as you want - it's
entirely unaffected by anything you do on mainnet, and vice versa.

## Quick Start (Devnet)

```bash
npm install
npx tsx src/scripts/generateWallets.ts --devnet   # or: npm run generate-wallets
# fund the printed main wallet address from https://solfaucet.com/
npm run fund
npm run start:devnet
```

## Going Live (Mainnet)

**Do this in order, carefully - this is real money.**

1. Generate a **fresh** mainnet wallet set (never reuse devnet wallets):
   ```bash
   npm run generate-wallets:mainnet
   ```
   This writes wallets to `./wallets-mainnet/` (encrypted, same as devnet)
   **and** a plaintext `./wallets-mainnet/SEED_PHRASES_BACKUP.txt` with every
   wallet's real seed phrase/private key. Move that file to secure offline
   storage (an encrypted USB drive, a password manager) once you've saved
   it - it's gitignored, but it's still a plaintext copy of every key on
   this machine. This exists so a lost password or corrupted wallet file
   can never mean lost funds.
2. Edit the token identity fields in `.env` (see below) - name, icon,
   Twitter, etc.
3. Fund the printed main wallet address with real SOL.
4. `npm run fund -- --mainnet`
5. `npm run start:mainnet`

**Note:** as of now, launching still uses this app's own local
bonding-curve simulation, not a real pump.fun listing - see
[PUMPFUN_INTEGRATION.md](PUMPFUN_INTEGRATION.md) for exactly what that
means and what's left to build before a mainnet run is actually
discoverable on pump.fun/Axiom. Don't run a real mainnet launch expecting
outside buyers to find it until that's done.

## Configuring the token - name, icon, socials

All in `.env`:

```bash
TOKEN_NAME=YourTokenName
TOKEN_SYMBOL=SYMB
TOKEN_ICON_PATH=./icon.png       # path to an image file
TOKEN_DESCRIPTION=A short description
TOKEN_TWITTER=https://x.com/yourhandle
TOKEN_TELEGRAM=https://t.me/yourgroup
TOKEN_WEBSITE=https://yoursite.com
```

Edit these, then run either start command - the values flow all the way
through to token creation (logged at launch so you can confirm they were
picked up). **Important:** the icon/socials are not yet actually attached
on-chain anywhere pump.fun would display them - see
[PUMPFUN_INTEGRATION.md](PUMPFUN_INTEGRATION.md).

## RPC endpoints

Devnet's public RPC (`api.devnet.solana.com`) rate-limits hard under any
real trading volume. Get a free dedicated RPC (Helius, QuickNode, etc.) and
set it per-network in `.env`:

```bash
DEVNET_RPC_ENDPOINT=https://devnet.helius-rpc.com/?api-key=...
DEVNET_WS_ENDPOINT=wss://devnet.helius-rpc.com/?api-key=...
MAINNET_RPC_ENDPOINT=   # fill in only when actually going live
MAINNET_WS_ENDPOINT=
```

These are separate on purpose - a provider issues a different URL per
network, and accidentally pointing a mainnet run at a devnet-only endpoint
just fails outright.

## Hotkeys (while running)

| Key | Action                                    |
| --- | ------------------------------------------ |
| `C` | Close all positions immediately (real, on-chain sell-off) |
| `P` | Pause organic volume simulation             |
| `R` | Resume organic volume simulation            |
| `Q` | Shut down gracefully                        |

## Other scripts

```bash
npm run balances                      # show all wallet balances (devnet)
npm run balances -- --mainnet         # same, mainnet
npm run reclaim                       # sweep sub-wallets back to main (devnet)
npm run redistribute                  # 80/20 split main -> sub-wallets (devnet)
npx tsx src/scripts/exportWallet.ts main            # print a wallet's real seed/key (devnet)
npx tsx src/scripts/exportWallet.ts main --mainnet  # same, mainnet
```

All of the above accept `--mainnet`/`--devnet` to target that network's
wallet folder (defaults to devnet if omitted).

## Folder structure

```
wallets/            devnet wallets (encrypted)
wallets-mainnet/     mainnet wallets (encrypted + plaintext seed backup)
npc-wallets/         devnet-only simulated outside-buyer wallets (optional, see below)
src/core/            bundler, wallet manager, bonding curve, volume simulator, exit strategy
src/scripts/         one-off CLI scripts (generate/fund/reclaim/redistribute/balances/export)
src/dashboard/       web dashboard (chart + live stats)
```

## Devnet-only: simulated outside buyers

For more realistic devnet rehearsal, you can generate 1-2 wallets that
behave like independent outside buyers (buy in randomly early, then
randomly hold or sell later) - see `npx tsx src/scripts/generateNpcWallets.ts`.
This is hard-gated to devnet and does nothing at all on mainnet, regardless
of whether the wallets exist.

## Status / What's Built

- Devnet rehearsal: full pipeline (wallet generation, token creation,
  bundled buys, organic volume simulation, coordinated exit) against a
  local bonding-curve simulation.
- Mainnet: wallet/network separation and config are ready, but the actual
  pump.fun on-chain integration (real bonding curve, real metadata, real
  discoverability) is **not yet built** - see
  [PUMPFUN_INTEGRATION.md](PUMPFUN_INTEGRATION.md) for the full scope and
  phased plan.
