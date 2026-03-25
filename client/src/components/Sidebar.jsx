import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { clearAuth, getUser, isAdmin, isManagerPlus } from '../hooks/useApi';

const NAV = [
  { to:'/', icon:'◈', label:'KPI Overview', section:'KPI' },
  { to:'/kpi/users', icon:'◉', label:'User Drill-Down', section:'KPI' },
  { to:'/qc', icon:'◆', label:'QC Overview', section:'QC' },
  { to:'/queue', icon:'◧', label:'Queue Ops', section:'OPS' },
  { to:'/chat', icon:'✦', label:'AI Assistant', section:'AI' },
  { to:'/glossary', icon:'◇', label:'Glossary', section:'AI', managerOnly:true },
  { to:'/ai/config', icon:'⊘', label:'AI Config', section:'AI', adminOnly:true },
  { to:'/settings', icon:'⚙', label:'Configuration', section:'CONFIG' },
  { to:'/email', icon:'✉', label:'Email Reports', section:'CONFIG', managerOnly:true },
  { to:'/admin/users', icon:'◎', label:'User Management', section:'ADMIN', adminOnly:true },
];

const SEC_COLORS = { KPI:'text-blue-400', QC:'text-emerald-400', OPS:'text-purple-400', AI:'text-amber-400', CONFIG:'text-slate-400', ADMIN:'text-red-400' };

export default function Sidebar() {
  const nav = useNavigate();
  const user = getUser();
  const admin = isAdmin();
  const manager = isManagerPlus();
  let curSec = '';

  return (
    <aside className="w-52 min-h-screen bg-slate-900 border-r border-slate-700/40 flex flex-col shrink-0">
      <div className="px-4 py-4 border-b border-slate-700/40">
        <div className="font-display font-bold text-base text-white tracking-tight">IEE <span className="text-navy-400">Ops</span></div>
        <div className="text-[9px] uppercase tracking-[0.15em] text-slate-500 mt-0.5">Operations Dashboard</div>
      </div>
      <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
        {NAV.filter(n => {
          if (n.adminOnly && !admin) return false;
          if (n.managerOnly && !manager) return false;
          return true;
        }).map(n => {
          const showSec = n.section !== curSec;
          curSec = n.section;
          return (
            <React.Fragment key={n.to}>
              {showSec && <div className={`text-[9px] font-bold uppercase tracking-[0.15em] px-2.5 pt-3.5 pb-1 ${SEC_COLORS[n.section]}`}>{n.section}</div>}
              <NavLink to={n.to} end={n.to==='/'} className={({isActive}) =>
                `flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] font-medium transition-all ${isActive?'bg-navy-600/25 text-white border border-navy-500/25':'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}>
                <span className="text-sm opacity-50">{n.icon}</span>{n.label}
              </NavLink>
            </React.Fragment>
          );
        })}
      </nav>
      <div className="px-3 py-3 border-t border-slate-700/40">
        <div className="text-[10px] text-slate-500">Signed in as</div>
        <div className="text-xs font-medium text-slate-300 truncate">{user?.name||'User'}</div>
        <div className="text-[10px] text-slate-500 truncate">{user?.role}</div>
        <button onClick={() => { clearAuth(); nav('/login'); }} className="text-[10px] text-slate-500 hover:text-red-400 mt-1.5 transition-colors">Sign out</button>
      </div>
    </aside>
  );
}
