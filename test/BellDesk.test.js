const { expect } = require("chai");
const { ethers } = require("hardhat");

// Local stand-ins only, inside test/. The Uniswap v4 PoolManager is the real contract.
// Nothing here is deployed, demoed or claimed.

const ZERO_HOOKS = ethers.ZeroAddress;
const FEE = 500;
const TICK_SPACING = 10;
// 1 WETH = 1,200 USDC. Raw ratio is WETH wei per raw USDC unit.
const RAW_RATIO = 1e18 / 1200e6;
const SQRT_PRICE_X96 = BigInt(Math.round(Math.sqrt(RAW_RATIO) * 2 ** 96));
const CURRENT_TICK = 205410; // near log(RAW_RATIO) / log(1.0001), multiple of 10

async function deploySortedMocks(Mock) {
  // BellDesk needs USDC below WETH. Redeploy until the addresses sort that way.
  for (;;) {
    const a = await Mock.deploy("Token A", 6);
    const b = await Mock.deploy("Token B", 18);
    await a.waitForDeployment();
    await b.waitForDeployment();
    if (BigInt(await a.getAddress()) < BigInt(await b.getAddress())) return { usdc: a, weth: b };
  }
}

describe("BellDesk", function () {
  let deployer, proxy, referee, buyer, seller, outsider, lp;
  let usdc, weth, desk, pm, helper, poolKey;
  const PRICE = 1_200_000000n; // 1,200 USDC per WETH, micro-units
  const QTY = ethers.parseEther("0.002");

  beforeEach(async function () {
    [deployer, proxy, referee, buyer, seller, outsider, lp] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    ({ usdc, weth } = await deploySortedMocks(Mock));

    const PoolManager = await ethers.getContractFactory("PoolManager");
    pm = await PoolManager.deploy(deployer.address);
    await pm.waitForDeployment();

    const Helper = await ethers.getContractFactory("PoolModifyLiquidityTest");
    helper = await Helper.deploy(await pm.getAddress());
    await helper.waitForDeployment();

    poolKey = {
      currency0: await usdc.getAddress(),
      currency1: await weth.getAddress(),
      fee: FEE,
      tickSpacing: TICK_SPACING,
      hooks: ZERO_HOOKS,
    };
    await pm.initialize(poolKey, SQRT_PRICE_X96);

    // Liquidity around the current price, from a liquidity provider.
    const lower = CURRENT_TICK - 6000;
    const upper = CURRENT_TICK + 6000;
    await usdc.mint(lp.address, 1_000_000_000000n);
    await weth.mint(lp.address, ethers.parseEther("100"));
    await usdc.connect(lp).approve(await helper.getAddress(), ethers.MaxUint256);
    await weth.connect(lp).approve(await helper.getAddress(), ethers.MaxUint256);
    await helper.connect(lp).modifyLiquidity(
      poolKey,
      { tickLower: lower, tickUpper: upper, liquidityDelta: 10n ** 15n, salt: ethers.ZeroHash },
      "0x"
    );

    const Desk = await ethers.getContractFactory("BellDesk");
    desk = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress());
    await desk.waitForDeployment();
    await desk.setReferee(referee.address);

    await usdc.mint(buyer.address, 10_000_000000n);
    await weth.mint(seller.address, ethers.parseEther("1"));
  });

  describe("constructor", function () {
    it("rejects a USDC address that does not sort below WETH", async function () {
      const Desk = await ethers.getContractFactory("BellDesk");
      const u = await usdc.getAddress();
      const w = await weth.getAddress();
      await expect(Desk.deploy(proxy.address, w, u, await pm.getAddress())).to.be.revertedWithCustomError(
        Desk,
        "CurrencyNotSorted"
      );
    });
  });

  describe("setReferee", function () {
    it("lets only the deployer set it, and only once", async function () {
      const Desk = await ethers.getContractFactory("BellDesk");
      const fresh = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress());
      await expect(fresh.connect(outsider).setReferee(referee.address)).to.be.revertedWithCustomError(
        fresh,
        "NotDeployer"
      );
      await fresh.setReferee(referee.address);
      await expect(fresh.setReferee(outsider.address)).to.be.revertedWithCustomError(fresh, "RefereeAlreadySet");
    });

    it("rejects the zero address", async function () {
      const Desk = await ethers.getContractFactory("BellDesk");
      const fresh = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress());
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

  describe("swaps through the real Uniswap v4 pool", function () {
    it("swapSell sells the desk's WETH and sends USDC proceeds to the seller", async function () {
      const sellAmount = ethers.parseEther("0.0002");
      await weth.mint(await desk.getAddress(), sellAmount);
      const before = await usdc.balanceOf(seller.address);

      await expect(desk.connect(proxy).swapSell(referee.address, seller.address, sellAmount))
        .to.emit(desk, "Swapped");

      const out = (await usdc.balanceOf(seller.address)) - before;
      // 0.0002 WETH at 1,200 USDC per WETH is 0.24 USDC, less the 0.05% fee and a little price impact.
      expect(out).to.be.greaterThan(230_000n);
      expect(out).to.be.lessThanOrEqual(240_000n);
      expect(await weth.balanceOf(await desk.getAddress())).to.equal(0);
    });

    it("swapBuy sells the desk's USDC and sends WETH proceeds to the buyer", async function () {
      const sellAmount = 10_000000n; // 10 USDC
      await usdc.mint(await desk.getAddress(), sellAmount);
      const before = await weth.balanceOf(buyer.address);

      await expect(desk.connect(proxy).swapBuy(referee.address, buyer.address, sellAmount))
        .to.emit(desk, "Swapped");

      const out = (await weth.balanceOf(buyer.address)) - before;
      // 10 USDC at 1,200 USDC per WETH is about 0.008333 WETH, less fee and impact.
      expect(out).to.be.greaterThan(ethers.parseEther("0.0082"));
      expect(out).to.be.lessThanOrEqual(ethers.parseEther("0.008334"));
      expect(await usdc.balanceOf(await desk.getAddress())).to.equal(0);
    });

    it("reports ok = false and moves nothing if the desk cannot pay the pool", async function () {
      const before = await usdc.balanceOf(seller.address);
      await expect(desk.connect(proxy).swapSell(referee.address, seller.address, ethers.parseEther("0.001")))
        .to.emit(desk, "Swapped")
        .withArgs(seller.address, true, ethers.parseEther("0.001"), 0, false);
      expect(await usdc.balanceOf(seller.address)).to.equal(before);
    });

    it("rejects swap calls from anyone but the callback proxy", async function () {
      await expect(
        desk.connect(outsider).swapSell(referee.address, seller.address, 1n)
      ).to.be.revertedWithCustomError(desk, "NotCallbackProxy");
      await expect(
        desk.connect(outsider).swapBuy(referee.address, buyer.address, 1n)
      ).to.be.revertedWithCustomError(desk, "NotCallbackProxy");
    });

    it("rejects a direct unlockCallback from anyone but the pool manager", async function () {
      await expect(desk.connect(outsider).unlockCallback("0x")).to.be.revertedWithCustomError(
        desk,
        "NotPoolManager"
      );
    });
  });
});
