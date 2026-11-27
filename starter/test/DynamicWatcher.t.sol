// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test, Vm } from "forge-std/Test.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { DynamicWatcher } from "../src/DynamicWatcher.sol";
import { Switchboard } from "../src/Switchboard.sol";
import { CampOrigin } from "../src/CampOrigin.sol";

/// @dev 比 Camp.t.sol 里的 MockSystem 更严格：按完整参数记录订阅，
///      退订参数对不上时不生效（模拟真实网络的「静默失败」），并记录失配次数。
contract ExactMockSystem {
    mapping(bytes32 => bool) public active;
    uint256 public activeCount;
    uint256 public subscribeCount;
    uint256 public unsubscribeCount;
    uint256 public missedUnsubscribe;

    function _key(address owner, uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(owner, c, a, t0, t1, t2, t3));
    }

    function subscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bytes32 k = _key(msg.sender, c, a, t0, t1, t2, t3);
        if (!active[k]) activeCount++;
        active[k] = true;
        subscribeCount++;
    }

    function unsubscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        bytes32 k = _key(msg.sender, c, a, t0, t1, t2, t3);
        unsubscribeCount++;
        if (!active[k]) {
            missedUnsubscribe++;
            return;
        }
        active[k] = false;
        activeCount--;
    }

    function isActive(address owner, uint256 c, address a, uint256 t0, uint256 ignore) external view returns (bool) {
        return active[_key(owner, c, a, t0, ignore, ignore, ignore)];
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}
}

contract DynamicWatcherTest is Test {
    address constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    uint256 constant IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 constant CHAIN = 84532;

    ExactMockSystem system;
    Switchboard board;
    CampOrigin targetA;
    CampOrigin targetB;
    DynamicWatcher watcher;

    function setUp() public {
        ExactMockSystem impl = new ExactMockSystem();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        system = ExactMockSystem(payable(SYSTEM_ADDR));

        board = new Switchboard();
        targetA = new CampOrigin();
        targetB = new CampOrigin();
        watcher = new DynamicWatcher{ value: 1 ether }(CHAIN, address(board));
    }

    // ── 辅助：把真实 emit 的事件转成 LogRecord 交给 react，确保 topic / data 编码和链上一致 ──

    function _deliverLast(address emitter) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter != emitter) continue;
            IReactive.LogRecord memory r;
            r.chainId = CHAIN;
            r.contractAddress = l.emitter;
            r.topic0 = uint256(l.topics[0]);
            if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
            r.data = l.data;
            r.opCode = 1 + l.topics.length;
            r.txHash = uint256(keccak256(abi.encode(i, block.number)));
            vm.prank(SYSTEM_ADDR);
            watcher.react(r);
            return;
        }
        revert("no log");
    }

    function _start(address target, uint256 limit) internal {
        vm.recordLogs();
        board.start(target, limit);
        _deliverLast(address(board));
    }

    function _stop(address target) internal {
        vm.recordLogs();
        board.stop(target);
        _deliverLast(address(board));
    }

    function _ping(CampOrigin target, uint256 value) internal {
        vm.recordLogs();
        target.ping(value);
        _deliverLast(address(target));
    }

    function _watching(address target) internal view returns (bool) {
        return system.isActive(address(watcher), CHAIN, target, watcher.PING_TOPIC_0(), IGNORE);
    }

    // ── 构造与鉴权 ──

    function test_constructorSubscribesControlOnly() public view {
        assertEq(system.activeCount(), 2);
        assertTrue(system.isActive(address(watcher), CHAIN, address(board), watcher.START_TOPIC_0(), IGNORE));
        assertTrue(system.isActive(address(watcher), CHAIN, address(board), watcher.STOP_TOPIC_0(), IGNORE));
        assertTrue(watcher.controlSubscribed());
    }

    function test_topicsMatchEventSignatures() public view {
        assertEq(watcher.START_TOPIC_0(), uint256(Switchboard.Start.selector));
        assertEq(watcher.STOP_TOPIC_0(), uint256(Switchboard.Stop.selector));
        assertEq(watcher.PING_TOPIC_0(), uint256(CampOrigin.Ping.selector));
    }

    function test_reactOnlySystem() public {
        IReactive.LogRecord memory r;
        vm.expectRevert();
        watcher.react(r);
    }

    function test_switchboardOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(Switchboard.NotOwner.selector);
        board.start(address(targetA), 3);
    }

    // ── 动态订阅主流程 ──

    function test_startSubscribesTarget() public {
        _start(address(targetA), 3);
        assertTrue(_watching(address(targetA)));
        assertEq(watcher.remaining(address(targetA)), 3);
        assertEq(watcher.targets().length, 1);
        assertEq(system.activeCount(), 3);
    }

    function test_pingCountedThenStopUnsubscribes() public {
        _start(address(targetA), 5);
        _ping(targetA, 7);
        _ping(targetA, 8);
        assertEq(watcher.seen(address(targetA)), 2);
        assertEq(watcher.remaining(address(targetA)), 3);

        _stop(address(targetA));
        assertFalse(_watching(address(targetA)));
        assertEq(system.missedUnsubscribe(), 0); // 退订参数和订阅完全一致
        assertEq(watcher.remaining(address(targetA)), 0);
        assertEq(watcher.targets().length, 0);

        // 退订后仍在路上的 Ping：丢弃，不计数
        _ping(targetA, 9);
        assertEq(watcher.seen(address(targetA)), 2);
    }

    function test_limitReachedAutoUnsubscribes() public {
        _start(address(targetA), 2);
        _ping(targetA, 1);
        vm.recordLogs();
        targetA.ping(2);
        vm.expectEmit(true, true, false, false, address(watcher));
        emit DynamicWatcher.Unwatched(address(targetA), 2, 2, 0);
        _deliverLast(address(targetA));

        assertFalse(_watching(address(targetA)));
        assertEq(system.missedUnsubscribe(), 0);
        assertEq(watcher.seen(address(targetA)), 2);
    }

    function test_restartAfterStop() public {
        _start(address(targetA), 2);
        _stop(address(targetA));
        _start(address(targetA), 2);
        assertTrue(_watching(address(targetA)));
        _ping(targetA, 1);
        assertEq(watcher.seen(address(targetA)), 1);
    }

    // ── 防护 ──

    function test_limitCappedAtMax() public {
        _start(address(targetA), 1_000_000);
        assertEq(watcher.remaining(address(targetA)), watcher.MAX_LIMIT());
    }

    function test_duplicateStartIgnored() public {
        _start(address(targetA), 3);
        uint256 subsBefore = system.subscribeCount();
        _start(address(targetA), 9);
        assertEq(system.subscribeCount(), subsBefore);
        assertEq(watcher.remaining(address(targetA)), 3);
    }

    function test_maxTargetsEnforced() public {
        _start(address(targetA), 1);
        _start(address(targetB), 1);
        _start(address(0xC0), 1);
        _start(address(0xD0), 1); // 第 4 个：拒绝
        assertEq(watcher.targets().length, watcher.MAX_TARGETS());
        assertEq(watcher.remaining(address(0xD0)), 0);
    }

    function test_wildcardAndZeroLimitRejected() public {
        _start(address(0), 3); // 通配订阅：拒绝
        _start(address(board), 3); // 订阅控制台自己：拒绝
        _start(address(targetA), 0); // limit 为 0：拒绝
        assertEq(watcher.targets().length, 0);
        assertEq(system.activeCount(), 2);
    }

    function test_stopUnknownTargetIgnored() public {
        uint256 before = system.unsubscribeCount();
        _stop(address(targetA));
        assertEq(system.unsubscribeCount(), before);
    }

    function test_fakeControlEventFromOtherContractIgnored() public {
        // 别的合约发出同签名的 Start：contractAddress 不是 Switchboard，不会被当成控制指令
        IReactive.LogRecord memory r;
        r.chainId = CHAIN;
        r.contractAddress = address(0xEE);
        r.topic0 = watcher.START_TOPIC_0();
        r.topic1 = uint256(uint160(address(targetA)));
        r.data = abi.encode(uint256(5));
        vm.prank(SYSTEM_ADDR);
        watcher.react(r);
        assertEq(watcher.remaining(address(targetA)), 0);
    }

    function test_wrongChainIgnored() public {
        IReactive.LogRecord memory r;
        r.chainId = 1;
        r.contractAddress = address(board);
        r.topic0 = watcher.START_TOPIC_0();
        r.topic1 = uint256(uint160(address(targetA)));
        r.data = abi.encode(uint256(5));
        vm.prank(SYSTEM_ADDR);
        watcher.react(r);
        assertEq(watcher.reactCount(), 0);
    }

    function test_stopAllUnsubscribesEverything() public {
        _start(address(targetA), 3);
        _start(address(targetB), 3);
        assertEq(system.activeCount(), 4);

        watcher.stopAll();
        assertEq(system.activeCount(), 0);
        assertEq(system.missedUnsubscribe(), 0);
        assertFalse(watcher.controlSubscribed());

        watcher.resumeControl();
        assertEq(system.activeCount(), 2);
    }

    function test_stopAllOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(DynamicWatcher.NotOwner.selector);
        watcher.stopAll();
    }
}
