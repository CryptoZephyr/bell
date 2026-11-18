import { encodeAbiParameters, keccak256, numberToHex, zeroAddress } from "viem";
import { client } from "./clients";
import { DESKS, REFERENCE_POOL_ID, type DeskChainId } from "./config";
import { poolManagerAbi } from "./abi";

/** USDC micro-units per 1 ETH from a pool's sqrt price. USDC is currency0 in every pool. */
export const priceAtSqrt = (s: bigint): bigint => (s === 0n ? 0n : ((10n ** 18n) << 192n) / (s * s));

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (n + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / y) / 2n; }
  return x;
}
export const sqrtAtPrice = (microPerEth: bigint): bigint => isqrt(((10n ** 18n) << 192n) / microPerEth);

function poolIdOf(chainId: DeskChainId): `0x${string}` {
  const d = DESKS[chainId];
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [d.usdc, d.weth, 500, d.tickSpacing, zeroAddress],
    ),
  );
}

/** The live price of a chain's USDC/WETH pool, read straight from the pool manager's storage. */
export async function poolPrice(chainId: DeskChainId): Promise<{ sqrt: bigint; price: bigint }> {
  const d = DESKS[chainId];
  const id = chainId === 1301 ? REFERENCE_POOL_ID : poolIdOf(chainId);
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]));
  const raw = await client(chainId).readContract({ address: d.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot] });
  const sqrt = BigInt(raw) & ((1n << 160n) - 1n);
  return { sqrt, price: priceAtSqrt(sqrt) };
}

export { numberToHex };
