from __future__ import annotations

import hashlib
from urllib.parse import urlsplit, urlunsplit

from courlan import normalize_url
from rapidfuzz import fuzz
import regex


def sha256(value: str | None) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def canonicalize_url(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    candidate = raw
    parsed = urlsplit(candidate)
    if not parsed.scheme or not parsed.netloc:
        candidate = f"https://{raw}"
    normalized = normalize_url(candidate)
    parsed = urlsplit(normalized or candidate)
    if not parsed.netloc:
        return regex.sub(r"/+$", "", regex.sub(r"#.*$", "", raw))

    path = parsed.path
    if path != "/":
        path = regex.sub(r"/+$", "", path)
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, parsed.query, ""))


def canonical_url_hash(value: str | None) -> str:
    return sha256(canonicalize_url(value))


def normalize_title(value: str | None) -> str:
    text = str(value or "").lower()
    text = regex.sub(r"[^\p{Script=Han}a-z0-9]+", " ", text)
    return regex.sub(r"\s+", " ", text).strip()


def normalized_topic(value: str | None) -> str:
    return regex.sub(r"\s+", "", normalize_title(value))[:512]


def tokenize_mixed(value: str | None) -> set[str]:
    tokens: set[str] = set()
    for part in normalize_title(value).split():
        for token in regex.findall(r"[a-z0-9]+", part):
            tokens.add(token)
        for run in regex.findall(r"\p{Script=Han}+", part):
            if len(run) == 1:
                tokens.add(run)
            else:
                for index in range(len(run) - 1):
                    tokens.add(run[index:index + 2])
    return tokens


def jaccard(a: str | None, b: str | None) -> float:
    left_norm = normalized_topic(a)
    right_norm = normalized_topic(b)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm == right_norm:
        return 1.0

    left_title = normalize_title(a)
    right_title = normalize_title(b)
    ratio = fuzz.ratio(left_norm, right_norm) / 100
    token_set = fuzz.token_set_ratio(left_title, right_title) / 100
    partial = fuzz.partial_ratio(left_norm, right_norm) / 100
    partial_score = partial * 0.9 if min(len(left_norm), len(right_norm)) >= 12 else 0
    return max(ratio, token_set, partial_score)
