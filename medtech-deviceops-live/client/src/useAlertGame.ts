import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AlertDecisionRequest,
  AlertGameBootstrap,
  AlertGameMode,
  AlertGameRun,
  AlertGameStep,
  AlertGameStepSummary,
  AlertGameSummary,
  AlertRoute,
} from '../../shared/alerts';
import type { Health } from '../../shared/types';
import { api, ApiError } from './lib/api';

const STORAGE_KEY = 'deviceops-alert-game-v1';

interface RouteOperation {
  runId: string;
  alertId: string;
  requestId: string;
  route?: AlertRoute;
  request: AlertDecisionRequest;
}

interface CreateOperation {
  mode: AlertGameMode;
  requestId: string;
}

function remember(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    return;
  }
}

function rememberedId() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function messageOf(failure: unknown) {
  return failure instanceof Error ? failure.message : 'The server could not be reached.';
}

function send<Result>(url: string, body: unknown, signal?: AbortSignal) {
  return api<Result>(url, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(25_000),
    cache: 'no-store',
  });
}

export function useAlertGame() {
  const [run, setRun] = useState<AlertGameRun | null>(null);
  const [runs, setRuns] = useState<AlertGameSummary[]>([]);
  const [steps, setSteps] = useState<AlertGameStepSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [controlBusy, setControlBusy] = useState(true);
  const [routing, setRouting] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pending, setPending] = useState<RouteOperation | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
  const [replay, setReplay] = useState<AlertGameStep | null>(null);
  const [notice, setNotice] = useState('');
  const [frameAt, setFrameAt] = useState(() => performance.now());
  const [clockAnchor, setClockAnchor] = useState(() => ({
    elapsedMs: 0,
    receivedAt: performance.now(),
    running: false,
  }));
  const runRef = useRef<AlertGameRun | null>(null);
  const controlRef = useRef(true);
  const routingRef = useRef(false);
  const replayRef = useRef(false);
  const autopilotRef = useRef(false);
  const pendingRef = useRef<RouteOperation | null>(null);
  const createRef = useRef<CreateOperation | null>(null);
  const failedClock = useRef<boolean | null>(null);
  const initialRequestId = useRef(crypto.randomUUID());
  const anchor = useRef(clockAnchor);
  const mounted = useRef(false);

  const stopAutopilot = useCallback(() => {
    autopilotRef.current = false;
    setAutopilot(false);
  }, []);

  const accept = useCallback(
    (value: AlertGameRun, history?: AlertGameStepSummary[], replace = false) => {
      const previous = runRef.current;
      if (previous && previous.id !== value.id && !replace) return false;
      if (
        previous?.id === value.id &&
        (value.revision < previous.revision ||
          (value.revision === previous.revision && value.observedAt < previous.observedAt))
      ) {
        return false;
      }
      const receivedAt = performance.now();
      runRef.current = value;
      const nextAnchor = {
        elapsedMs: value.snapshot.elapsedMs,
        receivedAt,
        running: value.snapshot.running && !value.snapshot.complete,
      };
      anchor.current = nextAnchor;
      setClockAnchor(nextAnchor);
      setFrameAt(receivedAt);
      setRun(value);
      setSyncError(null);
      remember(value.id);
      if (history) {
        setSteps([...history].sort((left, right) => right.turn - left.turn));
      } else if (value.latestStep) {
        const latest = value.latestStep;
        setSteps((previousSteps) =>
          [latest, ...previousSteps.filter((step) => step.turn !== latest.turn)].sort(
            (left, right) => right.turn - left.turn
          )
        );
      }
      if (!value.snapshot.running || value.snapshot.complete) stopAutopilot();
      return true;
    },
    [stopAutopilot]
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [bootstrapResult, healthResult] = await Promise.allSettled([
        api<AlertGameBootstrap>('/api/alert-games', { signal, cache: 'no-store' }),
        api<Health>('/api/health', { signal, cache: 'no-store' }),
      ]);
      if (signal?.aborted || !mounted.current) return;
      setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
      if (bootstrapResult.status === 'rejected') throw new Error(messageOf(bootstrapResult.reason));
      const bootstrap = bootstrapResult.value;
      setRuns(bootstrap.runs);
      let selected: AlertGameRun | null = null;
      const savedId = rememberedId();
      if (savedId) {
        try {
          selected =
            bootstrap.run?.id === savedId
              ? bootstrap.run
              : await api<AlertGameRun>(`/api/alert-games/${encodeURIComponent(savedId)}`, {
                  signal,
                  cache: 'no-store',
                });
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
        }
      }
      if (signal?.aborted || !mounted.current) return;
      if (!selected) {
        selected = await send<AlertGameRun>(
          '/api/alert-games',
          { seed: 42, mode: 'steady', requestId: initialRequestId.current },
          signal
        );
      }
      const active = selected;
      const history = await api<AlertGameStepSummary[]>(`/api/alert-games/${active.id}/steps`, {
        signal,
        cache: 'no-store',
      });
      if (signal?.aborted || !mounted.current) return;
      accept(active, history, true);
      setRuns((previous) => [active, ...previous.filter((entry) => entry.id !== active.id)]);
      setError(null);
    },
    [accept]
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          controlRef.current = false;
          setControlBusy(false);
          setLoading(false);
        }
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!run?.id) return;
    const timer = window.setInterval(() => setFrameAt(performance.now()), run.snapshot.running || routing ? 100 : 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.snapshot.running, routing]);

  const activeRunId = run?.id;
  const clockRunning = run?.snapshot.running ?? false;
  useEffect(() => {
    if (!activeRunId || (!clockRunning && !routing)) return;
    const runId = activeRunId;
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const value = await api<AlertGameRun>(`/api/alert-games/${runId}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          cache: 'no-store',
        });
        if (!controller.signal.aborted && runRef.current?.id === runId) accept(value);
      } catch (failure) {
        if (!controller.signal.aborted) setSyncError(messageOf(failure));
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeRunId, clockRunning, routing, accept]);

  const refresh = useCallback(async () => {
    const current = runRef.current;
    if (!current) {
      await load();
      return;
    }
    const [value, history, status] = await Promise.all([
      api<AlertGameRun>(`/api/alert-games/${current.id}`, { cache: 'no-store' }),
      api<AlertGameStepSummary[]>(`/api/alert-games/${current.id}/steps`, { cache: 'no-store' }),
      api<Health>('/api/health', { cache: 'no-store' }),
    ]);
    if (!mounted.current || runRef.current?.id !== current.id) return;
    setHealth(status);
    accept(value, history);
  }, [accept, load]);

  const setRunning = useCallback(
    async (running: boolean) => {
      const current = runRef.current;
      if (!current || controlRef.current || (running && (routingRef.current || replayRef.current))) return;
      stopAutopilot();
      controlRef.current = true;
      setControlBusy(true);
      failedClock.current = running;
      try {
        const value = await send<AlertGameRun>(`/api/alert-games/${current.id}/clock`, { running });
        if (!mounted.current) return;
        accept(value);
        failedClock.current = null;
        setError(null);
        setNotice(running ? 'Shift started. Incoming alerts and the game clock are live.' : 'Shift paused.');
      } catch (failure) {
        if (mounted.current) setError(`Could not ${running ? 'start' : 'pause'} the shift. ${messageOf(failure)}`);
      } finally {
        controlRef.current = false;
        if (mounted.current) setControlBusy(false);
      }
    },
    [accept, stopAutopilot]
  );

  const newShift = useCallback(
    async (mode: AlertGameMode, retryCreate = false) => {
      if (controlRef.current || routingRef.current) return;
      stopAutopilot();
      controlRef.current = true;
      setControlBusy(true);
      const operation = retryCreate && createRef.current ? createRef.current : { mode, requestId: crypto.randomUUID() };
      createRef.current = operation;
      try {
        const current = runRef.current;
        if (current?.snapshot.running) {
          const paused = await send<AlertGameRun>(`/api/alert-games/${current.id}/clock`, { running: false });
          if (!mounted.current) return;
          accept(paused);
        }
        const value = await send<AlertGameRun>('/api/alert-games', { seed: 42, ...operation });
        if (!mounted.current) return;
        accept(value, [], true);
        setRuns((previous) => [value, ...previous.filter((entry) => entry.id !== value.id)]);
        setReplay(null);
        replayRef.current = false;
        pendingRef.current = null;
        createRef.current = null;
        failedClock.current = null;
        setPending(null);
        setHasRetry(false);
        setError(null);
        setNotice(`New ${operation.mode} shift, paused. Earlier shifts are retained.`);
      } catch (failure) {
        if (mounted.current) setError(`The new shift could not be created. ${messageOf(failure)}`);
      } finally {
        controlRef.current = false;
        if (mounted.current) setControlBusy(false);
      }
    },
    [accept, stopAutopilot]
  );

  const triage = useCallback(
    async (route?: AlertRoute, retryOperation?: RouteOperation) => {
      const current = runRef.current;
      const projectedElapsed =
        anchor.current.elapsedMs + (anchor.current.running ? performance.now() - anchor.current.receivedAt : 0);
      if (
        !current ||
        controlRef.current ||
        routingRef.current ||
        replayRef.current ||
        !current.snapshot.running ||
        current.snapshot.complete ||
        projectedElapsed >= current.snapshot.durationMs ||
        (!retryOperation && pendingRef.current)
      ) {
        return;
      }
      const next = current.nextDecision;
      if (!next && !retryOperation) return;
      const operation =
        retryOperation ??
        (next
          ? {
              runId: current.id,
              alertId: next.alertId,
              requestId: crypto.randomUUID(),
              ...(route ? { route } : {}),
              request: next.request,
            }
          : null);
      if (!operation || operation.runId !== current.id) return;
      routingRef.current = true;
      setRouting(true);
      pendingRef.current = operation;
      setPending(operation);
      setHasRetry(false);
      setError(null);
      try {
        const value = await send<AlertGameRun>(`/api/alert-games/${current.id}/triage`, {
          alertId: operation.alertId,
          requestId: operation.requestId,
          ...(operation.route ? { route: operation.route } : {}),
        });
        if (!mounted.current || runRef.current?.id !== current.id) return;
        accept(value);
        pendingRef.current = null;
        setPending(null);
        setNotice(value.latestStep?.outcome.message ?? 'Handoff recorded.');
      } catch (failure) {
        if (!mounted.current) return;
        stopAutopilot();
        setError(messageOf(failure));
        setHasRetry(true);
        try {
          let refreshed = await api<AlertGameRun>(`/api/alert-games/${current.id}`, { cache: 'no-store' });
          if (!mounted.current || runRef.current?.id !== current.id) return;
          if (refreshed.snapshot.running && !refreshed.snapshot.complete) {
            refreshed = await send<AlertGameRun>(`/api/alert-games/${current.id}/clock`, { running: false });
          }
          if (!mounted.current) return;
          accept(refreshed);
          if (refreshed.latestStep?.requestId === operation.requestId) {
            pendingRef.current = null;
            setPending(null);
            setHasRetry(false);
            setError(null);
            setNotice('The saved handoff was recovered. No duplicate decision was requested.');
          } else if (failure instanceof ApiError && failure.status === 409) {
            setHasRetry(false);
            pendingRef.current = null;
            setPending(null);
          }
        } catch (refreshFailure) {
          if (mounted.current) setSyncError(`Recovery needs a connection. ${messageOf(refreshFailure)}`);
        }
      } finally {
        routingRef.current = false;
        if (mounted.current) setRouting(false);
      }
    },
    [accept, stopAutopilot]
  );

  const retry = useCallback(async () => {
    if (controlRef.current || routingRef.current) return;
    const operation = pendingRef.current;
    if (operation) {
      if (!runRef.current?.snapshot.running) await setRunning(true);
      if (runRef.current?.snapshot.running) await triage(operation.route, operation);
      return;
    }
    if (createRef.current) {
      await newShift(createRef.current.mode, true);
      return;
    }
    if (failedClock.current !== null) {
      await setRunning(failedClock.current);
      return;
    }
    controlRef.current = true;
    setControlBusy(true);
    try {
      await refresh();
      if (mounted.current) setError(null);
    } catch (failure) {
      if (mounted.current) setError(messageOf(failure));
    } finally {
      controlRef.current = false;
      if (mounted.current) setControlBusy(false);
    }
  }, [newShift, refresh, setRunning, triage]);

  const selectReplay = useCallback(
    async (turn: number) => {
      const current = runRef.current;
      if (!current || controlRef.current || routingRef.current || pendingRef.current) return;
      stopAutopilot();
      controlRef.current = true;
      setControlBusy(true);
      try {
        if (current.snapshot.running) {
          const paused = await send<AlertGameRun>(`/api/alert-games/${current.id}/clock`, { running: false });
          if (!mounted.current) return;
          accept(paused);
        }
        const detail = await api<AlertGameStep>(`/api/alert-games/${current.id}/steps/${turn}`, {
          cache: 'no-store',
        });
        if (!mounted.current) return;
        replayRef.current = true;
        setReplay(detail);
        setError(null);
        setNotice(`Replaying saved handoff ${turn}. The live shift is paused; no AI call was made.`);
      } catch (failure) {
        if (mounted.current) setError(`The saved handoff could not be loaded. ${messageOf(failure)}`);
      } finally {
        controlRef.current = false;
        if (mounted.current) setControlBusy(false);
      }
    },
    [accept, stopAutopilot]
  );

  const openSavedShift = useCallback(
    async (id: string) => {
      if (controlRef.current || routingRef.current || pendingRef.current) return;
      stopAutopilot();
      controlRef.current = true;
      setControlBusy(true);
      try {
        const current = runRef.current;
        if (current?.snapshot.running) {
          const paused = await send<AlertGameRun>(`/api/alert-games/${current.id}/clock`, { running: false });
          if (!mounted.current) return;
          accept(paused);
        }
        let saved = await api<AlertGameRun>(`/api/alert-games/${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (saved.snapshot.running) {
          saved = await send<AlertGameRun>(`/api/alert-games/${saved.id}/clock`, { running: false });
        }
        const history = await api<AlertGameStepSummary[]>(`/api/alert-games/${saved.id}/steps`, {
          cache: 'no-store',
        });
        if (!mounted.current) return;
        accept(saved, history, true);
        replayRef.current = false;
        setReplay(null);
        setPending(null);
        setHasRetry(false);
        setError(null);
        setNotice('Saved shift opened in a paused state. No AI call was made.');
      } catch (failure) {
        if (mounted.current) setError(`The saved shift could not be opened. ${messageOf(failure)}`);
      } finally {
        controlRef.current = false;
        if (mounted.current) setControlBusy(false);
      }
    },
    [accept, stopAutopilot]
  );

  const exitReplay = useCallback(() => {
    replayRef.current = false;
    setReplay(null);
    setNotice('Returned to the preserved live shift. It remains paused.');
  }, []);

  const elapsedMs = replay
    ? replay.afterSnapshot.elapsedMs
    : Math.min(
        run?.snapshot.durationMs ?? 60_000,
        clockAnchor.elapsedMs + (clockAnchor.running ? Math.max(0, frameAt - clockAnchor.receivedAt) : 0)
      );
  const stale = !!syncError || (!!run?.snapshot.running && frameAt - clockAnchor.receivedAt > 3500);
  const deadlineReached = elapsedMs >= (run?.snapshot.durationMs ?? 60_000);

  useEffect(() => {
    if (
      !autopilot ||
      !run?.snapshot.running ||
      !run.nextDecision ||
      controlBusy ||
      routing ||
      error ||
      stale ||
      deadlineReached ||
      replay
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (autopilotRef.current) void triage();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [autopilot, run, controlBusy, routing, error, stale, deadlineReached, replay, triage]);

  const toggleAutopilot = useCallback(() => {
    if (autopilotRef.current) {
      stopAutopilot();
      return;
    }
    const current = runRef.current;
    if (
      !current?.snapshot.running ||
      controlRef.current ||
      routingRef.current ||
      pendingRef.current ||
      replayRef.current
    ) {
      return;
    }
    autopilotRef.current = true;
    setAutopilot(true);
  }, [stopAutopilot]);

  return {
    run,
    runs,
    steps,
    health,
    loading,
    controlBusy,
    routing,
    deciding: routing && !pending?.route,
    autopilot,
    error,
    syncError,
    stale,
    pending,
    hasRetry,
    replay,
    notice,
    elapsedMs,
    deadlineReached,
    snapshot: replay?.afterSnapshot ?? run?.snapshot ?? null,
    step: replay ?? run?.latestStep ?? null,
    newShift,
    setRunning,
    triage,
    retry,
    selectReplay,
    openSavedShift,
    exitReplay,
    toggleAutopilot,
    stopAutopilot,
  };
}
