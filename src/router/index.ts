/**
 * `@deepcoreprotocol/sdk/router` — the DeepCore Router API client. See `client.ts` for what it verifies.
 */
export {
  DeepCoreRouterClient,
  DeepCoreRouterError,
  approvalsOf,
  type DeepCoreRouterClientOptions,
  type RouterApproval,
  type RouterErrorCode,
  type RouterQuote,
  type RouterRoutedFee,
  type RouterSwap,
} from "./client.js";

// Calldata verification for integrators that build their own flow around the API (audit D, 2026-10-07).
export { verifySwapCalldata, swapKindFromCalldata, UnverifiedSwapCalldata, FILL_ABI as DEEPCORE_FILL_ROUTER_FILL_ABI, type SwapRequestFacts, type SwapTxFacts } from "./verify.js";
