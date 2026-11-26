import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useDevice } from '../context/DeviceContext';
import { LayoutDashboard, Package, ShoppingCart, Users, Settings, Boxes, FileSpreadsheet } from 'lucide-react';
import api from '../services/api';

const Navbar = () => {
  const { isMobile } = useDevice();
  const location = useLocation();
  const [backendHealthy, setBackendHealthy] = useState(true);

  useEffect(() => {
    let mounted = true;
    const checkHealth = async () => {
      try {
        await api.get('/health', { timeout: 3000 });
        if (mounted) setBackendHealthy(true);
      } catch {
        if (mounted) setBackendHealthy(false);
      }
    };
    checkHealth();
    const timer = setInterval(checkHealth, 30000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  if (isMobile) return null;

  const navItems = [
    { path: '/stock', label: 'Dashboard', icon: Boxes, isPrimary: true },
    { path: '/audits', label: 'Audits & Reports', icon: FileSpreadsheet },
    { path: '/inventory', label: 'Inventory', icon: Package },
  ];

  const rightNavItems = [
    { path: '/orders', label: 'Orders', icon: ShoppingCart },
    { path: '/customers', label: 'Customers', icon: Users },
    { path: '/settings', label: 'Settings', icon: Settings },
  ];

  const isActive = (path) => location.pathname === path;

  return (
    <nav className="h-[60px] w-full flex items-center justify-between px-4 lg:px-6 border-b border-[var(--border-soft)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-1 lg:gap-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.path);
          
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-sm font-medium ${
                active
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-primary)] hover:text-[var(--accent)]'
              }`}
            >
              <Icon size={16} />
              <span className="hidden md:inline">{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="absolute left-1/2 -translate-x-1/2">
        <Link to="/billing" className="flex items-center gap-2 text-xl font-extrabold text-[var(--text-primary)] hover:opacity-80 transition-opacity">
          <img src="/Mediblix-logo.png" alt="Mediblix Logo" className="w-9 h-9 object-contain" />
          <span>Mediblix</span>
        </Link>
      </div>

      <div className="flex items-center gap-1 lg:gap-2">
        <span
          title={backendHealthy ? 'Local SQLite backend connected' : 'Backend unreachable'}
          className={`hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            backendHealthy
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${backendHealthy ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {backendHealthy ? 'Local SQLite' : 'Offline'}
        </span>
        {rightNavItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.path);
          
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-sm font-medium ${
                active
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-primary)] hover:text-[var(--accent)]'
              }`}
            >
              <Icon size={16} />
              <span className="hidden md:inline">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
};

export default Navbar;
