import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Card, Table, Section, Pills, Skel, FilterBar, FilterSelect, FilterInput, FilterReset, fmt, fmtI, disambiguateWorkers } from '../components/UI';
import { api } from '../hooks/useApi';

const TT = { contentStyle:{ background:'#1e293b', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8, color:'#fff', fontSize:12 } };
const BUCKET_COLORS = { 'Exclude Short':'#616161', 'Out-of-Range Short':'#F57F17', 'In-Range':'#2E7D32', 'Out-of-Range Long':'#E65100', 'Exclude Long':'#B71C1C', 'Unclassified':'#424242', 'Open':'#1565C0' };

export default function KPIOverview() {
  const [segs, setSegs] = useState([]);
  const [classified, setClassified] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('status');
  const [fType, setFType] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');
  const [fWorker, setFWorker] = useState('');
  const [fBucket, setFBucket] = useState('');
  const nav = useNavigate();

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try {
      // Fetch both raw segments and classified data
      let all = [], p = 1, more = true;
      while (more) { const d = await api(`/kpi-segments?days=60&page=${p}&pageSize=5000`); all = all.concat(d.segments||[]); more = d.hasMore; p++; }
      setSegs(disambiguateWorkers(all));
      // Also fetch classification summary (first page only for stats)
      try { const c = await api('/kpi-classify?days=60&page=1&pageSize=5000'); setClassified(c); } catch {}
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  const workers = useMemo(() => {
    const m = {};
    segs.forEach(s => { if (s.workerEmail) m[s.workerEmail] = s.displayName || s.workerName; });
    return Object.entries(m).map(([v,l]) => ({value:v,label:l})).sort((a,b) => a.label.localeCompare(b.label));
  }, [segs]);

  const filtered = useMemo(() => segs.filter(s => {
    if (fType && s.orderType !== fType) return false;
    if (fWorker && s.workerEmail !== fWorker) return false;
    if (fFrom && s.segmentStart && s.segmentStart < fFrom) return false;
    if (fTo && s.segmentStart && s.segmentStart > fTo + 'T23:59:59') return false;
    return true;
  }), [segs, fType, fFrom, fTo, fWorker]);

  // Filter classified segments if available
  const filteredClassified = useMemo(() => {
    if (!classified?.segments) return [];
    return classified.segments.filter(s => {
      if (fType && s.orderType !== fType) return false;
      if (fWorker && s.workerEmail !== fWorker) return false;
      if (fBucket && s.bucket !== fBucket) return false;
      return true;
    });
  }, [classified, fType, fWorker, fBucket]);

  const metrics = useMemo(() => {
    if (!filtered.length) return null;
    const closed = filtered.filter(s => !s.isOpen && s.durationMinutes > 0);
    const totalMin = closed.reduce((a,s) => a + (s.durationMinutes||0), 0);
    return {
      total: filtered.length, closed: closed.length, open: filtered.filter(s=>s.isOpen).length,
      avg: closed.length ? totalMin/closed.length : 0, hrs: totalMin/60,
      workers: new Set(filtered.map(s=>s.workerEmail).filter(Boolean)).size,
      orders: new Set(filtered.map(s=>s.orderSerialNumber).filter(Boolean)).size
    };
  }, [filtered]);

  // 5-bucket stats
  const bucketStats = useMemo(() => {
    if (!classified?.classification) return null;
    return classified.classification;
  }, [classified]);

  const bucketChartData = useMemo(() => {
    if (!bucketStats?.bucketCounts) return [];
    const order = ['Exclude Short', 'Out-of-Range Short', 'In-Range', 'Out-of-Range Long', 'Exclude Long', 'Unclassified', 'Open'];
    return order.filter(b => bucketStats.bucketCounts[b]).map(b => ({ bucket: b, count: bucketStats.bucketCounts[b], fill: BUCKET_COLORS[b] }));
  }, [bucketStats]);

  const byStatus = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const k = s.statusName||s.statusSlug||'Unknown';
      if (!m[k]) m[k] = {status:k,count:0,totalMin:0,closed:0,open:0};
      m[k].count++; if (!s.isOpen && s.durationMinutes>0){m[k].totalMin+=s.durationMinutes;m[k].closed++;} if(s.isOpen) m[k].open++;
    });
    return Object.values(m).map(d=>({...d,avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null,hrs:Math.round(d.totalMin/60*10)/10})).sort((a,b)=>b.count-a.count);
  }, [filtered]);

  const byWorker = useMemo(() => {
    const m = {};
    filtered.forEach(s => {
      const k = s.workerEmail||'none';
      if (!m[k]) m[k] = {worker:s.displayName||s.workerName||'UNATTRIBUTED',email:k,count:0,totalMin:0,closed:0};
      m[k].count++; if(!s.isOpen&&s.durationMinutes>0){m[k].totalMin+=s.durationMinutes;m[k].closed++;}
    });
    return Object.values(m).map(d=>({...d,avg:d.closed?Math.round(d.totalMin/d.closed*10)/10:null,hrs:Math.round(d.totalMin/60*10)/10})).sort((a,b)=>b.count-a.count);
  }, [filtered]);

  const daily = useMemo(() => {
    const m = {};
    filtered.forEach(s => { const d = s.segmentStart?.substring(0,10); if(!d) return; if(!m[d]) m[d]={date:d,count:0}; m[d].count++; });
    return Object.values(m).sort((a,b)=>a.date.localeCompare(b.date));
  }, [filtered]);

  const clearFilters = () => { setFType(''); setFFrom(''); setFTo(''); setFWorker(''); setFBucket(''); };

  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-display font-bold text-white">KPI Overview</h1><p className="text-xs text-slate-400 mt-0.5">Processing performance · Last 60 days</p></div>

      <FilterBar>
        <FilterSelect label="Order Type" value={fType} onChange={setFType} options={['evaluation','translation']} />
        <FilterSelect label="Worker" value={fWorker} onChange={setFWorker} options={workers} allLabel="All Workers" />
        <FilterInput label="From" value={fFrom} onChange={setFFrom} type="date" />
        <FilterInput label="To" value={fTo} onChange={setFTo} type="date" />
        {classified && <FilterSelect label="Bucket" value={fBucket} onChange={setFBucket} options={['Exclude Short','Out-of-Range Short','In-Range','Out-of-Range Long','Exclude Long','Unclassified','Open']} />}
        <FilterReset onClick={clearFilters} />
      </FilterBar>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
        <Card label="Segments" value={fmtI(metrics?.total)} loading={loading} />
        <Card label="Closed" value={fmtI(metrics?.closed)} color="green" loading={loading} />
        <Card label="Open" value={fmtI(metrics?.open)} color="amber" loading={loading} />
        <Card label="Avg Duration" value={fmt(metrics?.avg)} sub="min" loading={loading} />
        <Card label="Total Hours" value={fmtI(Math.round(metrics?.hrs||0))} loading={loading} />
        <Card label="Workers" value={fmtI(metrics?.workers)} color="plum" loading={loading} />
        <Card label="Orders" value={fmtI(metrics?.orders)} color="slate" loading={loading} />
      </div>

      {/* 5-Bucket Classification */}
      {bucketStats && <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="glass rounded-xl p-4">
          <Section title="5-Bucket Classification" sub={`${classified?.benchmarksApplied || 0} benchmarks applied`}>
            <div className="grid grid-cols-3 gap-2 mt-3">
              <div className="text-center p-2 rounded-lg bg-emerald-600/10 border border-emerald-500/20">
                <div className="text-xl font-bold text-emerald-400">{bucketStats.inRangePercent}%</div>
                <div className="text-[10px] text-slate-400">In-Range</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-orange-600/10 border border-orange-500/20">
                <div className="text-xl font-bold text-orange-400">{bucketStats.outRangeShortPercent}%</div>
                <div className="text-[10px] text-slate-400">Out Short</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-red-600/10 border border-red-500/20">
                <div className="text-xl font-bold text-red-400">{bucketStats.outRangeLongPercent}%</div>
                <div className="text-[10px] text-slate-400">Out Long</div>
              </div>
            </div>
            <div className="flex gap-2 mt-2 text-[10px] text-slate-500">
              <span>Excluded: {bucketStats.excludedPercent}%</span>
              <span>Unclassified: {bucketStats.unclassifiedPercent}%</span>
            </div>
          </Section>
        </div>
        <div className="glass rounded-xl p-4">
          <Section title="Bucket Distribution">
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={bucketChartData} margin={{left:0,right:10}}>
                <XAxis dataKey="bucket" tick={{fill:'#94a3b8',fontSize:9}} angle={-20} textAnchor="end" height={50} />
                <YAxis tick={{fill:'#94a3b8',fontSize:10}} />
                <Tooltip {...TT} />
                <Bar dataKey="count" radius={[3,3,0,0]}>{bucketChartData.map((d,i) => <Cell key={i} fill={d.fill} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </Section>
        </div>
      </div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="glass rounded-xl p-4">
          <Section title="Segments by Status" sub="Top 10">
            {loading ? <Skel rows={6} cols={1} /> :
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={byStatus.slice(0,10)} layout="vertical" margin={{left:10,right:15}}>
                <XAxis type="number" tick={{fill:'#94a3b8',fontSize:10}} />
                <YAxis type="category" dataKey="status" width={160} tick={{fill:'#94a3b8',fontSize:10}} />
                <Tooltip {...TT} /><Bar dataKey="count" fill="#3d6bab" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>}
          </Section>
        </div>
        <div className="glass rounded-xl p-4">
          <Section title="Daily Volume">
            {loading ? <Skel rows={6} cols={1} /> :
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={daily} margin={{left:0,right:10}}>
                <XAxis dataKey="date" tick={{fill:'#94a3b8',fontSize:9}} angle={-45} textAnchor="end" height={55} />
                <YAxis tick={{fill:'#94a3b8',fontSize:10}} />
                <Tooltip {...TT} /><Bar dataKey="count" fill="#2E7D32" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>}
          </Section>
        </div>
      </div>

      <Section title="Breakdown" right={
        <Pills tabs={[{key:'status',label:'By Status'},{key:'worker',label:'By Worker'}]} active={view} onChange={setView} />
      }>
        {view === 'status' ?
          <Table cols={[
            {key:'status',label:'Status',w:200},
            {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
            {key:'closed',label:'Closed',right:true,render:v=>fmtI(v)},
            {key:'open',label:'Open',right:true,render:v=>fmtI(v)},
            {key:'avg',label:'Avg Min',right:true,render:v=>fmt(v)},
            {key:'hrs',label:'Total Hrs',right:true,render:v=>fmt(v)}
          ]} rows={byStatus} />
        :
          <Table cols={[
            {key:'worker',label:'Worker',w:200},
            {key:'count',label:'Segments',right:true,render:v=>fmtI(v)},
            {key:'avg',label:'Avg Min',right:true,render:v=>fmt(v)},
            {key:'hrs',label:'Total Hrs',right:true,render:v=>fmt(v)}
          ]} rows={byWorker} onRow={r => r.email !== 'none' && nav(`/kpi/users?worker=${r.email}`)} />
        }
      </Section>
    </div>
  );
}
