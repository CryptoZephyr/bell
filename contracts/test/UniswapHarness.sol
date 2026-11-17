// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only. These imports pull the real Uniswap v4 PoolManager and its liquidity
// helper into the build so tests can deploy them. Nothing here is deployed.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
