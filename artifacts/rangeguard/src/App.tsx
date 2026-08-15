import { type ReactNode, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { type Faction, type MatchMode, type TickState, type MatchResult, type TimelineMoment, type Zone, WS_PATH } from '@workspace/platoontactics-shared';
import { Crosshair, Radio, WifiOff, ChevronRight } from 'lucide-react';
import { Game } from './game/Game';
import { Result } from './game/Result';

const queryClient = new QueryClient();
type Screen = 'menu' | 'lobby' | 'game' | 'result';
const factionColor = (f: Faction) => f === 'ukraine' ? '#4a9fba' : '#b54d43';
const fmt = (n: number) => `${Math.floor(n / 60).toString().padStart(2,'0')}:${Math.floor(n % 60).toString().padStart(2,'0')}`;

function AppShell() { return <><Switch><Route path="/" component={PlatoonTactics} /><Route component={NotFound} /></Switch></>; }

function RoutedErrorBoundary({ children }: { children: ReactNode }) { return <ErrorBoundary resetKey="platoontactics">{children}</ErrorBoundary>; }

function App() { return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RoutedErrorBoundary><AppShell /></RoutedErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>; }

export default App;

function PlatoonTactics() {
  const [screen, setScreen] = useState<Screen>('menu'); const [name, setName] = useState(''); const [codeInput, setCodeInput] = useState('');
  const [code, setCode] = useState(''); const [faction, setFaction] = useState<Faction>('ukraine'); const [opponent, setOpponent] = useState('Awaiting contact'); const [state, setState] = useState<TickState | null>(null); const [result, setResult] = useState<MatchResult | null>(null); const [timeline, setTimeline] = useState<TimelineMoment[]>([]); const [error, setError] = useState(''); const [connected, setConnected] = useState(false); const [connecting, setConnecting] = useState(false); const [requestedMode, setRequestedMode] = useState<MatchMode>('capture'); const [mode, setMode] = useState<MatchMode | null>(null); const [zones, setZones] = useState<Zone[]>([]); const socket = useRef<WebSocket | null>(null);
  const send = (message: unknown) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)); };
  const connect = (action: {type:'create_match';name:string;mode:MatchMode}|{type:'create_solo';name:string;mode:MatchMode}|{type:'join_match';code:string;name:string}) => {
    if (connecting) return; // an attempt is already in flight
    if (!name.trim()) { setError('Callsign required.'); return; }
    setError('');
    // Never open a second socket on top of an existing one.
    if (socket.current) { socket.current.onclose = null; socket.current.close(); socket.current = null; }
    setConnecting(true);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + WS_PATH);
    socket.current = ws;
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify(action)); };
    ws.onclose = () => {
      setConnected(false); setConnecting(false);
      if (socket.current === ws) {
        socket.current = null;
        // An unexpected close mid-match ends on the result screen with no
        // result — the "Signal lost" outcome. A received match_over has
        // already moved us to 'result', and leave() nulls the socket before
        // closing, so neither path lands here.
        setScreen((prev) => (prev === 'game' ? 'result' : prev));
      }
    };
    ws.onerror = () => { setError('Unable to establish uplink.'); setConnecting(false); };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'match_created' || msg.type === 'match_joined') { setConnecting(false); setCode(msg.code); setFaction(msg.faction); setMode(msg.mode); setScreen('lobby'); }
      if (msg.type === 'opponent_joined') setOpponent(msg.opponentName);
      if (msg.type === 'match_start') { setConnecting(false); setFaction(msg.faction); setOpponent(msg.opponentName); setZones(msg.zones ?? []); setMode(msg.mode); setScreen('game'); }
      if (msg.type === 'tick') setState(msg.state);
      if (msg.type === 'match_over') { setState(msg.state); setResult(msg.result); setTimeline(msg.timeline ?? []); setScreen('result'); }
      if (msg.type === 'error') { setError(msg.message); setConnecting(false); ws.close(); if (socket.current === ws) socket.current = null; } // rejected create/join: close cleanly
    };
  };
  const leave = () => { send({type:'leave_match'}); if (socket.current) { socket.current.close(); socket.current = null; } setConnecting(false); setState(null); setResult(null); setTimeline([]); setZones([]); setMode(null); setOpponent('Awaiting contact'); setError(''); setScreen('menu'); setCode(''); };
  return <main className="grain scanlines min-h-[100dvh] overflow-hidden bg-[#171613] font-sans">{screen === 'menu' && <Menu name={name} setName={setName} code={codeInput} setCode={setCodeInput} mode={requestedMode} setMode={setRequestedMode} error={error} busy={connecting} onCreate={() => connect({type:'create_match',name,mode:requestedMode})} onSolo={() => connect({type:'create_solo',name,mode:requestedMode})} onJoin={() => connect({type:'join_match',code:codeInput.toUpperCase(),name})} />} {screen === 'lobby' && mode && <Lobby code={code} faction={faction} opponent={opponent} connected={connected} mode={mode} onLeave={leave} />} {screen === 'game' && mode && <Game state={state} faction={faction} zones={zones} mode={mode} send={send} connected={connected} onLeave={leave} />} {screen === 'result' && mode && <Result result={result} faction={faction} timeline={timeline} mode={mode} onLeave={leave} />}</main>;
}

function ModeToggle({mode,setMode,disabled}:{mode:MatchMode;setMode:(m:MatchMode)=>void;disabled:boolean}) {
  // Two options, no explanatory panel: the mode names carry the meaning.
  return <div className="mb-5 grid grid-cols-2 gap-px bg-[#545043]">
    {(['classic','capture'] as const).map((m) => (
      <button key={m} data-testid={`button-mode-${m}`} onClick={()=>setMode(m)} disabled={disabled} className={`px-3 py-2 text-xs font-bold uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-35 ${mode===m ? 'bg-[#373224] text-[#f0c44a]' : 'bg-[#1e1e1a] text-[#878070] hover:text-[#e7e0c9]'}`}>
        {m === 'classic' ? 'Classic' : 'Capture the Leader'}
      </button>
    ))}
  </div>;
}

function Menu({name,setName,code,setCode,mode,setMode,error,busy,onCreate,onSolo,onJoin}: {name:string;setName:(v:string)=>void;code:string;setCode:(v:string)=>void;mode:MatchMode;setMode:(m:MatchMode)=>void;error:string;busy:boolean;onCreate:()=>void;onSolo:()=>void;onJoin:()=>void}) { return <section className="relative flex min-h-[100dvh] items-center p-6 md:p-16"><div className="absolute inset-y-0 right-0 hidden w-[48%] bg-[radial-gradient(ellipse_at_center,rgba(57,89,78,.45),transparent_68%)] md:block"/><div className="relative z-10 w-full max-w-5xl"><div className="mb-20 flex items-center gap-3 text-xs uppercase tracking-[.28em] text-[#f0c44a]"><Crosshair size={18}/> Frontline Crossing <span className="text-[#716d61]">/</span> Sector 01</div><div className="max-w-2xl"><p className="mb-5 font-mono text-[11px] uppercase tracking-[.35em] text-[#9b9584]">PlatoonTactics Operations Network</p><h1 className="text-[clamp(4rem,11vw,9.5rem)] font-extrabold uppercase leading-[.78] tracking-[-.05em] text-[#e7e0c9]">Platoon<span className="text-[#f0c44a]">Tactics</span></h1><p className="mt-9 max-w-md border-l border-[#f0c44a] pl-4 font-mono text-sm leading-6 text-[#aaa391]">Vision is a weapon. Five soldiers. One objective. No second chances.</p></div><div className="mt-16 max-w-lg border border-[#3c3a32] bg-[#1e1e1a]/90 p-5 shadow-2xl"><label className="mb-2 block font-mono text-[10px] uppercase tracking-widest text-[#9b9584]">Operator callsign</label><input data-testid="input-callsign" value={name} onChange={e=>setName(e.target.value)} placeholder="ENTER NAME" className="mb-5 w-full border-b border-[#545043] bg-transparent px-1 py-3 font-mono text-sm uppercase text-[#e7e0c9] outline-none placeholder:text-[#5e5a4e] focus:border-[#f0c44a]"/><ModeToggle mode={mode} setMode={setMode} disabled={Boolean(code.trim())}/><div className="flex flex-col gap-3 sm:flex-row"><button data-testid="button-create-match" onClick={onCreate} disabled={busy} className="flex flex-1 items-center justify-between bg-[#f0c44a] px-4 py-3 text-sm font-bold uppercase tracking-widest text-[#171613] transition hover:bg-[#ffe17b] disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Connecting…' : 'Create operation'} <ChevronRight size={16}/></button><div className="flex flex-1 border border-[#545043]"><input data-testid="input-join-code" value={code} onChange={e=>setCode(e.target.value)} maxLength={6} placeholder="JOIN CODE" className="min-w-0 flex-1 bg-transparent px-3 font-mono text-xs uppercase outline-none placeholder:text-[#716d61]"/><button data-testid="button-join-match" onClick={onJoin} disabled={busy} className="border-l border-[#545043] px-4 text-xs font-bold uppercase tracking-widest text-[#e7e0c9] hover:bg-[#2c2b24] disabled:cursor-not-allowed disabled:opacity-50">Join</button></div></div><button data-testid="button-solo-match" onClick={onSolo} disabled={busy} className="mt-3 flex w-full items-center justify-between border border-[#545043] px-4 py-3 text-sm font-bold uppercase tracking-widest text-[#e7e0c9] transition hover:border-[#f0c44a] hover:text-[#f0c44a] disabled:cursor-not-allowed disabled:opacity-50">Engage computer opponent <ChevronRight size={16}/></button>{error && <p data-testid="status-error" className="mt-4 flex items-center gap-2 font-mono text-xs text-[#e77b6d]"><WifiOff size={13}/>{error}</p>}</div></div><div className="absolute bottom-7 right-7 hidden text-right font-mono text-[10px] uppercase leading-5 tracking-widest text-[#686456] md:block">AUTH // SECURE<br/>CLIENT BUILD 0.4.7<br/>RULES: SERVER AUTHORITATIVE</div></section>; }

function Lobby({code,faction,opponent,connected,mode,onLeave}:{code:string;faction:Faction;opponent:string;connected:boolean;mode:MatchMode;onLeave:()=>void}) { return <section className="flex min-h-[100dvh] items-center justify-center p-6"><div className="w-full max-w-xl border border-[#3c3a32] bg-[#1e1e1a] p-8 md:p-12"><div className="flex items-center justify-between border-b border-[#39372f] pb-5"><div className="flex items-center gap-2 text-xs uppercase tracking-[.24em] text-[#f0c44a]"><Radio size={16}/> Operation staging</div><span className="font-mono text-[10px] text-[#6f6a5b]">{connected ? 'UPLINK STABLE' : 'UPLINK LOST'}</span></div><p className="mt-12 font-mono text-[10px] uppercase tracking-[.3em] text-[#928b79]">Transmit this code to your opponent</p><div data-testid="text-join-code" className="my-3 font-mono text-7xl font-semibold tracking-[.18em] text-[#f0c44a]">{code || '------'}</div><div className="mb-12 flex items-center gap-3 text-sm text-[#b6af9d]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#f0c44a]"/>Waiting for second operator<span className="text-[#e7e0c9]">{opponent !== 'Awaiting contact' ? opponent : ''}</span></div><div className="grid grid-cols-2 gap-px bg-[#3c3a32]"><div className="bg-[#24231e] p-4"><p className="font-mono text-[10px] uppercase text-[#777263]">Your side</p><p className="mt-2 text-xl font-bold uppercase" style={{color:factionColor(faction)}}>{faction}</p></div><div className="bg-[#24231e] p-4"><p className="font-mono text-[10px] uppercase text-[#777263]">Mode</p><p data-testid="text-match-mode" className="mt-2 text-xl font-bold uppercase text-[#e7e0c9]">{mode === 'capture' ? 'Capture the Leader' : 'Classic'}</p></div></div><button data-testid="button-leave-lobby" onClick={onLeave} className="mt-8 text-xs uppercase tracking-widest text-[#878070] hover:text-[#f0c44a]">Abort staging</button></div></section>; }
