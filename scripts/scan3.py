import pyarrow.parquet as pq, pyarrow.fs as pfs, pyarrow as pa, pyarrow.compute as pc, concurrent.futures as cf
fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
W,S,E,N=-71.13,42.33,-71.02,42.395
def run(theme,typ,cols,out):
    base=f"overturemaps-us-west-2/release/2026-10-21.0/theme={theme}/type={typ}/"
    files=[f.path for f in fs.get_file_info(pfs.FileSelector(base)) if f.path.endswith('.parquet')]
    def scan(p):
        pf=pq.ParquetFile(p, filesystem=fs); md=pf.metadata
        idx={md.schema.column(i).path:i for i in range(md.num_columns)}
        tabs=[]
        for rg in range(md.num_row_groups):
            r=md.row_group(rg)
            st=lambda n:(r.column(idx[n]).statistics.min,r.column(idx[n]).statistics.max)
            if st('bbox.xmin')[0]<=E and st('bbox.xmax')[1]>=W and st('bbox.ymin')[0]<=N and st('bbox.ymax')[1]>=S:
                t=pf.read_row_group(rg,columns=cols+['bbox']); b=t.column('bbox').combine_chunks()
                m=pc.and_(pc.and_(pc.less_equal(b.field('xmin'),E),pc.greater_equal(b.field('xmax'),W)),pc.and_(pc.less_equal(b.field('ymin'),N),pc.greater_equal(b.field('ymax'),S)))
                tabs.append(t.filter(m))
        return tabs
    allt=[]
    with cf.ThreadPoolExecutor(16) as ex:
        for ts in ex.map(scan, files): allt+=ts
    t=pa.concat_tables(allt); print(out,t.num_rows); pq.write_table(t,out)
run('places','place',['id','geometry','names','basic_category','taxonomy','confidence','operating_status'],'places.parquet')
run('base','land',['id','geometry','subtype','class'],'land.parquet')
run('base','infrastructure',['id','geometry','subtype','class'],'infra.parquet')
run('buildings','building',['id','geometry','names','height','num_floors','facade_color','facade_material','roof_color','roof_shape','min_height','is_underground'],'buildings2.parquet')
run('buildings','building_part',['id','geometry','height','min_height','building_id','facade_color','roof_color','roof_shape'],'parts.parquet')
