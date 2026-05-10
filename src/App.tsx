import { useState, useEffect, useRef, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ReactMarkdown from 'react-markdown';
import './App.css';
import outputs from '../amplify_outputs.json';

const AGENT_ARN = outputs.custom?.agentRuntimeArn;
const SESSIONS_KEY = 'chat_sessions';
const CURRENT_KEY = 'chat_current_session';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isToolUsing?: boolean;
  toolCompleted?: boolean;
  toolName?: string;
}

interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
}

function loadStoredSessions(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionMeta[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function makeSession(): SessionMeta {
  return { id: crypto.randomUUID(), title: '新しい会話', createdAt: new Date().toISOString() };
}

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>(() => {
    const stored = loadStoredSessions();
    if (stored.length > 0) return stored;
    const first = makeSession();
    saveSessions([first]);
    return [first];
  });

  const [currentSessionId, setCurrentSessionId] = useState<string>(() => {
    const stored = localStorage.getItem(CURRENT_KEY);
    const sessions = loadStoredSessions();
    return stored && sessions.find(s => s.id === stored) ? stored : sessions[0]?.id ?? makeSession().id;
  });

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      setMessages([]);
      try {
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        if (!accessToken || cancelled) return;

        const res = await fetch(agentUrl(), {
          method: 'POST',
          headers: agentHeaders(accessToken, currentSessionId),
          body: JSON.stringify({ action: 'get_history' }),
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          for (const line of decoder.decode(value, { stream: true }).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            const event = JSON.parse(data);
            if (event.type === 'history' && !cancelled) {
              setMessages(event.data.map((m: { role: string; content: string }) => ({
                id: crypto.randomUUID(),
                role: m.role as 'user' | 'assistant',
                content: m.content,
              })));
            }
          }
        }
      } catch {
        // 履歴取得失敗時は空のまま続行
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentSessionId]);

  function agentUrl() {
    return `https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;
  }

  function agentHeaders(accessToken: string, sessionId: string) {
    return {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    };
  }

  function switchSession(id: string) {
    setCurrentSessionId(id);
    localStorage.setItem(CURRENT_KEY, id);
  }

  function newSession() {
    const s = makeSession();
    setSessions(prev => {
      const updated = [s, ...prev];
      saveSessions(updated);
      return updated;
    });
    switchSession(s.id);
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: input.trim() };

    // 最初のメッセージでセッションのタイトルを設定
    if (messages.filter(m => m.role === 'user').length === 0) {
      const title = input.trim().slice(0, 30);
      setSessions(prev => {
        const updated = prev.map(s => s.id === currentSessionId ? { ...s, title } : s);
        saveSessions(updated);
        return updated;
      });
    }

    setMessages(prev => [...prev, userMessage, { id: crypto.randomUUID(), role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true);

    const session = await fetchAuthSession();
    const accessToken = session.tokens?.accessToken?.toString();

    const res = await fetch(agentUrl(), {
      method: 'POST',
      headers: agentHeaders(accessToken!, currentSessionId),
      body: JSON.stringify({ prompt: userMessage.content }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isInToolUse = false;
    let toolIdx = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        const event = JSON.parse(data);

        if (event.type === 'tool_use') {
          isInToolUse = true;
          const savedBuffer = buffer;
          setMessages(prev => {
            const msgs = [...prev];
            if (savedBuffer) {
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: savedBuffer };
              toolIdx = msgs.length;
              msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: '', isToolUsing: true, toolName: event.tool_name });
            } else {
              toolIdx = msgs.length - 1;
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], isToolUsing: true, toolName: event.tool_name };
            }
            return msgs;
          });
          buffer = '';
          continue;
        }

        if (event.type === 'text' && event.data) {
          if (isInToolUse && !buffer) {
            const savedIdx = toolIdx;
            setMessages(prev => {
              const msgs = [...prev];
              if (savedIdx >= 0 && savedIdx < msgs.length) msgs[savedIdx] = { ...msgs[savedIdx], toolCompleted: true };
              msgs.push({ id: crypto.randomUUID(), role: 'assistant', content: event.data });
              return msgs;
            });
            buffer = event.data;
            isInToolUse = false;
            toolIdx = -1;
          } else {
            buffer += event.data;
            setMessages(prev => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: buffer, isToolUsing: false };
              return msgs;
            });
          }
        }
      }
    }
    setLoading(false);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <button onClick={newSession} className="new-chat-btn">＋ 新しい会話</button>
        <div className="session-list">
          {sessions.map(s => (
            <div
              key={s.id}
              className={`session-item ${s.id === currentSessionId ? 'active' : ''}`}
              onClick={() => switchSession(s.id)}
            >
              <div className="session-title">{s.title}</div>
              <div className="session-date">
                {new Date(s.createdAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="main">
        <header className="header">
          <h1 className="title">フルサーバーレスなAIエージェントアプリ</h1>
          <p className="subtitle">AmplifyとAgentCoreで構築しています</p>
        </header>

        <div className="message-area">
          <div className="message-container">
            {historyLoading && (
              <div className="history-loading">会話履歴を読み込み中…</div>
            )}
            {!historyLoading && messages.length === 0 && (
              <div className="empty-state">メッセージを入力して会話を始めましょう</div>
            )}
            {messages.map(msg => (
              <div key={msg.id} className={`message-row ${msg.role}`}>
                <div className={`bubble ${msg.role}`}>
                  {msg.role === 'assistant' && !msg.content && !msg.isToolUsing && (
                    <span className="thinking">考え中…</span>
                  )}
                  {msg.isToolUsing && (
                    <span className={`tool-status ${msg.toolCompleted ? 'completed' : 'active'}`}>
                      {msg.toolCompleted ? '✓' : '⏳'} {msg.toolName}
                      {msg.toolCompleted ? 'ツールを利用しました' : 'ツールを利用中...'}
                    </span>
                  )}
                  {msg.content && !msg.isToolUsing && <ReactMarkdown>{msg.content}</ReactMarkdown>}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="form-wrapper">
          <form onSubmit={handleSubmit} className="form">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="メッセージを入力..."
              disabled={loading || historyLoading}
              className="input"
            />
            <button type="submit" disabled={loading || historyLoading || !input.trim()} className="button">
              {loading ? '⌛️' : '送信'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default App;
