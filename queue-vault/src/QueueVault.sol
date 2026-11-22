// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title QueueVault — 带 FIFO 提款队列的 ERC4626 金库（部署在 Base Sepolia）
/// @notice 大部分现金存进共享借贷池（MockPool）生息，只留少量缓冲。
///         现金不够时用户 requestRedeem 排队；池子一出现流动性，任何人（快通道是 Reactive 回调）
///         调用 settleQueue：先从池里抢回队列缺口，再按 FIFO 兑付。
/// @dev   设计取舍见 docs/即时结算提款队列-产品与技术方案.md 第 7 节：
///        - 排队锁定申请时的价格，份额立即销毁 → PPS 不下降
///        - 舍入一律有利于金库；_decimalsOffset = 6 防通胀攻击
///        - settleQueue 不设权限，没有工作时不 revert（回调 revert 也照样收费）
contract QueueVault is ERC4626, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    error ZeroAddress();
    error RequestTooSmall(uint256 assets, uint256 minimum);
    error ExceedsAllocatable(uint256 assets, uint256 allocatable);
    error NothingToClaim();

    struct RedeemRequest {
        address owner;
        address receiver;
        uint128 assetsTotal; // 申请时锁定的应付资产
        uint128 assetsRemaining; // 剩余待付
        uint64 requestedAt;
        uint64 settledAt;
    }

    uint8 public constant REASON_DEPOSIT = 1;
    uint8 public constant REASON_REQUEST = 2;
    uint8 public constant REASON_SETTLED = 3;
    /// @notice 单次兑付笔数的硬顶，防止人工兜底调用时传入巨大的 maxCount 造成无界循环
    uint256 public constant MAX_SETTLE_PER_CALL = 50;

    IERC4626 public immutable POOL;
    uint256 public immutable MIN_REQUEST_ASSETS;
    uint16 public immutable BUFFER_BPS;

    mapping(uint256 id => RedeemRequest) internal _requests;
    /// @notice [head, tail) 就是队列；head 只增不减（相当于 Kafka 的 committed offset）
    uint256 public head = 1;
    uint256 public tail = 1;
    uint256 public totalQueuedAssets;
    mapping(address => uint256) public claimable;
    uint256 public totalClaimable;
    uint256 public snapshotSeq;

    event RedeemRequested(
        uint256 indexed id,
        address indexed owner,
        address indexed receiver,
        uint256 shares,
        uint256 assets,
        uint64 requestedAt
    );
    event Recalled(uint256 wanted, uint256 got, uint256 poolLiquidityAfter);
    event RecallFailed(bytes reason);
    event RedeemSettled(uint256 indexed id, address indexed receiver, uint256 paid, uint256 remaining, bool done);
    event PayoutDeferred(uint256 indexed id, address indexed receiver, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event SettleSkipped(uint256 head, uint256 queueCash);
    event Allocated(uint256 assets, uint256 cashAfter);
    /// @notice react() 读不到 Base 的状态，所以判断所需的数据全部放进这个事件（Event-Carried State Transfer）。
    ///         queueActive 作为 topic1，Reactive 只订阅 topic1 = 1，队列空闲时的存款不产生 react 费用。
    event LiquiditySnapshot(
        bool indexed queueActive,
        uint8 indexed reason,
        uint256 seq,
        uint256 queueCash,
        uint256 poolPosition,
        uint256 poolLiquidity,
        uint256 headId,
        uint256 headRemaining,
        uint256 totalQueued,
        uint256 totalClaimable,
        uint256 pendingCount,
        uint64 timestamp
    );

    constructor(IERC20 asset_, IERC4626 pool_, uint256 minRequestAssets_, uint16 bufferBps_)
        ERC4626(asset_)
        ERC20("Queue Vault USDC", "qvUSDC")
        Ownable(msg.sender)
    {
        if (address(pool_) == address(0)) revert ZeroAddress();
        POOL = pool_;
        MIN_REQUEST_ASSETS = minRequestAssets_;
        BUFFER_BPS = bufferBps_;
    }

    // ───────────────────────── 现金口径 ─────────────────────────

    /// @notice 金库在池中的资产价值（向下取整，不高估）
    function poolPosition() public view returns (uint256) {
        return POOL.previewRedeem(POOL.balanceOf(address(this)));
    }

    function poolLiquidity() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(POOL));
    }

    /// @notice 可以用来兑付队列的现金（扣掉已确认待领的部分）
    function queueCash() public view returns (uint256) {
        return _subSat(_cash(), totalClaimable);
    }

    /// @notice 可以用来即时提款 / 配置到池子的现金：排队负债优先占用，所以没人能插队
    function instantCash() public view returns (uint256) {
        return _subSat(_cash(), totalClaimable + totalQueuedAssets);
    }

    function pendingCount() public view returns (uint256) {
        return tail - head;
    }

    function getRequest(uint256 id) external view returns (RedeemRequest memory) {
        return _requests[id];
    }

    // ───────────────────────── ERC4626 覆写 ─────────────────────────

    /// @notice 排队负债和待领余额已经不属于留下的份额持有人
    function totalAssets() public view override returns (uint256) {
        return _subSat(_cash() + poolPosition(), totalQueuedAssets + totalClaimable);
    }

    /// @notice ERC4626 要求 max* 反映流动性限制；即时提款只能用超出队列负债的现金
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), instantCash());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(instantCash(), Math.Rounding.Floor));
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        _snapshot(REASON_DEPOSIT, false);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ───────────────────────── 排队 ─────────────────────────

    /// @notice 现金不够时排队赎回：按当前价格锁定应付资产，份额立即销毁
    /// @dev PPS 不下降：a = floor(s·A/S) ≤ s·A/S ⇒ (A−a)/(S−s) ≥ A/S
    function requestRedeem(uint256 shares, address receiver, address owner_)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (receiver == address(0)) revert ZeroAddress();
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        uint256 assets = previewRedeem(shares); // Floor：有利于金库
        if (assets < MIN_REQUEST_ASSETS) revert RequestTooSmall(assets, MIN_REQUEST_ASSETS);

        _burn(owner_, shares);
        id = tail++;
        uint128 a = assets.toUint128();
        _requests[id] = RedeemRequest(owner_, receiver, a, a, uint64(block.timestamp), 0);
        totalQueuedAssets += assets;

        emit RedeemRequested(id, owner_, receiver, shares, assets, uint64(block.timestamp));
        _snapshot(REASON_REQUEST, false);
    }

    /// @notice 先从池里抢回队列缺口，再按 FIFO 兑付最多 maxCount 笔。任何人都能调用。
    /// @dev 结果只由链上状态决定，谁调用都一样；没有工作可做时直接返回，不 revert。
    function settleQueue(uint256 maxCount)
        external
        nonReentrant
        returns (uint256 recalled, uint256 processed, uint256 paid)
    {
        bool wasActive = head < tail;

        // ① 抢流动性：一次取回全部缺口，不受 maxCount 限制（先把钱拿到手，兑付可以分批）
        uint256 qc = queueCash();
        if (totalQueuedAssets > qc) {
            uint256 want = totalQueuedAssets - qc;
            uint256 take = Math.min(want, POOL.maxWithdraw(address(this)));
            if (take > 0) {
                try POOL.withdraw(take, address(this), address(this)) {
                    recalled = take;
                } catch (bytes memory err) {
                    emit RecallFailed(err); // 池子异常也不阻断用闲置现金兑付
                }
            }
            emit Recalled(want, recalled, poolLiquidity());
        }

        // ② FIFO 兑付，队首可部分兑付
        if (maxCount > MAX_SETTLE_PER_CALL) maxCount = MAX_SETTLE_PER_CALL;
        uint256 avail = queueCash();
        uint256 id = head;
        while (processed < maxCount && id < tail && avail > 0) {
            uint256 rid = id;
            RedeemRequest storage r = _requests[rid];
            uint256 pay = Math.min(r.assetsRemaining, avail);

            // Effects：先改完所有状态（CEI）
            r.assetsRemaining -= uint128(pay);
            totalQueuedAssets -= pay;
            avail -= pay;
            paid += pay;
            processed++;
            bool done = r.assetsRemaining == 0;
            if (done) {
                r.settledAt = uint64(block.timestamp);
                id++;
            }
            head = id;

            // Interactions
            _payout(rid, r.receiver, pay);
            emit RedeemSettled(rid, r.receiver, pay, r.assetsRemaining, done);
            if (!done) break; // 现金已经用完
        }

        if (recalled == 0 && processed == 0) {
            emit SettleSkipped(head, queueCash());
            return (0, 0, 0);
        }
        _snapshot(REASON_SETTLED, wasActive);
    }

    /// @notice 领取 push 转账失败后转入的余额
    function claim() external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        IERC20(asset()).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ───────────────────────── 管理人 ─────────────────────────

    /// @notice 把闲置现金存进池子生息；只能动 instantCash 中超出缓冲的部分，队列非空时自然被禁止
    function allocate(uint256 assets) external nonReentrant onlyOwner {
        uint256 floor = totalAssets() * BUFFER_BPS / 10_000;
        uint256 allocatable = _subSat(instantCash(), floor);
        if (assets > allocatable) revert ExceedsAllocatable(assets, allocatable);
        IERC20(asset()).forceApprove(address(POOL), assets);
        POOL.deposit(assets, address(this));
        emit Allocated(assets, _cash());
    }

    // ───────────────────────── 内部 ─────────────────────────

    /// @dev push 失败（例如接收者被代币拉黑）就转成 pull，一个坏接收者不会卡住整条队列
    function _payout(uint256 id, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = asset().call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            claimable[to] += amount;
            totalClaimable += amount;
            emit PayoutDeferred(id, to, amount);
        }
    }

    /// @dev queueActive = 队列非空，或者本次操作刚好把队列清空（让 Reactive 侧的镜像归零）
    function _snapshot(uint8 reason, bool wasActive) internal {
        uint256 pending = tail - head;
        uint256 headRemaining = pending > 0 ? _requests[head].assetsRemaining : 0;
        emit LiquiditySnapshot(
            pending > 0 || wasActive,
            reason,
            ++snapshotSeq,
            queueCash(),
            poolPosition(),
            poolLiquidity(),
            head,
            headRemaining,
            totalQueuedAssets,
            totalClaimable,
            pending,
            uint64(block.timestamp)
        );
    }

    function _cash() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function _subSat(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
