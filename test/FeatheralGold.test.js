const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (n) => ethers.parseUnits(String(n), 18);
const SUPPLY = E(216265000);

describe("FeatheralGold", () => {
  let t, admin, a, b;
  beforeEach(async () => {
    [admin, a, b] = await ethers.getSigners();
    t = await (await ethers.getContractFactory("FeatheralGold")).deploy(admin.address);
  });

  it("admin ABI artifact is in sync with the source", async () => {
    const fs = require("fs"), crypto = require("crypto");
    const x = JSON.parse(fs.readFileSync("sites/shared/abi/FeatheralGold.json", "utf8"));
    const src = fs.readFileSync("contracts/FeatheralGold.sol");
    const art = await require("hardhat").artifacts.readArtifact("FeatheralGold");
    expect(x.sourceSha256).to.equal(crypto.createHash("sha256").update(src).digest("hex"));
    expect(x.totalSupply).to.equal(SUPPLY.toString());
    expect(x.abi).to.deep.equal(art.abi);
    expect(x).not.to.have.property("bytecode");
  });

  it("mints the fixed world-gold supply (216,265,000 kg) once", async () => {
    expect(await t.symbol()).to.equal("FTHG");
    expect(await t.totalSupply()).to.equal(SUPPLY);
    expect(await t.balanceOf(admin.address)).to.equal(SUPPLY);
  });

  it("has no way to change supply", async () => {
    for (const fn of ["mint", "burn", "burnFrom", "setSupplyCap"]) expect(t.interface.hasFunction(fn)).to.equal(false);
  });

  it("rejects zero admin", async () => {
    const f = await ethers.getContractFactory("FeatheralGold");
    await expect(f.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(f, "ZeroAddress");
  });

  it("restricts privileged functions", async () => {
    await expect(t.connect(a).pause()).to.be.reverted;
    await expect(t.connect(a).setBlacklisted(b.address, true)).to.be.reverted;
    await expect(t.connect(a).setRate(1)).to.be.reverted;
    await expect(t.connect(a).setMetadataURI("x")).to.be.reverted;
  });

  it("pauses transfers", async () => {
    await t.pause();
    await expect(t.transfer(a.address, 1)).to.be.reverted;
    await t.unpause();
    await t.transfer(a.address, 1);
  });

  it("blocks blacklisted accounts", async () => {
    await t.transfer(a.address, E(10));
    await t.setBlacklisted(a.address, true);
    await expect(t.connect(a).transfer(b.address, 1)).to.be.revertedWithCustomError(t, "Blacklisted");
    await expect(t.transfer(a.address, 1)).to.be.revertedWithCustomError(t, "Blacklisted");
  });

  it("exchange moves FTHG to treasury without changing supply", async () => {
    await t.transfer(a.address, E(10));
    await expect(t.connect(a).exchangeForFthDollar(E(1), ethers.id("acct"))).to.be.revertedWithCustomError(t, "ExchangeDisabled");
    await expect(t.setGameExchangeEnabled(true)).to.be.revertedWithCustomError(t, "InvalidRate");
    await expect(t.setRate(0)).to.be.revertedWithCustomError(t, "InvalidRate");
    await t.setTreasury(b.address);
    await t.setRate(E(100));
    await t.setGameExchangeEnabled(true);
    await expect(t.connect(a).exchangeForFthDollar(0, ethers.id("acct"))).to.be.revertedWithCustomError(t, "ZeroAmount");
    await expect(t.connect(a).exchangeForFthDollar(E(2), ethers.id("acct")))
      .to.emit(t, "ExchangedForFthDollar")
      .withArgs(a.address, ethers.id("acct"), E(2), E(200));
    expect(await t.balanceOf(a.address)).to.equal(E(8));
    expect(await t.balanceOf(b.address)).to.equal(E(2));
    expect(await t.totalSupply()).to.equal(SUPPLY);
  });
});
