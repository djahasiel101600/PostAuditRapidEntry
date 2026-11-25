"""PhilGEPS registered-merchants lookup (server-side only).

Public government registry (https://philgeps.gov.ph/CmsHomePages/regMerchants)
used for clerical verification of payees. The search is a form POST that needs
the CakePHP-style ``_csrfToken`` scraped from the full page plus the session
cookie, and it returns an HTML ``<tr>`` fragment. Lookups are low-volume and
user-initiated from the Rapid Entry screen, and results are cached in memory.

Note: this module intentionally uses only ``requests`` + stdlib ``html.parser``
(no bs4) so no new dependency is required.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime
from html.parser import HTMLParser

import requests

logger = logging.getLogger(__name__)

BASE_URL = 'https://philgeps.gov.ph/CmsHomePages/regMerchants'
HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    ),
    'Referer': BASE_URL,
    'Accept': 'text/html,application/xhtml+xml',
}
POST_HEADERS = {
    **HEADERS,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, */*; q=0.01',
}
TIMEOUT = (5, 20)  # connect, read
MAX_PAGES = 2
MAX_RESPONSE_CHARS = 200_000
MAX_QUERY_LEN = 120

CACHE_TTL_HIT = 24 * 60 * 60  # 24h for non-empty results
CACHE_TTL_MISS = 60 * 60  # 1h for empty results
CACHE_MAX_ENTRIES = 200
MAX_RESULTS = 20

_CELL_LABELS = {
    'organization_name': 'name',
    'type': 'merchantType',
    'red_approval_date': 'redApprovalDate',
    'status': 'status',
    'merchant_activity': 'activity',
    'issuancedate': 'issuedDate',
    'expiredate': 'expiresDate',
    'ref_numbers': 'refNumber',
}

_cache: dict[str, tuple[float, list[dict]]] = {}
_cache_lock = threading.Lock()


class PhilGepsError(Exception):
    """Raised when the PhilGEPS registry cannot be reached or parsed."""


class _MerchantTableParser(HTMLParser):
    """Collect ``td[data-label]`` cells grouped per ``<tr>``."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict[str, str]] = []
        self._row: dict[str, str] | None = None
        self._cell_label: str | None = None
        self._cell_parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == 'tr':
            self._row = {}
        elif tag == 'td' and self._row is not None:
            label = attrs_dict.get('data-label')
            if label:
                self._cell_label = label
                self._cell_parts = []

    def handle_data(self, data):
        if self._cell_label is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'td' and self._row is not None and self._cell_label is not None:
            text = ' '.join(''.join(self._cell_parts).split())
            self._row[self._cell_label] = text
            self._cell_label = None
            self._cell_parts = []
        elif tag == 'tr' and self._row is not None:
            if any(label in self._row for label in _CELL_LABELS):
                self.rows.append(self._row)
            self._row = None


def _normalize_query(query: str) -> str:
    return ' '.join(str(query or '').split())[:MAX_QUERY_LEN].upper()


def _normalize_name(name: str) -> str:
    """Casefold, collapse whitespace, drop punctuation for exact matching."""
    cleaned = re.sub(r'[.,()\'"]', ' ', str(name or '').casefold())
    return ' '.join(cleaned.split())


def _iso_date(value: str) -> str:
    value = (value or '').strip()
    if not value:
        return ''
    for fmt in ('%d-%b-%Y', '%d-%B-%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(value, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return ''


def _fetch_csrf_token(session: requests.Session) -> str:
    page = session.get(BASE_URL, headers=HEADERS, timeout=TIMEOUT)
    if page.status_code != 200:
        raise PhilGepsError(f'PhilGEPS page returned {page.status_code}.')
    match = re.search(r'name="_csrfToken"[^>]*value="([^"]+)"', page.text)
    if not match:
        raise PhilGepsError('PhilGEPS CSRF token not found.')
    return match.group(1)


def _parse_rows(html: str) -> list[dict]:
    parser = _MerchantTableParser()
    parser.feed(html[:MAX_RESPONSE_CHARS])
    parser.close()
    records: list[dict] = []
    for row in parser.rows:
        record = {key: '' for key in _CELL_LABELS.values()}
        for label, key in _CELL_LABELS.items():
            record[key] = row.get(label, '')
        record['redApprovalDate'] = _iso_date(record['redApprovalDate'])
        record['issuedDate'] = _iso_date(record['issuedDate'])
        record['expiresDate'] = _iso_date(record['expiresDate'])
        if record['name']:
            records.append(record)
    return records


def search_merchants(query: str) -> list[dict]:
    """Query the PhilGEPS registry. Raises PhilGepsError on failure."""
    normalized = _normalize_query(query)
    if len(normalized) < 3:
        raise PhilGepsError('Payee name too short.')

    try:
        session = requests.Session()
        token = _fetch_csrf_token(session)
        results: list[dict] = []
        for page_no in range(1, MAX_PAGES + 1):
            response = session.post(
                BASE_URL,
                params={'page': page_no},
                data={
                    '_csrfToken': token,
                    'searchOrgName': normalized,
                    'searchMembershipStatus': 'All',
                },
                headers=POST_HEADERS,
                timeout=TIMEOUT,
            )
            if response.status_code != 200:
                raise PhilGepsError(f'PhilGEPS search returned {response.status_code}.')
            page_rows = _parse_rows(response.text)
            results.extend(page_rows)
            if not page_rows or len(results) >= MAX_RESULTS:
                break
    except PhilGepsError:
        raise
    except requests.RequestException as exc:
        raise PhilGepsError('PhilGEPS lookup failed.') from exc

    return results[:MAX_RESULTS]


def lookup(query: str, force_refresh: bool = False) -> dict:
    """Cached lookup. Returns {query, cached, match, results}."""
    normalized = _normalize_query(query)
    if len(normalized) < 3:
        raise PhilGepsError('Payee name too short.')

    now = time.monotonic()
    cached = False
    with _cache_lock:
        entry = _cache.get(normalized)
        if entry and not force_refresh and entry[0] > now:
            cached = True
            results = entry[1]
        else:
            results = None  # type: ignore[assignment]

    if results is None:
        results = search_merchants(normalized)
        ttl = CACHE_TTL_HIT if results else CACHE_TTL_MISS
        with _cache_lock:
            if len(_cache) >= CACHE_MAX_ENTRIES:
                # Drop the oldest entry (dicts preserve insertion order).
                _cache.pop(next(iter(_cache)), None)
            _cache[normalized] = (now + ttl, results)

    match = None
    target = _normalize_name(normalized)
    for record in results:
        if _normalize_name(record.get('name', '')) == target:
            match = record
            break

    logger.info(
        'PhilGEPS lookup: query_len=%d results=%d cached=%s match=%s',
        len(normalized), len(results), cached, match is not None,
    )
    return {
        'query': normalized,
        'cached': cached,
        'match': match,
        'results': [dict(record) for record in results],
    }
