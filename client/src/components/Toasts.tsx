import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { IconX } from './Icons';

type Kind = 'info' | 'success' | 'error' | 'warning';
interface Toast {
  id: number;
  kind: Kind;
  text: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  show(text: string, kind?: Kind, action?: Toast['action']): void;
  error(e: unknown): void;
}

const Ctx = createContext<ToastApi>({ show() {}, error() {} });
export const useToasts = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (text: string, kind: Kind = 'info', action?: Toast['action']) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-4), { id, kind, text, action }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 7000 : action ? 9000 : 4500);
    },
    [dismiss],
  );
  const error = useCallback((e: unknown) => show(e instanceof Error ? e.message : String(e), 'error'), [show]);
  const api = useRef<ToastApi>({ show, error });
  api.current.show = show;
  api.current.error = error;
  return (
    <Ctx.Provider value={api.current}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <IconX size={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
