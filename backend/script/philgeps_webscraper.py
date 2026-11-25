import requests
from bs4 import BeautifulSoup

session = requests.Session()
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Referer': 'https://philgeps.gov.ph/CmsHomePages/regMerchants',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, */*; q=0.01',
}

url = 'https://philgeps.gov.ph/CmsHomePages/regMerchants'

# The page doesn't have a CSRF token input, but the GET endpoint works directly
orgName = "JDF HEAVY EQUIPMENT PARTS CENTER"
candidates = [
    # (method, url, data_or_params)
    ('GET', f'{url}?page=1&searchOrgName={orgName}&searchMembershipStatus=All', None),
]

for method, u, data in candidates:
    try:
        r = (session.get(u, headers=headers) if method == 'GET'
             else session.post(u, data=data, headers=headers))
        soup_r = BeautifulSoup(r.text, 'html.parser')
        trs = soup_r.find_all('tr')
        labeled = [tr for tr in trs if tr.find('td', {'data-label': 'organization_name'})]
        print(f"[{method}] {u}\n  status={r.status_code} len={len(r.text)} "
              f"tr={len(trs)} labeled_rows={len(labeled)}")
        if labeled:
            print("  ✅ FOUND DATA ENDPOINT")
            for tr in labeled[:3]:
                row = {td['data-label']: td.get_text(separator=' ', strip=True)
                       for td in tr.find_all('td') if td.get('data-label')}
                print("   ", row)
            break
    except Exception as e:
        print(f"[{method}] {u} → ERROR: {e}")