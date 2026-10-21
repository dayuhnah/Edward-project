// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../Market.sol";

/**
 * @dev TEST ONLY. A contract trader used to attack the refund path of an expired market.
 *      Normal       - takes its refund like an ordinary trader.
 *      RejectEther  - its receive() reverts, so the refund transfer fails.
 *      Reenter      - when it receives its refund it calls claimRefund() again; the
 *                     Market's reentrancy guard must block that call.
 *      Do not deploy outside tests.
 */
contract ReentrantRefunder is IERC1155Receiver, ERC165 {
    enum Mode { Normal, RejectEther, Reenter }

    Mode public mode;
    Market public market;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function setMode(Mode m) external {
        mode = m;
    }

    function buy(Market m, uint256 outcomeId) external payable {
        market = m;
        m.buyOutcomeTokens{value: msg.value}(outcomeId, 0);
    }

    function refund() external {
        market.claimRefund();
    }

    receive() external payable {
        if (mode == Mode.RejectEther) revert("no ETH");
        if (mode == Mode.Reenter && !reentryAttempted) {
            reentryAttempted = true;
            try market.claimRefund() { reentrySucceeded = true; } catch {}
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

    function supportsInterface(bytes4 id) public view override(ERC165, IERC165) returns (bool) {
        return id == type(IERC1155Receiver).interfaceId || super.supportsInterface(id);
    }
}
