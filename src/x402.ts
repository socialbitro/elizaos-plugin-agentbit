/**
 * Minimal x402 (v2) client for the AgentBIT Router.
 *
 * Runs one task against https://agentbit.app/v1/route/execute: sends an unpaid
 * request, receives the HTTP 402 payment requirements, signs an EIP-3009
 * TransferWithAuthorization (USDC on Base) with the agent's own key, and replays
 * the request with the payment — the router then executes the best x402 tool for
 * the task and returns the result. Self-contained: no AgentBIT API key, no signup.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

/** EIP-3009 TransferWithAuthorization typed-data types (USDC / EIP-712). */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface RouteParams {
  /** AgentBIT base URL (default https://agentbit.app). */
  baseUrl?: string;
  /** The agent's EVM private key (0x-prefixed). Signs the USDC payment. */
  privateKey: string;
  /** Plain-language task; the router picks the single best x402 tool for it. */
  task: string;
  /** Optional explicit x402 resource URL to run instead of auto-picking. */
  resource?: string;
  /** Optional input passed to the chosen tool. */
  body?: Record<string, unknown>;
  /** Per-call spend cap in USDC. If the priced route exceeds it, refuse to pay. */
  maxAmountUsdc?: number;
}

export interface RouteResult {
  ok: boolean;
  /** The tool result (or an error object) as returned by the router. */
  data: unknown;
  /** The USDC amount paid, in whole USDC (0 when nothing was paid). */
  paidUsdc: number;
  /** A short human-readable summary of what happened. */
  message: string;
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  // Node 18+ and modern runtimes expose Web Crypto on globalThis.
  const c: Crypto = (globalThis as unknown as { crypto: Crypto }).crypto;
  c.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

function b64decode(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

function b64encode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/**
 * Execute one task through the AgentBIT Router, paying via x402 if required.
 * Never throws for expected conditions — returns a RouteResult describing the
 * outcome so an agent action can relay it cleanly.
 */
export async function routeExecute(params: RouteParams): Promise<RouteResult> {
  const baseUrl = (params.baseUrl ?? "https://agentbit.app").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/route/execute`;

  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(params.privateKey as Hex);
  } catch (e) {
    return { ok: false, data: null, paidUsdc: 0, message: `Invalid wallet private key: ${errMsg(e)}` };
  }
  const buyer = account.address;

  const requestBody = JSON.stringify({
    task: params.task,
    ...(params.resource ? { resource: params.resource } : {}),
    body: params.body ?? {},
  });
  // Send the wallet up front so the 402 already reflects any volume discount
  // (X-BUYER-WALLET) — the agent then signs the discounted amount automatically.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "X-BUYER-WALLET": buyer,
  };

  // 1) unpaid request -> 402 with payment requirements
  let first: Response;
  try {
    first = await fetch(url, { method: "POST", headers, body: requestBody });
  } catch (e) {
    return { ok: false, data: null, paidUsdc: 0, message: `AgentBIT router unreachable: ${errMsg(e)}` };
  }

  if (first.status !== 402) {
    // No payment needed (e.g. free trial / cached) — return whatever we got.
    const data = await first.json().catch(() => ({ status: first.status }));
    return { ok: first.ok, data, paidUsdc: 0, message: first.ok ? "Completed without payment." : `Router returned HTTP ${first.status}.` };
  }

  const requiredHeader = first.headers.get("PAYMENT-REQUIRED");
  let required: any;
  try {
    required = requiredHeader ? JSON.parse(b64decode(requiredHeader)) : await first.json();
  } catch (e) {
    return { ok: false, data: null, paidUsdc: 0, message: `Could not read payment requirements: ${errMsg(e)}` };
  }

  const req = (required.accepts ?? []).find(
    (a: any) => (a.scheme ?? "exact") === "exact" && String(a.network ?? "").startsWith("eip155:"),
  );
  if (!req) {
    return { ok: false, data: null, paidUsdc: 0, message: "Router returned no payable (exact/EVM) option." };
  }

  const amount = String(req.amount ?? req.maxAmountRequired ?? "0");
  if (!/^\d+$/.test(amount)) {
    return { ok: false, data: null, paidUsdc: 0, message: `Router returned an unreadable price (${amount}).` };
  }
  const amountUsdc = Number(amount) / 1_000_000;

  if (params.maxAmountUsdc !== undefined && amountUsdc > params.maxAmountUsdc) {
    return {
      ok: false,
      data: null,
      paidUsdc: 0,
      message: `Route price ${amountUsdc} USDC exceeds the cap of ${params.maxAmountUsdc} USDC — not paid.`,
    };
  }

  // 2) sign an EIP-3009 authorization with the agent's wallet
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: buyer,
    to: String(req.payTo),
    value: amount,
    validAfter: String(now - 60),
    validBefore: String(now + Number(req.maxTimeoutSeconds ?? 300)),
    nonce: randomNonce(),
  };
  const chainId = Number(String(req.network).split(":")[1] ?? 0);

  let signature: Hex;
  try {
    signature = await account.signTypedData({
      domain: {
        name: req.extra?.name ?? "USDC",
        version: req.extra?.version ?? "2",
        chainId,
        verifyingContract: req.asset as Hex,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as Hex,
        to: authorization.to as Hex,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
  } catch (e) {
    return { ok: false, data: null, paidUsdc: 0, message: `Failed to sign the x402 payment: ${errMsg(e)}` };
  }

  const paymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted: req,
    payload: { signature, authorization },
    ...(required.extensions ? { extensions: required.extensions } : {}),
  };

  // 3) paid request -> the router runs the tool and returns the result
  let paid: Response;
  try {
    paid = await fetch(url, {
      method: "POST",
      headers: { ...headers, "PAYMENT-SIGNATURE": b64encode(JSON.stringify(paymentPayload)) },
      body: requestBody,
    });
  } catch (e) {
    return { ok: false, data: null, paidUsdc: 0, message: `AgentBIT payment failed: ${errMsg(e)}` };
  }

  const data = await paid.json().catch(() => ({ status: paid.status }));
  if (!paid.ok) {
    return { ok: false, data, paidUsdc: 0, message: `Router returned HTTP ${paid.status} after payment.` };
  }
  return { ok: true, data, paidUsdc: amountUsdc, message: `Ran the best x402 tool and paid ${amountUsdc} USDC.` };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
