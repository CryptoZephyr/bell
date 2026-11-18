// Deploys the Bell contracts one stage at a time. Usage:
//   STAGE=referee npx hardhat run scripts/deploy.js --network lasna
//   STAGE=desk:baseSepolia npx hardhat run scripts/deploy.js --network baseSepolia
//   STAGE=desk:unichainSepolia npx hardhat run scripts/deploy.js --network unichainSepolia
//   STAGE=configure npx hardhat run scripts/deploy.js --network lasna
// Addresses are written to deployments/bell.json, shared by all stages. Private keys come from BELL_PRIVATE_KEY.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const CHAINS = {
  baseSepolia: {
    chainId: 84532n,
    callbackProxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    weth: "0x4200000000000000000000000000000000000006",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    tickSpacing: 20, // fee-500 pool on Base, tick spacing 20 (the tick-10 pool there is broken)
    fundEth: "0.005",
  },
  unichainSepolia: {
    chainId: 1301n,
    callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
    weth: "0x4200000000000000000000000000000000000006",
    poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
    tickSpacing: 10, // reference pool on Unichain
    fundEth: "0.005",
  },
};

const file = path.join(__dirname, "..", "deployments", "bell.json"); // shared across networks
const readRecord = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const writeRecord = (rec) => fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");

async function main() {
  const stage = process.env.STAGE;
  const [signer] = await ethers.getSigners();
  const rec = readRecord();
  console.log(`network=${network.name} stage=${stage} signer=${signer.address}`);

  if (stage === "referee") {
    const F = await ethers.getContractFactory("BellReferee");
    const value = ethers.parseEther(process.env.REACT_FUND || "0.3");
    const c = await F.deploy({ value });
    await c.waitForDeployment();
    rec.referee = await c.getAddress();
    rec.refereeTx = c.deploymentTransaction().hash;
    rec.refereeBlock = (await c.deploymentTransaction().wait()).blockNumber; // the app scans events from here
    writeRecord(rec);
    console.log("referee", rec.referee, "tx", rec.refereeTx);
    return;
  }

  if (stage.startsWith("desk:")) {
    const key = stage.slice(5);
    const cfg = CHAINS[key];
    if (!cfg) throw new Error(`unknown chain ${key}`);
    if (!rec.referee) throw new Error("deploy the referee first (its address is the desk's callback sender)");
    const F = await ethers.getContractFactory("BellDesk");
    const c = await F.deploy(cfg.callbackProxy, rec.referee, cfg.usdc, cfg.weth, cfg.poolManager, cfg.tickSpacing, {
      value: ethers.parseEther(cfg.fundEth),
    });
    await c.waitForDeployment();
    rec[key] = {
      chainId: cfg.chainId.toString(),
      desk: await c.getAddress(),
      usdc: cfg.usdc,
      weth: cfg.weth,
      poolManager: cfg.poolManager,
      tickSpacing: cfg.tickSpacing,
      tx: c.deploymentTransaction().hash,
      block: (await c.deploymentTransaction().wait()).blockNumber, // the app scans events from here
    };
    writeRecord(rec);
    console.log(key, "desk", rec[key].desk, "tx", rec[key].tx);
    return;
  }

  if (stage === "configure") {
    if (!rec.referee || !rec.baseSepolia || !rec.unichainSepolia) throw new Error("missing deployment records");
    const referee = await ethers.getContractAt("BellReferee", rec.referee);
    const poolKey = {
      currency0: rec.unichainSepolia.usdc,
      currency1: rec.unichainSepolia.weth,
      fee: 500,
      tickSpacing: 10,
      hooks: ethers.ZeroAddress,
    };
    const poolId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint24,int24,address)"],
        [[poolKey.currency0, poolKey.currency1, 500, 10, ethers.ZeroAddress]]
      )
    );
    const toCfg = (d) => ({ chainId: BigInt(d.chainId), desk: d.desk, usdc: d.usdc, weth: d.weth });
    const tx = await referee.configure({
      chainA: toCfg(rec.baseSepolia),
      chainB: toCfg(rec.unichainSepolia),
      poolManagerB: rec.unichainSepolia.poolManager,
      poolIdB: poolId,
    });
    const r = await tx.wait();
    rec.configureTx = tx.hash;
    rec.poolIdB = poolId;
    writeRecord(rec);
    console.log("configured, tx", tx.hash, "status", r.status, "poolId", poolId);
    return;
  }

  throw new Error(`unknown STAGE ${stage}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
