import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Bootstrap,
  FleetSnapshot,
  Health,
  RunView,
  ScenarioKind,
  StepDetail,
  StepSummary,
  TickInput,
} from '../../shared/types';
import { api, ApiError, post } from './lib/api';

const STORAGE_KEY = 'deviceops-current-run';

function remember(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    return;
  }
}

export function useSimulation() {
  const [run, setRun] = useState<RunView | null>(null);
  const [preview, setPreview] = useState<FleetSnapshot | null>(null);
  const [steps, setSteps] = useState<StepSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(true);
  const [deciding, setDeciding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [replay, setReplay] = useState<StepDetail | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
  const runRef = useRef<RunView | null>(null);
  const busyRef = useRef(true);
  const failedTick = useRef<TickInput | null>(null);
  const initialRunId = useRef(crypto.randomUUID());

  const accept = useCallback((value: RunView, history?: StepSummary[]) => {
    const sameRun = runRef.current?.id === value.id;
    runRef.current = value;
    setRun(value);
    remember(value.id);
    setReplay(null);
    setSteps((previous) => {
      if (history) return history;
      if (!value.latestStep) return [];
      return [value.latestStep, ...(sameRun ? previous.filter((step) => step.turn !== value.latestStep?.turn) : [])];
    });
  }, []);

  const pause = useCallback(() => setPlaying(false), []);

  const fetchSaved = useCallback(
    async (signal?: AbortSignal) => {
      const [data, status] = await Promise.all([
        api<Bootstrap>('/api/runs', { signal }),
        api<Health>('/api/health', { signal }),
      ]);
      let selected: RunView | null = null;
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(STORAGE_KEY);
      } catch {
        remembered = null;
      }
      if (remembered) {
        if (remembered === data.run?.id) {
          selected = data.run;
        } else {
          try {
            selected = await api<RunView>(`/api/runs/${encodeURIComponent(remembered)}`, { signal });
          } catch (failure) {
            if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
          }
        }
      }
      if (!selected || selected.sopVersion !== data.policyVersion) {
        selected = await api<RunView>('/api/runs', {
          method: 'POST',
          body: JSON.stringify({ seed: 42, requestId: initialRunId.current, scenario: 'lot_qc' }),
          signal,
        });
      }
      const history = await api<StepSummary[]>(`/api/runs/${selected.id}/steps`, { signal });
      if (signal?.aborted) return;
      setHealth(status);
      setPreview(data.preview);
      if (selected) accept(selected, history);
      setError(null);
    },
    [accept]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchSaved(controller.signal)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : 'The saved simulation could not be loaded.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          busyRef.current = false;
          setBusy(false);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [fetchSaved]);

  const ensureRun = useCallback(async () => {
    if (runRef.current) return runRef.current;
    const created = await post<RunView>('/api/runs', {
      seed: 42,
      requestId: crypto.randomUUID(),
      scenario: 'lot_qc',
    });
    accept(created, []);
    return created;
  }, [accept]);

  const tick = useCallback(
    async (retryInput?: TickInput): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const current = await ensureRun();
        if (current.tick >= 60) {
          pause();
          setNotice('60-turn limit reached. Reset starts a new run and retains this history.');
          return false;
        }
        const input = retryInput ?? { expectedRevision: current.revision, requestId: crypto.randomUUID() };
        failedTick.current = input;
        setDeciding(true);
        const updated = await post<RunView>(`/api/runs/${current.id}/tick`, input);
        accept(updated);
        failedTick.current = null;
        setHasRetry(false);
        setNotice(updated.latestStep?.outcome.message ?? 'Turn saved.');
        if (updated.tick >= 60) pause();
        return true;
      } catch (failure) {
        pause();
        setError(failure instanceof Error ? failure.message : 'The decision could not complete. Simulation paused.');
        if (failure instanceof ApiError && failure.status === 409 && runRef.current) {
          failedTick.current = null;
          try {
            accept(await api<RunView>(`/api/runs/${runRef.current.id}`));
          } catch {
            setNotice('Refresh to load the current saved state.');
          }
        }
        setHasRetry(failedTick.current !== null);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
        setDeciding(false);
      }
    },
    [accept, ensureRun, pause]
  );

  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cycle = async () => {
      const started = performance.now();
      const succeeded = await tick();
      if (succeeded && !cancelled)
        timer = setTimeout(
          () => {
            void cycle();
          },
          Math.max(0, 2000 - (performance.now() - started))
        );
    };
    void cycle();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playing, tick]);

  const operation = useCallback(
    async (action: () => Promise<void>) => {
      if (busyRef.current) return;
      pause();
      busyRef.current = true;
      setBusy(true);
      setError(null);
      failedTick.current = null;
      setHasRetry(false);
      try {
        await action();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Operation failed.');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [pause]
  );

  const startStory = useCallback(
    (scenario: ScenarioKind) =>
      operation(async () => {
        const created = await post<RunView>('/api/runs', {
          seed: 42,
          requestId: crypto.randomUUID(),
          scenario,
        });
        accept(created, []);
        setNotice('Story ready. Ask AI_DECIDE to choose the next action.');
      }),
    [accept, operation]
  );

  const selectReplay = useCallback(
    (turn: number) =>
      operation(async () => {
        if (!runRef.current) return;
        setReplay(await api<StepDetail>(`/api/runs/${runRef.current.id}/steps/${turn}`));
        setNotice(`Replaying saved turn ${turn}. No new inference was requested.`);
      }),
    [operation]
  );

  const retry = useCallback(async () => {
    if (failedTick.current) {
      await tick(failedTick.current);
      return;
    }
    await operation(async () => {
      await fetchSaved();
    });
  }, [fetchSaved, operation, tick]);

  return {
    run,
    steps,
    health,
    busy,
    deciding,
    loading,
    playing,
    error,
    notice,
    replay,
    hasRetry,
    snapshot: replay?.afterSnapshot ?? run?.snapshot ?? preview,
    step: replay ?? run?.latestStep ?? null,
    pause,
    play: () => setPlaying(true),
    tick,
    startStory,
    selectReplay,
    retry,
    exitReplay: () => setReplay(null),
  };
}
