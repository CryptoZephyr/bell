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
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n; // above this the desk clamps the limit
const FEE_PPM = 500n;

function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / y) / 2n;
  }
  return x;
}

// Same rule as BellReferee._sqrtLimit. A buyer swap pushes the price up, so the limit is a floor on sqrtP.
function sqrtLimit(isBuy, limit) {
  const cap = isBuy ? (limit * (1_000_000n - FEE_PPM)) / 1_000_000n : (limit * 1_000_000n + (1_000_000n - FEE_PPM) - 1n) / (1_000_000n - FEE_PPM);
  const x = (10n ** 18n << 192n) / cap;
  let s = isqrt(x);
  if (isBuy && s * s < x) s += 1n;
  return s;
}

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
    desk = await Desk.deploy(proxy.address, referee.address, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress(), 10);
    await desk.waitForDeployment();

    await usdc.mint(buyer.address, 10_000_000000n);
    await weth.mint(seller.address, ethers.parseEther("1"));
  });

  describe("constructor", function () {
    it("rejects a USDC address that does not sort below WETH", async function () {
      const Desk = await ethers.getContractFactory("BellDesk");
      const u = await usdc.getAddress();
      const w = await weth.getAddress();
      await expect(Desk.deploy(proxy.address, referee.address, w, u, await pm.getAddress(), 10)).to.be.revertedWithCustomError(
        Desk,
        "CurrencyNotSorted"
      );
    });
  });

  describe("place", function () {
    it("records the order and emits OrderPlaced without moving funds", async function () {
      await usdc.connect(buyer).approve(await desk.getAddress(), ethers.MaxUint256);
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
      // Placing needs funds and approval. The tests below then control the approval themselves.
      await usdc.connect(buyer).approve(await desk.getAddress(), ethers.MaxUint256);
      await weth.connect(seller).approve(await desk.getAddress(), ethers.MaxUint256);
      await desk.connect(buyer).place(true, PRICE, QTY);
      await desk.connect(seller).place(false, PRICE, QTY);
      await usdc.connect(buyer).approve(await desk.getAddress(), 0);
      await weth.connect(seller).approve(await desk.getAddress(), 0);
    });

    it("rejects callers other than the callback proxy", async function () {
      await expect(
        desk.connect(outsider).collect(referee.address, 1, buyer.address, true, 1n)
      ).to.be.revertedWithCustomError(desk, "NotAuthorized");
    });

    it("rejects a callback whose RVM id is not the referee", async function () {
      await expect(
        desk.connect(proxy).collect(outsider.address, 1, buyer.address, true, 1n)
      ).to.be.revertedWithCustomError(desk, "CallbackNotAuthorized");
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
      ).to.be.revertedWithCustomError(desk, "NotAuthorized");
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

      await expect(desk.connect(proxy).swapSell(referee.address, seller.address, sellAmount, MAX_SQRT))
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

      await expect(desk.connect(proxy).swapBuy(referee.address, buyer.address, sellAmount, 0))
        .to.emit(desk, "Swapped");

      const out = (await weth.balanceOf(buyer.address)) - before;
      // 10 USDC at 1,200 USDC per WETH is about 0.008333 WETH, less fee and impact.
      expect(out).to.be.greaterThan(ethers.parseEther("0.0082"));
      expect(out).to.be.lessThanOrEqual(ethers.parseEther("0.008334"));
      expect(await usdc.balanceOf(await desk.getAddress())).to.equal(0);
    });

    it("reports ok = false and moves nothing if the desk cannot pay the pool", async function () {
      const before = await usdc.balanceOf(seller.address);
      await expect(desk.connect(proxy).swapSell(referee.address, seller.address, ethers.parseEther("0.001"), MAX_SQRT))
        .to.emit(desk, "Swapped")
        .withArgs(seller.address, true, ethers.parseEther("0.001"), 0, 0, 0, false);
      expect(await usdc.balanceOf(seller.address)).to.equal(before);
    });

    it("rejects swap calls from anyone but the callback proxy", async function () {
      await expect(
        desk.connect(outsider).swapSell(referee.address, seller.address, 1n, 0)
      ).to.be.revertedWithCustomError(desk, "NotAuthorized");
      await expect(
        desk.connect(outsider).swapBuy(referee.address, buyer.address, 1n, 0)
      ).to.be.revertedWithCustomError(desk, "NotAuthorized");
    });

    it("rejects a direct unlockCallback from anyone but the pool manager", async function () {
      await expect(desk.connect(outsider).unlockCallback("0x")).to.be.revertedWithCustomError(
        desk,
        "NotPoolManager"
      );
    });
  });

  describe("per-order accounting", function () {
    beforeEach(async function () {
      await usdc.connect(buyer).approve(await desk.getAddress(), ethers.MaxUint256);
      await desk.connect(buyer).place(true, PRICE, QTY);
    });

    it("refunds what was collected and not yet closed, exactly once", async function () {
      const cost = 2_400000n;
      const before = await usdc.balanceOf(buyer.address);
      await desk.connect(proxy).collect(referee.address, 1, buyer.address, true, cost);
      expect(await desk.collectedOf(1)).to.equal(cost);
      await expect(desk.connect(proxy).refundOrder(referee.address, 1, false))
        .to.emit(desk, "Refunded")
        .withArgs(1, buyer.address, cost, true);
      expect(await usdc.balanceOf(buyer.address)).to.equal(before);
      await expect(desk.connect(proxy).refundOrder(referee.address, 1, false)).to.not.emit(desk, "Refunded");
    });

    it("closeOrder stops a later refund from paying funds that were already settled", async function () {
      await desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 2_400000n);
      await desk.connect(proxy).closeOrder(referee.address, 1);
      await expect(desk.connect(proxy).refundOrder(referee.address, 1, false)).to.not.emit(desk, "Refunded");
    });

    it("freeze blocks a late pull, so funds cannot be stranded after a refund", async function () {
      await desk.connect(proxy).refundOrder(referee.address, 1, true);
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 2_400000n))
        .to.emit(desk, "Collected")
        .withArgs(1, buyer.address, 2_400000n, false);
      expect(await desk.collectedOf(1)).to.equal(0);
    });

    it("only the callback proxy can call the accounting functions", async function () {
      await expect(desk.connect(outsider).refundOrder(referee.address, 1, false)).to.be.revertedWithCustomError(desk, "NotAuthorized");
      await expect(desk.connect(outsider).closeOrder(referee.address, 1)).to.be.revertedWithCustomError(desk, "NotAuthorized");
    });
  });
  describe("limit-capped fallback swaps", function () {
    const ONE = 10n ** 18n;

    it("a buyer remainder stops at the cap, returns the unused USDC, and stays inside the limit", async function () {
      const limit = 1_201_000000n; // pool is at 1,200, so the buyer cap leaves room for a small move only
      const amountIn = 10_000000n;
      await usdc.mint(await desk.getAddress(), amountIn);
      const wethBefore = await weth.balanceOf(buyer.address);
      const usdcBefore = await usdc.balanceOf(buyer.address);

      const tx = await desk.connect(proxy).swapBuy(referee.address, buyer.address, amountIn, sqrtLimit(true, limit));
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return desk.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Swapped");

      expect(ev.args.ok).to.equal(true);
      expect(ev.args.amountUsed).to.be.greaterThan(0n);
      expect(ev.args.amountUsed).to.be.lessThan(amountIn);
      expect(ev.args.amountUsed + ev.args.refunded).to.equal(amountIn);
      const out = (await weth.balanceOf(buyer.address)) - wethBefore;
      expect(out).to.equal(ev.args.amountOut);
      expect((await usdc.balanceOf(buyer.address)) - usdcBefore).to.equal(ev.args.refunded);
      // All-in price paid is at or under the buyer's limit.
      expect((ev.args.amountUsed * ONE) / out).to.be.lessThanOrEqual(limit);
      expect(await usdc.balanceOf(await desk.getAddress())).to.equal(0);
    });

    it("a buyer remainder reports ok = false when the pool price is already above the cap", async function () {
      const limit = 1_200_300000n; // cap 1,199.7 sits below the pool price of 1,200
      const amountIn = 10_000000n;
      await usdc.mint(await desk.getAddress(), amountIn);
      await expect(desk.connect(proxy).swapBuy(referee.address, buyer.address, amountIn, sqrtLimit(true, limit)))
        .to.emit(desk, "Swapped")
        .withArgs(buyer.address, false, amountIn, 0, 0, 0, false);
      expect(await usdc.balanceOf(await desk.getAddress())).to.equal(amountIn); // nothing moved
      expect(await weth.balanceOf(buyer.address)).to.equal(0);
    });

    it("a seller remainder stops at the cap, returns the unused WETH, and stays inside the limit", async function () {
      const limit = 1_199_000000n;
      const amountIn = ethers.parseEther("0.01");
      await weth.mint(await desk.getAddress(), amountIn);
      const usdcBefore = await usdc.balanceOf(seller.address);
      const wethBefore = await weth.balanceOf(seller.address);

      const tx = await desk.connect(proxy).swapSell(referee.address, seller.address, amountIn, sqrtLimit(false, limit));
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return desk.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Swapped");

      expect(ev.args.ok).to.equal(true);
      expect(ev.args.amountUsed).to.be.greaterThan(0n);
      expect(ev.args.amountUsed).to.be.lessThan(amountIn);
      expect(ev.args.amountUsed + ev.args.refunded).to.equal(amountIn);
      const out = (await usdc.balanceOf(seller.address)) - usdcBefore;
      expect(out).to.equal(ev.args.amountOut);
      expect((await weth.balanceOf(seller.address)) - wethBefore).to.equal(ev.args.refunded);
      // All-in price received is at or over the seller's limit.
      expect((out * ONE) / ev.args.amountUsed).to.be.greaterThanOrEqual(limit);
      expect(await weth.balanceOf(await desk.getAddress())).to.equal(0);
    });

    it("a seller remainder reports ok = false when the pool price is already under the cap", async function () {
      const limit = 1_250_000000n; // cap 1,250.6 sits above the pool price of 1,200
      const amountIn = ethers.parseEther("0.01");
      await weth.mint(await desk.getAddress(), amountIn);
      await expect(desk.connect(proxy).swapSell(referee.address, seller.address, amountIn, sqrtLimit(false, limit)))
        .to.emit(desk, "Swapped")
        .withArgs(seller.address, true, amountIn, 0, 0, 0, false);
      expect(await weth.balanceOf(await desk.getAddress())).to.equal(amountIn);
    });

    it("fills the whole amount when the limit is far from the pool price", async function () {
      const amountIn = ethers.parseEther("0.0002");
      await weth.mint(await desk.getAddress(), amountIn);
      await expect(desk.connect(proxy).swapSell(referee.address, seller.address, amountIn, sqrtLimit(false, 100_000000n)))
        .to.emit(desk, "Swapped");
      expect(await weth.balanceOf(seller.address)).to.equal(ethers.parseEther("1")); // nothing refunded
    });
  });

  describe("cancel", function () {
    beforeEach(async function () {
      await usdc.connect(buyer).approve(await desk.getAddress(), ethers.MaxUint256);
      await desk.connect(buyer).place(true, PRICE, QTY);
    });

    it("lets the trader cancel, and emits OrderCancelled", async function () {
      await expect(desk.connect(buyer).cancel(1)).to.emit(desk, "OrderCancelled").withArgs(1, buyer.address);
      expect(await desk.frozen(1)).to.equal(true);
    });

    it("rejects a cancel from anyone but the order's trader", async function () {
      await expect(desk.connect(outsider).cancel(1)).to.be.revertedWithCustomError(desk, "NotOrderTrader");
      await expect(desk.connect(outsider).cancel(99)).to.be.revertedWithCustomError(desk, "NotOrderTrader");
    });

    it("rejects a second cancel, and a cancel after the order was frozen", async function () {
      await desk.connect(buyer).cancel(1);
      await expect(desk.connect(buyer).cancel(1)).to.be.revertedWithCustomError(desk, "AlreadyFrozen");
    });

    it("a cancel that lands before the pull wins, so the pull reports ok = false and takes nothing", async function () {
      await desk.connect(buyer).cancel(1);
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 2_400000n))
        .to.emit(desk, "Collected")
        .withArgs(1, buyer.address, 2_400000n, false);
      expect(await desk.collectedOf(1)).to.equal(0);
    });

    it("a cancel after the pull is too late. The funds stay collected", async function () {
      await desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 2_400000n);
      await desk.connect(buyer).cancel(1); // allowed, but the funds are already in the desk
      expect(await desk.collectedOf(1)).to.equal(2_400000n);
    });

    it("a settled order is frozen, so it can never be pulled or cancelled again", async function () {
      await desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 2_400000n);
      await desk.connect(proxy).closeOrder(referee.address, 1);
      expect(await desk.frozen(1)).to.equal(true);
      await expect(desk.connect(buyer).cancel(1)).to.be.revertedWithCustomError(desk, "AlreadyFrozen");
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 1_000000n))
        .to.emit(desk, "Collected")
        .withArgs(1, buyer.address, 1_000000n, false);
    });
  });
  describe("placement checks (spam is rejected before it costs a reaction)", function () {
    it("rejects an order the trader cannot pay for, and emits nothing", async function () {
      // No approval yet.
      await expect(desk.connect(buyer).place(true, PRICE, QTY)).to.be.revertedWithCustomError(desk, "NotFunded");
      await expect(desk.connect(seller).place(false, PRICE, QTY)).to.be.revertedWithCustomError(desk, "NotFunded");
      // Approved, but no balance.
      await usdc.connect(outsider).approve(await desk.getAddress(), ethers.MaxUint256);
      await expect(desk.connect(outsider).place(true, PRICE, QTY)).to.be.revertedWithCustomError(desk, "NotFunded");
      expect(await desk.nextOrderId()).to.equal(1n);
    });

    it("needs approval and balance for the cost at the order's own limit price", async function () {
      const cost = (QTY * PRICE + ethers.parseEther("1") - 1n) / ethers.parseEther("1");
      await usdc.connect(buyer).approve(await desk.getAddress(), cost - 1n);
      await expect(desk.connect(buyer).place(true, PRICE, QTY)).to.be.revertedWithCustomError(desk, "NotFunded");
      await usdc.connect(buyer).approve(await desk.getAddress(), cost);
      await expect(desk.connect(buyer).place(true, PRICE, QTY)).to.emit(desk, "OrderPlaced");
      // A seller needs the WETH itself.
      await weth.connect(seller).approve(await desk.getAddress(), QTY);
      await expect(desk.connect(seller).place(false, PRICE, QTY)).to.emit(desk, "OrderPlaced");
    });

    it("rejects dust orders and values too large for the referee", async function () {
      await usdc.connect(buyer).approve(await desk.getAddress(), ethers.MaxUint256);
      await expect(desk.connect(buyer).place(true, PRICE, (await desk.MIN_QTY()) - 1n)).to.be.revertedWithCustomError(desk, "OrderTooSmall");
      await expect(desk.connect(buyer).place(true, PRICE, await desk.MIN_QTY())).to.emit(desk, "OrderPlaced");
      await expect(desk.connect(buyer).place(true, 2n ** 128n, QTY)).to.be.revertedWithCustomError(desk, "OrderTooLarge");
      await expect(desk.connect(buyer).place(true, PRICE, 2n ** 128n)).to.be.revertedWithCustomError(desk, "OrderTooLarge");
    });
  });
  describe("pull limit (the desk never pulls more than the order committed to)", function () {
    let cost;
    beforeEach(async function () {
      cost = (QTY * PRICE + ethers.parseEther("1") - 1n) / ethers.parseEther("1");
      await usdc.connect(buyer).approve(await desk.getAddress(), ethers.MaxUint256);
      await weth.connect(seller).approve(await desk.getAddress(), ethers.MaxUint256);
      await desk.connect(buyer).place(true, PRICE, QTY);
      await desk.connect(seller).place(false, PRICE, QTY);
    });

    it("rejects a buyer pull above the cost at the order's own limit, even with a huge approval", async function () {
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, cost + 1n)).to.be.revertedWithCustomError(desk, "PullExceedsOrder");
      expect(await desk.collectedOf(1)).to.equal(0n);
      expect(await usdc.balanceOf(await desk.getAddress())).to.equal(0n);
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, cost)).to.emit(desk, "Collected").withArgs(1, buyer.address, cost, true);
    });

    it("rejects a seller pull above the order quantity", async function () {
      await expect(desk.connect(proxy).collect(referee.address, 2, seller.address, false, QTY + 1n)).to.be.revertedWithCustomError(desk, "PullExceedsOrder");
      await expect(desk.connect(proxy).collect(referee.address, 2, seller.address, false, QTY)).to.emit(desk, "Collected");
    });

    it("counts repeated pulls together, so asking twice cannot exceed the order", async function () {
      await desk.connect(proxy).collect(referee.address, 1, buyer.address, true, cost - 1000n);
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 1001n)).to.be.revertedWithCustomError(desk, "PullExceedsOrder");
      await expect(desk.connect(proxy).collect(referee.address, 1, buyer.address, true, 1000n)).to.emit(desk, "Collected");
      expect(await desk.collectedOf(1)).to.equal(cost);
    });
  });
});
