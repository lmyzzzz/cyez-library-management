import { useEffect, useRef } from "react";

/**
 * 自动模式：预览准备就绪后立即提交一次，不等待倒计时。
 * enabled 或 ready 的后续变化不会重复提交；提交失败由页面显示错误并留给教师
 * 点击确认按钮重试，不自动重放。
 */
export function useAutoSubmit(
  enabled: boolean,
  ready: boolean,
  submit: () => Promise<void>,
) {
  const fired = useRef(false);
  const latest = useRef(submit);
  latest.current = submit;
  useEffect(() => {
    if (!enabled || !ready || fired.current) return;
    fired.current = true;
    void latest.current();
  }, [enabled, ready]);
}

/**
 * 手动模式：同一张卡再次刷卡时 main 递增确认信号，页面提交一次当前预览。
 * signal 从 0 开始，每次流程重挂载都会重新计数，因此不会误提交旧流程。
 */
export function useConfirmSignal(signal: number, submit: () => Promise<void>) {
  const handled = useRef(0);
  const latest = useRef(submit);
  latest.current = submit;
  useEffect(() => {
    if (signal <= handled.current) return;
    handled.current = signal;
    void latest.current();
  }, [signal]);
}
