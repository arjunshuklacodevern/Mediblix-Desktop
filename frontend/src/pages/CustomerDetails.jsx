import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { 
  ArrowLeft, Mail, Phone, Calendar, Star, Package, TrendingUp, Clock, 
  ShoppingBag, CreditCard, Sparkles, Eye, X, Printer, Download, RotateCcw,
  Edit3, Check, AlertCircle, History, Info, ChevronRight
} from 'lucide-react';
import { CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis } from 'recharts';
import customerService from '../services/customerService';
import saleService from '../services/saleService';

const CustomerDetails = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedBill, setSelectedBill] = useState(null);
  const [showBillingModal, setShowBillingModal] = useState(false);
  const [toast, setToast] = useState(null);

  // Return modal state
  const [showReturnModal, setShowReturnModal] = useState(false);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [refundMethod, setRefundMethod] = useState('Cash');
  const [returnReason, setReturnReason] = useState('');
  const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);

  // Modify modal state
  const [showModifyModal, setShowModifyModal] = useState(false);
  const [modifiedItems, setModifiedItems] = useState([]);
  const [modifiedPaymentMethod, setModifiedPaymentMethod] = useState('Cash');
  const [modifyReason, setModifyReason] = useState('');
  const [isSubmittingModify, setIsSubmittingModify] = useState(false);
  const [showModifyConfirm, setShowModifyConfirm] = useState(false);

  // Audit history view toggle inside invoice details modal
  const [activeTab, setActiveTab] = useState('items'); // 'items' | 'returns' | 'revisions'

  const showToastNotification = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchCustomerDetail = async () => {
    try {
      setLoading(true);
      const data = await customerService.getCustomerById(id);
      setCustomer(data);
      if (selectedBill) {
        const refreshed = data.purchaseHistory?.find(s => s._id === selectedBill._id || s.id === selectedBill.id);
        if (refreshed) setSelectedBill(refreshed);
      }
    } catch (error) {
      console.error(error);
      showToastNotification(error.response?.data?.message || error.message || 'Failed to load customer', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomerDetail();
  }, [id]);

  if (loading) {
    return (
      <div className="h-[calc(100vh-70px)] w-full bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="h-[calc(100vh-70px)] w-full bg-gray-50 flex flex-col items-center justify-center p-6 text-[var(--text-secondary)]">
        <Package size={48} className="text-gray-300 mb-2" />
        <p className="font-semibold text-lg">Customer not found</p>
        <button
          onClick={() => navigate(-1)}
          className="mt-4 px-4 py-2 bg-[var(--accent)] text-white rounded-xl text-sm font-semibold hover:opacity-90 transition-all cursor-pointer font-sans"
        >
          Go Back
        </button>
      </div>
    );
  }

  const totalGrossSpent = customer.purchaseHistory?.reduce((sum, sale) => sum + (sale.totalAmount || 0), 0) || 0;

  const totalRefunded = customer.purchaseHistory?.reduce((sum, sale) => {
    if (sale.refundAmount !== undefined && sale.refundAmount > 0) return sum + sale.refundAmount;
    const saleRefund = sale.items?.reduce((iSum, item) => {
      const retQty = item.returnedQuantity || 0;
      const effectivePrice = item.price * (1 - (item.discount || 0) / 100);
      return iSum + (retQty * effectivePrice);
    }, 0) || 0;
    return sum + saleRefund;
  }, 0) || 0;

  const totalNetSpent = Math.max(0, totalGrossSpent - totalRefunded);

  const totalReturnedItems = customer.purchaseHistory?.reduce((sum, sale) => {
    return sum + (sale.items?.reduce((iSum, item) => iSum + (item.returnedQuantity || 0), 0) || 0);
  }, 0) || 0;

  const totalOrders = customer.purchaseHistory?.length || 0;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalNetSpent / totalOrders) : 0;
  const lastOrderDate = totalOrders > 0
    ? new Date(customer.purchaseHistory[0].createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'Never';

  const memberRank = totalNetSpent > 50000 ? 'Gold' : totalNetSpent > 20000 ? 'Silver' : 'Bronze';

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthlyData = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const mLabel = months[d.getMonth()];
    monthlyData[mLabel] = 0;
  }

  customer.purchaseHistory?.forEach(sale => {
    const saleDate = new Date(sale.createdAt);
    const mLabel = months[saleDate.getMonth()];
    const saleRefund = sale.refundAmount !== undefined && sale.refundAmount > 0
      ? sale.refundAmount
      : (sale.items?.reduce((sum, i) => sum + (i.returnedQuantity || 0) * i.price * (1 - (i.discount || 0) / 100), 0) || 0);
    const netSale = Math.max(0, sale.totalAmount - saleRefund);
    if (mLabel in monthlyData) {
      monthlyData[mLabel] += netSale;
    }
  });

  const spendingData = Object.keys(monthlyData).map(m => ({
    month: m,
    amount: monthlyData[m]
  }));

  const handlePrintPastInvoice = async (saleId) => {
    try {
      const blob = await saleService.generateInvoice(saleId);
      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (error) {
      console.error(error);
      showToastNotification('Failed to generate printable invoice', 'error');
    }
  };

  const handleDownloadPastInvoice = async (saleId, invoiceNumber) => {
    try {
      const blob = await saleService.generateInvoice(saleId);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice-${invoiceNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      showToastNotification('Failed to download invoice PDF', 'error');
    }
  };

  // Open Return Modal
  const handleOpenReturnModal = (bill) => {
    const initialQtys = {};
    bill.items?.forEach((item) => {
      const itemId = item._id || item.id;
      initialQtys[itemId] = 0;
    });
    setReturnQuantities(initialQtys);
    setRefundMethod(bill.paymentMethod || 'Cash');
    setReturnReason('');
    setShowReturnModal(true);
  };

  // Open Modify Modal
  const handleOpenModifyModal = (bill) => {
    const items = bill.items?.map((item) => ({
      _id: item._id || item.id,
      productId: item.product?._id || item.product?.id || item.product,
      name: item.product?.name || 'Unknown Product',
      quantity: Number(item.quantity) || 1,
      price: Number(item.price) || 0,
      discount: Number(item.discount) || 0,
      returnedQuantity: Number(item.returnedQuantity) || 0,
    })) || [];
    setModifiedItems(items);
    setModifiedPaymentMethod(bill.paymentMethod || 'Cash');
    setModifyReason('');
    setShowModifyConfirm(false);
    setShowModifyModal(true);
  };

  // Return handlers
  const handleReturnQtyChange = (itemId, val, maxVal) => {
    const parsed = parseInt(val, 10);
    const validQty = isNaN(parsed) ? 0 : Math.max(0, Math.min(parsed, maxVal));
    setReturnQuantities(prev => ({ ...prev, [itemId]: validQty }));
  };

  const handleReturnAllItems = () => {
    if (!selectedBill?.items) return;
    const allQtys = {};
    selectedBill.items.forEach((item) => {
      const itemId = item._id || item.id;
      const maxReturnable = Math.max(0, item.quantity - (item.returnedQuantity || 0));
      allQtys[itemId] = maxReturnable;
    });
    setReturnQuantities(allQtys);
  };

  const handleResetReturnQtys = () => {
    if (!selectedBill?.items) return;
    const zeroQtys = {};
    selectedBill.items.forEach((item) => {
      const itemId = item._id || item.id;
      zeroQtys[itemId] = 0;
    });
    setReturnQuantities(zeroQtys);
  };

  const handleProcessReturnSubmit = async () => {
    if (!selectedBill) return;
    const itemsToReturn = [];
    let totalReturnRefund = 0;

    for (const item of (selectedBill.items || [])) {
      const itemId = item._id || item.id;
      const qty = Number(returnQuantities[itemId]) || 0;
      if (qty > 0) {
        const effectivePrice = item.price * (1 - (item.discount || 0) / 100);
        totalReturnRefund += (qty * effectivePrice);
        itemsToReturn.push({
          itemId,
          productId: item.product?._id || item.product?.id || item.product,
          returnQuantity: qty
        });
      }
    }

    if (itemsToReturn.length === 0) {
      showToastNotification('Please select at least one item quantity to return.', 'error');
      return;
    }

    try {
      setIsSubmittingReturn(true);
      await saleService.processReturn(selectedBill._id, {
        items: itemsToReturn,
        refundMethod,
        reason: returnReason.trim() || 'Customer return'
      });

      showToastNotification(`Return processed successfully! Total Refund: ₹${totalReturnRefund.toFixed(2)}`, 'success');
      setShowReturnModal(false);
      await fetchCustomerDetail();
    } catch (error) {
      console.error(error);
      showToastNotification(error.response?.data?.message || error.message || 'Failed to process return', 'error');
    } finally {
      setIsSubmittingReturn(false);
    }
  };

  // Modify handlers
  const handleModifyItemChange = (index, field, value) => {
    setModifiedItems(prev => {
      const updated = [...prev];
      const item = { ...updated[index] };
      if (field === 'quantity') {
        const parsed = parseInt(value, 10);
        item.quantity = isNaN(parsed) ? item.returnedQuantity : parsed;
      } else if (field === 'price') {
        const parsed = parseFloat(value);
        item.price = isNaN(parsed) ? 0 : Math.max(0, parsed);
      } else if (field === 'discount') {
        const parsed = parseFloat(value);
        item.discount = isNaN(parsed) ? 0 : Math.max(0, Math.min(100, parsed));
      }
      updated[index] = item;
      return updated;
    });
  };

  const handleModifyInvoiceSubmit = async () => {
    if (!selectedBill) return;

    if (!modifyReason.trim()) {
      showToastNotification('Please provide a reason for the invoice modification.', 'error');
      return;
    }

    // Validation
    for (let i = 0; i < modifiedItems.length; i++) {
      const item = modifiedItems[i];
      if (item.quantity < item.returnedQuantity) {
        showToastNotification(`Quantity for ${item.name} cannot be less than returned quantity (${item.returnedQuantity}).`, 'error');
        return;
      }
      if (item.quantity <= 0) {
        showToastNotification(`Quantity for ${item.name} must be greater than 0.`, 'error');
        return;
      }
      if (item.price < 0) {
        showToastNotification(`Price for ${item.name} cannot be negative.`, 'error');
        return;
      }
    }

    try {
      setIsSubmittingModify(true);
      const payload = {
        paymentMethod: modifiedPaymentMethod,
        reason: modifyReason.trim(),
        items: modifiedItems.map(item => ({
          itemId: item._id,
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
          discount: item.discount
        }))
      };

      await saleService.modifyInvoice(selectedBill._id, payload);
      showToastNotification('Invoice modified successfully!', 'success');
      setShowModifyModal(false);
      setShowModifyConfirm(false);
      await fetchCustomerDetail();
    } catch (error) {
      console.error(error);
      showToastNotification(error.response?.data?.message || error.message || 'Failed to modify invoice', 'error');
    } finally {
      setIsSubmittingModify(false);
    }
  };

  return (
    <div className="h-[calc(100vh-70px)] w-full bg-gray-50 overflow-hidden">
      <div className="h-full overflow-y-auto p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-gray-500 hover:text-gray-900 transition-colors cursor-pointer font-sans text-sm font-semibold"
          >
            <ArrowLeft size={18} />
            <span>Back to Customers</span>
          </button>

          <div className="bg-white rounded-2xl p-6 border border-gray-200 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-[var(--accent-light)] to-transparent opacity-20 rounded-bl-full -mr-16 -mt-16" />
            
            <div className="relative flex flex-col md:flex-row items-start md:items-center gap-6">
              <div className="w-20 h-20 rounded-2xl bg-[var(--accent-light)] flex items-center justify-center text-[var(--accent)] font-bold text-3xl shadow-md border-4 border-white">
                {customer.name.charAt(0).toUpperCase()}
              </div>
              
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <h1 className="text-2xl font-bold text-gray-900">{customer.name}</h1>
                  <span className="px-2.5 py-0.5 bg-amber-50 text-amber-700 rounded-full text-xs font-semibold border border-amber-200 flex items-center gap-1">
                    <Star size={12} fill="currentColor" />
                    {memberRank} Member
                  </span>
                </div>
                
                <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                  {customer.email && (
                    <div className="flex items-center gap-1.5">
                      <Mail size={14} />
                      {customer.email}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Phone size={14} />
                    +91 {customer.mobile}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar size={14} />
                    Joined {new Date(customer.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-green-50 rounded-lg text-green-600">
                  <CreditCard size={18} />
                </div>
                <span className="text-xs text-gray-500 font-semibold font-sans">Total Net Spent</span>
              </div>
              <p className="text-xl font-bold text-gray-900">₹{totalNetSpent.toLocaleString()}</p>
              {totalRefunded > 0 && (
                <p className="text-[10px] text-gray-400 mt-1 font-medium">Gross: ₹{totalGrossSpent.toLocaleString()}</p>
              )}
            </div>
            
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
                  <ShoppingBag size={18} />
                </div>
                <span className="text-xs text-gray-500 font-semibold font-sans">Total Orders</span>
              </div>
              <p className="text-xl font-bold text-gray-900">{totalOrders}</p>
            </div>

            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-red-50 rounded-lg text-red-600">
                  <RotateCcw size={18} />
                </div>
                <span className="text-xs text-gray-500 font-semibold font-sans">Returns & Refunds</span>
              </div>
              <p className="text-xl font-bold text-red-600">-₹{totalRefunded.toLocaleString()}</p>
              <p className="text-[10px] text-gray-400 mt-1 font-medium">{totalReturnedItems} items returned</p>
            </div>

            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 bg-purple-50 rounded-lg text-purple-600">
                  <TrendingUp size={18} />
                </div>
                <span className="text-xs text-gray-500 font-semibold font-sans">Average Net Order</span>
              </div>
              <p className="text-xl font-bold text-gray-900">₹{avgOrderValue.toLocaleString()}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-gray-900">Spending Overview (Net)</h3>
                <div className="flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-600 rounded-full text-xs font-semibold border border-purple-100">
                  <Sparkles size={12} />
                  Spending Chart
                </div>
              </div>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={spendingData}>
                    <defs>
                      <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#166534" stopOpacity={0.25}/>
                        <stop offset="95%" stopColor="#166534" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 11}} dy={8} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 11}} tickFormatter={(value) => `₹${value.toLocaleString()}`} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.05)' }}
                      formatter={(value) => [`₹${value.toLocaleString()}`, 'Net Spent']}
                    />
                    <Area type="monotone" dataKey="amount" stroke="#166534" strokeWidth={3} fillOpacity={1} fill="url(#colorAmount)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm flex flex-col min-h-[350px]">
              <div className="flex items-center justify-between mb-6 flex-shrink-0">
                <h3 className="text-lg font-bold text-gray-900">Recent Invoices</h3>
              </div>
              
              <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
                {customer.purchaseHistory && customer.purchaseHistory.length > 0 ? (
                  customer.purchaseHistory.slice(0, 5).map((sale) => {
                    const saleRefund = sale.refundAmount !== undefined && sale.refundAmount > 0
                      ? sale.refundAmount
                      : (sale.items?.reduce((sum, i) => sum + (i.returnedQuantity || 0) * i.price * (1 - (i.discount || 0) / 100), 0) || 0);
                    const netSaleAmount = Math.max(0, sale.totalAmount - saleRefund);
                    const totalReturnedQty = sale.items?.reduce((sum, i) => sum + (i.returnedQuantity || 0), 0) || 0;

                    return (
                      <div 
                        key={sale._id} 
                        className="flex items-center justify-between p-3 bg-gray-50 border border-gray-150 rounded-xl hover:border-[var(--accent)] transition-all"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-gray-900 text-xs">{sale.invoiceNumber}</p>
                            {saleRefund > 0 && (
                              <span className="px-1.5 py-0.5 bg-red-50 text-red-600 rounded text-[10px] font-bold">
                                -{totalReturnedQty} Returned (-₹{saleRefund.toLocaleString()})
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-gray-500 mt-0.5">
                            {new Date(sale.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="font-bold text-green-700 text-xs">₹{netSaleAmount.toLocaleString()}</p>
                            {saleRefund > 0 ? (
                              <p className="text-[9px] text-gray-400 line-through">₹{sale.totalAmount.toLocaleString()}</p>
                            ) : (
                              <span className="text-[9px] px-1.5 py-0.2 bg-gray-200 text-gray-700 rounded-md font-medium">
                                {sale.paymentMethod}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              setSelectedBill(sale);
                              setShowBillingModal(true);
                            }}
                            className="p-1.5 bg-white border border-gray-200 hover:border-[var(--accent)] text-gray-500 hover:text-[var(--accent)] rounded-lg transition-all cursor-pointer"
                          >
                            <Eye size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-gray-400 py-12">
                    <Package size={28} className="text-gray-300 mb-1" />
                    <p className="text-xs font-semibold">No invoices found</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Invoice Details Modal */}
      {showBillingModal && selectedBill && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#121f18] text-gray-900 dark:text-[#f0fdf4] w-full max-w-4xl rounded-2xl border border-gray-200 dark:border-[#1f3328] shadow-strong overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-gray-150 dark:border-[#1f3328] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">Invoice Details</h2>
                <span className="px-2.5 py-0.5 bg-gray-100 dark:bg-[#192b21] text-gray-700 dark:text-gray-300 rounded-md text-xs font-semibold">
                  #{selectedBill.invoiceNumber}
                </span>
              </div>
              <button
                onClick={() => {
                  setShowBillingModal(false);
                  setActiveTab('items');
                }}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-[#192b21] rounded-lg text-gray-500 dark:text-gray-400 transition-all cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Navigation Tabs if there are returns or revisions */}
            {((selectedBill.returns && selectedBill.returns.length > 0) || (selectedBill.revisions && selectedBill.revisions.length > 0)) && (
              <div className="px-6 pt-3 flex items-center gap-2 border-b border-gray-100 dark:border-[#1f3328] bg-gray-50/50 dark:bg-[#0b130f]">
                <button
                  onClick={() => setActiveTab('items')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                    activeTab === 'items'
                      ? 'bg-[var(--accent)] text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#192b21]'
                  }`}
                >
                  Items & Billing
                </button>
                {selectedBill.returns && selectedBill.returns.length > 0 && (
                  <button
                    onClick={() => setActiveTab('returns')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                      activeTab === 'returns'
                        ? 'bg-[var(--accent)] text-white shadow-sm'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#192b21]'
                    }`}
                  >
                    <RotateCcw size={12} />
                    <span>Return History</span>
                    <span className="ml-1 px-1.5 py-0.2 bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 rounded text-[10px] font-bold">
                      {selectedBill.returns.length}
                    </span>
                  </button>
                )}
                {selectedBill.revisions && selectedBill.revisions.length > 0 && (
                  <button
                    onClick={() => setActiveTab('revisions')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
                      activeTab === 'revisions'
                        ? 'bg-[var(--accent)] text-white shadow-sm'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-[#192b21]'
                    }`}
                  >
                    <History size={12} />
                    <span>Revisions</span>
                    <span className="ml-1 px-1.5 py-0.2 bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 rounded text-[10px] font-bold">
                      {selectedBill.revisions.length}
                    </span>
                  </button>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-6 flex flex-col min-h-0">
              {activeTab === 'items' && (
                <>
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <h3 className="font-bold text-xl text-[var(--accent)]">Mediblix</h3>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Invoice Number: {selectedBill.invoiceNumber}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Date: {new Date(selectedBill.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                    <div className="text-right">
                      <span className="px-2.5 py-1 bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-300 rounded-md text-xs font-semibold border border-green-200 dark:border-green-900">
                        Paid
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Payment: {selectedBill.paymentMethod}</p>
                    </div>
                  </div>

                  <div className="border border-gray-200 dark:border-[#1f3328] rounded-xl overflow-hidden mb-6 flex-shrink-0">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-[#0b130f] text-gray-500 dark:text-gray-400 text-xs font-semibold border-b border-gray-200 dark:border-[#1f3328]">
                          <th className="px-4 py-3">Medicine Item</th>
                          <th className="px-4 py-3 text-right">Price</th>
                          <th className="px-4 py-3 text-right">Sold Qty & Value</th>
                          <th className="px-4 py-3 text-right">Returned Qty & Refund</th>
                          <th className="px-4 py-3 text-right">Net Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 dark:divide-[#1f3328] text-sm">
                        {selectedBill.items.map((item, idx) => {
                          const retQty = item.returnedQuantity || 0;
                          const availQty = item.quantity - retQty;
                          const effectivePrice = item.price * (1 - (item.discount || 0) / 100);
                          const soldVal = item.quantity * effectivePrice;
                          const retVal = retQty * effectivePrice;
                          const netVal = availQty * effectivePrice;

                          return (
                            <tr key={idx} className="hover:bg-gray-50/50 dark:hover:bg-[#192b21]/40">
                              <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#f0fdf4]">
                                {item.product?.name || "Deleted Product"}
                              </td>
                              <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400 text-xs">
                                ₹{item.price.toLocaleString()}
                              </td>
                              <td className="px-4 py-3 text-right font-medium">
                                <span className="text-xs text-gray-800 dark:text-gray-200 font-semibold">{item.quantity} Tabs</span>
                                <span className="block text-[10px] text-gray-500 dark:text-gray-400">₹{soldVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              </td>
                              <td className="px-4 py-3 text-right font-medium">
                                {retQty > 0 ? (
                                  <div>
                                    <span className="text-xs text-red-600 dark:text-red-400 font-semibold">{retQty} returned</span>
                                    <span className="block text-[10px] text-red-600 dark:text-red-400 font-bold">-₹{retVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                  </div>
                                ) : (
                                  <span className="text-xs text-gray-400">0</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right font-bold text-green-700 dark:text-green-400">
                                <span className="text-xs">{availQty} Tabs</span>
                                <span className="block text-[10px] font-bold">₹{netVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {(() => {
                    const modalRefund = selectedBill.refundAmount !== undefined && selectedBill.refundAmount > 0
                      ? selectedBill.refundAmount
                      : (selectedBill.items?.reduce((sum, i) => sum + (i.returnedQuantity || 0) * i.price * (1 - (i.discount || 0) / 100), 0) || 0);
                    const modalNet = Math.max(0, selectedBill.totalAmount - modalRefund);

                    return (
                      <div className="w-full max-w-xs ml-auto space-y-2 border-t border-gray-200 dark:border-[#1f3328] pt-4 mb-6">
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-500 dark:text-gray-400">Original Subtotal</span>
                          <span className="font-semibold">₹{selectedBill.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        {modalRefund > 0 && (
                          <div className="flex justify-between text-sm text-red-600 dark:text-red-400">
                            <span className="font-medium">Total Refunded</span>
                            <span className="font-bold">-₹{modalRefund.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-base font-bold text-gray-900 dark:text-[#f0fdf4] border-t border-dashed border-gray-200 dark:border-[#1f3328] pt-2">
                          <span>Net Paid Amount</span>
                          <span className="text-lg text-green-600 dark:text-green-400">₹{modalNet.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}

              {/* Return History Tab */}
              {activeTab === 'returns' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 mb-2">
                    <Info size={16} className="text-amber-500" />
                    <span>Audit trail of all merchandise returns issued against this invoice.</span>
                  </div>
                  {selectedBill.returns && selectedBill.returns.length > 0 ? (
                    <div className="border border-gray-200 dark:border-[#1f3328] rounded-xl overflow-hidden">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-[#0b130f] text-gray-500 dark:text-gray-400 font-semibold border-b border-gray-200 dark:border-[#1f3328]">
                            <th className="px-4 py-3">Return Date</th>
                            <th className="px-4 py-3">Refund Method</th>
                            <th className="px-4 py-3">Reason</th>
                            <th className="px-4 py-3 text-right">Refund Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-[#1f3328]">
                          {selectedBill.returns.map((ret, rIdx) => (
                            <tr key={rIdx} className="hover:bg-gray-50/50 dark:hover:bg-[#192b21]/40">
                              <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#f0fdf4]">
                                {new Date(ret.createdAt || ret.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="px-4 py-3">
                                <span className="px-2 py-0.5 bg-gray-100 dark:bg-[#192b21] rounded text-[11px] font-medium text-gray-800 dark:text-gray-200">
                                  {ret.refundMethod || ret.refund_method || 'Cash'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                                {ret.reason || 'Customer return'}
                              </td>
                              <td className="px-4 py-3 text-right font-bold text-red-600 dark:text-red-400">
                                -₹{Number(ret.totalRefundAmount !== undefined ? ret.totalRefundAmount : ret.total_refund_amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 py-6 text-center">No returns recorded for this invoice.</p>
                  )}
                </div>
              )}

              {/* Revision History Tab */}
              {activeTab === 'revisions' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 mb-2">
                    <Info size={16} className="text-blue-500" />
                    <span>Audit trail of invoice modifications and adjustments.</span>
                  </div>
                  {selectedBill.revisions && selectedBill.revisions.length > 0 ? (
                    <div className="border border-gray-200 dark:border-[#1f3328] rounded-xl overflow-hidden">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-[#0b130f] text-gray-500 dark:text-gray-400 font-semibold border-b border-gray-200 dark:border-[#1f3328]">
                            <th className="px-4 py-3">Revision Date</th>
                            <th className="px-4 py-3">Previous Total</th>
                            <th className="px-4 py-3">New Total</th>
                            <th className="px-4 py-3">Payment Method</th>
                            <th className="px-4 py-3">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-[#1f3328]">
                          {selectedBill.revisions.map((rev, rvIdx) => {
                            const pTot = rev.previousTotal !== undefined ? rev.previousTotal : rev.previous_total;
                            const nTot = rev.newTotal !== undefined ? rev.newTotal : rev.new_total;
                            const pPay = rev.previousPaymentMethod || rev.previous_payment_method;
                            const nPay = rev.newPaymentMethod || rev.new_payment_method;

                            return (
                              <tr key={rvIdx} className="hover:bg-gray-50/50 dark:hover:bg-[#192b21]/40">
                                <td className="px-4 py-3 font-medium text-gray-900 dark:text-[#f0fdf4]">
                                  {new Date(rev.createdAt || rev.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </td>
                                <td className="px-4 py-3 text-gray-500 dark:text-gray-400 line-through">
                                  ₹{Number(pTot).toFixed(2)}
                                </td>
                                <td className="px-4 py-3 font-bold text-green-700 dark:text-green-400">
                                  ₹{Number(nTot).toFixed(2)}
                                </td>
                                <td className="px-4 py-3">
                                  <span className="text-gray-600 dark:text-gray-300">
                                    {pPay} → <b>{nPay}</b>
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                                  {rev.reason || 'Invoice revision'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 py-6 text-center">No modifications recorded for this invoice.</p>
                  )}
                </div>
              )}

              {/* Action Buttons in Footer */}
              <div className="flex items-center justify-between gap-3 mt-auto pt-4 border-t border-gray-200 dark:border-[#1f3328] flex-wrap">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleOpenReturnModal(selectedBill)}
                    className="px-3.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60 border border-amber-200 dark:border-amber-800/60 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 font-sans shadow-sm"
                    title="Return one or more items from this bill"
                  >
                    <RotateCcw size={14} />
                    Return Bill
                  </button>
                  <button
                    onClick={() => handleOpenModifyModal(selectedBill)}
                    className="px-3.5 py-2 bg-blue-50 hover:bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/60 border border-blue-200 dark:border-blue-800/60 text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 font-sans shadow-sm"
                    title="Modify item quantities, prices, discounts or payment method"
                  >
                    <Edit3 size={14} />
                    Modify Invoice
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handlePrintPastInvoice(selectedBill._id)}
                    className="px-4 py-2 bg-gray-50 dark:bg-[#0b130f] border border-gray-200 dark:border-[#1f3328] hover:border-[var(--accent)] text-gray-600 dark:text-gray-300 hover:text-[var(--accent)] text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 font-sans"
                  >
                    <Printer size={14} />
                    Print
                  </button>
                  <button
                    onClick={() => handleDownloadPastInvoice(selectedBill._id, selectedBill.invoiceNumber)}
                    className="px-4 py-2 bg-[var(--accent)] hover:opacity-90 text-white text-xs font-semibold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 font-sans shadow-sm"
                  >
                    <Download size={14} />
                    Download PDF
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Return Bill Modal */}
      {showReturnModal && selectedBill && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#121f18] text-gray-900 dark:text-[#f0fdf4] w-full max-w-3xl rounded-2xl border border-gray-200 dark:border-[#1f3328] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-toast">
            <div className="px-6 py-4 border-b border-gray-150 dark:border-[#1f3328] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-50 dark:bg-amber-950/50 rounded-xl text-amber-700 dark:text-amber-400">
                  <RotateCcw size={18} />
                </div>
                <div>
                  <h2 className="text-lg font-bold">Return Bill / Items</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Invoice #{selectedBill.invoiceNumber}</p>
                </div>
              </div>
              <button
                onClick={() => setShowReturnModal(false)}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-[#192b21] rounded-lg text-gray-500 dark:text-gray-400 transition-all cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5 min-h-0">
              <div className="bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200">
                  <Info size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <span>Returned items are automatically restocked into inventory and deducted from the customer's purchase total.</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={handleReturnAllItems}
                    className="px-2.5 py-1 text-[11px] font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-md cursor-pointer transition-colors"
                  >
                    Return All
                  </button>
                  <button
                    type="button"
                    onClick={handleResetReturnQtys}
                    className="px-2.5 py-1 text-[11px] font-semibold bg-gray-200 dark:bg-[#192b21] text-gray-700 dark:text-gray-300 rounded-md cursor-pointer hover:bg-gray-300 dark:hover:bg-[#2a4537] transition-colors"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Items Table */}
              <div className="border border-gray-200 dark:border-[#1f3328] rounded-xl overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-[#0b130f] text-gray-500 dark:text-gray-400 font-semibold border-b border-gray-200 dark:border-[#1f3328]">
                      <th className="px-3 py-2.5">Medicine</th>
                      <th className="px-3 py-2.5 text-right">Sold</th>
                      <th className="px-3 py-2.5 text-right">Returned</th>
                      <th className="px-3 py-2.5 text-right">Returnable</th>
                      <th className="px-3 py-2.5 text-center">Return Qty</th>
                      <th className="px-3 py-2.5 text-right">Refund Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-[#1f3328]">
                    {selectedBill.items.map((item) => {
                      const itemId = item._id || item.id;
                      const retQty = item.returnedQuantity || 0;
                      const maxReturnable = Math.max(0, item.quantity - retQty);
                      const currentVal = returnQuantities[itemId] || 0;
                      const effectivePrice = item.price * (1 - (item.discount || 0) / 100);
                      const lineRefund = currentVal * effectivePrice;

                      return (
                        <tr key={itemId} className="hover:bg-gray-50/50 dark:hover:bg-[#192b21]/30">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-[#f0fdf4]">
                            <div>{item.product?.name || "Product"}</div>
                            <span className="text-[10px] text-gray-500 dark:text-gray-400">
                              ₹{item.price} {item.discount > 0 ? `(${item.discount}% off)` : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-700 dark:text-gray-300">{item.quantity}</td>
                          <td className="px-3 py-2.5 text-right text-red-600 dark:text-red-400 font-semibold">{retQty}</td>
                          <td className="px-3 py-2.5 text-right text-green-700 dark:text-green-400 font-bold">{maxReturnable}</td>
                          <td className="px-3 py-2.5 text-center">
                            {maxReturnable > 0 ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleReturnQtyChange(itemId, currentVal - 1, maxReturnable)}
                                  className="w-6 h-6 rounded bg-gray-100 dark:bg-[#192b21] hover:bg-gray-200 dark:hover:bg-[#2a4537] text-gray-700 dark:text-gray-300 font-bold flex items-center justify-center cursor-pointer"
                                  disabled={currentVal <= 0}
                                >
                                  -
                                </button>
                                <input
                                  type="number"
                                  min="0"
                                  max={maxReturnable}
                                  value={currentVal}
                                  onChange={(e) => handleReturnQtyChange(itemId, e.target.value, maxReturnable)}
                                  className="w-14 text-center px-1.5 py-1 text-xs border border-gray-300 dark:border-[#2a4537] rounded-md bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] font-semibold focus:outline-none focus:border-[var(--accent)]"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleReturnQtyChange(itemId, currentVal + 1, maxReturnable)}
                                  className="w-6 h-6 rounded bg-gray-100 dark:bg-[#192b21] hover:bg-gray-200 dark:hover:bg-[#2a4537] text-gray-700 dark:text-gray-300 font-bold flex items-center justify-center cursor-pointer"
                                  disabled={currentVal >= maxReturnable}
                                >
                                  +
                                </button>
                              </div>
                            ) : (
                              <span className="text-[11px] text-gray-400 italic">Fully Returned</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right font-bold text-red-600 dark:text-red-400">
                            ₹{lineRefund.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Refund Method & Reason */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                    Refund Method
                  </label>
                  <select
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-[#2a4537] rounded-lg bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value="Cash">Cash</option>
                    <option value="Card">Card</option>
                    <option value="UPI">UPI</option>
                    <option value="Online">Online</option>
                    <option value="Store Credit">Store Credit</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                    Return Reason
                  </label>
                  <input
                    type="text"
                    placeholder="e.g., Wrong dosage, customer preference, damaged item"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-[#2a4537] rounded-lg bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              </div>

              {/* Financial Calculation Box */}
              {(() => {
                const totalRefundAmount = selectedBill.items?.reduce((sum, item) => {
                  const itemId = item._id || item.id;
                  const qty = returnQuantities[itemId] || 0;
                  const effectivePrice = item.price * (1 - (item.discount || 0) / 100);
                  return sum + (qty * effectivePrice);
                }, 0) || 0;

                const totalItemsToReturn = Object.values(returnQuantities).reduce((sum, q) => sum + (Number(q) || 0), 0);

                return (
                  <div className="bg-gray-50 dark:bg-[#0b130f] border border-gray-200 dark:border-[#1f3328] rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Total Items Returning</p>
                      <p className="text-sm font-bold text-gray-900 dark:text-[#f0fdf4]">{totalItemsToReturn} units</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Total Refund Due</p>
                      <p className="text-xl font-bold text-red-600 dark:text-red-400">
                        ₹{totalRefundAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="px-6 py-4 border-t border-gray-150 dark:border-[#1f3328] flex items-center justify-end gap-3 bg-gray-50/50 dark:bg-[#0b130f]">
              <button
                type="button"
                onClick={() => setShowReturnModal(false)}
                className="px-4 py-2 text-xs font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-[#192b21] rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleProcessReturnSubmit}
                disabled={isSubmittingReturn || Object.values(returnQuantities).every(q => !q || q === 0)}
                className="px-5 py-2 text-xs font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shadow-sm"
              >
                {isSubmittingReturn ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <RotateCcw size={14} />
                    <span>Confirm & Process Return</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modify Invoice Modal */}
      {showModifyModal && selectedBill && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#121f18] text-gray-900 dark:text-[#f0fdf4] w-full max-w-3xl rounded-2xl border border-gray-200 dark:border-[#1f3328] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-toast">
            <div className="px-6 py-4 border-b border-gray-150 dark:border-[#1f3328] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-blue-50 dark:bg-blue-950/50 rounded-xl text-blue-700 dark:text-blue-400">
                  <Edit3 size={18} />
                </div>
                <div>
                  <h2 className="text-lg font-bold">Modify Invoice</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Invoice #{selectedBill.invoiceNumber}</p>
                </div>
              </div>
              <button
                onClick={() => setShowModifyModal(false)}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-[#192b21] rounded-lg text-gray-500 dark:text-gray-400 transition-all cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5 min-h-0">
              <div className="bg-blue-50/60 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 rounded-xl p-3 flex items-center gap-2 text-xs text-blue-900 dark:text-blue-200">
                <Info size={16} className="text-blue-600 dark:text-blue-400 flex-shrink-0" />
                <span>Adjusting item quantities automatically reconciles inventory stock. Quantity cannot be lowered below already returned quantity.</span>
              </div>

              {/* Editable Items Table */}
              <div className="border border-gray-200 dark:border-[#1f3328] rounded-xl overflow-hidden">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-[#0b130f] text-gray-500 dark:text-gray-400 font-semibold border-b border-gray-200 dark:border-[#1f3328]">
                      <th className="px-3 py-2.5">Medicine</th>
                      <th className="px-3 py-2.5 text-center">Quantity</th>
                      <th className="px-3 py-2.5 text-right">Unit Price (₹)</th>
                      <th className="px-3 py-2.5 text-right">Disc (%)</th>
                      <th className="px-3 py-2.5 text-right">Line Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-[#1f3328]">
                    {modifiedItems.map((item, idx) => {
                      const lineTotal = item.quantity * item.price * (1 - (item.discount || 0) / 100);

                      return (
                        <tr key={item._id} className="hover:bg-gray-50/50 dark:hover:bg-[#192b21]/30">
                          <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-[#f0fdf4]">
                            <div>{item.name}</div>
                            {item.returnedQuantity > 0 && (
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                                {item.returnedQuantity} already returned (min: {item.returnedQuantity})
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <input
                              type="number"
                              min={item.returnedQuantity || 1}
                              value={item.quantity}
                              onChange={(e) => handleModifyItemChange(idx, 'quantity', e.target.value)}
                              className="w-16 text-center px-1.5 py-1 text-xs border border-gray-300 dark:border-[#2a4537] rounded-md bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] font-semibold focus:outline-none focus:border-[var(--accent)]"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.price}
                              onChange={(e) => handleModifyItemChange(idx, 'price', e.target.value)}
                              className="w-20 text-right px-1.5 py-1 text-xs border border-gray-300 dark:border-[#2a4537] rounded-md bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] font-semibold focus:outline-none focus:border-[var(--accent)]"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="1"
                              value={item.discount}
                              onChange={(e) => handleModifyItemChange(idx, 'discount', e.target.value)}
                              className="w-14 text-right px-1.5 py-1 text-xs border border-gray-300 dark:border-[#2a4537] rounded-md bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] font-semibold focus:outline-none focus:border-[var(--accent)]"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-right font-bold text-gray-900 dark:text-[#f0fdf4]">
                            ₹{lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Payment Method & Modification Reason */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                    Payment Method
                  </label>
                  <select
                    value={modifiedPaymentMethod}
                    onChange={(e) => setModifiedPaymentMethod(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-[#2a4537] rounded-lg bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value="Cash">Cash</option>
                    <option value="Card">Card</option>
                    <option value="UPI">UPI</option>
                    <option value="Online">Online</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
                    Reason for Revision <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Corrected quantity, discount renegotiated, customer request"
                    value={modifyReason}
                    onChange={(e) => setModifyReason(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-gray-300 dark:border-[#2a4537] rounded-lg bg-white dark:bg-[#0b130f] text-gray-900 dark:text-[#f0fdf4] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              </div>

              {/* Financial Comparison Box */}
              {(() => {
                const newTotal = modifiedItems.reduce((sum, item) => {
                  return sum + (item.quantity * item.price * (1 - (item.discount || 0) / 100));
                }, 0);
                const originalTotal = selectedBill.totalAmount;
                const delta = newTotal - originalTotal;

                return (
                  <div className="bg-gray-50 dark:bg-[#0b130f] border border-gray-200 dark:border-[#1f3328] rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Original Total</p>
                      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                        ₹{originalTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Difference</p>
                      <p className={`text-sm font-bold ${delta > 0 ? 'text-green-600 dark:text-green-400' : delta < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}`}>
                        {delta > 0 ? `+₹${delta.toFixed(2)}` : delta < 0 ? `-₹${Math.abs(delta).toFixed(2)}` : '₹0.00'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Revised Total</p>
                      <p className="text-xl font-bold text-green-700 dark:text-green-400">
                        ₹{newTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="px-6 py-4 border-t border-gray-150 dark:border-[#1f3328] flex items-center justify-end gap-3 bg-gray-50/50 dark:bg-[#0b130f]">
              <button
                type="button"
                onClick={() => setShowModifyModal(false)}
                className="px-4 py-2 text-xs font-semibold text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-[#192b21] rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleModifyInvoiceSubmit}
                disabled={isSubmittingModify || !modifyReason.trim()}
                className="px-5 py-2 text-xs font-semibold bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-all cursor-pointer flex items-center gap-1.5 shadow-sm"
              >
                {isSubmittingModify ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    <span>Save Changes</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[9999] animate-toast">
          <div className={`flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg border ${
            toast.type === 'error'
              ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/90 dark:text-red-300 dark:border-red-900'
              : 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/90 dark:text-green-300 dark:border-green-900'
          }`}>
            {toast.type === 'error' ? <AlertCircle size={18} /> : <Check size={18} />}
            <span className="text-sm font-semibold">{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerDetails;
