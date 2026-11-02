"use strict";

const { ethers } = require("ethers");
const hre = require("hardhat");
const env = require("../services/operations/runtime").environment();
require("../services/operations/configuration").assertDatabaseConfiguration(require("node:path").resolve(__dirname, ".."));

const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const SOURCE_ADMIN = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const RESERVE_ADMIN = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";

async function main() {
  const rpcUrl = env.TOKEN_API_RPC_URL;
  const privateKey = env.BRIDGE_DEPLOYER_PRIVATE_KEY;
  const gameService = env.TOKEN_API_GAME_SERVICE_ADDRESS;
  if (!rpcUrl || !privateKey || !gameService || !ethers.isAddress(gameService)) {
    throw new Error("Set TOKEN_API_RPC_URL, TOKEN_API_GAME_SERVICE_ADDRESS, and BRIDGE_DEPLOYER_PRIVATE_KEY in Admin Settings.");
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== 1n) throw new Error(`Refusing deployment: RPC chain ID is ${network.chainId}, expected Ethereum Mainnet (1).`);
  const deployer = new ethers.Wallet(privateKey, provider);
  await hre.run("compile");
  const artifact = await hre.artifacts.readArtifact("FthgGameBridge");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  console.log(`Deploying the FTHG game bridge from ${deployer.address}. FTHG token remains unchanged.`);
  const bridge = await factory.deploy(TOKEN, SOURCE_ADMIN, RESERVE_ADMIN, gameService);
  const receipt = await bridge.deploymentTransaction().wait(2);
  if (!receipt || receipt.status !== 1) throw new Error("Bridge deployment did not confirm successfully.");
  console.log(`Bridge deployed: ${await bridge.getAddress()}`);
  console.log(`Deployment transaction: ${receipt.hash}`);
  console.log(`Game-service role: ${ethers.getAddress(gameService)}`);
  console.log("The pool is NOT initialized. Deposit only the FTHG reserve you intend to commit, then initialize with a matching FTH$ game-ledger budget.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
