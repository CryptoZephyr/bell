import { parseAbi } from "viem";

export const refereeAbi = parseAbi([
  "function cronOn() view returns (bool)",
  "function pulling() view returns (bool)",
  "function openPrice() view returns (uint256)",
  "function settlePrice() view returns (uint256)",
  "function roundId() view returns (uint256)",
  "function MAX_BOOK() view returns (uint256)",
  "function MAX_ORDERS_PER_TRADER() view returns (uint256)",
  "function ORDER_TTL() view returns (uint256)",
  "function openIds(uint256) view returns (uint256)",
  "function placedAt(uint256) view returns (uint64)",
  "function bookIdOf(bytes32) view returns (uint256)",
  "function orders(uint256) view returns (address trader, uint32 chainId, bool isBuy, bool open, uint48 deskOrderId, uint128 limit, uint128 qty)",
  "event OrderAdded(uint256 indexed bookId, uint256 chainId, uint256 deskOrderId, address trader, bool isBuy)",
  "event OrderDropped(uint256 indexed bookId, string reason)",
  "event Observed(uint160 sqrtPriceX96, uint256 price)",
  "event RoundOpened(uint256 price)",
  "event BellVoid(string reason)",
  "event BellRang(uint256 price, uint256 eligibleCount, uint256 pairCount)",
  "event Unwound(uint256 failedBookId)",
  "event Settled(uint256 price, uint256 pairCount)",
  "event PullsExpired(uint256 indexed roundId, uint256 missing)",
  "event Refunded(address indexed to, uint256 chainId, uint256 amount)",
]);

export const deskAbi = parseAbi([
  "function place(bool isBuy, uint256 price, uint256 qty) returns (uint256)",
  "function cancel(uint256 orderId)",
  "function MIN_QTY() view returns (uint256)",
  "function orders(uint256) view returns (address trader, bool isBuy, uint256 price, uint256 qty)",
  "function collectedOf(uint256) view returns (uint256)",
  "function closedOf(uint256) view returns (uint256)",
  "function frozen(uint256) view returns (bool)",
  "error NotFunded()",
  "error OrderTooSmall()",
  "error OrderTooLarge()",
  "error ZeroAmount()",
  "error NotOrderTrader()",
  "error AlreadyFrozen()",
  "event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBuy, uint256 price, uint256 qty)",
  "event OrderCancelled(uint256 indexed orderId, address indexed trader)",
  "event Collected(uint256 indexed orderId, address indexed from, uint256 amount, bool ok)",
  "event Paid(uint256 indexed orderId, address indexed to, uint256 amount, bool ok)",
  "event Swapped(address indexed to, bool sellWeth, uint256 amountIn, uint256 amountUsed, uint256 amountOut, uint256 refunded, bool ok)",
  "event Refunded(uint256 indexed orderId, address indexed to, uint256 amount, bool ok)",
  "event Closed(uint256 indexed orderId, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function deposit() payable",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const poolManagerAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
export const systemAbi = parseAbi([
  "function reserves(address) view returns (uint256)",
  "function debts(address) view returns (uint256)",
]);
