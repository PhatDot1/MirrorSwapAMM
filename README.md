# Mirror + Instanton AMM

**A dual-representation liquidity system for Hyperliquid**

---

## TL;DR

This protocol manages **one pool of liquidity** that can be expressed in **two equivalent ways**:

1. As a continuous pricing function (AMM)
2. As discrete limit orders (orderbook)

Which representation is used depends on market conditions, but the underlying liquidity state is always the same.

When conditions cross defined thresholds—inventory limits, volatility spikes, oracle degradation—capital moves **discretely** between venues instead of being continuously optimized.

**That dual description + discrete jumps is what we call "Mirror Symmetry + Instantons."**

---

## What This Is

A hybrid AMM designed specifically for Hyperliquid that:

- Prices trades using a smooth on-chain curve
- Can express the same liquidity as explicit orderbook orders
- Reallocates capital in discrete steps when risk changes

It exploits Hyperliquid's unique split architecture:

| Layer | Purpose |
|-------|---------|
| **HyperEVM** | Programmable state & swaps |
| **HyperCore** | High-performance orderbooks |

---

## Core Idea (One Sentence)

> One liquidity state, two equivalent representations, chosen dynamically—with discrete jumps between venues when thresholds are crossed.

---

## The Canonical Liquidity State

Everything in the system derives from one shared state:

```
Liquidity State = (q, pRef, θ)
```

| Symbol | Meaning |
|--------|---------|
| `q` | Current inventory (net long/short position) |
| `pRef` | Oracle-anchored reference price |
| `θ = {λ, η, s}` | Risk parameters controlling curvature and spread |

This state exists **independently** of where liquidity is deployed.

---

## Two Representations, Same Liquidity

### Representation A: AMM (Continuous)

**What it is:** A pricing function that computes prices on demand based on inventory.

```
price(q) = pRef · (1 + λ·q + tanh(q / η))
```

**What question it answers:** "If someone trades right now, what price should I quote?"

**Properties:**
- Continuous
- Reactive
- No stored orders
- Capital efficient for small trades

---

### Representation B: Orderbook (Discrete)

**What it is:** Explicit limit orders placed at prices derived from the same pricing function.

**How it's derived:**
1. Sample the AMM curve at different inventory levels
2. Place bids/asks at those prices
3. Sizes determined by risk caps

**What question it answers:** "Where should I place bids and asks in advance?"

**Properties:**
- Discrete
- Executable
- Explicit commitments
- Safer under stress

---

## What "Mirror Symmetry" Means (No Physics)

**Mirror symmetry = the same liquidity, described in two equivalent ways.**

| AMM View | Orderbook View |
|----------|----------------|
| Continuous curve | Discrete price levels |
| Computed on trade | Pre-committed orders |
| Smooth & reactive | Granular & executable |

They are **not** different strategies. They are **different representations of the same thing.**

Change the state `(q, pRef, θ)` → both representations change together.

**That's the mirror.**

---

## This Is NOT "Switching Regimes"

A regime switch would mean:
- AMM logic changes
- Orderbook logic changes
- Different pricing rules apply

**That is NOT what happens here.**

Instead:
- The pricing logic is **fixed**
- Only the **expression** changes

Think of it like: a smooth curve vs. a polyline approximation of that curve.

Same object. Different resolution.

---

## When the System Switches Representations

The system doesn't always use both at once. It chooses the representation that best fits current conditions.

### Trigger 1: Inventory Pressure

- `|q|` grows large
- AMM prices become very skewed
- Explicit orders are safer
- **→ Express liquidity as orderbook orders**

### Trigger 2: Volatility Spike

- Oracle variance increases
- AMM becomes too reactive
- Risk of being picked off
- **→ Widen and step back via orderbook**

### Trigger 3: Calm Markets

- Low volatility
- Small trades
- Inventory near zero
- **→ AMM is more capital efficient**

---

## What "Instantons" Mean (Still No Physics)

**Core insight:** Some changes should be smooth. Some changes should be decisions.

### Smooth Changes
- Small trades
- Normal volatility
- Gradual inventory drift

*Handled by:* Continuous AMM pricing

### Discrete Changes
- Inventory hits a hard limit
- Oracle becomes stale
- Volatility regime changes

*Handled by:* Explicit capital jumps:
- AMM → orderbook
- Orderbook → AMM
- (Future) → yield

**These are not gradual optimizations. They are threshold-triggered actions.**

That's what we call an **instanton**.

---

## What We Borrow From Physics (Metaphorically)

### Mirror Symmetry (Conceptual)
- Same object, two equivalent descriptions
- Continuous ↔ discrete
- State-based ↔ instruction-based

### Instantons (Conceptual)
- Most evolution is smooth
- Some transitions are discrete and irreversible
- Triggered by thresholds, not gradients

### What We Explicitly Do NOT Claim

- No real Calabi–Yau geometry
- No path integrals
- No literal physics

**This is mechanism design, using physics language as a structuring metaphor, not as math.**

---

## Why This Design Matters

| Benefit | Explanation |
|---------|-------------|
| **Hyperliquid-native** | Exploits the HyperEVM + HyperCore split directly |
| **Enables new strategies** | Impossible on pure AMMs |
| **Clean separation** | Slow-moving state vs. fast execution |
| **Easy to reason about** | Mental model is simple once you get it |
| **Easy to extend** | Add new venues (yield, etc.) without redesign |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Canonical State                          │
│                   (q, pRef, θ)                              │
└─────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼                               ▼
┌─────────────────────┐       ┌─────────────────────┐
│   AMM (HyperEVM)    │       │ Orderbook (HyperCore)│
│                     │       │                      │
│  Continuous pricing │◄─────►│  Discrete orders     │
│  Computed on-demand │ Mirror│  Pre-committed       │
└─────────────────────┘       └─────────────────────┘
          │                               │
          └───────────────┬───────────────┘
                          │
                    ┌─────┴─────┐
                    │ Instanton │
                    │  Triggers │
                    └───────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         Inventory   Volatility    Oracle
          Limits      Spikes     Staleness
```

---

## Repo Structure

```
contracts/
├── MirrorState.sol         # Canonical liquidity state
├── MirrorAMM.sol           # Continuous pricing
└── InstantonAllocator.sol  # Threshold-based capital jumps

scripts/
├── deploy/                 # Deployment scripts
├── oracle/                 # Oracle lifecycle management
└── demos/                  # AMM swap demonstrations

paper/
└── mirror_symmetric_amm.tex  # Full formal writeup
```

---

## Key Contracts

### MirrorState.sol
Stores the canonical liquidity state `(q, pRef, θ)`. Updated by the keeper. Read by both AMM and allocation logic.

### MirrorAMM.sol
Implements the continuous pricing function. Executes swaps. Reads HyperCore state via precompiles for safety checks.

### InstantonAllocator.sol
Monitors threshold conditions. Triggers discrete capital reallocation between AMM and orderbook venues.

---

## The Pricing Function

The AMM uses a potential-based pricing model:

```
log P(q) = c + λq + tanh(q/η)
```

Where:
- `c = log(pRef)` — centers the curve at the reference price
- `λq` — linear price impact (standard market-making)
- `tanh(q/η)` — saturation at inventory boundaries

**Why tanh?** It's not arbitrary. It emerges from optimizing LP profit under bounded inventory constraints. As inventory approaches limits, prices must diverge to discourage further trades in that direction. The tanh function smoothly implements this.

---

## Safety Features

### Oracle Validation
- **Normal:** Execute at computed price
- **Mild deviation:** Widen spread, cap trade size
- **Severe deviation:** Revert transaction

### Circuit Breakers
- Oracle deviation > threshold
- Data staleness > critical time
- Inventory exceeds maximum
- Admin emergency trigger

### Parameter Bounds
All risk parameters have hard limits that cannot be exceeded by keepers or strategists.

---

## One-Paragraph Summary

This protocol treats liquidity as something that can be described in two equivalent ways: as a smooth pricing function or as discrete limit orders. Most systems pick one. Hyperliquid allows both. We keep a single canonical liquidity state, express it continuously when markets are calm, and switch to discrete execution when conditions demand it. The switch itself is not gradual—it happens when a threshold is crossed. That dual description, and the discrete jumps between them, is what we mean by "mirror symmetry plus instantons."

---

## Getting Started

```bash
# Clone the repo
git clone <repo-url>
cd mirror-instanton-amm

# Install dependencies
npm install

# Deploy contracts (testnet)
npx hardhat run scripts/deploy/deploy.js --network hyperliquid-testnet

# Run keeper
node scripts/oracle/keeper.js
```

---

[TODO]