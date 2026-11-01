const { expect } = require("chai");
const { ethers } = require("hardhat");

const E = (value) => ethers.parseUnits(String(value), 18);

describe("FthgGameBridge", () => {
  let token, bridge, sourceAdmin, reserveAdmin, gameService, user, recipient;
  const accountId = ethers.id("featheral-game-account");

  async function deployPool() {
    token = await (await ethers.getContractFactory("FeatheralGold")).deploy(sourceAdmin.address);
    bridge = await (await ethers.getContractFactory("FthgGameBridge")).deploy(
      await token.getAddress(),
      sourceAdmin.address,
      reserveAdmin.address,
      gameService.address,
    );
    await token.transfer(await bridge.getAddress(), E(100));
    await bridge.connect(sourceAdmin).initializePool(E(100_000));
  }

  beforeEach(async () => {
    [sourceAdmin, reserveAdmin, gameService, user, recipient] = await ethers.getSigners();
    await deployPool();
  });

  it("keeps the published bridge ABI synchronized with the Solidity source", async () => {
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const artifact = JSON.parse(fs.readFileSync("sites/shared/abi/FthgGameBridge.json", "utf8"));
    const source = fs.readFileSync("contracts/FthgGameBridge.sol");
    const compiled = await require("hardhat").artifacts.readArtifact("FthgGameBridge");
    expect(artifact.sourceSha256).to.equal(crypto.createHash("sha256").update(source).digest("hex"));
    expect(artifact.abi).to.deep.equal(compiled.abi);
    expect(artifact).not.to.have.property("bytecode");
  });

  it("starts at 1:1000 only from deposited FTHG and a matching game-ledger budget", async () => {
    expect(await bridge.reserveFthg()).to.equal(E(100));
    expect(await bridge.reserveFthDollar()).to.equal(E(100_000));
    expect(await bridge.spotRate()).to.equal(E(1_000));
    expect(await token.balanceOf(await bridge.getAddress())).to.equal(E(100));
  });

  it("adds only deposited FTHG to the curve after an explicit admin sync", async () => {
    const bridgeAddress = await bridge.getAddress();
    await token.transfer(bridgeAddress, E(5));
    await expect(bridge.connect(user).syncDepositedFthg()).to.be.reverted;
    await expect(bridge.connect(reserveAdmin).syncDepositedFthg())
      .to.emit(bridge, "FthgReserveAdded")
      .withArgs(E(5), E(105));
    expect(await bridge.reserveFthg()).to.equal(E(105));
    expect(await token.balanceOf(bridgeAddress)).to.equal(E(105));
  });

  it("rejects a pool seed that does not match the initial rate", async () => {
    const empty = await (await ethers.getContractFactory("FthgGameBridge")).deploy(
      await token.getAddress(),
      sourceAdmin.address,
      reserveAdmin.address,
      gameService.address,
    );
    await token.transfer(await empty.getAddress(), E(1));
    await expect(empty.connect(sourceAdmin).initializePool(E(999)))
      .to.be.revertedWithCustomError(empty, "InvalidPoolSeed");
  });

  it("quotes and settles FTHG conversions against changing constant-product reserves", async () => {
    await token.transfer(user.address, E(1));
    await token.connect(user).approve(await bridge.getAddress(), E(1));
    const quote = await bridge.quoteFthDollarOut(E(1));
    await expect(bridge.connect(user).convertFthg(E(1), quote, accountId))
      .to.emit(bridge, "FthgConverted")
      .withArgs(user.address, accountId, E(1), quote, E(101), E(100_000) - quote);
    expect(await bridge.spotRate()).to.be.lessThan(E(1_000));
  });

  it("allows only the game service to redeem FTH$ for funded FTHG", async () => {
    const redemptionId = ethers.id("redemption-1");
    const quote = await bridge.quoteFthgOut(E(100));
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    await expect(bridge.connect(user).redeemFthDollar(E(100), quote, recipient.address, accountId, redemptionId, deadline))
      .to.be.reverted;
    await expect(bridge.connect(gameService).redeemFthDollar(E(100), quote, recipient.address, accountId, redemptionId, deadline))
      .to.emit(bridge, "FthDollarRedeemed")
      .withArgs(redemptionId, accountId, recipient.address, E(100), quote, E(100) - quote, E(100_100));
    await expect(bridge.connect(gameService).redeemFthDollar(E(100), quote, recipient.address, accountId, redemptionId, deadline))
      .to.be.revertedWithCustomError(bridge, "RedemptionAlreadyUsed");
    expect(await token.balanceOf(recipient.address)).to.equal(quote);
  });

  it("locks a 6% simple-interest FTHG stake until the signed game-year matures", async () => {
    await token.approve(await bridge.getAddress(), E(10));
    await expect(bridge.connect(sourceAdmin).stake(E(10), 1, accountId))
      .to.be.revertedWithCustomError(bridge, "GameClockUnavailable");
    await bridge.connect(gameService).setGameYear(7);
    await expect(bridge.connect(sourceAdmin).stake(E(10), 1, accountId))
      .to.emit(bridge, "FthgStaked")
      .withArgs(1, sourceAdmin.address, accountId, E(10), 1, 8, E(600), E(1_000));
    expect(await bridge.totalStakedFthg()).to.equal(E(10));
    await expect(bridge.connect(sourceAdmin).claimStake(1)).to.be.revertedWithCustomError(bridge, "StakeNotMature");
    await bridge.connect(gameService).setGameYear(8);
    await expect(bridge.connect(user).claimStake(1))
      .to.emit(bridge, "StakeClaimed")
      .withArgs(1, sourceAdmin.address, accountId, E(10), E(600));
    expect(await bridge.totalStakedFthg()).to.equal(0);
    expect(await token.balanceOf(sourceAdmin.address)).to.equal(E(216_265_000) - E(100));
  });

  it("supports only the published game-year staking terms", async () => {
    await token.approve(await bridge.getAddress(), E(10));
    await bridge.connect(gameService).setGameYear(1);
    await expect(bridge.connect(sourceAdmin).stake(E(10), 3, accountId))
      .to.be.revertedWithCustomError(bridge, "UnsupportedTerm");
  });

  it("allows either fixed admin to configure treasury settings and rejects unauthorized callers", async () => {
    await bridge.connect(reserveAdmin).setBaseAprBps(500);
    expect(await bridge.baseAprBps()).to.equal(500);
    await expect(bridge.connect(user).addFthDollarBudget(E(1))).to.be.reverted;
    await expect(bridge.connect(gameService).setGameYear(1)).not.to.be.reverted;
  });

  it("pauses new swaps and stakes while leaving matured principal claims available", async () => {
    await bridge.connect(sourceAdmin).pause();
    await token.transfer(user.address, E(1));
    await token.connect(user).approve(await bridge.getAddress(), E(1));
    await expect(bridge.connect(user).convertFthg(E(1), 0, accountId)).to.be.reverted;
    await expect(bridge.connect(user).stake(E(1), 1, accountId)).to.be.reverted;
    await bridge.connect(gameService).setGameYear(1);
    await token.approve(await bridge.getAddress(), E(10));
    await bridge.connect(sourceAdmin).unpause();
    await bridge.connect(sourceAdmin).stake(E(10), 1, accountId);
    await bridge.connect(sourceAdmin).pause();
    await bridge.connect(gameService).setGameYear(2);
    await expect(bridge.connect(user).claimStake(1)).not.to.be.reverted;
  });
});
