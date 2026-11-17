const { expect } = require("chai");
const { ethers } = require("hardhat");

// Local stand-ins only, inside test/. The Uniswap v4 PoolManager is real.
// The Reactive system contract is a stand-in (MockSystem), as Memory.md allows for unit tests.
// Nothing here is deployed, demoed or claimed.

const SYSTEM = "0x8888888888888888888888888888888888888888";
const CHAIN_A = 84532n; // Base Sepolia (desk only, no reference pool)
const CHAIN_B = 1301n; // Unichain Sepolia (desk plus reference pool)
const LASNA = 5318007n;
const CRON_CONTRACT = "0x0000000000000000000000000000000000fffFfF";
const CRON_TOPIC = "0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70";

const FEE = 500;
const TICK_SPACING = 10;
const SQRT_PRICE_X96 = BigInt(Math.round(Math.sqrt(1e18 / 1200e6) * 2 ** 96)); // 1,200 USDC per WETH
const CURRENT_TICK = 205410;

const QTY = ethers.parseEther("0.002");
const LIMIT_HIGH = 1300_000000n; // buyer will pay up to 1,300
const LIMIT_LOW = 1100_000000n; // seller will take at least 1,100
const ONE_USDC = 1_000000n;

async function deploySortedMocks(Mock) {
  for (;;) {
    const a = await Mock.deploy("Token A", 6);
    const b = await Mock.deploy("Token B", 18);
    await a.waitForDeployment();
    await b.waitForDeployment();
    if (BigInt(await a.getAddress()) < BigInt(await b.getAddress())) return { usdc: a, weth: b };
  }
}

function toRecord(lg, chainId) {
  const t = lg.topics;
  return {
    chainId: chainId,
    contractAddress: lg.address,
    topic0: t[0] ? BigInt(t[0]) : 0n,
    topic1: t[1] ? BigInt(t[1]) : 0n,
    topic2: t[2] ? BigInt(t[2]) : 0n,
    topic3: t[3] ? BigInt(t[3]) : 0n,
    data: lg.data,
    blockNumber: BigInt(lg.blockNumber),
    opCode: 0n,
    blockHash: 0n,
    txHash: 0n,
    logIndex: BigInt(lg.index),
  };
}

describe("BellReferee", function () {
  let deployer, proxy, buyer, seller, outsider, lp;
  let system, referee, refereeAddr, chains, chainOf;
  let trace = []; // every receipt produced by the current bell

  async function makeChain(chainId) {
    const Mock = await ethers.getContractFactory("MockERC20");
    const { usdc, weth } = await deploySortedMocks(Mock);
    const PoolManager = await ethers.getContractFactory("PoolManager");
    const pm = await PoolManager.deploy(deployer.address);
    await pm.waitForDeployment();
    const Helper = await ethers.getContractFactory("PoolModifyLiquidityTest");
    const helper = await Helper.deploy(await pm.getAddress());
    await helper.waitForDeployment();

    const poolKey = {
      currency0: await usdc.getAddress(),
      currency1: await weth.getAddress(),
      fee: FEE,
      tickSpacing: TICK_SPACING,
      hooks: ethers.ZeroAddress,
    };
    await pm.initialize(poolKey, SQRT_PRICE_X96);
    await usdc.mint(lp.address, 1_000_000_000000n);
    await weth.mint(lp.address, ethers.parseEther("100"));
    await usdc.connect(lp).approve(await helper.getAddress(), ethers.MaxUint256);
    await weth.connect(lp).approve(await helper.getAddress(), ethers.MaxUint256);
    await helper.connect(lp).modifyLiquidity(
      poolKey,
      { tickLower: CURRENT_TICK - 6000, tickUpper: CURRENT_TICK + 6000, liquidityDelta: 10n ** 15n, salt: ethers.ZeroHash },
      "0x"
    );

    const Desk = await ethers.getContractFactory("BellDesk");
    const desk = await Desk.deploy(proxy.address, refereeAddr, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress());
    await desk.waitForDeployment();

    const poolId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint24,int24,address)"],
        [[poolKey.currency0, poolKey.currency1, FEE, TICK_SPACING, ethers.ZeroAddress]]
      )
    );

    const addrs = [await desk.getAddress(), await usdc.getAddress(), await weth.getAddress(), await pm.getAddress()];
    addrs.forEach((a) => chainOf.set(a.toLowerCase(), chainId));

    return {
      chainId,
      desk,
      usdc,
      weth,
      pm,
      poolId,
      cfg: {
        chainId,
        desk: await desk.getAddress(),
        usdc: await usdc.getAddress(),
        weth: await weth.getAddress(),
      },
    };
  }

  beforeEach(async function () {
    [deployer, proxy, buyer, seller, outsider, lp] = await ethers.getSigners();
    chainOf = new Map();

    // Put the system stand-in at the library's hard-coded system address.
    const MockSystem = await ethers.getContractFactory("MockSystem");
    const stand = await MockSystem.deploy();
    await stand.waitForDeployment();
    const code = await ethers.provider.getCode(await stand.getAddress());
    await network.provider.send("hardhat_setCode", [SYSTEM, code]);
    system = await ethers.getContractAt("MockSystem", SYSTEM);

    const Referee = await ethers.getContractFactory("BellReferee");
    referee = await Referee.deploy();
    await referee.waitForDeployment();
    refereeAddr = await referee.getAddress();

    chains = {
      A: await makeChain(CHAIN_A),
      B: await makeChain(CHAIN_B),
    };

    await referee.configure({
      chainA: chains.A.cfg,
      chainB: chains.B.cfg,
      poolManagerB: await chains.B.pm.getAddress(),
      poolIdB: chains.B.poolId,
    });

    // Buyer on A holds USDC. Seller on B holds WETH. Both approve their desk.
    const A = chains.A;
    const B = chains.B;
    await A.usdc.mint(buyer.address, 100_000000n);
    await B.weth.mint(seller.address, ethers.parseEther("1"));
    await A.usdc.connect(buyer).approve(await A.desk.getAddress(), ethers.MaxUint256);
    await B.weth.connect(seller).approve(await B.desk.getAddress(), ethers.MaxUint256);
    // Desk pots for remainder swaps and pool fallbacks.
    await B.usdc.mint(await B.desk.getAddress(), 10_000_000000n);
    await A.usdc.mint(await A.desk.getAddress(), 1_000_000000n);
  });

  // ---------------------------------------------------------------- harness

  async function feed(receipt) {
    for (const lg of receipt.logs) {
      const chainId = chainOf.get(lg.address.toLowerCase());
      if (chainId === undefined) continue;
      const rec = toRecord(lg, chainId);
      const r = await (await system.relay(refereeAddr, rec)).wait();
      trace.push(r);
      await drain(r);
    }
  }

  // Plays the Reactive callback proxy: sends each referee callback to its desk,
  // replacing the first payload argument with the referee's RVM id, then feeds the results back.
  async function drain(receipt) {
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== SYSTEM.toLowerCase()) continue;
      let parsed;
      try {
        parsed = system.interface.parseLog(lg);
      } catch {
        continue;
      }
      if (!parsed || parsed.name !== "CallbackRequested") continue;
      const payload = parsed.args.payload;
      const data = payload.slice(0, 10) + ethers.zeroPadValue(refereeAddr, 32).slice(2) + payload.slice(74);
      const tx = await proxy.sendTransaction({ to: parsed.args.recipient, data, gasLimit: 3_000_000 });
      const r = await tx.wait();
      trace.push(r);
      if (r.status !== 1) throw new Error("desk callback reverted");
      await feed(r);
    }
  }

  async function ring() {
    const cron = {
      chainId: LASNA,
      contractAddress: CRON_CONTRACT,
      topic0: BigInt(CRON_TOPIC),
      topic1: 0n,
      topic2: 0n,
      topic3: 0n,
      data: "0x",
      blockNumber: 0n,
      opCode: 0n,
      blockHash: 0n,
      txHash: 0n,
      logIndex: 0n,
    };
    trace = [];
    const r = await (await system.relay(refereeAddr, cron)).wait();
    trace.push(r);
    await drain(r);
    return r;
  }

  function refereeEvents(receipt, name) {
    const out = [];
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== refereeAddr.toLowerCase()) continue;
      try {
        const p = referee.interface.parseLog(lg);
        if (p && p.name === name) out.push(p);
      } catch {}
    }
    return out;
  }

  function callbacks(receipt) {
    const out = [];
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== SYSTEM.toLowerCase()) continue;
      try {
        const p = system.interface.parseLog(lg);
        if (p && p.name === "CallbackRequested") out.push(p);
      } catch {}
    }
    return out;
  }

  // A small pool swap, so the referee hears a reference price.
  async function observePrice(size = ONE_USDC) {
    const B = chains.B;
    const r = await (await B.desk.connect(proxy).swapBuy(refereeAddr, outsider.address, size)).wait();
    await feed(r);
  }

  async function place(chain, signer, isBuy, limit, qty) {
    const r = await (await chain.desk.connect(signer).place(isBuy, limit, qty)).wait();
    await feed(r);
    return r;
  }

  // ---------------------------------------------------------------- tests

  it("rejects react() from anyone but the system contract", async function () {
    const rec = { chainId: LASNA, contractAddress: CRON_CONTRACT, topic0: BigInt(CRON_TOPIC), topic1: 0n, topic2: 0n, topic3: 0n, data: "0x", blockNumber: 0n, opCode: 0n, blockHash: 0n, txHash: 0n, logIndex: 0n };
    await expect(referee.connect(outsider).react(rec)).to.be.revertedWithCustomError(referee, "NotAuthorized");
  });

  it("settles a full cross-chain round at the pool price", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await place(B, seller, false, LIMIT_LOW, QTY);
    expect(await referee.cronOn()).to.equal(true);

    const buyerWethB0 = await B.weth.balanceOf(buyer.address);
    const sellerUsdcA0 = await A.usdc.balanceOf(seller.address);

    const r = await ring();
    const P = await referee.settlePrice();
    expect(refereeEvents(r, "BellRang").length).to.be.greaterThan(0);

    // Buyer receives the matched WETH on chain B. Seller receives USDC on chain A, the buyer's chain.
    const buyerGain = (await B.weth.balanceOf(buyer.address)) - buyerWethB0;
    const sellerGain = (await A.usdc.balanceOf(seller.address)) - sellerUsdcA0;
    expect(buyerGain).to.be.greaterThanOrEqual(QTY);
    expect(sellerGain).to.be.greaterThanOrEqual((QTY * P) / ethers.parseEther("1"));

    expect((await referee.orders(1)).open).to.equal(false);
    expect((await referee.orders(2)).open).to.equal(false);
    expect(await referee.cronOn()).to.equal(false);
  });

  it("skips the round when the pool price drifts more than 10% from the open price", async function () {
    const A = chains.A;
    const B = chains.B;
    await B.usdc.mint(await B.desk.getAddress(), 5000_000000n);
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await place(B, seller, false, LIMIT_LOW, QTY);

    // Push the reference price up by about 20%.
    await observePrice(4000_000000n);

    const r = await ring();
    expect(callbacks(r).length).to.equal(0);
    const voids = refereeEvents(r, "BellVoid");
    expect(voids.length).to.equal(1);
    expect(voids[0].args.reason).to.contain("drift");
    expect((await referee.orders(1)).open).to.equal(true);
    expect((await referee.orders(2)).open).to.equal(true);
  });

  it("keeps an order outside its protection limit, and fills the other side at the pool", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_LOW, QTY); // buyer will not pay the bell price, so not eligible
    await place(B, seller, false, LIMIT_LOW, QTY);

    const sellerUsdcB0 = await B.usdc.balanceOf(seller.address);
    const r = await ring();

    // Only the seller is pulled. Their WETH is then sold into the chain B pool.
    const deskB = (await B.desk.getAddress()).toLowerCase();
    const targets = callbacks(r).map((c) => c.args.recipient.toLowerCase());
    expect(targets.length).to.be.greaterThan(0);
    expect(targets.every((t) => t === deskB)).to.equal(true);
    expect((await referee.orders(1)).open).to.equal(true);
    expect((await referee.orders(2)).open).to.equal(false);
    expect((await B.usdc.balanceOf(seller.address)) - sellerUsdcB0).to.be.greaterThan(0);
  });

  it("unwinds every collected amount when one pull fails, and drops the failed order", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await B.weth.connect(seller).approve(await B.desk.getAddress(), 0); // seller's pull will fail
    await place(B, seller, false, LIMIT_LOW, QTY);

    const buyerUsdc0 = await A.usdc.balanceOf(buyer.address);
    const r = await ring();

    const dropped = trace.flatMap((t) => refereeEvents(t, "OrderDropped"));
    expect(dropped.some((d) => d.args.reason === "pull failed")).to.equal(true);
    expect(await A.usdc.balanceOf(buyer.address)).to.equal(buyerUsdc0);
    expect((await referee.orders(1)).open).to.equal(true);
    expect((await referee.orders(2)).open).to.equal(false);
  });

  it("refunds an unmatched buyer on chain A, which has no reference pool", async function () {
    const A = chains.A;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY); // no seller at all

    const buyerUsdcA0 = await A.usdc.balanceOf(buyer.address);
    await ring();
    const calls = trace.flatMap((t) => callbacks(t));
    const swapSelectors = [
      ethers.id("swapBuy(address,address,uint256)").slice(0, 10),
      ethers.id("swapSell(address,address,uint256)").slice(0, 10),
    ];
    // No swap is requested on chain A. The pulled USDC comes back to the buyer in full.
    expect(calls.some((c) => swapSelectors.includes(c.args.payload.slice(0, 10)))).to.equal(false);
    expect(await A.usdc.balanceOf(buyer.address)).to.equal(buyerUsdcA0);
    expect((await referee.orders(1)).open).to.equal(false);
  });

  it("swaps an unmatched buyer on chain B at the reference pool (buyer-side fallback)", async function () {
    const B = chains.B;
    await B.usdc.mint(buyer.address, 10_000000n);
    await B.usdc.connect(buyer).approve(await B.desk.getAddress(), ethers.MaxUint256);
    await observePrice();
    await place(B, buyer, true, LIMIT_HIGH, QTY); // no seller on chain B

    const wethB0 = await B.weth.balanceOf(buyer.address);
    await ring();
    expect((await B.weth.balanceOf(buyer.address)) - wethB0).to.be.greaterThan(0);
    expect((await referee.orders(1)).open).to.equal(false);
  });

  it("runs a later round cleanly after an earlier round unwound (no stale pull state)", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await B.weth.connect(seller).approve(await B.desk.getAddress(), 0);
    await place(B, seller, false, LIMIT_LOW, QTY); // pull fails, round unwinds
    await ring();
    expect((await referee.orders(1)).open).to.equal(true);
    expect((await referee.orders(2)).open).to.equal(false);

    // A fresh seller with a real approval, then a second round with the carried buyer.
    await B.weth.connect(seller).approve(await B.desk.getAddress(), ethers.MaxUint256);
    const wethB0 = await B.weth.balanceOf(buyer.address);
    await place(B, seller, false, LIMIT_LOW, QTY);
    await ring();
    expect(trace.flatMap((t) => refereeEvents(t, "Settled")).length).to.be.greaterThan(0);
    expect((await B.weth.balanceOf(buyer.address)) - wethB0).to.be.greaterThanOrEqual(QTY);
    expect((await referee.orders(1)).open).to.equal(false);
  });

  it("expires a round whose pull callback never arrives, and clears it", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await place(B, seller, false, LIMIT_LOW, QTY);

    // Bell without relaying the desk callbacks: the pulls never report.
    const cron = {
      chainId: LASNA, contractAddress: CRON_CONTRACT, topic0: BigInt(CRON_TOPIC), topic1: 0n, topic2: 0n, topic3: 0n,
      data: "0x", blockNumber: 0n, opCode: 0n, blockHash: 0n, txHash: 0n, logIndex: 0n,
    };
    await (await system.relay(refereeAddr, cron)).wait();
    expect(await referee.pulling()).to.equal(true);

    await network.provider.send("evm_increaseTime", [301]);
    await network.provider.send("evm_mine");
    const r = await ring();
    expect(refereeEvents(r, "PullsExpired").length).to.equal(1);
    expect(await referee.pulling()).to.equal(false);
    expect((await referee.orders(1)).open).to.equal(false);
    expect((await referee.orders(2)).open).to.equal(false);
  });

  it("refunds pulls whose desk events were lost, then freezes those orders", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await place(B, seller, false, LIMIT_LOW, QTY);
    const buyerUsdcA0 = await A.usdc.balanceOf(buyer.address);
    const sellerWethB0 = await B.weth.balanceOf(seller.address);

    // Bell: the desks execute the pulls, but their events never reach the referee.
    const cron = {
      chainId: LASNA, contractAddress: CRON_CONTRACT, topic0: BigInt(CRON_TOPIC), topic1: 0n, topic2: 0n, topic3: 0n,
      data: "0x", blockNumber: 0n, opCode: 0n, blockHash: 0n, txHash: 0n, logIndex: 0n,
    };
    const rr = await (await system.relay(refereeAddr, cron)).wait();
    for (const c of callbacks(rr)) {
      const payload = c.args.payload;
      const data = payload.slice(0, 10) + ethers.zeroPadValue(refereeAddr, 32).slice(2) + payload.slice(74);
      await (await proxy.sendTransaction({ to: c.args.recipient, data, gasLimit: 3_000_000 })).wait();
    }
    expect(await A.usdc.balanceOf(buyer.address)).to.be.lessThan(buyerUsdcA0);
    expect(await referee.pulling()).to.equal(true);

    // The round expires. The referee asks each desk to refund what it actually collected.
    await network.provider.send("evm_increaseTime", [301]);
    await network.provider.send("evm_mine");
    await ring();
    expect(await A.usdc.balanceOf(buyer.address)).to.equal(buyerUsdcA0);
    expect(await B.weth.balanceOf(seller.address)).to.equal(sellerWethB0);
    expect(await referee.pulling()).to.equal(false);
    expect((await referee.orders(1)).open).to.equal(false);
    expect((await referee.orders(2)).open).to.equal(false);

    // A late pull for a frozen order cannot take funds again.
    await expect(A.desk.connect(proxy).collect(refereeAddr, 1, buyer.address, true, 2_400000n))
      .to.emit(A.desk, "Collected")
      .withArgs(1, buyer.address, 2_400000n, false);
  });

  it("refunds a trader when a desk swap reports ok = false", async function () {
    const B = chains.B;
    await B.usdc.mint(await B.desk.getAddress(), 2_000000n);
    const usdcBefore = await B.usdc.balanceOf(buyer.address);
    const deskB = await B.desk.getAddress();
    const swappedTopic = ethers.id("Swapped(address,bool,uint256,uint256,bool)");
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bool", "uint256", "uint256", "bool"],
      [false, 1_000000n, 0n, false]
    );
    const fake = {
      address: deskB,
      topics: [swappedTopic, ethers.zeroPadValue(buyer.address, 32)],
      data,
      blockNumber: 1,
      index: 0,
    };
    await feed({ logs: [fake] });
    expect(await B.usdc.balanceOf(buyer.address)).to.equal(usdcBefore + 1_000000n);
  });

  it("settles a 2 buyer by 2 seller round, with pairs crossing chains", async function () {
    const A = chains.A;
    const B = chains.B;
    const [, , , , , , buyer2, seller2] = await ethers.getSigners();
    await A.usdc.mint(buyer2.address, 100_000000n);
    await A.usdc.connect(buyer2).approve(await A.desk.getAddress(), ethers.MaxUint256);
    await B.weth.mint(seller2.address, ethers.parseEther("1"));
    await B.weth.connect(seller2).approve(await B.desk.getAddress(), ethers.MaxUint256);

    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await place(A, buyer2, true, LIMIT_HIGH, QTY);
    await place(B, seller, false, LIMIT_LOW, QTY);
    await place(B, seller2, false, LIMIT_LOW, QTY);

    const buyerWeth = (await B.weth.balanceOf(buyer.address)) + (await B.weth.balanceOf(buyer2.address));
    const r = await ring();
    const P = await referee.settlePrice();
    const buyerWethAfter = (await B.weth.balanceOf(buyer.address)) + (await B.weth.balanceOf(buyer2.address));
    expect(buyerWethAfter - buyerWeth).to.be.greaterThanOrEqual(2n * QTY);
    expect(refereeEvents(r, "BellRang").length).to.be.greaterThan(0);
    for (let id = 1; id <= 4; id++) {
      expect((await referee.orders(id)).open).to.equal(false);
    }
    expect(await referee.cronOn()).to.equal(false);
    expect(P).to.be.greaterThan(0n);
  });

  it("drops an order when its trader moves funds before the bell", async function () {
    const A = chains.A;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);

    const r = await (await A.usdc.connect(buyer).transfer(outsider.address, ONE_USDC)).wait();
    await feed(r);
    expect((await referee.orders(1)).open).to.equal(false);

    const bell = await ring();
    expect(callbacks(bell).length).to.equal(0);
    expect(await referee.cronOn()).to.equal(false);
  });
});
