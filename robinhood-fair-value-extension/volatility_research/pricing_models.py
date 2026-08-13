"""Generic European and American option-pricing models.

All public inputs use the conventions already used by FairVal: volatility,
rate and dividend yield are annualized percentages; DTE is calendar days.
The module is deliberately side-effect free.  It prices research scenarios and
never submits orders or executes hedges.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import math
import time
from typing import Any, Protocol

import numpy as np

from .black_scholes import black_scholes_greeks, black_scholes_price


MIN_TIME_YEARS = 1.0 / (365.0 * 24.0 * 60.0)


@dataclass(frozen=True)
class PricingInputs:
    spot: float
    strike: float
    dte: float
    volatility: float
    rate: float = 0.0
    dividend: float = 0.0
    option_type: str = "call"
    exercise_style: str = "european"
    discrete_dividends: tuple[tuple[float, float], ...] = ()

    @property
    def time_years(self) -> float:
        return max(float(self.dte) / 365.0, MIN_TIME_YEARS)

    def validated(self) -> "PricingInputs":
        values = (self.spot, self.strike, self.dte, self.volatility, self.rate, self.dividend)
        if not all(math.isfinite(float(value)) for value in values):
            raise ValueError("pricing inputs must be finite")
        if self.spot <= 0 or self.strike <= 0:
            raise ValueError("spot and strike must be positive")
        if self.dte < 0:
            raise ValueError("DTE cannot be negative")
        if self.volatility <= 0:
            raise ValueError("volatility must be positive")
        if self.option_type.lower() not in {"call", "put"}:
            raise ValueError("option_type must be 'call' or 'put'")
        if self.exercise_style.lower() not in {"european", "american"}:
            raise ValueError("exercise_style must be 'european' or 'american'")
        for days, amount in self.discrete_dividends:
            if not math.isfinite(float(days)) or not math.isfinite(float(amount)) or days <= 0 or amount <= 0:
                raise ValueError("discrete dividends must contain positive finite (days, amount) pairs")
        return self


@dataclass(frozen=True)
class Greeks:
    delta: float
    gamma: float
    theta: float
    vega: float
    rho: float


@dataclass
class PricingResult:
    price: float
    model: str
    converged: bool = True
    warning: str | None = None
    steps: int | None = None
    runtime_ms: float = 0.0
    early_exercise_premium: float = 0.0
    exercise_boundary: list[dict[str, float | int]] = field(default_factory=list)
    greeks: Greeks | None = None
    convergence_error: float | None = None
    convergence_tolerance: float | None = None
    max_steps: int | None = None
    convergence_status: str = "not_applicable"
    convergence_history: list[dict[str, Any]] = field(default_factory=list)
    numerical_method: str | None = None


@dataclass(frozen=True)
class IVResult:
    volatility: float | None
    converged: bool
    status: str
    reason: str | None
    iterations: int
    lower_bound: float
    upper_bound: float
    residual: float | None = None


class PricingModel(Protocol):
    name: str
    exercise_style: str

    def price(self, inputs: PricingInputs) -> float: ...

    def price_diagnostics(self, inputs: PricingInputs) -> PricingResult: ...

    def greeks(self, inputs: PricingInputs) -> Greeks: ...


def _intrinsic(inputs: PricingInputs, spot: float | None = None) -> float:
    value = inputs.spot if spot is None else spot
    return max(value - inputs.strike, 0.0) if inputs.option_type.lower() == "call" else max(inputs.strike - value, 0.0)


def _cash_dividends_before_expiry(inputs: PricingInputs) -> tuple[tuple[float, float], ...]:
    return tuple(sorted(
        ((float(days), float(amount)) for days, amount in inputs.discrete_dividends if days <= inputs.dte + 1e-12),
        key=lambda item: item[0],
    ))


def _cash_dividend_present_value(inputs: PricingInputs, elapsed_years: float = 0.0) -> float:
    rate = inputs.rate / 100.0
    return sum(
        amount * math.exp(-rate * (days / 365.0 - elapsed_years))
        for days, amount in _cash_dividends_before_expiry(inputs)
        if days / 365.0 > elapsed_years + 1e-12
    )


def _escrowed_dividend_inputs(inputs: PricingInputs) -> PricingInputs:
    present_value = _cash_dividend_present_value(inputs)
    if present_value <= 0:
        return inputs
    adjusted_spot = inputs.spot - present_value
    if adjusted_spot <= 0:
        raise ValueError("cash-dividend present value must be below spot")
    return replace(inputs, spot=adjusted_spot, discrete_dividends=())


def _european_lower_bound(inputs: PricingInputs) -> float:
    t = inputs.time_years
    discounted_spot = inputs.spot * math.exp(-(inputs.dividend / 100.0) * t)
    discounted_strike = inputs.strike * math.exp(-(inputs.rate / 100.0) * t)
    if inputs.option_type.lower() == "call":
        return max(discounted_spot - discounted_strike, 0.0)
    return max(discounted_strike - discounted_spot, 0.0)


def _price_scalar(inputs: PricingInputs, dividend_adjusted: bool = True) -> float:
    value = black_scholes_price(
        inputs.spot,
        inputs.strike,
        inputs.dte,
        inputs.volatility,
        inputs.rate,
        inputs.dividend if dividend_adjusted else 0.0,
        inputs.option_type,
    )
    return float(np.asarray(value).item())


class BlackScholesModel:
    exercise_style = "european"

    def __init__(self, dividend_adjusted: bool = True) -> None:
        self.dividend_adjusted = dividend_adjusted
        self.name = "black_scholes_dividend_adjusted" if dividend_adjusted else "black_scholes_european"

    def _inputs(self, inputs: PricingInputs) -> PricingInputs:
        inputs.validated()
        clean = _escrowed_dividend_inputs(inputs)
        return clean if self.dividend_adjusted else replace(clean, dividend=0.0)

    def price(self, inputs: PricingInputs) -> float:
        return _price_scalar(self._inputs(inputs), dividend_adjusted=True)

    def greeks(self, inputs: PricingInputs) -> Greeks:
        clean = self._inputs(inputs)
        result = black_scholes_greeks(
            clean.spot, clean.strike, clean.dte, clean.volatility,
            clean.rate, clean.dividend, clean.option_type,
        )
        scalar = lambda key: float(np.asarray(result[key]).item())
        return Greeks(scalar("delta"), scalar("gamma"), scalar("theta"), scalar("vega"), scalar("rho"))

    def price_diagnostics(self, inputs: PricingInputs) -> PricingResult:
        started = time.perf_counter()
        clean = self._inputs(inputs)
        price = self.price(clean)
        return PricingResult(
            price=price,
            model=self.name,
            runtime_ms=(time.perf_counter() - started) * 1000.0,
            greeks=self.greeks(clean),
        )


def _finite_difference_vega_rho(model: PricingModel, inputs: PricingInputs) -> tuple[float, float]:
    vol_bump = max(0.01, min(0.10, inputs.volatility * 0.0025))
    vol_low = max(inputs.volatility - vol_bump, 0.0001)
    vega = (
        model.price(replace(inputs, volatility=inputs.volatility + vol_bump))
        - model.price(replace(inputs, volatility=vol_low))
    ) / (inputs.volatility + vol_bump - vol_low)
    rate_bump = 0.01
    rho = (
        model.price(replace(inputs, rate=inputs.rate + rate_bump))
        - model.price(replace(inputs, rate=inputs.rate - rate_bump))
    ) / (2.0 * rate_bump)
    return float(vega), float(rho)


class CRRBinomialModel:
    name = "binomial_american_crr"

    def __init__(self, steps: int = 250, american: bool = True) -> None:
        if not isinstance(steps, int) or steps < 2:
            raise ValueError("binomial steps must be an integer >= 2")
        self.steps = steps
        self.american = american
        self.exercise_style = "american" if american else "european"
        if not american:
            self.name = "binomial_european_crr"

    def _lattice(self, inputs: PricingInputs, include_details: bool) -> PricingResult:
        started = time.perf_counter()
        clean = inputs.validated()
        n = self.steps
        t = clean.time_years
        dt = t / n
        sigma = clean.volatility / 100.0
        r = clean.rate / 100.0
        q = clean.dividend / 100.0
        cash_dividend_pv = _cash_dividend_present_value(clean)
        lattice_spot = clean.spot - cash_dividend_pv
        if lattice_spot <= 0:
            raise ValueError("cash-dividend present value must be below spot")
        remaining_cash = np.array([
            _cash_dividend_present_value(clean, step * dt)
            for step in range(n + 1)
        ])
        u = math.exp(sigma * math.sqrt(dt))
        d = 1.0 / u
        denominator = u - d
        if abs(denominator) < 1e-15:
            raise ValueError("binomial up/down factors collapsed; increase volatility or reduce steps")
        probability = (math.exp((r - q) * dt) - d) / denominator
        if not 0.0 <= probability <= 1.0:
            raise ValueError(f"invalid CRR risk-neutral probability {probability:.6f}")
        discount = math.exp(-r * dt)

        indices = np.arange(n + 1, dtype=float)
        stocks = lattice_spot * np.power(u, indices) * np.power(d, n - indices) + remaining_cash[n]
        if clean.option_type.lower() == "call":
            values = np.maximum(stocks - clean.strike, 0.0)
        else:
            values = np.maximum(clean.strike - stocks, 0.0)

        layer_one: tuple[np.ndarray, np.ndarray] | None = None
        layer_two: tuple[np.ndarray, np.ndarray] | None = None
        boundary: list[dict[str, float | int]] = []
        for step in range(n - 1, -1, -1):
            continuation = discount * ((1.0 - probability) * values[:-1] + probability * values[1:])
            node_indices = np.arange(step + 1, dtype=float)
            node_stocks = lattice_spot * np.power(u, node_indices) * np.power(d, step - node_indices) + remaining_cash[step]
            if self.american:
                if clean.option_type.lower() == "call":
                    exercise = np.maximum(node_stocks - clean.strike, 0.0)
                else:
                    exercise = np.maximum(clean.strike - node_stocks, 0.0)
                exercised = (exercise > continuation + 1e-12) & (exercise > 0)
                values = np.maximum(continuation, exercise)
                if include_details and exercised.any():
                    exercise_spots = node_stocks[exercised]
                    boundary.append({
                        "time_step": step,
                        "days_remaining": float(clean.dte * (n - step) / n),
                        "spot_boundary": float(exercise_spots.min() if clean.option_type.lower() == "call" else exercise_spots.max()),
                    })
            else:
                values = continuation
            if step == 2:
                layer_two = (node_stocks.copy(), values.copy())
            elif step == 1:
                layer_one = (node_stocks.copy(), values.copy())

        root = max(float(values[0]), _intrinsic(clean) if self.american else _european_lower_bound(clean))
        greek_result: Greeks | None = None
        if include_details and layer_one is not None and layer_two is not None:
            stocks_one, values_one = layer_one
            stocks_two, values_two = layer_two
            delta = float((values_one[1] - values_one[0]) / (stocks_one[1] - stocks_one[0]))
            delta_down = (values_two[1] - values_two[0]) / (stocks_two[1] - stocks_two[0])
            delta_up = (values_two[2] - values_two[1]) / (stocks_two[2] - stocks_two[1])
            gamma = float((delta_up - delta_down) / ((stocks_two[2] - stocks_two[0]) / 2.0))
            theta = float((values_two[1] - root) / (2.0 * dt * 365.0))
            vega, rho = _finite_difference_vega_rho(self, clean)
            greek_result = Greeks(delta, gamma, theta, vega, rho)

        premium = 0.0
        if self.american and include_details:
            european_tree = CRRBinomialModel(n, american=False).price(clean)
            premium = max(root - european_tree, 0.0)
        return PricingResult(
            price=root,
            model=self.name,
            steps=n,
            runtime_ms=(time.perf_counter() - started) * 1000.0,
            early_exercise_premium=premium,
            exercise_boundary=list(reversed(boundary)),
            greeks=greek_result,
        )

    def price(self, inputs: PricingInputs) -> float:
        return self._lattice(inputs, include_details=False).price

    def price_diagnostics(self, inputs: PricingInputs) -> PricingResult:
        return self._lattice(inputs, include_details=True)

    def greeks(self, inputs: PricingInputs) -> Greeks:
        result = self.price_diagnostics(inputs).greeks
        if result is None:
            raise RuntimeError("tree greeks unavailable")
        return result


def smoothed_crr_result(
    inputs: PricingInputs,
    *,
    steps: int,
    american: bool = True,
    include_details: bool = False,
) -> PricingResult:
    """Average adjacent CRR lattices to reduce even/odd strike oscillation."""

    started = time.perf_counter()
    primary_model = CRRBinomialModel(steps, american=american)
    primary = (
        primary_model.price_diagnostics(inputs)
        if include_details
        else PricingResult(price=primary_model.price(inputs), model=primary_model.name, steps=steps)
    )
    adjacent_price = CRRBinomialModel(steps + 1, american=american).price(inputs)
    primary.price = 0.5 * (primary.price + adjacent_price)
    primary.runtime_ms = (time.perf_counter() - started) * 1000.0
    primary.numerical_method = "crr_adjacent_step_smoothed"
    return primary


def adaptive_crr(
    inputs: PricingInputs,
    *,
    min_steps: int = 50,
    max_steps: int = 400,
    tolerance: float = 0.0025,
    american: bool = True,
) -> PricingResult:
    """Step-double a smoothed CRR lattice and return honest error metadata."""

    clean_min = max(2, int(min_steps))
    clean_max = max(clean_min, int(max_steps))
    clean_tolerance = max(1e-8, float(tolerance))
    schedule: list[int] = []
    steps = clean_min
    while steps < clean_max:
        schedule.append(steps)
        steps *= 2
    if not schedule or schedule[-1] != clean_max:
        schedule.append(clean_max)

    started = time.perf_counter()
    history: list[dict[str, Any]] = []
    previous: float | None = None
    selected: PricingResult | None = None
    converged = False
    for steps in schedule:
        level_started = time.perf_counter()
        result = smoothed_crr_result(inputs, steps=steps, american=american)
        difference = None if previous is None else result.price - previous
        error = None if difference is None else abs(difference)
        history.append({
            "steps": steps,
            "adjacent_steps": steps + 1,
            "price": result.price,
            "difference_from_previous": difference,
            "error_estimate": error,
            "runtime_ms": (time.perf_counter() - level_started) * 1000.0,
        })
        selected = result
        if len(history) >= 3 and error is not None and error <= clean_tolerance:
            converged = True
            break
        previous = result.price
    if selected is None:
        raise RuntimeError("adaptive CRR produced no lattice result")
    selected.converged = converged
    selected.warning = None if converged else "maximum tree steps reached before tolerance"
    selected.runtime_ms = (time.perf_counter() - started) * 1000.0
    selected.convergence_error = history[-1]["error_estimate"]
    selected.convergence_tolerance = clean_tolerance
    selected.max_steps = clean_max
    selected.convergence_status = "converged" if converged else "max_steps_reached"
    selected.convergence_history = history
    selected.numerical_method = "adaptive_crr_step_doubling_adjacent_smoothed"
    return selected


class TrinomialModel:
    name = "trinomial_american"

    def __init__(self, steps: int = 250, american: bool = True) -> None:
        if not isinstance(steps, int) or steps < 2:
            raise ValueError("trinomial steps must be an integer >= 2")
        self.steps = steps
        self.american = american
        self.exercise_style = "american" if american else "european"
        if not american:
            self.name = "trinomial_european"

    def _lattice(self, inputs: PricingInputs, include_details: bool) -> PricingResult:
        started = time.perf_counter()
        clean = inputs.validated()
        n = self.steps
        dt = clean.time_years / n
        sigma = clean.volatility / 100.0
        r = clean.rate / 100.0
        q = clean.dividend / 100.0
        cash_dividend_pv = _cash_dividend_present_value(clean)
        lattice_spot = clean.spot - cash_dividend_pv
        if lattice_spot <= 0:
            raise ValueError("cash-dividend present value must be below spot")
        remaining_cash = np.array([
            _cash_dividend_present_value(clean, step * dt)
            for step in range(n + 1)
        ])
        half_vol = sigma * math.sqrt(dt / 2.0)
        denominator = math.exp(half_vol) - math.exp(-half_vol)
        if abs(denominator) < 1e-15:
            raise ValueError("trinomial movement factors collapsed")
        drift = math.exp((r - q) * dt / 2.0)
        pu = ((drift - math.exp(-half_vol)) / denominator) ** 2
        pd = ((math.exp(half_vol) - drift) / denominator) ** 2
        pm = 1.0 - pu - pd
        if min(pu, pm, pd) < -1e-12 or max(pu, pm, pd) > 1.0 + 1e-12:
            raise ValueError(f"invalid trinomial probabilities pd={pd:.6f}, pm={pm:.6f}, pu={pu:.6f}")
        pu, pm, pd = min(max(pu, 0.0), 1.0), min(max(pm, 0.0), 1.0), min(max(pd, 0.0), 1.0)
        discount = math.exp(-r * dt)
        u = math.exp(sigma * math.sqrt(2.0 * dt))

        states = np.arange(-n, n + 1, dtype=float)
        stocks = lattice_spot * np.power(u, states) + remaining_cash[n]
        values = np.maximum(stocks - clean.strike, 0.0) if clean.option_type.lower() == "call" else np.maximum(clean.strike - stocks, 0.0)
        layer_one: tuple[np.ndarray, np.ndarray] | None = None
        boundary: list[dict[str, float | int]] = []
        for step in range(n - 1, -1, -1):
            continuation = discount * (pd * values[:-2] + pm * values[1:-1] + pu * values[2:])
            node_states = np.arange(-step, step + 1, dtype=float)
            node_stocks = lattice_spot * np.power(u, node_states) + remaining_cash[step]
            if self.american:
                exercise = np.maximum(node_stocks - clean.strike, 0.0) if clean.option_type.lower() == "call" else np.maximum(clean.strike - node_stocks, 0.0)
                exercised = (exercise > continuation + 1e-12) & (exercise > 0)
                values = np.maximum(continuation, exercise)
                if include_details and exercised.any():
                    exercise_spots = node_stocks[exercised]
                    boundary.append({
                        "time_step": step,
                        "days_remaining": float(clean.dte * (n - step) / n),
                        "spot_boundary": float(exercise_spots.min() if clean.option_type.lower() == "call" else exercise_spots.max()),
                    })
            else:
                values = continuation
            if step == 1:
                layer_one = (node_stocks.copy(), values.copy())

        root = max(float(values[0]), _intrinsic(clean) if self.american else _european_lower_bound(clean))
        greek_result: Greeks | None = None
        if include_details and layer_one is not None:
            node_stocks, node_values = layer_one
            delta = float((node_values[2] - node_values[0]) / (node_stocks[2] - node_stocks[0]))
            delta_down = (node_values[1] - node_values[0]) / (node_stocks[1] - node_stocks[0])
            delta_up = (node_values[2] - node_values[1]) / (node_stocks[2] - node_stocks[1])
            gamma = float((delta_up - delta_down) / ((node_stocks[2] - node_stocks[0]) / 2.0))
            theta = float((node_values[1] - root) / (dt * 365.0))
            vega, rho = _finite_difference_vega_rho(self, clean)
            greek_result = Greeks(delta, gamma, theta, vega, rho)
        premium = 0.0
        if self.american and include_details:
            european_tree = TrinomialModel(n, american=False).price(clean)
            premium = max(root - european_tree, 0.0)
        return PricingResult(
            price=root,
            model=self.name,
            steps=n,
            runtime_ms=(time.perf_counter() - started) * 1000.0,
            early_exercise_premium=premium,
            exercise_boundary=list(reversed(boundary)),
            greeks=greek_result,
        )

    def price(self, inputs: PricingInputs) -> float:
        return self._lattice(inputs, include_details=False).price

    def price_diagnostics(self, inputs: PricingInputs) -> PricingResult:
        return self._lattice(inputs, include_details=True)

    def greeks(self, inputs: PricingInputs) -> Greeks:
        result = self.price_diagnostics(inputs).greeks
        if result is None:
            raise RuntimeError("tree greeks unavailable")
        return result


class BaroneAdesiWhaleyModel:
    """Barone-Adesi/Whaley quadratic approximation for American options.

    The critical exercise boundary is solved numerically rather than with the
    fragile Newton update commonly copied between implementations.  The model
    is a fast scanner benchmark; FairVal still uses lattice agreement for
    high-confidence American selections.
    """

    name = "american_approximation_baw"
    exercise_style = "american"

    @staticmethod
    def _critical_price(inputs: PricingInputs) -> tuple[float, float]:
        t = inputs.time_years
        sigma = inputs.volatility / 100.0
        r = inputs.rate / 100.0
        q = inputs.dividend / 100.0
        b = r - q
        sigma2 = sigma * sigma
        kappa = 1.0 - math.exp(-max(r, 1e-10) * t)
        m = 2.0 * max(r, 1e-10) / sigma2
        n = 2.0 * b / sigma2
        root = math.sqrt((n - 1.0) ** 2 + 4.0 * m / max(kappa, 1e-12))
        q_power = (-(n - 1.0) + root) / 2.0 if inputs.option_type.lower() == "call" else (-(n - 1.0) - root) / 2.0
        discount_q = math.exp(-q * t)

        def d1(spot: float) -> float:
            return (math.log(spot / inputs.strike) + (b + 0.5 * sigma2) * t) / (sigma * math.sqrt(t))

        def coefficient(spot: float) -> float:
            if inputs.option_type.lower() == "call":
                return (spot / q_power) * (1.0 - discount_q * 0.5 * (1.0 + math.erf(d1(spot) / math.sqrt(2.0))))
            return -(spot / q_power) * (1.0 - discount_q * 0.5 * (1.0 + math.erf(-d1(spot) / math.sqrt(2.0))))

        european = BlackScholesModel(dividend_adjusted=True)

        def equation(spot: float) -> float:
            local = replace(inputs, spot=spot, exercise_style="european")
            if inputs.option_type.lower() == "call":
                return spot - inputs.strike - european.price(local) - coefficient(spot)
            return inputs.strike - spot - european.price(local) - coefficient(spot)

        if inputs.option_type.lower() == "call":
            low, high = inputs.strike, max(inputs.strike * 2.0, inputs.spot * 2.0)
            f_low = equation(low)
            f_high = equation(high)
            for _ in range(60):
                if f_low * f_high <= 0:
                    break
                high *= 2.0
                f_high = equation(high)
        else:
            low, high = max(inputs.strike * 1e-8, 1e-10), inputs.strike
            f_low, f_high = equation(low), equation(high)
        if f_low * f_high > 0:
            raise ValueError("BAW critical exercise boundary could not be bracketed")
        for _ in range(160):
            midpoint = 0.5 * (low + high)
            f_mid = equation(midpoint)
            if abs(f_mid) < 1e-10 or high - low < 1e-10:
                return midpoint, coefficient(midpoint)
            if f_low * f_mid <= 0:
                high, f_high = midpoint, f_mid
            else:
                low, f_low = midpoint, f_mid
        midpoint = 0.5 * (low + high)
        return midpoint, coefficient(midpoint)

    def price(self, inputs: PricingInputs) -> float:
        clean = inputs.validated()
        if _cash_dividends_before_expiry(clean):
            raise ValueError("BAW does not support discrete cash dividends; use CRR")
        r = clean.rate / 100.0
        q = clean.dividend / 100.0
        if clean.option_type.lower() == "call" and q <= 0:
            return BlackScholesModel(True).price(clean)
        if r <= 0:
            raise ValueError("BAW approximation requires a positive rate; use a tree model")
        boundary, coefficient = self._critical_price(clean)
        sigma = clean.volatility / 100.0
        b = r - q
        t = clean.time_years
        m = 2.0 * r / (sigma * sigma)
        n = 2.0 * b / (sigma * sigma)
        kappa = 1.0 - math.exp(-r * t)
        root = math.sqrt((n - 1.0) ** 2 + 4.0 * m / kappa)
        q_power = (-(n - 1.0) + root) / 2.0 if clean.option_type.lower() == "call" else (-(n - 1.0) - root) / 2.0
        if clean.option_type.lower() == "call" and clean.spot >= boundary:
            return _intrinsic(clean)
        if clean.option_type.lower() == "put" and clean.spot <= boundary:
            return _intrinsic(clean)
        european = BlackScholesModel(True).price(clean)
        return max(european + coefficient * (clean.spot / boundary) ** q_power, _intrinsic(clean))

    def greeks(self, inputs: PricingInputs) -> Greeks:
        clean = inputs.validated()
        spot_bump = max(clean.spot * 0.001, 0.01)
        up = self.price(replace(clean, spot=clean.spot + spot_bump))
        center = self.price(clean)
        down = self.price(replace(clean, spot=max(clean.spot - spot_bump, 1e-8)))
        delta = (up - down) / (2.0 * spot_bump)
        gamma = (up - 2.0 * center + down) / (spot_bump * spot_bump)
        tomorrow = self.price(replace(clean, dte=max(clean.dte - 1.0, 0.0)))
        theta = tomorrow - center
        vega, rho = _finite_difference_vega_rho(self, clean)
        return Greeks(delta, gamma, theta, vega, rho)

    def price_diagnostics(self, inputs: PricingInputs) -> PricingResult:
        started = time.perf_counter()
        price = self.price(inputs)
        european = BlackScholesModel(True).price(inputs)
        return PricingResult(
            price=price,
            model=self.name,
            runtime_ms=(time.perf_counter() - started) * 1000.0,
            early_exercise_premium=max(price - european, 0.0),
            greeks=self.greeks(inputs),
        )


def implied_volatility(
    target_price: float,
    pricing_model: PricingModel,
    inputs: PricingInputs,
    lower: float = 0.01,
    upper: float = 500.0,
    tolerance: float = 1e-8,
    max_iterations: int = 120,
) -> IVResult:
    """Invert any monotone pricing model with a bracketed bisection solver."""

    try:
        clean = inputs.validated()
    except ValueError as error:
        return IVResult(None, False, "invalid_inputs", str(error), 0, lower, upper)
    if not math.isfinite(target_price) or target_price < 0:
        return IVResult(None, False, "invalid_target", "target price must be finite and nonnegative", 0, lower, upper)
    style = getattr(pricing_model, "exercise_style", clean.exercise_style).lower()
    theoretical_lower = _intrinsic(clean) if style == "american" else _european_lower_bound(clean)
    if target_price < theoretical_lower - tolerance:
        return IVResult(None, False, "below_lower_bound", f"target {target_price:.8f} is below model lower bound {theoretical_lower:.8f}", 0, lower, upper)
    if style == "american" and theoretical_lower > 0 and abs(target_price - theoretical_lower) <= tolerance:
        return IVResult(None, False, "intrinsic_boundary", "target equals intrinsic value, so volatility is not uniquely identifiable", 0, lower, upper)
    def evaluate(volatility: float) -> float | None:
        try:
            price = pricing_model.price(replace(clean, volatility=float(volatility)))
            return float(price) if math.isfinite(price) else None
        except (ValueError, OverflowError, FloatingPointError):
            return None

    # Broker IV or the caller's current input is normally close to the root.
    # Expand away from that seed before paying for a full logarithmic grid.
    seed = min(max(float(clean.volatility), lower), upper)
    seed_price = evaluate(seed)
    if seed_price is not None and abs(seed_price - target_price) <= tolerance:
        return IVResult(seed, True, "converged", None, 0, seed, seed, seed_price - target_price)
    bracket: tuple[tuple[float, float], tuple[float, float]] | None = None
    if seed_price is not None and seed_price < target_price:
        low_point = (seed, seed_price)
        volatility = seed
        for _ in range(24):
            if volatility >= upper:
                break
            next_volatility = min(upper, max(volatility + 0.25, volatility * 1.35))
            if next_volatility == volatility:
                break
            volatility = next_volatility
            price = evaluate(volatility)
            if price is None:
                continue
            if price + tolerance >= target_price:
                bracket = (low_point, (volatility, price))
                break
            low_point = (volatility, price)
    elif seed_price is not None:
        high_point = (seed, seed_price)
        volatility = seed
        for _ in range(24):
            if volatility <= lower:
                break
            next_volatility = max(lower, min(volatility - 0.01, volatility / 1.35))
            if next_volatility == volatility:
                break
            volatility = next_volatility
            price = evaluate(volatility)
            if price is None:
                continue
            if price - tolerance <= target_price:
                bracket = ((volatility, price), high_point)
                break
            high_point = (volatility, price)

    # A fixed-step lattice can have invalid transition probabilities at very
    # low sigma. Retain a smaller grid fallback for that unusual domain.
    grid = np.geomspace(max(lower, 1e-8), upper, 24)
    valid_points: list[tuple[float, float]] = []
    last_error: str | None = None
    for volatility in grid if bracket is None else ():
        try:
            price = pricing_model.price(replace(clean, volatility=float(volatility)))
            if math.isfinite(price):
                valid_points.append((float(volatility), float(price)))
        except (ValueError, OverflowError, FloatingPointError) as error:
            last_error = str(error)
    if bracket is None and not valid_points:
        return IVResult(None, False, "pricing_error", last_error or "pricing model returned no finite values", 0, lower, upper)
    for left, right in zip(valid_points, valid_points[1:]) if bracket is None else ():
        if left[1] - tolerance <= target_price <= right[1] + tolerance:
            bracket = (left, right)
            break
    if bracket is None:
        low_vol, low_price = valid_points[0]
        high_vol, high_price = valid_points[-1]
        if target_price < low_price - tolerance:
            return IVResult(None, False, "below_volatility_grid", f"target is below price at lowest valid volatility {low_vol:.6f}%", 0, low_vol, high_vol, low_price - target_price)
        return IVResult(None, False, "above_volatility_grid", f"target is above price at highest valid volatility {high_vol:.6f}%", 0, low_vol, high_vol, high_price - target_price)
    (low, low_price), (high, high_price) = bracket
    midpoint, model_price = low, low_price
    for iteration in range(1, max_iterations + 1):
        midpoint = 0.5 * (low + high)
        try:
            model_price = pricing_model.price(replace(clean, volatility=midpoint))
        except (ValueError, OverflowError, FloatingPointError) as error:
            return IVResult(None, False, "pricing_error", str(error), iteration, low, high)
        residual = model_price - target_price
        if abs(residual) <= tolerance or high - low <= 1e-8:
            return IVResult(midpoint, True, "converged", None, iteration, low, high, residual)
        if residual < 0:
            low = midpoint
        else:
            high = midpoint
    return IVResult(midpoint, False, "max_iterations", "IV solver reached its iteration limit", max_iterations, low, high, model_price - target_price)


def convergence_report(
    model_type: type[CRRBinomialModel] | type[TrinomialModel],
    inputs: PricingInputs,
    step_counts: tuple[int, ...] = (50, 100, 250, 500, 1000),
    tolerance: float = 0.0025,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    previous: float | None = None
    for steps in step_counts:
        model = model_type(steps=steps, american=inputs.exercise_style.lower() == "american")
        try:
            result = model.price_diagnostics(inputs)
            difference = None if previous is None else result.price - previous
            rows.append({
                "model": result.model,
                "steps": steps,
                "price": result.price,
                "difference_from_previous": difference,
                "runtime_ms": result.runtime_ms,
                "stabilized": difference is not None and abs(difference) <= tolerance,
                "warning": result.warning,
            })
            previous = result.price
        except (ValueError, OverflowError, FloatingPointError) as error:
            rows.append({
                "model": model.name,
                "steps": steps,
                "price": None,
                "difference_from_previous": None,
                "runtime_ms": None,
                "stabilized": False,
                "warning": str(error),
            })
    return rows


DEFAULT_STYLE_MAP: dict[str, dict[str, str]] = {
    "SPX": {"style": "european", "instrument_type": "index"},
    "SPXW": {"style": "european", "instrument_type": "index"},
    "XSP": {"style": "european", "instrument_type": "index"},
    "SPY": {"style": "american", "instrument_type": "etf"},
    "QQQ": {"style": "american", "instrument_type": "etf"},
    "IWM": {"style": "american", "instrument_type": "etf"},
}


@dataclass(frozen=True)
class StyleResolution:
    style: str
    instrument_type: str
    verified: bool
    warning: str | None


def resolve_contract_style(
    ticker: str,
    option_style: str | None = None,
    instrument_type: str | None = None,
    style_map: dict[str, dict[str, str]] | None = None,
) -> StyleResolution:
    explicit = (option_style or "").strip().lower()
    instrument = (instrument_type or "").strip().lower()
    if explicit in {"european", "american"}:
        return StyleResolution(explicit, instrument or "unknown", True, None)
    mapping = {**DEFAULT_STYLE_MAP, **(style_map or {})}.get(str(ticker).upper())
    if mapping:
        return StyleResolution(
            mapping["style"], instrument or mapping.get("instrument_type", "unknown"), False,
            f"option style inferred from configurable ticker map for {str(ticker).upper()}",
        )
    if instrument in {"equity", "stock", "etf"}:
        return StyleResolution("american", instrument, False, f"American exercise style inferred from instrument type '{instrument}'")
    if instrument == "index":
        return StyleResolution("european", instrument, False, "European exercise style inferred from index classification")
    return StyleResolution(
        "unknown", instrument or "unknown", False,
        "contract style could not be verified; dividend-adjusted Black-Scholes fallback used",
    )


def _warning_text(items: list[str | None]) -> str:
    return "; ".join(dict.fromkeys(item for item in items if item))


def contract_pricing_diagnostics(
    *,
    ticker: str,
    market_mid: float,
    market_iv: float,
    forecast_volatility: float,
    inputs: PricingInputs,
    option_style: str | None = None,
    instrument_type: str | None = None,
    style_map: dict[str, dict[str, str]] | None = None,
    tree_steps: int = 400,
    tree_min_steps: int = 50,
    tree_tolerance: float = 0.0025,
    material_premium: float = 0.01,
    model_disagreement_tolerance: float = 0.02,
) -> dict[str, Any]:
    """Return scanner-ready prices, IVs, selection rationale and diagnostics."""

    resolution = resolve_contract_style(ticker, option_style, instrument_type, style_map)
    style = resolution.style
    bs_plain = BlackScholesModel(False)
    bs_dividend = BlackScholesModel(True)
    market_inputs = replace(inputs, volatility=market_iv, exercise_style="european")
    forecast_inputs = replace(inputs, volatility=forecast_volatility, exercise_style="european")
    bs_started = time.perf_counter()
    bs_plain_market = bs_plain.price(market_inputs)
    bs_market = bs_dividend.price(market_inputs)
    bs_forecast = bs_dividend.price(forecast_inputs)
    bs_runtime_ms = (time.perf_counter() - bs_started) * 1000.0
    bs_iv_result = implied_volatility(market_mid, bs_dividend, market_inputs)
    bs_greeks = bs_dividend.greeks(market_inputs)
    cash_dividend_pv = _cash_dividend_present_value(inputs)
    dividend_model = "escrowed_cash_dividend_schedule" if _cash_dividends_before_expiry(inputs) else "continuous_dividend_yield"

    warnings: list[str | None] = [resolution.warning]
    binomial_market = trinomial_market = baw_market = math.nan
    binomial_forecast = trinomial_forecast = baw_forecast = math.nan
    american_iv = trinomial_iv = math.nan
    american_greeks: Greeks | None = None
    tree_agreement = math.nan
    selected_model: PricingModel = bs_dividend
    selected_fair_value = bs_forecast
    model_reason = "European-style contract uses dividend-adjusted Black-Scholes"
    exact_tree_premium = 0.0
    analytic_premium = 0.0
    convergence_status = "not_applicable"
    tree_steps_used: int | None = None
    tree_convergence_error = math.nan
    tree_history: list[dict[str, Any]] = []
    binomial_runtime_ms = trinomial_runtime_ms = approximation_runtime_ms = math.nan

    if style == "american":
        baw = BaroneAdesiWhaleyModel()
        try:
            crr_started = time.perf_counter()
            american_forecast_inputs = replace(forecast_inputs, exercise_style="american")
            adaptive_forecast = adaptive_crr(
                american_forecast_inputs,
                min_steps=tree_min_steps,
                max_steps=tree_steps,
                tolerance=tree_tolerance,
                american=True,
            )
            tree_steps_used = adaptive_forecast.steps
            tree_convergence_error = (
                adaptive_forecast.convergence_error
                if adaptive_forecast.convergence_error is not None
                else math.nan
            )
            tree_history = adaptive_forecast.convergence_history
            convergence_status = adaptive_forecast.convergence_status
            crr = CRRBinomialModel(tree_steps_used, american=True)
            tri = TrinomialModel(tree_steps_used, american=True)
            crr_market_result = smoothed_crr_result(
                replace(market_inputs, exercise_style="american"),
                steps=tree_steps_used,
                american=True,
                include_details=True,
            )
            binomial_forecast = adaptive_forecast.price
            binomial_runtime_ms = crr_market_result.runtime_ms + (time.perf_counter() - crr_started) * 1000.0
            binomial_market = crr_market_result.price
            exact_tree_premium = max(
                binomial_forecast - smoothed_crr_result(
                    american_forecast_inputs,
                    steps=tree_steps_used,
                    american=False,
                ).price,
                0.0,
            )
            analytic_premium = max(binomial_forecast - bs_forecast, 0.0)
            american_greeks = crr_market_result.greeks
            iv_result = implied_volatility(market_mid, crr, replace(market_inputs, exercise_style="american"))
            american_iv = iv_result.volatility if iv_result.volatility is not None else math.nan
            if not iv_result.converged:
                warnings.append(f"American IV solver failed: {iv_result.reason or iv_result.status}")
            trinomial_started = time.perf_counter()
            trinomial_market = tri.price(replace(market_inputs, exercise_style="american"))
            trinomial_forecast = tri.price(replace(forecast_inputs, exercise_style="american"))
            trinomial_runtime_ms = (time.perf_counter() - trinomial_started) * 1000.0
            tri_iv_result = implied_volatility(market_mid, tri, replace(market_inputs, exercise_style="american"))
            trinomial_iv = tri_iv_result.volatility if tri_iv_result.volatility is not None else math.nan
            tree_agreement = abs(binomial_forecast - trinomial_forecast)
            agreement_limit = max(model_disagreement_tolerance, 0.005 * max(binomial_forecast, 1.0))
            if not adaptive_forecast.converged:
                warnings.append(
                    f"CRR did not converge to ${tree_tolerance:.4f} by {tree_steps_used} steps; "
                    f"last error estimate was "
                    f"{'unavailable' if not math.isfinite(tree_convergence_error) else f'${tree_convergence_error:.4f}'}"
                )
            if tree_agreement > agreement_limit:
                warnings.append(f"binomial/trinomial forecast values differ by ${tree_agreement:.4f}")
            try:
                approximation_started = time.perf_counter()
                baw_market = baw.price(replace(market_inputs, exercise_style="american"))
                baw_forecast = baw.price(replace(forecast_inputs, exercise_style="american"))
                approximation_runtime_ms = (time.perf_counter() - approximation_started) * 1000.0
                if abs(baw_forecast - binomial_forecast) > max(0.05, 0.02 * max(binomial_forecast, 1.0)):
                    warnings.append("BAW approximation differs materially from the CRR benchmark")
            except (ValueError, OverflowError, FloatingPointError) as error:
                warnings.append(f"BAW approximation unavailable: {error}")
            if not adaptive_forecast.converged:
                selected_model = bs_dividend
                selected_fair_value = bs_forecast
                model_reason = "Fallback to dividend-adjusted Black-Scholes because the American tree did not meet its convergence tolerance"
                warnings.append("selected model fallback was used")
            elif tree_agreement > agreement_limit:
                selected_model = bs_dividend
                selected_fair_value = bs_forecast
                model_reason = "Fallback to dividend-adjusted Black-Scholes because American tree agreement was poor"
                warnings.append("selected model fallback was used")
            elif exact_tree_premium >= material_premium:
                selected_model = crr
                selected_fair_value = binomial_forecast
                model_reason = "American CRR selected because same-lattice early-exercise premium exceeded the materiality threshold"
                warnings.append("early exercise premium is material")
            else:
                selected_model = bs_dividend
                selected_fair_value = bs_forecast
                model_reason = "Black-Scholes selected because American early-exercise premium was negligible"
            if getattr(selected_model, "exercise_style", "european") == "american" and not iv_result.converged:
                selected_model = bs_dividend
                selected_fair_value = bs_forecast
                model_reason = "Fallback to dividend-adjusted Black-Scholes because American IV solver failed"
                warnings.append("selected model fallback was used")
            if inputs.option_type.lower() == "put" and inputs.strike / inputs.spot >= 1.10:
                warnings.append("deep ITM put; early exercise may be relevant")
            if inputs.dte <= 3 and _intrinsic(inputs) > 0:
                warnings.append("near-expiration ITM option")
            if inputs.option_type.lower() == "call" and inputs.dividend > 0 and not _cash_dividends_before_expiry(inputs):
                warnings.append("continuous dividend yield used; no discrete ex-dividend schedule was supplied")
        except (ValueError, OverflowError, FloatingPointError) as error:
            selected_model = bs_dividend
            selected_fair_value = bs_forecast
            model_reason = "Fallback to dividend-adjusted Black-Scholes because American pricing failed"
            warnings.extend([f"American model failed: {error}", "selected model fallback was used"])
    elif style == "unknown":
        selected_model = bs_dividend
        selected_fair_value = bs_forecast
        model_reason = "Fallback to Black-Scholes because contract style could not be verified"

    selected_iv = american_iv if getattr(selected_model, "exercise_style", "european") == "american" else (bs_iv_result.volatility or math.nan)
    model_prices = [value for value in (binomial_forecast, trinomial_forecast) if math.isfinite(value)]
    agreement_component = 1.0 if len(model_prices) < 2 else max(0.0, 1.0 - tree_agreement / max(0.05, abs(selected_fair_value) * 0.05))
    style_component = 1.0 if resolution.verified else (0.75 if style != "unknown" else 0.45)
    solver_component = 1.0 if (bs_iv_result.converged and (style != "american" or math.isfinite(american_iv))) else 0.45
    model_confidence = round((agreement_component + style_component + solver_component) / 3.0, 4)
    selected_model_runtime_ms = (
        binomial_runtime_ms
        if getattr(selected_model, "exercise_style", "european") == "american"
        else bs_runtime_ms
    )

    return {
        "option_style": style,
        "style_verified": resolution.verified,
        "instrument_type": resolution.instrument_type,
        "black_scholes_no_dividend_market_iv_fair_value": bs_plain_market,
        "bs_market_iv_fair_value": bs_market,
        "bs_forecast_vol_fair_value": bs_forecast,
        "binomial_market_iv_fair_value": binomial_market,
        "trinomial_market_iv_fair_value": trinomial_market,
        "approximation_market_iv_fair_value": baw_market,
        "american_market_iv_fair_value": binomial_market,
        "binomial_forecast_vol_fair_value": binomial_forecast,
        "trinomial_forecast_vol_fair_value": trinomial_forecast,
        "approximation_forecast_vol_fair_value": baw_forecast,
        "american_forecast_vol_fair_value": binomial_forecast,
        "selected_model_fair_value": selected_fair_value,
        "black_scholes_iv": bs_iv_result.volatility if bs_iv_result.volatility is not None else math.nan,
        "binomial_american_iv": american_iv,
        "trinomial_american_iv": trinomial_iv,
        "american_model_iv": american_iv,
        "selected_model_iv": selected_iv,
        "iv_solver_status": "converged" if math.isfinite(selected_iv) else "failed",
        "iv_solver_warning": None if math.isfinite(selected_iv) else "selected-model IV could not be backsolved from midpoint",
        "early_exercise_premium": analytic_premium,
        "tree_early_exercise_premium": exact_tree_premium,
        "tree_model_difference": tree_agreement,
        "tree_convergence_status": convergence_status,
        "tree_convergence_error": tree_convergence_error,
        "tree_convergence_tolerance": tree_tolerance if style == "american" else math.nan,
        "tree_steps_used": tree_steps_used,
        "tree_max_steps": tree_steps if style == "american" else None,
        "tree_numerical_method": "adaptive_crr_step_doubling_adjacent_smoothed" if style == "american" else None,
        "tree_convergence_history": tree_history,
        "black_scholes_runtime_ms": bs_runtime_ms,
        "binomial_runtime_ms": binomial_runtime_ms,
        "trinomial_runtime_ms": trinomial_runtime_ms,
        "approximation_runtime_ms": approximation_runtime_ms,
        "selected_model_runtime_ms": selected_model_runtime_ms,
        "delta": bs_greeks.delta,
        "gamma": bs_greeks.gamma,
        "theta": bs_greeks.theta,
        "vega": bs_greeks.vega,
        "rho": bs_greeks.rho,
        "american_delta": american_greeks.delta if american_greeks else math.nan,
        "american_gamma": american_greeks.gamma if american_greeks else math.nan,
        "model_used": selected_model.name if style != "unknown" else "unknown_style_black_scholes_fallback",
        "model_reason": model_reason,
        "model_confidence": model_confidence,
        "pricing_warning": _warning_text(warnings),
        "dividend_model": dividend_model,
        "cash_dividend_present_value": cash_dividend_pv,
        "discrete_dividend_count": len(_cash_dividends_before_expiry(inputs)),
    }
