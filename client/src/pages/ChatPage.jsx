import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, isManagerPlus, getUser } from '../hooks/useApi';

// Defense-in-depth for the assistant transcript renderer. react-markdown v9 disables
// raw HTML by default, but `skipHtml` is explicit, and `urlTransform` blocks
// non-http(s)/mailto schemes (e.g., javascript:) in any links the model emits.
const SAFE_URL_SCHEMES = /^(https?:|mailto:)/i;
function safeUrl(url) {
  if (typeof url !== 'string') return '';
  return SAFE_URL_SCHEMES.test(url.trim()) ? url : '';
}

function fmtTs(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  const diffMs = now - dt;
  if (diffMs < 60000) return 'just now';
  if (diffMs < 3600000) return `${Math.floor(diffMs/60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs/3600000)}h ago`;
  return dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
}

export default function ChatPage() {
  const [msgs, setMsgs]           = useState([]);
  const [input, setInput]         = useState('');
  const [loading, setLoading]     = useState(false);
  const [suggested, setSuggested] = useState([]);
  const [showPrompt, setShowPrompt] = useState(false);
  const [sysPrompt, setSysPrompt] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);

  // Conversation management
  const [convId, setConvId]       = useState(null);   // MongoDB _id of current saved convo
  const [convTitle, setConvTitle] = useState('');
  const [history, setHistory]     = useState([]);      // list of saved conversations
  const [histLoading, setHistLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saving, setSaving]       = useState(false);

  const endRef  = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { loadSuggested(); loadHistory(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  async function loadSuggested() {
    try { const d = await api('/ai/suggested-questions'); setSuggested(d.questions || []); } catch {}
  }

  async function loadHistory() {
    setHistLoading(true);
    try {
      const d = await api('/ai/conversations');
      setHistory(d.conversations || []);
    } catch {}
    setHistLoading(false);
  }

  async function loadConversation(id) {
    try {
      const d = await api(`/ai/conversations/${id}`);
      setMsgs(d.messages || []);
      setConvId(id);
      setConvTitle(d.title || '');
      setShowHistory(false);
    } catch (e) { alert('Failed to load: ' + e.message); }
  }

  const saveConversation = useCallback(async (messages, existingId) => {
    if (!messages.length) return null;
    setSaving(true);
    try {
      const title = messages.find(m => m.role === 'user')?.content?.substring(0, 60) || 'Conversation';
      if (existingId) {
        await api(`/ai/conversations/${existingId}`, { method: 'PUT', body: JSON.stringify({ messages, title }) });
        return existingId;
      } else {
        const d = await api('/ai/conversations', { method: 'POST', body: JSON.stringify({ messages, title }) });
        return d.id;
      }
    } catch {}
    setSaving(false);
    return existingId;
  }, []);

  async function deleteConversation(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await api(`/ai/conversations/${id}`, { method: 'DELETE' });
      if (id === convId) { newConversation(); }
      setHistory(h => h.filter(c => String(c._id) !== String(id)));
    } catch {}
  }

  function newConversation() {
    setMsgs([]); setConvId(null); setConvTitle(''); setShowHistory(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  async function loadPrompt() {
    setShowPrompt(true);
    try { const d = await api('/ai/system-prompt'); setSysPrompt(d.prompt || ''); } catch (e) { setSysPrompt('Error: ' + e.message); }
  }

  async function savePrompt() {
    setPromptLoading(true);
    try { await api('/ai/system-prompt', { method: 'PUT', body: JSON.stringify({ content: sysPrompt }) }); alert('Prompt saved!'); }
    catch (e) { alert('Failed: ' + e.message); }
    setPromptLoading(false);
  }

  async function send(text) {
    const q = (text || input).trim();
    if (!q || loading) return;
    const userMsg = { role: 'user', content: q };
    const newMsgs = [...msgs, userMsg];
    setMsgs(newMsgs);
    setInput('');
    setLoading(true);

    try {
      const d = await api('/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: newMsgs.map(m => ({ role: m.role, content: m.content })) })
      });
      const finalMsgs = [...newMsgs, { role: 'assistant', content: d.response || 'No response.', tools: d.toolIterations }];
      setMsgs(finalMsgs);

      // Auto-save after every exchange
      const savedId = await saveConversation(finalMsgs, convId);
      if (savedId && savedId !== convId) {
        setConvId(savedId);
        setConvTitle(finalMsgs[0]?.content?.substring(0, 60) || 'Conversation');
        // Refresh history list
        loadHistory();
      }
      setSaving(false);
    } catch (e) {
      setMsgs([...newMsgs, { role: 'assistant', content: '⚠ Error: ' + e.message }]);
    }
    setLoading(false);
  }

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const user = getUser();

  return (
    <div className="flex h-[calc(100vh-3.5rem)] gap-0 -mx-3 sm:-mx-6 -mt-0">

      {/* ── Sidebar: conversation history ─────────────────────── */}
      <div className={`${showHistory ? 'flex' : 'hidden'} lg:flex flex-col w-64 shrink-0 border-r border-surface-200 bg-surface-50`}>
        <div className="px-3 py-3 border-b border-surface-200 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-ink-400">Conversations</span>
          <button onClick={newConversation}
            className="text-xs bg-brand-500 hover:bg-brand-600 text-white px-2.5 py-1 rounded-lg font-semibold">
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {histLoading && <div className="px-3 py-4 text-xs text-ink-400">Loading…</div>}
          {!histLoading && !history.length && (
            <div className="px-3 py-6 text-center text-xs text-ink-400">
              No saved conversations yet. Start chatting!
            </div>
          )}
          {history.map(c => (
            <button key={String(c._id)} onClick={() => loadConversation(String(c._id))}
              className={`w-full text-left px-3 py-2.5 group hover:bg-white transition-colors border-b border-surface-100 ${String(c._id) === String(convId) ? 'bg-brand-50 border-l-2 border-l-brand-400' : ''}`}>
              <div className="flex items-start justify-between gap-1">
                <span className="text-[11px] font-medium text-ink-800 truncate leading-snug">{c.title || 'Conversation'}</span>
                <button onClick={e => deleteConversation(String(c._id), e)}
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 text-xs shrink-0 ml-1">×</button>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-ink-400">{fmtTs(c.updatedAt)}</span>
                {c.messageCount && <span className="text-[10px] text-ink-300">· {Math.floor(c.messageCount / 2)} exchange{Math.floor(c.messageCount/2)!==1?'s':''}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Main chat area ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 px-3 sm:px-6">
        {/* Header */}
        <div className="flex items-center justify-between py-3 border-b border-surface-200 mb-3 gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowHistory(h => !h)}
              className="lg:hidden p-1.5 rounded-lg text-ink-500 hover:bg-surface-100 text-xs border border-surface-200">
              ☰
            </button>
            <div>
              <h1 className="text-base font-display font-bold text-ink-900 leading-tight" data-tour="chat-title">
                {convTitle || 'AI Assistant'}
              </h1>
              <p className="text-[10px] text-ink-400">
                {user?.name && <span className="font-medium text-brand-600">{user.name} · </span>}
                Ask questions about your KPI, QC, and Queue data
                {saving && <span className="ml-2 text-ink-300">Saving…</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {msgs.length > 0 && (
              <button onClick={newConversation}
                className="text-xs text-ink-400 hover:text-ink-700 px-2.5 py-1.5 border border-surface-200 rounded-lg">
                New chat
              </button>
            )}
            {isManagerPlus() && (
              <button onClick={loadPrompt}
                className="text-xs text-ink-400 hover:text-ink-900 px-3 py-1.5 border border-surface-200 rounded-lg">
                ⚙ Prompt
              </button>
            )}
          </div>
        </div>

        {/* System prompt editor */}
        {showPrompt && (
          <div className="card-surface p-4 mb-3 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-ink-900">System Prompt</span>
              <button onClick={() => setShowPrompt(false)} className="text-xs text-ink-400 hover:text-ink-900">Close</button>
            </div>
            <textarea value={sysPrompt} onChange={e => setSysPrompt(e.target.value)} rows={8}
              className="w-full px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 font-mono resize-y focus:outline-none focus:border-brand-400" />
            <div className="flex gap-2 mt-2">
              <button onClick={savePrompt} disabled={promptLoading}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded font-medium">
                {promptLoading ? 'Saving...' : 'Save Prompt'}
              </button>
              <p className="text-[10px] text-ink-500 self-center">Changes affect all users. Edits are logged.</p>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-3 pb-3 min-h-0">
          {!msgs.length && (
            <div className="space-y-4 pt-6">
              <div className="text-center text-ink-500 text-sm mb-4">Ask me anything about your operations data.</div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 max-w-3xl mx-auto">
                {suggested.map((q, i) => (
                  <button key={i} onClick={() => send(q.text)}
                    className="card-surface p-3 text-left hover:bg-brand-50 transition-colors group border border-transparent hover:border-brand-200">
                    <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1 font-semibold">{q.category}</div>
                    <div className="text-xs text-ink-600 group-hover:text-ink-900 transition-colors leading-relaxed">{q.text}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] ${m.role === 'user' ? 'max-w-[70%]' : ''}`}>
                {m.role === 'user' ? (
                  <div className="bg-brand-500 text-white px-4 py-2.5 rounded-2xl rounded-tr-sm text-sm">
                    {m.content}
                  </div>
                ) : (
                  <div className="bg-white border border-surface-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                    <div className="text-sm text-ink-700 prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0.5 prose-headings:text-ink-900 prose-headings:font-semibold prose-code:bg-surface-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs">
                      <ReactMarkdown skipHtml urlTransform={safeUrl}>{m.content}</ReactMarkdown>
                    </div>
                    {m.tools > 0 && (
                      <div className="text-[10px] text-ink-400 mt-2 pt-2 border-t border-surface-100">
                        Fetched live data ({m.tools} quer{m.tools === 1 ? 'y' : 'ies'})
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-white border border-surface-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-ink-400">
                  <div className="flex gap-1">
                    {[0,1,2].map(i => (
                      <div key={i} className="w-1.5 h-1.5 bg-brand-400 rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />
                    ))}
                  </div>
                  <span className="text-xs">Analyzing your data…</span>
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 mt-2 mb-2">
          <div className="card-surface px-4 py-3 flex gap-3 items-end border border-surface-200 rounded-2xl">
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about your KPI, QC, or queue data…"
              rows={1}
              className="flex-1 bg-transparent text-sm text-ink-900 placeholder-ink-400 resize-none focus:outline-none min-h-[36px] max-h-[120px]"
              style={{ height: 'auto' }}
              onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }} />
            <button onClick={() => send()} disabled={loading || !input.trim()}
              className="px-5 py-2 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white text-sm rounded-xl font-semibold transition-colors shrink-0">
              {loading ? '…' : '↑'}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1">
            <span className="text-[10px] text-ink-300">Enter to send · Shift+Enter for new line</span>
            {msgs.length > 0 && convId && (
              <span className="text-[10px] text-ink-300 flex items-center gap-1">
                ✓ Auto-saved
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
