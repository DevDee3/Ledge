# Ledge

Ledge is a Base-native protection application for modelling and executing loss-capped hedges through binary outcome markets. It combines a Next.js web app with Foundry smart contracts for a controlled Base Sepolia testnet deployment.

> **Testnet software:** this repository is currently intended for Base Sepolia experimentation. The included faucet token, manually controlled oracle, and market-owner controls are not suitable for mainnet or production custody.

## What the project does

1. Loads live binary markets from the deployed Base market factory.
2. Models a hedge for a long or short position across a chosen price window.
3. Shows the expiry payoff, premium, available depth, and loss-cap result.
4. Connects an injected EVM wallet such as MetaMask or Rabby.
5. Approves the test collateral and buys the selected Base market legs.
6. Verifies the hedge legs from successful Base transaction receipts.
7. Commits the intended protection plan to `LedgeRegistry` on-chain.

The registry records the plan and its oracle-derived entry price. It does not custody the hedge or independently prove that market legs were purchased; the frontend's fill verification is a separate step.

## Repository layout

```text
Contracts/   Solidity contracts, Foundry scripts, and tests
Web/         Next.js frontend, market API, wallet flow, and hedge calculator
```

## Prerequisites

- Node.js and npm
- Foundry (`forge`, `cast`, and optionally `anvil`)
- An EVM wallet with Base Sepolia ETH for gas
- A deployed Base Sepolia registry, oracle, market factory, and collateral token
- An RPC endpoint for Base Sepolia; the public endpoint works for light testing, while a provider endpoint is recommended for repeated use

## Run the web app

```bash
cd Web
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

`NEXT_PUBLIC_*` values are embedded into the frontend at build time. Restart the dev server or rebuild after changing them.

Minimum Base Sepolia configuration in `Web/.env`:

```env
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_EVM_RPC=https://sepolia.base.org
NEXT_PUBLIC_LEDGE_REGISTRY=0x...
NEXT_PUBLIC_LEDGE_ORACLE=0x...
NEXT_PUBLIC_MARKET_FACTORY=0x...
NEXT_PUBLIC_LEDGE_COLLATERAL=0x...
NEXT_PUBLIC_LEDGE_DEPLOY_BLOCK=12345678
NEXT_PUBLIC_ENABLE_TRADING=0
LEDGE_DISABLE_DEMO=1
```

Set `NEXT_PUBLIC_ENABLE_TRADING=1` only after verifying the deployed contracts, market books, oracle prices, and wallet flow.

## Deploy Base Sepolia contracts

From `Contracts/`, configure `.env` without committing private keys:

```env
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
ORACLE_OWNER=0x...
MARKET_OWNER=0x...
```

Import a deployer into Foundry's encrypted keystore:

```bash
cast wallet import deployer --interactive
```

Deploy the testnet oracle and registry:

```bash
forge script script/DeployBaseTestnet.s.sol:DeployBaseTestnet \
  --rpc-url base_sepolia \
  --account deployer \
  --broadcast \
  -vvv
```

Deploy the Base-native collateral and market factory:

```bash
forge script script/DeployBaseMarket.s.sol:DeployBaseMarket \
  --rpc-url base_sepolia \
  --account deployer \
  --broadcast \
  -vvv
```

Copy the printed Oracle, Registry, Collateral, and Factory addresses into `Web/.env`. Also set `NEXT_PUBLIC_LEDGE_DEPLOY_BLOCK` to the registry deployment block. Do not leave it as `0`; the app uses it to avoid an oversized event scan.

The testnet oracle is owner-controlled. Before committing a BTC plan, publish its reference price, for example:

```bash
cast send 0xORACLE \
  "set(uint32,uint64)" 0 64000 \
  --rpc-url https://sepolia.base.org \
  --account deployer
```

Index `0` is BTC in the current testnet configuration. The manual oracle must be replaced with an audited, trust-minimized oracle before any mainnet consideration.

## User flow

1. Select BTC, ETH, or SOL and choose long or short.
2. Adjust notional, loss cap, and protection window.
3. Confirm that the payoff chart and market data are live—not demo data.
4. Connect a wallet on Base Sepolia.
5. Refresh markets before trading if the market timestamp is older than 30 seconds.
6. Click **Buy hedge legs** and approve each collateral allowance and market purchase.
7. Wait for every leg to show verified from Base receipts.
8. Click **Commit this hedge on-chain**.

Two confirmations per hedge leg are currently expected: one collateral approval and one market purchase. The registry commit is an additional transaction.

## Development checks

```bash
cd Web
npm test
npm run build
```

For contracts:

```bash
cd Contracts
forge build
forge test
```

## Troubleshooting

- **Market factory is not configured:** set `NEXT_PUBLIC_MARKET_FACTORY` and rebuild.
- **RPC request failed:** verify the RPC URL with `cast chain-id --rpc-url ...`; Base Sepolia must return `84532`.
- **`eth_getLogs` or deployment-block error:** set the actual registry deployment block in `NEXT_PUBLIC_LEDGE_DEPLOY_BLOCK`, not zero.
- **Commit gas estimation fails:** verify that the oracle has a non-zero price for the selected asset index and that the wallet has native Base Sepolia ETH.
- **Buy button disabled:** inspect the message beside it. Trading must be enabled, executable legs must exist, and the loss cap must be met.
- **Demo data warning:** do not execute trades using simulated data. Keep `LEDGE_DISABLE_DEMO=1` for user-facing deployments.

## Security and launch status

This repository is a testnet prototype. Before mainnet use, it still requires an independent smart-contract audit, a production-grade oracle, hardened market creation and resolution permissions, operational monitoring, key management, rate-limit strategy, deployment verification, and end-to-end testing against the final deployed addresses.

See the more detailed component documentation in [`Contracts/README.md`](Contracts/README.md) and [`Web/README.md`](Web/README.md).
