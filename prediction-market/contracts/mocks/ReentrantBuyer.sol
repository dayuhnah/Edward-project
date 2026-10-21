// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../Market.sol";

/**
 * @dev TEST ONLY. A malicious buyer: when the Market mints shares to it, the ERC-1155
 *      receiver hook tries to call buyOutcomeTokens() again. The reentrancy guard must
 *      block the inner call. Do not deploy outside tests.
 */
contract ReentrantBuyer is IERC1155Receiver, ERC165 {
    Market public market;
    bool public attempted;
    bool public reentrancyBlocked;
    bool public reentrancySucceeded;

    /// @param amount Wei used for the outer buy. Send `2 * amount` so the hook has funds.
    function attack(Market m, uint256 amount) external payable {
        market = m;
        m.buyOutcomeTokens{value: amount}(0, 0);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        if (!attempted) {
            attempted = true;
            try market.buyOutcomeTokens{value: address(this).balance}(0, 0) {
                reentrancySucceeded = true;
            } catch {
                reentrancyBlocked = true;
            }
        }
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

    receive() external payable {}
}
