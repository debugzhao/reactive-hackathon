// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Vm } from "forge-std/Vm.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { BaseSetup } from "./BaseSetup.t.sol";
import { QueueReactive } from "../src/QueueReactive.sol";
import { QueueSettler } from "../src/QueueSettler.sol";
import { IQueueVault } from "../src/interfaces/IQueueVault.sol";

/// @dev 本地模拟 Reactive 系统合约（0x8888…）：记录订阅 / 退订，把回调请求存起来供测试「投递」
contract MockSystem {
    struct Sub {
        uint256 chainId;
        address contract_;
        uint256 topic0;
        uint256 topic1;
    }

    Sub[] public subs;
    uint256 public unsubscribeCount;
    ISystemContract.CallbackConfiguration_V_1_0[] internal _requests;

    function subscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256, uint256) external {
        subs.push(Sub(c, a, t0, t1));
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {
        unsubscribeCount++;
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory cfg) external {
        _requests.push(cfg);
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function request(uint256 i) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) {
        return _requests[i];
    }

    receive() external payable { }
}

/// @dev 本地模拟目标链 Callback Proxy：把 payload 首个 address 参数替换成 reactive 地址再调用
contract MockProxy {
    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable { }

    function deliver(address recipient, address reactive, bytes memory payload) external returns (bool ok, bytes memory ret) {
        assembly {
            mstore(add(payload, 36), reactive) // selector(4) 之后的第一个 32 字节
        }
        (ok, ret) = recipient.call(payload);
    }
}

contract IntegrationTest is BaseSetup {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    uint256 internal constant CHAIN = 84532;

    MockSystem internal system;
    MockProxy internal proxy;
    QueueReactive internal reactive;
    QueueSettler internal settler;
    uint256 internal snapshotTopic0;
    uint256 internal repaidTopic0;

    function setUp() public override {
        super.setUp();
        vm.chainId(CHAIN);
        MockSystem impl = new MockSystem();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        system = MockSystem(payable(SYSTEM_ADDR));
        proxy = new MockProxy();

        snapshotTopic0 = uint256(
            keccak256(
                "LiquiditySnapshot(bool,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint64)"
            )
        );
        repaidTopic0 = uint256(keccak256("Repaid(address,uint256,uint256,uint64)"));

        reactive = new QueueReactive{ value: 1 ether }(
            CHAIN, address(vault), address(pool), snapshotTopic0, repaidTopic0, 10, 1_500_000, 100 * USDC, 20
        );
        settler = new QueueSettler{ value: 0.1 ether }(
            IPayable(payable(address(proxy))), address(reactive), IQueueVault(address(vault))
        );
        reactive.setSettler(address(settler));
    }

    // ───────────── 工具：把真实 emit 的日志转成 LogRecord 喂给 react ─────────────

    function _toRecord(Vm.Log memory l) internal pure returns (IReactive.LogRecord memory r) {
        r.chainId = CHAIN;
        r.contractAddress = l.emitter;
        r.topic0 = uint256(l.topics[0]);
        if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
        if (l.topics.length > 2) r.topic2 = uint256(l.topics[2]);
        if (l.topics.length > 3) r.topic3 = uint256(l.topics[3]);
        r.data = l.data;
        r.opCode = 1 + l.topics.length;
        r.txHash = uint256(keccak256(abi.encode(l.emitter, l.data)));
    }

    /// @dev 模拟 Reactive 网络：只投递订阅命中的日志（快照要 topic1 = 1）
    function _relay(Vm.Log[] memory logs) internal returns (uint256 delivered) {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            bool hit = (l.emitter == address(vault) && uint256(l.topics[0]) == snapshotTopic0 && uint256(l.topics[1]) == 1)
                || (l.emitter == address(pool) && uint256(l.topics[0]) == repaidTopic0);
            if (!hit) continue;
            vm.prank(SYSTEM_ADDR);
            reactive.react(_toRecord(l));
            delivered++;
        }
    }

    /// @dev 模拟 Callback Proxy 投递所有尚未投递的回调；投递产生的日志也会再交给 react（事件自续）
    function _deliverAll(uint256 fromIndex) internal returns (uint256 next) {
        next = fromIndex;
        while (next < system.requestCount()) {
            ISystemContract.CallbackConfiguration_V_1_0 memory cfg = system.request(next++);
            assertEq(cfg.chainId, CHAIN);
            assertEq(cfg.recipient, address(settler));
            assertGe(cfg.gasLimit, 100_000);
            vm.recordLogs();
            (bool ok,) = proxy.deliver{ gas: cfg.gasLimit }(cfg.recipient, address(reactive), cfg.payload);
            assertTrue(ok, "callback must succeed");
            _relay(vm.getRecordedLogs());
        }
    }

    // ───────────── 订阅与鉴权 ─────────────

    function test_subscribesBothSourcesInConstructor() public view {
        (uint256 c0, address a0, uint256 t00, uint256 t10) = system.subs(0);
        (uint256 c1, address a1, uint256 t01,) = system.subs(1);
        assertEq(c0, CHAIN);
        assertEq(a0, address(vault));
        assertEq(t00, snapshotTopic0);
        assertEq(t10, 1, "only queueActive snapshots");
        assertEq(c1, CHAIN);
        assertEq(a1, address(pool));
        assertEq(t01, repaidTopic0);
        assertTrue(reactive.subscribed());
    }

    function test_reactOnlyCallableBySystem() public {
        IReactive.LogRecord memory r;
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM_ADDR));
        reactive.react(r);
    }

    function test_settlerRejectsNonProxy() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), address(proxy)));
        settler.onSettle(address(reactive), 1, 0, 0, 10);
    }

    function test_settlerRejectsWrongReactive() public {
        bytes memory payload = abi.encodeWithSignature(
            "onSettle(address,uint8,uint256,uint256,uint256)", address(0), uint8(1), uint256(0), uint256(0), uint256(10)
        );
        (bool ok, bytes memory ret) = proxy.deliver(address(settler), address(0xBAD), payload);
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0xBAD), address(reactive))
        );
    }

    function test_gasLimitBelowFloorRejected() public {
        vm.expectRevert(abi.encodeWithSelector(QueueReactive.GasLimitTooLow.selector, uint64(99_999)));
        reactive.setParams(10, 99_999, 0);
    }

    // ───────────── react 的过滤 ─────────────

    function test_reactIgnoresForeignAndMalformedLogs() public {
        IReactive.LogRecord memory r;
        r.chainId = 1; // 别的链
        r.contractAddress = address(vault);
        r.topic0 = snapshotTopic0;
        vm.prank(SYSTEM_ADDR);
        reactive.react(r);

        r.chainId = CHAIN;
        r.data = hex"1234"; // 长度不对：不能 revert
        vm.prank(SYSTEM_ADDR);
        reactive.react(r);

        r.contractAddress = address(0xBEEF); // 别的合约
        vm.prank(SYSTEM_ADDR);
        reactive.react(r);

        assertEq(system.requestCount(), 0);
        assertEq(reactive.reactCount(), 3);
    }

    function test_staleSnapshotIsDropped() public {
        _setupUtilized();
        vm.recordLogs();
        _request(alice, 2_000 * USDC);
        Vm.Log[] memory first = vm.getRecordedLogs();
        _relay(first);
        (uint256 seq,,,,,,) = reactive.mirror();
        assertGt(seq, 0);

        _relay(first); // 重放同一个快照
        assertEq(system.requestCount(), 1, "replayed snapshot must not trigger again");
    }

    // ───────────── 全链路 ─────────────

    /// @notice 演示脚本的完整流程：排队 → 缓冲部分兑付 → 还款 → 抢回流动性 → 队列清空
    function test_fullLoop_requestThenRepayDrainsQueue() public {
        _setupUtilized();
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        // ① Alice 排队：快照显示还有约 501 缓冲 ≥ 门槛 100，触发第一次回调
        vm.recordLogs();
        uint256 idA = _request(alice, 2_000 * USDC);
        _relay(vm.getRecordedLogs());
        assertEq(system.requestCount(), 1);
        uint256 cursor = _deliverAll(0);
        assertEq(vault.head(), idA, "Alice partially paid, still at head");

        // ② Bob 排队：现金为 0，池子没有流动性 → 不触发
        vm.recordLogs();
        uint256 idB = _request(bob, 1_000 * USDC);
        _relay(vm.getRecordedLogs());
        assertEq(system.requestCount(), cursor, "no cash, no callback");

        // ③ 借款人还款 2,500：Repaid 触发回调，抢回缺口，清空队列
        vm.recordLogs();
        _repay(2_500 * USDC);
        _relay(vm.getRecordedLogs());
        assertEq(system.requestCount(), cursor + 1);
        _deliverAll(cursor);

        assertEq(vault.pendingCount(), 0, "queue drained");
        assertEq(usdc.balanceOf(alice) - aliceBefore, vault.getRequest(idA).assetsTotal);
        assertEq(usdc.balanceOf(bob) - bobBefore, vault.getRequest(idB).assetsTotal);
        (,,,,,, uint256 pending) = reactive.mirror();
        assertEq(pending, 0, "mirror reset by the 'queue just emptied' snapshot");
    }

    function test_competitorFirst_callbackLandsEmptyHanded() public {
        _setupUtilized();
        vm.recordLogs();
        _request(alice, 2_000 * USDC);
        _relay(vm.getRecordedLogs());
        uint256 cursor = _deliverAll(0); // 用掉缓冲

        vm.recordLogs();
        _repay(2_000 * USDC);
        _relay(vm.getRecordedLogs());
        assertEq(system.requestCount(), cursor + 1, "reactive decided to settle");

        // 对手在回调落地之前取走全部流动性
        vm.prank(competitor);
        pool.withdraw(2_000 * USDC, competitor, competitor);

        _deliverAll(cursor); // 回调照常成功，只是什么也没抢到
        assertEq(vault.pendingCount(), 1, "Alice keeps waiting for the next repay");
    }

    function test_continuationAfterMaxPerCallback() public {
        reactive.setParams(2, 1_500_000, 100 * USDC);
        _setupUtilized();
        // 排 5 笔，每笔 400：缓冲约 501 只够付 1 笔多一点
        vm.recordLogs();
        for (uint256 i; i < 5; ++i) {
            _request(alice, 400 * USDC);
        }
        _relay(vm.getRecordedLogs());
        uint256 cursor = _deliverAll(0);
        assertEq(vault.pendingCount(), 4, "buffer only covers the first request");

        vm.recordLogs();
        _repay(5_000 * USDC);
        _relay(vm.getRecordedLogs());

        // 每个回调最多兑付 2 笔，靠 SETTLED 快照自续，直到队列清空
        uint256 end = _deliverAll(cursor);
        assertEq(vault.pendingCount(), 0);
        assertGe(end - cursor, 2, "needed more than one callback after the repay");
    }

    function test_budgetExhaustionUnsubscribes() public {
        reactive.topUp(1);
        _setupUtilized();
        vm.recordLogs();
        _request(alice, 2_000 * USDC);
        _relay(vm.getRecordedLogs());
        assertEq(reactive.remainingCallbacks(), 0);
        assertFalse(reactive.subscribed());
        assertEq(system.unsubscribeCount(), 2);
    }

    function test_pauseStopsCallbacks() public {
        reactive.pause();
        _setupUtilized();
        vm.recordLogs();
        _request(alice, 2_000 * USDC);
        _relay(vm.getRecordedLogs());
        assertEq(system.requestCount(), 0);
    }

    function test_circuitBreakerPausesOnEventFlood() public {
        reactive.setBreaker(3, 60);
        IReactive.LogRecord memory r;
        r.chainId = CHAIN;
        r.contractAddress = address(0xBEEF); // 垃圾事件也计入窗口
        for (uint256 i; i < 3; ++i) {
            vm.prank(SYSTEM_ADDR);
            reactive.react(r);
        }
        assertFalse(reactive.paused());

        vm.prank(SYSTEM_ADDR);
        reactive.react(r); // 第 4 次：熔断
        assertTrue(reactive.paused());
        assertFalse(reactive.subscribed());
        assertEq(system.unsubscribeCount(), 2);

        // 窗口过后由 owner 手动恢复
        vm.warp(block.timestamp + 61);
        reactive.resume();
        assertTrue(reactive.subscribed());
        assertEq(reactive.windowCount(), 0);
    }

    function test_breakerWindowResetsOverTime() public {
        reactive.setBreaker(3, 60);
        IReactive.LogRecord memory r;
        for (uint256 i; i < 9; ++i) {
            vm.prank(SYSTEM_ADDR);
            reactive.react(r);
            vm.warp(block.timestamp + 25); // 每 60 秒最多 3 次：不触发
        }
        assertFalse(reactive.paused());
    }

    function test_gasOfWorstCaseCallbackFitsLimit() public {
        _setupUtilized();
        for (uint256 i; i < 10; ++i) {
            _request(i % 2 == 0 ? alice : bob, 250 * USDC);
        }
        vault.settleQueue(1); // 用掉缓冲，让队列卡住
        _repay(5_000 * USDC);

        bytes memory payload = abi.encodeWithSignature(
            "onSettle(address,uint8,uint256,uint256,uint256)", address(0), uint8(2), uint256(0), uint256(0), uint256(10)
        );
        uint256 g = gasleft();
        (bool ok,) = proxy.deliver(address(settler), address(reactive), payload);
        uint256 used = g - gasleft();
        assertTrue(ok);
        emit log_named_uint("gas: recall + 10 payouts", used);
        assertLt(used * 13 / 10, 1_500_000, "1.3x margin under callbackGasLimit");
    }
}
