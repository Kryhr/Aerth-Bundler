# Pump.fun Mainnet Integration - Scoping

## 👉 Next step, when funded (do this first, in order)

1. Send a small amount of real SOL (~0.1 SOL is enough for a first test) to
   the mainnet main wallet: `DcMw8Kgk8c2NsaSCxpDGXRJdAJfPbQwraKCjbXNDEw9d`
2. Set `TOKEN_ICON_PATH` in `.env` to a real image file if not already set
   (pump.fun's metadata upload rejects requests with no image).
3. Run the dry run - costs nothing, sends nothing:
   ```bash
   npx tsx src/scripts/testPumpFunCreate.ts --dry-run
   ```
4. If it succeeds, run it for real (no `--dry-run`) to create one real,
   throwaway test coin and confirm it's actually live/visible on pump.fun.
5. Only after that succeeds: come back here and do the Phase 2 wiring pass
   (see "Phase 2" below for exactly what that involves and why it's
   deliberately not done yet) - this is a real refactor across
   `bundler.ts`/`volumeSimulator.ts`/`exitStrategy.ts`, not a quick swap, and
   it deserves to be done with a real coin available to verify against.
   Include the liquidity tracker (below) in that same pass - it depends on
   the same real market wiring.

## Mainnet-only: liquidity tracker (built, not wired)

Devnet's fake curve has no concept of this - there's no real "outside"
liquidity to run out of, since it's all our own wallets. Mainnet is
different: other people's real buys/sells change how much the curve can
actually pay out, and if our bundled wallets hold a big share of the real
circulating supply, a full exit could get stuck not because our own logic
is wrong, but because there just isn't enough real liquidity in the curve
to absorb it.

`PumpFunMarket.getLiquiditySnapshot(ourTokenHoldings)` (in
[pumpFunMarket.ts](src/core/pumpFunMarket.ts)) reads pump.fun's real
(non-virtual) reserves directly from the live `BondingCurve` account and
returns:
- `realSolLiquidity` / `realTokenLiquidity` - the actual extractable
  depth right now, from real trades only (not the protocol's virtual seed)
- `ourFullExitValue` - what our current token holdings would actually sell
  for right now, using pump.fun's own curve math (not a re-implementation)
- `ourShareOfRealSupply` - how much of the real circulating supply we hold
- `fullyExitable` - a simple flag: our full exit would consume less than
  50% of the real liquidity currently there, i.e. there's genuine headroom
  from outside trading, not just enough to barely scrape by

Once Phase 2 is wired in, this should show up alongside the multiplier in
the Step 5 monitor loop and terminal ticker (mainnet only, gated the same
way `NpcSimulator` is devnet-only) - the goal being: know whether a clean
full exit is realistic *before* pressing `c`, not find out mid-sell.

Meanwhile devnet testing continues completely independently - nothing above
touches or is touched by devnet.

## Current state (confirmed by reading the code, not assumed)

- `TokenFactory.createToken()` creates a bare, anonymous SPL token: classic
  Token program, 9 decimals, no name/symbol/image attached anywhere
  on-chain or off-chain. `createTokenWithMetadata()` exists but is a stub -
  it calls `createToken()` and discards the description/image entirely.
- `LocalMarket` is a private, local, in-memory bonding-curve simulation.
  It's real on-chain SOL/tokens moving between real wallets, but the price
  math is entirely ours - never pump.fun's actual program.
- **Net effect: running this against mainnet today would create an
  invisible token nobody can discover on pump.fun/Axiom, with a "market"
  only this app's own wallets know how to trade against.** None of the
  "get outside people to buy in" plan works until this is real.

## What pump.fun actually requires (from their official public docs repo,
`pump-fun/pump-public-docs`, pulled fresh - not from memory/training data)

- Coins are created via the **`create_v2`** instruction: **Token-2022**
  program, **6 decimals** (not 9), plus `name`, `symbol`, `uri` (a metadata
  JSON URI), and `creator` passed directly as instruction args.
- Trading uses **`buy_v2`** / **`sell_v2`** - unified instructions for both
  SOL-paired and other coins. Each needs, among ~25 accounts:
  - `feeRecipient` - one of 8 official addresses (list in
    `docs/FEE_RECIPIENTS.md`)
  - `buybackFeeRecipient` - one of 8 official addresses (same doc)
  - `creator_vault`, `user_volume_accumulator`, `sharing_config`,
    `fee_config`/`fee_program` - all real PDAs pump.fun's program requires
- **Official SDKs exist and should be used instead of hand-coding
  instructions**:
  - TS: `@pump-fun/pump-sdk` (npm)
  - Rust: `pump-rust-client` (crates.io)
- Price/reserves live in the real on-chain `BondingCurve` PDA
  (`["bonding-curve", mint]`) - a real integration reads this account,
  it doesn't maintain its own copy of the numbers.
- **Metadata image/social-links upload flow is NOT covered in the official
  program docs repo** (that repo is about the on-chain program, not
  pump.fun's website upload API) - this needs separate research/testing:
  likely either pump.fun's own upload endpoint (needs verifying against
  their current site, not assumed) or a generic IPFS pinning service
  (Pinata, nft.storage) producing a URI pointing at a JSON file shaped like
  `{ name, symbol, description, image, twitter, telegram, website }`.

## Why this can't just be "swap the RPC URL"

Everything downstream currently trusts `LocalMarket`'s in-memory
`solReserve`/`tokenReserve` - the multiplier calculation, the exit
strategy's profit math, the price floor, the whole dashboard. A real
integration needs a parallel "real market" implementation that instead:
reads the actual `BondingCurve` account for current state, and submits
real `buy_v2`/`sell_v2` transactions via the SDK. Devnet has no deployed
pump.fun program, so `LocalMarket` stays exactly as-is for devnet rehearsal
- the new implementation only gets used when `NETWORK=mainnet`.

## Progress

**Phase 1 (token creation with metadata) - built, not yet verified live:**
- `src/core/pumpFunMetadata.ts` - uploads icon/description/socials to
  pump.fun's real metadata endpoint (`https://pump.fun/api/ipfs`), gets back
  a `metadataUri`. Confirmed via multiple independent third-party
  integration write-ups (not pump.fun's own docs repo, which only covers
  the on-chain program) - **verify with a real dry-run before trusting it**.
- `src/core/pumpFunTokenFactory.ts` - builds and sends the real
  `create_v2` instruction via the official `@pump-fun/pump-sdk` (confirmed
  by inspecting the installed package's actual shipped type definitions
  directly, not its bundled README - the README example code disagreed
  with its own `.d.ts` on the `PumpSdk` constructor signature, a real
  instance of the "breaking changes happen" risk flagged in this doc).
  Supports a `dryRun` option that simulates the transaction
  (`connection.simulateTransaction`) instead of sending it.
- `src/scripts/testPumpFunCreate.ts` - standalone test script.
  **Run with `--dry-run` first, always**, before ever running it for real:
  ```bash
  npx tsx src/scripts/testPumpFunCreate.ts --dry-run
  ```
- **NOT wired into the main Bundler flow yet, deliberately.** Trading
  (Step 3/4/5) still runs against `LocalMarket`'s fake curve - if Phase 1
  alone were wired into `npm run start:mainnet`, it would create a real,
  public pump.fun listing but then have all subsequent "trading" hit a
  completely disconnected fake curve, which is actively broken, not just
  incomplete. Phase 2 has to land first.
- **Confirmed live**: an actual dry run against the real deployed program
  successfully uploaded metadata and got as far as `simulateTransaction`
  before failing on `AccountNotFound` - traced to the mainnet wallet
  genuinely having 0 lamports (an account with 0 lamports and no data
  doesn't exist on Solana's ledger at all, so it can't be used as a fee
  payer). Not a code bug - re-run the dry run once the wallet has a small
  real balance.
- Also confirmed live: pump.fun's metadata endpoint **requires** an image -
  it 400s with "Missing file" if none is given, despite some docs implying
  it's optional in certain cases. `testPumpFunCreate.ts` now checks for
  `TOKEN_ICON_PATH` up front instead of letting that surface as a raw API
  error.
- Also confirmed live: `create_v2`'s instruction data does **not** include
  supply or decimals - pump.fun coins are always 1B supply at 6 decimals,
  minted entirely into the bonding curve at creation, seeded by the
  protocol's own fixed virtual reserves. `TOKEN_SUPPLY`/`INITIAL_LIQUIDITY`
  in `.env` only apply to devnet's fake `LocalMarket` path - once wired,
  the real mainnet path won't read them at all.

**Phase 2 (real market implementation) - built, NOT wired into Bundler:**
- `src/core/pumpFunMarket.ts` - a `PumpFunMarket` class exposing the same
  method names `LocalMarket` does (`buy`, `sell`, `sellBatch`, `getPrice`,
  `getReserves`, `estimateSellProceeds`, `getTokenBalance`, `transfer`),
  backed by real `buy_v2`/`sell_v2` instructions and real on-chain
  `BondingCurve` reads via `OnlinePumpSdk`. Uses pump.fun's own
  `getBuyTokenAmountFromSolAmount`/`getSellSolAmountFromTokenAmount` helpers
  for the curve math rather than reimplementing their formula. Every
  signature was verified against the installed package's actual `.d.ts`
  (the README disagreed with its own types on the curve-math helpers too -
  a second, separate instance of the drift risk, not a one-off).
- **Deliberately not wired into `Bundler`/`VolumeSimulator`/`ExitStrategy`
  yet.** This is a real, structural blocker, not just caution: `LocalMarket`
  exposes `getPrice()`/`getReserves()`/`estimateSellProceeds()` as
  **synchronous** methods (it's an in-memory number), while
  `PumpFunMarket`'s equivalents are necessarily **asynchronous** (they read
  live chain state over RPC). Every call site across `bundler.ts`,
  `volumeSimulator.ts`, and `exitStrategy.ts` that currently calls these
  synchronously would need to change to `await` them - a real refactor
  across the whole trading pipeline, not a drop-in swap. Doing that
  particular pass with zero ability to test either path live (no funded
  mainnet wallet, no real coin created yet) is the wrong moment to rush it -
  a mistake here risks real capital, not a replayable devnet test. The
  right time to do this pass is once a dry run of Phase 1 has actually
  succeeded (wallet funded) and there's a real coin to test Phase 2's reads
  against.

## Phased plan

1. **Token creation with real metadata** - add `@pump-fun/pump-sdk`,
   rewrite the mainnet path of `TokenFactory` to call `createV2Instruction`
   (Token-2022, 6 decimals), with real `name`/`symbol`/`uri` sourced from
   config (see below). Verify the metadata image/social upload flow first,
   on a throwaway coin, before wiring it into the main flow.
2. **Real market implementation** - a `PumpFunMarket` class implementing
   the same interface `LocalMarket` exposes (`buy`, `sell`, `getPrice`,
   `getReserves`, `estimateSellProceeds`) but backed by real `buy_v2`/
   `sell_v2` calls and real `BondingCurve` account reads. `Bundler`
   branches between `LocalMarket` (devnet) and `PumpFunMarket` (mainnet)
   based on `NETWORK`.
3. **Config for name/symbol/icon/socials** - `.env` (or a dedicated
   `token.config.json`) with clearly documented fields:
   `TOKEN_NAME`, `TOKEN_SYMBOL` (already exist), plus new `TOKEN_ICON_PATH`,
   `TOKEN_DESCRIPTION`, `TOKEN_TWITTER`, `TOKEN_TELEGRAM`, `TOKEN_WEBSITE`.
   A short README section documents exactly where to edit each one before
   a real launch.
4. **Careful, small-amount real testing** - before ever running this with
   real bundled capital, do one real mainnet test with a trivial amount
   (e.g. the smallest fraction of SOL that's not just dust) to confirm the
   create/buy/sell round-trip actually works against pump.fun's real
   program, before trusting it with real capital.

## Open items needing verification before Phase 1 starts

- The actual metadata image/JSON upload flow (not in the program docs repo)
- Whether `@pump-fun/pump-sdk`'s current version matches the `create_v2`/
  `buy_v2`/`sell_v2` interface described above (docs repo shows breaking
  changes have happened before, e.g. the 2026-04-28 fee-recipient change)
