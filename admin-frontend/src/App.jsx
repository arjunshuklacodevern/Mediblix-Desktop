import React from "react";
import { HashRouter } from "react-router-dom";
import AdminAuthState from "./context/AdminAuthStates";
import { ThemeProvider } from "./context/ThemeContext";
import AppRoutes from "./routes/Route";

function App() {
  return (
    <ThemeProvider>
      <HashRouter>
        <AdminAuthState>
          <AppRoutes />
        </AdminAuthState>
      </HashRouter>
    </ThemeProvider>
  );
}

export default App;

