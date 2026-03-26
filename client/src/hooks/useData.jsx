import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { api } from './useApi';
import { disambiguateWorkers } from '../components/UI';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [kpiSegs, setKpiSegs]             = useState([]);
  const [benchmarks, setBenchmarks]       = useState([]);
  const [classifiedSummary, setClassifiedSummary] = useState(null);
  const [qcEvents, setQcEvents]           = useState([]);
  const [queueSnap, setQueueSnap]         = useState(null);
  const [queueWait, setQueueWait]         = useState(null);
  const [users, setUsers]                 = useState([]);
  const [kpiLoading, setKpiLoading]       = useState(false);
  const [qcLoading, setQcLoading]         = useState(false);
  const [queueLoading, setQueueLoading]   = useState(false);
  const loadedRef = useRef({ kpi: false, qc: false, queue: false });

  const loadKpi = useCallback(async (force = false) => {
    if (loadedRef.current.kpi && !force) return;
    setKpiLoading(true);
    try {
      // ── Fix 3: fetch users + user-levels in parallel, don't block segments ──
      const [usersData, lvlData, benchData] = await Promise.all([
        api('/data/users').catch(() => ({ users: [] })),
        api('/config/user-levels').catch(() => ({ levels: [] })),
        api('/config/benchmarks').catch(() => ({ benchmarks: [] })),
      ]);

      const userList = usersData.users || [];
      setUsers(userList);

      // Build xphUnit map from benchmarks: statusSlug → xphUnit (Orders|Credentials|Reports)
      const benchList = benchData.benchmarks || [];
      setBenchmarks(benchList);

      const xphUnitBySlug = {};
      for (const b of benchList) {
        if (b.status) xphUnitBySlug[b.status] = b.xphUnit || 'Orders';
      }

      // Build lookup maps.
      // IMPORTANT: segments carry workerUserId as a v2Id ObjectId string
      // (e.g. "687a5894ef7495fca0666516"), NOT a v1Id integer.
      // backfill_users has both v2Id and v1Id — must key on v2Id to match segments.
      // Email is a reliable fallback since it's consistent across both systems.
      const userByV2Id  = {}; // v2Id string → { dept, name }
      const userByEmail = {}; // email lower  → { dept, name }
      for (const u of userList) {
        const entry = { dept: u.departmentName || '', name: u.fullName || '' };
        if (u.v2Id)  userByV2Id[String(u.v2Id)]         = entry;
        if (u.email) userByEmail[u.email.toLowerCase()]  = entry;
      }

      // Level lookup: dashboard_user_levels stores v1Id + email.
      // workerUserId is v2Id so v1Id path never hits — email is the only working key.
      // Keep levelByV1Id for forward-compat once user-levels is migrated to v2Id.
      const levelByV1Id  = {};
      const levelByEmail = {};
      for (const l of (lvlData.levels || [])) {
        if (l.v1Id)  levelByV1Id[String(l.v1Id)]         = l.level;
        if (l.email) levelByEmail[l.email.toLowerCase()]  = l.level;
      }

      // ── Fix 1 + 4: parallel pagination — fetch p1 to learn totalPages,
      //   then fire all remaining pages simultaneously. ──────────────────────
      // At 10k pageSize and ~70k segments that's 1 + parallel(6) instead of
      // 14 sequential requests. Network time: ~400ms vs ~4-6s.
      // cb= cache-bust: forces unique URLs so browser/proxy never deduplicates
      // parallel requests or returns a cached 304 for a different page
      const cb = Date.now();
      const first = await api(`/data/kpi-segments?page=1&pageSize=10000&drilldown=1&cb=${cb}`);
      const totalPages = first.totalPages || 1;

      let rest = [];
      if (totalPages > 1) {
        rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) =>
            api(`/data/kpi-segments?page=${i + 2}&pageSize=10000&drilldown=1&cb=${cb}`)
          )
        );
      }

      const all = [first, ...rest].flatMap(d => d.segments || []);

      // ── Enrich segments with department + level ──────────────────────────
      const enriched = all.map(s => {
        const email = (s.workerEmail || '').toLowerCase();
        const v2Id  = s.workerUserId ? String(s.workerUserId) : ''; // workerUserId IS a v2Id

        let dept  = '';
        let level = '';

        // v2Id lookup preferred — workerUserId in segments is a v2Id ObjectId string.
        // Email fallback for segments where workerUserId is null/missing.
        if (v2Id && userByV2Id[v2Id])        dept  = userByV2Id[v2Id].dept;
        else if (email && userByEmail[email]) dept  = userByEmail[email].dept;

        // Level: dashboard_user_levels keyed on email (v1Id path dead until migration).
        if (email && levelByEmail[email])     level = levelByEmail[email];

        // Compute unitValue based on xphUnit for this status:
        // Orders = 1 per segment, Credentials = credentialCount, Reports = reportItemCount
        const xphUnit = xphUnitBySlug[s.statusSlug] || 'Orders';
        const unitValue = xphUnit === 'Credentials'
          ? (s.credentialCount || 0)
          : xphUnit === 'Reports'
            ? (s.reportItemCount || 0)
            : 1;

        return { ...s, departmentName: dept, userLevel: level, xphUnit, unitValue };
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
      // Paginate like KPI segments: fetch p1, then remaining pages in parallel.
      // QC is small now (1,100 events) but this future-proofs growth to 50k+.
      const first = await api('/data/qc-events?page=1&pageSize=5000');
      const totalPages = first.totalPages || 1;
      let rest = [];
      if (totalPages > 1) {
        rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) =>
            api(`/data/qc-events?page=${i + 2}&pageSize=5000`)
          )
        );
      }
      setQcEvents([first, ...rest].flatMap(d => d.events || []));
      loadedRef.current.qc = true;
    } catch (e) { console.error('QC load failed:', e); }
    setQcLoading(false);
  }, []);

  const loadQueue = useCallback(async (force = false) => {
    if (loadedRef.current.queue && !force) return;
    setQueueLoading(true);
    try {
      // ── Fix 2: /data/queue-wait-summary reads from backfill config DB (~1ms)
      //   instead of running a live 450-day production aggregation (10–22s). ──
      const [s, w] = await Promise.all([
        api('/data/queue-snapshot'),
        api('/data/queue-wait-summary'),
      ]);
      setQueueSnap(s);
      setQueueWait(w);
      loadedRef.current.queue = true;
    } catch (e) { console.error('Queue load failed:', e); }
    setQueueLoading(false);
  }, []);

  const forceRefreshQueue = useCallback(async () => {
    // Force-refresh: hit live endpoints to bypass cache
    setQueueLoading(true);
    try {
      const [s, w] = await Promise.all([
        api('/queue-snapshot'),
        api('/queue-wait-summary?days=90'),
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
      kpiSegs, classifiedSummary, qcEvents, queueSnap, queueWait, users, benchmarks,
      kpiLoading, qcLoading, queueLoading,
      loadKpi, loadQc, loadQueue, forceRefreshQueue, refreshAll,
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