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
  restart() {
    this.stopped = false;
    this.deadline = this.now() + this.duration;
  }
}
