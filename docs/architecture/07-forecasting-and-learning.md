# Forecasting across time horizons

## First forecast: explainable operational spending

The demo forecasts department/project/category spending through the quarter. It does not claim to implement a complete accounting ledger, cash-flow model, revenue recognition system, or investment advisor.

Use a deterministic baseline with explicit components:

`quarter estimate = actual spend to cutoff + outstanding expected commitments + uncommitted remaining baseline`

The remaining baseline must exclude obligations already represented by commitments. Reconcile recurring vendor/category periods by stable obligation IDs or explicit schedules. Simply adding historical run rate to all commitments would double-count known subscriptions and purchase obligations.

## Forecast inputs

- Posted financial activity with corrections and currency.
- Remaining commitments and expected timing.
- Recurring obligations and contract schedules.
- Project-tagged usage quantities and prices.
- A documented historical window for uncommitted variable spending.
- Source coverage, freshness, period boundaries, and business calendar.

The first implementation is single-currency USD. Additional currencies require an explicit rate source, valuation time, rounding rules, and separate original amounts.

## Role of the model

The model selects approved analyses, identifies candidate drivers, proposes structured assumptions, and explains computed differences with citations. It cannot invent a number and store it as a calculated forecast result.

For Atlas, observed GPU usage may be increasing while a repository issue describes repeated training runs. The measured forecast increase comes from usage and spending data. The issue supports a possible explanation; it does not prove causality or justify automatic budget expansion.

A scenario such as “reduce training runs by 20% next month” becomes a typed assumption bounded by schema and scope permissions. The forecasting code recalculates the result. Scenario outputs remain separate from the baseline and never change budgets on their own.

## Snapshots and traceability

Each run records scope, currency, as-of cutoff, source watermarks, input record/projection versions, calculation version, assumptions, totals, component contributions, and coverage warnings. Persist the snapshot immutably and maintain a separate pointer to the latest completed run.

A consistent cutoff means every included projection has processed the required source range. If one connector lags, publish a clearly qualified partial forecast or wait according to the run's policy. The label must state which data is missing. Processing time is not a substitute for source coverage.

Compare snapshots using calculated contribution deltas: newly recognized spend, changes in commitments, changed recurring obligations, and changed variable baseline. The narrative cites these deltas rather than reconstructing arithmetic from prose.

## Update strategy

Financial events schedule a coalesced P1 refresh for affected scopes. Aggregate upward from project to department/company without counting a shared cost twice. Broad scenario exploration is P2 work; a user-requested scoped calculation can be P0 with bounded execution.

Late or corrected events invalidate the affected historical buckets and forecast inputs. Retain old snapshots for explaining what leadership saw at the time, and issue a new snapshot with a correction relationship.

## Honest uncertainty

Start with low/base/high scenarios based on named assumptions. Call them sensitivity ranges, not calibrated probabilities. Statistical prediction intervals require a model and evidence of calibration.

Missing sources, incomplete history, unmatched transactions, and uncertain commitments appear as coverage warnings. A forecast with fewer known expenses should not look healthier simply because a connector stopped updating.

## What the system learns

As actual outcomes arrive, calculate forecast error by horizon and scope, measure which baselines are systematically biased, and retain confirmed business context. Authorized review can approve improved forecasting parameters after evaluation.

Decision outcomes also become retrievable precedent: a previous exception may explain why a human approved a similar request. It does not authorize the next one. Observed outcomes, hypotheses, and policy remain distinct data classes.
