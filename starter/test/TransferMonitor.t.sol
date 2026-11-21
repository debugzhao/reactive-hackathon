// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { TransferMonitor } from "../src/TransferMonitor.sol";
import { MockSystem } from "./Camp.t.sol";

contract TransferMonitorTest is Test {
    address constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    address constant TOKEN_A = address(0xA);
    address constant TOKEN_B = address(0xB);

    MockSystem system;
    TransferMonitor monitor;

    function setUp() public {
        MockSystem impl = new MockSystem();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        system = MockSystem(payable(SYSTEM_ADDR));
        monitor = new TransferMonitor{ value: 1 ether }(address(0), 2);
    }

    function _log(address token, uint256 amount, uint256 opCode) internal pure returns (IReactive.LogRecord memory l) {
        l.chainId = 11155111;
        l.contractAddress = token;
        l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef;
        l.topic1 = uint256(uint160(address(0x1111)));
        l.topic2 = uint256(uint160(address(0x2222)));
        l.data = abi.encode(amount);
        l.opCode = opCode;
        l.txHash = 0xabc;
    }

    function _react(IReactive.LogRecord memory l) internal {
        vm.prank(SYSTEM_ADDR);
        monitor.react(l);
    }

    function test_subscribesWildcardInConstructor() public view {
        (uint256 c, address a, uint256 t0) = system.subs(0);
        assertEq(c, 11155111);
        assertEq(a, address(0)); // 通配：所有 ERC-20 合约
        assertEq(t0, monitor.TRANSFER_TOPIC_0());
        assertTrue(monitor.subscribed());
    }

    function test_reactOnlySystem() public {
        vm.expectRevert();
        monitor.react(_log(TOKEN_A, 1, 3));
    }

    function test_decodesAndAccumulates() public {
        vm.expectEmit(true, true, true, true, address(monitor));
        emit TransferMonitor.TransferSeen(TOKEN_A, address(0x1111), address(0x2222), 100, 0xabc);
        _react(_log(TOKEN_A, 100, 3));

        assertEq(monitor.turnover(TOKEN_A), 100);
        assertEq(monitor.processed(), 1);
        assertEq(monitor.remaining(), 1);
        assertEq(monitor.lastTxHash(), 0xabc);
    }

    function test_ignoresLog4_ERC721() public {
        _react(_log(TOKEN_A, 7, 4)); // ERC-721 Transfer：同 topic0，但是 LOG4
        assertEq(monitor.processed(), 0);
        assertEq(monitor.remaining(), 2);
    }

    function test_limitReachedUnsubscribesOnce() public {
        _react(_log(TOKEN_A, 1, 3));
        _react(_log(TOKEN_B, 2, 3));
        assertEq(monitor.remaining(), 0);
        assertFalse(monitor.subscribed());
        assertEq(system.unsubscribeCount(), 1);

        // 退订后仍到达的事件：直接 return，不下溢、不 revert
        _react(_log(TOKEN_A, 3, 3));
        assertEq(monitor.processed(), 2);
        assertEq(system.unsubscribeCount(), 1);
    }

    function test_setLimitResubscribesWithoutDuplicate() public {
        monitor.setLimit(5); // 仍在订阅中 → 不重复订阅
        vm.expectRevert();
        system.subs(1);

        monitor.setLimit(0);
        assertFalse(monitor.subscribed());
        monitor.setLimit(3);
        assertTrue(monitor.subscribed());
        (, address a,) = system.subs(1);
        assertEq(a, address(0));
    }

    function test_setLimitOnlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(TransferMonitor.NotOwner.selector);
        monitor.setLimit(1);
    }

    function test_specificTokenSubscription() public {
        TransferMonitor m = new TransferMonitor(TOKEN_A, 1);
        (, address a,) = system.subs(1);
        assertEq(a, TOKEN_A);
        assertEq(m.TOKEN(), TOKEN_A);
    }
}
