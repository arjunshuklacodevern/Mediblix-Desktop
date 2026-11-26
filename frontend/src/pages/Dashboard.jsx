import { useState, useEffect } from 'react';
import { Package, TrendingUp, AlertTriangle, Truck, IndianRupee, ArrowUp, ArrowDown, Users, ShoppingCart, Sparkles, CalendarClock, ArrowRight } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useNavigate } from 'react-router-dom';
import productService from '../services/productService';

const Dashboard = () => {
  const navigate = useNavigate();
  const [liveAlerts, setLiveAlerts] = useState({
    loading: true,
    totalProducts: 0,
    lowStock: [],
    outOfStock: [],
    expiringSoon: [],
    expired: [],
  });

  useEffect(() => {
    let active = true;
    const loadAlerts = async () => {
      try {
        const products = await productService.getProducts();
        if (!active || !Array.isArray(products)) return;
        const now = new Date();
        const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const outOfStock = products.filter((p) => (Number(p.quantity) || 0) === 0);
        const lowStock = products.filter((p) => {
          const qty = Number(p.quantity) || 0;
          const min = Number(p.minStock) || 10;
          return qty > 0 && qty < min;
        });
        const expired = products.filter((p) => p.expiryDate && new Date(p.expiryDate) < now);
        const expiringSoon = products.filter((p) => {
          if (!p.expiryDate) return false;
          const exp = new Date(p.expiryDate);
          return exp >= now && exp <= in30Days;
        });

        setLiveAlerts({
          loading: false,
          totalProducts: products.length,
          lowStock,
          outOfStock,
          expiringSoon,
          expired,
        });
      } catch (err) {
        console.error('Failed to load live inventory alerts:', err);
        if (active) setLiveAlerts((prev) => ({ ...prev, loading: false }));
      }
    };
    loadAlerts();
    return () => { active = false; };
  }, []);

  const revenueData = [
    { name: 'Jan', revenue: 4000, orders: 240 },
    { name: 'Feb', revenue: 3000, orders: 198 },
    { name: 'Mar', revenue: 5000, orders: 320 },
    { name: 'Apr', revenue: 4500, orders: 280 },
    { name: 'May', revenue: 6000, orders: 410 },
    { name: 'Jun', revenue: 5500, orders: 380 },
    { name: 'Jul', revenue: 7000, orders: 450 },
  ];

  const categoryData = [
    { name: 'Analgesics', value: 35, color: '#166534' },
    { name: 'Antibiotics', value: 25, color: '#22c55e' },
    { name: 'Diabetes', value: 20, color: '#86efac' },
    { name: 'Vitamins', value: 12, color: '#bbf7d0' },
    { name: 'Antacids', value: 8, color: '#dcfce7' },
  ];

  const weeklyOrders = [
    { day: 'Mon', orders: 45 },
    { day: 'Tue', orders: 52 },
    { day: 'Wed', orders: 38 },
    { day: 'Thu', orders: 67 },
    { day: 'Fri', orders: 73 },
    { day: 'Sat', orders: 89 },
    { day: 'Sun', orders: 41 },
  ];

  const stats = [
    {
      title: 'Total Products',
      value: '2,543',
      change: 12,
      isPositive: true,
      icon: Package,
      bgColor: 'bg-emerald-50',
      iconBg: 'bg-emerald-500',
    },
    {
      title: 'Low Stock Items',
      value: '23',
      change: null,
      warning: 'Needs attention',
      icon: AlertTriangle,
      bgColor: 'bg-amber-50',
      iconBg: 'bg-amber-500',
    },
    {
      title: 'Pending Orders',
      value: '156',
      change: 8,
      isPositive: true,
      icon: Truck,
      bgColor: 'bg-blue-50',
      iconBg: 'bg-blue-500',
    },
    {
      title: 'Stock Value',
      value: '₹1.2M',
      change: 5.2,
      isPositive: true,
      icon: IndianRupee,
      bgColor: 'bg-purple-50',
      iconBg: 'bg-purple-500',
    },
  ];

  const topProducts = [
    { id: '1', name: 'Calpol 650', sold: 234, revenue: '₹7,488' },
    { id: '3', name: 'Glycomet 500', sold: 156, revenue: '₹13,260' },
    { id: '4', name: 'Limcee 500', sold: 412, revenue: '₹17,304' },
    { id: '5', name: 'Mox 500', sold: 189, revenue: '₹21,735' },
  ];

  return (
    <div className="min-h-full w-full bg-[var(--bg-main)] p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)]">Dashboard</h1>
            <p className="text-[var(--text-secondary)] mt-1">Overview of your inventory analytics</p>
          </div>
          {!liveAlerts.loading && (
            <span className="text-xs font-medium px-3 py-1.5 rounded-full bg-[var(--bg-card)] border border-[var(--border-soft)] text-[var(--text-secondary)]">
              Live Inventory: <strong className="text-[var(--text-primary)]">{liveAlerts.totalProducts}</strong> products tracked
            </span>
          )}
        </div>

        {/* Live Attention Required Alerts */}
        {!liveAlerts.loading && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              onClick={() => navigate('/inventory')}
              className="text-left bg-[var(--bg-card)] rounded-2xl p-5 border border-amber-200 hover:shadow-md transition-all cursor-pointer flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center">
                  <AlertTriangle size={22} className="text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">Low / Out of Stock</p>
                  <p className="text-2xl font-bold text-[var(--text-primary)]">
                    {liveAlerts.lowStock.length + liveAlerts.outOfStock.length}
                  </p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    {liveAlerts.outOfStock.length} out of stock • {liveAlerts.lowStock.length} low
                  </p>
                </div>
              </div>
              <ArrowRight size={18} className="text-amber-600" />
            </button>

            <button
              onClick={() => navigate('/inventory')}
              className="text-left bg-[var(--bg-card)] rounded-2xl p-5 border border-red-200 hover:shadow-md transition-all cursor-pointer flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-red-50 flex items-center justify-center">
                  <CalendarClock size={22} className="text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">Expired / Expiring (30d)</p>
                  <p className="text-2xl font-bold text-[var(--text-primary)]">
                    {liveAlerts.expired.length + liveAlerts.expiringSoon.length}
                  </p>
                  <p className="text-xs text-red-700 mt-0.5">
                    {liveAlerts.expired.length} expired • {liveAlerts.expiringSoon.length} expiring soon
                  </p>
                </div>
              </div>
              <ArrowRight size={18} className="text-red-600" />
            </button>

            <button
              onClick={() => navigate('/billing')}
              className="text-left bg-[var(--bg-card)] rounded-2xl p-5 border border-[var(--border-soft)] hover:shadow-md transition-all cursor-pointer flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <ShoppingCart size={22} className="text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">Quick Action</p>
                  <p className="text-lg font-bold text-[var(--text-primary)]">Open POS Billing</p>
                  <p className="text-xs text-emerald-700 mt-0.5">Start a new customer checkout</p>
                </div>
              </div>
              <ArrowRight size={18} className="text-emerald-600" />
            </button>
          </div>
        )}

        {/* Stats Cards - Unique Style */}
        {/* <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {stats.map((stat, index) => {
            const Icon = stat.icon;
            return (
              <div key={index} className="bg-[var(--bg-card)] rounded-2xl p-6 border border-[var(--border-soft)] shadow-sm hover:shadow-md transition-all">
                <div className="flex items-start justify-between mb-4">
                  <div className={`p-3 rounded-xl ${stat.bgColor}`}>
                    <Icon size={24} className={stat.iconBg.replace('bg-', 'text-')} />
                  </div>
                  {stat.change && (
                    <div className={`flex items-center gap-1 text-sm font-medium ${stat.isPositive ? 'text-green-600' : 'text-red-600'}`}>
                      {stat.isPositive ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
                      <span>{Math.abs(stat.change)}%</span>
                    </div>
                  )}
                  {stat.warning && (
                    <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded-lg text-xs font-medium">
                      {stat.warning}
                    </span>
                  )}
                </div>
                <h3 className="text-sm text-[var(--text-secondary)] font-medium mb-1">{stat.title}</h3>
                <p className="text-2xl font-bold text-[var(--text-primary)]">{stat.value}</p>
              </div>
            );
          })}
        </div> */}


        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Revenue Chart */}
          <div className="lg:col-span-2 bg-[var(--bg-card)] rounded-2xl p-6 border border-[var(--border-soft)]">
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-[var(--text-primary)]">Revenue Overview</h2>
                  <div className="flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-600 rounded-full text-xs font-medium border border-purple-100">
                    <Sparkles size={12} />
                    AI Forecast
                  </div>
                </div>
                <p className="text-sm text-[var(--text-secondary)]">Monthly revenue and orders</p>
              </div>
              <div className="flex gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-[var(--accent)]" />
                  <span className="text-[var(--text-secondary)]">Revenue</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-300" />
                  <span className="text-[var(--text-secondary)]">Orders</span>
                </div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={revenueData}>
                <defs>
                  <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#166534" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#166534" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#fff', 
                    border: '1px solid #e5e7eb', 
                    borderRadius: '12px',
                    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)'
                  }} 
                />
                <Area type="monotone" dataKey="revenue" stroke="#166534" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                <Line type="monotone" dataKey="orders" stroke="#86efac" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Category Pie Chart */}
          <div className="bg-[var(--bg-card)] rounded-2xl p-6 border border-[var(--border-soft)]">
            <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Sales by Category</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-4">Product distribution</p>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={categoryData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {categoryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#fff', 
                    border: '1px solid #e5e7eb', 
                    borderRadius: '8px' 
                  }} 
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-2 mt-4">
              {categoryData.map((item, index) => (
                <div key={index} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-[var(--text-secondary)]">{item.name}</span>
                  </div>
                  <span className="font-semibold text-[var(--text-primary)]">{item.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Weekly Orders Bar Chart */}
          <div className="bg-[var(--bg-card)] rounded-2xl p-6 border border-[var(--border-soft)]">
            <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Weekly Orders</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-6">Orders received this week</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={weeklyOrders}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis dataKey="day" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#fff', 
                    border: '1px solid #e5e7eb', 
                    borderRadius: '8px' 
                  }} 
                />
                <Bar dataKey="orders" fill="#166534" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Top Products Table */}
          <div className="bg-[var(--bg-card)] rounded-2xl p-6 border border-[var(--border-soft)]">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-[var(--text-primary)]">Top Products</h2>
                <p className="text-sm text-[var(--text-secondary)]">Best selling items</p>
              </div>
              <button className="text-sm text-[var(--accent)] font-medium hover:underline cursor-pointer">View All</button>
            </div>
            <div className="space-y-4">
              {topProducts.map((product, index) => (
                <div 
                  key={index} 
                  onClick={() => navigate(`/product/${product.id}`)}
                  className="flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-[var(--accent-light)] flex items-center justify-center font-bold text-[var(--accent)]">
                      {index + 1}
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors">{product.name}</p>
                      <p className="text-sm text-[var(--text-secondary)]">{product.sold} units sold</p>
                    </div>
                  </div>
                  <span className="font-semibold text-[var(--accent)]">{product.revenue}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
