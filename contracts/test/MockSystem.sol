// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

interface IReactiveReferee {
    function react(IReactive.LogRecord calldata log) external;
}

/// @dev Local stand-in for the Reactive system contract, allowed by Memory.md for unit tests only.
///      The tests place this code at the library's hard-coded system address (0x888...888).
///      It records subscriptions and callback requests, and relays logs into react().
contract MockSystem {
    event Subscribed(uint256 chainId, address indexed contractAddress, uint256 topic0, uint256 topic1);
    event Unsubscribed(uint256 chainId, address indexed contractAddress, uint256 topic0, uint256 topic1);
    event CallbackRequested(uint256 chainId, address indexed recipient, uint64 gasLimit, bytes payload);

    function subscribe(uint256 chainId, address contractAddress, uint256 topic0, uint256 topic1, uint256, uint256)
        external
    {
        emit Subscribed(chainId, contractAddress, topic0, topic1);
    }

    function unsubscribe(uint256 chainId, address contractAddress, uint256 topic0, uint256 topic1, uint256, uint256)
        external
    {
        emit Unsubscribed(chainId, contractAddress, topic0, topic1);
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 calldata config) external {
        emit CallbackRequested(config.chainId, config.recipient, config.gasLimit, config.payload);
    }

    function relay(address referee, IReactive.LogRecord calldata log) external {
        IReactiveReferee(referee).react(log);
    }
}
