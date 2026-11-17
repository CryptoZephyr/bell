// Deposits REACT into the Omni system contract as reserves for a reactive contract.
// Usage: AMOUNT=0.2 npx hardhat run scripts/fund-reserves.js --network lasna
const { ethers, network } = require("hardhat");
const rec = require("../deployments/bell.json");

const SYSTEM = "0x8888888888888888888888888888888888888888";

async function main() {
  const [signer] = await ethers.getSigners();
  const sys = new ethers.Contract(SYSTEM, ["function depositTo(address) payable", "function reserves(address) view returns (uint256)"], signer);
  const amount = ethers.parseEther(process.env.AMOUNT || "0.2");
  const tx = await sys.depositTo(rec.referee, { value: amount });
  const r = await tx.wait();
  console.log(`network=${network.name} depositTo tx ${tx.hash} status ${r.status}`);
  console.log("reserves now", ethers.formatEther(await sys.reserves(rec.referee)), "REACT");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
