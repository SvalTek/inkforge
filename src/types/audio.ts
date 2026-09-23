import type { AssetResolver } from "../project/assets.ts";

export interface AudioPlayOptions {
  id?: string;
  loop?: boolean;
  volume?: number;
}

export interface AudioManagerLike {
  play(path: string, options?: AudioPlayOptions): string;
  stop(id: string): void;
  pause(id: string): void;
  resume(id: string): void;
  setVolume(id: string, value: number): void;
  setLoop(id: string, value: boolean): void;
  stopAll(): void;
  destroy(): void;
}

export type AudioResolver = Pick<AssetResolver, "url" | "get">;
