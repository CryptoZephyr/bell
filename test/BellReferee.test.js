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
    const desk = await Desk.deploy(proxy.address, refereeAddr, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress(), TICK_SPACING);
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
      noteGas(r);
      await drain(r);
    }
  }

  // Gas of the referee's reactions that matter for capacity.
  let gasLog = [];
  function noteGas(r) {
    const tags = [];
    if (refereeEvents(r, "BellRang").length) tags.push("bell");
    if (refereeEvents(r, "Settled").length) tags.push("settle");
    if (tags.length) gasLog.push({ tags, gas: r.gasUsed, callbacks: callbacks(r).length });
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
    noteGas(r);
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
    const r = await (await B.desk.connect(proxy).swapBuy(refereeAddr, outsider.address, size, 0)).wait();
    await feed(r);
  }

  async function place(chain, signer, isBuy, limit, qty) {
    const r = await (await chain.desk.connect(signer).place(isBuy, limit, qty)).wait();
    await feed(r);
    return r;
  }

  // ---------------------------------------------------------------- tests

  it("lets only the deployer withdraw REACT from the referee, and only to a real address", async function () {
    const Referee = await ethers.getContractFactory("BellReferee");
    const fresh = await Referee.deploy({ value: ethers.parseEther("0.5") });
    await fresh.waitForDeployment();
    const freshAddr = await fresh.getAddress();

    await expect(fresh.connect(outsider).withdraw(outsider.address, 1n)).to.be.revertedWithCustomError(fresh, "NotDeployer");
    await expect(fresh.withdraw(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(fresh, "ZeroAddress");

    const before = await ethers.provider.getBalance(outsider.address);
    await expect(fresh.withdraw(outsider.address, ethers.parseEther("0.2")))
      .to.emit(fresh, "Withdrawn")
      .withArgs(outsider.address, ethers.parseEther("0.2"));
    expect(await ethers.provider.getBalance(outsider.address)).to.equal(before + ethers.parseEther("0.2"));
    expect(await ethers.provider.getBalance(freshAddr)).to.equal(ethers.parseEther("0.3"));
  });

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

  it("drops only the failed order when one pull fails, and settles the other in the same round", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await B.weth.connect(seller).approve(await B.desk.getAddress(), 0); // seller's pull will fail
    await place(B, seller, false, LIMIT_LOW, QTY);

    const sellerWethB0 = await B.weth.balanceOf(seller.address);
    const buyerUsdc0 = await A.usdc.balanceOf(buyer.address);
    const buyerWethA0 = await A.weth.balanceOf(buyer.address);
    await ring();

    const dropped = trace.flatMap((t) => refereeEvents(t, "OrderDropped"));
    expect(dropped.some((d) => d.args.reason === "pull failed")).to.equal(true);
    expect(trace.flatMap((t) => refereeEvents(t, "Settled")).length).to.equal(1);
    // The buyer was pulled, found no seller, and bought from the chain A pool in the same round.
    expect(await A.usdc.balanceOf(buyer.address)).to.be.lessThan(buyerUsdc0);
    expect((await A.weth.balanceOf(buyer.address)) - buyerWethA0).to.be.greaterThan(0n);
    expect(await B.weth.balanceOf(seller.address)).to.equal(sellerWethB0); // never pulled
    expect((await referee.orders(1)).open).to.equal(false);
    expect((await referee.orders(2)).open).to.equal(false);
    expect(await referee.pulling()).to.equal(false);
  });

  it("swaps an unmatched buyer on chain A at that chain's pool (buyer-side fallback on every chain)", async function () {
    const A = chains.A;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY); // no seller at all

    const wethA0 = await A.weth.balanceOf(buyer.address);
    await ring();
    expect((await A.weth.balanceOf(buyer.address)) - wethA0).to.be.greaterThan(0);
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

  it("runs a later round cleanly after an earlier round dropped a failed pull (no stale pull state)", async function () {
    const A = chains.A;
    const B = chains.B;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await B.weth.connect(seller).approve(await B.desk.getAddress(), 0);
    await place(B, seller, false, LIMIT_LOW, QTY); // seller's pull fails, the buyer still settles
    await ring();
    expect((await referee.orders(1)).open).to.equal(false);
    expect((await referee.orders(2)).open).to.equal(false);

    // A second round with a fresh pair.
    await B.weth.connect(seller).approve(await B.desk.getAddress(), ethers.MaxUint256);
    const wethB0 = await B.weth.balanceOf(buyer.address);
    await place(A, buyer, true, LIMIT_HIGH, QTY);
    await place(B, seller, false, LIMIT_LOW, QTY);
    await ring();
    expect(trace.flatMap((t) => refereeEvents(t, "Settled")).length).to.be.greaterThan(0);
    expect((await B.weth.balanceOf(buyer.address)) - wethB0).to.be.greaterThanOrEqual(QTY);
    expect((await referee.orders(3)).open).to.equal(false);
    expect((await referee.orders(4)).open).to.equal(false);
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
    const swappedTopic = ethers.id("Swapped(address,bool,uint256,uint256,uint256,uint256,bool)");
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bool", "uint256", "uint256", "uint256", "uint256", "bool"],
      [false, 1_000000n, 0n, 0n, 0n, false]
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
  // ---------------------------------------------------------------- v5

  const CRON = {
    chainId: LASNA, contractAddress: CRON_CONTRACT, topic0: BigInt(CRON_TOPIC), topic1: 0n, topic2: 0n, topic3: 0n,
    data: "0x", blockNumber: 0n, opCode: 0n, blockHash: 0n, txHash: 0n, logIndex: 0n,
  };

  // Rings the bell but does not relay the desk callbacks. Returns the callbacks, so a test can run some of them.
  async function ringHeld() {
    trace = [];
    const r = await (await system.relay(refereeAddr, CRON)).wait();
    trace.push(r);
    noteGas(r);
    return callbacks(r);
  }

  async function runCallback(c) {
    const payload = c.args.payload;
    const data = payload.slice(0, 10) + ethers.zeroPadValue(refereeAddr, 32).slice(2) + payload.slice(74);
    const r = await (await proxy.sendTransaction({ to: c.args.recipient, data, gasLimit: 3_000_000 })).wait();
    trace.push(r);
    await feed(r);
    return r;
  }

  function priceNow() {
    return referee.lastSqrtPriceX96().then((s) => (10n ** 18n << 192n) / (s * s));
  }

  async function extraSigners() {
    const sg = await ethers.getSigners();
    return { buyer2: sg[6], seller2: sg[7] };
  }

  describe("limit-capped fallback", function () {
    it("a buyer remainder partly fills at the pool, and the unused USDC comes back in the same desk call", async function () {
      const A = chains.A;
      await A.usdc.mint(buyer.address, 10_000_000000n);
      await observePrice();
      const p = await priceNow();
      const limit = (p * 10007n) / 10000n; // 7 bps of room: the 5 bps fee plus a little price move
      const qty = ethers.parseEther("5");
      await place(A, buyer, true, limit, qty);

      const usdc0 = await A.usdc.balanceOf(buyer.address);
      const weth0 = await A.weth.balanceOf(buyer.address);
      await ring();
      const swaps = trace.flatMap((t) => t.logs.map((l) => { try { return A.desk.interface.parseLog(l); } catch { return null; } })).filter((e) => e && e.name === "Swapped");
      expect(swaps.length).to.equal(1);
      const ev = swaps[0];
      expect(ev.args.ok).to.equal(true);
      expect(ev.args.amountUsed).to.be.greaterThan(0n);
      expect(ev.args.refunded).to.be.greaterThan(0n);
      expect(ev.args.amountUsed + ev.args.refunded).to.equal(ev.args.amountIn);
      const spent = usdc0 - (await A.usdc.balanceOf(buyer.address));
      const got = (await A.weth.balanceOf(buyer.address)) - weth0;
      // The buyer paid the cost at the settle price, and got back exactly the unused part.
      expect(spent).to.equal(ev.args.amountUsed);
      expect(ev.args.amountIn).to.equal(await refereePulledAt(await referee.settlePrice(), qty));
      expect((ev.args.amountUsed * 10n ** 18n) / got).to.be.lessThanOrEqual(limit);
      expect((await referee.orders(1)).open).to.equal(false);
    });

    it("a buyer remainder whose cap is under the pool price is refunded in full (ok = false path)", async function () {
      const A = chains.A;
      await observePrice();
      const p = await priceNow();
      // Eligible (limit >= p), but the fee-adjusted cap sits below the pool price.
      const limit = p + p / 20000n; // 0.5 bp over
      await place(A, buyer, true, limit, QTY);
      const usdc0 = await A.usdc.balanceOf(buyer.address);
      await ring();
      const swapped = trace.flatMap((t) => t.logs.map((l) => { try { return A.desk.interface.parseLog(l); } catch { return null; } })).filter((e) => e && e.name === "Swapped");
      expect(swapped.length).to.equal(1);
      expect(swapped[0].args.ok).to.equal(false);
      expect(await A.usdc.balanceOf(buyer.address)).to.equal(usdc0); // everything came back
      expect((await referee.orders(1)).open).to.equal(false);
    });

    it("a seller remainder partly fills at the pool, and the unused WETH comes back", async function () {
      const B = chains.B;
      await observePrice();
      const p = await priceNow();
      const limit = (p * 9993n) / 10000n;
      await B.weth.mint(seller.address, ethers.parseEther("10"));
      await place(B, seller, false, limit, ethers.parseEther("5"));

      const usdc0 = await B.usdc.balanceOf(seller.address);
      const weth0 = await B.weth.balanceOf(seller.address);
      await ring();
      const swaps = trace.flatMap((t) => t.logs.map((l) => { try { return B.desk.interface.parseLog(l); } catch { return null; } })).filter((e) => e && e.name === "Swapped");
      expect(swaps.length).to.equal(1);
      const ev = swaps[0];
      expect(ev.args.ok).to.equal(true);
      expect(ev.args.refunded).to.be.greaterThan(0n);
      expect(ev.args.amountUsed + ev.args.refunded).to.equal(ethers.parseEther("5"));
      const got = (await B.usdc.balanceOf(seller.address)) - usdc0;
      expect((got * 10n ** 18n) / ev.args.amountUsed).to.be.greaterThanOrEqual(limit);
      expect(weth0 - (await B.weth.balanceOf(seller.address))).to.equal(ev.args.amountUsed);
    });

    it("a seller remainder whose cap is over the pool price is refunded in full", async function () {
      const B = chains.B;
      await observePrice();
      const p = await priceNow();
      const limit = p - p / 20000n; // eligible (limit <= p), cap above the pool price after the fee adjustment
      await place(B, seller, false, limit, QTY);
      const weth0 = await B.weth.balanceOf(seller.address);
      await ring();
      const swapped = trace.flatMap((t) => t.logs.map((l) => { try { return B.desk.interface.parseLog(l); } catch { return null; } })).filter((e) => e && e.name === "Swapped");
      expect(swapped[0].args.ok).to.equal(false);
      expect(await B.weth.balanceOf(seller.address)).to.equal(weth0);
    });

    async function refereePulledAt(p, qty) {
      return (qty * p + 10n ** 18n - 1n) / 10n ** 18n;
    }
  });

  describe("_sqrtLimit math", function () {
    let h;
    beforeEach(async function () {
      const H = await ethers.getContractFactory("RefereeHarness");
      h = await H.deploy();
      await h.waitForDeployment();
    });

    function isqrt(n) {
      if (n < 2n) return n;
      let x = n;
      let y = (x + 1n) / 2n;
      while (y < x) { x = y; y = (x + n / y) / 2n; }
      return x;
    }

    it("matches the live Unichain sqrt price at the live price (593,191,736)", async function () {
      const live = 3252984827254301519434012148547105n;
      const p = 593_191_736n;
      // Without the fee tightening the bound is the pool's own price. Check it through priceOf and the sqrt helper.
      const s = await h.isqrt((10n ** 18n << 192n) / p);
      const ratio = (Number(s) / Number(live));
      expect(Math.abs(ratio - 1)).to.be.lessThan(0.0001);
      expect(await h.priceOf(live)).to.be.closeTo(p, p / 10000n);
    });

    it("isqrt returns the floor square root", async function () {
      for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 30n, 10n ** 30n + 1n, (1n << 255n) + 12345n, (1n << 256n) - 1n]) {
        expect(await h.isqrt(n)).to.equal(isqrt(n));
      }
    });

    it("applies the fee in the safe direction for each side and rounds the safe way", async function () {
      for (const limit of [593_191_736n, 805_000000n, 1_200_000000n, 1_234_567_891n]) {
        const buy = await h.sqrtLimit(true, limit);
        const sell = await h.sqrtLimit(false, limit);
        const sAtLimit = isqrt((10n ** 18n << 192n) / limit);
        // The buyer floor is above the sqrt at the limit (price cap below the limit), the seller ceiling is below it.
        expect(buy).to.be.greaterThan(sAtLimit);
        expect(sell).to.be.lessThan(sAtLimit);
        // Check the exact formula, including buyer round up and seller round down.
        const capB = (limit * 999500n) / 1_000_000n;
        const xB = (10n ** 18n << 192n) / capB;
        let eb = isqrt(xB);
        if (eb * eb < xB) eb += 1n;
        expect(buy).to.equal(eb);
        const capS = (limit * 1_000_000n + 999500n - 1n) / 999500n;
        expect(sell).to.equal(isqrt((10n ** 18n << 192n) / capS));
        // Price reached at each bound is inside the trader's limit once the fee is added back.
        const pBuy = (10n ** 18n << 192n) / (buy * buy);
        const pSell = (10n ** 18n << 192n) / (sell * sell);
        expect((pBuy * 1_000_000n) / 999500n).to.be.lessThanOrEqual(limit);
        expect((pSell * 999500n) / 1_000_000n).to.be.greaterThanOrEqual(limit);
      }
    });
  });

  describe("guard anchor follows each bell window", function () {
    it("a lasting 20% move voids one bell, then the next bell clears at the new price", async function () {
      const A = chains.A;
      const B = chains.B;
      await B.usdc.mint(await B.desk.getAddress(), 5000_000000n);
      await observePrice();
      await place(A, buyer, true, 2000_000000n, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);
      const p0 = await priceNow();

      await observePrice(4000_000000n); // lasting move
      const p1 = await priceNow();
      expect(p1 * 100n).to.be.greaterThan(p0 * 110n);

      const r1 = await ring();
      expect(refereeEvents(r1, "BellVoid")[0].args.reason).to.contain("drift");
      expect(refereeEvents(r1, "RoundOpened")[0].args.price).to.equal(p1);
      expect(callbacks(r1).length).to.equal(0);
      expect((await referee.orders(1)).open).to.equal(true);

      const r2 = await ring();
      expect(refereeEvents(r2, "BellVoid").length).to.equal(0);
      expect(await referee.settlePrice()).to.equal(p1);
      expect((await referee.orders(1)).open).to.equal(false);
      expect((await referee.orders(2)).open).to.equal(false);
    });

    it("an order placed before any pool swap was heard is anchored by the first swap", async function () {
      const A = chains.A;
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      expect(await referee.openPrice()).to.equal(0n);

      const r1 = await ring();
      expect(refereeEvents(r1, "BellVoid")[0].args.reason).to.contain("no pool price");

      await observePrice();
      expect(await referee.openPrice()).to.equal(await priceNow());

      const r2 = await ring();
      expect(refereeEvents(r2, "BellVoid").length).to.equal(0);
      expect((await referee.orders(1)).open).to.equal(false);
    });

    it("a move under 10% inside one window still clears", async function () {
      const A = chains.A;
      const B = chains.B;
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);
      await observePrice(400_000000n); // a few percent
      const r = await ring();
      expect(refereeEvents(r, "BellVoid").length).to.equal(0);
      expect((await referee.orders(1)).open).to.equal(false);
    });

    it("re-anchors to the latest price when a round settles and other orders carry on", async function () {
      const A = chains.A;
      const B = chains.B;
      const { buyer2 } = await extraSigners();
      await A.usdc.mint(buyer2.address, 100_000000n);
      await A.usdc.connect(buyer2).approve(await A.desk.getAddress(), ethers.MaxUint256);
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);
      await place(A, buyer2, true, LIMIT_LOW, QTY); // under the pool price, so it carries over
      const opened = await referee.openPrice();

      await observePrice(400_000000n); // a few percent, inside the guard
      const latest = await priceNow();
      expect(latest).to.not.equal(opened);

      const r = await ring();
      expect(trace.flatMap((t) => refereeEvents(t, "Settled")).length).to.equal(1);
      expect((await referee.orders(3)).open).to.equal(true);
      expect(await referee.openPrice()).to.equal(latest);
      const reopened = trace.flatMap((t) => refereeEvents(t, "RoundOpened"));
      expect(reopened[reopened.length - 1].args.price).to.equal(latest);
      expect(r).to.not.equal(undefined);
    });
  });

  describe("failed pulls drop alone", function () {
    it("two buyers and one seller, one buyer's pull fails: the other buyer and the seller settle", async function () {
      const A = chains.A;
      const B = chains.B;
      const { buyer2 } = await extraSigners();
      await A.usdc.mint(buyer2.address, 100_000000n); // buyer2 never approves the desk
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(A, buyer2, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);

      const buyerWeth0 = await B.weth.balanceOf(buyer.address);
      const sellerUsdc0 = await A.usdc.balanceOf(seller.address);
      const b2Usdc0 = await A.usdc.balanceOf(buyer2.address);
      await ring();
      const P = await referee.settlePrice();

      expect((await B.weth.balanceOf(buyer.address)) - buyerWeth0).to.be.greaterThanOrEqual(QTY);
      expect((await A.usdc.balanceOf(seller.address)) - sellerUsdc0).to.be.greaterThanOrEqual((QTY * P) / 10n ** 18n);
      expect(await A.usdc.balanceOf(buyer2.address)).to.equal(b2Usdc0);
      const reasons = trace.flatMap((t) => refereeEvents(t, "OrderDropped")).map((d) => d.args.reason);
      expect(reasons.filter((x) => x === "pull failed").length).to.equal(1);
      expect(trace.flatMap((t) => refereeEvents(t, "Unwound")).length).to.equal(1);
      for (const id of [1, 2, 3]) expect((await referee.orders(id)).open).to.equal(false);
      expect(await referee.pulling()).to.equal(false);
    });

    it("a lost delivery: survivors settle on the expiry bell, and the missing order is frozen and refunded", async function () {
      const A = chains.A;
      const B = chains.B;
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);

      const cbs = await ringHeld();
      expect(cbs.length).to.equal(2);
      const sellerWeth0 = await B.weth.balanceOf(seller.address);
      // The buyer's pull reports. The seller's pull runs on the desk, but its event never reaches the referee.
      await runCallback(cbs[0]);
      const payload = cbs[1].args.payload;
      const data = payload.slice(0, 10) + ethers.zeroPadValue(refereeAddr, 32).slice(2) + payload.slice(74);
      await (await proxy.sendTransaction({ to: cbs[1].args.recipient, data, gasLimit: 3_000_000 })).wait();
      expect(await B.weth.balanceOf(seller.address)).to.be.lessThan(sellerWeth0);
      expect(await referee.pulling()).to.equal(true);

      await network.provider.send("evm_increaseTime", [301]);
      await network.provider.send("evm_mine");
      const buyerWeth0 = await A.weth.balanceOf(buyer.address);
      await ring();
      expect(trace.flatMap((t) => refereeEvents(t, "PullsExpired")).length).to.equal(1);
      expect(trace.flatMap((t) => refereeEvents(t, "Settled")).length).to.equal(1);
      expect(await B.weth.balanceOf(seller.address)).to.equal(sellerWeth0); // refunded by the desk's record
      expect((await A.weth.balanceOf(buyer.address)) - buyerWeth0).to.be.greaterThan(0n); // survivor bought from the pool
      expect(await B.desk.frozen(1)).to.equal(true);
      expect(await referee.pulling()).to.equal(false);
    });

    it("all pulls fail: nothing is paid and nothing stays collected", async function () {
      const A = chains.A;
      const B = chains.B;
      await observePrice();
      await A.usdc.connect(buyer).approve(await A.desk.getAddress(), 0);
      await B.weth.connect(seller).approve(await B.desk.getAddress(), 0);
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);
      const u0 = await A.usdc.balanceOf(buyer.address);
      const w0 = await B.weth.balanceOf(seller.address);
      await ring();
      expect(await A.usdc.balanceOf(buyer.address)).to.equal(u0);
      expect(await B.weth.balanceOf(seller.address)).to.equal(w0);
      expect(await A.usdc.balanceOf(await A.desk.getAddress())).to.equal(1_000_000000n); // desk pot untouched
      expect((await referee.orders(1)).open).to.equal(false);
      expect((await referee.orders(2)).open).to.equal(false);
      expect(await referee.pulling()).to.equal(false);
      expect(await referee.cronOn()).to.equal(false);
    });
  });

  describe("cancel", function () {
    it("a cancel before the bell drops the order with no pull", async function () {
      const A = chains.A;
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      const r = await (await A.desk.connect(buyer).cancel(1)).wait();
      await feed(r);
      expect((await referee.orders(1)).open).to.equal(false);
      const dropped = trace.flatMap((t) => refereeEvents(t, "OrderDropped"));
      expect(dropped.some((d) => d.args.reason === "cancelled")).to.equal(true);
      const bell = await ring();
      expect(callbacks(bell).length).to.equal(0);
      expect(await referee.cronOn()).to.equal(false);
    });

    it("a cancel from a stranger reverts", async function () {
      const A = chains.A;
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await expect(A.desk.connect(outsider).cancel(1)).to.be.revertedWithCustomError(A.desk, "NotOrderTrader");
    });

    it("a cancel during pulling but before the collect makes the pull fail, and the rest settle", async function () {
      const A = chains.A;
      const B = chains.B;
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);
      const cbs = await ringHeld();
      expect(await referee.pulling()).to.equal(true);

      const cr = await (await A.desk.connect(buyer).cancel(1)).wait();
      await feed(cr); // referee is pulling and the order is in the round, so it ignores the event
      expect((await referee.orders(1)).open).to.equal(true);

      const u0 = await A.usdc.balanceOf(buyer.address);
      const w0 = await B.weth.balanceOf(seller.address);
      const u1 = await B.usdc.balanceOf(seller.address);
      for (const c of cbs) await runCallback(c);
      expect(await A.usdc.balanceOf(buyer.address)).to.equal(u0); // the cancelled buyer was never pulled
      expect((await referee.orders(1)).open).to.equal(false);
      expect((await referee.orders(2)).open).to.equal(false);
      // The seller was pulled and settled against the chain B pool.
      expect(await B.weth.balanceOf(seller.address)).to.be.lessThan(w0);
      expect(await B.usdc.balanceOf(seller.address)).to.be.greaterThan(u1);
    });

    it("a cancel event after settlement is a no-op on the referee", async function () {
      const A = chains.A;
      const B = chains.B;
      await observePrice();
      await place(A, buyer, true, LIMIT_HIGH, QTY);
      await place(B, seller, false, LIMIT_LOW, QTY);
      await ring();
      expect((await referee.orders(1)).open).to.equal(false);
      const fake = {
        address: await A.desk.getAddress(),
        topics: [ethers.id("OrderCancelled(uint256,address)"), ethers.zeroPadValue("0x01", 32), ethers.zeroPadValue(buyer.address, 32)],
        data: "0x",
        blockNumber: 1,
        index: 0,
      };
      await feed({ logs: [fake] });
      expect((await referee.orders(1)).open).to.equal(false);
      await expect(A.desk.connect(buyer).cancel(1)).to.be.revertedWithCustomError(A.desk, "AlreadyFrozen");
    });

    it("configure subscribes to exactly 9 desk and pool events", async function () {
      const Referee = await ethers.getContractFactory("BellReferee");
      const fresh = await Referee.deploy();
      await fresh.waitForDeployment();
      const rc = await (await fresh.configure({
        chainA: chains.A.cfg,
        chainB: chains.B.cfg,
        poolManagerB: await chains.B.pm.getAddress(),
        poolIdB: chains.B.poolId,
      })).wait();
      const subs = rc.logs.map((l) => { try { return system.interface.parseLog(l); } catch { return null; } }).filter((e) => e && e.name === "Subscribed");
      expect(subs.length).to.equal(9);
      const cancelTopic = BigInt(ethers.id("OrderCancelled(uint256,address)"));
      expect(subs.filter((e) => e.args.topic0 === cancelTopic).length).to.equal(2);
    });
  });

  describe("capacity", function () {
    // Gas is measured on the referee's own reactions with the mock system contract. It does not include
    // the real system contract's cost per callback, so it is a floor for the real number, not the real number.
    const UNIT = 10n ** 14n; // 0.0001 WETH, above the dust threshold
    const SETTLE_BUDGET = 700_000n; // headroom under the 900k reaction cap

    async function prepare() {
      const sg = await ethers.getSigners();
      const traders = sg.slice(8, 32);
      for (const t of traders) {
        for (const c of [chains.A, chains.B]) {
          await c.usdc.mint(t.address, 100_000000n);
          await c.weth.mint(t.address, ethers.parseEther("1"));
          await c.usdc.connect(t).approve(await c.desk.getAddress(), ethers.MaxUint256);
          await c.weth.connect(t).approve(await c.desk.getAddress(), ethers.MaxUint256);
        }
      }
      return traders;
    }

    // Half buyers, half sellers. Buyers are 2 units each. Sellers are 1, then 2 x (m - 2), then 1 for the last,
    // so the cumulative sums never meet until the end and FIFO gives nb + ns - 1 pairs.
    async function maxPairs(T, n) {
      const m = n / 2;
      const sellerSizes = [1n, ...Array(m - 2).fill(2n), 1n];
      if (m === 1) sellerSizes.splice(0, sellerSizes.length, 2n);
      const order = [];
      for (let i = 0; i < m; i++) order.push({ t: T[i], chain: i % 2 === 0 ? chains.A : chains.B, buy: true, qty: 2n * UNIT });
      for (let j = 0; j < m; j++) order.push({ t: T[m + j], chain: j % 2 === 0 ? chains.B : chains.A, buy: false, qty: sellerSizes[j] * UNIT });
      for (const o of order) await place(o.chain, o.t, o.buy, o.buy ? LIMIT_HIGH : LIMIT_LOW, o.qty);
    }

    async function allSwaps(T, n) {
      for (let i = 0; i < n; i++) await place(i % 2 === 0 ? chains.A : chains.B, T[i], true, LIMIT_HIGH, 2n * UNIT);
    }

    async function measure(T, n, kind) {
      gasLog = [];
      await observePrice();
      if (kind === "pairs") await maxPairs(T, n);
      else await allSwaps(T, n);
      await ring();
      const settle = gasLog.find((g) => g.tags.includes("settle"));
      const bell = gasLog.find((g) => g.tags.includes("bell"));
      for (let id = Number(await referee.nextBookId()) - n; id < Number(await referee.nextBookId()); id++) {
        expect((await referee.orders(id)).open).to.equal(false);
      }
      return { n, kind, bell: bell.gas, bellCb: bell.callbacks, settle: settle.gas, settleCb: settle.callbacks };
    }

    it("measures bell and settle gas by book size, and MAX_BOOK keeps the worst case under budget", async function () {
      const T = await prepare();
      const max = Number(await referee.MAX_BOOK());
      const sizes = [4, 8, 12].filter((n) => n <= max);
      let worst = 0n;
      let worstBell = 0n;
      for (const n of sizes) {
        for (const kind of ["pairs", "swaps"]) {
          const r = await measure(T, n, kind);
          console.log(`        ${String(r.n).padStart(2)} orders ${kind.padEnd(5)}: bell ${r.bell} gas (${r.bellCb} cb), settle ${r.settle} gas (${r.settleCb} cb)`);
          if (n === max) {
            if (r.settle > worst) worst = r.settle;
            if (r.bell > worstBell) worstBell = r.bell;
          }
        }
      }
      console.log(`        MAX_BOOK = ${max}: worst settle ${worst}, worst bell ${worstBell}`);
      expect(worst).to.be.greaterThan(0n);
      expect(worst).to.be.lessThan(SETTLE_BUDGET);
      expect(worstBell).to.be.lessThan(SETTLE_BUDGET);
    });

    it("an order past MAX_BOOK is dropped with 'book full'", async function () {
      const T = await prepare();
      await observePrice();
      const max = Number(await referee.MAX_BOOK());
      for (let i = 0; i < max; i++) await place(chains.A, T[i], true, LIMIT_LOW, UNIT);
      const before = trace.length;
      await place(chains.A, T[0], true, LIMIT_LOW, UNIT);
      const dropped = trace.slice(before).flatMap((t) => refereeEvents(t, "OrderDropped"));
      expect(dropped.length).to.equal(1);
      expect(dropped[0].args.reason).to.equal("book full");
      expect((await referee.nextBookId()) - 1n).to.equal(BigInt(max));
    });
  });
});
