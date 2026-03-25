import React, { useEffect, useState } from 'react';
import { Section, Skel, FilterBar, FilterInput } from '../components/UI';
import { api, getUser, isManagerPlus } from '../hooks/useApi';

export default function GlossaryPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ term: '', definition: '', category: 'General', examples: '' });
  const [saving, setSaving] = useState(false);
  const canEdit = isManagerPlus();

  useEffect(() => { load(); }, []);
  async function load() { setLoading(true); try { const d = await api('/glossary'); setItems(d.glossary || []); } catch {} setLoading(false); }

  const startAdd = () => { setForm({ term: '', definition: '', category: 'General', examples: '' }); setEditing('new'); };
  const startEdit = (item) => { setForm({ term: item.term, definition: item.definition, category: item.category || 'General', examples: (item.examples || []).join(', ') }); setEditing(item.term); };
  const cancel = () => { setEditing(null); };

  const save = async () => {
    setSaving(true);
    try {
      await api('/glossary', { method: 'PUT', body: JSON.stringify({
        term: form.term, definition: form.definition, category: form.category,
        examples: form.examples ? form.examples.split(',').map(e => e.trim()).filter(Boolean) : []
      })});
      cancel(); await load();
    } catch (e) { alert('Failed: ' + e.message); }
    setSaving(false);
  };

  const remove = async (term) => {
    if (!confirm(`Delete "${term}" from glossary?`)) return;
    try { await api(`/glossary/${encodeURIComponent(term)}`, { method: 'DELETE' }); await load(); }
    catch (e) { alert('Failed: ' + e.message); }
  };

  const filtered = items.filter(i => {
    if (!filter) return true;
    const s = filter.toLowerCase();
    return i.term.toLowerCase().includes(s) || i.definition.toLowerCase().includes(s) || (i.category || '').toLowerCase().includes(s);
  });

  const categories = [...new Set(items.map(i => i.category || 'General'))].sort();

  if (loading) return <Skel rows={8} cols={3} />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-display font-bold text-ink-900">Glossary</h1>
          <p className="text-xs text-ink-400 mt-0.5">{items.length} terms · Fed into AI chatbot context automatically</p></div>
        {canEdit && <button onClick={startAdd} className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-ink-900 text-sm rounded-lg font-medium">+ Add Term</button>}
      </div>

      <FilterBar><FilterInput label="Search" value={filter} onChange={setFilter} placeholder="Search terms, definitions..." /></FilterBar>

      {editing && <div className="card-surface p-5">
        <Section title={editing === 'new' ? 'Add New Term' : `Edit: ${editing}`} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <div><label className="text-[10px] text-ink-400 uppercase">Term</label>
            <input type="text" value={form.term} onChange={e => setForm(f => ({...f, term: e.target.value}))}
              disabled={editing !== 'new'} className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900 disabled:opacity-50" /></div>
          <div><label className="text-[10px] text-ink-400 uppercase">Category</label>
            <input type="text" value={form.category} onChange={e => setForm(f => ({...f, category: e.target.value}))} list="cats"
              className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" />
            <datalist id="cats">{categories.map(c => <option key={c} value={c} />)}</datalist></div>
          <div className="col-span-full"><label className="text-[10px] text-ink-400 uppercase">Definition</label>
            <textarea value={form.definition} onChange={e => setForm(f => ({...f, definition: e.target.value}))} rows={3}
              className="w-full mt-1 px-3 py-2 bg-white border border-surface-200 rounded text-sm text-ink-900 resize-y" /></div>
          <div className="col-span-full"><label className="text-[10px] text-ink-400 uppercase">Examples (comma-separated)</label>
            <input type="text" value={form.examples} onChange={e => setForm(f => ({...f, examples: e.target.value}))} placeholder="example 1, example 2"
              className="w-full mt-1 px-3 py-1.5 bg-white border border-surface-200 rounded text-sm text-ink-900" /></div>
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={save} disabled={saving || !form.term || !form.definition} className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-surface-200 disabled:text-ink-400 text-ink-900 text-xs rounded font-medium">{saving ? 'Saving...' : 'Save'}</button>
          <button onClick={cancel} className="px-4 py-1.5 bg-slate-700 text-ink-900 text-xs rounded">Cancel</button>
        </div>
      </div>}

      <div className="space-y-2">
        {filtered.map((item, i) => (
          <div key={i} className="card-surface px-5 py-3.5 group">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-ink-900 font-medium text-sm">{item.term}</span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/20 border border-navy-500/20 rounded text-brand-600">{item.category || 'General'}</span>
                </div>
                <p className="text-sm text-ink-600 mt-1">{item.definition}</p>
                {item.examples?.length > 0 && <p className="text-[11px] text-ink-500 mt-1">Examples: {item.examples.join(', ')}</p>}
              </div>
              {canEdit && <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-3">
                <button onClick={() => startEdit(item)} className="text-[10px] text-brand-600 hover:text-ink-900 px-2 py-0.5 border border-surface-200 rounded">Edit</button>
                <button onClick={() => remove(item.term)} className="text-[10px] text-red-600 hover:text-red-300 px-2 py-0.5 border border-red-200 rounded">Delete</button>
              </div>}
            </div>
          </div>
        ))}
      </div>
      {!filtered.length && <div className="card-surface p-8 text-center text-ink-500">
        {filter ? 'No matching terms.' : 'No glossary terms yet. Click + Add Term to create the first entry.'}
      </div>}
    </div>
  );
}
