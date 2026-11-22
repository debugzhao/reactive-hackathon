// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MockPool — 测试网用的「精简版 Aave」共享借贷池
/// @notice 只保留一个关键特性：池里的现金先到先得。
///         - 多个存款人（金库、对手）存入拿池份额，份额记账直接复用 ERC4626
///         - 单一借款人借走现金，按时间线性计息
///         - 提款受池内现金限制：谁先 withdraw，谁拿走现金
///         - 借款人还款时 emit Repaid(availableLiquidity)，这是 Reactive 监听的「流动性出现」信号
/// @dev   计息只用 block.timestamp（Base Sepolia 200ms 出块，区块数不可靠）。
contract MockPool is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    error NotBorrower();
    error BorrowerAlreadySet();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error RepayExceedsDebt(uint256 amount, uint256 owed);

    /// @notice 流动性出现：Reactive 订阅这个事件。availableLiquidity = 还款后池内现金
    event Repaid(address indexed payer, uint256 amount, uint256 availableLiquidity, uint64 timestamp);
    event Borrowed(address indexed borrower, uint256 amount, uint256 availableLiquidity, uint64 timestamp);
    /// @notice 每次有人从池里取走现金都 emit，抢流动性实验靠它统计「谁拿到了多少」
    event LiquidityTaken(address indexed lender, uint256 amount, uint256 availableAfter, uint64 timestamp);

    uint256 private constant YEAR = 365 days;

    address public borrower;
    uint256 public principal;
    uint256 public accruedInterest;
    uint64 public lastAccrual;
    uint256 public immutable APR_BPS;

    modifier onlyBorrower() {
        if (msg.sender != borrower) revert NotBorrower();
        _;
    }

    constructor(IERC20 asset_, uint256 aprBps_)
        ERC4626(asset_)
        ERC20("Mock Pool Share", "mpUSDC")
        Ownable(msg.sender)
    {
        APR_BPS = aprBps_;
        lastAccrual = uint64(block.timestamp);
    }

    /// @notice 只能设置一次，避免 owner 中途换借款人
    function setBorrower(address borrower_) external onlyOwner {
        if (borrower != address(0)) revert BorrowerAlreadySet();
        borrower = borrower_;
    }

    // ───────────────────────── 借款人 ─────────────────────────

    /// @notice 借款人当前欠款（本金 + 已结利息 + 未结利息），向下取整，不高估池子资产
    function owed() public view returns (uint256) {
        return principal + accruedInterest + _pendingInterest();
    }

    function liquidity() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function borrow(uint256 amount) external onlyBorrower {
        _accrue();
        uint256 liq = liquidity();
        if (amount > liq) revert InsufficientLiquidity(amount, liq);
        principal += amount;
        IERC20(asset()).safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount, liquidity(), uint64(block.timestamp));
    }

    /// @notice 任何人都能替借款人还款；先抵利息，再抵本金
    /// @dev 还款让现金 +x、owed −x，所以池子的 PPS 不变，不会出现「还款前存、还款后取」的收益狙击
    function repay(uint256 amount) external {
        _accrue();
        uint256 debt = principal + accruedInterest;
        if (amount > debt) revert RepayExceedsDebt(amount, debt);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        if (amount <= accruedInterest) {
            accruedInterest -= amount;
        } else {
            principal -= amount - accruedInterest;
            accruedInterest = 0;
        }
        emit Repaid(msg.sender, amount, liquidity(), uint64(block.timestamp));
    }

    // ───────────────────────── ERC4626 覆写 ─────────────────────────

    function totalAssets() public view override returns (uint256) {
        return liquidity() + owed();
    }

    /// @notice 先到先得的核心：能取的不超过池内现金
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), liquidity());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(liquidity(), Math.Rounding.Floor));
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        super._withdraw(caller, receiver, owner_, assets, shares);
        emit LiquidityTaken(owner_, assets, liquidity(), uint64(block.timestamp));
    }

    /// @dev 虚拟份额，防通胀攻击
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ───────────────────────── 内部 ─────────────────────────

    function _pendingInterest() internal view returns (uint256) {
        return principal * APR_BPS * (block.timestamp - lastAccrual) / (10_000 * YEAR);
    }

    function _accrue() internal {
        accruedInterest += _pendingInterest();
        lastAccrual = uint64(block.timestamp);
    }
}
