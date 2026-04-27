import React, { useState, useCallback } from 'react';
import Tour, { useTourAutoStart } from './components/Tour';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { isAuth, isAdmin, isManagerPlus } from './hooks/useApi';
import { DataProvider } from './hooks/useData';
import Sidebar from './components/Sidebar';
import RefreshBar from './components/RefreshBar';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import InvitePage from './pages/InvitePage';
import KPIOverview from './pages/KPIOverview';
import KPIUsers from './pages/KPIUsers';
import KPIScorecard from './pages/KPIScorecard';
import OrderTracker from './pages/OrderTracker';
import DeptComparison from './pages/DeptComparison';
import ShiftHeatmap from './pages/ShiftHeatmap';
import StaffingForecast from './pages/StaffingForecast';
import QCOverview from './pages/QCOverview';
import QueueOps from './pages/QueueOps';
import ChatPage from './pages/ChatPage';
import GlossaryPage from './pages/GlossaryPage';
import GuardrailsPage from './pages/GuardrailsPage';
import SettingsPage from './pages/SettingsPage';
import EmailPage from './pages/EmailPage';
import ReportBuilder from './pages/ReportBuilder';
import AdminUsers from './pages/AdminUsers';
import BackfillPage from './pages/BackfillPage';
import AdminDiagPage from './pages/AdminDiagPage';

function AuthGuard() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tourOpen, setTourOpen] = useTourAutoStart();
  const startTour = useCallback(() => setTourOpen(true), [setTourOpen]);
  if (!isAuth()) return <Navigate to="/login" replace />;
  return (
    <DataProvider>
      <ErrorBoundary scope="auth-shell">
        <div className="flex min-h-screen bg-surface-100">
          {/* Desktop sidebar */}
          <div className="sidebar-desktop">
            <Sidebar />
          </div>
          {/* Mobile sidebar overlay */}
          {sidebarOpen && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div className="absolute inset-0 bg-black/30" onClick={() => setSidebarOpen(false)} />
              <div className="relative w-56 h-full">
                <Sidebar onNavigate={() => setSidebarOpen(false)} />
              </div>
            </div>
          )}
          <div className="main-content ml-0 lg:ml-56 flex-1 flex flex-col min-h-screen">
            {/* Top bar */}
            <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-sm border-b border-surface-200 px-3 sm:px-6 py-2 flex items-center justify-between gap-3">
              {/* Mobile hamburger */}
              <button onClick={() => setSidebarOpen(true)}
                className="sidebar-mobile-toggle p-1.5 rounded-lg hover:bg-surface-100 text-ink-500">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/>
                </svg>
              </button>
              <div className="flex-1" />
              <RefreshBar />
            </header>
            <main className="flex-1 p-3 sm:p-6 overflow-auto">
              {/* Inner boundary scoped to the page so a crash there leaves the
                  sidebar and topbar usable for navigation/recovery. */}
              <ErrorBoundary scope="page"><Outlet /></ErrorBoundary>
            </main>
          </div>
        </div>
        {tourOpen && <Tour onClose={() => setTourOpen(false)} />}
      </ErrorBoundary>
    </DataProvider>
  );
}
function AdminGuard() { if (!isAdmin()) return <Navigate to="/" replace />; return <Outlet />; }
function ManagerGuard() { if (!isManagerPlus()) return <Navigate to="/" replace />; return <Outlet />; }

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route element={<AuthGuard />}>
          <Route path="/" element={<KPIOverview />} />
          <Route path="/kpi/users" element={<KPIUsers />} />
          <Route path="/kpi/scorecard" element={<KPIScorecard />} />
          <Route path="/kpi/departments" element={<DeptComparison />} />
          <Route path="/kpi/heatmap" element={<ShiftHeatmap />} />
          <Route path="/orders" element={<OrderTracker />} />
          <Route path="/kpi/forecast" element={<StaffingForecast />} />
          <Route path="/qc" element={<QCOverview />} />
          <Route path="/queue" element={<QueueOps />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/reports" element={<ReportBuilder />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route element={<ManagerGuard />}>
            <Route path="/glossary" element={<GlossaryPage />} />
            <Route path="/email" element={<EmailPage />} />
          </Route>
          <Route element={<AdminGuard />}>
            <Route path="/ai/config" element={<GuardrailsPage />} />
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/backfill" element={<BackfillPage />} />
            <Route path="/admin/diagnostics" element={<AdminDiagPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
