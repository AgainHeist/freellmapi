import { useEffect, useRef, useState } from 'react';
import { useData } from '../hooks';
import { getSaasToken } from '../api';
import { errText, useToast } from '../state';
import { Badge, Button, Card, Field } from '../ui';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export function PlaygroundPage() {
  const { data } = useData<any>('/api/saas/catalog');
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [message, setMessage] = useState('Explain what an AI API gateway does in three sentences.');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(512);
  const [stream, setStream] = useState(true);
  const [output, setOutput] = useState('');
  const [meta, setMeta] = useState<{ latency: number; provider: string | null; model: string | null; requestId: string | null; tokens: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!model && data?.models?.length) setModel(data.models[0].id);
  }, [data, model]);

  const clear = () => { setOutput(''); setMeta(null); setError(null); };

  const run = async () => {
    if (!model) { setError('Choose a model first.'); return; }
    setError(null); setOutput(''); setMeta(null); setRunning(true);
    const started = performance.now();
    const ctrl = new AbortController();
    controller.current = ctrl;
    try {
      const res = await fetch(`${BASE}/api/saas/playground/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(getSaasToken() ? { Authorization: `Bearer ${getSaasToken()}` } : {}) },
        body: JSON.stringify({
          model, systemPrompt: system, stream, temperature, maxTokens,
          messages: [{ role: 'user', content: message }],
        }),
        signal: ctrl.signal,
      });
      const requestId = res.headers.get('X-Request-ID') ?? res.headers.get('X-ALI-BOSS-Request-ID');
      const provider = res.headers.get('X-Provider') ?? res.headers.get('X-Routed-Via');
      const servedModel = res.headers.get('X-Model');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      }
      let text = '';
      let tokens = 0;
      if (stream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.text ?? '';
              if (delta) { text += delta; setOutput(text); }
              if (parsed.usage) tokens = parsed.usage.total_tokens ?? (parsed.usage.prompt_tokens ?? 0) + (parsed.usage.completion_tokens ?? 0);
            } catch { /* keep-alive / non-JSON frames */ }
          }
        }
      } else {
        const body = await res.json().catch(() => ({}));
        text = body.choices?.[0]?.message?.content ?? body.output_text ?? JSON.stringify(body, null, 2);
        setOutput(text);
        tokens = body.usage?.total_tokens ?? 0;
      }
      setMeta({ latency: Math.round(performance.now() - started), provider, model: servedModel ?? model, requestId, tokens });
    } catch (err) {
      if ((err as Error).name === 'AbortError') setError('Stopped.');
      else setError(errText(err));
    } finally {
      setRunning(false);
      controller.current = null;
    }
  };

  return <>
    <div className="ab-page-head"><div><div className="ab-page-title">Playground</div><div className="ab-page-sub">Test any model with live streaming — requests go through your quota and are tracked in analytics.</div></div></div>
    {error && <div className="ab-form-error">{error}</div>}
    <div className="ab-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="ab-grid ab-grid-2">
        <Card>
          <Field label="Model"><select className="ab-select" value={model} onChange={e => setModel(e.target.value)}>
            {!data?.models?.length && <option value="">No models available</option>}
            {(data?.models ?? []).map((m: any) => <option key={`${m.provider}-${m.id}`} value={m.id}>{m.id} · {m.provider}</option>)}
          </select></Field>
          <Field label="System prompt"><textarea className="ab-textarea" rows={3} value={system} onChange={e => setSystem(e.target.value)} /></Field>
          <Field label="User message"><textarea className="ab-textarea" rows={4} value={message} onChange={e => setMessage(e.target.value)} /></Field>
          <div className="ab-grid ab-grid-2">
            <Field label={`Temperature: ${temperature}`}><input className="ab-input" type="range" min={0} max={2} step={0.1} value={temperature} onChange={e => setTemperature(Number(e.target.value))} /></Field>
            <Field label="Max tokens"><input className="ab-input" type="number" min={16} max={8192} value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} /></Field>
          </div>
          <label className="ab-row" style={{ fontSize: 13, marginBottom: 14 }}><input type="checkbox" checked={stream} onChange={e => setStream(e.target.checked)} /> Stream response (SSE)</label>
          <div className="ab-row">
            <Button variant="primary" onClick={() => void run()} loading={running}>{running ? 'Running…' : 'Run'}</Button>
            <Button disabled={!running} onClick={() => controller.current?.abort()}>Stop</Button>
            <Button variant="ghost" onClick={clear}>Clear</Button>
            <Button variant="ghost" onClick={() => { void navigator.clipboard.writeText(output); toast('Response copied.'); }} disabled={!output}>Copy</Button>
          </div>
        </Card>
        <Card>
          <div className="ab-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="ab-card-title">Response</div>
            {running && <Badge tone="red"><span className="ab-live">●</span> streaming</Badge>}
          </div>
          <div className="ab-chat-msg">{output || <span className="ab-muted">Run a request to see the response here.</span>}</div>
          {meta && <div style={{ marginTop: 14 }}>
            <div className="ab-kv"><span>Model</span><span className="ab-mono">{meta.model}</span></div>
            <div className="ab-kv"><span>Provider</span><span>{meta.provider ?? '—'}</span></div>
            <div className="ab-kv"><span>Request ID</span><span className="ab-mono">{meta.requestId ?? '—'}</span></div>
            <div className="ab-kv"><span>Tokens</span><span>{meta.tokens || '—'}</span></div>
            <div className="ab-kv"><span>Latency</span><span>{meta.latency} ms</span></div>
          </div>}
        </Card>
      </div>
    </div>
  </>;
}
