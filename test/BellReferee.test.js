const { expect } = require("chai");
const { ethers } = require("hardhat");

// Local stand-ins only, inside test/. The Uniswap v4 PoolManager is real.
// The Reactive system contract is a stand-in (MockSystem), as Memory.md allows for unit tests.
// Nothing here is deployed, demoed or claimed.

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
    chain_id: chainId,
    _contract: lg.address,
    topic_0: t[0] ? BigInt(t[0]) : 0n,
    topic_1: t[1] ? BigInt(t[1]) : 0n,
    topic_2: t[2] ? BigInt(t[2]) : 0n,
    topic_3: t[3] ? BigInt(t[3]) : 0n,
    data: lg.data,
    block_number: BigInt(lg.blockNumber),
    op_code: 0n,
    block_hash: 0n,
    tx_hash: 0n,
    log_index: BigInt(lg.index),
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
    const desk = await Desk.deploy(proxy.address, await usdc.getAddress(), await weth.getAddress(), await pm.getAddress());
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

    const MockSystem = await ethers.getContractFactory("MockSystem");
    system = await MockSystem.deploy();
    await system.waitForDeployment();

    chains = {
      A: await makeChain(CHAIN_A),
      B: await makeChain(CHAIN_B),
    };

    const Referee = await ethers.getContractFactory("BellReferee");
    referee = await Referee.deploy({
      system: await system.getAddress(),
      chainA: chains.A.cfg,
      chainB: chains.B.cfg,
      poolManagerB: await chains.B.pm.getAddress(),
      poolIdB: chains.B.poolId,
    });
    await referee.waitForDeployment();
    refereeAddr = await referee.getAddress();

    await chains.A.desk.setReferee(refereeAddr);
    await chains.B.desk.setReferee(refereeAddr);

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
      if (lg.address.toLowerCase() !== refereeAddr.toLowerCase()) continue;
      let parsed;
      try {
        parsed = referee.interface.parseLog(lg);
      } catch {
        continue;
      }
      if (!parsed || parsed.name !== "Callback") continue;
      const payload = parsed.args.payload;
      const data = payload.slice(0, 10) + ethers.zeroPadValue(refereeAddr, 32).slice(2) + payload.slice(74);
      const tx = await proxy.sendTransaction({ to: parsed.args._contract, data, gasLimit: 3_000_000 });
      const r = await tx.wait();
      trace.push(r);
      if (r.status !== 1) throw new Error("desk callback reverted");
      await feed(r);
    }
  }

  async function ring() {
    const cron = {
      chain_id: LASNA,
      _contract: CRON_CONTRACT,
      topic_0: BigInt(CRON_TOPIC),
      topic_1: 0n,
      topic_2: 0n,
      topic_3: 0n,
      data: "0x",
      block_number: 0n,
      op_code: 0n,
      block_hash: 0n,
      tx_hash: 0n,
      log_index: 0n,
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
    return refereeEvents(receipt, "Callback");
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
    const rec = { chain_id: LASNA, _contract: CRON_CONTRACT, topic_0: BigInt(CRON_TOPIC), topic_1: 0n, topic_2: 0n, topic_3: 0n, data: "0x", block_number: 0n, op_code: 0n, block_hash: 0n, tx_hash: 0n, log_index: 0n };
    await expect(referee.connect(outsider).react(rec)).to.be.revertedWithCustomError(referee, "NotSystem");
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
    const targets = callbacks(r).map((c) => c.args._contract.toLowerCase());
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

  it("fills an unmatched buyer at the chain A pool (buyer-side fallback)", async function () {
    const A = chains.A;
    await observePrice();
    await place(A, buyer, true, LIMIT_HIGH, QTY); // no seller at all

    const buyerWethA0 = await A.weth.balanceOf(buyer.address);
    const r = await ring();
    const deskB = (await chains.B.desk.getAddress()).toLowerCase();
    expect(callbacks(r).every((c) => c.args._contract.toLowerCase() !== deskB)).to.equal(true);
    expect((await A.weth.balanceOf(buyer.address)) - buyerWethA0).to.be.greaterThan(0);
    expect((await referee.orders(1)).open).to.equal(false);
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
