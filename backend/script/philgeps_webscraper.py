"""CLI debug tool for the PhilGEPS merchant lookup.

Usage (from the backend directory):

    .\\.venv\\Scripts\\python.exe script\\philgeps_webscraper.py "JDF HEAVY EQUIPMENT"

Prints the cached-lookup payload (match + results) as JSON. The application
itself calls the same service through GET /api/philgeps/merchants/.
"""

import json
import os
import sys

import django

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from ledger.philgeps import PhilGepsError, lookup  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2 or not ' '.join(sys.argv[1:]).strip():
        print('usage: python script/philgeps_webscraper.py "PAYEE NAME"')
        return 2
    query = ' '.join(sys.argv[1:])
    try:
        payload = lookup(query, force_refresh=True)
    except PhilGepsError as exc:
        print(f'lookup failed: {exc}')
        return 1
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
