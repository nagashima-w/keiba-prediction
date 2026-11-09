"""#688: offset つきのリッジのロジスティック(標準ライブラリの Newton 法)。切片は罰則なし。"""
from __future__ import annotations

import math

import common688 as K


def _solve(A, b):
    n = len(b)
    M = [A[i][:] + [b[i]] for i in range(n)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        d = M[i][i]
        for r in range(n):
            if r != i:
                f = M[r][i] / d
                if f != 0.0:
                    for k in range(i, n + 1):
                        M[r][k] -= f * M[i][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def fit(X, y, off, lam, iters=30, tol=1e-8):
    """X[i][0] = 1(切片)。罰則 = ½·lam·Σ_{j≥1} w_j²。戻り: w。"""
    p = len(X[0])
    w = [0.0] * p
    nz = [[(j, v) for j, v in enumerate(x) if v != 0.0] for x in X]
    pen = [0.0] + [lam] * (p - 1)
    for _ in range(iters):
        g = [-pen[j] * w[j] for j in range(p)]
        H = [[pen[i] if i == j else 0.0 for j in range(p)] for i in range(p)]
        for idx, yy in enumerate(y):
            row = nz[idx]
            z = off[idx] + sum(w[j] * v for j, v in row)
            pr = K.sigmoid(z)
            e = yy - pr
            wt = pr * (1 - pr)
            for a, (i, vi) in enumerate(row):
                g[i] += e * vi
                wv = wt * vi
                Hi = H[i]
                for j, vj in row[: a + 1]:
                    Hi[j] += wv * vj
        for i in range(p):
            for j in range(i + 1, p):
                H[i][j] = H[j][i]
        d = _solve(H, g)
        w = [w[i] + d[i] for i in range(p)]
        if max(abs(v) for v in d) < tol:
            break
    return w


def predict(X, off, w):
    return [K.sigmoid(o + sum(wi * xi for wi, xi in zip(w, x))) for x, o in zip(X, off)]


def logloss(p, y):
    s = 0.0
    for pi, yy in zip(p, y):
        pi = min(max(pi, 1e-12), 1 - 1e-12)
        s -= math.log(pi) if yy else math.log(1 - pi)
    return s / len(y)
