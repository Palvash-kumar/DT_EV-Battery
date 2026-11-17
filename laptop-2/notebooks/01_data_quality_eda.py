#!/usr/bin/env python3
"""
01_data_quality_eda.py — EDA report for ev_charging_patterns.csv

Generates all Phase 1 EDA plots and prints a data-quality report.
Run after prepare_charging_data.py has produced the cleaned Parquet.

Usage:
    cd laptop-2
    source .venv/bin/activate
    python notebooks/01_data_quality_eda.py
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # headless — saves PNGs without needing a display
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent.parent
RAW_CSV = BASE.parent / "Data" / "ev_charging_patterns.csv"
CLEAN_PQ = BASE / "data" / "processed" / "charging_clean.parquet"
SUMMARY_JSON = BASE / "data" / "processed" / "cleaning_summary.json"
PLOT_DIR = BASE / "data" / "processed" / "plots"
PLOT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Load data
# ---------------------------------------------------------------------------
df_raw = pd.read_csv(RAW_CSV, parse_dates=["Charging Start Time", "Charging End Time"])
df = pd.read_parquet(CLEAN_PQ)
summary = json.loads(SUMMARY_JSON.read_text())

print("=" * 60)
print("EV CHARGING DATA — QUALITY & EDA REPORT")
print("=" * 60)

# ---------------------------------------------------------------------------
# 1. Missingness heatmap
# ---------------------------------------------------------------------------
print("\n📊 1/7  Missingness heatmap ...")
fig, ax = plt.subplots(figsize=(12, 5))
sns.heatmap(
    df_raw.isnull().T,
    cbar=False,
    yticklabels=True,
    cmap="YlOrRd",
    ax=ax,
)
ax.set_title("Missing Values per Column (raw CSV)")
ax.set_xlabel("Row index")
fig.tight_layout()
fig.savefig(PLOT_DIR / "01_missingness.png", dpi=150)
plt.close(fig)

# Print null counts
nulls = df_raw.isnull().sum()
nulls_nonzero = nulls[nulls > 0]
if len(nulls_nonzero):
    print("   Columns with nulls:")
    for col, n in nulls_nonzero.items():
        print(f"     {col}: {n} ({n/len(df_raw)*100:.1f}%)")
else:
    print("   No null values found in raw data.")

# ---------------------------------------------------------------------------
# 2. Duration & energy distributions
# ---------------------------------------------------------------------------
print("📊 2/7  Duration & energy distributions ...")
fig, axes = plt.subplots(1, 2, figsize=(14, 5))

axes[0].hist(df["Charging Duration (hours)"], bins=40, edgecolor="black", alpha=0.7, color="#4C72B0")
axes[0].set_xlabel("Charging Duration (hours)")
axes[0].set_ylabel("Count")
axes[0].set_title("Distribution of Charging Duration")
axes[0].axvline(df["Charging Duration (hours)"].median(), color="red", ls="--", label=f'Median: {df["Charging Duration (hours)"].median():.2f}h')
axes[0].legend()

axes[1].hist(df["Energy Consumed (kWh)"].dropna(), bins=40, edgecolor="black", alpha=0.7, color="#55A868")
axes[1].set_xlabel("Energy Consumed (kWh)")
axes[1].set_ylabel("Count")
axes[1].set_title("Distribution of Energy Consumed")
axes[1].axvline(df["Energy Consumed (kWh)"].median(), color="red", ls="--", label=f'Median: {df["Energy Consumed (kWh)"].median():.1f} kWh')
axes[1].legend()

fig.tight_layout()
fig.savefig(PLOT_DIR / "02_duration_energy_dist.png", dpi=150)
plt.close(fig)

# ---------------------------------------------------------------------------
# 3. Energy by vehicle model & charger type
# ---------------------------------------------------------------------------
print("📊 3/7  Energy by vehicle model & charger type ...")
fig, axes = plt.subplots(1, 2, figsize=(14, 5))

order_model = df.groupby("Vehicle Model")["Energy Consumed (kWh)"].median().sort_values().index
sns.boxplot(data=df, y="Vehicle Model", x="Energy Consumed (kWh)", order=order_model, hue="Vehicle Model", ax=axes[0], palette="Set2", legend=False)
axes[0].set_title("Energy Consumed by Vehicle Model")

order_charger = df.groupby("Charger Type")["Energy Consumed (kWh)"].median().sort_values().index
sns.boxplot(data=df, y="Charger Type", x="Energy Consumed (kWh)", order=order_charger, hue="Charger Type", ax=axes[1], palette="Set3", legend=False)
axes[1].set_title("Energy Consumed by Charger Type")

fig.tight_layout()
fig.savefig(PLOT_DIR / "03_energy_by_model_charger.png", dpi=150)
plt.close(fig)

# ---------------------------------------------------------------------------
# 4. Charging rate vs temperature
# ---------------------------------------------------------------------------
print("📊 4/7  Charging rate vs temperature ...")
fig, ax = plt.subplots(figsize=(8, 6))
scatter = ax.scatter(
    df["Temperature (°C)"],
    df["Charging Rate (kW)"],
    c=df["Charging Duration (hours)"],
    cmap="coolwarm",
    alpha=0.6,
    s=15,
)
fig.colorbar(scatter, ax=ax, label="Duration (hours)")
ax.set_xlabel("Temperature (°C)")
ax.set_ylabel("Charging Rate (kW)")
ax.set_title("Charging Rate vs Temperature (colour = duration)")
fig.tight_layout()
fig.savefig(PLOT_DIR / "04_rate_vs_temperature.png", dpi=150)
plt.close(fig)

# ---------------------------------------------------------------------------
# 5. SOC delta vs energy consumed
# ---------------------------------------------------------------------------
print("📊 5/7  SOC delta vs energy consumed ...")
fig, ax = plt.subplots(figsize=(8, 6))
ax.scatter(df["socDelta"], df["Energy Consumed (kWh)"], alpha=0.4, s=15, color="#C44E52")
ax.set_xlabel("SOC Delta (%)")
ax.set_ylabel("Energy Consumed (kWh)")
ax.set_title("SOC Delta vs Energy Consumed")
# Highlight anomalous rows where SOC delta is negative
neg_soc = df[df["socDelta"] < 0]
if len(neg_soc):
    ax.scatter(neg_soc["socDelta"], neg_soc["Energy Consumed (kWh)"],
               color="black", s=25, marker="x", label=f"Negative SOC delta ({len(neg_soc)} rows)")
    ax.legend()
fig.tight_layout()
fig.savefig(PLOT_DIR / "05_soc_delta_vs_energy.png", dpi=150)
plt.close(fig)

# ---------------------------------------------------------------------------
# 6. Time-of-day demand
# ---------------------------------------------------------------------------
print("📊 6/7  Time-of-day demand ...")
fig, axes = plt.subplots(1, 2, figsize=(14, 5))

hourly = df.groupby("startHour").size()
axes[0].bar(hourly.index, hourly.values, color="#8172B2", edgecolor="black")
axes[0].set_xlabel("Hour of Day (0–23)")
axes[0].set_ylabel("Number of Sessions")
axes[0].set_title("Charging Sessions by Hour of Day")
axes[0].set_xticks(range(0, 24))

tod_order = ["Morning", "Afternoon", "Evening", "Night"]
tod_counts = df["Time of Day"].value_counts().reindex(tod_order, fill_value=0)
axes[1].bar(tod_counts.index, tod_counts.values, color="#CCB974", edgecolor="black")
axes[1].set_xlabel("Time of Day")
axes[1].set_ylabel("Number of Sessions")
axes[1].set_title("Sessions by Time of Day Category")

fig.tight_layout()
fig.savefig(PLOT_DIR / "06_time_of_day_demand.png", dpi=150)
plt.close(fig)

# ---------------------------------------------------------------------------
# 7. Data quality flag breakdown
# ---------------------------------------------------------------------------
print("📊 7/7  Data quality flag breakdown ...")
flag_data = summary.get("flag_breakdown", {})
if flag_data:
    fig, ax = plt.subplots(figsize=(10, 5))
    flags_sorted = dict(sorted(flag_data.items(), key=lambda x: x[1], reverse=True))
    bars = ax.barh(list(flags_sorted.keys()), list(flags_sorted.values()), color="#DD8452", edgecolor="black")
    ax.set_xlabel("Number of Rows Flagged")
    ax.set_title("Data Quality Flags (rows can have multiple flags)")
    for bar, v in zip(bars, flags_sorted.values()):
        ax.text(bar.get_width() + 5, bar.get_y() + bar.get_height() / 2,
                str(v), va="center", fontsize=9)
    fig.tight_layout()
    fig.savefig(PLOT_DIR / "07_data_quality_flags.png", dpi=150)
    plt.close(fig)

# ---------------------------------------------------------------------------
# Bonus: Correlation matrix for numerics
# ---------------------------------------------------------------------------
print("📊 Bonus: Correlation matrix ...")
num_cols = [
    "Battery Capacity (kWh)", "Energy Consumed (kWh)",
    "Charging Duration (hours)", "Charging Rate (kW)",
    "State of Charge (Start %)", "State of Charge (End %)",
    "Temperature (°C)", "Vehicle Age (years)", "socDelta",
]
fig, ax = plt.subplots(figsize=(10, 8))
corr = df[num_cols].corr()
sns.heatmap(corr, annot=True, fmt=".2f", cmap="RdBu_r", center=0, ax=ax, linewidths=0.5)
ax.set_title("Correlation Matrix — Numeric Features")
fig.tight_layout()
fig.savefig(PLOT_DIR / "08_correlation_matrix.png", dpi=150)
plt.close(fig)

# ---------------------------------------------------------------------------
# Print summary statistics
# ---------------------------------------------------------------------------
print("\n" + "=" * 60)
print("SUMMARY STATISTICS")
print("=" * 60)
print(f"Raw rows:            {summary['raw_row_count']}")
print(f"Final rows:          {summary['final_row_count']}")
print(f"Rows excluded:       {summary['rows_excluded']}")
print(f"Rows flagged:        {summary['rows_flagged']} ({summary['rows_flagged']/summary['raw_row_count']*100:.1f}%)")
print(f"Total nulls (raw):   {summary['profile_raw']['total_nulls']}")
print(f"Duplicated rows:     {summary['profile_raw']['duplicated_rows']}")
print(f"Columns imputed:     {summary.get('imputed_counts', {})}")

print("\nFlag breakdown:")
for flag, count in sorted(flag_data.items(), key=lambda x: -x[1]):
    print(f"  {flag}: {count}")

print("\nVehicle models:", df["Vehicle Model"].unique().tolist())
print("Charger types: ", df["Charger Type"].unique().tolist())
print("User types:    ", df["User Type"].unique().tolist())
print("Locations:     ", df["Charging Station Location"].unique().tolist())

print(f"\nAll plots saved to: {PLOT_DIR}/")
print("=" * 60)
print("IMPORTANT: This dataset has ONE row per user/session.")
print("It does NOT support per-battery degradation or longitudinal SOH claims.")
print("=" * 60)
