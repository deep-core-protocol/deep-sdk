// SPDX-License-Identifier: MIT
/**
 * DeepCore distribution: `DeepCoreMultisend` (push native or an ERC-20 to up to
 * 1,000 addresses per call) and `DeepCoreDropFactory` / `DeepCoreMerkleDrop`
 * (claimable Merkle airdrops).
 *
 * Readers return what the chain says; builders return `{ to, data, value }`
 * and never send. Every multisend call and every drop pays one flat native
 * fee, ENFORCED BY THE CONTRACT (`DeepCoreFeeGate`). Addresses come from the
 * address book (`DeepCoreDeployment.multisend`, `DeepCoreDeployment.dropFactory`).
 */

export { DEEPCORE_DROP_FACTORY_ABI, DEEPCORE_MERKLE_DROP_ABI, DEEPCORE_MULTISEND_ABI } from "../launchpad/generated/abi.js";
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
export * from "./amounts.js";
export * from "./multisend.js";
export * from "./merkle.js";
export * from "./drop.js";
export * from "./holders.js";
