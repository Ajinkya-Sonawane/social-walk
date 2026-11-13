# Builds client/public/data/city.json (geometry) and details.json (names, places, street furniture)
import pyarrow.parquet as pq, json, math, hashlib, shapely
from shapely import wkb
from shapely.geometry import box, Polygon, MultiPolygon, LineString, MultiLineString, GeometryCollection, Point
W,S,E,N=-71.13,42.33,-71.02,42.395
LON0,LAT0=-71.075,42.3625
KX=math.cos(math.radians(LAT0))*111320; KY=110540
def T(g): return shapely.transform(g, lambda c: c*[KX,KY] - [LON0*KX, LAT0*KY])
clip=box(W,S,E,N)
R=lambda v: round(v,1)
def flat(coords):
    out=[]
    for x,y in coords: out+=[R(x),R(y)]
    return out
def polys(g):
    if g.is_empty: return []
    if isinstance(g,Polygon): return [g]
    if isinstance(g,(MultiPolygon,GeometryCollection)): return [p for gg in g.geoms for p in polys(gg)]
    return []
def lines(g):
    if g.is_empty: return []
    if isinstance(g,LineString): return [g]
    if isinstance(g,(MultiLineString,GeometryCollection)): return [p for gg in g.geoms for p in lines(gg)]
    return []
def name(r):
    n=r.get('names'); return (n or {}).get('primary')
out={'origin':[LON0,LAT0],'bounds':[R(-0.055*KX+0),0,0,0]}
x0,y0=(W-LON0)*KX,(S-LAT0)*KY; x1,y1=(E-LON0)*KX,(N-LAT0)*KY
out['bounds']=[R(x0),R(y0),R(x1),R(y1)]
MAT={'brick':1,'stone':2,'glass':3,'concrete':4,'cement_block':4,'metal':3,'wood':5}
B=[]; BN=[]
for r in pq.read_table('buildings2.parquet').to_pylist():
    if r['is_underground'] or (r['min_height'] or 0)>3: continue
    g=T(wkb.loads(r['geometry']))
    h=r['height'] or ((r['num_floors'] or 0)*3.4) or (6+int(hashlib.md5(r['id'].encode()).hexdigest()[:2],16)%8)
    h=R(min(h,300)); m=MAT.get(r['facade_material'],0)
    best=None
    for p in polys(g):
        p=p.simplify(0.4)
        if p.is_empty or p.area<12: continue
        ext=list(p.exterior.coords)[:-1]
        if len(ext)<3: continue
        B.append([h,m]+flat(ext))
        if best is None or p.area>best.area: best=p
    n=name(r)
    if n and best is not None:
        c=best.representative_point(); BN.append([n,R(c.x),R(c.y),h,R(math.sqrt(best.area))])
out['buildings']=B
def area_feats(path, keep):
    res=[]
    for r in pq.read_table(path).to_pylist():
        if not keep(r): continue
        g=T(wkb.loads(r['geometry']).intersection(clip))
        for p in polys(g):
            p=p.simplify(1.0)
            if p.is_empty or p.area<30: continue
            res.append([flat(list(p.exterior.coords)[:-1])]+[flat(list(i.coords)[:-1]) for i in p.interiors if Polygon(i).area>30])
    return res
out['water']=area_feats('water.parquet',lambda r:r['subtype'] in ('river','ocean','lake','pond','reservoir','physical','water','canal') and r['class'] not in ('ditch','drain','stream'))
out['parks']=area_feats('landuse.parquet',lambda r:r['subtype'] in ('park','recreation','managed','horticulture','cemetery','protected') or r['class'] in ('grass',))
RC={'motorway':0,'trunk':0,'primary':1,'secondary':1,'tertiary':2,'residential':3,'unclassified':3,'living_street':3,'unknown':3,'pedestrian':4,'service':4}
roads=[]; snames=[]; sidx={}
for r in pq.read_table('roads.parquet').to_pylist():
    if r['subtype']!='road' or r['class'] not in RC: continue
    n=name(r); ni=-1
    if n:
        if n not in sidx: sidx[n]=len(snames); snames.append(n)
        ni=sidx[n]
    g=T(wkb.loads(r['geometry']).intersection(clip))
    for l in lines(g):
        l=l.simplify(1.0)
        if l.length<2: continue
        roads.append([RC[r['class']],ni]+flat(l.coords))
out['roads']=roads; out['streetNames']=snames
LM=[('Boston Common',-71.0655,42.3550),('Back Bay',-71.0810,42.3503),('Beacon Hill',-71.0685,42.3588),('North End',-71.0542,42.3647),('Downtown',-71.0589,42.3555),('Seaport',-71.0440,42.3480),('Fenway',-71.0972,42.3467),('Kendall Square',-71.0865,42.3629),('MIT',-71.0942,42.3601),('Central Square',-71.1036,42.3651),('Harvard Square',-71.1190,42.3732),('Charles River',-71.0900,42.3560),('East Cambridge',-71.0780,42.3690),('South End',-71.0750,42.3400),('Charlestown',-71.0620,42.3780)]
out['landmarks']=[[n,R((x-LON0)*KX),R((y-LAT0)*KY)] for n,x,y in LM]
json.dump(out,open('city.json','w'),separators=(',',':'))
# ---- details ----
D={'buildingNames':BN}
cats=[]; cidx={}; P=[]
for r in pq.read_table('places.parquet').to_pylist():
    n=name(r)
    if not n or (r['operating_status'] or 'open')!='open' or (r['confidence'] or 0)<0.5: continue
    c=r['basic_category'] or ((r['taxonomy'] or {}).get('primary')) or 'place'
    if c not in cidx: cidx[c]=len(cats); cats.append(c)
    pt=T(wkb.loads(r['geometry']))
    if pt.geom_type!='Point': pt=pt.representative_point()
    P.append([n,cidx[c],R(pt.x),R(pt.y),round(r['confidence'],2)])
D['placeCategories']=cats; D['places']=P
def pts(path, pred):
    o=[]
    for r in pq.read_table(path).to_pylist():
        if not pred(r): continue
        g=T(wkb.loads(r['geometry']))
        if g.geom_type=='Point': o+= [R(g.x),R(g.y)]
    return o
D['trees']=pts('land.parquet',lambda r:r['subtype']=='tree')
D['lamps']=pts('infra.parquet',lambda r:r['class']=='street_lamp')
D['benches']=pts('infra.parquet',lambda r:r['class']=='bench')
D['busStops']=pts('infra.parquet',lambda r:r['class']=='bus_stop')
D['signals']=pts('infra.parquet',lambda r:r['class']=='traffic_signals')
json.dump(D,open('details.json','w'),separators=(',',':'),ensure_ascii=False)
print(len(B),len(BN),len(P),len(cats),len(D['trees'])//2,len(D['lamps'])//2,len(D['benches'])//2,len(snames))
