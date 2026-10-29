export class IdleTimer {
  private deadline: number;
  private stopped = false;
  constructor(
    private now: () => number,
    private cancel: () => void,
    private duration = 10000,
  ) {
    this.deadline = now() + duration;
  }
  activity(trusted: boolean) {
    if (!this.check() && trusted && !this.stopped)
      this.deadline = this.now() + this.duration;
  }
  check() {
    if (!this.stopped && this.now() >= this.deadline) {
      this.stopped = true;
      this.cancel();
      return true;
    }
    return this.stopped;
  }
  remaining() {
    return Math.max(0, this.deadline - this.now());
  }
  submit() {
    if (this.check()) return false;
    this.stopped = true;
    return true;
  }
  stop() {
    this.stopped = true;
  }
}
export class EndTimer {
  private deadline: number;
  private paused = false;
  private sent = false;
  constructor(
    private now: () => number,
    private confirm: () => void,
    private duration = 5000,
  ) {
    this.deadline = now() + duration;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    if (!this.sent) {
      this.paused = false;
      this.deadline = this.now() + this.duration;
    }
  }
  tick() {
    if (!this.sent && !this.paused && this.now() >= this.deadline)
      this.submit();
  }
  submit() {
    if (this.sent) return false;
    this.sent = true;
    this.confirm();
    return true;
  }
  remaining() {
    return this.paused ? null : Math.max(0, this.deadline - this.now());
  }
  stop() {
    this.sent = true;
  }
}
