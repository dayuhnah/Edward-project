// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev TEST ONLY. Pushes ETH into a contract without calling any of its functions,
 *      using selfdestruct from the constructor (still allowed after Cancun).
 *      Used to check that unexpected ETH cannot break the Market's accounting.
 *      Do not deploy outside tests.
 */
contract ForceSender {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
