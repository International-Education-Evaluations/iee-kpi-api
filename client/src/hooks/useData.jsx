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

  const loadKpi = useCallback(async (force = false) => {
    if (loadedRef.current.kpi && !force) return;
    setKpiLoading(true);
    try {
      // 1. Load users for department/level resolution
      const usersData = await api('/data/users').catch(() => ({ users: [] }));
      const userList = usersData.users || [];
      setUsers(userList);

      // Build lookup maps: email→{dept,level}, v1Id→{dept}
      const userByEmail = {};
      const userByV1Id = {};
      for (const u of userList) {
        if (u.email) {
          userByEmail[u.email.toLowerCase()] = {
            dept: u.departmentName || '',
            name: u.fullName || '',
          };
        }
        if (u.v1Id) {
          userByV1Id[String(u.v1Id)] = {
            dept: u.departmentName || '',
            name: u.fullName || '',
          };
        }
      }

      // 2. Load user levels from config (for level assignment)
      let levelByEmail = {};
      let levelByV1Id = {};
      try {
        const lvlData = await api('/config/user-levels');
        for (const l of (lvlData.levels || [])) {
          if (l.email) levelByEmail[l.email.toLowerCase()] = l.level;
          if (l.v1Id) levelByV1Id[String(l.v1Id)] = l.level;
        }
      } catch {}

      // 3. Load raw segments from backfill (fast — direct MongoDB read)
      let all = [], p = 1, more = true;
      while (more) {
        const d = await api(`/data/kpi-segments?page=${p}&pageSize=5000`);
        all = all.concat(d.segments || []);
        more = d.hasMore;
        p++;
      }

      // 4. Enrich segments with department + level from user maps
      const enriched = all.map(s => {
        const email = (s.workerEmail || '').toLowerCase();
        const v1Id = s.workerUserId ? String(s.workerUserId) : '';

        // Department resolution
        let dept = '';
        if (email && userByEmail[email]) dept = userByEmail[email].dept;
        else if (v1Id && userByV1Id[v1Id]) dept = userByV1Id[v1Id].dept;

        // Level resolution
        let level = '';
        if (email && levelByEmail[email]) level = levelByEmail[email];
        else if (v1Id && levelByV1Id[v1Id]) level = levelByV1Id[v1Id];

        return { ...s, departmentName: dept, userLevel: level };
      });

      setKpiSegs(disambiguateWorkers(enriched));
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
