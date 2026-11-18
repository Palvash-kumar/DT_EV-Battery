"""Estimators shared by training scripts and the service (joblib needs an importable path)."""

import numpy as np
from sklearn.base import BaseEstimator, RegressorMixin, clone


class RatioToReference(BaseEstimator, RegressorMixin):
    """Predict y as reference × learned correction, where reference is a feature column.

    Used for charging time: reference is the physics time at the car's full power,
    and the model learns how much longer real sessions take.
    """

    def __init__(self, estimator, reference: str = "ideal_h"):
        self.estimator = estimator
        self.reference = reference

    def fit(self, X, y):
        self.estimator_ = clone(self.estimator).fit(X, y / X[self.reference])
        return self

    def predict(self, X):
        return self.estimator_.predict(X) * X[self.reference].to_numpy()


class TariffPlusResidual(BaseEstimator, RegressorMixin):
    """Predict a fee as learned price per kWh × energy, plus a learned residual (e.g. overstay fees).

    The per-kWh price is the median fee/kWh of paid sessions, so large sessions are priced
    linearly instead of flattening where trees saw little data.
    """

    def __init__(self, estimator, energy: str = "energy_kwh"):
        self.estimator = estimator
        self.energy = energy

    def fit(self, X, y):
        paid = y > 0
        self.price_per_kwh_ = float(np.median(y[paid] / X.loc[paid, self.energy]))
        self.estimator_ = clone(self.estimator).fit(X, y - self.price_per_kwh_ * X[self.energy])
        return self

    def predict(self, X):
        return self.price_per_kwh_ * X[self.energy].to_numpy() + self.estimator_.predict(X)
