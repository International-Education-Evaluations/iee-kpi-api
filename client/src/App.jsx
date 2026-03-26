import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { isAuth, isAdmin, isManagerPlus } from './hooks/useApi';
import Sidebar from './components/Sidebar';
import LoginPage from './pages/LoginPage';
import InvitePage from './pages/InvitePage';
import KPIOverview from './pages/KPIOverview';
import KPIUsers from './pages/KPIUsers';
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

function AuthGuard() {
  if (!isAuth()) return <Navigate to="/login" replace />;
  return (
    <div className="flex min-h-screen bg-surface-100">
      <Sidebar />
      <main className="ml-56 flex-1 p-6 overflow-auto min-h-screen"><Outlet /></main>
    </div>
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
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
