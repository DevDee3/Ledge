## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```

## Deploy to Base

```bash
cp .env.example .env            # set BASE_SEPOLIA_RPC_URL and LEDGE_ORACLE, then:
source .env
forge install foundry-rs/forge-std
forge test && forge coverage --report summary

cast wallet import deployer --interactive      # one-time: stores your key in an encrypted keystore

# LEDGE_ORACLE must be a Base-compatible adapter that implements the registry's oracle call shape.
# 1. Simulate (sends nothing)
forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --account deployer -vvv
# 2. Base Sepolia
forge script script/Deploy.s.sol:Deploy --rpc-url base_sepolia --account deployer --broadcast -vvv
# 3. Base mainnet, only after testnet validation and an audited oracle adapter
forge script script/Deploy.s.sol:Deploy --rpc-url base --account deployer --broadcast -vvv
```
The registry address and deploy block are in `broadcast/Deploy.s.sol/<chainId>/run-latest.json`
(`contractAddress`, and `receipts[0].blockNumber` which is hex). Put them in the web app's `.env.local`.

`script/DeployLocal.s.sol` is for a local Anvil chain only. It deploys a mock oracle for development.
Base deployments use an explicit oracle adapter. A manual/testnet adapter is suitable only for
controlled testing, not production.

For a controlled Base Sepolia test deployment, set `ORACLE_OWNER` and run:

```bash
forge script script/DeployBaseTestnet.s.sol:DeployBaseTestnet --rpc-url base_sepolia --account deployer --broadcast -vvv
```

The script prints both addresses. Set the printed oracle and registry addresses in the web app, then
publish raw prices with `cast send <ORACLE> "set(uint32,uint64)" <INDEX> <PRICE>` before committing
or settling plans. This manual oracle is intentionally not production-safe.

For the Base-native market layer, set `MARKET_OWNER` and run:

```bash
forge script script/DeployBaseMarket.s.sol:DeployBaseMarket --rpc-url base_sepolia --account deployer --broadcast -vvv
```

The script prints the collateral token and factory. Set those as `NEXT_PUBLIC_LEDGE_COLLATERAL`
and `NEXT_PUBLIC_MARKET_FACTORY` in the web app.
