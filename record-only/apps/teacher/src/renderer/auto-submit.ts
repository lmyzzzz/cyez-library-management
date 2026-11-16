import { useCallback, useEffect, useRef, useState } from "react";

/** One attempt per preview. User interaction, loss of connection, hiding the
 * window, or a delayed timer cancels automation; none resumes it implicitly. */
export function useAutoSubmit(
  enabled: boolean,
  ready: boolean,
  online: boolean,
  submit: () => Promise<void>,
) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const stopped = useRef(false),
    callback = useRef(submit);
  callback.current = submit;
  const stop = useCallback(() => {
    stopped.current = true;
    setRemaining(null);
  }, []);
  useEffect(() => {
    if (!enabled || stopped.current) return;
    const interaction = () => stop();
    const hidden = () => {
      if (document.hidden) stop();
    };
    const names = ["pointerdown", "keydown", "input", "wheel"];
    names.forEach((name) => document.addEventListener(name, interaction, true));
    document.addEventListener("visibilitychange", hidden);
    return () => {
      names.forEach((name) =>
        document.removeEventListener(name, interaction, true),
      );
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [enabled]);
  useEffect(() => {
    if (!online) stop();
    if (!enabled || !ready || stopped.current) return;
    if (document.hidden) {
      stop();
      return;
    }
    const deadline = performance.now() + 3000;
    setRemaining(3000);
    const timer = setInterval(() => {
      if (stopped.current) return;
      const left = deadline - performance.now();
      if (document.hidden || left < -1000) {
        stop();
        return;
      }
      if (left <= 0) {
        stop();
        void callback.current();
      } else setRemaining(left);
    }, 100);
    return () => clearInterval(timer);
  }, [enabled, ready, online]);
  return { remaining, stop };
}
