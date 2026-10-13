# Ledge

Ledge helps traders model and execute a loss-capped hedge through Base-native binary outcome markets, with protection records stored on Base.

## Development

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Run the release checks with:

```bash
npm run check
```

This runs ESLint, the unit tests, and a production build.

## Important product limitations

- The calculator is based on payoff at binary expiry; mark-to-market behavior before expiry is different.
- Trading is opt-in via `NEXT_PUBLIC_ENABLE_TRADING=1`; when enabled, the app sends expiring IOC orders and blocks the registry commit unless all legs are verified from recent fills.
- The on-chain registry records the intended plan and prices from its configured oracle adapter; it is not proof of hedge execution.
- Settlement uses the oracle price at the time of settlement inside the settlement window.
- Never trade using simulated/demo market data. Production deployments disable demo fallback automatically.

## Configuration

Copy `.env.example` to `.env.local`. The template targets the Base Sepolia-native Ledge registry and market protocol. Set the deployed registry, oracle adapter, market factory, collateral token, and deployment block before starting the user-facing app. `NEXT_PUBLIC_*` values are embedded at build time, so rebuild after changing them.

Users need an injected browser wallet such as MetaMask or Rabby. The calculator works without a wallet; wallet connection is required to approve collateral, buy Base market legs, and write the protection record on-chain.

The on-chain panel remains hidden until `NEXT_PUBLIC_LEDGE_REGISTRY` is configured. The calculator can run without a deployed registry.

Before enabling trading, deploy the Base market factory and collateral token, then verify the Base Sepolia registry and market addresses before enabling execution.

The market loader and trading path verify that every market's `collateral()` address matches
`NEXT_PUBLIC_LEDGE_COLLATERAL`. A mismatch is rejected before approvals or purchases are sent.
The trading path also checks the wallet's collateral balance and approves only the maximum spend
for each order, rather than approving the requested share amount.

## Local contract flow

The contract lives in `../Contracts` and uses Foundry. Start Anvil, deploy with `script/DeployLocal.s.sol`, then configure the printed registry address and `NEXT_PUBLIC_CHAIN_ID=31337` before starting the web app.

The generated ABI is in `lib/abi.ts`; regenerate it after contract changes with `node scripts/gen-abi.mjs <path-to-compiled-json>`.
