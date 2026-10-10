<p align="center">
  <a href="https://deepcore.fun">
    <img src=".github/assets/og-image-1200x630.png" alt="DeepCore: launch on one core. Tokens, Launchpads and DEXes at deepcore.fun" width="720">
  </a>
</p>

# deep-sdk

The TypeScript SDK for DeepCore Protocol, `@deepcoreprotocol/sdk`. MIT-licensed and independently
authored, so a Launchpad, a DEX, an indexer or a hook developer builds against DeepCore without
importing GPL code.

## Features

DeepCore is one shared liquidity core (a single Vault with concentrated-liquidity and Bin pool
managers, on HyperEVM) that Launchpads and DEXes build on instead of deploying their own AMM. The SDK
is the typed way in:

- **Protocol types.** Pool keys and ids, currencies, balance deltas, fees, the hook permission bitmap,
  and typed definitions for every event the contracts emit.
- **Launches.** Build and validate a token launch on a CL range or a shaped Bin distribution:
  presets, the opening price, the anti-snipe fee schedule, the optional creator tax and a Launchpad's
  terms.
- **Launchpads and DEXes.** Read and write the on-chain owner, name and brand of a Launchpad or DEX
  created through `DeepCorePadFactory`.
- **Market reads.** Trades, candles, holders, the pool directory and spot price, from logs and
  `getSlot0`, denominated in the quote token.
- **Prices with provenance.** A native/USD price resolved from Chainlink on chain, then Pyth, then a
  DeepCore pool; every answer says where it came from, and "no source" is an answer, not a zero.
- **Utilities.** Liquidity locks, token locks and vesting, multisend, Merkle airdrops and team splits.
- **Registry and trust.** What the on-chain registry records about a hook, rendered without implying
  an audit.
- **Chains.** Public endpoints per chain with a failover transport, and a reader for the clock the
  contracts actually see.

## Licence

MIT. The Solidity contracts it talks to are GPL-2.0-or-later and live in
[deep-core-protocol/contracts](https://github.com/deep-core-protocol/contracts); the SDK works from
their compiled ABIs and carries none of their source.

Site: [deepcore.fun](https://deepcore.fun)
