import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './components/layout/app-layout';
import { DashboardPage } from './pages/dashboard/dashboard-page';
import { TasksPage } from './pages/tasks/tasks-page';
import { WorkflowPage } from './pages/workflow/workflow-page';
import { AgentsPage } from './pages/agents/agents-page';
import { McpPage } from './pages/mcp/mcp-page';
import { ToolsPage } from './pages/tools/tools-page';
import { CommandsPage } from './pages/commands/commands-page';
import { InterceptPage } from './pages/intercept/intercept-page';
import { SettingsPage } from './pages/settings/settings-page';
import { ReportsPage } from './pages/reports/reports-page';
import { AttackSurfacePage } from './pages/attack-surface/attack-surface-page';
import { FindingsPage } from './pages/findings/findings-page';
import { EvidencePage } from './pages/evidence/evidence-page';
import { NotFoundPage } from './pages/not-found-page';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'workflow', element: <WorkflowPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'tools', element: <ToolsPage /> },
      { path: 'mcp', element: <McpPage /> },
      { path: 'commands', element: <CommandsPage /> },
      { path: 'intercept', element: <InterceptPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'attack-surface', element: <AttackSurfacePage /> },
      { path: 'vulnerabilities', element: <FindingsPage /> },
      { path: 'evidence', element: <EvidencePage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
