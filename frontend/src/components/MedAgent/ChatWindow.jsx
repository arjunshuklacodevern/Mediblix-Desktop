import React, { useState, useRef, useEffect } from 'react';
import { Send, AlertTriangle, Info, ArrowRight, Minus, X, Sparkles, Database, BarChart2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import medAgentService from '../../services/medAgentService';
import MedicineCard, { AlternativeCard } from './MedicineCard';

const ChatWindow = ({ onClose }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(true);
  const [aiStatus, setAiStatus] = useState({
    activeMode: 'offline',
    onlineConfigured: false,
    provider: 'local-sqlite',
  });
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const quickChips = [
    "Headache & fever",
    "Acidity",
    "Stock summary",
    "Need Dolo 650",
    "Low stock alerts",
    "How to add product?",
    "Create a bill",
  ];

  useEffect(() => {
    // Initial welcome message
    setMessages([
      {
        id: 1,
        sender: 'agent',
        type: 'general',
        mode: 'offline',
        content:
          "Hi! I'm MedAgent, your Hybrid AI pharmacy assistant. I operate offline using your local SQLite database and online for advanced generative reasoning when connected.\n\nI can help you:\n• Recommend OTC medicines for symptoms\n• Find in-stock substitutes for unavailable items\n• Provide instant stock valuation & reorder alerts\n• Guide you through Mediblix features",
      },
    ]);

    // Check backend hybrid AI status
    medAgentService
      .getStatus()
      .then((status) => {
        if (status) setAiStatus(status);
      })
      .catch(() => {
        setAiStatus({
          activeMode: 'offline',
          onlineConfigured: false,
          provider: 'local-sqlite',
        });
      });

    // Focus input on mount
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 250);
  };

  const handleFindAlternative = async (medicineName, category) => {
    const messageId = Date.now();
    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        sender: 'user',
        content: `Find alternative for ${medicineName}`,
      },
    ]);
    setIsTyping(true);

    try {
      const response = await medAgentService.getAlternatives(medicineName, category);

      setMessages((prev) => [
        ...prev,
        {
          id: messageId + 1,
          sender: 'agent',
          type: 'alternative',
          mode: 'offline',
          content: `Here are available alternatives for "${medicineName}":`,
          alternatives: response.alternatives || [],
          originalMedicine: response.originalMedicine,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: messageId + 1,
          sender: 'agent',
          type: 'error',
          content: "Sorry, I couldn't find alternatives right now. Please check your inventory.",
        },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  const sendMessage = async (text) => {
    if (!text.trim()) return;

    const messageId = Date.now();
    const userMessage = { id: messageId, sender: 'user', content: text };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsTyping(true);

    try {
      const history = messages.slice(-5).map((m) => ({
        role: m.sender === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      }));

      const response = await medAgentService.sendMessage(text, history);

      setMessages((prev) => [
        ...prev,
        {
          id: messageId + 1,
          sender: 'agent',
          ...response,
          content: response.message,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: messageId + 1,
          sender: 'agent',
          type: 'error',
          content: "I'm having trouble connecting to the local AI service. Please try again.",
        },
      ]);
    } finally {
      setIsTyping(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputValue);
    }
  };

  const handleChipClick = (chip) => {
    sendMessage(chip);
  };

  const renderAgentMessage = (msg) => {
    return (
      <div className="medagent-msg agent">
        <div className="medagent-msg-bubble">
          {msg.content}

          {/* Mode or Fallback Indicator */}
          {msg.fallbackApplied && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2 flex items-center gap-1.5 font-medium">
              <Database size={12} className="text-amber-600" />
              <span>Offline Fallback Active (Local SQLite & Clinical Engine)</span>
            </div>
          )}

          {/* Doctor Warning */}
          {msg.doctorConsultRequired && (
            <div className="medagent-doctor-warning">
              <AlertTriangle className="medagent-doctor-warning-icon" />
              <div>
                <strong>Urgent Medical Attention Advised</strong>
                <br />
                Please advise the customer to seek professional medical help immediately.
              </div>
            </div>
          )}

          {/* Insights Data Grid */}
          {msg.insightsData?.metrics && (
            <div className="medagent-insights-box">
              <div className="flex items-center gap-1.5 font-semibold text-slate-800 mb-2">
                <BarChart2 size={14} className="text-emerald-600" />
                <span>Inventory Health Metrics</span>
              </div>
              <div className="medagent-insights-grid">
                <div className="medagent-stat-tile">
                  <div className="medagent-stat-value">₹{msg.insightsData.metrics.totalValuation.toLocaleString()}</div>
                  <div className="medagent-stat-label">Total Stock Value</div>
                </div>
                <div className="medagent-stat-tile">
                  <div className="medagent-stat-value">{msg.insightsData.metrics.totalProducts}</div>
                  <div className="medagent-stat-label">Active SKUs</div>
                </div>
                <div className="medagent-stat-tile">
                  <div className="medagent-stat-value text-amber-600">{msg.insightsData.metrics.lowStockCount}</div>
                  <div className="medagent-stat-label">Low Stock (≤10)</div>
                </div>
                <div className="medagent-stat-tile">
                  <div className="medagent-stat-value text-red-600">{msg.insightsData.metrics.outOfStockCount}</div>
                  <div className="medagent-stat-label">Out of Stock</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Medicines List */}
        {msg.medicines?.map((med, idx) => (
          <MedicineCard key={idx} medicine={med} onFindAlternative={handleFindAlternative} />
        ))}

        {/* Alternatives */}
        {msg.alternatives?.length > 0 && (
          <div className="medagent-alts-container">
            {msg.type === 'alternative' ? (
              msg.alternatives.map((alt, idx) => <AlternativeCard key={idx} alt={alt} />)
            ) : (
              msg.alternatives.map((altGroup, idx) => (
                <div key={idx}>
                  <div className="medagent-alts-header">Alternatives for {altGroup.forMedicine}</div>
                  {altGroup.alternatives.map((alt, aIdx) => (
                    <AlternativeCard key={aIdx} alt={alt} />
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {/* General Advice */}
        {msg.generalAdvice && !msg.doctorConsultRequired && (
          <div className="medagent-advice">
            <Info size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>{msg.generalAdvice}</div>
          </div>
        )}

        {/* App Guidance Steps */}
        {(msg.steps || msg.navigateTo) && (
          <div className="medagent-nav-card">
            {msg.steps && (
              <ul className="medagent-nav-steps">
                {msg.steps.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ul>
            )}
            {msg.navigateTo && (
              <button
                className="medagent-nav-btn"
                onClick={() => {
                  navigate(msg.navigateTo);
                  onClose();
                }}
              >
                Go to {msg.pageTitle || 'Page'} <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`medagent-window ${isClosing ? 'closing' : ''}`}>
      {/* Header */}
      <div className="medagent-header">
        <div className="medagent-header-avatar">
          <span style={{ fontSize: '20px' }}>🏥</span>
        </div>
        <div className="medagent-header-info">
          <div className="flex items-center gap-2">
            <div className="medagent-header-title">Mediblix MedAgent</div>
            <span className={`medagent-mode-badge ${aiStatus.activeMode === 'online' ? 'online' : 'offline'}`}>
              {aiStatus.activeMode === 'online' ? '🟢 Cloud AI' : '⚡ Local SQLite'}
            </span>
          </div>
          <div className="medagent-header-subtitle">
            {aiStatus.activeMode === 'online'
              ? 'Cloud Gateway connected'
              : 'Local clinical heuristics & SQLite data active'}
          </div>
        </div>
        <div className="medagent-header-actions">
          <button className="medagent-header-btn" onClick={handleClose}>
            <Minus size={18} />
          </button>
        </div>
      </div>

      {/* Disclaimer */}
      {showDisclaimer && (
        <div className="medagent-disclaimer">
          <AlertTriangle size={14} className="medagent-disclaimer-icon" />
          <div>
            <strong>Disclaimer:</strong> Not a substitute for professional medical advice. Always verify medicines before dispensing.
          </div>
          <button className="medagent-disclaimer-close" onClick={() => setShowDisclaimer(false)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="medagent-messages">
        {messages.map((msg) =>
          msg.sender === 'user' ? (
            <div key={msg.id} className="medagent-msg user">
              <div className="medagent-msg-bubble">{msg.content}</div>
            </div>
          ) : (
            <React.Fragment key={msg.id}>{renderAgentMessage(msg)}</React.Fragment>
          )
        )}

        {messages.length === 1 && (
          <div className="medagent-chips">
            {quickChips.map((chip, idx) => (
              <button key={idx} className="medagent-chip" onClick={() => handleChipClick(chip)}>
                {chip}
              </button>
            ))}
          </div>
        )}

        {isTyping && (
          <div className="medagent-typing">
            <div className="medagent-typing-dots">
              <div className="medagent-typing-dot"></div>
              <div className="medagent-typing-dot"></div>
              <div className="medagent-typing-dot"></div>
            </div>
            <div className="medagent-typing-text">MedAgent is thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="medagent-input-area">
        <input
          ref={inputRef}
          type="text"
          className="medagent-input"
          placeholder="Describe symptoms, ask for alternatives or stock summary..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isTyping}
        />
        <button
          className="medagent-send-btn"
          onClick={() => sendMessage(inputValue)}
          disabled={!inputValue.trim() || isTyping}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
};

export default ChatWindow;
