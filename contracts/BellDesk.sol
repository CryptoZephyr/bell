// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title BellDesk
/// @notice One desk per chain. Holds trader orders and moves money only when the
///         Reactive callback proxy calls on behalf of the single BellReferee.
/// @dev Placing an order moves no funds. Funds leave a trader's wallet only in
///      `collect`, and leave the desk only in `pay`.
contract BellDesk {
    struct Order {
        address trader;
        bool isBuy;
        uint256 price; // USDC micro-units per 1 WETH
        uint256 qty; // WETH wei for both sides
    }

    address public immutable callbackProxy;
    address public immutable deployer;
    IERC20 public immutable usdc;
    IERC20 public immutable weth;

    /// @notice The referee's RVM id. Set once by the deployer, then locked.
    address public referee;
    uint256 public nextOrderId = 1;
    mapping(uint256 => Order) public orders;

    event RefereeSet(address indexed referee);
    event OrderPlaced(uint256 indexed orderId, address indexed trader, bool isBuy, uint256 price, uint256 qty);
    event Collected(uint256 indexed orderId, address indexed from, uint256 amount, bool ok);
    event Paid(uint256 indexed orderId, address indexed to, uint256 amount, bool ok);

    error ZeroAddress();
    error ZeroAmount();
    error NotDeployer();
    error RefereeAlreadySet();
    error RefereeNotSet();
    error NotCallbackProxy();
    error NotReferee();
    error OrderTraderMismatch();

    modifier onlyRefereeCallback(address rvmId) {
        if (referee == address(0)) revert RefereeNotSet();
        if (msg.sender != callbackProxy) revert NotCallbackProxy();
        if (rvmId != referee) revert NotReferee();
        _;
    }

    constructor(address _callbackProxy, address _usdc, address _weth) {
        if (_callbackProxy == address(0) || _usdc == address(0) || _weth == address(0)) revert ZeroAddress();
        callbackProxy = _callbackProxy;
        deployer = msg.sender;
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
    }

    /// @notice Deployer-only, once. Links this desk to the referee after the referee is deployed.
    function setReferee(address _referee) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (referee != address(0)) revert RefereeAlreadySet();
        if (_referee == address(0)) revert ZeroAddress();
        referee = _referee;
        emit RefereeSet(_referee);
    }

    /// @notice Record an order. No funds move. The trader must approve this desk
    ///         for USDC (buy) or WETH (sell) before the bell, or the order drops at collect.
    function place(bool isBuy, uint256 price, uint256 qty) external returns (uint256 orderId) {
        if (price == 0 || qty == 0) revert ZeroAmount();
        orderId = nextOrderId++;
        orders[orderId] = Order({trader: msg.sender, isBuy: isBuy, price: price, qty: qty});
        emit OrderPlaced(orderId, msg.sender, isBuy, price, qty);
    }

    /// @notice Pull a trader's funds into the desk. Buyers pay USDC, sellers pay WETH.
    ///         A failed pull never reverts. It emits ok = false so the referee can unwind.
    function collect(address rvmId, uint256 orderId, address trader, bool isBuy, uint256 amount)
        external
        onlyRefereeCallback(rvmId)
        returns (bool ok)
    {
        if (amount == 0) revert ZeroAmount();
        Order storage o = orders[orderId];
        if (o.trader != trader || o.isBuy != isBuy) revert OrderTraderMismatch();
        IERC20 token = isBuy ? usdc : weth;
        ok = _call(address(token), abi.encodeCall(IERC20.transferFrom, (trader, address(this), amount)));
        emit Collected(orderId, trader, amount, ok);
    }

    /// @notice Send funds from the desk's pot to a counterparty on this chain.
    ///         A failed transfer never reverts. It emits ok = false.
    function pay(address rvmId, uint256 orderId, address to, bool payUsdc, uint256 amount)
        external
        onlyRefereeCallback(rvmId)
        returns (bool ok)
    {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        IERC20 token = payUsdc ? usdc : weth;
        ok = _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
        emit Paid(orderId, to, amount, ok);
    }

    /// @dev Low-level token call that tolerates tokens which return nothing or false.
    function _call(address token, bytes memory data) internal returns (bool) {
        (bool success, bytes memory ret) = token.call(data);
        if (!success) return false;
        if (ret.length == 0) return true;
        return ret.length == 32 && abi.decode(ret, (bool));
    }
}
