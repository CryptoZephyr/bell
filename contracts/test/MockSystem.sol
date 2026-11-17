// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISystemContract, LogRecord} from "../BellReferee.sol";

interface IReferee {
    function react(LogRecord calldata log) external;
}

/// @dev Local stand-in for the Reactive system contract, allowed by Memory.md for unit tests only.
///      It records subscriptions and relays logs into react() the way the Reactive network would.
contract MockSystem is ISystemContract {
    event Subscribed(uint256 chain_id, address indexed _contract, uint256 topic_0, uint256 topic_1);
    event Unsubscribed(uint256 chain_id, address indexed _contract, uint256 topic_0, uint256 topic_1);

    function subscribe(uint256 chain_id, address _contract, uint256 topic_0, uint256 topic_1, uint256, uint256)
        external
    {
        emit Subscribed(chain_id, _contract, topic_0, topic_1);
    }

    function unsubscribe(uint256 chain_id, address _contract, uint256 topic_0, uint256 topic_1, uint256, uint256)
        external
    {
        emit Unsubscribed(chain_id, _contract, topic_0, topic_1);
    }

    function relay(address referee, LogRecord calldata log) external {
        IReferee(referee).react(log);
    }
}
