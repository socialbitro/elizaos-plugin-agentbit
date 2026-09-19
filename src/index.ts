/**
 * elizaos-plugin-agentbit — the AgentBIT Router as an elizaOS plugin.
 *
 * Adds two actions to your elizaOS agent:
 *   • AGENTBIT_ROUTE    — run the single best x402 tool for a task across the whole
 *                         ecosystem (14,000+ tools, including external sellers) and
 *                         return the result. Pay-per-call in USDC on Base; the agent
 *                         signs an EIP-3009 authorization with its own key.
 *   • AGENTBIT_DISCOVER — free: search what tools exist for a task (no payment).
 *
 * Setup — add to your character/runtime settings (or env):
 *   AGENTBIT_WALLET_PRIVATE_KEY = 0x…   (an EVM key with a little USDC on Base)
 *   AGENTBIT_BASE_URL           = https://agentbit.app   (optional)
 *   AGENTBIT_MAX_USDC           = 0.05                    (optional per-call cap)
 *
 * Then register the plugin:
 *   import { agentbitPlugin } from "elizaos-plugin-agentbit";
 *   // plugins: [agentbitPlugin]
 *
 * No AgentBIT API key, no signup. The agent's wallet needs a little USDC on Base.
 */
import {
  type Action,
  type Plugin,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  elizaLogger,
} from "@elizaos/core";
import { routeExecute } from "./x402.js";

function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const v = runtime.getSetting(key);
  if (v !== null && v !== undefined && v !== "") {
    return v;
  }
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[key];
}

function walletKey(runtime: IAgentRuntime): string | undefined {
  return (
    setting(runtime, "AGENTBIT_WALLET_PRIVATE_KEY") ??
    setting(runtime, "EVM_PRIVATE_KEY") ??
    setting(runtime, "WALLET_PRIVATE_KEY")
  );
}

function baseUrl(runtime: IAgentRuntime): string {
  return setting(runtime, "AGENTBIT_BASE_URL") ?? "https://agentbit.app";
}

function maxUsdc(runtime: IAgentRuntime): number | undefined {
  const raw = setting(runtime, "AGENTBIT_MAX_USDC");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const routeAction: Action = {
  name: "AGENTBIT_ROUTE",
  similes: [
    "ROUTE_TASK",
    "RUN_X402_TOOL",
    "PAY_PER_CALL",
    "USE_AGENTBIT",
    "RUN_EXTERNAL_TOOL",
    "GET_ONCHAIN_DATA",
  ],
  description:
    "Run the single best x402 tool for a task across the whole ecosystem (14,000+ tools, including external sellers) and return the result. Use this whenever no built-in action/tool covers what the user needs — e.g. real-time or on-chain data, web extraction, wallet/sanctions screening, specialized computation. Pays per call in USDC on Base automatically from the agent's own wallet.",
  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    // Only available when a wallet key is configured to sign the payment.
    return Boolean(walletKey(runtime));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: { [key: string]: unknown } | undefined,
    callback?: HandlerCallback,
  ): Promise<boolean> => {
    const privateKey = walletKey(runtime);
    if (!privateKey) {
      await callback?.({
        text: "AgentBIT is not configured: set AGENTBIT_WALLET_PRIVATE_KEY (an EVM key with a little USDC on Base).",
      });
      return false;
    }

    const task = (message.content?.text ?? "").trim();
    if (!task) {
      await callback?.({ text: "Tell me what to run and I'll route it to the best x402 tool." });
      return false;
    }

    const resource = typeof _options?.resource === "string" ? (_options.resource as string) : undefined;
    const body =
      _options?.body && typeof _options.body === "object" ? (_options.body as Record<string, unknown>) : undefined;

    try {
      const result = await routeExecute({
        baseUrl: baseUrl(runtime),
        privateKey,
        task,
        resource,
        body,
        maxAmountUsdc: maxUsdc(runtime),
      });

      const payload = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      const text = result.ok
        ? `${result.message}\n\n${payload}`
        : `AgentBIT could not complete that: ${result.message}`;

      await callback?.({ text, source: "agentbit" });
      return result.ok;
    } catch (e) {
      elizaLogger.error(`AGENTBIT_ROUTE failed: ${e instanceof Error ? e.message : String(e)}`);
      await callback?.({ text: `AgentBIT error: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  },
  examples: [
    [
      { user: "{{user1}}", content: { text: "What's the current Ethereum gas price?" } },
      {
        user: "{{agent}}",
        content: { text: "Let me fetch that via AgentBIT.", action: "AGENTBIT_ROUTE" },
      },
    ],
    [
      { user: "{{user1}}", content: { text: "Screen wallet 0x1234…abcd for sanctions." } },
      {
        user: "{{agent}}",
        content: { text: "Running a sanctions screen through AgentBIT.", action: "AGENTBIT_ROUTE" },
      },
    ],
    [
      { user: "{{user1}}", content: { text: "Extract the main article text from https://example.com/post" } },
      {
        user: "{{agent}}",
        content: { text: "I'll route that to a web-extraction tool via AgentBIT.", action: "AGENTBIT_ROUTE" },
      },
    ],
  ],
};

const discoverAction: Action = {
  name: "AGENTBIT_DISCOVER",
  similes: ["DISCOVER_TOOLS", "FIND_X402_TOOL", "SEARCH_TOOLS", "WHAT_TOOLS"],
  description:
    "Free: search which x402 tools exist for a task across the AgentBIT meta-marketplace, without paying or running anything. Use when the user asks what is available rather than to run something now.",
  validate: async (): Promise<boolean> => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: { [key: string]: unknown } | undefined,
    callback?: HandlerCallback,
  ): Promise<boolean> => {
    const q = (message.content?.text ?? "").trim();
    const url = `${baseUrl(runtime).replace(/\/+$/, "")}/api/discover?q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      await callback?.({ text: JSON.stringify(data), source: "agentbit" });
      return res.ok;
    } catch (e) {
      elizaLogger.error(`AGENTBIT_DISCOVER failed: ${e instanceof Error ? e.message : String(e)}`);
      await callback?.({ text: `AgentBIT discovery error: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  },
  examples: [
    [
      { user: "{{user1}}", content: { text: "What x402 tools are there for blockchain data?" } },
      {
        user: "{{agent}}",
        content: { text: "Let me search AgentBIT for matching tools.", action: "AGENTBIT_DISCOVER" },
      },
    ],
  ],
};

export const agentbitPlugin: Plugin = {
  name: "agentbit",
  description:
    "AgentBIT Router — one action to run the best x402 tool for any task across 14,000+ tools and pay per call in USDC on Base.",
  actions: [routeAction, discoverAction],
  evaluators: [],
  providers: [],
};

export { routeExecute } from "./x402.js";
export type { RouteParams, RouteResult } from "./x402.js";
export default agentbitPlugin;
