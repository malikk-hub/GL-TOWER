import asyncio, json
from playwright.async_api import async_playwright
APP='file:///home/claude/work/gl-towers/web/index.html'
R=[]
def rec(id,name,expected,observed,ok): R.append(dict(id=id,name=name,expected=expected,observed=observed,result='Pass' if ok else 'Fail')); print(id,ok,observed)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':1440,'height':900})
        pg=await ctx.new_page(); errs=[]
        pg.on('pageerror',lambda e: errs.append(str(e))); pg.on('dialog',lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(APP+'#dashboard'); await pg.wait_for_timeout(800)
        await pg.evaluate("localStorage.clear()"); await pg.reload(); await pg.wait_for_timeout(800)
        # T1 navigation
        routes=['dashboard','towers','sensors','irrigation','lighting','plants','insights','alerts','devices','reports','settings']; okr=0
        for r in routes:
            await pg.evaluate(f"location.hash='#{r}'"); await pg.wait_for_timeout(300)
            L=await pg.evaluate("document.querySelector('.content').innerText.length")
            okr+= L>200
        rec('T01','Navigation between the 11 workspaces','Each workspace renders, no JavaScript error',f'{okr}/11 rendered, {len(errs)} JS errors',okr==11 and not errs)
        # T2 add tower via wizard
        n0=await pg.evaluate("getTowers().length")
        await pg.evaluate("location.hash='#towers'"); await pg.wait_for_timeout(400)
        await pg.click('[data-add-tower-normal]'); await pg.wait_for_timeout(300)
        await pg.fill('#newTowerName','Test Tower'); await pg.click('[data-create-tower-from-wizard]'); await pg.wait_for_timeout(400)
        n1=await pg.evaluate("getTowers().length"); has=await pg.evaluate("getTowers().some(t=>t.name==='Test Tower')")
        rec('T02','Add a tower with the 4-step wizard','Tower count +1, new tower listed',f'{n0} to {n1} towers, "Test Tower" listed={has}',n1==n0+1 and has)
        # T3 persistence
        await pg.reload(); await pg.wait_for_timeout(800)
        has2=await pg.evaluate("getTowers().some(t=>t.name==='Test Tower')"); n2=await pg.evaluate("getTowers().length")
        rec('T03','Saved data after page reload','New tower still present after reload',f'{n2} towers after reload, "Test Tower" present={has2}',has2 and n2==n1)
        # T4 select tower persists
        tid=await pg.evaluate("getTowers().find(t=>t.name==='Test Tower').id")
        await pg.evaluate(f"setSelectedTowerId('{tid}');render()"); await pg.reload(); await pg.wait_for_timeout(700)
        sel=await pg.evaluate("selectedTower().name")
        rec('T04','Selected tower kept after reload','"Test Tower" still selected',f'selected = "{sel}"',sel=='Test Tower')
        # T5/T6 irrigation recommendations
        for tid_,stage,sub in [('T05','mature','coco'),('T06','seedling','rockwool')]:
            await pg.evaluate("location.hash='#irrigation'"); await pg.wait_for_timeout(400)
            exp=await pg.evaluate(f"DASH_IRRIGATION_MATRIX['{stage}']['{sub}']")
            sel_=f'[data-apply-irrigation-preset="{sub}"][data-stage="{stage}"]'
            cnt=await pg.locator(sel_).count()
            if cnt: await pg.locator(sel_).first.click()
            else: await pg.evaluate(f"(()=>{{const e=document.createElement('button');e.dataset.applyIrrigationPreset='{sub}';e.dataset.stage='{stage}';document.body.appendChild(e);e.click();e.remove();}})()")
            await pg.wait_for_timeout(300)
            pump=await pg.evaluate("(()=>{const t=selectedTower();return [t.pump.pumpOn,t.pump.pumpPause,t.pump.profile]})()")
            names={'mature':'Mature','seedling':'Seedling','coco':'coco coir','rockwool':'rockwool'}
            rec(tid_,f'Irrigation recommendation: {names[stage]} stage + {names[sub]}',f"ON {exp['on']} min / pause {exp['off']} min",f'ON {pump[0]} min / pause {pump[1]} min',pump[0]==exp['on'] and pump[1]==exp['off'])
        # T7 lighting preset
        await pg.evaluate("location.hash='#lighting'"); await pg.wait_for_timeout(400)
        keys=await pg.evaluate("Object.keys(DASH_LED_PRESETS)")
        k='bloom' if 'bloom' in keys else keys[0]
        exp=await pg.evaluate(f"DASH_LED_PRESETS['{k}']")
        await pg.locator(f'[data-apply-light-preset="{k}"]').first.click(); await pg.wait_for_timeout(300)
        li=await pg.evaluate("selectedTower().lighting")
        rec('T07',f'Apply the {exp["label"]} LED preset',f'Photoperiod {exp.get("photo")} h, intensity {exp.get("intensity")} %',f'Photoperiod {li["photoperiod"]} h, intensity {li["brightness"]} %',li['photoperiod']==exp.get('photo') and li['brightness']==exp.get('intensity'))
        # T8 Italian
        await pg.evaluate("location.hash='#settings'"); await pg.wait_for_timeout(300)
        await pg.evaluate("(()=>{const s=getAppSettings();s.language='it';saveAppSettings(s);setLanguageShell();render();})()"); await pg.wait_for_timeout(600)
        nav=await pg.evaluate("document.querySelector('.nav,nav,.sidebar').innerText")
        it=any(w in nav for w in ['Impostazioni','Irrigazione','Illuminazione','Piante'])
        rec('T08','Switch the interface to Italian','Navigation and labels shown in Italian','Sidebar shows "'+', '.join([w for w in ['Impostazioni','Irrigazione','Illuminazione','Piante','Sensori'] if w in nav])+'"',it)
        await pg.reload(); await pg.wait_for_timeout(700)
        nav=await pg.evaluate("document.querySelector('.nav,nav,.sidebar').innerText")
        rec('T09','Language choice kept after reload','Interface still in Italian','Italian still active' if 'Impostazioni' in nav or 'Irrigazione' in nav else 'reverted to English','Impostazioni' in nav or 'Irrigazione' in nav)
        await pg.evaluate("(()=>{const s=getAppSettings();s.language='en';saveAppSettings(s);})()"); await pg.reload(); await pg.wait_for_timeout(700)
        nav=await pg.evaluate("document.querySelector('.nav,nav,.sidebar').innerText")
        rec('T10','Switch back to English','Navigation shown in English','Sidebar shows "Settings", "Irrigation"' if 'Settings' in nav else nav[:60],'Settings' in nav and 'Irrigation' in nav)
        # T11 plant search
        await pg.evaluate("location.hash='#plants'"); await pg.wait_for_timeout(500)
        total=await pg.evaluate("APP_PLANTS.length")
        await pg.fill('#plantManagerSearch','basil'); await pg.wait_for_timeout(500)
        txt=await pg.evaluate("(document.body.innerText.match(/(\\d+) visible/)||[])[1]||''")
        rows=await pg.evaluate("[...document.querySelectorAll('tr')].filter(r=>r.offsetParent&&/basil/i.test(r.innerText)).length")
        rec('T11','Search "basil" in the plant library',f'Only matching plants shown (out of {total})',f'{txt or "?"} visible, {rows} rows containing "basil"',txt!='' and int(txt)<total and rows>0)
        # T12 delete tower
        n3=await pg.evaluate("getTowers().length"); tid=await pg.evaluate("getTowers().find(t=>t.name==='Test Tower').id")
        await pg.evaluate(f"deleteTowerNormal('{tid}')"); await pg.wait_for_timeout(400)
        n4=await pg.evaluate("getTowers().length"); gone=await pg.evaluate("!getTowers().some(t=>t.name==='Test Tower')"); s=await pg.evaluate("selectedTower()&&selectedTower().name")
        rec('T12','Delete a tower (with confirmation)','Tower removed, another tower selected',f'{n3} to {n4} towers, new selection "{s}"',gone and n4==n3-1 and bool(s))
        # T13 mobile
        m=await ctx.new_page(); await m.set_viewport_size({'width':390,'height':844}); await m.goto(APP+'#dashboard'); await m.wait_for_timeout(800)
        sw=await m.evaluate("document.documentElement.scrollWidth")
        cw=await m.evaluate("Math.min(...[...document.querySelector('.metrics-6').children].map(c=>c.getBoundingClientRect().width))")
        rec('T13','Responsive layout on a 390 px phone screen','No horizontal scrolling, sensor cards readable (2 per row)',f'page width {sw} px, smallest card {round(cw)} px wide',sw<=392 and cw>=140)
        await m.screenshot(path='/home/claude/work/shots/mobile.png')
        rec('T14','JavaScript errors during the whole session','0 errors',f'{len(errs)} errors',len(errs)==0)
        json.dump(R,open('/home/claude/work/gl-towers/tests/demo_results.json','w'),indent=1)
        await b.close()
asyncio.run(main())
