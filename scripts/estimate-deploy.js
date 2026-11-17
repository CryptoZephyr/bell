// Estimates the REACT cost of deploying the referee and the desks, without sending anything.
const { ethers, network } = require("hardhat");
(async () => {
  const [signer] = await ethers.getSigners();
  const ref = await ethers.getContractFactory("BellReferee");
  const gas = await ethers.provider.estimateGas({ from: signer.address, data: ref.bytecode });
  const price = (await ethers.provider.getFeeData()).gasPrice;
  console.log(network.name, "referee deploy gas", gas.toString(), "cost REACT", ethers.formatEther(gas * price));
})().catch((e) => { console.error(String(e.shortMessage || e.message).slice(0, 200)); process.exitCode = 1; });
