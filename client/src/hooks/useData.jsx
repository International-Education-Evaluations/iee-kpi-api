import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { api } from './useApi';
import { disambiguateWorkers } from '../components/UI';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [kpiSegs, setKpiSegs] = useState([]);
  const [classifiedSummary, setClassifiedSummary] = useState(null);
  const [qcEvents, setQcEvents] = useState([]);
  const [queueSnap, setQueueSnap] = useState(null);
  const [queueWait, setQueueWait] = useState(null);
  const [users, setUsers] = useState([]);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [qcLoading, setQcLoading] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const loadedRef = useRef({ kpi: false, qc: false, queue: false });

  // ── Load KPI: fetch classified segments (paginated) ─────
  // /kpi-classify returns segments WITH bucket, userLevel, departmentName, xphTarget
  // This is a superset of /data/kpi-segments — use it as primary source
  const loadKpi = useCallback(async (force = false) => {
    if (loadedRef.current.kpi && !force) return;
    setKpiLoading(true);
    try {
      // Also load users for fallback dept resolution
      const usersData = await api('/data/users').catch(() => ({ users: [] }));
      const userList = usersData.users || [];
      setUsers(userList);

      // Build email→dept and v1Id→dept maps from backfill_users
      const deptByEmail = {};
      const deptByV1Id = {};
      for (const u of userList) {
        if (u.email && u.departmentName) deptByEmail[u.email.toLowerCase()] = u.departmentName;
        if (u.v1Id && u.departmentName) deptByV1Id[String(u.v1Id)] = u.departmentName;
      }

      // Paginated fetch of classified segments
      let all = [], p = 1, more = true, summary = null;
      while (more) {
        const d = await api(`/kpi-classify?days=60&page=${p}&pageSize=5000`);
        if (p === 1) summary = d.classification;
        const segs = (d.segments || []).map(s => {
          // Resolve department: classify endpoint provides it, fallback to user lookup
          let dept = s.departmentName || '';
          if (!dept && s.workerEmail) dept = deptByEmail[s.workerEmail.toLowerCase()] || '';
          if (!dept && s.workerUserId) dept = deptByV1Id[String(s.workerUserId)] || '';

          // Compute XpH per segment (for performance table)
          const durHrs = s.durationMinutes > 0 ? s.durationMinutes / 60 : 0;
          const numerator = s.reportItemCount || 1;
          const xph = durHrs > 0 ? Math.round(numerator / durHrs * 100) / 100 : null;

          return { ...s, departmentName: dept, xph };
        });
        all = all.concat(segs);
        more = d.hasMore;
        p++;
      }
      setKpiSegs(disambiguateWorkers(all));
      setClassifiedSummary(summary);
      loadedRef.current.kpi = true;
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
      kpiSegs, classifiedSummary, qcEvents, queueSnap, queueWait, users,
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
