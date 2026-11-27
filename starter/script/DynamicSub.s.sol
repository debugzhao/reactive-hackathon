// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { Switchboard } from "../src/Switchboard.sol";
import { CampOrigin } from "../src/CampOrigin.sol";
import { DynamicWatcher } from "../src/DynamicWatcher.sol";

// 练习 B：动态订阅。源链默认 Base Sepolia（84532），Reactive 侧是 Lasna。
// 步骤和预期见 notes/2026-11-25-练习B-动态订阅.md

/// ① 源链：部署控制台 Switchboard + 一个被监听的 target（复用 CampOrigin，它会发 Ping）
///   forge script script/DynamicSub.s.sol:DeployDynOrigin --rpc-url $DYN_ORIGIN_RPC_URL --broadcast
contract DeployDynOrigin is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        Switchboard board = new Switchboard();
        CampOrigin target = new CampOrigin();
        vm.stopBroadcast();
        console.log("SWITCHBOARD_ADDR=", address(board));
        console.log("TARGET_ADDR=", address(target));
    }
}

/// ② Lasna：部署 DynamicWatcher（构造时只订阅控制通道），默认预付 0.15 lREACT
///   forge script script/DynamicSub.s.sol:DeployDynWatcher --rpc-url $LASNA_RPC_URL --broadcast
contract DeployDynWatcher is Script {
    function run() external {
        uint256 originChain = vm.envOr("DYN_ORIGIN_CHAIN_ID", uint256(84532));
        address board = vm.envAddress("SWITCHBOARD_ADDR");
        uint256 fund = vm.envOr("DYN_FUND", uint256(0.15 ether)); // lREACT

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        DynamicWatcher w = new DynamicWatcher{ value: fund }(originChain, board);
        vm.stopBroadcast();
        console.log("WATCHER_ADDR=", address(w));
    }
}

/// ③ 源链：发 Start(target, limit) → Watcher 在 react() 里订阅 target
///   forge script script/DynamicSub.s.sol:DynStart --rpc-url $DYN_ORIGIN_RPC_URL --broadcast
contract DynStart is Script {
    function run() external {
        uint256 limit = vm.envOr("DYN_LIMIT", uint256(3));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        Switchboard(vm.envAddress("SWITCHBOARD_ADDR")).start(vm.envAddress("TARGET_ADDR"), limit);
        vm.stopBroadcast();
        console.log("start sent, limit", limit);
    }
}

/// ④ 源链：target 发 Ping → 正在监听时会被计数
///   forge script script/DynamicSub.s.sol:DynPing --rpc-url $DYN_ORIGIN_RPC_URL --broadcast
contract DynPing is Script {
    function run() external {
        uint256 value = vm.envOr("DYN_PING_VALUE", uint256(1));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        CampOrigin(vm.envAddress("TARGET_ADDR")).ping(value);
        vm.stopBroadcast();
        console.log("pinged with value", value);
    }
}

/// ⑤ 源链：发 Stop(target) → Watcher 在 react() 里退订 target
///   forge script script/DynamicSub.s.sol:DynStop --rpc-url $DYN_ORIGIN_RPC_URL --broadcast
contract DynStop is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        Switchboard(vm.envAddress("SWITCHBOARD_ADDR")).stop(vm.envAddress("TARGET_ADDR"));
        vm.stopBroadcast();
        console.log("stop sent");
    }
}
