import pyarrow.parquet as pq, pyarrow.fs as pfs, pyarrow as pa, json
fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
p="overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/part-00061-1345e8cd-794d-5a4b-9ee7-8b553dcab556-c000.zstd.parquet"
f=pq.ParquetFile(p, filesystem=fs)
print(f.schema_arrow)
W,S,E,N=-71.13,42.33,-71.02,42.395
tabs=[]
for rg in [178,179,182,185,186,187,188,190]:
    t=f.read_row_group(rg, columns=['id','geometry','bbox','height','num_floors','names','class'])
    b=t.column('bbox').combine_chunks()
    import pyarrow.compute as pc
    m=pc.and_(pc.and_(pc.greater_equal(b.field('xmin'),W),pc.less_equal(b.field('xmax'),E)),pc.and_(pc.greater_equal(b.field('ymin'),S),pc.less_equal(b.field('ymax'),N)))
    tabs.append(t.filter(m))
t=pa.concat_tables(tabs)
print(t.num_rows)
pq.write_table(t,'boston.parquet')
