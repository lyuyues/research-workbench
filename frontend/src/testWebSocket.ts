/** Minimal stand-in for the browser WebSocket, driven by tests. */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("not open");
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // --- test drivers ---
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emit(event: unknown) {
    this.onmessage?.({ data: typeof event === "string" ? event : JSON.stringify(event) });
  }
  fail() {
    this.onerror?.();
    this.close();
  }
}
