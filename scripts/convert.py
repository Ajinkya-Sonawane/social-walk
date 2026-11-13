import pyarrow.parquet as pq, json, math, hashlib
from shapely import wkb
from shapely.geometry import box, Polygon, MultiPolygon, LineString, MultiLineString, GeometryCollection
from shapely.ops import transform
W,S,E,N=-71.13,42.33,-71.02,42.395
LON0,LAT0=-71.075,42.3625
KX=math.cos(math.radians(LAT0))*111320; KY=110540
proj=lambda x,y,z=None:((x-LON0)*KX,(y-LAT0)*KY)
clip=box(W,S,E,N)
def R(v): return round(v,1)
def flat(coords): 
    out=[]
    for x,y in coords: out+= [R(x),R(y)]
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
out={'origin':[LON0,LAT0],'bounds':[R(proj(W,S)[0]),R(proj(W,S)[1]),R(proj(E,N)[0]),R(proj(E,N)[1])]}
# buildings
B=[]
for r in pq.read_table('boston.parquet',columns=['id','geometry','height','num_floors']).to_pylist():
    g=transform(proj,wkb.loads(r['geometry']))
    h=r['height'] or ((r['num_floors'] or 0)*3.4) or (6+int(hashlib.md5(r['id'].encode()).hexdigest()[:2],16)%8)
    for p in polys(g):
        p=p.simplify(0.4)
        if p.is_empty or p.area<12: continue
        ext=list(p.exterior.coords)[:-1]
        if len(ext)<3: continue
        B.append([R(min(h,300))]+flat(ext))
out['buildings']=B
def area_feats(path, keep):
    res=[]
    for r in pq.read_table(path).to_pylist():
        if not keep(r): continue
        g=wkb.loads(r['geometry']).intersection(clip)
        g=transform(proj,g)
        for p in polys(g):
            p=p.simplify(1.0)
            if p.is_empty or p.area<30: continue
            res.append([flat(list(p.exterior.coords)[:-1])]+[flat(list(i.coords)[:-1]) for i in p.interiors if Polygon(i).area>30])
    return res
out['water']=area_feats('water.parquet',lambda r:r['subtype'] in ('river','ocean','lake','pond','reservoir','physical','water','canal') and r['class'] not in ('ditch','drain','stream'))
out['parks']=area_feats('landuse.parquet',lambda r:r['subtype'] in ('park','recreation','managed','horticulture','cemetery','protected') or r['class'] in ('grass',))
RC={'motorway':0,'trunk':0,'primary':1,'secondary':1,'tertiary':2,'residential':3,'unclassified':3,'living_street':3,'unknown':3,'pedestrian':4,'service':4}
roads=[]
for r in pq.read_table('roads.parquet').to_pylist():
    if r['subtype']!='road' or r['class'] not in RC: continue
    g=transform(proj,wkb.loads(r['geometry']).intersection(clip))
    for l in lines(g):
        l=l.simplify(1.0)
        if l.length<2: continue
        roads.append([RC[r['class']]]+flat(l.coords))
out['roads']=roads
LM=[('Boston Common',-71.0655,42.3550),('Back Bay',-71.0810,42.3503),('Beacon Hill',-71.0685,42.3588),('North End',-71.0542,42.3647),('Downtown',-71.0589,42.3555),('Seaport',-71.0440,42.3480),('Fenway',-71.0972,42.3467),('Kendall Square',-71.0865,42.3629),('MIT',-71.0942,42.3601),('Central Square',-71.1036,42.3651),('Harvard Square',-71.1190,42.3732),('Charles River',-71.0900,42.3560),('East Cambridge',-71.0780,42.3690),('South End',-71.0750,42.3400),('Charlestown',-71.0620,42.3780)]
out['landmarks']=[[n,R(proj(x,y)[0]),R(proj(x,y)[1])] for n,x,y in LM]
print(len(B),len(out['water']),len(out['parks']),len(roads))
json.dump(out,open('city.json','w'),separators=(',',':'))
