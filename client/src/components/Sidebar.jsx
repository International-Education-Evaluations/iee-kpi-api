import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { getUser, clearAuth, isAdmin, isManagerPlus } from '../hooks/useApi';

const NAV = [
  { to:'/', icon:'◈', label:'KPI Overview', section:'KPI' },
  { to:'/kpi/users', icon:'◉', label:'User Drill-Down', section:'KPI' },
  { to:'/qc', icon:'◆', label:'QC Overview', section:'QC' },
  { to:'/queue', icon:'▣', label:'Queue Ops', section:'OPS' },
  { to:'/reports', icon:'▦', label:'Report Builder', section:'REPORTS' },
  { to:'/chat', icon:'✦', label:'AI Assistant', section:'AI' },
  { to:'/glossary', icon:'◇', label:'Glossary', section:'AI', managerOnly:true },
  { to:'/ai/config', icon:'◎', label:'AI Config', section:'AI', adminOnly:true },
  { to:'/settings', icon:'⚙', label:'Configuration', section:'CONFIG', managerOnly:false },
  { to:'/email', icon:'✉', label:'Email Reports', section:'CONFIG', managerOnly:true },
  { to:'/admin/users', icon:'◎', label:'User Management', section:'ADMIN', adminOnly:true },
  { to:'/admin/backfill', icon:'↻', label:'Data Backfill', section:'ADMIN', adminOnly:true },
];

export default function Sidebar() {
  const user = getUser();
  const nav = useNavigate();
  const sections = [...new Set(NAV.map(n => n.section))];

  return (
    <aside className="w-56 bg-white border-r border-surface-200 flex flex-col h-screen fixed left-0 top-0 z-30">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-surface-200">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
            <span className="text-white font-display font-bold text-sm">IEE</span>
          </div>
          <div>
            <div className="font-display font-bold text-ink-900 text-sm leading-tight">IEE Ops</div>
            <div className="text-[10px] text-ink-400 font-medium tracking-wide uppercase">Operations Dashboard</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
        {sections.map(sec => {
          const items = NAV.filter(n => n.section === sec && !(n.adminOnly && !isAdmin()) && !(n.managerOnly && !isManagerPlus()));
          if (!items.length) return null;
          return (
            <div key={sec}>
              <div className="text-[9px] font-bold uppercase tracking-[0.1em] text-ink-400 px-2 pt-4 pb-1.5">{sec}</div>
              {items.map(n => (
                <NavLink key={n.to} to={n.to} end={n.to==='/'}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                      isActive
                        ? 'bg-brand-50 text-brand-600 border border-brand-200'
                        : 'text-ink-600 hover:bg-surface-50 hover:text-ink-900 border border-transparent'
                    }`
                  }>
                  <span className="w-5 text-center text-xs opacity-70">{n.icon}</span>
                  <span>{n.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="px-4 py-4 border-t border-surface-200 bg-surface-50">
        <div className="text-[10px] text-ink-400 font-medium uppercase tracking-wider">Signed in as</div>
        <div className="text-sm font-semibold text-ink-900 mt-0.5 truncate">{user?.name || 'User'}</div>
        <div className="text-[10px] text-ink-400 mt-0.5">{user?.role}</div>
        <button onClick={() => { clearAuth(); nav('/login'); }}
          className="mt-2 text-[11px] text-ink-400 hover:text-danger font-medium transition-colors">
          Sign out
        </button>
      </div>
    </aside>
  );
}
