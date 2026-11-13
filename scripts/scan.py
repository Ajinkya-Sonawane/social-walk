import pyarrow.parquet as pq, pyarrow.fs as pfs, sys, concurrent.futures as cf
fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
base="overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/"
files=[f.path for f in fs.get_file_info(pfs.FileSelector(base)) if f.path.endswith('.parquet')]
print(len(files), file=sys.stderr)
W,S,E,N=-71.13,42.33,-71.02,42.395
def scan(p):
    md=pq.ParquetFile(p, filesystem=fs).metadata
    names=[md.schema.column(i).path for i in range(md.num_columns)]
    idx={n:i for i,n in enumerate(names)}
    hits=[]
    for rg in range(md.num_row_groups):
        r=md.row_group(rg)
        def st(n): 
            s=r.column(idx[n]).statistics; return s.min,s.max
        xmin=st('bbox.xmin'); xmax=st('bbox.xmax'); ymin=st('bbox.ymin'); ymax=st('bbox.ymax')
        if xmin[0]<=E and xmax[1]>=W and ymin[0]<=N and ymax[1]>=S: hits.append(rg)
    return p,hits
with cf.ThreadPoolExecutor(16) as ex:
    for p,h in ex.map(scan, files):
        if h: print(p, h)
