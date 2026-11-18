#!/usr/bin/env python3
"""
download_datasets.py — Fetch the public datasets used for training.

  nasa      NASA PCoE Li-ion battery aging data (LiCoO2 18650 cells)       ~210 MB
  isu       ISU-ILCC battery aging dataset (238 NMC cells, 63 conditions)   ~50 MB summary files
  isu-raw   ISU-ILCC per-cycle JSON (exact cycle counts)    ~10 GB, kept zipped (66 GB unzipped)
  paloalto  City of Palo Alto EV charging sessions 2011-2020 (with fees)    ~85 MB
  acn       Caltech ACN-Data charging sessions (caltech, jpl, office001)    ~67k sessions

ACN-Data needs an API token: register at https://ev.caltech.edu/dataset and set
ACN_API_TOKEN. Without it the public demo token is used.

Usage:
    cd laptop-2
    python src/download_datasets.py nasa isu paloalto acn
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from base64 import b64encode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGING_RAW = ROOT / "data" / "battery_aging" / "raw"
SESSIONS_RAW = ROOT / "data" / "charging_sessions" / "raw"

NASA_URL = "https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip"
FIGSHARE_FILE = "https://ndownloader.figshare.com/files/{}"
ISU_FILES = {
    "Valid_cells.csv": 43754763,
    "process_data.py": 43754835,
    "README_V2.0.pdf": 43754898,
    "capacity_fade.zip": 43755582,
    "Q_interpolated.zip": 43755588,
}
ISU_RAW_FILES = {"Cycling_json.zip": 43777470}
PALO_ALTO_URL = (
    "https://data.paloalto.gov/datasets/"
    "194693-electric-vehicle-charging-station-usage-july-2011-dec-2020.download/"
)
ACN_API = "https://ev.caltech.edu/api/v1/sessions/{site}"
ACN_SITES = ["caltech", "jpl", "office001"]


def fetch(url: str, dest: Path, headers: dict | None = None) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  exists: {dest.name}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {dest.name} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "evdt-dataset-fetch", **(headers or {})})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)


def unzip(path: Path, into: Path) -> None:
    with zipfile.ZipFile(path) as z:
        z.extractall(into)


def nasa() -> None:
    zip_path = AGING_RAW / "nasa_battery.zip"
    fetch(NASA_URL, zip_path)
    out = AGING_RAW / "nasa_extracted"
    if any(out.rglob("*.mat")):
        print("  NASA .mat files already extracted")
        return
    unzip(zip_path, out)
    for inner in out.rglob("*.zip"):
        unzip(inner, inner.parent / inner.stem)
    print(f"  extracted {len(list(out.rglob('*.mat')))} .mat files")


def isu(files: dict[str, int], extract: bool = True) -> None:
    out = AGING_RAW / "isu_ilcc"
    for name, file_id in files.items():
        fetch(FIGSHARE_FILE.format(file_id), out / name)
        if extract and name.endswith(".zip") and not (out / name[:-4]).exists():
            unzip(out / name, out)


def palo_alto() -> None:
    fetch(PALO_ALTO_URL, SESSIONS_RAW / "palo_alto_ev_usage.csv")


def _acn_get(site: str, params: dict) -> dict:
    token = os.environ.get("ACN_API_TOKEN", "DEMO_TOKEN")
    auth = "Basic " + b64encode(f"{token}:".encode()).decode()
    url = ACN_API.format(site=site) + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "evdt-dataset-fetch", "Authorization": auth})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except OSError:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def _acn_month(site: str, start: datetime) -> list:
    # Deep pagination is very slow on this API, so query one month at a time
    end = (start + timedelta(days=32)).replace(day=1)
    fmt = "%a, %d %b %Y %H:%M:%S GMT"
    where = f'connectionTime>="{start.strftime(fmt)}" and connectionTime<"{end.strftime(fmt)}"'
    items, page = [], 1
    while True:
        data = _acn_get(site, {"where": where, "max_results": 100, "page": page})
        items.extend(data["_items"])
        if "next" not in data["_links"]:
            return items
        page += 1


def acn() -> None:
    for site in ACN_SITES:
        dest = SESSIONS_RAW / f"acn_{site}.json"
        if dest.exists():
            print(f"  exists: {dest.name}")
            continue
        first = _acn_get(site, {"sort": "connectionTime", "max_results": 1})["_items"][0]["connectionTime"]
        last = _acn_get(site, {"sort": "-connectionTime", "max_results": 1})["_items"][0]["connectionTime"]
        parse = lambda s: datetime.strptime(s, "%a, %d %b %Y %H:%M:%S %Z")  # noqa: E731
        month, months = parse(first).replace(day=1, hour=0, minute=0, second=0), []
        while month <= parse(last):
            months.append(month)
            month = (month + timedelta(days=32)).replace(day=1)
        with ThreadPoolExecutor(max_workers=4) as pool:
            items = [s for chunk in pool.map(lambda m: _acn_month(site, m), months) for s in chunk]
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(items))
        print(f"  {site}: saved {len(items)} sessions ({first} .. {last})")


def main():
    jobs = {
        "nasa": nasa,
        "isu": lambda: isu(ISU_FILES),
        # Cycling_json.zip unpacks to ~66 GB; prepare_isu.py reads it without extracting
        "isu-raw": lambda: isu(ISU_RAW_FILES, extract=False),
        "paloalto": palo_alto,
        "acn": acn,
    }
    parser = argparse.ArgumentParser(description="Download training datasets")
    parser.add_argument("datasets", nargs="+", choices=sorted(jobs))
    args = parser.parse_args()
    for name in args.datasets:
        print(f"[{name}]")
        jobs[name]()


if __name__ == "__main__":
    sys.exit(main())
