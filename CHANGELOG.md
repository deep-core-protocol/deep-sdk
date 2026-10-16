# Changelog — `@deepcoreprotocol/sdk`

MIT. Versions before 0.2.0 were distributed from the public source mirror
(<https://github.com/deep-core-protocol/deep-sdk>) only; 0.2.0 is the first release on npm.

## 0.2.0 — 2026-10-14

First release on npm as `@deepcoreprotocol/sdk`.

### Added

- Stock market reads and the `stocks` site kind.
- Robinhood Chain stock tokens (38, each read on chain from the issuer's factory), more BNB Chain
  stock tokens, Binance-Peg USDT on BNB Chain.
- The two integration prompts in `prompts/` are rewritten for `LaunchpadKitV2`: second-based
  durations, guard fees taken in the quote currency, `SwapNotFilled`, the router and
  `verifySwapCalldata`, and the public API. They now ship in the package.
- `CHANGELOG.md` ships in the package.

### Added after the first build (released with 0.2.0)

- **Limit orders and DCA, managed vaults, liquidity rewards** (`orders`, `vaults`, `rewards`), now that
  their contracts are deployed and read back on HyperEVM (999), Robinhood Chain (4663) and Base (8453)
  (2026-10-16). The address book carries `rangeOrders`, `dca`, `vaultFactory`, `lpRewardsHook`,
  `oracleHook`, `dexHook` and `tunerGate` there; BNB Chain carries none of them
  until its deployment completes.
- **Stock premiums** (`stocks/premium`): a stock token's on-chain price beside its market price
  (token-priced Chainlink feeds; share-priced feeds only through the token's own multiplier, read on
  chain), with the reason whenever the two are not comparable.
- Base Sepolia (84532) in the chain table, as DeepCore's testnet (no address-book record until deployed).
- The stock and native price-feed tables judge each round against the chain head read beside it.

## 0.1.4 — 2026-10-12

- **Address book:** HyperEVM (999), BNB Chain (56), Robinhood Chain (4663) and Base (8453), written
  from on-chain read-back, at the same contract addresses on every chain; HyperEVM's two dynamic-fee
  hooks.
- **Router:** `verifySwapCalldata` decodes router calldata and refuses anything but the requested
  swap; `DeepCoreRouterClient.swap` applies it to every answer. Swaps pay with Permit2 by
  signature, and the native coin can be paid into (and received from) a wrapped-native pool in one
  transaction.
- **Launches:** `buildLaunchAndBuyV2`, a launch and the creator's first buy in one transaction.
- **Safe:** `SafeContracts.version` is `"1.4.1" | "1.5.0"`, with the verified v1.5.0 contract set
  per chain.
- **Chains:** an endpoint that answers with a JSON-RPC limit or "busy" error cools down like one that
  answers 429; measured `eth_getLogs` range limits for BNB Chain, Robinhood Chain and Base.
- **Tokens and prices:** USDG on Robinhood Chain; native-quoted stock pools
  (`chainlinkCrossFeedConfig`; `chainlinkFeedConfig` refuses a native quote).
- **IPFS:** DeepCore's own gateway (`ipfs.deepcore.fun`) first in the default gateway list.

## 0.1.3 — 2026-09-30

- `LaunchpadKitV2` with quote-currency guard fees: launch builders and validation, the guard
  generation read from the hook's permission bitmap, `decodeSwapNotFilled`, earnings reads that
  keep one claimable balance per account and currency.
- The Launchpad factory (`DeepCorePadFactory`) and pad reads, launch-and-buy, the price-band oracles.
- `@deepcoreprotocol/sdk/router`: typed client for the router API tier.
