// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract FthgGameBridge is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant GAME_SERVICE_ROLE = keccak256("GAME_SERVICE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant INITIAL_FTHDOLLARS_PER_FTHG = 1_000 ether;
    uint16 public constant MAX_BASE_APR_BPS = 10_000;

    IERC20 public immutable fthg;
    uint256 public reserveFthg;
    uint256 public reserveFthDollar;
    uint256 public currentGameYear;
    uint256 public totalStakedFthg;
    uint256 public nextStakeId = 1;
    uint16 public baseAprBps = 600;
    bool public poolInitialized;
    bool public gameClockInitialized;

    struct Stake {
        address account;
        bytes32 gameAccountId;
        uint256 fthgAmount;
        uint256 rewardFthDollar;
        uint256 maturityGameYear;
        bool claimed;
    }

    mapping(uint256 => Stake) public stakes;
    mapping(bytes32 => bool) public usedRedemptionIds;

    event PoolInitialized(uint256 fthgReserve, uint256 fthDollarBudget, uint256 initialRate);
    event FthgReserveAdded(uint256 amount, uint256 reserveFthg);
    event FthDollarBudgetAdded(uint256 amount, uint256 reserveFthDollar);
    event BaseAprChanged(uint16 oldAprBps, uint16 newAprBps);
    event GameYearUpdated(uint256 oldGameYear, uint256 newGameYear);
    event FthgConverted(address indexed account, bytes32 indexed gameAccountId, uint256 fthgIn, uint256 fthDollarOut, uint256 reserveFthg, uint256 reserveFthDollar);
    event FthDollarRedeemed(bytes32 indexed redemptionId, bytes32 indexed gameAccountId, address indexed recipient, uint256 fthDollarIn, uint256 fthgOut, uint256 reserveFthg, uint256 reserveFthDollar);
    event FthgStaked(uint256 indexed stakeId, address indexed account, bytes32 indexed gameAccountId, uint256 fthgAmount, uint8 termYears, uint256 maturityGameYear, uint256 rewardFthDollar, uint256 lockedRate);
    event StakeClaimed(uint256 indexed stakeId, address indexed account, bytes32 indexed gameAccountId, uint256 fthgReturned, uint256 rewardFthDollar);

    error ZeroAddress();
    error ZeroAmount();
    error PoolNotInitialized();
    error PoolAlreadyInitialized();
    error InvalidPoolSeed();
    error InvalidQuote();
    error UnsupportedTerm();
    error InsufficientBudget();
    error GameYearCannotDecrease();
    error StakeNotFound();
    error StakeNotMature();
    error StakeAlreadyClaimed();
    error RedemptionAlreadyUsed();
    error RedemptionExpired();
    error GameClockUnavailable();

    constructor(address token, address sourceAdmin, address reserveAdmin, address gameService) {
        if (token == address(0) || sourceAdmin == address(0) || reserveAdmin == address(0) || gameService == address(0)) revert ZeroAddress();
        fthg = IERC20(token);
        _grantRole(DEFAULT_ADMIN_ROLE, sourceAdmin);
        _grantRole(DEFAULT_ADMIN_ROLE, reserveAdmin);
        _grantRole(TREASURY_ROLE, sourceAdmin);
        _grantRole(TREASURY_ROLE, reserveAdmin);
        _grantRole(PAUSER_ROLE, sourceAdmin);
        _grantRole(PAUSER_ROLE, reserveAdmin);
        _grantRole(GAME_SERVICE_ROLE, gameService);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function initializePool(uint256 fthDollarBudget) external onlyRole(TREASURY_ROLE) {
        if (poolInitialized) revert PoolAlreadyInitialized();
        uint256 deposited = fthg.balanceOf(address(this));
        if (deposited == 0 || fthDollarBudget == 0
            || fthDollarBudget != deposited * INITIAL_FTHDOLLARS_PER_FTHG / 1 ether) revert InvalidPoolSeed();
        reserveFthg = deposited;
        reserveFthDollar = fthDollarBudget;
        poolInitialized = true;
        emit PoolInitialized(deposited, fthDollarBudget, INITIAL_FTHDOLLARS_PER_FTHG);
    }

    function addFthDollarBudget(uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (!poolInitialized || reserveFthg == 0) revert PoolNotInitialized();
        if (amount == 0) revert ZeroAmount();
        reserveFthDollar += amount;
        emit FthDollarBudgetAdded(amount, reserveFthDollar);
    }

    function syncDepositedFthg() external onlyRole(TREASURY_ROLE) {
        if (!poolInitialized) revert PoolNotInitialized();
        uint256 actualBalance = fthg.balanceOf(address(this));
        uint256 accountedBalance = reserveFthg + totalStakedFthg;
        if (actualBalance <= accountedBalance) revert ZeroAmount();
        uint256 added = actualBalance - accountedBalance;
        reserveFthg += added;
        emit FthgReserveAdded(added, reserveFthg);
    }

    function setBaseAprBps(uint16 newAprBps) external onlyRole(TREASURY_ROLE) {
        if (newAprBps > MAX_BASE_APR_BPS) revert InvalidQuote();
        emit BaseAprChanged(baseAprBps, newAprBps);
        baseAprBps = newAprBps;
    }

    function setGameYear(uint256 newGameYear) external onlyRole(GAME_SERVICE_ROLE) {
        if (newGameYear < currentGameYear) revert GameYearCannotDecrease();
        emit GameYearUpdated(currentGameYear, newGameYear);
        currentGameYear = newGameYear;
        gameClockInitialized = true;
    }

    function quoteFthDollarOut(uint256 fthgIn) public view returns (uint256) {
        _requirePool();
        if (fthgIn == 0) revert ZeroAmount();
        uint256 newX = reserveFthg + fthgIn;
        return reserveFthDollar - (reserveFthg * reserveFthDollar / newX);
    }

    function quoteFthgOut(uint256 fthDollarIn) public view returns (uint256) {
        _requirePool();
        if (fthDollarIn == 0) revert ZeroAmount();
        uint256 newY = reserveFthDollar + fthDollarIn;
        return reserveFthg - (reserveFthg * reserveFthDollar / newY);
    }

    function spotRate() public view returns (uint256) {
        _requirePool();
        return reserveFthDollar * 1 ether / reserveFthg;
    }

    function convertFthg(uint256 amount, uint256 minFthDollarOut, bytes32 gameAccountId) external whenNotPaused nonReentrant returns (uint256 fthDollarOut) {
        _requirePool();
        if (amount == 0) revert ZeroAmount();
        fthDollarOut = quoteFthDollarOut(amount);
        if (fthDollarOut < minFthDollarOut || fthDollarOut == 0) revert InvalidQuote();
        fthg.safeTransferFrom(msg.sender, address(this), amount);
        reserveFthg += amount;
        reserveFthDollar -= fthDollarOut;
        emit FthgConverted(msg.sender, gameAccountId, amount, fthDollarOut, reserveFthg, reserveFthDollar);
    }

    function redeemFthDollar(uint256 amount, uint256 minFthgOut, address recipient, bytes32 gameAccountId, bytes32 redemptionId, uint256 deadline)
        external onlyRole(GAME_SERVICE_ROLE) whenNotPaused nonReentrant returns (uint256 fthgOut)
    {
        _requirePool();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (redemptionId == bytes32(0)) revert InvalidQuote();
        if (block.timestamp > deadline) revert RedemptionExpired();
        if (usedRedemptionIds[redemptionId]) revert RedemptionAlreadyUsed();
        fthgOut = quoteFthgOut(amount);
        if (fthgOut < minFthgOut || fthgOut == 0) revert InvalidQuote();
        if (fthg.balanceOf(address(this)) < totalStakedFthg + reserveFthg) revert InvalidPoolSeed();
        usedRedemptionIds[redemptionId] = true;
        reserveFthg -= fthgOut;
        reserveFthDollar += amount;
        fthg.safeTransfer(recipient, fthgOut);
        emit FthDollarRedeemed(redemptionId, gameAccountId, recipient, amount, fthgOut, reserveFthg, reserveFthDollar);
    }

    function stake(uint256 amount, uint8 termYears, bytes32 gameAccountId) external whenNotPaused nonReentrant returns (uint256 stakeId) {
        _requirePool();
        if (!gameClockInitialized) revert GameClockUnavailable();
        if (amount == 0) revert ZeroAmount();
        if (termYears != 1 && termYears != 2 && termYears != 5 && termYears != 10 && termYears != 20 && termYears != 30) revert UnsupportedTerm();
        uint256 rate = spotRate();
        uint256 fthgInterest = amount * baseAprBps * termYears / 10_000;
        uint256 reward = fthgInterest * rate / 1 ether;
        if (reward == 0 || reward > reserveFthDollar) revert InsufficientBudget();
        stakeId = nextStakeId++;
        uint256 maturity = currentGameYear + termYears;
        stakes[stakeId] = Stake(msg.sender, gameAccountId, amount, reward, maturity, false);
        totalStakedFthg += amount;
        reserveFthDollar -= reward;
        fthg.safeTransferFrom(msg.sender, address(this), amount);
        emit FthgStaked(stakeId, msg.sender, gameAccountId, amount, termYears, maturity, reward, rate);
    }

    function claimStake(uint256 stakeId) external nonReentrant {
        Stake storage position = stakes[stakeId];
        if (position.account == address(0)) revert StakeNotFound();
        if (position.claimed) revert StakeAlreadyClaimed();
        if (currentGameYear < position.maturityGameYear) revert StakeNotMature();
        position.claimed = true;
        totalStakedFthg -= position.fthgAmount;
        fthg.safeTransfer(position.account, position.fthgAmount);
        emit StakeClaimed(stakeId, position.account, position.gameAccountId, position.fthgAmount, position.rewardFthDollar);
    }

    function _requirePool() private view {
        if (!poolInitialized || reserveFthg == 0 || reserveFthDollar == 0) revert PoolNotInitialized();
    }
}
