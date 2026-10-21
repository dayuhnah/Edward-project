# Documentation

## Task 1a, Documentation
[Task1a_Documentation.pdf](https://github.com/user-attachments/files/33140469/Task1a_Documentation.pdf)
 ### Test Outcomes
 <img width="458" height="143" alt="image" src="https://github.com/user-attachments/assets/e629e214-fa8a-4219-837f-d12a5d41232f" />

## Task 1b, Resolution (Phase 3)
### Remix Demo
Tested on Remix VM. Account 1 created the market and Account 2 is the arbitrator.

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
