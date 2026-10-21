# Documentation

## Task 1a, Documentation
[Task1a_Documentation.pdf](https://github.com/user-attachments/files/33140469/Task1a_Documentation.pdf)
 ### Test Outcomes
 <img width="458" height="143" alt="image" src="https://github.com/user-attachments/assets/e629e214-fa8a-4219-837f-d12a5d41232f" />
 
## Task 1b, PHASE 2
[Phase2_Trading_Documentation.pdf](https://github.com/user-attachments/files/33754066/Phase2_Trading_Documentation.pdf)

## Task 1b, PHASE 3 & 5
Resolution is done with `resolve(outcomeId)` and Phase 5 adds the timeout and refunds in `Market.sol`.

- `resolve()` can only be called by the arbitrator, after endTime, once, and within 7 days of endTime
- if the arbitrator doesn't resolve within 7 days the market becomes Expired
- in an expired market everyone can call `claimRefund()` to get back what they put in (traders and the creator's seed), and their shares are burned
- `status()` returns 0 Upcoming, 1 Open, 2 Closed, 3 Resolved, 4 Expired

### Test Outcomes
```
cd prediction-market
npm install
npx hardhat test
```
126 passing (97 existing + 29 new in `test/Expiry.test.js`). Market.sol coverage: 100% lines.

```
Phase 5: expiry and timeout
  status() lifecycle
    ✔ resolution deadline is endTime + 7 days
    ✔ Upcoming → Open → Closed → Resolved
    ✔ Closed → Expired exactly at the deadline when nobody resolves
    ✔ a resolved market never becomes Expired
  resolution deadline
    ✔ arbitrator can still resolve one second before the deadline
    ✔ arbitrator cannot resolve at or after the deadline
    ✔ the arbitrator check still comes first after expiry
  no trading after endTime or expiry
    ✔ buying after endTime is rejected
    ✔ buying in an expired market is rejected
    ✔ an expired market cannot be redeemed as if resolved
  collateral tracking
    ✔ records the creator's seed and every trader's ETH
    ✔ contract balance equals the total recorded collateral
  markExpired()
    ✔ cannot be called before the deadline
    ✔ anyone can call it after the deadline; emits MarketTimedOut
    ✔ cannot be called twice
    ✔ cannot expire a resolved market
  claimRefund()
    ✔ is not allowed before expiry
    ✔ is not allowed in a resolved market, even much later
    ✔ first refund marks the market expired and emits MarketTimedOut + Refunded
    ✔ every trader gets back exactly what they paid
    ✔ the creator gets the seed back
    ✔ after everyone is refunded the contract is empty
    ✔ burns the refunded trader's shares of every outcome
    ✔ double refund is rejected
    ✔ an account that never paid has nothing to refund
    ✔ refunds go to the payer, not to whoever holds transferred shares (known limitation)
  3-outcome market
    ✔ refunds and burns across all three outcomes
  ETH transfer failure and reentrancy
    ✔ re-entering claimRefund() from inside the refund is blocked; it is paid exactly once
    ✔ a recipient that rejects ETH makes the refund revert; nothing is burned or cleared

29 passing
```

### Remix Demo (resolution)
Tested on Remix VM. Account 1 created the market and Account 2 is the arbitrator.
These were recorded on our earlier version where the function was called `resolveMarket()`. It is now `resolve()` with the same checks and errors.

**1. Create market**

![create market](docs/task1b/fig1-create-market.png)

**2. Creator tries to resolve - reverts with NotArbitrator**

![not arbitrator](docs/task1b/fig2-not-arbitrator.png)

**3. Arbitrator tries to resolve before end time - reverts with MarketNotEnded**

![market not ended](docs/task1b/fig3-market-not-ended.png)

**4. Arbitrator resolves after end time (outcome 0 = YES)**

![resolve success](docs/task1b/fig4-resolve-success.png)

**5. status() = 3 (Resolved), winningOutcome() = 0**

![resolved state](docs/task1b/fig5-resolved-state.png)

**6. Resolving again - reverts with AlreadyResolved**

![already resolved](docs/task1b/fig6-already-resolved.png)

Expiry and refunds are shown in the tests above since they need 7 days to pass, which Remix can't skip.
