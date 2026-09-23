import type { AudioManagerLike, AudioPlayOptions, AudioResolver } from "../types/index.ts";

interface AudioEntry {
  id: string;
  element: HTMLAudioElement;
}

export class AudioManager implements AudioManagerLike {
  private readonly entries = new Map<string, AudioEntry>();
  private sequence = 0;

  constructor(private readonly resolver: AudioResolver, private readonly onError: (message: string) => void) {}

  play(path: string, options: AudioPlayOptions = {}): string {
    const source = this.resolver.url(path);
    const asset = this.resolver.get(path);
    if (!source || !asset?.mime.startsWith("audio/")) {
      this.onError(`Audio asset not found or unsupported: ${path}`);
      return "";
    }
    const id = options.id || `sound-${++this.sequence}`;
    if (this.entries.has(id)) this.stop(id);
    const element = new Audio(source);
    element.preload = "auto";
    element.loop = options.loop === true;
    element.volume = clampVolume(options.volume);
    element.addEventListener("error", () => this.onError(`Audio could not be loaded: ${path}`), { once: true });
    element.addEventListener("ended", () => {
      if (!element.loop && this.entries.get(id)?.element === element) this.entries.delete(id);
    });
    this.entries.set(id, { id, element });
    void element.play().catch(() => this.onError(`Audio playback was blocked: ${path}`));
    return id;
  }

  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.element.pause();
    entry.element.currentTime = 0;
    entry.element.removeAttribute("src");
    entry.element.load();
    this.entries.delete(id);
  }

  pause(id: string): void {
    this.entries.get(id)?.element.pause();
  }

  resume(id: string): void {
    const entry = this.entries.get(id);
    if (entry) void entry.element.play().catch(() => this.onError(`Audio playback was blocked: ${id}`));
  }

  setVolume(id: string, value: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.element.volume = clampVolume(value);
  }

  setLoop(id: string, value: boolean): void {
    const entry = this.entries.get(id);
    if (entry) entry.element.loop = value;
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.stop(id);
  }

  destroy(): void {
    this.stopAll();
  }
}

function clampVolume(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, Number(value)));
}
