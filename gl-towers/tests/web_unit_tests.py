"""GL Towers — unit tests of the web application logic (U1–U5 of the report).
Run: python3 tests/web_unit_tests.py   (opens web/index.html as a file, demo mode)
"""
import asyncio, json, os
from playwright.async_api import async_playwright

APP = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'web', 'index.html'))

CHECKS = """(()=>{
  const out={};
  let ok=0,n=0;
  for(const st of Object.keys(DASH_IRRIGATION_MATRIX))for(const su of Object.keys(DASH_IRRIGATION_MATRIX[st])){n++;
    if(currentIrrigationRecommendation({stage:'x'},st,su)===DASH_IRRIGATION_MATRIX[st][su])ok++;}
  out.U1=[ok===20&&n===20,`${ok}/${n} correct`];
  const m=[['Germination','germination'],['Seedling','seedling'],['Vegetative','vegetative'],['Flowering','mature'],['Mature','mature'],['Empty','vegetative']];
  const good=m.filter(([a,e])=>irrigationStageFromTower({stage:a})===e).length;
  out.U2=[good===6,`${good}/6 correct`];
  const fb=currentIrrigationRecommendation({},'unknown','unknown');
  out.U3=[fb.on===1.5&&fb.off===90,`${fb.on} / ${fb.off} min`];
  const P=APP_PLANTS, cats=new Set(P.map(p=>p.categoryGL)).size;
  const missing=P.filter(p=>!p.displayName||!p.nameIT||p.phMin==null||p.phMax==null).length;
  const bad=P.filter(p=>!(parseFloat(p.phMin)<parseFloat(p.phMax))).length;
  out.U4=[P.length===254&&cats===8&&!missing&&!bad,`${P.length} entries, ${cats} categories, ${missing} missing, ${bad} invalid`];
  const ids=new Set(P.map(p=>p.id)).size;
  out.U5=[ids===P.length,`${ids} distinct ids for ${P.length} entries`];
  return out;})()"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page()
        await pg.goto(APP); await pg.wait_for_timeout(800)
        res = await pg.evaluate(CHECKS)
        for k, (ok, obs) in res.items(): print(k, 'PASS' if ok else 'FAIL', obs)
        print(f"{sum(1 for v in res.values() if v[0])}/{len(res)} passed")
        await b.close()

asyncio.run(main())
