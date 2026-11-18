// Moves the referee's own REACT balance into its system-contract reserves, then adds EXTRA REACT from the signer.
// Usage: EXTRA=0.2 npx hardhat run scripts/top-up-reserves.js --network lasna
// The contract balance is not counted as reserves, only depositTo is.
const { ethers } = require("hardhat");
const rec = require("../deployments/bell.json");
const SYSTEM = "0x8888888888888888888888888888888888888888";

(async () => {
  const [signer] = await ethers.getSigners();
  const ref = await ethers.getContractAt("BellReferee", rec.referee, signer);
  const sys = new ethers.Contract(SYSTEM, ["function depositTo(address) payable", "function reserves(address) view returns (uint256)"], signer);
  const bal = await ethers.provider.getBalance(rec.referee);
  if (bal > 0n) {
    await (await ref.withdraw(signer.address, bal)).wait();
    console.log("withdrew", ethers.formatEther(bal), "REACT from the referee");
  }
  const total = bal + ethers.parseEther(process.env.EXTRA || "0");
  if (total > 0n) {
    const r = await (await sys.depositTo(rec.referee, { value: total })).wait();
    console.log("depositTo", ethers.formatEther(total), "REACT", r.hash);
  }
  console.log("reserves now", ethers.formatEther(await sys.reserves(rec.referee)), "REACT");
})().catch((e) => { console.error(String(e.shortMessage || e.message).slice(0, 300)); process.exitCode = 1; });
