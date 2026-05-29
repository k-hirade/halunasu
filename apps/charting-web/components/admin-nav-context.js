"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

const EMPTY_ADMIN_NAV = {
  activeTab: "",
  currentPage: null,
  isAvailable: false,
  sections: [],
  selectTab: null
};

const AdminNavContext = createContext(null);

export function AdminNavProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);
  const [navState, setNavState] = useState(EMPTY_ADMIN_NAV);

  const closeAdminNav = useCallback(() => {
    setIsOpen(false);
  }, []);

  const openAdminNav = useCallback(() => {
    setIsOpen(true);
  }, []);

  const toggleAdminNav = useCallback(() => {
    setIsOpen((current) => !current);
  }, []);

  const clearAdminNav = useCallback(() => {
    setIsOpen(false);
    setNavState(EMPTY_ADMIN_NAV);
  }, []);

  const registerAdminNav = useCallback((nextState) => {
    setNavState({
      activeTab: nextState?.activeTab || "",
      currentPage: nextState?.currentPage || null,
      isAvailable: Boolean(nextState?.isAvailable),
      sections: Array.isArray(nextState?.sections) ? nextState.sections : [],
      selectTab: typeof nextState?.selectTab === "function" ? nextState.selectTab : null
    });
  }, []);

  const selectAdminNavTab = useCallback((tabId) => {
    if (navState.selectTab) {
      navState.selectTab(tabId);
    }

    setIsOpen(false);
  }, [navState]);

  const value = useMemo(() => ({
    ...navState,
    clearAdminNav,
    closeAdminNav,
    isOpen,
    openAdminNav,
    registerAdminNav,
    selectAdminNavTab,
    toggleAdminNav
  }), [
    clearAdminNav,
    closeAdminNav,
    isOpen,
    navState,
    openAdminNav,
    registerAdminNav,
    selectAdminNavTab,
    toggleAdminNav
  ]);

  return (
    <AdminNavContext.Provider value={value}>
      {children}
    </AdminNavContext.Provider>
  );
}

export function useAdminNav() {
  const context = useContext(AdminNavContext);

  if (!context) {
    throw new Error("useAdminNav must be used within AdminNavProvider");
  }

  return context;
}
