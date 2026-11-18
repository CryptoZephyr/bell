// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title BellDesk
/// @notice One desk per chain. Holds trader orders and moves money only when the
///         Reactive callback proxy calls on behalf of the single BellReferee.
/// @dev Callbacks are guarded by onlyServiceProvider (the proxy) and onlyCallbackSender
///      (the referee's address, fixed at deployment). Placing an order moves no funds.
contract BellDesk is AbstractCallback, IUnlockCallback {
    using CurrencyLibrary for Currency;

    struct Order {
        address trader;
        bool isBuy;
        uint256 price; // USDC micro-units per 1 WETH
        uint256 qty; // WETH wei for both sides
    }

    /// @dev Fallback pool: USDC/WETH, 0.05%, no hooks. Tick spacing is set per chain (10 on Unichain, the reference pool).
    uint24 public constant POOL_FEE = 500;
    int24 public immutable poolTickSpacing;

    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    IPoolManager public immutable poolManager;
    PoolKey public poolKey;

    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    // Per-order accounting kept on the desk, so the referee can refund what a desk really collected
    // even when the referee never heard about the pull (a lost event).
    mapping(uint256 => uint256) public collectedOf; // total pulled for the order
    mapping(uint256 => uint256) public closedOf; // amount already settled or refunded
    mapping(uint256 => bool) public frozen; // no further pulls for this order

    event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBuy, uint256 price, uint256 qty);
    event Collected(uint256 indexed orderId, address indexed from, uint256 amount, bool ok);
    event Paid(uint256 indexed orderId, address indexed to, uint256 amount, bool ok);
    event Swapped(
        address indexed to,
        bool sellWeth,
        uint256 amountIn,
        uint256 amountUsed,
        uint256 amountOut,
        uint256 refunded,
        bool ok
    );
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    event Closed(uint256 indexed orderId, uint256 amount);
    event Refunded(uint256 indexed orderId, address indexed to, uint256 amount, bool ok);

    error ZeroAddress();
    error ZeroAmount();
    error NotPoolManager();
    error OrderTraderMismatch();
    error CurrencyNotSorted();
    error NotOrderTrader();
    error AlreadyFrozen();

    /// @param callbackProxy_ The Reactive callback proxy on this chain.
    /// @param referee_ The referee's RVM id (the reactive contract's address on Lasna).
    constructor(IPayable callbackProxy_, address referee_, address usdc_, address weth_, address poolManager_, int24 tickSpacing_)
        payable
        AbstractCallback(callbackProxy_, referee_)
    {
        if (tickSpacing_ <= 0) revert ZeroAmount();
        poolTickSpacing = tickSpacing_;
        if (referee_ == address(0) || usdc_ == address(0) || weth_ == address(0) || poolManager_ == address(0)) {
            revert ZeroAddress();
        }
        // The pool key needs USDC as currency0. Both testnet USDC addresses sort below WETH.
        if (uint160(usdc_) >= uint160(weth_)) revert CurrencyNotSorted();
        usdc = IERC20(usdc_);
        weth = IERC20(weth_);
        poolManager = IPoolManager(poolManager_);
        poolKey = PoolKey({
            currency0: Currency.wrap(usdc_),
            currency1: Currency.wrap(weth_),
            fee: POOL_FEE,
            tickSpacing: tickSpacing_,
            hooks: IHooks(address(0))
        });
    }

    /// @notice Record an order. No funds move. The trader must approve this desk
    ///         for USDC (buy) or WETH (sell) before the bell, or the order drops at collect.
    function place(bool isBuy, uint256 price, uint256 qty) external returns (uint256 orderId) {
        if (price == 0 || qty == 0) revert ZeroAmount();
        orderId = nextOrderId++;
        orders[orderId] = Order({trader: msg.sender, isBuy: isBuy, price: price, qty: qty});
        emit OrderPlaced(orderId, msg.sender, isBuy, price, qty);
    }

    /// @notice Cancel an order before the desk pulls its funds. Only the order's trader can cancel.
    ///         The order is frozen, so a pull that arrives later fails with ok = false. A cancel that lands
    ///         after the pull is too late, and the trade goes through.
    function cancel(uint256 orderId) external {
        Order storage o = orders[orderId];
        if (o.trader != msg.sender) revert NotOrderTrader();
        if (frozen[orderId]) revert AlreadyFrozen();
        frozen[orderId] = true;
        emit OrderCancelled(orderId, msg.sender);
    }

    /// @notice Pull a trader's funds into the desk. Buyers pay USDC, sellers pay WETH.
    ///         A failed pull never reverts. It emits ok = false so the referee can unwind.
    function collect(address rvmId, uint256 orderId, address trader, bool isBuy, uint256 amount)
        external
        onlyServiceProvider
        onlyCallbackSender(rvmId)
        returns (bool ok)
    {
        if (amount == 0) revert ZeroAmount();
        Order storage o = orders[orderId];
        if (o.trader != trader || o.isBuy != isBuy) revert OrderTraderMismatch();
        if (frozen[orderId]) {
            emit Collected(orderId, trader, amount, false);
            return false;
        }
        IERC20 token = isBuy ? usdc : weth;
        ok = _call(address(token), abi.encodeCall(IERC20.transferFrom, (trader, address(this), amount)));
        if (ok) collectedOf[orderId] += amount;
        emit Collected(orderId, trader, amount, ok);
    }

    /// @notice Mark everything collected for this order as accounted for. The referee calls this after
    ///         settling an order, so a later refund cannot pay the same funds twice.
    function closeOrder(address rvmId, uint256 orderId)
        external
        onlyServiceProvider
        onlyCallbackSender(rvmId)
    {
        closedOf[orderId] = collectedOf[orderId];
        frozen[orderId] = true; // a settled order can never be pulled again
        emit Closed(orderId, collectedOf[orderId]);
    }

    /// @notice Return what this desk collected for the order and not yet accounted for. With freeze = true
    ///         the order can no longer be pulled, so a late callback cannot strand funds again.
    function refundOrder(address rvmId, uint256 orderId, bool freeze)
        external
        onlyServiceProvider
        onlyCallbackSender(rvmId)
        returns (uint256 amount)
    {
        Order storage o = orders[orderId];
        if (freeze) frozen[orderId] = true;
        amount = collectedOf[orderId] - closedOf[orderId];
        closedOf[orderId] = collectedOf[orderId];
        if (amount == 0) return 0;
        IERC20 token = o.isBuy ? usdc : weth;
        bool ok = _call(address(token), abi.encodeCall(IERC20.transfer, (o.trader, amount)));
        emit Refunded(orderId, o.trader, amount, ok);
    }

    /// @notice Send funds from the desk's pot to a counterparty on this chain.
    ///         A failed transfer never reverts. It emits ok = false.
    function pay(address rvmId, uint256 orderId, address to, bool payUsdc, uint256 amount)
        external
        onlyServiceProvider
        onlyCallbackSender(rvmId)
        returns (bool ok)
    {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        IERC20 token = payUsdc ? usdc : weth;
        ok = _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
        emit Paid(orderId, to, amount, ok);
    }

    /// @notice Sell WETH from the desk's pot into the real Uniswap v4 pool. USDC proceeds go to `to`.
    ///         Used for a seller's unmatched remainder. The swap stops at `sqrtPriceLimitX96`, and any WETH the
    ///         pool did not take inside that limit goes back to `to`. A failed swap never reverts. It emits ok = false.
    function swapSell(address rvmId, address to, uint256 amountWeth, uint160 sqrtPriceLimitX96)
        external
        onlyServiceProvider
        onlyCallbackSender(rvmId)
        returns (bool ok, uint256 amountOut)
    {
        return _swap(to, false, amountWeth, sqrtPriceLimitX96);
    }

    /// @notice Sell USDC from the desk's pot into the real Uniswap v4 pool for WETH to `to`.
    ///         Used for a buyer's unmatched remainder. The swap stops at `sqrtPriceLimitX96`, and any USDC the
    ///         pool did not take inside that limit goes back to `to`. A failed swap never reverts. It emits ok = false.
    function swapBuy(address rvmId, address to, uint256 amountUsdc, uint160 sqrtPriceLimitX96)
        external
        onlyServiceProvider
        onlyCallbackSender(rvmId)
        returns (bool ok, uint256 amountOut)
    {
        return _swap(to, true, amountUsdc, sqrtPriceLimitX96);
    }

    /// @dev Pool swaps run inside PoolManager.unlock. The desk settles what it owes and takes what it is owed.
    ///      The limit is clamped inside the pool bounds. If the pool price is already past the limit, Uniswap
    ///      reverts, the try/catch turns that into ok = false, and the referee refunds the full amount.
    function _swap(address to, bool zeroForOne, uint256 amountIn, uint160 limit)
        internal
        returns (bool ok, uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (zeroForOne && limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        if (!zeroForOne && (limit == 0 || limit >= TickMath.MAX_SQRT_PRICE)) limit = TickMath.MAX_SQRT_PRICE - 1;
        uint256 used;
        try poolManager.unlock(abi.encode(to, zeroForOne, amountIn, limit)) returns (bytes memory res) {
            (amountOut, used) = abi.decode(res, (uint256, uint256));
            ok = true;
        } catch {
            ok = false;
        }
        uint256 refunded;
        if (ok && used < amountIn) {
            uint256 back = amountIn - used;
            // Report the refund only when the transfer worked, so the event never claims funds that are still here.
            if (_call(address(zeroForOne ? usdc : weth), abi.encodeCall(IERC20.transfer, (to, back)))) {
                refunded = back;
            }
        }
        emit Swapped(to, !zeroForOne, amountIn, used, amountOut, refunded, ok);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (address to, bool zeroForOne, uint256 amountIn, uint160 limit) =
            abi.decode(data, (address, bool, uint256, uint160));

        SwapParams memory params = SwapParams({
            zeroForOne: zeroForOne,
            // Negative means exact input.
            amountSpecified: -int256(amountIn),
            sqrtPriceLimitX96: limit
        });
        BalanceDelta delta = poolManager.swap(poolKey, params, "");

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        Currency inCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
        Currency outCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
        uint256 owed = uint256(uint128(-(zeroForOne ? d0 : d1)));
        uint256 received = uint256(uint128(zeroForOne ? d1 : d0));

        // Settle the input side: sync, transfer into the pool, then settle.
        poolManager.sync(inCurrency);
        IERC20(Currency.unwrap(inCurrency)).transfer(address(poolManager), owed);
        poolManager.settle();

        // Take the output side straight to the recipient.
        if (received > 0) poolManager.take(outCurrency, to, received);

        return abi.encode(received, owed);
    }

    /// @dev Low-level token call that tolerates tokens which return nothing or false.
    function _call(address token, bytes memory data) internal returns (bool) {
        (bool success, bytes memory ret) = token.call(data);
        if (!success) return false;
        if (ret.length == 0) return true;
        return ret.length == 32 && abi.decode(ret, (bool));
    }
}
