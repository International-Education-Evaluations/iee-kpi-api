import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ResponsiveGridLayout } from 'react-grid-layout';
import { api } from '../hooks/useApi';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

export default function DashboardGrid({ pageId, defaultLayout, children }) {
  const [layouts, setLayouts] = useState(null);
  const [editing, setEditing] = useState(false);
  const [width, setWidth] = useState(1200);
  const containerRef = useRef(null);
  const saveTimeout = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await api(`/user/layout/${pageId}`);
        setLayouts(d.layout ? d.layout : { lg: defaultLayout });
      } catch { setLayouts({ lg: defaultLayout }); }
    })();
  }, [pageId]);

  const saveLayout = useCallback((newLayouts) => {
    if (!editing) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(async () => {
      try { await api(`/user/layout/${pageId}`, { method: 'PUT', body: JSON.stringify({ layout: newLayouts }) }); }
      catch (e) { console.error('Layout save failed:', e); }
    }, 1000);
  }, [pageId, editing]);

  const onLayoutChange = (currentLayout, allLayouts) => {
    if (!editing) return; // Don't update state when locked
    setLayouts(allLayouts);
    saveLayout(allLayouts);
  };

  const resetLayout = async () => {
    setLayouts({ lg: defaultLayout });
    try { await api(`/user/layout/${pageId}`, { method: 'PUT', body: JSON.stringify({ layout: { lg: defaultLayout } }) }); } catch {}
  };

  if (!layouts) return null;

  return (
    <div ref={containerRef}>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setEditing(!editing)}
          className={`text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all ${editing
            ? 'bg-amber-50 text-amber-700 border border-amber-200'
            : 'text-ink-400 hover:text-ink-700 border border-surface-200 hover:border-surface-300 bg-white'}`}>
          {editing ? '✓ Done Editing' : '⚙ Customize Layout'}
        </button>
        {editing && <button onClick={resetLayout} className="text-[11px] text-ink-400 hover:text-ink-700 px-3 py-1.5 border border-surface-200 rounded-lg bg-white font-medium">Reset Default</button>}
        {editing && <span className="text-[11px] text-ink-400">Drag title bars · Resize corners · Auto-saves</span>}
      </div>
      <ResponsiveGridLayout className="layout" layouts={layouts}
        breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
        cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
        rowHeight={60} width={width}
        isDraggable={editing} isResizable={editing}
        onLayoutChange={onLayoutChange}
        draggableHandle=".widget-handle"
        compactType="vertical" margin={[12, 12]}>
        {children}
      </ResponsiveGridLayout>
    </div>
  );
}

export function Widget({ children, title, className = '' }) {
  return (
    <div className={`card-surface overflow-hidden h-full flex flex-col ${className}`}>
      {title && <div className="widget-handle px-4 py-2.5 text-xs font-semibold text-ink-500 border-b border-surface-200 select-none shrink-0 bg-surface-50">
        {typeof title === 'string' ? title : title}
      </div>}
      <div className="flex-1 p-4 overflow-auto min-h-0">{children}</div>
    </div>
  );
}
