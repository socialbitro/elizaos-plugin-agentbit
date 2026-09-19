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
| `AGENTBIT_WALLET_PRIVATE_KEY` | ✅ | — | An EVM private key (`0x…`) with a little USDC on Base. Signs each payment. Also read from `EVM_PRIVATE_KEY` / `WALLET_PRIVATE_KEY`. |
| `AGENTBIT_BASE_URL` | | `https://agentbit.app` | Override the AgentBIT endpoint. |
| `AGENTBIT_MAX_USDC` | | none | Per-call spend cap in USDC. If a route is priced above it, the call is refused instead of paid. |

> Fund the agent's wallet with a small amount of USDC on Base. The wallet address that pays also unlocks **volume discounts** automatically (the plugin sends `X-BUYER-WALLET`, so returning agents get the loyalty price with no extra step). The first eligible call is **free**.

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
