// SPDX-License-Identifier: MIT
/**
 * DeepCore lockers: `DeepCorePositionLock` (time-locked CL liquidity positions) and
 * `DeepCoreTokenLock` (ERC-20 / native time-locks and vesting).
 *
 * Readers return what the chain says; builders return `{ to, data, value }`
 * and never send. Each lock pays one flat native fee, ENFORCED BY THE
 * CONTRACT (`DeepCoreFeeGate`); `readFeeGate` reads it and the builders size
 * `msg.value` with `feeSafeValue`, which the contract refunds any surplus of.
 * Addresses come from the address book (`DeepCoreDeployment.positionLock`,
 * `DeepCoreDeployment.tokenLock`); `null` there means not deployed.
 */

export { DEEPCORE_POSITION_LOCK_ABI, DEEPCORE_TOKEN_LOCK_ABI } from "../launchpad/generated/abi.js";
export {
  NATIVE,
  buildErc20Approve,
  buildFlushProtocolFees,
  decodePendingUtilityFee,
  feeMayRise,
  feeSafeValue,
  isNative,
  readErc20Allowance,
  readFeeGate,
} from "../utilities/feeGate.js";
export type { FeeGateTerms, PendingUtilityFee, UtilityCall } from "../utilities/feeGate.js";
export { positionAmounts } from "./clAmounts.js";
export type { PositionAmounts } from "./clAmounts.js";
export * from "./position.js";
export * from "./token.js";
export * from "./lpLockers.js";
