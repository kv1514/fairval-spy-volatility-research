"""Dependency-light SVG diagnostics for volatility research runs."""

from __future__ import annotations

from html import escape
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd


WIDTH = 960
HEIGHT = 520
MARGIN = {"left": 74, "right": 28, "top": 58, "bottom": 66}
COLORS = ("#087f5b", "#e8590c", "#364fc7", "#9c36b5", "#0b7285", "#c92a2a", "#5f3dc4")


def _svg_shell(title: str, body: str, subtitle: str = "") -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}">
<rect width="100%" height="100%" fill="#fbfaf5"/>
<style>text{{font-family:Inter,Segoe UI,Arial,sans-serif;fill:#17212b}} .axis{{stroke:#7b8794;stroke-width:1}} .grid{{stroke:#dfe3e6;stroke-width:1}} .label{{font-size:12px}} .legend{{font-size:13px;font-weight:600}}</style>
<text x="{MARGIN['left']}" y="30" font-size="22" font-weight="700">{escape(title)}</text>
<text x="{MARGIN['left']}" y="49" font-size="12" fill="#66717c">{escape(subtitle)}</text>
{body}
</svg>'''


def _empty_chart(title: str, message: str) -> str:
    body = f'<rect x="74" y="75" width="858" height="370" fill="#f1f0ea" stroke="#c7cbc8"/><text x="503" y="260" text-anchor="middle" font-size="16">{escape(message)}</text>'
    return _svg_shell(title, body)


def _numeric_xy(frame: pd.DataFrame, x: str, y: str) -> tuple[np.ndarray, np.ndarray]:
    local = frame[[x, y]].dropna()
    return local[x].to_numpy(dtype=float), local[y].to_numpy(dtype=float)


def _scale(values: np.ndarray, low: float, high: float, reverse: bool = False) -> np.ndarray:
    finite = values[np.isfinite(values)]
    if not finite.size:
        return np.full(values.shape, (low + high) / 2.0)
    minimum, maximum = float(finite.min()), float(finite.max())
    if np.isclose(minimum, maximum):
        return np.full(values.shape, (low + high) / 2.0)
    scaled = low + (values - minimum) * (high - low) / (maximum - minimum)
    return high - (scaled - low) if reverse else scaled


def _axes(y_values: np.ndarray, x_label: str, y_label: str) -> str:
    x0, x1 = MARGIN["left"], WIDTH - MARGIN["right"]
    y0, y1 = MARGIN["top"] + 20, HEIGHT - MARGIN["bottom"]
    finite = y_values[np.isfinite(y_values)]
    minimum = float(finite.min()) if finite.size else 0.0
    maximum = float(finite.max()) if finite.size else 1.0
    if np.isclose(minimum, maximum):
        maximum = minimum + 1.0
    parts = [f'<line class="axis" x1="{x0}" y1="{y1}" x2="{x1}" y2="{y1}"/>', f'<line class="axis" x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}"/>']
    for tick in range(5):
        y = y1 - tick * (y1 - y0) / 4
        value = minimum + tick * (maximum - minimum) / 4
        parts.append(f'<line class="grid" x1="{x0}" y1="{y:.1f}" x2="{x1}" y2="{y:.1f}"/><text class="label" x="{x0-9}" y="{y+4:.1f}" text-anchor="end">{value:.1f}</text>')
    parts.append(f'<text class="label" x="{(x0+x1)/2:.1f}" y="{HEIGHT-19}" text-anchor="middle">{escape(x_label)}</text>')
    parts.append(f'<text class="label" transform="translate(19 {(y0+y1)/2:.1f}) rotate(-90)" text-anchor="middle">{escape(y_label)}</text>')
    return "".join(parts)


def _line_chart(title: str, series: list[tuple[str, np.ndarray, np.ndarray]], x_label: str, y_label: str, subtitle: str = "") -> str:
    usable = [(name, x, y) for name, x, y in series if len(x) and len(y)]
    if not usable:
        return _empty_chart(title, "No observations available for this chart")
    all_x = np.concatenate([item[1] for item in usable])
    all_y = np.concatenate([item[2] for item in usable])
    sx = _scale(all_x, MARGIN["left"], WIDTH - MARGIN["right"])
    sy = _scale(all_y, MARGIN["top"] + 20, HEIGHT - MARGIN["bottom"], reverse=True)
    body = [_axes(all_y, x_label, y_label)]
    offset = 0
    for index, (name, x, y) in enumerate(usable):
        length = len(x)
        points = " ".join(f"{px:.2f},{py:.2f}" for px, py in zip(sx[offset:offset+length], sy[offset:offset+length], strict=True))
        color = COLORS[index % len(COLORS)]
        body.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2.4"/>')
        if length <= 100:
            body.extend(
                f'<circle cx="{px:.2f}" cy="{py:.2f}" r="3" fill="{color}"/>'
                for px, py in zip(sx[offset:offset+length], sy[offset:offset+length], strict=True)
            )
        body.append(f'<line x1="{MARGIN["left"]+index*180}" y1="67" x2="{MARGIN["left"]+index*180+23}" y2="67" stroke="{color}" stroke-width="3"/><text class="legend" x="{MARGIN["left"]+index*180+30}" y="71">{escape(name)}</text>')
        offset += length
    return _svg_shell(title, "".join(body), subtitle)


def _scatter_chart(title: str, x: np.ndarray, y: np.ndarray, x_label: str, y_label: str) -> str:
    if not len(x):
        return _empty_chart(title, "No completed forecast targets available")
    sx = _scale(x, MARGIN["left"], WIDTH - MARGIN["right"])
    sy = _scale(y, MARGIN["top"] + 20, HEIGHT - MARGIN["bottom"], reverse=True)
    body = [_axes(y, x_label, y_label)]
    body.extend(f'<circle cx="{px:.2f}" cy="{py:.2f}" r="3" fill="#087f5b" fill-opacity="0.42"/>' for px, py in zip(sx, sy, strict=True))
    return _svg_shell(title, "".join(body), "Each point is one strictly out-of-sample ticker/date/horizon forecast")


def _bar_chart(title: str, labels: Iterable[str], values: np.ndarray, y_label: str) -> str:
    labels = list(labels)
    if not labels:
        return _empty_chart(title, "No evaluation rows available")
    y0, y1 = MARGIN["top"] + 20, HEIGHT - MARGIN["bottom"]
    x0, x1 = MARGIN["left"], WIDTH - MARGIN["right"]
    maximum = max(float(np.nanmax(values)), 1e-9)
    gap = (x1 - x0) / len(labels)
    body = [_axes(np.append(values, 0.0), "Forecast horizon (trading days)", y_label)]
    for index, (label, value) in enumerate(zip(labels, values, strict=True)):
        height = float(value) / maximum * (y1 - y0)
        x = x0 + index * gap + gap * 0.18
        width = gap * 0.64
        body.append(f'<rect x="{x:.1f}" y="{y1-height:.1f}" width="{width:.1f}" height="{height:.1f}" fill="{COLORS[index % len(COLORS)]}"/><text class="label" x="{x+width/2:.1f}" y="{y1+20}" text-anchor="middle">{escape(label)}</text><text class="label" x="{x+width/2:.1f}" y="{max(y1-height-7,y0+10):.1f}" text-anchor="middle">{value:.2f}</text>')
    return _svg_shell(title, "".join(body))


def _histogram(title: str, values: np.ndarray, bins: int = 24) -> str:
    finite = values[np.isfinite(values)]
    if not finite.size:
        return _empty_chart(title, "No ranked option contracts were supplied")
    counts, edges = np.histogram(finite, bins=min(bins, max(5, int(np.sqrt(finite.size)))))
    labels = [f"{(edges[i]+edges[i+1])/2:.1f}" for i in range(len(counts))]
    return _bar_chart(title, labels, counts.astype(float), "Contract count")


def write_visualizations(
    output_dir: str | Path,
    forecasts: pd.DataFrame,
    evaluation: pd.DataFrame,
    lambda_performance: pd.DataFrame,
    weights_history: pd.DataFrame,
    rankings: pd.DataFrame | None = None,
) -> list[Path]:
    """Write the six requested diagnostics as portable SVG files plus an index."""

    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    rankings = rankings if rankings is not None else pd.DataFrame()

    if not rankings.empty and {"date", "market_iv", "forecast_vol"}.issubset(rankings.columns):
        over_time = rankings.assign(date=pd.to_datetime(rankings["date"])).groupby("date", as_index=False)[["market_iv", "forecast_vol"]].median().sort_values("date")
        x = over_time["date"].map(pd.Timestamp.toordinal).to_numpy(dtype=float)
        chart1 = _line_chart("Market IV vs forecast volatility", [("Market IV", x, over_time["market_iv"].to_numpy(float)), ("Forecast vol", x, over_time["forecast_vol"].to_numpy(float))], "Date", "Annualized volatility (%)")
    else:
        chart1 = _empty_chart("Market IV vs forecast volatility", "Supply an option-history CSV to populate this chart")

    completed = forecasts[(forecasts["model"] == "best_model") & forecasts["future_realized_vol"].notna()].copy()
    if len(completed) > 3_000:
        completed = completed.iloc[np.linspace(0, len(completed) - 1, 3_000, dtype=int)]
    x2, y2 = _numeric_xy(completed, "forecast_vol", "future_realized_vol")
    chart2 = _scatter_chart("Forecast vs future realized volatility", x2, y2, "Forecast volatility (%)", "Future realized volatility (%)")

    model_errors = evaluation[evaluation["model"] == "best_model"].sort_values("horizon") if not evaluation.empty else pd.DataFrame()
    chart3 = _bar_chart("Model variance error by horizon", model_errors.get("horizon", pd.Series(dtype=str)).astype(str), model_errors.get("mse_variance", pd.Series(dtype=float)).to_numpy(float), "MSE of annualized variance")

    if not lambda_performance.empty:
        latest_date = lambda_performance["date"].max()
        curve = lambda_performance[(lambda_performance["date"] == latest_date) & (lambda_performance["stage"] == "fine")].groupby("lambda", as_index=False)["mse_variance"].mean().sort_values("lambda")
        chart4 = _line_chart("EWMA lambda performance curve", [("Walk-forward validation loss", curve["lambda"].to_numpy(float), curve["mse_variance"].to_numpy(float))], "Lambda", "MSE of variance", f"Latest rebalance: {pd.Timestamp(latest_date).date()}")
    else:
        chart4 = _empty_chart("EWMA lambda performance curve", "Not enough completed targets to tune lambda")

    if not weights_history.empty:
        chosen_horizon = 5 if (weights_history["horizon"] == 5).any() else int(weights_history["horizon"].iloc[0])
        weights = weights_history[weights_history["horizon"] == chosen_horizon].groupby("date", as_index=False)[["w5", "w10", "w20", "w60"]].mean().sort_values("date")
        x5 = pd.to_datetime(weights["date"]).map(pd.Timestamp.toordinal).to_numpy(float)
        series5 = [(f"w{window}", x5, weights[f"w{window}"].to_numpy(float)) for window in (5, 10, 20, 60)]
        chart5 = _line_chart("Optimized blend weights over time", series5, "Date", "Variance weight", f"Horizon: {chosen_horizon} trading days · mean across available tickers")
    else:
        chart5 = _empty_chart("Optimized blend weights over time", "Not enough completed targets to optimize weights")

    chart6 = _histogram("Distribution of volatility edge", rankings.get("vol_edge", pd.Series(dtype=float)).to_numpy(float))
    charts = {
        "market_iv_vs_forecast_volatility.svg": chart1,
        "forecast_vs_future_realized_volatility.svg": chart2,
        "model_error_by_horizon.svg": chart3,
        "ewma_lambda_performance_curve.svg": chart4,
        "weighted_blend_weights_over_time.svg": chart5,
        "vol_edge_distribution.svg": chart6,
    }
    written: list[Path] = []
    for filename, payload in charts.items():
        path = target / filename
        path.write_text(payload, encoding="utf-8")
        written.append(path)
    cards = "".join(f'<figure><img src="{escape(path.name)}" alt="{escape(path.stem)}"><figcaption>{escape(path.stem.replace("_", " ").title())}</figcaption></figure>' for path in written)
    index = target / "index.html"
    index.write_text(f'<!doctype html><meta charset="utf-8"><title>Volatility research diagnostics</title><style>body{{font-family:Inter,Segoe UI,sans-serif;background:#edece6;margin:0;padding:24px}}h1{{max-width:960px;margin:0 auto 20px}}figure{{max-width:960px;margin:0 auto 24px;background:white;padding:12px;box-shadow:0 3px 18px #0001}}img{{width:100%}}figcaption{{font-weight:600;padding:8px 4px}}</style><h1>Volatility research diagnostics</h1>{cards}', encoding="utf-8")
    written.append(index)
    return written
