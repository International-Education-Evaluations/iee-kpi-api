import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { api } from './useApi';
import { disambiguateWorkers } from '../components/UI';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [kpiSegs, setKpiSegs] = useState([]);
  const [qcEvents, setQcEvents] = useState([]);
  const [queueSnap, setQueueSnap] = useState(null);
  const [queueWait, setQueueWait] = useState(null);
  const [classified, setClassified] = useState(null);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [qcLoading, setQcLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const loadedRef = useRef({ kpi: false, qc: false, queue: false });

  const loadKpi = useCallback(async (force = false) => {
    if (loadedRef.current.kpi && !force) return;
    setKpiLoading(true);
    try {
      let all = [], p = 1, more = true;
      while (more) {
        const d = await api(`/data/kpi-segments?days=60&page=${p}&pageSize=5000`);
        all = all.concat(d.segments || []);
        more = d.hasMore; p++;
      }
      setKpiSegs(disambiguateWorkers(all));
      loadedRef.current.kpi = true;
      try { const c = await api('/kpi-classify?days=60&page=1&pageSize=5000'); setClassified(c); } catch {}
    } catch (e) { console.error('KPI load failed:', e); }
    setKpiLoading(false);
  }, []);

  const loadQc = useCallback(async (force = false) => {
    if (loadedRef.current.qc && !force) return;
    setQcLoading(true);
    try {
      const d = await api('/data/qc-events?days=60&includeHtml=false&includeText=false');
      setQcEvents(d.events || []);
      loadedRef.current.qc = true;
    } catch (e) { console.error('QC load failed:', e); }
    setQcLoading(false);
  }, []);

  const loadQueue = useCallback(async (force = false) => {
    if (loadedRef.current.queue && !force) return;
    setQueueLoading(true);
    try {
      const [s, w] = await Promise.all([
        api('/data/queue-snapshot'),
        api('/queue-wait-summary?days=450')
      ]);
      setQueueSnap(s);
      setQueueWait(w);
      loadedRef.current.queue = true;
    } catch (e) { console.error('Queue load failed:', e); }
    setQueueLoading(false);
  }, []);

  const forceRefreshQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const [s, w] = await Promise.all([
        api('/queue-snapshot'),
        api('/queue-wait-summary?days=450')
      ]);
      setQueueSnap({ ...s, source: 'live' });
      setQueueWait(w);
    } catch (e) { console.error(e); }
    setQueueLoading(false);
  }, []);

  const refreshAll = useCallback(async () => {
    loadedRef.current = { kpi: false, qc: false, queue: false };
    await Promise.all([loadKpi(true), loadQc(true), loadQueue(true)]);
  }, [loadKpi, loadQc, loadQueue]);

  return (
    <DataContext.Provider value={{
      kpiSegs, qcEvents, queueSnap, queueWait, classified,
      kpiLoading, qcLoading, queueLoading,
      loadKpi, loadQc, loadQueue, forceRefreshQueue, refreshAll
    }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be inside DataProvider');
  return ctx;
}
