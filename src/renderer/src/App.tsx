import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CustomField, Entry, ExportFormat, ProviderKind, ReportDraft } from '../../shared/contracts';
import type { EntryCreateInput, GenerationView, ProviderProfileView, TemplateSummary } from '../../shared/ipc';

type Page = 'today' | 'history' | 'templates' | 'generate' | 'settings';

function localDate(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

const navItems: Array<{ id: Page; label: string; icon: string }> = [
  { id: 'today', label: 'Today', icon: '✦' }, { id: 'history', label: 'History', icon: '◷' },
  { id: 'templates', label: 'Templates', icon: '▤' }, { id: 'generate', label: 'Generate', icon: '↗' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
];

export function App() {
  const [page, setPage] = useState<Page>('today');
  const [locked, setLocked] = useState<boolean>();
  const [recoveryError, setRecoveryError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [providers, setProviders] = useState<ProviderProfileView[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEntries, nextTemplates, nextProviders, nextFields] = await Promise.all([
        window.dsr.entries.list(), window.dsr.templates.list(), window.dsr.providers.list(),
        window.dsr.entries.listCustomFields()
      ]);
      setEntries(nextEntries); setTemplates(nextTemplates); setProviders(nextProviders); setCustomFields(nextFields); setError('');
    } catch (reason) { setError(readableError(reason)); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void window.dsr.security.status().then((status) => {
      setRecoveryError(status.recoveryError ?? '');
      setLocked(status.locked);
      if (!status.locked) void refresh(); else setLoading(false);
    }).catch((reason) => { setError(readableError(reason)); setLocked(true); setLoading(false); });
  }, [refresh]);

  useEffect(() => window.dsr.navigation.onOpen((target) => setPage(target)), []);

  useEffect(() => {
    const handleRejection = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      setError(readableError(event.reason));
    };
    window.addEventListener('unhandledrejection', handleRejection);
    return () => window.removeEventListener('unhandledrejection', handleRejection);
  }, []);

  if (locked === undefined) return <LoadingScreen />;
  if (recoveryError) return <RecoveryScreen message={recoveryError} />;
  if (locked) return <UnlockScreen onUnlock={async (passphrase) => { await window.dsr.security.unlock(passphrase); setLocked(false); await refresh(); }} />;

  return <div className="app-shell"><aside className="sidebar">
    <div className="brand"><span className="brand-mark">D</span><div><strong>DSR Creator</strong><small>Local workspace</small></div></div>
    <nav aria-label="Main navigation">{navItems.map((item) => <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setPage(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>
    <div className="privacy-note"><span>●</span> Stored locally & encrypted</div>
  </aside><main className="main-content">
    {page === 'today' && <TodayPage entries={entries} fields={customFields.filter((field) => field.active)} loading={loading} onSaved={refresh} />}
    {page === 'history' && <HistoryPage entries={entries} onChanged={refresh} />}
    {page === 'templates' && <TemplatesPage templates={templates} providers={providers} onChanged={refresh} />}
    {page === 'generate' && <GeneratePage templates={templates} providers={providers} />}
    {page === 'settings' && <><SettingsPage providers={providers} customFields={customFields} onChanged={refresh} /><BackupHealth /><ProviderQuickActions providers={providers} onChanged={refresh} /><CustomFieldTools onChanged={refresh} /></>}
    {error && <div role="alert" className="error-banner">{error}</div>}
  </main></div>;
}

function LoadingScreen() { return <main className="lock-screen"><div className="lock-card"><span className="brand-mark">D</span><h1>Opening your workspace…</h1></div></main>; }

function RecoveryScreen({ message }: { message: string }) {
  return <main className="lock-screen"><div className="lock-card"><span className="brand-mark">D</span><p className="eyebrow">Workspace recovery required</p><h1>The encrypted database could not be opened</h1><p role="alert">{message}</p><p>Keep the database and its .pre-restore safety copies. Restore the newest encrypted backup after correcting the OS keyring or database file problem.</p></div></main>;
}

function BackupHealth() {
  const [health, setHealth] = useState<{ lastSuccess?: string; lastError?: string }>({});
  useEffect(() => { void window.dsr.backup.status().then(setHealth); }, []);
  return <div className="panel"><h2>Automatic backup health</h2><p className="helper">{health.lastError ? `Last error: ${health.lastError}` : health.lastSuccess ? `Last successful snapshot: ${new Date(health.lastSuccess).toLocaleString()}` : 'A snapshot will be created while the workspace is open.'}</p></div>;
}

function UnlockScreen({ onUnlock }: { onUnlock(passphrase: string): Promise<void> }) {
  const [passphrase, setPassphrase] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <main className="lock-screen"><form className="lock-card" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onUnlock(passphrase); } catch (reason) { setError(readableError(reason)); } finally { setBusy(false); } }}>
    <span className="brand-mark">D</span><p className="eyebrow">Encrypted local workspace</p><h1>Welcome back</h1><p>Your Linux keyring is unavailable, so your passphrase is required at every launch.</p>
    <label className="field"><span>Database passphrase</span><input type="password" autoFocus value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
    {error && <p role="alert" className="inline-error">{error}</p>}<button className="primary" disabled={passphrase.length < 12 || busy}>{busy ? 'Unlocking…' : 'Unlock workspace'}</button>
  </form></main>;
}

function TodayPage({ entries, fields, loading, onSaved }: { entries: Entry[]; fields: CustomField[]; loading: boolean; onSaved(): Promise<void> }) {
  const [note, setNote] = useState(''); const [project, setProject] = useState(''); const [status, setStatus] = useState('in-progress'); const [duration, setDuration] = useState(''); const [blockers, setBlockers] = useState(''); const [links, setLinks] = useState(''); const [tags, setTags] = useState(''); const [customValues, setCustomValues] = useState<Record<string, unknown>>({}); const [saving, setSaving] = useState(false);
  const todaysEntries = useMemo(() => entries.filter((entry) => entry.workDate === localDate()), [entries]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!note.trim() || saving) return; setSaving(true);
    const input: EntryCreateInput = { workDate: localDate(), note: note.trim(), standardValues: { project: project.trim(), status, duration: duration.trim(), blockers: blockers.trim(), links: links.trim() }, customValues, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) };
    try { await window.dsr.entries.create(input); setNote(''); setDuration(''); setBlockers(''); setLinks(''); setTags(''); setCustomValues({}); await onSaved(); } finally { setSaving(false); }
  }
  return <section><header className="page-header"><div><p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>What moved forward today?</h1></div><div className="entry-count"><strong>{todaysEntries.length}</strong><span>updates today</span></div></header>
    <form className="entry-card" onSubmit={save}><label className="field full"><span>What did you work on?</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Write a quick update. Details can stay rough — the report engine will shape them later." rows={4} /></label>
      <div className="field-grid"><label className="field"><span>Project</span><input value={project} onChange={(event) => setProject(event.target.value)} placeholder="Optional" /></label><label className="field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="in-progress">In progress</option><option value="done">Done</option><option value="blocked">Blocked</option></select></label><label className="field"><span>Duration</span><input value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="e.g. 2h" /></label><label className="field"><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="backend, release" /></label><label className="field"><span>Blockers</span><input value={blockers} onChange={(event) => setBlockers(event.target.value)} placeholder="Optional" /></label><label className="field"><span>Links</span><input value={links} onChange={(event) => setLinks(event.target.value)} placeholder="Ticket or PR URLs" /></label>{fields.map((field) => <CustomFieldInput key={field.id} field={field} value={customValues[field.id]} onChange={(value) => setCustomValues((current) => ({ ...current, [field.id]: value }))} />)}</div>
      <div className="form-footer"><span>Entries are saved only on this computer.</span><button className="primary" disabled={!note.trim() || saving}>{saving ? 'Saving…' : 'Save update'}</button></div></form>
    <div className="section-title"><h2>Today’s timeline</h2><span>{todaysEntries.length} items</span></div><div className="timeline">{loading && <p className="empty">Loading your entries…</p>}{!loading && todaysEntries.length === 0 && <p className="empty">No updates yet. Add the first thing you worked on.</p>}{todaysEntries.map((entry) => <EntryCard key={entry.id} entry={entry} onChanged={onSaved} />)}</div>
  </section>;
}

function CustomFieldInput({ field, value, onChange }: { field: CustomField; value: unknown; onChange(value: unknown): void }) {
  if (field.type === 'boolean') return <label className="field checkbox-field"><span>{field.label}</span><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /></label>;
  if (field.type === 'select') return <label className="field"><span>{field.label}</span><select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select></label>;
  return <label className="field"><span>{field.label}</span><input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={String(value ?? '')} onChange={(event) => onChange(field.type === 'number' ? Number(event.target.value) : event.target.value)} /></label>;
}

function HistoryPage({ entries, onChanged }: { entries: Entry[]; onChanged(): Promise<void> }) {
  const [search, setSearch] = useState(''); const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const filtered = entries.filter((entry) => (!search || JSON.stringify(entry).toLowerCase().includes(search.toLowerCase())) && (!dateFrom || entry.workDate >= dateFrom) && (!dateTo || entry.workDate <= dateTo));
  return <section><header className="page-header"><div><p className="eyebrow">Your work archive</p><h1>History</h1></div></header><div className="toolbar"><label className="field"><span>Search</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Notes, project, fields…" /></label><label className="field"><span>From</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label className="field"><span>To</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="timeline">{filtered.length ? filtered.map((entry) => <EntryCard key={entry.id} entry={entry} onChanged={onChanged} />) : <p className="empty">No entries match these filters.</p>}</div></section>;
}

function EntryCard({ entry, onChanged }: { entry: Entry; onChanged(): Promise<void> }) {
  const project = String(entry.standardValues.project || 'General'); const status = String(entry.standardValues.status || 'not set');
  return <article className="timeline-entry"><div className="timeline-dot" /><div className="entry-body"><div className="entry-meta"><span className="project-pill">{project}</span><span>{status.replace('-', ' ')}</span><time>{entry.workDate}</time></div><p>{entry.note}</p>{entry.tags.length > 0 && <div className="tags">{entry.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}<div className="entry-actions"><button onClick={async () => { const note = window.prompt('Edit work update', entry.note); if (note?.trim()) { await window.dsr.entries.update(entry.id, { note: note.trim() }); await onChanged(); } }}>Edit</button><button onClick={async () => { if (window.confirm('Delete this work update? This cannot be undone.')) { await window.dsr.entries.delete(entry.id); await onChanged(); } }}>Delete</button></div></div></article>;
}

function TemplatesPage({ templates, providers, onChanged }: { templates: TemplateSummary[]; providers: ProviderProfileView[]; onChanged(): Promise<void> }) {
  const [name, setName] = useState(''); const [instructions, setInstructions] = useState(''); const [source, setSource] = useState<File>(); const [providerId, setProviderId] = useState(''); const [templateId, setTemplateId] = useState(''); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); setMessage(''); try { await window.dsr.templates.import({ templateId: templateId || undefined, name: name.trim(), instructions: instructions.trim(), providerProfileId: providerId || undefined, sourceName: source?.name, sourceBase64: source ? await fileToBase64(source) : undefined, makeDefault: templates.length === 0 }); setName(''); setInstructions(''); setSource(undefined); setTemplateId(''); setMessage('Template saved and ready to reuse.'); await onChanged(); } catch (reason) { setMessage(readableError(reason)); } finally { setBusy(false); } }
  return <section><header className="page-header"><div><p className="eyebrow">Stored once, reused every day</p><h1>Templates</h1></div></header><div className="two-column"><form className="panel" onSubmit={save}><h2>{templateId ? 'Create a new version' : 'Add a report format'}</h2><label className="field"><span>Existing template</span><select value={templateId} onChange={(event) => { setTemplateId(event.target.value); const selected = templates.find((item) => item.id === event.target.value); if (selected) setName(selected.name); }}><option value="">New template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><label className="field"><span>Template name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Team weekly DSR" /></label><label className="field"><span>Format instructions</span><textarea required={!source} value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={5} placeholder="Describe sections, ordering, tone, grouping, and field mappings." /></label><label className="field"><span>Sample file (optional)</span><input type="file" accept=".docx,.xlsx,.md,.markdown,.txt,.csv" onChange={(event) => setSource(event.target.files?.[0])} /></label><label className="field"><span>AI compiler (optional)</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">Local structural parser</option>{providers.filter((provider) => provider.enabled).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><p className="helper">The sample is parsed once. Future reports use the compact saved blueprint—not the original file.</p><button className="primary" disabled={busy || !name.trim() || (!instructions.trim() && !source)}>{busy ? 'Compiling…' : 'Save template'}</button>{message && <p className="helper">{message}</p>}</form>
    <div className="panel"><h2>Saved formats</h2>{templates.length === 0 && <p className="empty">No templates yet.</p>}{templates.map((template) => <article className="list-card" key={template.id}><div><strong>{template.name}</strong><small>Version {template.versionNumber} · {template.blueprint.sections.length} sections {template.isDefault ? '· Default' : ''}</small></div><div className="row-actions">{!template.isDefault && <button onClick={async () => { await window.dsr.templates.setDefault(template.id); await onChanged(); }}>Make default</button>}<select aria-label={`Version for ${template.name}`} value={template.activeVersionId} onChange={async (event) => { if (window.confirm('Activate this older template version?')) { await window.dsr.templates.activateVersion(template.id, event.target.value); await onChanged(); } }}>{template.versions.map((version) => <option key={version.id} value={version.id}>v{version.versionNumber}</option>)}</select><button onClick={() => { setTemplateId(''); setName(`${template.name} copy`); setInstructions(template.versions.find((version) => version.id === template.activeVersionId)?.instructions ?? ''); }}>Duplicate</button></div></article>)}</div></div></section>;
}

function GeneratePage({ templates, providers }: { templates: TemplateSummary[]; providers: ProviderProfileView[] }) {
  const today = localDate(); const [dateFrom, setDateFrom] = useState(today); const [dateTo, setDateTo] = useState(today); const [templateId, setTemplateId] = useState(templates.find((item) => item.isDefault)?.id ?? templates[0]?.id ?? ''); const [providerId, setProviderId] = useState(providers.find((item) => item.isDefault)?.id ?? ''); const [format, setFormat] = useState<ExportFormat>('markdown'); const [result, setResult] = useState<GenerationView>(); const [draft, setDraft] = useState<ReportDraft>(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  useEffect(() => { if (!templateId && templates[0]) setTemplateId(templates.find((item) => item.isDefault)?.id ?? templates[0].id); }, [templateId, templates]);
  const selectedTemplate = templates.find((template) => template.id === templateId); const needsAi = Boolean(selectedTemplate?.blueprint.narrativeRules.length); const request = { dateFrom, dateTo, templateId, providerProfileId: providerId || undefined, format };
  async function generate() { if (!templateId) return; setBusy(true); setMessage(''); try { const estimate = await window.dsr.reports.estimate(request); if (estimate) setMessage(estimate.requiresChunking ? `Estimated ${estimate.inputTokens.toLocaleString()} tokens. Cached daily chunking will be used.` : `Estimated ${estimate.inputTokens.toLocaleString()} input tokens.`); const next = await window.dsr.reports.generate(request); setResult(next); setDraft(next.draft); } catch (reason) { setMessage(readableError(reason)); } finally { setBusy(false); } }
  async function exportDraft() { if (!result || !draft) return; setBusy(true); try { await window.dsr.reports.updateDraft(result.id, draft); const artifact = await window.dsr.reports.export(result.id, format); setMessage(`Saved ${artifact.bytes.toLocaleString()} bytes to ${artifact.path}`); } catch (reason) { setMessage(readableError(reason)); } finally { setBusy(false); } }
  return <section><header className="page-header"><div><p className="eyebrow">Review before anything leaves your device</p><h1>Generate a report</h1></div></header>{templates.length === 0 ? <p className="empty">Create a template first. Your saved format will appear here automatically.</p> : <><div className="panel generation-controls"><label className="field"><span>From</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label className="field"><span>To</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label><label className="field"><span>Template</span><select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.versionNumber}</option>)}</select></label><label className="field"><span>AI profile</span><select disabled={!needsAi} value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">{needsAi ? 'Choose profile' : 'Not needed'}</option>{providers.filter((provider) => provider.enabled).map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label><label className="field"><span>Output</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>{(['markdown', 'xlsx', 'docx', 'pdf', 'csv', 'json', 'txt'] as ExportFormat[]).map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label></div><div className="send-disclosure"><strong>{needsAi ? 'AI generation' : 'Local generation'}</strong><span>{needsAi ? `Entries from ${dateFrom} to ${dateTo} plus the compact “${selectedTemplate?.name}” blueprint will be sent only to the selected profile.` : 'This template maps saved fields directly, so report content stays fully offline.'}</span></div><div className="action-row"><button className="primary" onClick={generate} disabled={busy || !templateId || (needsAi && !providerId)}>{busy ? 'Working…' : 'Generate preview'}</button>{message && <span className="helper">{message}</span>}</div>{draft && <div className="preview panel"><div className="preview-header"><div><p className="eyebrow">Editable draft</p><h2>{draft.metadata.title}</h2></div><button className="primary" onClick={exportDraft} disabled={busy}>Export report</button></div>{draft.sections.map((section, sectionIndex) => <div className="preview-section" key={section.id}><h3>{section.title}</h3>{section.text !== undefined && <textarea aria-label={`${section.title} content`} value={section.text} onChange={(event) => setDraft(updateSection(draft, sectionIndex, { text: event.target.value }))} rows={5} />}{section.items?.map((item, itemIndex) => <textarea aria-label={`${section.title} item ${itemIndex + 1}`} key={itemIndex} value={item} onChange={(event) => { const items = [...section.items!]; items[itemIndex] = event.target.value; setDraft(updateSection(draft, sectionIndex, { items })); }} rows={2} />)}{section.columns && section.rows && <div className="table-wrap"><table><thead><tr>{section.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{section.rows.map((row, rowIndex) => <tr key={rowIndex}>{section.columns!.map((column) => <td key={column}><input value={row[column] ?? ''} onChange={(event) => { const rows = section.rows!.map((current, index) => index === rowIndex ? { ...current, [column]: event.target.value } : current); setDraft(updateSection(draft, sectionIndex, { rows })); }} /></td>)}</tr>)}</tbody></table></div>}</div>)}</div>}</>}</section>;
}

function SettingsPage({ providers, customFields, onChanged }: { providers: ProviderProfileView[]; customFields: CustomField[]; onChanged(): Promise<void> }) {
  const [editProviderId, setEditProviderId] = useState(''); const [kind, setKind] = useState<ProviderKind>('openai-api'); const [name, setName] = useState(''); const [model, setModel] = useState(''); const [credential, setCredential] = useState(''); const [contextLimit, setContextLimit] = useState(32_768); const [message, setMessage] = useState(''); const [backupPassword, setBackupPassword] = useState(''); const [fieldLabel, setFieldLabel] = useState(''); const [reminderEnabled, setReminderEnabled] = useState(false); const [reminderTime, setReminderTime] = useState('17:30');
  useEffect(() => { void window.dsr.settings.get('reminder').then((value) => { const reminder = value as { enabled?: boolean; time?: string } | undefined; setReminderEnabled(Boolean(reminder?.enabled)); setReminderTime(reminder?.time ?? '17:30'); }); }, []);
  async function saveProvider(event: FormEvent) { event.preventDefault(); try { await window.dsr.providers.save({ id: editProviderId || undefined, name, kind, model, credential: credential || undefined, contextLimit, makeDefault: editProviderId ? undefined : providers.length === 0, enabled: true }); setEditProviderId(''); setName(''); setCredential(''); setModel(''); setMessage('AI profile saved.'); await onChanged(); } catch (reason) { setMessage(readableError(reason)); } }
  return <section><header className="page-header"><div><p className="eyebrow">Change choices at any time</p><h1>Settings</h1></div></header><div className="settings-stack"><div className="panel"><h2>AI profiles</h2><form className="settings-grid" onSubmit={saveProvider}><label className="field"><span>Connection type</span><select value={kind} onChange={(event) => setKind(event.target.value as ProviderKind)}><option value="openai-api">OpenAI API key</option><option value="anthropic-api">Anthropic API key</option><option value="codex-subscription">Codex subscription</option><option value="claude-subscription">Claude subscription</option></select></label><label className="field"><span>Profile name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Work AI" /></label><label className="field"><span>Model</span><input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model ID" /></label><label className="field"><span>Context limit</span><input type="number" min="1024" value={contextLimit} onChange={(event) => setContextLimit(Number(event.target.value))} /></label>{kind.endsWith('-api') && <label className="field"><span>API key</span><input type="password" required value={credential} onChange={(event) => setCredential(event.target.value)} /></label>}<button className="primary">Save AI profile</button></form>{providers.map((provider) => <article className="list-card" key={provider.id}><div><strong>{provider.name}</strong><small>{provider.kind} · {provider.model} · {provider.contextLimit.toLocaleString()} tokens {provider.isDefault ? '· Default' : ''}</small></div><div className="row-actions"><button onClick={async () => { const result = await window.dsr.providers.test(provider.id); setMessage(result.message); }}>Test</button><button onClick={async () => { await window.dsr.providers.save({ id: provider.id, enabled: !provider.enabled }); await onChanged(); }}>{provider.enabled ? 'Disable' : 'Enable'}</button><button onClick={async () => { if (window.confirm('Delete this AI profile?')) { await window.dsr.providers.delete(provider.id); await onChanged(); } }}>Delete</button></div></article>)}{message && <p className="helper">{message}</p>}</div><div className="panel"><h2>Daily reminder</h2><div className="settings-grid"><label className="field checkbox-field"><span>Enable reminder</span><input type="checkbox" checked={reminderEnabled} onChange={(event) => setReminderEnabled(event.target.checked)} /></label><label className="field"><span>Reminder time</span><input type="time" value={reminderTime} onChange={(event) => setReminderTime(event.target.value)} /></label><button className="primary" onClick={async () => { await window.dsr.settings.set('reminder', { enabled: reminderEnabled, time: reminderTime }); setMessage('Reminder saved.'); }}>Save reminder</button></div></div><div className="panel"><h2>Custom entry fields</h2><div className="settings-grid"><label className="field"><span>Field label</span><input value={fieldLabel} onChange={(event) => setFieldLabel(event.target.value)} placeholder="Client, sprint, environment…" /></label><button className="primary" disabled={!fieldLabel.trim()} onClick={async () => { await window.dsr.entries.createCustomField({ label: fieldLabel, type: 'text', options: [] }); setFieldLabel(''); await onChanged(); }}>Add field</button></div>{customFields.map((field) => <article className="list-card" key={field.id}><div><strong>{field.label}</strong><small>{field.type} · {field.active ? 'Active' : 'Disabled'}</small></div><div className="row-actions"><button onClick={async () => { const label = window.prompt('Rename custom field', field.label); if (label?.trim()) { await window.dsr.entries.updateCustomField(field.id, { label: label.trim() }); await onChanged(); } }}>Rename</button><button onClick={async () => { await window.dsr.entries.updateCustomField(field.id, { active: !field.active }); await onChanged(); }}>{field.active ? 'Disable' : 'Enable'}</button></div></article>)}<p className="helper">Historical values remain attached to stable field IDs after renaming or disabling.</p></div><div className="panel"><h2>Encrypted backups</h2><div className="settings-grid"><label className="field"><span>Backup password</span><input type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="At least 12 characters" /></label><button onClick={async () => { try { const result = await window.dsr.backup.create({ password: backupPassword }); setMessage(`Backup saved to ${result.path}`); } catch (reason) { setMessage(readableError(reason)); } }}>Export backup</button><button onClick={async () => { if (window.confirm('Restore a backup and restart DSR Creator? A safety copy of the current database will be retained.')) await window.dsr.backup.restore({ password: backupPassword }); }}>Restore backup</button></div><p className="helper">Automatic encrypted snapshots retain seven daily and four weekly backups.</p></div></div></section>;
}

function ProviderQuickActions({ providers, onChanged }: { providers: ProviderProfileView[]; onChanged(): Promise<void> }) {
  const [message, setMessage] = useState('');
  if (providers.length === 0) return null;
  return <div className="panel provider-actions"><h2>Profile maintenance</h2>{providers.map((provider) => <article className="list-card" key={provider.id}><div><strong>{provider.name}</strong><small>Rename, replace credentials, or change the default without affecting saved reports.</small></div><div className="row-actions">{provider.kind === 'codex-subscription' && <button onClick={async () => { try { const result = await window.dsr.providers.login(provider.id); setMessage(result.message); } catch (reason) { setMessage(readableError(reason)); } }}>Connect with ChatGPT</button>}{!provider.isDefault && <button onClick={async () => { await window.dsr.providers.save({ id: provider.id, makeDefault: true }); await onChanged(); }}>Make default</button>}<button onClick={async () => { const name = window.prompt('Rename AI profile', provider.name); if (name?.trim()) { await window.dsr.providers.save({ id: provider.id, name: name.trim() }); await onChanged(); } }}>Rename</button>{provider.kind.endsWith('-api') && <button onClick={async () => { const credential = window.prompt('Enter the replacement API key'); if (credential?.trim()) { await window.dsr.providers.save({ id: provider.id, credential }); setMessage('Credential replaced securely.'); } }}>Replace key</button>}</div></article>)}{message && <p className="helper">{message}</p>}</div>;
}

function CustomFieldTools({ onChanged }: { onChanged(): Promise<void> }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomField['type']>('text');
  const [options, setOptions] = useState('');
  return <div className="panel provider-actions"><h2>Advanced custom field</h2><div className="settings-grid"><label className="field"><span>Label</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Customer impact" /></label><label className="field"><span>Field type</span><select value={type} onChange={(event) => setType(event.target.value as CustomField['type'])}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / no</option><option value="date">Date</option><option value="select">Choice list</option></select></label>{type === 'select' && <label className="field"><span>Choices</span><input value={options} onChange={(event) => setOptions(event.target.value)} placeholder="Low, Medium, High" /></label>}<button className="primary" disabled={!label.trim()} onClick={async () => { await window.dsr.entries.createCustomField({ label: label.trim(), type, options: options.split(',').map((item) => item.trim()).filter(Boolean) }); setLabel(''); setOptions(''); await onChanged(); }}>Add typed field</button></div></div>;
}

function updateSection(draft: ReportDraft, index: number, patch: Partial<ReportDraft['sections'][number]>): ReportDraft { return { ...draft, sections: draft.sections.map((section, current) => current === index ? { ...section, ...patch } : section) }; }

async function fileToBase64(file: File): Promise<string> { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }

function readableError(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason || 'Something went wrong'); }
