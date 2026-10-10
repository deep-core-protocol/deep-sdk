/**
 * Calldata verification for a swap transaction handed back by the Router API (audit D M-1, 2026-10-07).
 *
 * `DeepCoreRouterClient.swap` pins `tx.to` to DeepCore's own UniversalRouter or DeepCoreFillRouter, but a
 * transaction to the LEGITIMATE router can still be hostile: a compromised or spoofed API could return
 * calldata that pays the trade's output to somebody else, pulls more than `amountIn` through the user's
 * standing Permit2 allowance, or sets `tx.value` above the amount. So the client decodes the bytes and
 * checks them against the request before any wallet sees them — the same discipline the widget already
 * applies to its routed path (`packages/widgets/src/core/routed.ts`, `verifyBuiltRoutedSwap`).
 *
 * What is accepted:
 *  - DeepCoreFillRouter.fill(p): currencies, amountIn, recipient, minAmountOut, wrap/unwrap flags and
 *    maxFeeBps all equal to the request; nothing else.
 *  - UniversalRouter.execute(commands, inputs, deadline): only the commands DeepCore's own swap path
 *    emits (`INFI_SWAP`, `PAY_PORTION`, `SWEEP`, `WRAP_ETH`, `UNWRAP_WETH`); inside an `INFI_SWAP` plan only
 *    swap actions plus SETTLE/TAKE whose currency, amounts and recipients are bounded by the request:
 *    every SETTLE of the user's funds is `tokenIn` for at most `amountIn`, and every TAKE pays the
 *    caller (MSG_SENDER), the request's recipient, or the router itself followed by a SWEEP to one of
 *    those. `PERMIT2_TRANSFER_FROM`, `TRANSFER`, `PERMIT2_PERMIT*`, third-party AMM legs, sub-plans and
 *    pool initialisation are refused outright: none of them is a DeepCore pool swap.
 *  - `tx.value` is `amountIn` when `tokenIn` is the native sentinel and 0 otherwise.
 *
 * Anything it cannot decode is refused: unknown bytes are not "probably fine".
 */
import { decodeAbiParameters, decodeFunctionData, getAbiItem, isAddressEqual, toFunctionSelector, type Address, type Hex } from "viem";

export const NATIVE_SENTINEL: Address = "0x0000000000000000000000000000000000000000";
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";

/** UniversalRouter commands (packages/router/src/libraries/Commands.sol). */
const CMD = {
  SWEEP: 0x04,
  PAY_PORTION: 0x06,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  INFI_SWAP: 0x10,
} as const;
const COMMAND_TYPE_MASK = 0x3f;

/** Infinity plan actions (packages/widgets/src/callpath/constants.ts mirrors the periphery). */
const ACT = {
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  CL_SWAP_EXACT_IN: 0x07,
  CL_SWAP_EXACT_OUT_SINGLE: 0x08,
  CL_SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
  SWEEP: 0x14,
  BIN_SWAP_EXACT_IN_SINGLE: 0x1c,
  BIN_SWAP_EXACT_IN: 0x1d,
  BIN_SWAP_EXACT_OUT_SINGLE: 0x1e,
  BIN_SWAP_EXACT_OUT: 0x1f,
} as const;
const SWAP_ACTIONS = new Set<number>([
  ACT.CL_SWAP_EXACT_IN_SINGLE, ACT.CL_SWAP_EXACT_IN, ACT.CL_SWAP_EXACT_OUT_SINGLE, ACT.CL_SWAP_EXACT_OUT,
  ACT.BIN_SWAP_EXACT_IN_SINGLE, ACT.BIN_SWAP_EXACT_IN, ACT.BIN_SWAP_EXACT_OUT_SINGLE, ACT.BIN_SWAP_EXACT_OUT,
]);

const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export const FILL_ABI = [
  {
    type: "function",
    name: "fill",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "target", type: "address" },
          { name: "currencyIn", type: "address" },
          { name: "currencyOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "minAmountOut", type: "uint256" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "wrapInput", type: "bool" },
          { name: "unwrapOutput", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export interface SwapRequestFacts {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly recipient: Address;
  readonly minAmountOut: bigint;
  readonly deadline: number;
  /** The fee the quote showed, for a fill-router transaction. */
  readonly feeBps?: number;
}

export interface SwapTxFacts {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export class UnverifiedSwapCalldata extends Error {
  constructor(readonly reason: string) {
    super(`swap calldata refused: ${reason}`);
    this.name = "UnverifiedSwapCalldata";
  }
}

const same = (a: Address, b: Address) => isAddressEqual(a, b);
const refuse = (reason: string): never => {
  throw new UnverifiedSwapCalldata(reason);
};

// Derived from the ABIs at load, so a struct change can never leave a stale literal behind.
const EXECUTE_SELECTOR = toFunctionSelector(getAbiItem({ abi: EXECUTE_ABI, name: "execute" })).toLowerCase();
const FILL_SELECTOR = toFunctionSelector(getAbiItem({ abi: FILL_ABI, name: "fill" })).toLowerCase();

/** Which DeepCore router a swap's calldata is for, by selector; `null` for anything else. */
export function swapKindFromCalldata(data: Hex): "universal-router" | "fill-router" | null {
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === EXECUTE_SELECTOR) return "universal-router";
  if (sel === FILL_SELECTOR) return "fill-router";
  return null;
}

/**
 * Throws `UnverifiedSwapCalldata` unless `tx` is exactly the swap `req` describes, addressed to
 * `kind` ("universal-router" | "fill-router").
 */
export function verifySwapCalldata(kind: "universal-router" | "fill-router", tx: SwapTxFacts, req: SwapRequestFacts): void {
  if (!/^0x[0-9a-fA-F]*$/.test(tx.data)) refuse("tx.data is not hex");
  const nativeIn = same(req.tokenIn, NATIVE_SENTINEL);
  const expectedValue = nativeIn ? req.amountIn : 0n;
  if (tx.value !== expectedValue) refuse(`tx.value ${tx.value} is not ${expectedValue}`);
  if (kind === "fill-router") return verifyFill(tx.data, req, nativeIn);
  return verifyExecute(tx.data, req);
}

function verifyFill(data: Hex, req: SwapRequestFacts, nativeIn: boolean): void {
  let p;
  try {
    p = decodeFunctionData({ abi: FILL_ABI, data }).args[0];
  } catch {
    return refuse("calldata is not DeepCoreFillRouter.fill");
  }
  const nativeOut = same(req.tokenOut, NATIVE_SENTINEL);
  if (!same(p.currencyIn, req.tokenIn) || !same(p.currencyOut, req.tokenOut)) refuse("fill trades another pair");
  if (p.wrapInput !== nativeIn || p.unwrapOutput !== nativeOut) refuse("fill wrap/unwrap flags do not match the pair");
  if (p.amountIn !== req.amountIn) refuse("fill spends another amount");
  if (!same(p.recipient, req.recipient)) refuse("fill pays another recipient");
  if (p.minAmountOut < req.minAmountOut) refuse("fill's floor is below the minimum shown");
  if (Number(p.deadline) !== req.deadline) refuse("fill deadline differs from the one shown");
  if (req.feeBps !== undefined && p.maxFeeBps !== req.feeBps) refuse("fill fee differs from the quoted rate");
}

function verifyExecute(data: Hex, req: SwapRequestFacts): void {
  let args;
  try {
    args = decodeFunctionData({ abi: EXECUTE_ABI, data }).args;
  } catch {
    return refuse("calldata is not UniversalRouter.execute");
  }
  const [commands, inputs, deadline] = args;
  if (Number(deadline) !== req.deadline) refuse("execute deadline differs from the one shown");
  const bytes = Buffer.from(commands.slice(2), "hex");
  if (bytes.length === 0 || bytes.length !== inputs.length) refuse("commands and inputs do not line up");
  let takesToRouter = false;
  let sweptToUser = false;
  for (let i = 0; i < bytes.length; i++) {
    const cmd = bytes[i]! & COMMAND_TYPE_MASK;
    const input = inputs[i]!;
    switch (cmd) {
      case CMD.INFI_SWAP: {
        const r = verifyInfiPlan(input, req);
        takesToRouter ||= r.takesToRouter;
        break;
      }
      case CMD.SWEEP:
      case CMD.UNWRAP_WETH:
      case CMD.PAY_PORTION: {
        const [, recipient] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], input);
        if (!(same(recipient, MSG_SENDER) || same(recipient, req.recipient))) refuse("output is paid to a third party");
        if (cmd !== CMD.PAY_PORTION) sweptToUser = true;
        break;
      }
      case CMD.WRAP_ETH: {
        const [recipient, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], input);
        if (!same(recipient, ADDRESS_THIS)) refuse("wrap pays a third party");
        if (amount > req.amountIn && amount !== (1n << 255n)) refuse("wrap exceeds amountIn");
        break;
      }
      default:
        refuse(`command 0x${cmd.toString(16).padStart(2, "0")} is not part of a DeepCore pool swap`);
    }
  }
  if (takesToRouter && !sweptToUser) refuse("output taken to the router is never swept to the user");
}

function verifyInfiPlan(input: Hex, req: SwapRequestFacts): { takesToRouter: boolean } {
  let actions: Hex, params: readonly Hex[];
  try {
    [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);
  } catch {
    return refuse("INFI_SWAP plan is not (actions, params)");
  }
  const acts = Buffer.from(actions.slice(2), "hex");
  if (acts.length === 0 || acts.length !== params.length) refuse("plan actions and params do not line up");
  let takesToRouter = false;
  let settled = false;
  const okRecipient = (r: Address) => same(r, MSG_SENDER) || same(r, req.recipient) || same(r, ADDRESS_THIS);
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]!;
    const p = params[i]!;
    if (SWAP_ACTIONS.has(a)) continue; // the pool swap itself; its floors are the TAKEs' and minAmountOut's business
    switch (a) {
      case ACT.SETTLE_ALL: {
        const [currency, maxAmount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p);
        if (!same(currency, req.tokenIn)) refuse("plan settles a currency other than tokenIn from the user");
        if (maxAmount > req.amountIn) refuse("plan may pull more than amountIn from the user");
        settled = true;
        break;
      }
      case ACT.SETTLE: {
        const [currency, amount, payerIsUser] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], p);
        if (payerIsUser) {
          if (!same(currency, req.tokenIn)) refuse("plan settles a currency other than tokenIn from the user");
          if (amount > req.amountIn) refuse("plan may pull more than amountIn from the user");
          settled = true;
        }
        break;
      }
      case ACT.SETTLE_PAIR:
        refuse("plan settles a pair from the user (not a swap)");
        break;
      case ACT.TAKE:
      case ACT.TAKE_PORTION: {
        const [, recipient] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], p);
        if (!okRecipient(recipient)) refuse("plan takes output to a third party");
        if (same(recipient, ADDRESS_THIS)) takesToRouter = true;
        break;
      }
      case ACT.TAKE_PAIR: {
        const [, , recipient] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], p);
        if (!okRecipient(recipient)) refuse("plan takes output to a third party");
        if (same(recipient, ADDRESS_THIS)) takesToRouter = true;
        break;
      }
      case ACT.TAKE_ALL: {
        const [, minAmount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], p);
        if (minAmount < req.minAmountOut) refuse("plan's floor is below the minimum shown");
        break; // pays msg.sender by construction
      }
      case ACT.CLOSE_CURRENCY:
      case ACT.CLEAR_OR_TAKE:
      case ACT.SWEEP:
        break; // settle-or-take of the plan's own residue; neither pulls from the user nor pays a third party
      default:
        refuse(`plan action 0x${a.toString(16).padStart(2, "0")} is not part of a swap`);
    }
  }
  if (!settled) refuse("plan never settles the input (not a swap the user pays for)");
  return { takesToRouter };
}
