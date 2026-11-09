const { expect } = require("chai");
const path = require("node:path");
const { createRequire } = require("node:module");
const { generateKeyPairSync } = require("node:crypto");

describe("Dependency toolchain", () => {
  it("preserves CommonJS application scopes alongside the ESM Hardhat config", async () => {
    expect(require("../package.json").type).to.equal("module");
    for (const directory of ["scripts", "services", "shared", "sites", "test"]) {
      expect(require(`../${directory}/package.json`).type).to.equal("commonjs");
    }
    expect(require("../sites/world.featheral.com/play/package.json").type).to.equal("module");
    const { default: hre } = await import("hardhat");
    const compiler = hre.config.solidity.profiles.default.compilers[0];
    expect(compiler.version).to.equal("0.8.24");
    expect(compiler.settings.optimizer).to.deep.equal({ enabled: true, runs: 200 });
    expect(compiler.settings.evmVersion).to.equal("cancun");
    expect(require("../services/database/sqlite").open).to.be.a("function");
    expect(require("../shared/gold-pricing").quote).to.be.a("function");
  });

  it("contains no deprecated locked packages and covers every locked install script", () => {
    for (const directory of ["..", "../sites/world.featheral.com/play"]) {
      const manifest = require(`${directory}/package.json`);
      const lock = require(`${directory}/package-lock.json`);
      for (const [name, item] of Object.entries(lock.packages)) {
        expect(item.deprecated, name).to.equal(undefined);
        if (!item.hasInstallScript) continue;
        const packageName = name.split("node_modules/").at(-1);
        const policy = manifest.allowScripts[`${packageName}@${item.version}`] ?? manifest.allowScripts[packageName];
        expect(policy, name).to.be.a("boolean");
      }
    }
  });

  it("runs World esbuild and Sharp image conversion with the installed native binaries", async () => {
    const worldRequire = createRequire(path.resolve(__dirname, "../sites/world.featheral.com/play/package.json"));
    expect(worldRequire("esbuild").transformSync("const value: number = 1", { loader: "ts" }).code).to.include("const value = 1");
    const sharp = require("sharp");
    const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#42697a" } })
      .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).webp().toBuffer();
    const metadata = await sharp(image).metadata();
    expect(metadata.format).to.equal("webp");
    expect(metadata.width).to.equal(320);
    expect(metadata.height).to.equal(240);
  });

  it("loads SSH support and parses an ephemeral host key without native CPU acceleration", () => {
    const { Client, Server, utils } = require("ssh2");
    expect(Client).to.be.a("function");
    expect(Server).to.be.a("function");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const parsed = utils.parseKey(privateKey.export({ type: "pkcs1", format: "pem" }));
    expect(parsed).not.to.be.instanceOf(Error);
    expect(parsed.getPublicSSH()).to.be.instanceOf(Buffer);
  });
});
