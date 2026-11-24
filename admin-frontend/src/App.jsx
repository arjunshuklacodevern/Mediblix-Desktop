import React from "react";
import { HashRouter } from "react-router-dom";
import AdminAuthState from "./context/AdminAuthStates";
import AppRoutes from "./routes/Route";

function App() {
  return (
    <HashRouter>
      <AdminAuthState>
        <AppRoutes />
      </AdminAuthState>
    </HashRouter>
  );
}

export default App;

