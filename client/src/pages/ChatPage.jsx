import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Section } from '../components/UI';
import { api, isManagerPlus } from '../hooks/useApi';

export default function ChatPage() {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [suggested, setSuggested] = useState([]);
  const [showPrompt, setShowPrompt] = useState(false);
  const [sysPrompt, setSysPrompt] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { loadSuggested(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({behavior:'smooth'}); }, [msgs]);

  async function loadSuggested() { try { const d = await api('/ai/suggested-questions'); setSuggested(d.questions||[]); } catch {} }
  async function loadPrompt() { setShowPrompt(true); try { const d = await api('/ai/system-prompt'); setSysPrompt(d.prompt||''); } catch(e) { setSysPrompt('Error: '+e.message); } }
  async function savePrompt() { setPromptLoading(true); try { await api('/ai/system-prompt',{method:'PUT',body:JSON.stringify({content:sysPrompt})}); alert('Prompt saved!'); } catch(e) { alert('Failed: '+e.message); } setPromptLoading(false); }

  async function send(text) {
    const q = text || input.trim();
    if (!q) return;
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
      setMsgs([...newMsgs, { role: 'assistant', content: d.response || 'No response.', tools: d.toolIterations }]);
    } catch (e) {
      setMsgs([...newMsgs, { role: 'assistant', content: '⚠ Error: ' + e.message }]);
    }
    setLoading(false);
  }

  const handleKey = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] max-h-[calc(100vh-3rem)]">
      <div className="flex items-center justify-between mb-3">
        <div><h1 className="text-xl font-display font-bold text-ink-900" data-tour="chat-title">AI Assistant</h1><p className="text-xs text-ink-400 mt-0.5">Ask questions about your KPI, QC, and Queue data</p></div>
        {isManagerPlus() && <button onClick={loadPrompt} className="text-xs text-ink-400 hover:text-ink-900 transition-colors px-3 py-1.5 border border-surface-200 rounded-lg">⚙ System Prompt</button>}
      </div>

      {/* Prompt editor */}
      {showPrompt && <div className="card-surface p-4 mb-3">
        <div className="flex items-center justify-between mb-2"><span className="text-sm font-medium text-ink-900">System Prompt</span><button onClick={()=>setShowPrompt(false)} className="text-xs text-ink-400 hover:text-ink-900">Close</button></div>
        <textarea value={sysPrompt} onChange={e=>setSysPrompt(e.target.value)} rows={8} className="w-full px-3 py-2 bg-white border border-surface-200 rounded-lg text-sm text-ink-900 font-mono resize-y focus:outline-none focus:border-brand-400" />
        <div className="flex gap-2 mt-2">
          <button onClick={savePrompt} disabled={promptLoading} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-ink-900 text-xs rounded font-medium">{promptLoading?'Saving...':'Save Prompt'}</button>
          <p className="text-[10px] text-ink-500 self-center">Changes affect all users. Edits are logged.</p>
        </div>
      </div>}

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-3 min-h-0">
        {!msgs.length && <div className="space-y-4 pt-8">
          <div className="text-center text-ink-500 text-sm mb-6">Ask me anything about your operations data.</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 max-w-3xl mx-auto">
            {suggested.map((q,i) => (
              <button key={i} onClick={() => send(q.text)}
                className="card-surface p-3.5 text-left hover:bg-white/[0.06] transition-colors group">
                <div className="text-[10px] uppercase tracking-wider text-ink-500 mb-1">{q.category}</div>
                <div className="text-sm text-ink-600 group-hover:text-ink-900 transition-colors">{q.text}</div>
              </button>
            ))}
          </div>
        </div>}

        {msgs.map((m, i) => (
          <div key={i} className={`max-w-3xl ${m.role==='user'?'ml-auto':'mr-auto'}`}>
            <div className={m.role === 'user' ? 'chat-user' : 'chat-ai'}>
              {m.role === 'user' ? <div className="text-sm text-ink-900">{m.content}</div> :
                <div className="text-sm text-ink-500 prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>}
            </div>
            {m.tools > 0 && <div className="text-[10px] text-ink-500 mt-1 ml-2">Fetched live data ({m.tools} queries)</div>}
          </div>
        ))}

        {loading && <div className="max-w-3xl mr-auto"><div className="chat-ai"><div className="flex items-center gap-2 text-sm text-ink-400"><div className="w-2 h-2 bg-navy-400 rounded-full loading" /><span>Analyzing your data...</span></div></div></div>}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="card-surface px-4 py-3 flex gap-3 items-end mt-2">
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder="Ask about your KPI, QC, or queue data..." rows={1}
          className="flex-1 bg-transparent text-sm text-ink-900 placeholder-ink-400 resize-none focus:outline-none min-h-[36px] max-h-[120px]"
          style={{height:'auto',overflow:'hidden'}} onInput={e=>{e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px';}} />
        <button onClick={()=>send()} disabled={loading || !input.trim()}
          className="px-5 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-200 disabled:text-ink-400 text-ink-900 text-sm rounded-lg font-medium transition-colors shrink-0">
          {loading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
