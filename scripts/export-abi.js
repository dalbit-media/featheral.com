const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

(async () => {
  const { default: hre } = await import("hardhat");
  await hre.tasks.getTask("build").run({ quiet: true });
  const abiDir = path.join(__dirname, "..", "shared", "abi");
  fs.mkdirSync(abiDir, { recursive: true });
  const art = await hre.artifacts.readArtifact("FeatheralGold");
  const bridgeArt = await hre.artifacts.readArtifact("FthgGameBridge");
  const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "FeatheralGold.sol"));
  const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "contracts", "FthgGameBridge.sol"));
  const cfg = hre.config.solidity.profiles.default.compilers[0];
  const out = {
    contractName: art.contractName,
    abi: art.abi,
    sourceSha256: crypto.createHash("sha256").update(src).digest("hex"),
    compiler: { version: cfg.version, optimizer: cfg.settings.optimizer, evmVersion: cfg.settings.evmVersion },
    openzeppelin: require("@openzeppelin/contracts/package.json").version,
    totalSupply: "216265000000000000000000000",
  };
  fs.writeFileSync(path.join(abiDir, "FeatheralGold.json"), JSON.stringify(out, null, 2));
  const bridgeOut = {
    contractName: bridgeArt.contractName,
    abi: bridgeArt.abi,
    sourceSha256: crypto.createHash("sha256").update(bridgeSrc).digest("hex"),
    compiler: { version: cfg.version, optimizer: cfg.settings.optimizer, evmVersion: cfg.settings.evmVersion },
    openzeppelin: require("@openzeppelin/contracts/package.json").version,
  };
  fs.writeFileSync(path.join(abiDir, "FthgGameBridge.json"), JSON.stringify(bridgeOut, null, 2));
  console.log(`Wrote shared/abi/FeatheralGold.json (ABI only, solc ${cfg.version}, OZ ${out.openzeppelin})`);
  console.log(`Wrote shared/abi/FthgGameBridge.json (ABI only, new dynamic bridge interface)`);
})().catch((e) => { console.error(e); process.exit(1); });
