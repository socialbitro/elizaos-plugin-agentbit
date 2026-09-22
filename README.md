# elizaos-plugin-agentbit

**Give your [elizaOS](https://github.com/elizaOS/eliza) agent one action that runs the best x402 tool for any task — across 14,000+ tools, including external sellers — and returns the result.** Pay-per-call in USDC on [Base](https://base.org). No AgentBIT API key, no signup.

The agent pays once, [AgentBIT](https://agentbit.app) picks and runs the best tool for the task (its own or an external x402 seller), and returns the result. The agent signs an [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `TransferWithAuthorization` (gasless USDC) with its own wallet key.

## Install

```bash
npm install elizaos-plugin-agentbit
```

## Configure

Add to your character's `settings.secrets` (or environment):

| Setting | Required | Default | Notes |
| --- | --- | --- | --- |
| `AGENTBIT_WALLET_PRIVATE_KEY` | ✅ | — | A **dedicated** EVM private key (`0x…`) with a little USDC on Base. Signs each payment. |
| `AGENTBIT_MAX_USDC` | | `0.05` | Per-call spend cap in USDC (**default-on**). A route priced above it is refused, not paid. |
| `AGENTBIT_BASE_URL` | | `https://agentbit.app` | Override the AgentBIT endpoint. |
| `AGENTBIT_ALLOW_ANY_ASSET` | | `false` | By default the plugin signs **only USDC on Base** (`eip155:8453`). Set `true` to allow any asset/chain the 402 names (not recommended). |

> Fund the wallet with a small amount of USDC on Base. The paying address also unlocks **volume discounts** automatically (the plugin sends `X-BUYER-WALLET`), and the first eligible call is **free**.

## Security

This action signs on-chain payments, and because its description tells the planner to use it "whenever no built-in tool covers the task", **paid calls can be initiated by the model during an ordinary conversation**. The plugin is hardened accordingly:

- **Dedicated key required.** It signs with `AGENTBIT_WALLET_PRIVATE_KEY`. It will **not** silently use the agent's shared `EVM_PRIVATE_KEY` / `WALLET_PRIVATE_KEY` (its treasury) — those are used only if you explicitly opt in by also setting `AGENTBIT_MAX_USDC`. Use a dedicated, lightly-funded key.
- **Default-on cap.** `AGENTBIT_MAX_USDC` defaults to `0.05`; a route priced above the cap is refused. Set it to bound your per-call spend.
- **Pinned to USDC on Base.** The plugin only signs `exact` payments in USDC (`0x8335…2913`) on Base (`eip155:8453`), so a misconfigured, spoofed, or DNS-hijacked router can't make it sign a different token or chain. Override with `AGENTBIT_ALLOW_ANY_ASSET=true` only if you understand the risk.
- **Bounded authorization window.** The EIP-3009 `validBefore` is clamped to at most 10 minutes regardless of what the 402 requests.

The key is used **only** to sign the EIP-3009 authorization locally (via `viem`, in `src/x402.ts`); it is never transmitted to AgentBIT or logged — only the signed payment payload goes over the wire.

## Register the plugin

```ts
import { agentbitPlugin } from "elizaos-plugin-agentbit";

export const character = {
  name: "MyAgent",
  plugins: [agentbitPlugin],
  settings: {
    secrets: {
      AGENTBIT_WALLET_PRIVATE_KEY: process.env.AGENTBIT_WALLET_PRIVATE_KEY,
      AGENTBIT_MAX_USDC: "0.05",
    },
  },
  // …
};
```

## Actions

### `AGENTBIT_ROUTE`
Runs the single best x402 tool for the user's task and returns the result, paying per call. Fires when no built-in action covers what's needed — real-time or on-chain data, web extraction, wallet/sanctions screening, specialized computation, etc.

### `AGENTBIT_DISCOVER`
Free. Searches which x402 tools exist for a task across the AgentBIT meta-marketplace, without paying or running anything. Use it to answer "what tools are available for X?".

## Programmatic use

You can also call the router directly, without the elizaOS runtime:

```ts
import { routeExecute } from "elizaos-plugin-agentbit";

const result = await routeExecute({
  privateKey: process.env.AGENTBIT_WALLET_PRIVATE_KEY!,
  task: "get the latest Base block height",
  maxAmountUsdc: 0.05,
});

console.log(result.ok, result.paidUsdc, result.data);
```

## How it works

1. The plugin sends the task to `POST /v1/route/execute` (unpaid) with the agent's wallet address.
2. AgentBIT replies `402 Payment Required` with the exact price for the chosen tool.
3. The plugin signs an EIP-3009 USDC authorization for that amount and replays the request.
4. AgentBIT runs the tool, settles the payment on Base, and returns the result.

Learn more at **[agentbit.app](https://agentbit.app)** · [Router](https://agentbit.app/router) · [Integrations](https://agentbit.app/integrations)

## License

MIT © AgentBIT
