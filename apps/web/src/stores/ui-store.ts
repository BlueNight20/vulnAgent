import { create } from 'zustand';

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  taskStatusFilter: string;
  taskKeyword: string;
  setTaskStatusFilter: (status: string) => void;
  setTaskKeyword: (keyword: string) => void;

  createTaskOpen: boolean;
  setCreateTaskOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  taskStatusFilter: '',
  taskKeyword: '',
  setTaskStatusFilter: (status) => set({ taskStatusFilter: status }),
  setTaskKeyword: (keyword) => set({ taskKeyword: keyword }),

  createTaskOpen: false,
  setCreateTaskOpen: (open) => set({ createTaskOpen: open }),
}));
