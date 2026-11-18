// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @title BellReferee
/// @notice The single Reactive contract on Lasna. It keeps one book across both desks,
///         rings the bell on timer events, prices the round from the reference pool,
///         and runs two-step settlement through desk callbacks.
/// @dev Guard: round-drift guard. Skip the round if the reference price at the bell differs
///      from the price when the round opened by more than DRIFT_BPS.
///      Deploy order: this contract first (no arguments), then the desks with this address
///      as their callback sender, then configure() once with the desk addresses.
contract BellReferee is AbstractReactive {
    // ---------------------------------------------------------------- constants

    uint64 public constant GAS_PULL_PAY = 400_000;
    uint64 public constant GAS_SWAP = 900_000;
    uint256 public constant DRIFT_BPS = 1000; // 10%
    uint256 public constant BPS = 10_000;
    /// @dev Set from measured gas, with the live system contract in the loop. A live 8-order round (7 pairs) used
    ///      364,590 gas for the bell and 717,911 for the settling reaction, so 8 orders already sit at the 700k
    ///      budget under the 900k reaction cap. The real system adds about 10k gas per callback over the local
    ///      stand-in. A reaction that does not fit would also fail on the expiry retry, so the cap keeps real headroom.
    uint256 public constant MAX_BOOK = 6;
    uint256 public constant PULL_TIMEOUT = 300; // seconds a round may wait for its pull callbacks
    uint256 public constant MAX_ORDERS_PER_TRADER = 2; // open orders one wallet may hold, so one wallet cannot fill the book
    uint256 public constant ORDER_TTL = 1800; // seconds an order may stay in the book. Older orders drop at the next bell
    uint256 public constant DUST_USDC = 10_000; // 0.01 USDC, below this a remainder is refunded, not swapped
    uint256 public constant DUST_WETH = 1e12; // 1e-6 WETH, below this a remainder is refunded, not swapped

    /// @dev Lasna timer: Cron100 ticks about every two minutes.
    address public constant CRON_CONTRACT = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant CRON_TOPIC = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 public constant LASNA_CHAIN_ID = 5318007;

    bytes32 public constant T_ORDER_PLACED = keccak256("OrderPlaced(uint256,address,bool,uint256,uint256)");
    bytes32 public constant T_COLLECTED = keccak256("Collected(uint256,address,uint256,bool)");
    bytes32 public constant T_TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 public constant T_SWAP = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    bytes32 public constant T_SWAPPED = keccak256("Swapped(address,bool,uint256,uint256,uint256,uint256,bool)");
    bytes32 public constant T_CANCELLED = keccak256("OrderCancelled(uint256,address)");

    /// @dev The desk's pool fee in parts per million. Used to tighten a trader's limit for the fallback swap.
    uint256 internal constant POOL_FEE_PPM = 500;

    // ---------------------------------------------------------------- config

    struct ChainConfig {
        uint256 chainId;
        address desk;
        address usdc;
        address weth;
    }

    struct Config {
        ChainConfig chainA; // Base Sepolia
        ChainConfig chainB; // Unichain Sepolia, hosts the reference pool
        address poolManagerB;
        bytes32 poolIdB;
    }

    address public immutable deployer;
    bool public configured;
    ChainConfig public chainA;
    ChainConfig public chainB;
    address public poolManagerB;
    bytes32 public poolIdB;

    // ---------------------------------------------------------------- book

    /// @dev Packed into 2 storage slots, because every reaction pays a cold read per slot per order.
    ///      The desk address is not stored. It follows from the chain id.
    struct Order {
        address trader;
        uint32 chainId;
        bool isBuy;
        bool open;
        uint48 deskOrderId;
        uint128 limit; // USDC micro-units per 1 WETH, the trader's protection
        uint128 qty; // WETH wei
    }

    struct Pair {
        uint256 buyer; // book id
        uint256 seller; // book id
        uint256 amount; // WETH wei
    }

    mapping(uint256 => Order) public orders;
    mapping(bytes32 => uint256) public bookIdOf; // keccak(chainId, deskOrderId) => book id
    mapping(uint256 => uint64) public placedAt; // book id => timestamp the referee heard the order
    uint256 public nextBookId = 1;
    uint256[] public openIds; // FIFO order of the book
    bool public cronOn;

    // ---------------------------------------------------------------- round state

    bool public haveObservation;
    uint160 public lastSqrtPriceX96;
    uint256 public openPrice; // reference price when the round opened, 0 if unknown
    bool public pulling;
    uint256 public settlePrice;

    uint256 public roundId;
    uint256 public pullStartedAt;
    uint32[] internal eligible; // book ids of this round's orders, packed 8 to a slot to keep the bell cheap
    mapping(uint256 => uint256) internal reportedRound; // book id => round whose pull it reported in
    mapping(uint256 => uint256) internal pulled; // book id => amount collected this round
    mapping(uint256 => bool) internal pullOk;
    uint256 internal pendingPulls;
    bool internal anyPullFailed;

    // ---------------------------------------------------------------- events

    event Configured(address indexed poolManagerB, bytes32 poolIdB);
    event OrderAdded(uint256 indexed bookId, uint256 chainId, uint256 deskOrderId, address trader, bool isBuy);
    event OrderDropped(uint256 indexed bookId, string reason);
    event Observed(uint160 sqrtPriceX96, uint256 price);
    event RoundOpened(uint256 price);
    event BellVoid(string reason);
    event BellRang(uint256 price, uint256 eligibleCount, uint256 pairCount);
    event Unwound(uint256 failedBookId);
    event Settled(uint256 price, uint256 pairCount);
    event Withdrawn(address indexed to, uint256 amount);
    event Refunded(address indexed to, uint256 chainId, uint256 amount);
    event PullsExpired(uint256 indexed roundId, uint256 missing);

    // ---------------------------------------------------------------- errors

    error NotDeployer();
    error AlreadyConfigured();
    error NotConfigured();
    error ZeroAddress();
    error UnknownChain();
    error BadPrice();
    error WithdrawFailed();

    // ---------------------------------------------------------------- setup

    constructor() payable {
        deployer = msg.sender;
    }

    /// @notice Deployer-only, once. Stores the desks and subscribes to their events and the reference pool.
    function configure(Config calldata c) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (configured) revert AlreadyConfigured();
        if (c.chainA.desk == address(0) || c.chainB.desk == address(0) || c.poolManagerB == address(0)) {
            revert ZeroAddress();
        }
        if (c.chainA.chainId > type(uint32).max || c.chainB.chainId > type(uint32).max) revert UnknownChain();
        configured = true;
        chainA = c.chainA;
        chainB = c.chainB;
        poolManagerB = c.poolManagerB;
        poolIdB = c.poolIdB;

        // Desk events on both chains, and reference pool swaps on chain B.
        SYSTEM.subscribe(c.chainA.chainId, c.chainA.desk, uint256(T_ORDER_PLACED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainA.chainId, c.chainA.desk, uint256(T_COLLECTED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainB.chainId, c.chainB.desk, uint256(T_ORDER_PLACED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainB.chainId, c.chainB.desk, uint256(T_COLLECTED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainB.chainId, c.poolManagerB, uint256(T_SWAP), uint256(c.poolIdB), REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainA.chainId, c.chainA.desk, uint256(T_SWAPPED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainB.chainId, c.chainB.desk, uint256(T_SWAPPED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainA.chainId, c.chainA.desk, uint256(T_CANCELLED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(c.chainB.chainId, c.chainB.desk, uint256(T_CANCELLED), REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit Configured(c.poolManagerB, c.poolIdB);
    }

    /// @notice Deployer withdraws leftover REACT.
    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------- reactive entry point

    function react(LogRecord calldata log) external onlySystem {
        if (log.contractAddress == CRON_CONTRACT && log.topic0 == CRON_TOPIC) {
            _bell();
            return;
        }
        bytes32 t0 = bytes32(log.topic0);
        if (t0 == T_ORDER_PLACED) {
            _onOrderPlaced(log);
        } else if (t0 == T_COLLECTED) {
            _onCollected(log);
        } else if (t0 == T_SWAP) {
            _onSwap(log);
        } else if (t0 == T_SWAPPED) {
            _onSwapped(log);
        } else if (t0 == T_TRANSFER) {
            _onTransfer(log);
        } else if (t0 == T_CANCELLED) {
            _onCancelled(log);
        }
    }

    // ---------------------------------------------------------------- book

    function _onOrderPlaced(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chainId);
        if (log.contractAddress != c.desk) return;
        (bool isBuy, uint256 limit, uint256 qty) = abi.decode(log.data, (bool, uint256, uint256));
        uint256 deskOrderId = log.topic1;
        address trader = address(uint160(log.topic2));

        if (openIds.length >= MAX_BOOK) {
            emit OrderDropped(0, "book full");
            return;
        }
        if (limit > type(uint128).max || qty > type(uint128).max || deskOrderId > type(uint48).max) {
            emit OrderDropped(0, "order too large");
            return;
        }
        uint256 mine;
        for (uint256 k = 0; k < openIds.length; k++) {
            if (orders[openIds[k]].trader == trader) mine++;
        }
        if (mine >= MAX_ORDERS_PER_TRADER) {
            emit OrderDropped(0, "too many open orders");
            return;
        }
        if (openIds.length == 0) {
            // The round opens with its first order. Anchor the drift guard to the latest price.
            openPrice = haveObservation ? _price(lastSqrtPriceX96) : 0;
            emit RoundOpened(openPrice);
            if (!cronOn) {
                SYSTEM.subscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
                cronOn = true;
            }
        }

        uint256 id = nextBookId++;
        orders[id] = Order({
            trader: trader,
            chainId: uint32(log.chainId),
            isBuy: isBuy,
            open: true,
            deskOrderId: uint48(deskOrderId),
            limit: uint128(limit),
            qty: uint128(qty)
        });
        bookIdOf[keccak256(abi.encode(log.chainId, deskOrderId))] = id;
        placedAt[id] = uint64(block.timestamp);
        openIds.push(id);

        // Funding watch: hear the trader's token transfers while the order is open.
        _subscribeTransfer(log.chainId, isBuy ? c.usdc : c.weth, trader);
        emit OrderAdded(id, log.chainId, deskOrderId, trader, isBuy);
    }

    function _onTransfer(LogRecord calldata log) internal {
        if (pulling) return; // our own pulls show up as transfers during settlement
        address from = address(uint160(log.topic1));
        ChainConfig memory c = _chainFor(log.chainId);
        uint256 k = 0;
        while (k < openIds.length) {
            uint256 id = openIds[k];
            Order storage o = orders[id];
            address token = o.isBuy ? c.usdc : c.weth;
            if (o.chainId == log.chainId && o.trader == from && log.contractAddress == token) {
                _drop(id, "funds moved"); // shifts openIds, so do not advance k
            } else {
                k++;
            }
        }
    }

    function _onCollected(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chainId);
        if (log.contractAddress != c.desk || !pulling) return;
        uint256 id = bookIdOf[keccak256(abi.encode(log.chainId, log.topic1))];
        if (id == 0 || !orders[id].open) return;
        if (reportedRound[id] == roundId) return; // duplicate event in this round
        (uint256 amount, bool ok) = abi.decode(log.data, (uint256, bool));
        reportedRound[id] = roundId;
        pulled[id] = amount;
        pullOk[id] = ok;
        if (!ok) anyPullFailed = true;
        pendingPulls--;
        if (pendingPulls == 0) _resolvePulls();
    }

    /// @dev A trader cancelled on the desk. Before the pull the order leaves the book. Once a round is pulling,
    ///      the desk decides through collect, because a frozen order fails its pull.
    function _onCancelled(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chainId);
        if (log.contractAddress != c.desk) return;
        uint256 id = bookIdOf[keccak256(abi.encode(log.chainId, log.topic1))];
        if (id == 0 || !orders[id].open) return;
        if (pulling) {
            for (uint256 k = 0; k < eligible.length; k++) {
                if (eligible[k] == id) return;
            }
        }
        _drop(id, "cancelled");
    }

    function _onSwap(LogRecord calldata log) internal {
        if (log.contractAddress != poolManagerB || log.topic1 != uint256(poolIdB)) return;
        (, , uint160 sqrtPriceX96, , , ) = abi.decode(log.data, (int128, int128, uint160, uint128, int24, uint24));
        haveObservation = true;
        lastSqrtPriceX96 = sqrtPriceX96;
        uint256 px = _price(sqrtPriceX96);
        emit Observed(sqrtPriceX96, px);
        // An order arrived before any pool swap was heard. Anchor the guard to this first price.
        if (openIds.length > 0 && openPrice == 0) {
            openPrice = px;
            emit RoundOpened(px);
        }
    }

    /// @dev A desk swap that reports ok = false leaves the amount in the desk. Return it to the trader.
    function _onSwapped(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chainId);
        if (log.contractAddress != c.desk) return;
        address to = address(uint160(log.topic1));
        (bool sellWeth, uint256 amountIn, , , , bool ok) =
            abi.decode(log.data, (bool, uint256, uint256, uint256, uint256, bool));
        // A partial fill needs nothing here, the desk already returned the unused part.
        if (ok) return;
        _callback(log.chainId, c.desk, GAS_PULL_PAY, abi.encodeWithSignature(
            "pay(address,uint256,address,bool,uint256)", address(0), 0, to, !sellWeth, amountIn
        ));
        emit Refunded(to, log.chainId, amountIn);
    }

    /// @dev Some pull callback never reported. Count the missing ones as failed, then unwind or settle.
    function _expirePulls() internal {
        uint256 missing;
        for (uint256 k = 0; k < eligible.length; k++) {
            uint256 id = eligible[k];
            if (reportedRound[id] != roundId) {
                reportedRound[id] = roundId;
                pulled[id] = 0;
                pullOk[id] = false;
                anyPullFailed = true;
                pendingPulls--;
                missing++;
            }
        }
        emit PullsExpired(roundId, missing);
        if (pendingPulls == 0) _resolvePulls();
    }

    // ---------------------------------------------------------------- bell

    function _bell() internal {
        if (openIds.length == 0) {
            if (cronOn) {
                SYSTEM.unsubscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
                cronOn = false;
            }
            return;
        }
        if (pulling) {
            if (block.timestamp >= pullStartedAt + PULL_TIMEOUT) {
                _expirePulls();
                return;
            }
            emit BellVoid("previous round still settling");
            return;
        }
        // Orders that sat in the book too long leave it, so limits parked far from the market cannot hold slots forever.
        if (_expireStale() && openIds.length == 0) {
            if (cronOn) {
                SYSTEM.unsubscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
                cronOn = false;
            }
            openPrice = 0;
            return;
        }
        if (!haveObservation) {
            emit BellVoid("no pool price heard");
            return;
        }
        if (openPrice == 0) {
            emit BellVoid("no opening price");
            return;
        }

        uint256 p = _price(lastSqrtPriceX96);
        uint256 diff = p > openPrice ? p - openPrice : openPrice - p;
        if (diff * BPS > openPrice * DRIFT_BPS) {
            // The guard blocks a jump inside one window. If the new price holds, the next bell clears.
            openPrice = p;
            emit RoundOpened(p);
            emit BellVoid("drift guard: round skipped, orders carry");
            return;
        }

        _clear(p);
    }

    /// @dev Pick the orders inside their protection at price p, match them, then start step 1 (pulls).
    ///      Orders outside their protection carry over. Pairs are not stored. They are rebuilt from the eligible
    ///      orders when the round settles, which keeps the bell and the settling reaction cheap.
    function _clear(uint256 p) internal {
        delete eligible;

        uint256 total = openIds.length;
        Order[] memory os = new Order[](total);
        uint256 n;
        for (uint256 k = 0; k < total; k++) {
            uint256 id = openIds[k];
            Order memory o = orders[id];
            if ((o.isBuy && o.limit >= p) || (!o.isBuy && o.limit <= p)) {
                os[n++] = o;
                eligible.push(uint32(id));
            }
        }
        if (n == 0) return;
        assembly { mstore(os, n) } // shrink to the eligible orders

        Pair[] memory prs = _match(os);

        // Step 1: pull from every eligible trader. Buyers pull the full cost at p (rounded up).
        settlePrice = p;
        roundId++;
        pullStartedAt = block.timestamp;
        pulling = true;
        pendingPulls = n;
        anyPullFailed = false;
        for (uint256 k = 0; k < n; k++) {
            Order memory o = os[k];
            uint256 amount = o.isBuy ? _ceilMul(o.qty, p) : o.qty;
            _callback(o.chainId, _desk(o.chainId), GAS_PULL_PAY, abi.encodeWithSignature(
                "collect(address,uint256,address,bool,uint256)", address(0), o.deskOrderId, o.trader, o.isBuy, amount
            ));
        }
        emit BellRang(p, n, prs.length);
    }

    /// @dev Two-pointer FIFO match of the eligible orders. Pairs hold positions in `os`, not book ids.
    function _match(Order[] memory os) internal pure returns (Pair[] memory prs) {
        uint256 n = os.length;
        uint256[] memory buyers = new uint256[](n);
        uint256[] memory sellers = new uint256[](n);
        uint256[] memory remB = new uint256[](n);
        uint256[] memory remS = new uint256[](n);
        uint256 nb;
        uint256 ns;
        for (uint256 k = 0; k < n; k++) {
            if (os[k].isBuy) {
                remB[nb] = os[k].qty;
                buyers[nb++] = k;
            } else {
                remS[ns] = os[k].qty;
                sellers[ns++] = k;
            }
        }
        Pair[] memory tmp = new Pair[](nb + ns);
        uint256 np;
        uint256 bi;
        uint256 sj;
        while (bi < nb && sj < ns) {
            uint256 take = remB[bi] < remS[sj] ? remB[bi] : remS[sj];
            if (take > 0) tmp[np++] = Pair({buyer: buyers[bi], seller: sellers[sj], amount: take});
            remB[bi] -= take;
            remS[sj] -= take;
            if (remB[bi] == 0) bi++;
            if (remS[sj] == 0) sj++;
        }
        assembly { mstore(tmp, np) }
        return tmp;
    }

    /// @dev Step 2: pay counterparties on the other chain, then sell each remainder into the pool.
    function _settle() internal {
        uint256 p = settlePrice;
        uint256 n = eligible.length;
        uint256[] memory ids = new uint256[](n);
        Order[] memory os = new Order[](n);
        for (uint256 k = 0; k < n; k++) {
            ids[k] = eligible[k];
            os[k] = orders[ids[k]];
        }
        Pair[] memory prs = _match(os);
        uint256[] memory paid = new uint256[](n); // USDC paid out of a buyer's pull, WETH out of a seller's

        for (uint256 i = 0; i < prs.length; i++) {
            Order memory b = os[prs[i].buyer];
            Order memory s = os[prs[i].seller];
            uint256 usdcOut = _floorMul(prs[i].amount, p);
            if (usdcOut > 0) {
                // Seller is paid USDC on the buyer's chain, from the buyer's pull.
                _callback(b.chainId, _desk(b.chainId), GAS_PULL_PAY, abi.encodeWithSignature(
                    "pay(address,uint256,address,bool,uint256)", address(0), s.deskOrderId, s.trader, true, usdcOut
                ));
            }
            // Buyer is paid WETH on the seller's chain, from the seller's pull.
            _callback(s.chainId, _desk(s.chainId), GAS_PULL_PAY, abi.encodeWithSignature(
                "pay(address,uint256,address,bool,uint256)", address(0), b.deskOrderId, b.trader, false, prs[i].amount
            ));
            paid[prs[i].buyer] += usdcOut;
            paid[prs[i].seller] += prs[i].amount;
        }

        // Remainders: buyers' unspent USDC goes into the pool for WETH, sellers' unsold WETH goes in for USDC.
        for (uint256 k = 0; k < n; k++) {
            Order memory o = os[k];
            uint256 rem = pulled[ids[k]] - paid[k];
            if (rem == 0) continue;
            bool canSwap = rem >= (o.isBuy ? DUST_USDC : DUST_WETH);
            if (canSwap) {
                // Each chain has its own USDC/WETH pool. Remainders are sold into the pool on the trader's chain.
                // The swap stops at the trader's own limit. What the pool cannot fill inside it comes back.
                uint160 lim = _sqrtLimit(o.isBuy, o.limit);
                _callback(o.chainId, _desk(o.chainId), GAS_SWAP, o.isBuy
                    ? abi.encodeWithSignature("swapBuy(address,address,uint256,uint160)", address(0), o.trader, rem, lim)
                    : abi.encodeWithSignature("swapSell(address,address,uint256,uint160)", address(0), o.trader, rem, lim)
                );
            } else {
                // Dust: return the unspent amount to the trader.
                _callback(o.chainId, _desk(o.chainId), GAS_PULL_PAY, abi.encodeWithSignature(
                    "pay(address,uint256,address,bool,uint256)", address(0), o.deskOrderId, o.trader, o.isBuy, rem
                ));
                emit Refunded(o.trader, o.chainId, rem);
            }
        }

        // Close each order on its desk so a later refund cannot pay these funds twice.
        for (uint256 k = 0; k < n; k++) {
            _callback(os[k].chainId, _desk(os[k].chainId), GAS_PULL_PAY, abi.encodeWithSignature(
                "closeOrder(address,uint256)", address(0), os[k].deskOrderId
            ));
        }

        emit Settled(p, prs.length);
        _finishRound();
    }

    /// @dev All pulls reported, or the timeout passed. Failed orders are refunded and dropped alone. The rest
    ///      are re-matched at the same price and settle in this round. Their money is already in the desks.
    function _resolvePulls() internal {
        if (!anyPullFailed) {
            _settle();
            return;
        }
        uint256 total = eligible.length;
        uint32[] memory keep = new uint32[](total);
        uint256 n;
        for (uint256 k = 0; k < total; k++) {
            uint256 id = eligible[k];
            if (pullOk[id]) {
                keep[n++] = uint32(id);
                continue;
            }
            // Failed, or the report never arrived. Freeze the order on the desk, so a late pull cannot
            // strand funds. The desk refunds whatever it actually collected.
            Order storage o = orders[id];
            _callback(o.chainId, _desk(o.chainId), GAS_PULL_PAY, abi.encodeWithSignature(
                "refundOrder(address,uint256,bool)", address(0), o.deskOrderId, true
            ));
            emit Unwound(id);
            _closeOrder(id, "pull failed");
        }
        delete eligible;
        for (uint256 i = 0; i < n; i++) eligible.push(keep[i]);
        _settle();
    }

    function _finishRound() internal {
        // Settled orders leave the book. Failed ones were closed already. One pass fixes the FIFO list.
        for (uint256 k = 0; k < eligible.length; k++) {
            _closeOrder(eligible[k], "settled");
        }
        _compactBook();
        pulling = false;
        delete eligible;
        anyPullFailed = false;
        pendingPulls = 0;
        if (openIds.length == 0) {
            openPrice = 0;
            if (cronOn) {
                SYSTEM.unsubscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
                cronOn = false;
            }
        } else if (haveObservation) {
            // Orders carry on. The next window is measured from the latest price.
            openPrice = _price(lastSqrtPriceX96);
            emit RoundOpened(openPrice);
        }
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Drop every order older than ORDER_TTL in one pass. Returns whether any left. The desk is not told, because
    ///      the referee simply forgets the order and a trader can still cancel it on the desk.
    function _expireStale() internal returns (bool any) {
        uint256 len = openIds.length;
        for (uint256 k = 0; k < len; k++) {
            uint256 id = openIds[k];
            if (block.timestamp > uint256(placedAt[id]) + ORDER_TTL) {
                _closeOrder(id, "expired");
                any = true;
            }
        }
        if (any) _compactBook();
    }

    /// @dev Remove one order and keep the FIFO list tight.
    function _drop(uint256 id, string memory reason) internal {
        if (!orders[id].open) return;
        _closeOrder(id, reason);
        _compactBook();
    }

    /// @dev Mark an order closed and release its funding watch. The FIFO list is fixed by _compactBook.
    function _closeOrder(uint256 id, string memory reason) internal {
        Order storage o = orders[id];
        if (!o.open) return;
        o.open = false;
        ChainConfig memory c = _chainFor(o.chainId);
        _unsubscribeTransfer(o.chainId, o.isBuy ? c.usdc : c.weth, o.trader);
        // bookIdOf is left as is. Every reader checks orders[id].open, and desk order ids never repeat.
        emit OrderDropped(id, reason);
    }

    /// @dev Rebuild the FIFO list from the orders that are still open, in one pass. Writes only what changed.
    function _compactBook() internal {
        uint256 len = openIds.length;
        uint256 kept;
        for (uint256 k = 0; k < len; k++) {
            uint256 id = openIds[k];
            if (orders[id].open) {
                if (kept != k) openIds[kept] = id;
                kept++;
            }
        }
        for (uint256 k = len; k > kept; k--) openIds.pop();
    }

    /// @dev Subscribe and unsubscribe share one helper per topic set, so the arguments always match.
    function _subscribeTransfer(uint256 chainId, address token, address trader) internal {
        SYSTEM.subscribe(chainId, token, uint256(T_TRANSFER), uint256(uint160(trader)), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _unsubscribeTransfer(uint256 chainId, address token, address trader) internal {
        SYSTEM.unsubscribe(chainId, token, uint256(T_TRANSFER), uint256(uint160(trader)), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _callback(uint256 chainId, address target, uint64 gasLimit, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({chainId: chainId, recipient: target, gasLimit: gasLimit, payload: payload})
        );
    }

    function _desk(uint256 chainId) internal view returns (address) {
        return chainId == chainA.chainId ? chainA.desk : chainB.desk;
    }

    function _chainFor(uint256 chainId) internal view returns (ChainConfig memory) {
        if (!configured) revert NotConfigured();
        if (chainId == chainA.chainId) return chainA;
        if (chainId == chainB.chainId) return chainB;
        revert UnknownChain();
    }

    /// @dev USDC micro-units per 1 WETH from the pool's sqrt price. currency0 is USDC.
    function _price(uint160 sqrtPriceX96) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0 || sqrtPriceX96 >= 2 ** 128) revert BadPrice();
        uint256 sq = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        return (uint256(1e18) << 192) / sq;
    }

    /// @dev Pool sqrt price bound for a trader's remainder swap. A buyer swap pushes the price up, so the limit is a
    ///      floor on sqrtP. A seller swap pushes it down, so the limit is a ceiling. The pool fee is taken out of the
    ///      limit first, so the all-in price stays inside it. The buyer rounds sqrtP up and the seller rounds it
    ///      down, so the bound never leaks past the limit.
    function _sqrtLimit(bool isBuy, uint256 limit) internal pure returns (uint160) {
        uint256 cap = isBuy
            ? (limit * (1e6 - POOL_FEE_PPM)) / 1e6
            : (limit * 1e6 + (1e6 - POOL_FEE_PPM) - 1) / (1e6 - POOL_FEE_PPM);
        if (cap == 0) cap = 1;
        uint256 x = (uint256(1e18) << 192) / cap;
        uint256 r = _sqrt(x); // floor
        if (isBuy && r * r < x) r += 1;
        if (r >= 2 ** 160) r = 2 ** 160 - 1;
        return uint160(r);
    }

    /// @dev Integer square root, floor. Starts near the answer from the bit length, then 7 Newton steps.
    function _sqrt(uint256 a) internal pure returns (uint256) {
        if (a <= 1) return a;
        uint256 aa = a;
        uint256 xn = 1;
        if (aa >= (1 << 128)) { aa >>= 128; xn <<= 64; }
        if (aa >= (1 << 64)) { aa >>= 64; xn <<= 32; }
        if (aa >= (1 << 32)) { aa >>= 32; xn <<= 16; }
        if (aa >= (1 << 16)) { aa >>= 16; xn <<= 8; }
        if (aa >= (1 << 8)) { aa >>= 8; xn <<= 4; }
        if (aa >= (1 << 4)) { aa >>= 4; xn <<= 2; }
        if (aa >= (1 << 2)) { xn <<= 1; }
        xn = (3 * xn) >> 1;
        xn = (xn + a / xn) >> 1;
        xn = (xn + a / xn) >> 1;
        xn = (xn + a / xn) >> 1;
        xn = (xn + a / xn) >> 1;
        xn = (xn + a / xn) >> 1;
        xn = (xn + a / xn) >> 1;
        xn = (xn + a / xn) >> 1;
        return xn - (xn > a / xn ? 1 : 0);
    }

    function _floorMul(uint256 wei_, uint256 price) internal pure returns (uint256) {
        return (wei_ * price) / 1e18;
    }

    function _ceilMul(uint256 wei_, uint256 price) internal pure returns (uint256) {
        return (wei_ * price + 1e18 - 1) / 1e18;
    }
}
