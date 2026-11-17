const { expect } = require("chai");
const { ethers } = require("hardhat");

// Local stand-ins only. Nothing here is deployed, demoed or claimed.
describe("BellDesk", function () {
  let deployer, proxy, referee, buyer, seller, outsider;
  let usdc, weth, desk;
  const PRICE = 1_200_000000n; // 1,200 USDC per WETH, micro-units
  const QTY = ethers.parseEther("0.002");

  beforeEach(async function () {
    [deployer, proxy, referee, buyer, seller, outsider] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    usdc = await Mock.deploy("USD Coin", 6);
    weth = await Mock.deploy("Wrapped Ether", 18);
    await usdc.waitForDeployment();
    await weth.waitForDeployment();

    const Desk = await ethers.getContractFactory("BellDesk");
    desk = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress());
    await desk.waitForDeployment();
    await desk.setReferee(referee.address);

    await usdc.mint(buyer.address, 10_000_000000n);
    await weth.mint(seller.address, ethers.parseEther("1"));
  });

  describe("setReferee", function () {
    it("lets only the deployer set it, and only once", async function () {
      const Desk = await ethers.getContractFactory("BellDesk");
      const fresh = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress());
      await expect(fresh.connect(outsider).setReferee(referee.address)).to.be.revertedWithCustomError(
        fresh,
        "NotDeployer"
      );
      await fresh.setReferee(referee.address);
      await expect(fresh.setReferee(outsider.address)).to.be.revertedWithCustomError(fresh, "RefereeAlreadySet");
    });

    it("rejects the zero address", async function () {
      const Desk = await ethers.getContractFactory("BellDesk");
      const fresh = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress());
      await expect(fresh.setReferee(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });
  });

  describe("place", function () {
    it("records the order and emits OrderPlaced without moving funds", async function () {
      await expect(desk.connect(buyer).place(true, PRICE, QTY))
        .to.emit(desk, "OrderPlaced")
        .withArgs(1, buyer.address, true, PRICE, QTY);
      const o = await desk.orders(1);
      expect(o.trader).to.equal(buyer.address);
      expect(o.isBuy).to.equal(true);
      expect(o.price).to.equal(PRICE);
      expect(o.qty).to.equal(QTY);
      expect(await usdc.balanceOf(buyer.address)).to.equal(10_000_000000n);
    });

    it("rejects zero price or quantity", async function () {
      await expect(desk.connect(buyer).place(true, 0, QTY)).to.be.revertedWithCustomError(desk, "ZeroAmount");
      await expect(desk.connect(seller).place(false, PRICE, 0)).to.be.revertedWithCustomError(desk, "ZeroAmount");
    });
  });

  describe("collect", function () {
    beforeEach(async function () {
      await desk.connect(buyer).place(true, PRICE, QTY);
      await desk.connect(seller).place(false, PRICE, QTY);
    });

    it("rejects callers other than the callback proxy", async function () {
      await expect(
        desk.connect(outsider).collect(referee.address, 1, buyer.address, true, 1n)
      ).to.be.revertedWithCustomError(desk, "NotCallbackProxy");
    });

    it("rejects a callback whose RVM id is not the referee", async function () {
      await expect(
        desk.connect(proxy).collect(outsider.address, 1, buyer.address, true, 1n)
      ).to.be.revertedWithCustomError(desk, "NotReferee");
    });

    it("pulls USDC from a buyer who approved the desk", async function () {
      const cost = (QTY * PRICE + ethers.parseEther("1") - 1n) / ethers.parseEther("1");
      await usdc.connect(buyer).approve(await desk.getAddress(), cost);
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, cost))
        .to.emit(desk, "Collected")
        .withArgs(1, buyer.address, cost, true);
      expect(await usdc.balanceOf(await desk.getAddress())).to.equal(cost);
    });

    it("pulls WETH from a seller who approved the desk", async function () {
      await weth.connect(seller).approve(await desk.getAddress(), QTY);
      await expect(desk.connect(proxy).collect(referee.address, 2, seller.address, false, QTY))
        .to.emit(desk, "Collected")
        .withArgs(2, seller.address, QTY, true);
      expect(await weth.balanceOf(await desk.getAddress())).to.equal(QTY);
    });

    it("never reverts on a failed pull, and reports ok = false", async function () {
      await expect(desk.connect(proxy).collect(referee.address, 2, seller.address, false, QTY))
        .to.emit(desk, "Collected")
        .withArgs(2, seller.address, QTY, false);
      expect(await weth.balanceOf(await desk.getAddress())).to.equal(0);
    });

    it("rejects a trader or side that does not match the stored order", async function () {
      await expect(
        desk.connect(proxy).collect(referee.address, 1, outsider.address, true, 1n)
      ).to.be.revertedWithCustomError(desk, "OrderTraderMismatch");
      await expect(
        desk.connect(proxy).collect(referee.address, 1, buyer.address, false, 1n)
      ).to.be.revertedWithCustomError(desk, "OrderTraderMismatch");
    });
  });

  describe("pay", function () {
    it("rejects callers other than the callback proxy", async function () {
      await expect(
        desk.connect(outsider).pay(referee.address, 1, seller.address, true, 1n)
      ).to.be.revertedWithCustomError(desk, "NotCallbackProxy");
    });

    it("pays a counterparty from the desk's pot", async function () {
      await usdc.mint(await desk.getAddress(), 2_400000n);
      await expect(desk.connect(proxy).pay(referee.address, 2, seller.address, true, 2_400000n))
        .to.emit(desk, "Paid")
        .withArgs(2, seller.address, 2_400000n, true);
      expect(await usdc.balanceOf(seller.address)).to.equal(2_400000n);
    });

    it("never reverts on a failed transfer, and reports ok = false", async function () {
      await expect(desk.connect(proxy).pay(referee.address, 2, seller.address, true, 1_000000n))
        .to.emit(desk, "Paid")
        .withArgs(2, seller.address, 1_000000n, false);
    });
  });
});
