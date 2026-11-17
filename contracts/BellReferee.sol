// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Reactive system contract interface (subscriptions). Verify against reactive-lib-omni before deploy.
interface ISystemContract {
    function subscribe(
        uint256 chain_id,
        address _contract,
        uint256 topic_0,
        uint256 topic_1,
        uint256 topic_2,
        uint256 topic_3
    ) external;

    function unsubscribe(
        uint256 chain_id,
        address _contract,
        uint256 topic_0,
        uint256 topic_1,
        uint256 topic_2,
        uint256 topic_3
    ) external;
}

/// @dev Log record delivered to react(). Verify field order against reactive-lib-omni before deploy.
struct LogRecord {
    uint256 chain_id;
    address _contract;
    uint256 topic_0;
    uint256 topic_1;
    uint256 topic_2;
    uint256 topic_3;
    bytes data;
    uint256 block_number;
    uint256 op_code;
    uint256 block_hash;
    uint256 tx_hash;
    uint256 log_index;
}

/// @title BellReferee
/// @notice The single Reactive contract on Lasna. It keeps one book across both desks,
///         rings the bell on timer events, prices the round from the reference pool,
///         and runs two-step settlement through desk callbacks.
/// @dev Guard: round-drift guard. Skip the round if the reference price at the bell differs
///      from the price when the round opened by more than DRIFT_BPS.
contract BellReferee {
    // ---------------------------------------------------------------- constants

    uint64 public constant GAS_PULL_PAY = 400_000;
    uint64 public constant GAS_SWAP = 900_000;
    uint256 public constant DRIFT_BPS = 1000; // 10%
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BOOK = 24;

    /// @dev Lasna timer: Cron100 ticks about every two minutes.
    address public constant CRON_CONTRACT = 0x0000000000000000000000000000000000fffFfF;
    uint256 public constant CRON_TOPIC = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;
    uint256 public constant LASNA_CHAIN_ID = 5318007;

    bytes32 public constant T_ORDER_PLACED = keccak256("OrderPlaced(uint256,address,bool,uint256,uint256)");
    bytes32 public constant T_COLLECTED = keccak256("Collected(uint256,address,uint256,bool)");
    bytes32 public constant T_TRANSFER = keccak256("Transfer(address,address,uint256)");
    bytes32 public constant T_SWAP = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

    // ---------------------------------------------------------------- config

    struct ChainConfig {
        uint256 chainId;
        address desk;
        address usdc;
        address weth;
    }

    ISystemContract public immutable system;
    address public immutable deployer;
    ChainConfig public chainA; // Base Sepolia
    ChainConfig public chainB; // Unichain Sepolia, hosts the reference pool
    address public immutable poolManagerB;
    bytes32 public immutable poolIdB;

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

    uint256[] internal eligible;
    Pair[] internal pairs;
    mapping(uint256 => uint256) internal pulled; // book id => amount collected
    mapping(uint256 => bool) internal pullOk;
    uint256 internal pendingPulls;
    bool internal anyPullFailed;

    // ---------------------------------------------------------------- events

    /// @dev Reactive callback event. The proxy replaces the first payload argument with this contract's RVM id.
    event Callback(uint256 indexed chain_id, address indexed _contract, uint64 indexed gas_limit, bytes payload);

    event OrderAdded(uint256 indexed bookId, uint256 chainId, uint256 deskOrderId, address trader, bool isBuy);
    event OrderDropped(uint256 indexed bookId, string reason);
    event Observed(uint160 sqrtPriceX96, uint256 price);
    event RoundOpened(uint256 price);
    event BellVoid(string reason);
    event BellRang(uint256 price, uint256 eligibleCount, uint256 pairCount);
    event Unwound(uint256 failedBookId);
    event Settled(uint256 price, uint256 pairCount);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------- errors

    error NotSystem();
    error NotDeployer();
    error ZeroAddress();
    error UnknownChain();
    error BadPrice();
    error WithdrawFailed();

    // ---------------------------------------------------------------- setup

    struct Config {
        address system;
        ChainConfig chainA;
        ChainConfig chainB;
        address poolManagerB;
        bytes32 poolIdB;
    }

    constructor(Config memory c) {
        if (c.system == address(0) || c.chainA.desk == address(0) || c.chainB.desk == address(0)) {
            revert ZeroAddress();
        }
        system = ISystemContract(c.system);
        deployer = msg.sender;
        chainA = c.chainA;
        chainB = c.chainB;
        poolManagerB = c.poolManagerB;
        poolIdB = c.poolIdB;

        // Desk events on both chains, and reference pool swaps on chain B.
        system.subscribe(c.chainA.chainId, c.chainA.desk, uint256(T_ORDER_PLACED), 0, 0, 0);
        system.subscribe(c.chainA.chainId, c.chainA.desk, uint256(T_COLLECTED), 0, 0, 0);
        system.subscribe(c.chainB.chainId, c.chainB.desk, uint256(T_ORDER_PLACED), 0, 0, 0);
        system.subscribe(c.chainB.chainId, c.chainB.desk, uint256(T_COLLECTED), 0, 0, 0);
        system.subscribe(c.chainB.chainId, c.poolManagerB, uint256(T_SWAP), uint256(c.poolIdB), 0, 0);
    }

    receive() external payable {}

    modifier onlySystem() {
        if (msg.sender != address(system)) revert NotSystem();
        _;
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
        if (log._contract == CRON_CONTRACT && log.topic_0 == CRON_TOPIC) {
            _bell();
            return;
        }
        bytes32 t0 = bytes32(log.topic_0);
        if (t0 == T_ORDER_PLACED) {
            _onOrderPlaced(log);
        } else if (t0 == T_COLLECTED) {
            _onCollected(log);
        } else if (t0 == T_SWAP) {
            _onSwap(log);
        } else if (t0 == T_TRANSFER) {
            _onTransfer(log);
        }
    }

    // ---------------------------------------------------------------- book

    function _onOrderPlaced(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chain_id);
        if (log._contract != c.desk) return;
        (bool isBuy, uint256 limit, uint256 qty) = abi.decode(log.data, (bool, uint256, uint256));
        uint256 deskOrderId = log.topic_1;
        address trader = address(uint160(log.topic_2));

        if (openIds.length >= MAX_BOOK) {
            emit OrderDropped(0, "book full");
            return;
        }
        if (openIds.length == 0) {
            // The round opens with its first order. Anchor the drift guard to the latest price.
            openPrice = haveObservation ? _price(lastSqrtPriceX96) : 0;
            emit RoundOpened(openPrice);
            if (!cronOn) {
                system.subscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, 0, 0, 0);
                cronOn = true;
            }
        }

        uint256 id = nextBookId++;
        orders[id] = Order({
            chainId: log.chain_id,
            desk: c.desk,
            deskOrderId: deskOrderId,
            trader: trader,
            isBuy: isBuy,
            limit: limit,
            qty: qty,
            open: true
        });
        bookIdOf[keccak256(abi.encode(log.chain_id, deskOrderId))] = id;
        openIds.push(id);

        // Funding watch: hear the trader's token transfers while the order is open.
        address token = isBuy ? c.usdc : c.weth;
        system.subscribe(log.chain_id, token, uint256(T_TRANSFER), uint256(uint160(trader)), 0, 0);
        emit OrderAdded(id, log.chain_id, deskOrderId, trader, isBuy);
    }

    function _onTransfer(LogRecord calldata log) internal {
        if (pulling) return; // our own pulls show up as transfers during settlement
        address from = address(uint160(log.topic_1));
        ChainConfig memory c = _chainFor(log.chain_id);
        uint256 k = 0;
        while (k < openIds.length) {
            uint256 id = openIds[k];
            Order storage o = orders[id];
            address token = o.isBuy ? c.usdc : c.weth;
            if (o.chainId == log.chain_id && o.trader == from && log._contract == token) {
                _drop(id, "funds moved"); // shifts openIds, so do not advance k
            } else {
                k++;
            }
        }
    }

    function _onCollected(LogRecord calldata log) internal {
        ChainConfig memory c = _chainFor(log.chain_id);
        if (log._contract != c.desk || !pulling) return;
        uint256 id = bookIdOf[keccak256(abi.encode(log.chain_id, log.topic_1))];
        if (id == 0 || !orders[id].open) return;
        (uint256 amount, bool ok) = abi.decode(log.data, (uint256, bool));
        if (pullOk[id] || pulled[id] != 0) return; // duplicate event
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
        if (log._contract != poolManagerB || log.topic_1 != uint256(poolIdB)) return;
        (, , uint160 sqrtPriceX96, , , ) = abi.decode(log.data, (int128, int128, uint160, uint128, int24, uint24));
        haveObservation = true;
        lastSqrtPriceX96 = sqrtPriceX96;
        emit Observed(sqrtPriceX96, _price(sqrtPriceX96));
    }

    // ---------------------------------------------------------------- bell

    function _bell() internal {
        if (openIds.length == 0) {
            if (cronOn) {
                system.unsubscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, 0, 0, 0);
                cronOn = false;
            }
            return;
        }
        if (pulling) {
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
            if (o.isBuy) {
                uint256 rem = pulled[id] - paidU[k];
                if (rem > 0) {
                    _callback(o.chainId, o.desk, GAS_SWAP, abi.encodeWithSignature(
                        "swapBuy(address,address,uint256)", address(0), o.trader, rem
                    ));
                }
            } else {
                uint256 rem = pulled[id] - paidW[k];
                if (rem > 0) {
                    _callback(o.chainId, o.desk, GAS_SWAP, abi.encodeWithSignature(
                        "swapSell(address,address,uint256)", address(0), o.trader, rem
                    ));
                }
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
                system.unsubscribe(LASNA_CHAIN_ID, CRON_CONTRACT, CRON_TOPIC, 0, 0, 0);
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
        address token = o.isBuy ? c.usdc : c.weth;
        system.unsubscribe(o.chainId, token, uint256(T_TRANSFER), uint256(uint160(o.trader)), 0, 0);
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

    function _indexOf(uint256 id) internal view returns (uint256) {
        for (uint256 k = 0; k < eligible.length; k++) {
            if (eligible[k] == id) return k;
        }
        revert UnknownChain();
    }

    function _callback(uint256 chainId, address target, uint64 gasLimit, bytes memory payload) internal {
        emit Callback(chainId, target, gasLimit, payload);
    }

    function _chainFor(uint256 chainId) internal view returns (ChainConfig memory) {
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
