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
        <div><h1 className="text-xl font-display font-bold text-white">AI Assistant</h1><p className="text-xs text-slate-400 mt-0.5">Ask questions about your KPI, QC, and Queue data</p></div>
        {isManagerPlus() && <button onClick={loadPrompt} className="text-xs text-slate-400 hover:text-white transition-colors px-3 py-1.5 border border-slate-700/40 rounded-lg">⚙ System Prompt</button>}
      </div>

      {/* Prompt editor */}
      {showPrompt && <div className="glass rounded-xl p-4 mb-3">
        <div className="flex items-center justify-between mb-2"><span className="text-sm font-medium text-white">System Prompt</span><button onClick={()=>setShowPrompt(false)} className="text-xs text-slate-400 hover:text-white">Close</button></div>
        <textarea value={sysPrompt} onChange={e=>setSysPrompt(e.target.value)} rows={8} className="w-full px-3 py-2 bg-slate-800/60 border border-slate-600/40 rounded-lg text-sm text-white font-mono resize-y focus:outline-none focus:border-navy-400" />
        <div className="flex gap-2 mt-2">
          <button onClick={savePrompt} disabled={promptLoading} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded font-medium">{promptLoading?'Saving...':'Save Prompt'}</button>
          <p className="text-[10px] text-slate-500 self-center">Changes affect all users. Edits are logged.</p>
        </div>
      </div>}

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-3 min-h-0">
        {!msgs.length && <div className="space-y-4 pt-8">
          <div className="text-center text-slate-500 text-sm mb-6">Ask me anything about your operations data.</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 max-w-3xl mx-auto">
            {suggested.map((q,i) => (
              <button key={i} onClick={() => send(q.text)}
                className="glass rounded-xl p-3.5 text-left hover:bg-white/[0.06] transition-colors group">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{q.category}</div>
                <div className="text-sm text-slate-300 group-hover:text-white transition-colors">{q.text}</div>
              </button>
            ))}
          </div>
        </div>}

        {msgs.map((m, i) => (
          <div key={i} className={`max-w-3xl ${m.role==='user'?'ml-auto':'mr-auto'}`}>
            <div className={m.role === 'user' ? 'chat-user' : 'chat-ai'}>
              {m.role === 'user' ? <div className="text-sm text-white">{m.content}</div> :
                <div className="text-sm text-slate-200 prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>}
            </div>
            {m.tools > 0 && <div className="text-[10px] text-slate-500 mt-1 ml-2">Fetched live data ({m.tools} queries)</div>}
          </div>
        ))}

        {loading && <div className="max-w-3xl mr-auto"><div className="chat-ai"><div className="flex items-center gap-2 text-sm text-slate-400"><div className="w-2 h-2 bg-navy-400 rounded-full loading" /><span>Analyzing your data...</span></div></div></div>}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="glass rounded-xl px-4 py-3 flex gap-3 items-end mt-2">
        <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} placeholder="Ask about your KPI, QC, or queue data..." rows={1}
          className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 resize-none focus:outline-none min-h-[36px] max-h-[120px]"
          style={{height:'auto',overflow:'hidden'}} onInput={e=>{e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px';}} />
        <button onClick={()=>send()} disabled={loading || !input.trim()}
          className="px-5 py-2 bg-navy-600 hover:bg-navy-500 disabled:bg-slate-700 text-white text-sm rounded-lg font-medium transition-colors shrink-0">
          {loading ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
