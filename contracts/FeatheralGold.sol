// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Featheral Gold (FTHG)
/// @notice Utility / economy-stabilizing token for Featheral World (featheral.com).
///         1 FTHG = 1 kg of the world's above-ground gold. The total supply is minted once at
///         deployment, can never be increased or burned, and equals the world gold stock
///         (World Gold Council, end-2024: 216,265 tonnes = 216,265,000 kg).
///         FTHG can be exchanged for the in-game currency Featheral Dollar (FTH$).
contract FeatheralGold is ERC20, ERC20Permit, AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    /// @notice Fixed total supply: 216,265,000 kg of gold, 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 216_265_000 ether;

    string public metadataURI;
    address public treasury;
    /// @notice FTH$ credited per 1 FTHG (1e18 units), set by treasury to stabilize the economy.
    uint256 public fthDollarPerFthg;
    bool public gameExchangeEnabled;
    mapping(address => bool) public blacklisted;

    event MetadataURIChanged(string uri);
    event BlacklistChanged(address indexed account, bool status);
    event RateChanged(uint256 oldRate, uint256 newRate);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event GameExchangeToggled(bool enabled);
    /// @dev Listened to by the Featheral World backend to credit FTH$ to `gameAccountId`.
    ///      FTHG is moved to the treasury (not burned) so total supply stays fixed.
    event ExchangedForFthDollar(address indexed account, bytes32 indexed gameAccountId, uint256 fthgAmount, uint256 fthDollars);

    error Blacklisted(address account);
    error ExchangeDisabled();
    error InvalidRate();
    error ZeroAddress();
    error ZeroAmount();

    constructor(address admin) ERC20("Featheral Gold", "FTHG") ERC20Permit("Featheral Gold") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(COMPLIANCE_ROLE, admin);
        _grantRole(TREASURY_ROLE, admin);
        treasury = admin;
        emit TreasuryChanged(address(0), admin);
        _mint(admin, TOTAL_SUPPLY);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function setMetadataURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        metadataURI = uri;
        emit MetadataURIChanged(uri);
    }

    function setBlacklisted(address account, bool status) external onlyRole(COMPLIANCE_ROLE) {
        blacklisted[account] = status;
        emit BlacklistChanged(account, status);
    }

    function setRate(uint256 newRate) external onlyRole(TREASURY_ROLE) {
        if (newRate == 0) revert InvalidRate();
        emit RateChanged(fthDollarPerFthg, newRate);
        fthDollarPerFthg = newRate;
    }

    function setTreasury(address newTreasury) external onlyRole(TREASURY_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setGameExchangeEnabled(bool enabled) external onlyRole(TREASURY_ROLE) {
        if (enabled && fthDollarPerFthg == 0) revert InvalidRate();
        gameExchangeEnabled = enabled;
        emit GameExchangeToggled(enabled);
    }

    /// @notice Send FTHG to the treasury and request an FTH$ credit for a Featheral World account.
    function exchangeForFthDollar(uint256 amount, bytes32 gameAccountId) external {
        if (!gameExchangeEnabled) revert ExchangeDisabled();
        if (amount == 0) revert ZeroAmount();
        uint256 fthDollars = (amount * fthDollarPerFthg) / 1e18;
        _transfer(msg.sender, treasury, amount);
        emit ExchangedForFthDollar(msg.sender, gameAccountId, amount, fthDollars);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused()) revert EnforcedPause();
        if (blacklisted[from]) revert Blacklisted(from);
        if (blacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}
