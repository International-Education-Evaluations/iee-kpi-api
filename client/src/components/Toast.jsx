import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ── Toast system ────────────────────────────────────────────────────────────
// Lightweight notifications stacked top-right. Three kinds:
//   - 'error'   red    — fetch failure, API error, validation failure
//   - 'warn'    amber  — partial load, soft failure, "X is missing"
//   - 'info'    blue   — neutral notice, success of a manual action
//
// Usage:
//   const { show } = useToast();
//   show({ kind:'error', title:'Couldn\'t load benchmarks', message:err.message });
//
// Toasts auto-dismiss after 6s (errors) or 4s (others). Click X to dismiss
// early. Identical title+message within 5s is deduped so a flapping endpoint
// doesn't spam the UI.

const ToastContext = createContext({ show: () => {}, dismiss: () => {}, dismissAll: () => {} });

export function useToast() { return useContext(ToastContext); }

let nextId = 1;
const DEDUPE_WINDOW_MS = 5000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const recentRef = useRef(new Map()); // key -> ts (for dedupe)

  const dismiss = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  const dismissAll = useCallback(() => setToasts([]), []);

  const show = useCallback(({ kind = 'info', title = '', message = '', action = null, durationMs }) => {
    const key = `${kind}|${title}|${message}`;
    const now = Date.now();
    const last = recentRef.current.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) return;
    recentRef.current.set(key, now);

    const id = nextId++;
    const toast = { id, kind, title, message, action };
    setToasts(t => [...t, toast]);

    const dur = durationMs ?? (kind === 'error' ? 6000 : 4000);
    if (dur > 0) setTimeout(() => dismiss(id), dur);
    return id;
  }, [dismiss]);

  // Expose globally so non-React code (like the api() helper) can show toasts
  // without prop-drilling. Cleared on unmount.
  useEffect(() => {
    window.__ieeToast = { show, dismiss, dismissAll };
    return () => { delete window.__ieeToast; };
  }, [show, dismiss, dismissAll]);

  return (
    <ToastContext.Provider value={{ show, dismiss, dismissAll }}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const STYLES = {
  error: { bar: 'bg-red-500',     bg: 'bg-red-50',     border: 'border-red-200',     icon: '⚠', text: 'text-red-800' },
  warn:  { bar: 'bg-amber-500',   bg: 'bg-amber-50',   border: 'border-amber-200',   icon: '!', text: 'text-amber-800' },
  info:  { bar: 'bg-brand-500',   bg: 'bg-brand-50',   border: 'border-brand-200',   icon: 'i', text: 'text-brand-800' },
};

function ToastViewport({ toasts, dismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed top-3 right-3 z-[100] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-1.5rem)] pointer-events-none">
      {toasts.map(t => {
        const s = STYLES[t.kind] || STYLES.info;
        return (
          <div key={t.id} role="alert"
            className={`pointer-events-auto card-surface ${s.bg} ${s.border} shadow-lg overflow-hidden flex items-start gap-2 p-3`}>
            <span className={`shrink-0 mt-0.5 w-5 h-5 rounded-full ${s.bar} text-white flex items-center justify-center text-[10px] font-bold`}>{s.icon}</span>
            <div className="flex-1 min-w-0">
              {t.title && <div className={`text-xs font-semibold ${s.text} leading-tight`}>{t.title}</div>}
              {t.message && <div className="text-[11px] text-ink-700 mt-0.5 break-words leading-snug">{t.message}</div>}
              {t.action && (
                <button onClick={() => { t.action.onClick(); dismiss(t.id); }}
                  className={`mt-1.5 text-[11px] font-semibold ${s.text} hover:underline`}>
                  {t.action.label}
                </button>
              )}
            </div>
            <button onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-ink-400 hover:text-ink-700 w-4 h-4 leading-none">×</button>
          </div>
        );
      })}
    </div>
  );
}

// Convenience helper for non-React callers.
export function showToast(opts) {
  if (typeof window !== 'undefined' && window.__ieeToast) window.__ieeToast.show(opts);
}
