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
    uint256 public constant MAX_BOOK = 24;
    uint256 public constant PULL_TIMEOUT = 300; // seconds a round may wait for its pull callbacks
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
    bytes32 public constant T_SWAPPED = keccak256("Swapped(address,bool,uint256,uint256,bool)");

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

    struct Order {
        uint256 chainId;
        address desk;
        uint256 deskOrderId;
        address trader;
        bool isBuy;
        uint256 limit; // USDC micro-units per 1 WETH, the trader's protection
        uint256 qty; // WETH wei
        bool open;
    }

    struct Pair {
        uint256 buyer; // book id
        uint256 seller; // book id
        uint256 amount; // WETH wei
    }

    mapping(uint256 => Order) public orders;
    mapping(bytes32 => uint256) public bookIdOf; // keccak(chainId, deskOrderId) => book id
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
    uint256[] internal eligible;
    Pair[] internal pairs;
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
            chainId: log.chainId,
            desk: c.desk,
            deskOrderId: deskOrderId,
            trader: trader,
            isBuy: isBuy,
            limit: limit,
            qty: qty,
            open: true
        });
        bookIdOf[keccak256(abi.encode(log.chainId, deskOrderId))] = id;
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
        if (pendingPulls == 0) {
            if (anyPullFailed) _unwind();
            else _settle();
        }
    }

    function _onSwap(LogRecord calldata log) internal {
        if (log.contractAddress != poolManagerB || log.topic1 != uint256(poolIdB)) return;
        (, , uint160 sqrtPriceX96, , , ) = abi.decode(log.data, (int128, int128, uint160, uint128, int24, uint24));
        haveObservation = true;
        lastSqrtPriceX96 = sqrtPriceX96;
        emit Observed(sqrtPriceX96, _price(sqrtPriceX96));
    }

    /// @dev A desk swap that reports ok = false leaves the amount in the desk. Return it to the trader.
    function _onSwapped(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chainId);
        if (log.contractAddress != c.desk) return;
        address to = address(uint160(log.topic1));
        (bool sellWeth, uint256 amountIn, , bool ok) = abi.decode(log.data, (bool, uint256, uint256, bool));
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
        if (pendingPulls == 0) {
            if (anyPullFailed) _unwind();
            else _settle();
        }
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
            emit BellVoid("drift guard: round skipped, orders carry");
            return;
        }

        _clear(p);
    }

    /// @dev Match at price p, then start step 1 (pulls). Orders outside their protection carry over.
    function _clear(uint256 p) internal {
        delete eligible;
        delete pairs;

        uint256[] memory buyers = new uint256[](openIds.length);
        uint256[] memory sellers = new uint256[](openIds.length);
        uint256 nb;
        uint256 ns;
        for (uint256 k = 0; k < openIds.length; k++) {
            uint256 id = openIds[k];
            Order storage o = orders[id];
            if (o.isBuy && o.limit >= p) {
                buyers[nb++] = id;
                eligible.push(id);
            } else if (!o.isBuy && o.limit <= p) {
                sellers[ns++] = id;
                eligible.push(id);
            }
        }
        if (eligible.length == 0) return;

        // Two-pointer FIFO match. Remaining quantities tracked in memory.
        uint256[] memory remB = new uint256[](nb);
        uint256[] memory remS = new uint256[](ns);
        for (uint256 i = 0; i < nb; i++) remB[i] = orders[buyers[i]].qty;
        for (uint256 j = 0; j < ns; j++) remS[j] = orders[sellers[j]].qty;
        uint256 bi;
        uint256 sj;
        while (bi < nb && sj < ns) {
            uint256 take = remB[bi] < remS[sj] ? remB[bi] : remS[sj];
            if (take > 0) pairs.push(Pair({buyer: buyers[bi], seller: sellers[sj], amount: take}));
            remB[bi] -= take;
            remS[sj] -= take;
            if (remB[bi] == 0) bi++;
            if (remS[sj] == 0) sj++;
        }

        // Step 1: pull from every eligible trader. Buyers pull the full cost at p (rounded up).
        settlePrice = p;
        roundId++;
        pullStartedAt = block.timestamp;
        pulling = true;
        pendingPulls = eligible.length;
        anyPullFailed = false;
        for (uint256 k = 0; k < eligible.length; k++) {
            uint256 id = eligible[k];
            Order storage o = orders[id];
            uint256 amount = o.isBuy ? _ceilMul(o.qty, p) : o.qty;
            _callback(o.chainId, o.desk, GAS_PULL_PAY, abi.encodeWithSignature(
                "collect(address,uint256,address,bool,uint256)", address(0), o.deskOrderId, o.trader, o.isBuy, amount
            ));
        }
        emit BellRang(p, eligible.length, pairs.length);
    }

    /// @dev Step 2: pay counterparties on the other chain, then sell each remainder into the pool.
    function _settle() internal {
        uint256 p = settlePrice;
        // Payments tracked by index into `eligible`, which holds at most MAX_BOOK orders.
        uint256[] memory paidU = new uint256[](eligible.length);
        uint256[] memory paidW = new uint256[](eligible.length);

        for (uint256 i = 0; i < pairs.length; i++) {
            Pair memory pr = pairs[i];
            Order storage b = orders[pr.buyer];
            Order storage s = orders[pr.seller];
            uint256 usdcOut = _floorMul(pr.amount, p);
            if (usdcOut > 0) {
                // Seller is paid USDC on the buyer's chain, from the buyer's pull.
                _callback(b.chainId, b.desk, GAS_PULL_PAY, abi.encodeWithSignature(
                    "pay(address,uint256,address,bool,uint256)", address(0), s.deskOrderId, s.trader, true, usdcOut
                ));
            }
            // Buyer is paid WETH on the seller's chain, from the seller's pull.
            _callback(s.chainId, s.desk, GAS_PULL_PAY, abi.encodeWithSignature(
                "pay(address,uint256,address,bool,uint256)", address(0), b.deskOrderId, b.trader, false, pr.amount
            ));
            paidU[_indexOf(pr.buyer)] += usdcOut;
            paidW[_indexOf(pr.seller)] += pr.amount;
        }

        // Remainders: buyers' unspent USDC goes into the pool for WETH, sellers' unsold WETH goes in for USDC.
        for (uint256 k = 0; k < eligible.length; k++) {
            uint256 id = eligible[k];
            Order storage o = orders[id];
            uint256 rem = o.isBuy ? pulled[id] - paidU[k] : pulled[id] - paidW[k];
            if (rem == 0) continue;
            bool canSwap = o.chainId == chainB.chainId && rem >= (o.isBuy ? DUST_USDC : DUST_WETH);
            if (canSwap) {
                // The reference pool lives on chain B only, so only chain B remainders are sold into it.
                _callback(o.chainId, o.desk, GAS_SWAP, o.isBuy
                    ? abi.encodeWithSignature("swapBuy(address,address,uint256)", address(0), o.trader, rem)
                    : abi.encodeWithSignature("swapSell(address,address,uint256)", address(0), o.trader, rem)
                );
            } else {
                // No pool on this chain, or dust: return the unspent amount to the trader.
                _callback(o.chainId, o.desk, GAS_PULL_PAY, abi.encodeWithSignature(
                    "pay(address,uint256,address,bool,uint256)", address(0), o.deskOrderId, o.trader, o.isBuy, rem
                ));
                emit Refunded(o.trader, o.chainId, rem);
            }
        }

        emit Settled(p, pairs.length);
        _finishRound(false);
    }

    /// @dev Some pull failed. Return every amount that was collected, drop the failed orders, keep the rest.
    function _unwind() internal {
        for (uint256 k = 0; k < eligible.length; k++) {
            uint256 id = eligible[k];
            Order storage o = orders[id];
            if (pullOk[id] && pulled[id] > 0) {
                _callback(o.chainId, o.desk, GAS_PULL_PAY, abi.encodeWithSignature(
                    "pay(address,uint256,address,bool,uint256)", address(0), o.deskOrderId, o.trader, o.isBuy, pulled[id]
                ));
            } else {
                emit Unwound(id);
                _drop(id, "pull failed");
            }
        }
        _finishRound(true);
    }

    function _finishRound(bool unwound) internal {
        // Settled orders leave the book. After an unwind, failed ones were already dropped.
        if (!unwound) {
            for (uint256 k = 0; k < eligible.length; k++) {
                _drop(eligible[k], "settled");
            }
        }
        pulling = false;
        delete eligible;
        delete pairs;
        anyPullFailed = false;
        pendingPulls = 0;
        if (openIds.length == 0) {
            openPrice = 0;
            if (cronOn) {
                SYSTEM.unsubscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
                cronOn = false;
            }
        }
    }

    // ---------------------------------------------------------------- helpers

    function _drop(uint256 id, string memory reason) internal {
        Order storage o = orders[id];
        if (!o.open) return;
        o.open = false;
        ChainConfig memory c = _chainFor(o.chainId);
        _unsubscribeTransfer(o.chainId, o.isBuy ? c.usdc : c.weth, o.trader);
        bookIdOf[keccak256(abi.encode(o.chainId, o.deskOrderId))] = 0;
        for (uint256 k = 0; k < openIds.length; k++) {
            if (openIds[k] == id) {
                for (uint256 m = k; m + 1 < openIds.length; m++) openIds[m] = openIds[m + 1];
                openIds.pop();
                break;
            }
        }
        emit OrderDropped(id, reason);
    }

    /// @dev Subscribe and unsubscribe share one helper per topic set, so the arguments always match.
    function _subscribeTransfer(uint256 chainId, address token, address trader) internal {
        SYSTEM.subscribe(chainId, token, uint256(T_TRANSFER), uint256(uint160(trader)), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _unsubscribeTransfer(uint256 chainId, address token, address trader) internal {
        SYSTEM.unsubscribe(chainId, token, uint256(T_TRANSFER), uint256(uint160(trader)), REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    function _indexOf(uint256 id) internal view returns (uint256) {
        for (uint256 k = 0; k < eligible.length; k++) {
            if (eligible[k] == id) return k;
        }
        revert UnknownChain();
    }

    function _callback(uint256 chainId, address target, uint64 gasLimit, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({chainId: chainId, recipient: target, gasLimit: gasLimit, payload: payload})
        );
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

    function _floorMul(uint256 wei_, uint256 price) internal pure returns (uint256) {
        return (wei_ * price) / 1e18;
    }

    function _ceilMul(uint256 wei_, uint256 price) internal pure returns (uint256) {
        return (wei_ * price + 1e18 - 1) / 1e18;
    }
}
