// SPDX-License-Identifier: MIT
/* ============================================================================
   THE DEEPCORE ADDRESS BOOK — one file, every deployed contract, per chain.

   WHY THIS LIVES IN THE SDK AND NOWHERE ELSE
   ------------------------------------------
   An address table is the first thing an integrator needs and the last thing
   they should have to type. Before this module the SDK shipped ABIs, event
   decoders and a probed RPC list but not a single address, so "simple
   integration" still began with hand-copying twenty hex strings out of a
   markdown file — and every consumer that did so became another place the
   truth could rot.

   It had already started. `apps/web/src/lib/chain.ts` carried one copy and
   `packages/create-deepcore-app/template/src/config/deployments.ts` a second, and
   the two had ALREADY diverged: the web copy knows the timelocks, the fee
   controller, the quoters and the position descriptor; the template copy does
   not. Neither was wrong, which is exactly the problem — two partial tables
   with no way to tell which one is behind. The DefiLlama adapters in this repo
   went the other way, two hand-maintained mirrors with a parity test bolted on
   to catch drift, and a parity test is a smoke alarm, not a fix. This module is
   the fix: both of those files now RE-EXPORT this one.

   Addresses and ABIs are facts about a public chain, not derivative works of
   the GPL contracts that produced them. Nothing here imports from
   `packages/core`, `periphery`, `router` or any hook package, so a third-party
   hook author can build against this MIT package without ever touching GPL
   code. Every value entered below must be an address READ BACK off chain
   after deployment, never one copied from a script's log.

   NULL MEANS NOT DEPLOYED. IT NEVER MEANS ZERO.
   ---------------------------------------------
   Every address field that can be absent is typed `Address | null`, and absent
   is written `null`. The zero address is not used as a placeholder anywhere in
   this file and must never be introduced: `0x000...000` is a value a caller
   will happily pass to `readContract`, `getCode` or a swap path, where it
   silently returns empty rather than failing. `null` cannot be called. It
   forces the consumer to branch, which is the whole point — the honest render
   for a contract that does not exist yet is "not configured on this chain",
   not a read against nothing.

   So: `deployment.launchpadKit === null` is a complete, checkable answer.
   `requireContract(deployment, "launchpadKit")` is the other half, for call
   sites that genuinely cannot proceed without it and would rather throw a
   sentence than a stack trace from viem.

   SOME OF THESE ADDRESSES WILL CHANGE
   -----------------------------------
   Registries, hooks and timelocks get redeployed with fixes, and later
   contracts land after the core. That is the normal state of an address book,
   not an exception to plan around, so the shape is chosen for it:

     * ONE edit, in ONE file, per redeploy. Nothing downstream restates an
       address; `apps/web` and the `create-deepcore-app` template both import.
     * `REDEPLOYABLE_CONTRACTS` names the keys whose address is a moving target,
       because the failure mode of a stale one is silent. A retired
       `DeepCoreRegistry` still answers `deepcoreCount()` with a number and renders as
       a healthy, empty marketplace, because a retired registry still responds
       after nothing reads it any more. A stale Vault, by contrast, cannot
       happen: it is immutable and permanent.

   DECIMALS ARE PART OF THE ADDRESS BOOK, NOT AN AFTERTHOUGHT
   ----------------------------------------------------------
   A USD stablecoin is commonly 6 decimals and WETH9 is 18. `sqrtPriceX96` encodes a
   price as a ratio of RAW units, so a hardcoded 18 against a 6-decimal quote is
   wrong by 10^12 — that is a pool opened at a million times the intended price,
   fixed permanently at `initialize`. This repo has already caught that trap
   twice (see the Arc note in `chains/endpoints.ts`, and `lib/swap.ts`). A token
   listed here therefore ALWAYS carries its decimals, and a token whose decimals
   nobody has read off its own contract does not get listed.

   The table is still a claim, not a proof. `decimals()` on the live contract is
   the proof, and anything pricing a pool should read it — `npm run deepcore:verify`
   in the scaffolded app does exactly that for every address and token here.

   ADDING A CHAIN IS A DATA CHANGE, NOT A CODE CHANGE
   --------------------------------------------------
   One object literal in `DEPLOYMENTS_TABLE` below is the whole edit. Nothing
   restates the chain list: `DeepCoreChainId`, `DeepCoreChainKey`, `DEEPCORE_CHAIN_IDS`,
   `DEEPCORE_MAINNET_CHAIN_IDS`, `NATIVE_CURRENCY` and `isDeepCoreChainId` are all
   DERIVED from that table's keys. Restating a chain list by hand means a new
   chain edits a union type, an array, a map and a function body, any one of
   which can be missed while the other three compile fine.

   What the compiler still enforces, and should: every field typed `Address`
   (not `Address | null`) must be present. A chain is not addable half-way.
   `vault`, `clPoolManager`, `binPoolManager`, `feeController`, `registry`,
   `universalRouter`, both position managers, both quoters, the descriptor,
   `create3Factory`, `permit2`, `weth`, `revShareHook`, the custody timelock and
   `deployedAtBlock` are all required (the policy timelock is not), because a consumer branching on `null`
   for those was never written. So a new chain enters this table when its core
   is deployed and read back, and not one commit earlier. There is no
   placeholder to pre-stage and no zero address to fill in.

   ARC MAINNET (5042) IS DELIBERATELY ABSENT
   -----------------------------------------
   It has never answered a probe from this project: TLS handshake failures on
   every candidate endpoint, so chain id 5042 has never been read off a live
   node, and its published USDC decimals contradict themselves (6 in the owner's
   config, 18 on Circle's own Connect page — the 10^12 gap above). See the long
   note in `chains/endpoints.ts`. Do not add it from memory or from a docs page.
   Nothing is deployed there in any case.
   ============================================================================ */

import type { Address } from "viem";
// SAFE_CONTRACTS (./safe.js) supplies each record's `safe` block; import it again with the first record.
import type { SafeContracts } from "./safe.js";

import { SAFE_CONTRACTS } from "./safe.js";
import type { ContractBlockClock } from "../chains/clock.js";

/**
 * Chains where DeepCore's shared core is deployed and verified.
 *
 * DERIVED from `DEPLOYMENTS_TABLE`'s keys — do not write a union here. Adding a
 * chain is one object literal in that table and nothing else.
 */
export type DeepCoreChainId = keyof typeof DEPLOYMENTS_TABLE;

/**
 * Stable key per chain. Matches the keys in `chains/endpoints.ts`.
 *
 * Also derived: it is the union of the table's own `key` fields.
 */
export type DeepCoreChainKey = (typeof DEPLOYMENTS_TABLE)[DeepCoreChainId]["key"];

/**
 * A token this address book knows about, with the decimals that make its
 * amounts mean something.
 *
 * `decimals` is not optional and has no default. See the header: a default of
 * 18 is how a 6-decimal quote token misprices a pool by 10^12.
 */
export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /**
   * `true` for a throwaway test token with no economic meaning. Rendering one
   * without saying so is how a testnet balance reads as money.
   */
  readonly isTestToken: boolean;
  /**
   * A tokenised stock: an issuer-controlled security token. Present only when
   * true. What it means for a pool or a launch quoted in it (as read on chain
   * for issuer-controlled stock tokens): the issuer can pause transfers, burn from
   * any holder and upgrade every stock token at once, and raw units differ
   * from shares by a UI multiplier. A UI must say so beside any stock pair.
   */
  readonly stock?: {
    /** The issuer as it names itself on the token, e.g. "Robinhood". */
    readonly issuer: string;
    /** Exchange ticker of the underlying, e.g. "NVDA". */
    readonly ticker: string;
  };
}

/* ============================================================================
   DURATION CLOCKS — how a deployed DeepCore contract measures time.

   Every duration in the current DeepCore contract sources uses
   `block.timestamp`. Earlier builds measure in `block.number`, which on Arbitrum
   Nitro is the PARENT chain's block, not the L2 block the RPC reports. A chain
   can hold both kinds at once, and older ones do not go away when the address
   book moves on: a pool is bound to its hook's address forever.

   So the clock is recorded HERE, per contract, and no consumer infers it:

     "timestamp"       stored times are unix seconds; compare with
                       `block.timestamp` (the latest block's `timestamp`).
     "contract-block"  stored times are the EVM's `block.number`; compare with
                       `readContractBlockNumber` from `chains/clock`, NEVER with
                       `eth_blockNumber`.

   There is no decode-time test that tells the two apart. `RevShareHook`'s
   8-word `getPendingConfig` has the same layout in both the block-numbered
   build and the timestamp source, and `LaunchGuardHook`'s `Launch` struct
   lines up word for word. The wrong reading returns a 1970 date or a far-future
   block, not an error. Look the address up; never guess.
   ============================================================================ */

/** How a contract measures and stores durations. See the block above. */
export type DurationClock = "timestamp" | "contract-block";

/**
 * The on-chain layout of `RevShareHook.getPendingConfig(poolId)`.
 *
 * - `block-no-expiry` — 7 words, `(uint48 effectiveBlock, ConfigParams)`. No
 *   expiry at all: a matured proposal stays armed until cancelled or frozen.
 * - `block-with-expiry` — 8 words, `(uint48 effectiveBlock, uint48 expiryBlock, ConfigParams)`.
 * - `timestamp-with-expiry` — 8 words, `(uint40 effectiveAt, uint40 expiresAt, ConfigParams)`.
 */
export type RevSharePendingShape = "block-no-expiry" | "block-with-expiry" | "timestamp-with-expiry";

/** One `RevShareHook` this address book knows, current or retired, with its shape. */
export interface RevShareHookRecord {
  readonly address: Address;
  readonly durationClock: DurationClock;
  readonly pendingShape: RevSharePendingShape;
  /**
   * `current` is the one `DeepCoreDeployment.revShareHook` names. Exactly one per chain.
   * `live` is a deployed, serviceable hook that is not (yet) the one `revShareHook` names —
   * e.g. a redeploy whose consumers have not migrated. `retired` is superseded but still hosts
   * whatever pools were bound to it.
   */
  readonly status: "current" | "live" | "retired";
  /** Why it is here. Pools bound to a retired hook still exist and still trade. */
  readonly note: string;
}

export interface NativeCurrency {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The contracts `LaunchpadKitV2` is built from, in the deployment order of
 * `packages/launchpad/docs/kit-v2-integration.md` section 11.12.
 *
 * A separate group rather than new top-level fields: none of these replaces the
 * block-numbered `launchpadKit` / `launchGuardHook` above, which keep hosting
 * their pools, and a kit is only usable when the whole group is present and
 * bound together (its constructor asserts the hooks' factory, the lockers'
 * position managers and recipient). Each slot is `null` until that contract is
 * deployed AND verified; a partially filled group is an in-progress deployment,
 * not a usable kit - `requireLaunchpadV2` refuses it.
 *
 * All durations in this stack are `block.timestamp` (Option B), so the group
 * carries no clock field.
 */
export interface LaunchpadV2Deployment {
  /** `LaunchpadKitV2`. Owner = the governance Safe; its only power is the launch fee. */
  readonly launchpadKitV2: Address | null;
  /** `LaunchLegs`, the linked library the kit DELEGATECALLs. Verified alongside the kit. */
  readonly launchLegs: Address | null;
  /** `LaunchTokenFactory`. Its `launchTokenInitCodeHash()` feeds off-chain address prediction. */
  readonly launchTokenFactory: Address | null;
  /** `DeepCoreLPLocker` (CL). No owner. */
  readonly clLPLocker: Address | null;
  /** `DeepCoreBinLPLocker`. No owner. */
  readonly binLPLocker: Address | null;
  /** The timestamp `LaunchGuardHook` bound to `launchTokenFactory`. Not the block-numbered `launchGuardHook`. */
  readonly clLaunchGuardHook: Address | null;
  /** `BinLaunchGuardHook(binPoolManager, launchTokenFactory)`. */
  readonly binLaunchGuardHook: Address | null;
  /** `DeepCorePadFactory`, bound to `launchpadKitV2`. No owner. */
  readonly padFactory: Address | null;
}

/**
 * The stock / RWA contracts: market-hours and stock-pair hooks and the oracles
 * they read. A hook address is part of pool identity, so every address here is
 * a deploy, never a patch. `null` where not deployed.
 *
 * Owner of all four = the governance Safe (Ownership table). Read `owner()`
 * rather than trusting this comment.
 */
export interface RwaDeployment {
  /** `MarketHoursHook`: trading sessions, holidays and a price band on a stock pool. */
  readonly marketHoursHook: Address | null;
  /**
   * `StockPairHook`: `MarketHoursHook` plus a per-pool compliance allowlist. It needs a trusted
   * router that attests the end user, so it opens no pool until one is configured.
   */
  readonly stockPairHook: Address | null;
  /** `ChainlinkPriceBandAdapter`: the band's reference price, read from Chainlink feeds. */
  readonly chainlinkPriceBandAdapter: Address | null;
  /** `AllowlistComplianceOracle`: the allowlist `StockPairHook` consults. */
  readonly allowlistComplianceOracle: Address | null;
  /**
   * `ManualPriceBandOracle`: a band reference a bounded publisher posts, for a stock no feed prices.
   * Owned by the CUSTODY timelock (its owner is exempt from the publisher bound), born with no
   * publisher. Optional in the type so a partial devnet override need not name it.
   */
  readonly manualPriceBandOracle?: Address | null;
  /** `PythPriceBandAdapter`: the band's reference from Pyth (pull oracle; `refresh` is permissionless). Owner: the Safe. */
  readonly pythPriceBandAdapter?: Address | null;
}


/**
 * Every DeepCore contract on one chain.
 *
 * Field-by-field nullability is deliberate and load-bearing. A field typed
 * `Address` is deployed on EVERY chain in this table — a consumer can use it
 * without a branch. A field typed `Address | null` is one that genuinely does
 * not exist somewhere, and the compiler makes you say what you will do about
 * that.
 */
export interface DeepCoreDeployment {
  readonly chainId: DeepCoreChainId;
  readonly key: DeepCoreChainKey;
  readonly name: string;
  /** Block explorer origin, no trailing slash. */
  readonly explorer: string;
  /**
   * `true` when this chain holds real value. Governs warning copy and nothing
   * about how anything is read — a testnet address under mainnet chrome is a
   * lie whether or not the reads succeeded.
   */
  readonly isMainnet: boolean;
  /**
   * Block the first DeepCore contract landed. Log scans start here, not at
   * genesis: an unbounded `getLogs` is how a public RPC starts refusing you.
   */
  readonly deployedAtBlock: bigint;
  readonly nativeCurrency: NativeCurrency;

  /* -- clocks ------------------------------------------------------------- */

  /**
   * Which clock `block.number` follows INSIDE THE EVM on this chain.
   *
   * `"parent-l1"` on Arbitrum Nitro chains, where a contract sees Ethereum's
   * block number while `eth_blockNumber` (and `deployedAtBlock` above) is the L2
   * one. Every block number a DeepCore contract STORES is on this clock. Compare
   * those against `readContractBlockNumber` from `chains/clock`, never against
   * `getBlockNumber()`. See the header of `chains/clock.ts`.
   */
  readonly contractBlockClock: ContractBlockClock;
  /**
   * Real cadence of the contract-visible `block.number`, in hundredths of a
   * second. NOT the RPC's block time, and NOT whatever a contract declared in
   * its own `blockTimeCentis()` — those can be wrong.
   */
  readonly contractBlockTimeCentis: number;

  /* -- settlement core ---------------------------------------------------- */

  /**
   * The singleton that custodies every token for the whole protocol.
   *
   * Immutable, permanent, and the highest-value address in the system —
   * `registerApp` is `onlyOwner` and irreversible. It will never be redeployed,
   * which is why it is safe to bake into a source file.
   */
  readonly vault: Address;
  readonly clPoolManager: Address;
  readonly binPoolManager: Address;
  /**
   * The `*PoolManagerOwner` wrappers that actually hold fee and pause authority
   * over every pool. `null` where the managers are owned directly.
   *
   * Recorded here because the alternative is what the dapp does today: read
   * `owner()` and keep hopping until you land somewhere recognisable. That hop
   * chain is still the right way to answer "who owns this NOW" — ownership can
   * be mid-migration — but the wrapper's ADDRESS is a fixed fact and
   * does not need discovering.
   */
  readonly clPoolManagerOwner: Address | null;
  readonly binPoolManagerOwner: Address | null;

  /* -- fees --------------------------------------------------------------- */

  /**
   * The contract governance points a pool manager at. Deployed does NOT mean
   * wired: read `poolManager.protocolFeeController()` to find out whether it is
   * in force, and expect `address(0)`.
   *
   * Never point a manager at a controller that has no function able to call
   * `collectProtocolFees`: everything it charged would accrue where nobody
   * could withdraw it (the caller check runs at collection time, so a later
   * controller can still sweep it).
   */
  readonly feeController: Address;
  /**
   * The two upstream `ProtocolFeeController` instances (one contract, deployed
   * twice — there is no separate CL/Bin source file, whatever the ops table
   * calls them). `null` where neither was deployed.
   */
  readonly clProtocolFeeController: Address | null;
  readonly binProtocolFeeController: Address | null;

  /* -- governance --------------------------------------------------------- */

  /**
   * The governance Safe.
   *
   * This is an identifier, not a claim about who owns what: on one chain it may
   * own every contract in this table, on another exist and own nothing.
   * Which is true for a given chain must be READ, never assumed from here.
   */
  readonly governanceSafe: Address;
  /** 48h tier. Vault and the pool manager owners — irreversible powers. */
  readonly timelockCustody: Address;
  /**
   * 6h tier. Fee policy, descriptor, router — reversible ones.
   *
   * `null` where no policy timelock exists. The Policy tier is retired
   * (reversible actions sit with the Safe directly), so new chains have none.
   */
  readonly timelockPolicy: Address | null;
  /**
   * The canonical Safe v1.4.1 contracts on this chain (`deployments/safe.ts`):
   * what the governance Safe is a proxy of, and the `MultiSendCallOnly` a
   * batch DELEGATECALLs. Verified by `eth_getCode` per chain before listing.
   */
  readonly safe: SafeContracts;

  /* -- directory ---------------------------------------------------------- */

  /**
   * `DeepCoreRegistry` — the HOOK registry, and the DeepCore Marketplace's backing
   * contract. This is the one `LaunchpadKit.registry()` returns and the one
   * `listHook` writes to.
   *
   * NOT `launchRegistry`. There are two registries, the names are one word
   * apart, and both are real and deployed — an integrator wired to the wrong
   * one and only caught it by probing. Tell them apart by a CALL,
   * never by the name or the position in this file:
   *
   *   DeepCoreRegistry        deepcoreCount() answers, MAX_NAME_BYTES() answers 64
   *   DeepCoreLaunchRegistry  deepcoreCount() REVERTS, launchCount() answers
   *
   * This one also owns the governance surface: `DeepCoreLaunchRegistry` reads
   * `CURATOR_ROLE` and `GUARDIAN_ROLE` from here rather than defining its own,
   * so a curator granted here can flag launches too.
   *
   * REDEPLOYABLE, and its stale failure mode is silent: a retired registry
   * answers `deepcoreCount()` with a number and renders as a healthy, empty
   * marketplace. Read it from here and nowhere else.
   */
  readonly registry: Address;

  /* -- periphery and router ----------------------------------------------- */

  readonly universalRouter: Address;
  /**
   * `DeepCoreFillRouter` — the routed-fill router that may fill a trade on a THIRD-PARTY AMM and
   * charges 10 bps for it, while a DeepCore pool is charged exactly 0 (owner decision 2026-09-20).
   *
   * `null` where it is not deployed, which is the house convention and NOT `?:` — `requireContract`
   * tests for `null`, so an optional member would be invisible to it and would produce viem's
   * "invalid address" instead of this file's "not deployed on <chain>" message. The absence is
   * meaningful: a caller that reads `null` as "route through DeepCore pools only" is behaving
   * correctly.
   *
   * ⚠ Never fall back to `universalRouter`. They are different contracts with different fee
   * behaviour, and conflating them charges a DeepCore pool the routed fee — the exact opposite of
   * the decision this router implements.
   *
   * Its `DeepCoreFillExecutor` is deliberately not listed: it is the router's own first CREATE
   * (nonce 1), so it is derived rather than configured, and `EXECUTOR()` on the router is the
   * authority.
   */
  readonly fillRouter: Address | null;
  readonly clPositionManager: Address;
  readonly binPositionManager: Address;
  readonly clQuoter: Address;
  readonly binQuoter: Address;
  readonly clPositionDescriptor: Address;

  /* -- external and utility ----------------------------------------------- */

  /** Our OWN CREATE3 factory. PancakeSwap's is `onlyWhitelisted` and not ours. */
  readonly create3Factory: Address;
  /** Canonical Permit2. Confirmed by reading code at the address on each chain. */
  readonly permit2: Address;
  /** Canonical wrapped native token. Also present in `tokens` with its decimals. */
  readonly weth: Address;

  /* -- DeepCore's own hooks --------------------------------------------------- */

  /**
   * `RevShareHook`. Takes nothing at all until a pool owner configures a
   * roster, so its presence in a pool key is not by itself a fee.
   *
   * REDEPLOYABLE. An older build may lack `keyOf`/`hasKey`/`totalTaken` and
   * revert on all three — a reminder that "the hook is deployed" and "the hook
   * has the function you are about to call" are different questions.
   */
  readonly revShareHook: Address;

  /* -- launchpad ------------------------------------------------------------ */

  /**
   * `DeepCoreLaunchRegistry` — the LAUNCH registry. A different contract from
   * `registry` above. If you are reading a claim about what is deployed,
   * check the table below, not a comment.
   *
   * Holds `registerLaunch` / `getLaunch(poolId)` / `launchCount()` and the
   * launchpad directory `registerLaunchpad` / `getLaunchpad`. It reads its
   * roles from `registry`, so it has no ownership row of its own.
   *
   * WHICH ONE DO I WANT?
   *   listing a HOOK ......... `registry`  (this is what the kit uses)
   *   a launch's own record ... `LaunchpadKit.getLaunchRecord(poolId)`
   *   the curated launch/launchpad directory ... this contract
   *
   * `deepcoreCount()` reverts here. That is the cheapest way to prove which of the
   * two you are holding.
   */
  readonly launchRegistry: Address | null;
  readonly launchpadKit: Address | null;
  readonly launchGuardHook: Address | null;

  /**
   * The CURRENT `LaunchpadKitV2` stack: the one a NEW launch and a NEW Launchpad go
   * through. See `LaunchpadV2Deployment`. Every slot is `null` on a chain without a kit.
   *
   * Only half the story for a READER: a hook address is part of pool identity, so a kit
   * that has been superseded keeps its launches, pools, locks and Launchpads forever.
   * Anything that lists or reads launches, pools, earnings, locks or Launchpads iterates
   * `launchpadV2Generations(d)` (current first, then `launchpadV2Retired`), never this
   * field alone, or every launch of an earlier generation disappears.
   */
  readonly launchpadV2: LaunchpadV2Deployment;

  /**
   * EARLIER kit v2 generations that are still SERVED: nothing new is created through them,
   * but their launches, pools, locks, fee credits and Launchpads live on and must still be
   * read. Newest first. Empty where the chain has only ever had one generation.
   *
   * Contracts a generation shares with another (the lockers and the token factory were
   * reused when the quote-fee guards shipped, 2026-09-28) appear in both records; readers
   * dedupe with `launchpadV2Addresses`. Tell generations' BEHAVIOUR apart by the guard's
   * bitmap (`guardGenerationOf`), never by which list an address sits in.
   */
  readonly launchpadV2Retired: readonly LaunchpadV2Deployment[];

  /**
   * `DeepCoreLaunchAndBuy`: create a launch and make the creator's first buy in one transaction.
   * Bound at construction to ONE kit (its `KIT()`), which is `launchpadV2.launchpadKitV2`
   * whenever this is set. `null` where it is not deployed.
   */
  readonly launchAndBuy: Address | null;
  /**
   * `DeepCoreDynamicFeeHook` (CL): a dynamic fee for ordinary pools, with a protocol share of each swap's
   * fee. `null` where not deployed.
   */
  readonly dynamicFeeHook: Address | null;
  /** `DeepCoreBinDynamicFeeHook`: the Bin twin. `null` where not deployed. */
  readonly binDynamicFeeHook: Address | null;

  /**
   * `DeepCoreSplitFactory` (Team splits): clones a `DeepCoreSplit` per team. Owner =
   * the governance Safe, whose only powers are the creation fee and the
   * protocol share for NEW splits, each inside an immutable cap. Independent of
   * the kit, so it is not part of `launchpadV2`. `null` where not deployed.
   */
  readonly splitFactory: Address | null;

  /**
   * DeepCore utilities: lockers, multisend and Merkle airdrops. Each charges one
   * flat native fee per action, enforced by the contract (`DeepCoreFeeGate`: owner
   * = the governance Safe, fee inside an immutable cap, increases behind a
   * notice, decreases immediate, flushed permissionlessly to the Safe). A caller
   * through the SDK pays exactly what any other caller pays. `null` where not
   * deployed.
   *
   * - `positionLock`: `DeepCorePositionLock`, time-locks a CLPositionManager NFT
   *   (bound to one position manager, read `positionManager()` from it).
   * - `tokenLock`: `DeepCoreTokenLock`, ERC-20 / native time-locks and vesting.
   * - `multisend`: `DeepCoreMultisend`, one call to up to 1,000 recipients.
   * - `dropFactory`: `DeepCoreDropFactory`, clones and funds a `DeepCoreMerkleDrop`.
   */
  readonly positionLock: Address | null;
  readonly tokenLock: Address | null;
  readonly multisend: Address | null;
  readonly dropFactory: Address | null;

  /**
   * Stock / RWA hooks and oracles. See `RwaDeployment`. Every slot is `null` on a chain where
   * they are not deployed.
   */
  readonly rwa: RwaDeployment;

  /* -- duration clocks ----------------------------------------------------- */

  /**
   * How each redeployable time-bounded contract in THIS record measures time.
   * `null` exactly where the contract itself is `null`. Consumers branch on this
   * — the landing preset curve, the dapp proposal banner, the keeper — and it
   * moves in the same edit as the address it describes.
   */
  readonly durationClocks: {
    readonly revShareHook: DurationClock;
    readonly launchpadKit: DurationClock | null;
    readonly launchGuardHook: DurationClock | null;
  };
  /**
   * Every `RevShareHook` a surface may meet on this chain: the current one and
   * each retired one that still hosts pools. Look a hook up with
   * `revShareHookRecord`; an address not listed here has an UNKNOWN shape.
   */
  readonly revShareHooks: readonly RevShareHookRecord[];

  /* -- tokens -------------------------------------------------------------- */

  /**
   * Tokens whose decimals have been read off their own contracts.
   *
   * NOT a token list for a UI to offer — there is no on-chain token registry
   * and this is not a substitute for one. It is the set this repo has actually
   * transacted with, carried so nobody has to guess a decimals value.
   */
  readonly tokens: readonly TokenInfo[];
}

/* ============================================================================
   THE TABLE.

   Edit HERE for a redeploy, and only here. Everything downstream — the dapp,
   the scaffolded tenant app, the keeper, any integrator — reads through this.
   ============================================================================ */

/*
 * The table itself, unannotated and `as const` so its KEYS and its `key` fields
 * are literal types the chain-id and chain-key unions above are read off. The
 * shape check happens once, on the annotated `DEEPCORE_DEPLOYMENTS` below: a field
 * of the wrong type, or a missing required address, is an error there and
 * points at the offending line here.
 */
const DEPLOYMENTS_TABLE = {
  /* --------------------------------------------------------------------------
     EMPTY ON PURPOSE. DeepCore Protocol has not deployed anywhere yet.

     Its first (and, at launch, only) chain is HyperEVM (999). Its record lands
     here in ONE commit, after the core, periphery, router, registry and kit are
     deployed and every address is READ BACK off chain (ops/deploy/
     hyperevm-deploy.md, step 14) — not one commit earlier, and never with a
     placeholder. Until then `DeepCoreChainId` is `never`, `DEEPCORE_CHAIN_IDS`
     is empty, and every surface renders "not deployed on this chain".

     The records that used to live here (Robinhood 4663, Base 8453, Sepolia
     11155111) belonged to the protocol this codebase was forked from. They are
     not DeepCore's and must never be re-added.
     -------------------------------------------------------------------------- */

  /* Written by ops/deploy/tools/make-record.mjs from the broadcast receipts and on-chain reads. */
  999: {
    chainId: 999,
    key: "hyperevm",
    name: "HyperEVM",
    explorer: "https://hyperevmscan.io",
    isMainnet: true,
    deployedAtBlock: 48127937n,
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    contractBlockClock: "native",
    contractBlockTimeCentis: 100,
    vault: "0x405515DB94aDBF3A827349f2C096809639581D09",
    clPoolManager: "0xE23978EBBf83Eab3f0226674d1183b5D3ED32FeC",
    binPoolManager: "0x004a786C4cB79358e2f86467B0eBFD87028648F4",
    clPoolManagerOwner: "0x115c885f089E9ed4DC6CB011A2474a78CAcfd363",
    binPoolManagerOwner: "0x5f3628B89ecc263a03ae49b9f45B1dD1c139D57e",
    feeController: "0x7878BAB23799d3e015998906Ea33327C183e3d78",
    clProtocolFeeController: null,
    binProtocolFeeController: null,
    governanceSafe: "0xeEd90A15348bCAf234733aeB695cA95c0c068c8B",
    timelockCustody: "0x26A09095965d0fF05f7cd600bCfCBb01A66680Bd",
    timelockPolicy: null,
    safe: SAFE_CONTRACTS[999]!,
    registry: "0x78789A53D65dfdaa5Bc110d970Dbbd12Edd39378",
    universalRouter: "0xF480dE4ff93257c18caD36F93E0EeB85A5d5819a",
    fillRouter: "0x7878624417E9d69219EAdD14bA1B01459C87b578",
    clPositionManager: "0x2D608934De0684B151261cbdd71A9134bE349F9d",
    binPositionManager: "0xEC7523d7FC95e335d2629150356C986946538d96",
    clQuoter: "0x366FbA57a555B351834EC6e5b18301974E1504Ed",
    binQuoter: "0x0AE000FecFCDfAf6b9f227548f77776E091b93cc",
    clPositionDescriptor: "0x9675f3Ffe38743D4EfD71BfcF31932645d16B54b",
    create3Factory: "0x72257921c0dE6db8c9665BB6D8462B709c61Bbf8",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    weth: "0x5555555555555555555555555555555555555555",
    revShareHook: "0x7878133cE09e979aa333ecAbB19d8c10F8BC7078",
    launchRegistry: "0x787871D20335808aD72DCAF96FE7b5b7eF616078",
    launchpadKit: null,
    launchGuardHook: null,
    launchpadV2: {
      launchpadKitV2: "0x78781DC6a34F0dcA85929Db22e04815096aAD378",
      launchLegs: "0x78783F3AAaB10a84D7FC0a00d243e19467531878",
      launchTokenFactory: "0x787826056c9A23f2B658f29956C63eCAdA8C0178",
      clLPLocker: "0x7878cB60Ba330c34ffA027Cdd062696eD9D08878",
      binLPLocker: "0x7878B240E282026e2318f69966A5e1c44293dc78",
      clLaunchGuardHook: "0x787888386b536536176aC6E0b0F3f398A929db78",
      binLaunchGuardHook: "0x787802F88BB73FcF49B3e879A47bDB1C42852178",
      padFactory: "0x7878647BCeBc138d3Af70a49399C06C5fbFBce78",
    },
    launchpadV2Retired: [],
    launchAndBuy: "0x78785C407A481FA5a68Ae04dd3196d3051214f78",
    dynamicFeeHook: "0x787824e3C3e0b8FCbDBFd106340cCE27c02Ed678",
    binDynamicFeeHook: "0x7878Ea1e49E6F9D1d498DCBB99a4C93ddaA95d78",
    splitFactory: "0x7878E295dF781eB25A941e788695CC58aA715F78",
    positionLock: "0x7878186b7B906Af641BfB0D9e7aEEB40Ec737778",
    tokenLock: "0x78787661C6B2D4bdd447456e47304F9E092D8678",
    multisend: "0x7878D62c54e6C7a073E6114F478774277F595878",
    dropFactory: "0x7878D474C2797c4C07ef06F848487fEE6aDbCA78",
    rwa: {
      marketHoursHook: null,
      stockPairHook: null,
      chainlinkPriceBandAdapter: null,
      allowlistComplianceOracle: null,
    },
    durationClocks: { revShareHook: "timestamp", launchpadKit: null, launchGuardHook: null },
    revShareHooks: [
      { address: "0x7878133cE09e979aa333ecAbB19d8c10F8BC7078", durationClock: "timestamp", pendingShape: "timestamp-with-expiry", status: "current", note: "First deployment." },
    ],
    /* Read on chain 2026-10-10: name(), symbol(), decimals(). */
    tokens: [
      { address: "0x5555555555555555555555555555555555555555", symbol: "WHYPE", name: "Wrapped HYPE", decimals: 18, isTestToken: false },
      { address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", symbol: "USD₮0", name: "USD₮0", decimals: 6, isTestToken: false },
    ],
  },
} as const;

/**
 * Every DeepCore contract on every chain.
 *
 * This annotation is the shape check for `DEPLOYMENTS_TABLE` above: a typo, a
 * wrong type or a missing required address fails HERE and names the field.
 */
export const DEEPCORE_DEPLOYMENTS: Readonly<Record<DeepCoreChainId, DeepCoreDeployment>> = DEPLOYMENTS_TABLE;

/**
 * The same table, indexed by plain chain id, for the helpers in this module whose ids
 * come from the table's own keys (or have passed `isDeepCoreChainId`). It keeps them
 * compiling while the table is empty and `DeepCoreChainId` is `never`; it adds no
 * chain and no record.
 */
const BOOK: Readonly<Record<number, DeepCoreDeployment>> = DEPLOYMENTS_TABLE;

/** Every chain in the table, ascending. Derived — never written out by hand. */
export const DEEPCORE_CHAIN_IDS: readonly DeepCoreChainId[] = (
  Object.keys(DEPLOYMENTS_TABLE).map(Number) as DeepCoreChainId[]
).sort((a, b) => a - b);

/**
 * The mainnets only. Iterate this, not `DEEPCORE_CHAIN_IDS`, anywhere a testnet
 * being present would be a bug.
 *
 * BOTH LISTS EXIST ON PURPOSE, and the reasoning is worth keeping because the
 * obvious move is to ship one. Dropping the testnet was considered and rejected: a
 * developer building a hook needs a deployed DeepCore to test against before
 * putting one in a real swap path, and a mainnet-only address book means they
 * hand-type testnet addresses — which is precisely the drift this module was
 * created to end.
 *
 * The real risk was never that a testnet is listed. It is that one gets
 * SELECTED by a default nobody revisited. So the answer is a narrower list for
 * the code paths where that would matter, rather than a smaller table that
 * makes honest testing harder.
 *
 * `DEEPCORE_DEPLOYMENTS[id].isMainnet` is the per-record form of the same fact.
 */
export const DEEPCORE_MAINNET_CHAIN_IDS: readonly DeepCoreChainId[] = DEEPCORE_CHAIN_IDS.filter(
  (id) => BOOK[id]!.isMainnet,
);

/**
 * Native currency per chain, split out for callers that want only this.
 *
 * Derived. Do not restate a chain here: a hand-written map is how a third chain
 * gets a fourth-hand ETH entry with the wrong symbol on a chain whose gas token
 * is not ether at all.
 */
export const NATIVE_CURRENCY: Readonly<Record<DeepCoreChainId, NativeCurrency>> = Object.freeze(
  Object.fromEntries(
    DEEPCORE_CHAIN_IDS.map((id) => [id, BOOK[id]!.nativeCurrency] as const),
  ) as Record<DeepCoreChainId, NativeCurrency>,
);

/**
 * Contracts whose address is a MOVING TARGET.
 *
 * Not a style note — a warning about failure modes. Each of these can be
 * replaced without anything downstream noticing, because the retired instance
 * keeps answering: a dead `DeepCoreRegistry` returns a count, a superseded
 * `RevShareHook` returns balances for pools nobody uses any more, a replaced
 * timelock still reports its delay. None of that throws.
 *
 * The correct handling is to read them from this module at call time rather
 * than snapshot them into a config, a database or a deployed front end's build.
 * Everything NOT on this list — the Vault above all — is immutable or has never
 * been replaced.
 */
export const REDEPLOYABLE_CONTRACTS = [
  "registry",
  "revShareHook",
  "timelockCustody",
  "timelockPolicy",
  "feeController",
  "launchRegistry",
  "launchpadKit",
  "launchGuardHook",
] as const satisfies readonly (keyof DeepCoreDeployment)[];

export type RedeployableContract = (typeof REDEPLOYABLE_CONTRACTS)[number];

/** Keys of `DeepCoreDeployment` that hold a single contract address. */
export type ContractKey = {
  [K in keyof DeepCoreDeployment]: DeepCoreDeployment[K] extends Address | null ? K : never;
}[keyof DeepCoreDeployment];

/**
 * Whether the address book knows this chain. Derived from the table's keys, so
 * a chain added there is recognised everywhere without a second edit.
 */
export function isDeepCoreChainId(chainId: number): chainId is DeepCoreChainId {
  return Object.prototype.hasOwnProperty.call(DEPLOYMENTS_TABLE, chainId);
}

/**
 * The deployment for a chain, or `undefined`.
 *
 * `undefined` rather than a throw, because "DeepCore is not on this chain" is a
 * perfectly ordinary answer that a UI should render, not an exception.
 */
export function getDeployment(chainId: number): DeepCoreDeployment | undefined {
  return isDeepCoreChainId(chainId) ? DEEPCORE_DEPLOYMENTS[chainId] : undefined;
}

/**
 * The deployment for a chain, or a thrown error naming the supported chains.
 *
 * For call sites that cannot proceed — a swap builder, a deploy script. Failing
 * loudly beats defaulting to another chain, which is how a testnet call ends up
 * signed against mainnet.
 */
export function requireDeployment(chainId: number): DeepCoreDeployment {
  const d = getDeployment(chainId);
  if (d === undefined) {
    throw new Error(
      `DeepCore is not deployed on chain ${chainId}. Deployed: ` +
        DEEPCORE_CHAIN_IDS.map((id) => `${id} (${BOOK[id]!.name})`).join(", ") +
        ".",
    );
  }
  return d;
}

/**
 * One contract address, or a thrown error that says which chain lacks it.
 *
 * The point is the message. `readContract` against `null` throws something
 * about an invalid address; this throws "LaunchpadKit is not deployed on
 * <chain name> (<chain id>)", which is the sentence the caller needed.
 */
export function requireContract(deployment: DeepCoreDeployment, key: ContractKey): Address {
  const value = deployment[key] as Address | null;
  if (value === null) {
    throw new Error(
      `${key} is not deployed on ${deployment.name} (${deployment.chainId}). ` +
        "It is recorded as null in @deepcoreprotocol/sdk deployments, which means " +
        "not-yet-deployed — handle its absence rather than substituting an address.",
    );
  }
  return value;
}

/** A known token on a chain, by symbol (case-insensitive). `undefined` if unknown. */
export function tokenBySymbol(
  chainId: DeepCoreChainId,
  symbol: string,
): TokenInfo | undefined {
  const wanted = symbol.toLowerCase();
  return BOOK[chainId]!.tokens.find((t) => t.symbol.toLowerCase() === wanted);
}

/** A known token on a chain, by address (case-insensitive). `undefined` if unknown. */
export function tokenByAddress(
  chainId: DeepCoreChainId,
  address: string,
): TokenInfo | undefined {
  const wanted = address.toLowerCase();
  return BOOK[chainId]!.tokens.find((t) => t.address.toLowerCase() === wanted);
}

/**
 * The record for a `RevShareHook` at `address` on `chainId`, current or retired,
 * or `undefined` when the address book does not know it.
 *
 * `undefined` is a real answer. A tenant's own hook, or a hook deployed after
 * this build of the SDK, has an unknown shape: render "unrecognised hook"
 * rather than decoding it through a layout that might be wrong.
 */
export function revShareHookRecord(chainId: number, address: string): RevShareHookRecord | undefined {
  const d = getDeployment(chainId);
  if (d === undefined) return undefined;
  const wanted = address.toLowerCase();
  return d.revShareHooks.find((h) => h.address.toLowerCase() === wanted);
}

/**
 * The duration clock of one of a deployment's time-bounded contracts, or a
 * thrown error when that contract is not deployed on this chain.
 */
export function requireDurationClock(
  deployment: DeepCoreDeployment,
  key: keyof DeepCoreDeployment["durationClocks"],
): DurationClock {
  const clock = deployment.durationClocks[key];
  if (clock === null) {
    throw new Error(`${key} is not deployed on ${deployment.name} (${deployment.chainId}), so it has no clock.`);
  }
  return clock;
}

/**
 * The kit v2 stack on a chain, every address present, or a thrown error naming
 * what is missing. A partially filled group is a deployment in progress: a kit
 * whose lockers or guards are not recorded cannot be checked, so it is refused.
 */
export function requireLaunchpadV2(deployment: DeepCoreDeployment): { readonly [K in keyof LaunchpadV2Deployment]: Address } {
  const g = deployment.launchpadV2;
  const missing = (Object.keys(g) as (keyof LaunchpadV2Deployment)[]).filter((k) => g[k] === null);
  if (missing.length > 0) {
    throw new Error(
      `LaunchpadKitV2 is not deployed on ${deployment.name} (${deployment.chainId}): ${missing.join(", ")} ` +
        "recorded as null in @deepcoreprotocol/sdk deployments.",
    );
  }
  return g as { readonly [K in keyof LaunchpadV2Deployment]: Address };
}

/** The part of a deployment the generation helpers read. `launchpadV2Retired` may be absent (a partial devnet override). */
export interface LaunchpadV2Book {
  readonly launchpadV2: LaunchpadV2Deployment;
  readonly launchpadV2Retired?: readonly LaunchpadV2Deployment[] | undefined;
}

const isSet = (a: Address | null | undefined): a is Address => typeof a === "string" && !/^0x0{40}$/i.test(a);

/**
 * Every kit v2 generation a READER must serve on this chain: the current one first, then the
 * retired ones, newest first. A generation with no kit recorded is left out. Creating a launch or
 * a Launchpad uses `launchpadV2` alone; everything that lists or reads uses this.
 */
export function launchpadV2Generations(d: LaunchpadV2Book): readonly LaunchpadV2Deployment[] {
  return [d.launchpadV2, ...(d.launchpadV2Retired ?? [])].filter((g) => isSet(g.launchpadKitV2));
}

/**
 * One contract role across every served generation, deduplicated (case-insensitively, first
 * spelling kept) and without nulls, current generation first. The lockers and the token factory
 * are shared between generations, so this is how a reader watches each of them ONCE.
 */
export function launchpadV2Addresses(d: LaunchpadV2Book, key: keyof LaunchpadV2Deployment): readonly Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const g of launchpadV2Generations(d)) {
    const a = g[key];
    if (!isSet(a) || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

/** Which served generation a contract belongs to. */
export interface LaunchpadV2GenerationMatch {
  readonly generation: LaunchpadV2Deployment;
  /** True for `launchpadV2`, the generation new launches go through. */
  readonly current: boolean;
  /** 0 = current, 1 = the newest retired, and so on. */
  readonly index: number;
}

/**
 * The served generation whose `key` slot (the kit by default) is `address`, or `null` when no
 * served generation has it. For a SHARED contract (a locker) this is the newest generation that
 * uses it; ask by kit, guard or pad factory when the generation matters.
 */
export function launchpadV2GenerationOf(
  d: LaunchpadV2Book,
  address: string,
  key: keyof LaunchpadV2Deployment = "launchpadKitV2",
): LaunchpadV2GenerationMatch | null {
  const wanted = address.toLowerCase();
  const all = launchpadV2Generations(d);
  const index = all.findIndex((g) => g[key]?.toLowerCase() === wanted);
  if (index < 0) return null;
  return { generation: all[index]!, current: all[index] === d.launchpadV2, index };
}

export function explorerTxUrl(chainId: DeepCoreChainId, hash: string): string {
  return `${BOOK[chainId]!.explorer}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: DeepCoreChainId, address: string): string {
  return `${BOOK[chainId]!.explorer}/address/${address}`;
}

// Safe v1.4.1 contract addresses per chain (see ./safe.ts). Re-exported here so
// the `deployments` namespace and the `./deployments` subpath carry them.
export { SAFE_CONTRACTS, SAFE_CONTRACT_CHAIN_IDS, SAFE_TX_TYPES, requireSafeContracts, safeContractsFor } from "./safe.js";
export type { SafeContracts } from "./safe.js";
