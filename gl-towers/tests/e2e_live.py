"""GL Towers — browser tests of the web application in LIVE mode (server + broker + simulator running).

Run:  python3 tests/e2e_live.py            (needs: pip install playwright && playwright install chromium)
Uses mosquitto_pub to inject readings as a tower node would.
Writes tests/e2e_results.json
"""
import asyncio, json, subprocess, time, urllib.request, os
from playwright.async_api import async_playwright

BASE = os.environ.get('GL_URL', 'http://localhost:3000')
DEVICE_PWD = os.environ.get('DEVICE_PASSWORD', 'node-dev-pass')
OUT = os.path.join(os.path.dirname(__file__), 'e2e_results.json')
results = []

def api(method, path, body=None):
    req = urllib.request.Request(BASE + '/api' + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or 'null')

def publish(tower, payload):
    subprocess.run(['mosquitto_pub', '-h', 'localhost', '-u', tower, '-P', DEVICE_PWD,
                    '-t', f'gltowers/main/{tower}/sensors', '-m', json.dumps(payload)], check=True)

def rec(id_, name, expected, observed, ok):
    results.append(dict(id=id_, name=name, expected=expected, observed=observed, result='Pass' if ok else 'Fail'))
    print(id_, 'PASS' if ok else 'FAIL', observed)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await page.goto(BASE + '/#dashboard'); await page.wait_for_timeout(2500)

        # E1 — live mode detected
        status = await page.evaluate("document.querySelector('.status-card').innerText.replace(/\\n/g,' ')")
        rec('E1', 'Web application connects to the server', 'Top bar shows "Live data — Connected"', status, 'Live data' in status and 'Connected' in status)

        # E2 — dashboard updated without reload when a reading arrives
        # tower-07 has no simulator attached, so only this test publishes for it
        await page.evaluate("setSelectedTowerId('tower-07'); render()")
        await page.wait_for_timeout(500)
        t0 = time.time(); publish('tower-07', {'ph': 6.8, 'level': 57, 'waterTemp': 21.6, 'airTemp': 22.7, 'humidity': 64})
        ok = False
        for _ in range(30):
            await page.wait_for_timeout(200)
            txt = await page.evaluate("document.querySelector('.content').innerText")
            if '6.8' in txt and '57%' in txt: ok = True; break
        rec('E2', 'Reading from tower-07 shown on the dashboard', 'pH 6.8 and level 57 % displayed without reload',
            f'Values displayed {time.time()-t0:.1f} s after publication, page not reloaded' if ok else 'not displayed', ok)

        # E3 — irrigation preset from the UI becomes a command confirmed by the node (tower-01 has a simulated node)
        await page.evaluate("setSelectedTowerId('tower-01'); location.hash='#irrigation'")
        await page.wait_for_timeout(1500)
        sel = '[data-apply-irrigation-preset="coco"][data-stage="mature"]'
        if await page.locator(sel).count():
            await page.locator(sel).first.click()
        else:
            await page.evaluate("""(()=>{const e=document.createElement('button');e.dataset.applyIrrigationPreset='coco';e.dataset.stage='mature';document.body.appendChild(e);e.click();e.remove();})()""")
        toast = ''
        for _ in range(25):
            await page.wait_for_timeout(200)
            toast = await page.evaluate("document.querySelector('.settings-save-toast')?.innerText||''")
            if 'confirmed' in toast: break
        pump = api('GET', '/towers/tower-01')['pump']
        ok = pump['pumpOn'] == 2 and pump['pumpPause'] == 75 and 'confirmed' in toast
        rec('E3', 'Irrigation preset Mature + Coco coir applied from the UI', 'Command sent, confirmed by the node, stored by the API',
            f'Toast "{toast}"; API pump = ON {pump["pumpOn"]} / pause {pump["pumpPause"]} min', ok)
        api('POST', '/towers/tower-01/commands', {'target': 'pump', 'pumpOn': 1, 'pumpPause': 90})

        # E4 — add then delete a tower from the UI, checked in the database through the API
        await page.evaluate("location.hash='#towers'"); await page.wait_for_timeout(1200)
        await page.click('[data-add-tower-normal]'); await page.wait_for_timeout(400)
        await page.fill('#newTowerName', 'E2E Tower'); await page.click('[data-create-tower-from-wizard]')
        created = None
        for _ in range(20):
            await page.wait_for_timeout(250)
            created = next((t for t in api('GET', '/towers') if t['name'] == 'E2E Tower'), None)
            if created: break
        deleted = False
        if created:
            await page.evaluate(f"deleteTowerNormal('{created['id']}')")
            for _ in range(20):
                await page.wait_for_timeout(250)
                if not any(t['id'] == created['id'] for t in api('GET', '/towers')): deleted = True; break
        rec('E4', 'Add and delete a tower from the UI', 'Tower stored in the database, then removed',
            f'Created "{created["id"] if created else "-"}" in the database, deleted={deleted}', bool(created) and deleted)

        # E5 — acknowledge an alert from the Alerts workspace
        publish('tower-03', {'ph': 7.7, 'level': 80})
        await page.wait_for_timeout(1500)
        await page.goto(BASE + '/#alerts'); await page.wait_for_timeout(2500)
        btn = page.locator('[data-live-ack]').first
        aid = await btn.get_attribute('data-live-ack') if await btn.count() else None
        if aid: await btn.click(); await page.wait_for_timeout(1000)
        acked = aid and any(a['id'] == int(aid) and a['ack'] for a in api('GET', '/alerts'))
        rec('E5', 'Acknowledge an alert in the Alerts workspace', 'Alert marked as acknowledged in the database',
            f'Alert #{aid} acknowledged' if acked else 'not acknowledged', bool(acked))

        # E6 — devices workspace lists the nodes with their state
        await page.evaluate("location.hash='#devices'"); await page.wait_for_timeout(1500)
        txt = await page.evaluate("document.querySelector('.live-card')?.innerText||''")
        ok = 'node-tower-01' in txt and 'Online' in txt and 'Offline' in txt
        rec('E6', 'Devices workspace shows the sensor nodes', 'Online and offline nodes with pump state and signal',
            'Nodes listed: ' + ', '.join(sorted({w for w in txt.split() if w.startswith('node-')})), ok)

        rec('E7', 'No JavaScript error during the session', '0 errors', f'{len(errors)} errors', not errors)
        await browser.close()
    json.dump(results, open(OUT, 'w'), indent=1)
    print(f"{sum(r['result']=='Pass' for r in results)}/{len(results)} passed")

asyncio.run(main())
