// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Script, console } from "forge-std/Script.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { MockUSDC } from "../src/MockUSDC.sol";
import { MockPool } from "../src/MockPool.sol";
import { QueueVault } from "../src/QueueVault.sol";
import { QueueReactive } from "../src/QueueReactive.sol";
import { QueueSettler } from "../src/QueueSettler.sol";
import { IQueueVault } from "../src/interfaces/IQueueVault.sol";

/// @dev 各步骤共享：地址统一读写 deployments/testnet.json，跨链步骤不用手抄地址
abstract contract Deployments is Script {
    /// @dev 本地冒烟测试用 DEPLOYMENTS_FILE=deployments/devnet.json，永远不会覆盖真实测试网地址
    function _path() internal view returns (string memory) {
        return vm.envOr("DEPLOYMENTS_FILE", string("deployments/testnet.json"));
    }
    uint256 internal constant USDC = 1e6;
    uint256 internal constant BASE_SEPOLIA = 84532;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function _read(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(vm.readFile(_path()), key);
    }

    function _write(string memory key, address value) internal {
        vm.writeJson(vm.toString(value), _path(), key);
    }

    function _key() internal view returns (uint256) {
        return vm.envUint("PRIVATE_KEY");
    }

    function _snapshotTopic0() internal pure returns (uint256) {
        return uint256(
            keccak256(
                "LiquiditySnapshot(bool,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint64)"
            )
        );
    }

    function _repaidTopic0() internal pure returns (uint256) {
        return uint256(keccak256("Repaid(address,uint256,uint256,uint64)"));
    }
}

/// ① Base Sepolia：MockUSDC + MockPool + QueueVault，并做两份种子存款（防通胀攻击）
///   forge script script/Deploy.s.sol:DeployBase --rpc-url $BASE_RPC_URL --broadcast
contract DeployBase is Deployments {
    function run() external {
        uint256 pk = _key();
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        MockUSDC usdc = new MockUSDC();
        MockPool pool = new MockPool(usdc, vm.envOr("POOL_APR_BPS", uint256(800)));
        pool.setBorrower(me); // 演示里部署者兼任借款人
        QueueVault vault = new QueueVault(usdc, IERC4626(address(pool)), 1 * USDC, uint16(vm.envOr("BUFFER_BPS", uint256(500))));

        usdc.mint(me, 2 * USDC);
        usdc.approve(address(pool), 1 * USDC);
        pool.deposit(1 * USDC, DEAD);
        usdc.approve(address(vault), 1 * USDC);
        vault.deposit(1 * USDC, DEAD);
        vm.stopBroadcast();

        string memory obj = "d";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "usdc", address(usdc));
        vm.serializeAddress(obj, "pool", address(pool));
        vm.serializeAddress(obj, "vault", address(vault));
        vm.serializeAddress(obj, "reactive", address(0));
        // 前端从这两个区块开始扫日志（脚本模拟时的区块号，一定早于合约真正上链的区块）
        vm.serializeUint(obj, "baseBlock", block.number);
        vm.serializeUint(obj, "lasnaBlock", 0);
        string memory json = vm.serializeAddress(obj, "settler", address(0));
        vm.writeJson(json, _path());

        console.log("USDC   ", address(usdc));
        console.log("POOL   ", address(pool));
        console.log("VAULT  ", address(vault));
    }
}

/// ② Lasna：QueueReactive（附带 lREACT 预付款），订阅金库快照和池子还款
///   forge script script/Deploy.s.sol:DeployReactive --rpc-url $LASNA_RPC_URL --broadcast
contract DeployReactive is Deployments {
    function run() external {
        address vault = _read(".vault");
        address pool = _read(".pool");
        uint256 fund = vm.envOr("REACTIVE_FUND", uint256(1 ether)); // lREACT

        vm.startBroadcast(_key());
        QueueReactive r = new QueueReactive{ value: fund }(
            BASE_SEPOLIA,
            vault,
            pool,
            _snapshotTopic0(),
            _repaidTopic0(),
            vm.envOr("MAX_PER_CALLBACK", uint256(10)),
            uint64(vm.envOr("CALLBACK_GAS_LIMIT", uint256(1_500_000))),
            vm.envOr("MIN_SETTLE_ASSETS", uint256(100 * USDC)),
            vm.envOr("CALLBACK_BUDGET", uint256(30))
        );
        vm.stopBroadcast();
        _write(".reactive", address(r));
        vm.writeJson(vm.toString(block.number), _path(), ".lasnaBlock");
        console.log("REACTIVE", address(r));
    }
}

/// ③ Base Sepolia：QueueSettler（附带 ETH 付回调费）
///   forge script script/Deploy.s.sol:DeploySettler --rpc-url $BASE_RPC_URL --broadcast
contract DeploySettler is Deployments {
    function run() external {
        address proxy = vm.envOr("CALLBACK_PROXY", address(0x476F44b11F5C942c58f4c8E3d0300E5710743585));
        uint256 fund = vm.envOr("SETTLER_FUND", uint256(0.005 ether));

        vm.startBroadcast(_key());
        QueueSettler s = new QueueSettler{ value: fund }(
            IPayable(payable(proxy)), _read(".reactive"), IQueueVault(_read(".vault"))
        );
        vm.stopBroadcast();
        _write(".settler", address(s));
        console.log("SETTLER", address(s));
    }
}

/// ④ Lasna：告诉 Reactive 合约回调发给谁
///   forge script script/Deploy.s.sol:SetSettler --rpc-url $LASNA_RPC_URL --broadcast
contract SetSettler is Deployments {
    function run() external {
        vm.startBroadcast(_key());
        QueueReactive(payable(_read(".reactive"))).setSettler(_read(".settler"));
        vm.stopBroadcast();
        console.log("settler set");
    }
}

/// ⑤ Base Sepolia：演示状态——存 10,000 → 配置 9,500 到池子 → 借款人借空池子
///   forge script script/Deploy.s.sol:SetupDemo --rpc-url $BASE_RPC_URL --broadcast
contract SetupDemo is Deployments {
    function run() external {
        uint256 pk = _key();
        address me = vm.addr(pk);
        MockUSDC usdc = MockUSDC(_read(".usdc"));
        MockPool pool = MockPool(_read(".pool"));
        QueueVault vault = QueueVault(_read(".vault"));
        uint256 amount = vm.envOr("DEMO_DEPOSIT", uint256(10_000 * USDC));

        vm.startBroadcast(pk);
        usdc.mint(me, amount);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, me);
        vault.allocate(amount * 95 / 100);
        vm.stopBroadcast();

        // 借空池子：借款金额在广播前读出来，避免模拟和上链状态不一致
        uint256 liq = pool.liquidity();
        vm.startBroadcast(pk);
        pool.borrow(liq);
        vm.stopBroadcast();
        console.log("vault cash      ", usdc.balanceOf(address(vault)));
        console.log("pool liquidity  ", pool.liquidity());
    }
}

/// ⑥ Base Sepolia：排队赎回（默认 2,000 USDC）
///   REDEEM_ASSETS=2000000000 forge script script/Deploy.s.sol:RequestRedeem --rpc-url $BASE_RPC_URL --broadcast
contract RequestRedeem is Deployments {
    function run() external {
        uint256 pk = _key();
        address me = vm.addr(pk);
        QueueVault vault = QueueVault(_read(".vault"));
        // Floor 换算：锁定的应付金额 ≤ 请求金额（previewWithdraw 是 Ceil，会多锁几 wei）
        uint256 shares = vault.convertToShares(vm.envOr("REDEEM_ASSETS", uint256(2_000 * USDC)));

        vm.startBroadcast(pk);
        uint256 id = vault.requestRedeem(shares, me, me);
        vm.stopBroadcast();
        console.log("request id", id);
    }
}

/// ⑦ Base Sepolia：借款人还款（默认 2,500 USDC），池子出现流动性 → 触发 Reactive
///   REPAY_ASSETS=2500000000 forge script script/Deploy.s.sol:Repay --rpc-url $BASE_RPC_URL --broadcast
contract Repay is Deployments {
    function run() external {
        uint256 pk = _key();
        address me = vm.addr(pk);
        MockUSDC usdc = MockUSDC(_read(".usdc"));
        MockPool pool = MockPool(_read(".pool"));
        uint256 amount = vm.envOr("REPAY_ASSETS", uint256(2_500 * USDC));

        vm.startBroadcast(pk);
        usdc.mint(me, amount); // 测试网：利息部分直接 mint
        usdc.approve(address(pool), amount);
        pool.repay(amount);
        vm.stopBroadcast();
        console.log("repaid", amount);
    }
}
