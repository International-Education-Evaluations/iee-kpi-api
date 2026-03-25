import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { isAuth, isAdmin, isManagerPlus } from './hooks/useApi';
import Sidebar from './components/Sidebar';
import LoginPage from './pages/LoginPage';
import KPIOverview from './pages/KPIOverview';
import KPIUsers from './pages/KPIUsers';
import QCOverview from './pages/QCOverview';
import QueueOps from './pages/QueueOps';
import ChatPage from './pages/ChatPage';
import GlossaryPage from './pages/GlossaryPage';
import GuardrailsPage from './pages/GuardrailsPage';
import SettingsPage from './pages/SettingsPage';
import EmailPage from './pages/EmailPage';
import AdminUsers from './pages/AdminUsers';

function AuthGuard() {
  if (!isAuth()) return <Navigate to="/login" replace />;
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-5 overflow-auto min-h-screen"><Outlet /></main>
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
        <Route element={<AuthGuard />}>
          <Route path="/" element={<KPIOverview />} />
          <Route path="/kpi/users" element={<KPIUsers />} />
          <Route path="/qc" element={<QCOverview />} />
          <Route path="/queue" element={<QueueOps />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route element={<ManagerGuard />}>
            <Route path="/glossary" element={<GlossaryPage />} />
            <Route path="/email" element={<EmailPage />} />
          </Route>
          <Route element={<AdminGuard />}>
            <Route path="/ai/config" element={<GuardrailsPage />} />
            <Route path="/admin/users" element={<AdminUsers />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
