// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../Market.sol";

/**
 * @dev TEST ONLY. A contract trader used to attack the payout path.
 *      Normal       - behaves like an ordinary holder.
 *      RejectEther  - its receive() reverts, so the Market's ETH payout fails.
 *      Reenter      - when it receives its payout it tries to redeem again; the Market's
 *                     reentrancy guard must block that call.
 *      Do not deploy outside tests.
 */
contract ReentrantRedeemer is IERC1155Receiver, ERC165 {
    enum Mode { Normal, RejectEther, Reenter }

    Mode public mode;
    Market public market;
    bool public reentryAttempted;
    bool public reentryBlocked;
    bool public reentrySucceeded;

    function setMode(Mode m) external {
        mode = m;
    }

    function buy(Market m, uint256 outcomeId) external payable {
        market = m;
        m.buyOutcomeTokens{value: msg.value}(outcomeId, 0);
    }

    function claim() external {
        market.claimPayout();
    }

    function redeem(uint256 shares) external {
        market.redeem(shares);
    }

    receive() external payable {
        if (mode == Mode.RejectEther) revert("no ether accepted");
        if (mode == Mode.Reenter && !reentryAttempted) {
            reentryAttempted = true;
            try market.redeem(1) {
                reentrySucceeded = true;
            } catch {
                reentryBlocked = true;
            }
        }
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
