// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {BellReferee} from "../BellReferee.sol";

/// @dev Test only. Exposes the referee's pure helpers so their math can be checked directly.
contract RefereeHarness is BellReferee {
    function sqrtLimit(bool isBuy, uint256 limit) external pure returns (uint160) {
        return _sqrtLimit(isBuy, limit);
    }

    function isqrt(uint256 x) external pure returns (uint256) {
        return _sqrt(x);
    }

    function priceOf(uint160 sqrtPriceX96) external pure returns (uint256) {
        return _price(sqrtPriceX96);
    }
}
