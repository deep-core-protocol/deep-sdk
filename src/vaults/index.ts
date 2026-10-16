// SPDX-License-Identifier: MIT
/**
 * Managed-liquidity vaults: `DeepCoreVaultFactory` and its `DeepCoreManagedVault` clones.
 *
 * A vault holds a concentrated position in ONE DeepCore CL pool and issues ERC-20 shares
 * pro rata. Anyone may `rebalance` (re-centre the base range around the TWAP of the pool's
 * price-oracle hook, inside a deviation guard, a cooldown and a drift trigger; the
 * remainder goes to a single-sided limit position; the vault never swaps) and `harvest`
 * (collect fees, take the frozen performance and curator fees, compound the rest). A
 * withdrawal reads no oracle and nothing can pause it.
 *
 * ONLY POOLS WITH AN ORACLE. The TWAP comes from a hook that contains DeepCore's oracle
 * module (`kind() == keccak256("deepcore.oracle.truncated-twap.v1")`). The vault's own
 * pool may carry it, or the curator names a sibling pool of the same pair that does. A
 * pool with neither cannot have a vault; spot price is never used to place liquidity.
 *
 * FEES (frozen per vault): a protocol performance fee on harvested LP fees (10% by
 * default, immutable cap 20%), the curator's fee (0-20%, chosen at creation), no fee on
 * principal, and a flat creation fee in native paid to the factory.
 *
 * Independently authored against the contracts' compiled ABI (`./abi.ts`) and their
 * documented rules (`packages/vaults/src/*.sol`, GPL). Validation here restates the
 * contracts' own checks so a wallet is never asked to sign a call the contract will
 * refuse; the contract stays the authority.
 *
 * NOTHING HERE IS DEPLOYED. `DeepCoreDeployment.vaultFactory` is absent or `null` on
 * every chain until the contracts are deployed and read back.
 *
 * @experimental Preview: the contracts are not deployed on any chain yet; addresses are null until they are.
 * The API may change in a minor release before the first deployment.
 */

import { BaseError, ContractFunctionRevertedError, encodeFunctionData, keccak256, stringToBytes, type Address, type Hex, type PublicClient } from "viem";

import { isNativeCurrency } from "../types/currency.js";
import { getHooksRegistrationBitmap, getTickSpacing } from "../types/parameters.js";
import type { PoolKey } from "../types/poolKey.js";
import { MANAGED_VAULT_ABI, VAULT_FACTORY_ABI } from "./abi.js";

export { MANAGED_VAULT_ABI, VAULT_FACTORY_ABI };

/* ---------------------------------------------------------- constants --- */

/** `keccak256("deepcore.oracle.truncated-twap.v1")`: what an oracle hook's `kind()` returns. */
export const ORACLE_KIND: Hex = keccak256(stringToBytes("deepcore.oracle.truncated-twap.v1"));
/** `DeepCoreManagedVault.FORBIDDEN_HOOK_BITS`: a hook with any of these could block or tax a withdrawal. */
export const VAULT_FORBIDDEN_HOOK_BITS = (1 << 4) | (1 << 5) | (1 << 12) | (1 << 13);
export const VAULT_MAX_CURATOR_FEE_BPS = 2_000;
export const VAULT_ABSOLUTE_MAX_PERFORMANCE_FEE_BPS = 2_000;
export const VAULT_DEAD_SHARES = 1_000n;
export const VAULT_MIN_INITIAL_SHARES = 1_000_000n;
export const VAULT_MAX_WIDTH = 400_000;
export const VAULT_MAX_DEVIATION = 2_000;
export const VAULT_MIN_TWAP_WINDOW = 600;
export const VAULT_MAX_TWAP_WINDOW = 86_400;
export const VAULT_MIN_COOLDOWN = 600;
export const VAULT_MAX_COOLDOWN = 7 * 86_400;
/** Why a `rebalance()` simulation reverted, in words, by the contract's error name. */
export const REBALANCE_REASONS: Readonly<Record<string, string>> = {
  NothingToManage: "empty",
  CooldownActive: "cooldown",
  OracleUnreadable: "oracle unreadable",
  DeviationTooHigh: "spot too far from TWAP",
  NoDrift: "no drift",
};

const MAX_UINT256 = 2n ** 256n - 1n;
const Q96 = 1n << 96n;
const BPS = 10_000n;

/* -------------------------------------------------------------- types --- */

/** The frozen strategy. Widths and thresholds are in ticks. */
export interface VaultConfig {
  readonly baseHalfWidth: number;
  readonly limitWidth: number;
  readonly maxDeviation: number;
  readonly rebalanceThreshold: number;
  readonly twapWindow: number;
  readonly cooldown: number;
  readonly curatorFeeBps: number;
}

/** A call ready for a wallet: target, calldata and the exact native value to attach. */
export interface VaultTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** Thrown by every builder for an input the contract would refuse. `field` names the input. */
export class VaultInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "VaultInputError";
    this.field = field;
  }
}

const fail = (field: string, message: string): never => {
  throw new VaultInputError(field, message);
};

function assertAddress(a: Address | undefined, field: string): void {
  if (a === undefined || !/^0x[0-9a-fA-F]{40}$/.test(a)) fail(field, `${field} is not an address.`);
}

function nonZero(a: Address, field: string): void {
  assertAddress(a, field);
  if (/^0x0{40}$/i.test(a)) fail(field, `${field} cannot be the zero address.`);
}

function assertAmount(v: bigint, field: string): void {
  if (typeof v !== "bigint" || v < 0n || v > MAX_UINT256) fail(field, `${field} must be a uint256.`);
}

const keyTuple = (k: PoolKey) => ({
  currency0: k.currency0,
  currency1: k.currency1,
  hooks: k.hooks,
  poolManager: k.poolManager,
  fee: k.fee,
  parameters: k.parameters,
});

/* --------------------------------------------------------- validation --- */

/**
 * The defaults the dapp offers for a pool's tick spacing: a base of about +-10%, a limit as
 * wide, a 1% deviation guard, a drift trigger at half the base, a 30-minute TWAP and a
 * one-hour cooldown. Rounded to the spacing.
 */
export function defaultVaultConfig(tickSpacing: number, curatorFeeBps = 0): VaultConfig {
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) fail("tickSpacing", "tickSpacing must be a positive integer.");
  const snap = (t: number) => Math.max(tickSpacing, Math.round(t / tickSpacing) * tickSpacing);
  const base = snap(1_000);
  return {
    baseHalfWidth: base,
    limitWidth: base,
    maxDeviation: Math.max(1, Math.min(100, Math.floor(base / 2))),
    rebalanceThreshold: Math.floor(base / 2),
    twapWindow: 1_800,
    cooldown: 3_600,
    curatorFeeBps,
  };
}

/**
 * Restates `DeepCoreManagedVault._validateConfig` and the fee caps. `oracleMinWindow` is the
 * oracle hook's `ORACLE_MIN_WINDOW_SECONDS` (the TWAP window must be at least that and 600).
 * Throws `VaultInputError` naming the field; returns the config unchanged when it passes.
 */
export function validateVaultConfig(c: VaultConfig, tickSpacing: number, oracleMinWindow = VAULT_MIN_TWAP_WINDOW): VaultConfig {
  const s = tickSpacing;
  const int = (v: number) => Number.isInteger(v);
  if (!int(c.baseHalfWidth) || c.baseHalfWidth < s || c.baseHalfWidth > VAULT_MAX_WIDTH || c.baseHalfWidth % s !== 0) {
    fail("baseHalfWidth", `baseHalfWidth must be a multiple of the tick spacing ${s}, from ${s} to ${VAULT_MAX_WIDTH}.`);
  }
  if (!int(c.limitWidth) || c.limitWidth < s || c.limitWidth > VAULT_MAX_WIDTH || c.limitWidth % s !== 0) {
    fail("limitWidth", `limitWidth must be a multiple of the tick spacing ${s}, from ${s} to ${VAULT_MAX_WIDTH}.`);
  }
  const maxDev = Math.min(Math.trunc(c.baseHalfWidth / 2), VAULT_MAX_DEVIATION);
  if (!int(c.maxDeviation) || c.maxDeviation < 1 || c.maxDeviation > maxDev) {
    fail("maxDeviation", `maxDeviation must be from 1 to ${maxDev} ticks (half the base half-width, at most ${VAULT_MAX_DEVIATION}).`);
  }
  if (!int(c.rebalanceThreshold) || c.rebalanceThreshold < 0 || c.rebalanceThreshold > c.baseHalfWidth) {
    fail("rebalanceThreshold", "rebalanceThreshold must be from 0 to the base half-width.");
  }
  const minWindow = Math.max(oracleMinWindow, VAULT_MIN_TWAP_WINDOW);
  if (!int(c.twapWindow) || c.twapWindow < minWindow || c.twapWindow > VAULT_MAX_TWAP_WINDOW) {
    fail("twapWindow", `twapWindow must be from ${minWindow} to ${VAULT_MAX_TWAP_WINDOW} seconds.`);
  }
  if (!int(c.cooldown) || c.cooldown < VAULT_MIN_COOLDOWN || c.cooldown > VAULT_MAX_COOLDOWN) {
    fail("cooldown", `cooldown must be from ${VAULT_MIN_COOLDOWN} to ${VAULT_MAX_COOLDOWN} seconds.`);
  }
  if (!int(c.curatorFeeBps) || c.curatorFeeBps < 0 || c.curatorFeeBps > VAULT_MAX_CURATOR_FEE_BPS) {
    fail("curatorFeeBps", `curatorFeeBps must be from 0 to ${VAULT_MAX_CURATOR_FEE_BPS}.`);
  }
  return c;
}

/** Why a key cannot carry a vault, or null when its parameters allow one. Pure: the oracle check needs a read. */
export function vaultKeyProblem(key: PoolKey, oracleKey: PoolKey, clPoolManager?: Address): string | null {
  const lower = (a: string) => a.toLowerCase();
  if (clPoolManager !== undefined && (lower(key.poolManager) !== lower(clPoolManager) || lower(oracleKey.poolManager) !== lower(clPoolManager))) {
    return "Both pools must be on DeepCore's CL pool manager.";
  }
  if (lower(key.currency0) !== lower(oracleKey.currency0) || lower(key.currency1) !== lower(oracleKey.currency1)) {
    return "The oracle pool must trade the same two currencies.";
  }
  const bitmap = getHooksRegistrationBitmap(key.parameters);
  if ((bitmap & VAULT_FORBIDDEN_HOOK_BITS) !== 0) {
    return `This pool's hook (bitmap 0x${bitmap.toString(16)}) can act on a removal, so it could block a withdrawal. The contract refuses it.`;
  }
  if (/^0x0{40}$/i.test(oracleKey.hooks)) return "The oracle pool has no hook, so it has no TWAP.";
  return null;
}

/* ----------------------------------------------------------- builders --- */

export interface CreateVaultArgs {
  readonly factory: Address;
  readonly key: PoolKey;
  /** The pool whose hook supplies the TWAP; defaults to `key`. */
  readonly oracleKey?: PoolKey;
  readonly config: VaultConfig;
  /** Any 32 bytes; the vault address binds it to the creator (`predictVault`). */
  readonly salt: Hex;
  /** `feeWei()` read from the factory now. Send a little more if an increase may land; the surplus is refunded. */
  readonly feeWei: bigint;
  readonly oracleMinWindow?: number;
  readonly clPoolManager?: Address;
}

/** `createVault(params, salt)`, payable with the creation fee. The caller becomes the curator. */
export function buildCreateVault(a: CreateVaultArgs): VaultTx {
  assertAddress(a.factory, "factory");
  const oracleKey = a.oracleKey ?? a.key;
  const problem = vaultKeyProblem(a.key, oracleKey, a.clPoolManager);
  if (problem !== null) fail("key", problem);
  const spacing = getTickSpacing(a.key.parameters);
  if (spacing < 1) fail("key", "The key carries no positive tick spacing; is it a CL key?");
  validateVaultConfig(a.config, spacing, a.oracleMinWindow);
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.salt)) fail("salt", "salt must be 32 bytes.");
  assertAmount(a.feeWei, "feeWei");
  const data = encodeFunctionData({
    abi: VAULT_FACTORY_ABI,
    functionName: "createVault",
    args: [{ key: keyTuple(a.key), oracleKey: keyTuple(oracleKey), config: { ...a.config } }, a.salt],
  });
  return { to: a.factory, data, value: a.feeWei };
}

/** `depositInitial(max0, max1, minShares, to, deadline)`: the first deposit, which places the base. */
export function buildDepositInitial(a: {
  readonly vault: Address;
  readonly key: PoolKey;
  readonly max0: bigint;
  readonly max1: bigint;
  readonly minShares?: bigint;
  readonly to: Address;
  readonly deadline: bigint;
}): VaultTx {
  assertAddress(a.vault, "vault");
  nonZero(a.to, "to");
  assertAmount(a.max0, "max0");
  assertAmount(a.max1, "max1");
  if (a.max0 === 0n && a.max1 === 0n) fail("max0", "Deposit something.");
  const data = encodeFunctionData({
    abi: MANAGED_VAULT_ABI,
    functionName: "depositInitial",
    args: [a.max0, a.max1, a.minShares ?? 0n, a.to, a.deadline],
  });
  return { to: a.vault, data, value: isNativeCurrency(a.key.currency0) ? a.max0 : 0n };
}

/** `deposit(shares, max0, max1, to, deadline)`. For a native currency0 the value is `max0`; the surplus is refunded. */
export function buildDeposit(a: {
  readonly vault: Address;
  readonly key: PoolKey;
  readonly shares: bigint;
  readonly max0: bigint;
  readonly max1: bigint;
  readonly to: Address;
  readonly deadline: bigint;
}): VaultTx {
  assertAddress(a.vault, "vault");
  nonZero(a.to, "to");
  if (typeof a.shares !== "bigint" || a.shares <= 0n) fail("shares", "shares must be above zero.");
  assertAmount(a.max0, "max0");
  assertAmount(a.max1, "max1");
  const data = encodeFunctionData({
    abi: MANAGED_VAULT_ABI,
    functionName: "deposit",
    args: [a.shares, a.max0, a.max1, a.to, a.deadline],
  });
  return { to: a.vault, data, value: isNativeCurrency(a.key.currency0) ? a.max0 : 0n };
}

/** `withdraw(shares, min0, min1, to, deadline)`. */
export function buildWithdraw(a: {
  readonly vault: Address;
  readonly shares: bigint;
  readonly min0: bigint;
  readonly min1: bigint;
  readonly to: Address;
  readonly deadline: bigint;
}): VaultTx {
  assertAddress(a.vault, "vault");
  nonZero(a.to, "to");
  if (typeof a.shares !== "bigint" || a.shares <= 0n) fail("shares", "shares must be above zero.");
  assertAmount(a.min0, "min0");
  assertAmount(a.min1, "min1");
  const data = encodeFunctionData({
    abi: MANAGED_VAULT_ABI,
    functionName: "withdraw",
    args: [a.shares, a.min0, a.min1, a.to, a.deadline],
  });
  return { to: a.vault, data, value: 0n };
}

/** `rebalance()`, `harvest()`, `flushProtocolFees()`: permissionless. */
export function buildVaultCall(vault: Address, fn: "rebalance" | "harvest" | "flushProtocolFees"): VaultTx {
  assertAddress(vault, "vault");
  return { to: vault, data: encodeFunctionData({ abi: MANAGED_VAULT_ABI, functionName: fn }), value: 0n };
}

/* --------------------------------------------------------------- math --- */

/** Applies a slippage tolerance to a quoted amount (up for a maximum, down for a minimum). */
export function withSlippage(amount: bigint, bps: number, direction: "max" | "min"): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) fail("bps", "slippage must be 0 to 10,000 bps.");
  const b = BigInt(bps);
  return direction === "max" ? (amount * (BPS + b) + BPS - 1n) / BPS : (amount * (BPS - b)) / BPS;
}

/**
 * Shares that `amount0` / `amount1` buy at the vault's current totals, rounded down (the
 * contract charges the pro-rata amounts rounded UP, so quote with `withSlippage(.., "max")`).
 * A side the vault holds none of does not limit the result.
 */
export function sharesForAmounts(a: {
  readonly total0: bigint;
  readonly total1: bigint;
  readonly supply: bigint;
  readonly amount0: bigint;
  readonly amount1: bigint;
}): bigint {
  if (a.supply === 0n) return 0n;
  const s0 = a.total0 === 0n ? null : (a.amount0 * a.supply) / a.total0;
  const s1 = a.total1 === 0n ? null : (a.amount1 * a.supply) / a.total1;
  if (s0 === null && s1 === null) return 0n;
  if (s0 === null) return s1 as bigint;
  if (s1 === null) return s0;
  return s0 < s1 ? s0 : s1;
}

/** Value of `amount0` in currency1 units at `sqrtPriceX96`. */
export function token0InToken1(amount0: bigint, sqrtPriceX96: bigint): bigint {
  return (((amount0 * sqrtPriceX96) / Q96) * sqrtPriceX96) / Q96;
}

/** One `Snapshot` event, as the share-value chart consumes it. */
export interface VaultSnapshot {
  readonly blockNumber: bigint;
  readonly total0: bigint;
  readonly total1: bigint;
  readonly supply: bigint;
  readonly sqrtPriceX96: bigint;
}

/**
 * The share-value series: per snapshot, what one share (1e18 units) holds, valued in
 * currency1 at that snapshot's own price. Snapshots with no supply are dropped.
 * Quote-denominated, never USD.
 */
export function shareValueSeries(snaps: readonly VaultSnapshot[]): { blockNumber: bigint; valuePerShare1e18: bigint }[] {
  const one = 10n ** 18n;
  return snaps
    .filter((s) => s.supply > 0n)
    .map((s) => ({
      blockNumber: s.blockNumber,
      valuePerShare1e18: ((token0InToken1(s.total0, s.sqrtPriceX96) + s.total1) * one) / s.supply,
    }));
}

/* ------------------------------------------------------------ readers --- */

export interface VaultState {
  readonly address: Address;
  readonly key: PoolKey;
  readonly oracleKey: PoolKey;
  readonly config: VaultConfig;
  readonly curator: Address;
  readonly performanceFeeBps: number;
  readonly totalSupply: bigint;
  readonly total0: bigint;
  readonly total1: bigint;
  readonly base: { readonly lower: number; readonly upper: number };
  readonly limit: { readonly lower: number; readonly upper: number };
  readonly baseLiquidity: bigint;
  readonly limitLiquidity: bigint;
  readonly lastRebalanceAt: bigint;
  /** From a simulation of `rebalance()` (the vault has no separate view: one code path, no drift between them). */
  readonly canRebalance: { readonly ok: boolean; readonly reason: string };
}

/** Reads one vault in a handful of calls. Throws on a transport error; the caller renders the error state. */
export async function readVault(client: PublicClient, vault: Address): Promise<VaultState> {
  const r = <T>(functionName: string) =>
    client.readContract({ address: vault, abi: MANAGED_VAULT_ABI, functionName: functionName as never }) as Promise<T>;
  const [key, oracleKey, config, curator, perf, supply, totals, base, limit, liq, last, can] = await Promise.all([
    r<PoolKey>("poolKey"),
    r<PoolKey>("oraclePoolKey"),
    r<VaultConfig>("config"),
    r<Address>("curator"),
    r<number>("performanceFeeBps"),
    r<bigint>("totalSupply"),
    r<readonly [bigint, bigint]>("totalAmounts"),
    r<readonly [number, number]>("base"),
    r<readonly [number, number]>("limit"),
    r<readonly [bigint, bigint]>("positionLiquidity"),
    r<bigint>("lastRebalanceAt"),
    simulateRebalance(client, vault),
  ]);
  return {
    address: vault,
    key,
    oracleKey,
    config: {
      baseHalfWidth: Number(config.baseHalfWidth),
      limitWidth: Number(config.limitWidth),
      maxDeviation: Number(config.maxDeviation),
      rebalanceThreshold: Number(config.rebalanceThreshold),
      twapWindow: Number(config.twapWindow),
      cooldown: Number(config.cooldown),
      curatorFeeBps: Number(config.curatorFeeBps),
    },
    curator,
    performanceFeeBps: Number(perf),
    totalSupply: supply,
    total0: totals[0],
    total1: totals[1],
    base: { lower: Number(base[0]), upper: Number(base[1]) },
    limit: { lower: Number(limit[0]), upper: Number(limit[1]) },
    baseLiquidity: liq[0],
    limitLiquidity: liq[1],
    lastRebalanceAt: last,
    canRebalance: can,
  };
}

/** Simulates `rebalance()`: ok, or the contract's refusal in words. Transport failures throw. */
export async function simulateRebalance(client: PublicClient, vault: Address): Promise<{ readonly ok: boolean; readonly reason: string }> {
  try {
    await client.simulateContract({ address: vault, abi: MANAGED_VAULT_ABI, functionName: "rebalance" });
    return { ok: true, reason: "ok" };
  } catch (e) {
    const name = revertName(e);
    if (name === null) throw e;
    return { ok: false, reason: REBALANCE_REASONS[name] ?? name };
  }
}

function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? "reverted";
  }
  return null;
}

/** Every vault the factory created, newest last (paged, `pageSize` per call). */
export async function readVaultAddresses(client: PublicClient, factory: Address, pageSize = 100): Promise<Address[]> {
  const n = (await client.readContract({ address: factory, abi: VAULT_FACTORY_ABI, functionName: "vaultCount" })) as bigint;
  const out: Address[] = [];
  for (let start = 0n; start < n; start += BigInt(pageSize)) {
    const page = (await client.readContract({
      address: factory,
      abi: VAULT_FACTORY_ABI,
      functionName: "vaults",
      args: [start, BigInt(pageSize)],
    })) as readonly Address[];
    out.push(...page);
  }
  return out;
}

/** The factory's current fees (creation fee in wei, performance fee in bps) and any pending increases. */
export async function readFactoryFees(client: PublicClient, factory: Address): Promise<{
  readonly feeWei: bigint;
  readonly performanceFeeBps: number;
  readonly pendingFee: { readonly wei: bigint; readonly effectiveAt: bigint };
  readonly pendingPerformanceFee: { readonly bps: number; readonly effectiveAt: bigint };
}> {
  const r = <T>(functionName: string) =>
    client.readContract({ address: factory, abi: VAULT_FACTORY_ABI, functionName: functionName as never }) as Promise<T>;
  const [feeWei, perf, pf, ppf] = await Promise.all([
    r<bigint>("feeWei"),
    r<number>("performanceFeeBps"),
    r<readonly [bigint, bigint]>("pendingFee"),
    r<readonly [number, bigint]>("pendingPerformanceFee"),
  ]);
  return {
    feeWei,
    performanceFeeBps: Number(perf),
    pendingFee: { wei: pf[0], effectiveAt: pf[1] },
    pendingPerformanceFee: { bps: Number(ppf[0]), effectiveAt: ppf[1] },
  };
}
