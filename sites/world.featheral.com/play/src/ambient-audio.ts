export const ambientTracks = ['nature', 'village', 'market', 'megacity'] as const;
export type AmbientTrack = typeof ambientTracks[number];
export type AmbientPage = 'explore' | 'settlement';

const audioPath = (track: AmbientTrack): string => `/audio/ambience/${track}.ogg`;
const maximumVolume = 0.22;
const fadeDuration = 900;

export function ambientTrackForPage(page: AmbientPage, stage: number): AmbientTrack {
  if (page === 'explore' || stage < 3) return 'nature';
  if (stage < 6) return 'village';
  if (stage < 14) return 'market';
  return 'megacity';
}

export class AmbientAudio {
  private readonly players = new Map<AmbientTrack, HTMLAudioElement>();
  private track: AmbientTrack;
  private active: HTMLAudioElement | null = null;
  private enabled = false;
  private fadeTimer: number | null = null;

  constructor(track: AmbientTrack) {
    this.track = track;
    for (const name of ambientTracks) {
      const player = new Audio(audioPath(name));
      player.preload = 'auto';
      player.loop = true;
      player.volume = 0;
      player.addEventListener('error', () => {
        console.warn(`Ambient audio could not be loaded: ${audioPath(name)}`, player.error);
      });
      player.load();
      this.players.set(name, player);
    }
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('pageshow', this.handleVisibilityChange);
    window.addEventListener('pagehide', this.pauseAll);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setTrack(track: AmbientTrack): void {
    if (this.track === track) return;
    this.track = track;
    if (this.enabled) this.playTrack(track);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (this.enabled) this.playTrack(this.track);
    else this.fadeOut();
  }

  private playTrack(track: AmbientTrack): void {
    const next = this.players.get(track);
    if (!next || next === this.active) return;
    this.stopFade();
    const previous = this.active;
    for (const player of this.players.values()) {
      if (player !== previous && player !== next) {
        player.pause();
        player.volume = 0;
      }
    }
    next.currentTime = 0;
    next.volume = 0;
    this.active = next;
    void next.play().then(() => {
      if (!this.enabled || this.active !== next) {
        next.pause();
        return;
      }
      this.fadeBetween(previous, next);
    }).catch(error => {
      console.warn(`Ambient audio playback failed: ${audioPath(track)}`, error);
      if (this.active === next) this.active = previous;
    });
  }

  private fadeBetween(previous: HTMLAudioElement | null, next: HTMLAudioElement): void {
    const previousVolume = previous?.volume ?? 0;
    const startedAt = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - startedAt) / fadeDuration);
      next.volume = maximumVolume * progress;
      if (previous) previous.volume = previousVolume * (1 - progress);
      if (progress === 1) {
        previous?.pause();
        this.stopFade();
      }
    }, 40);
  }

  private fadeOut(): void {
    this.stopFade();
    const players = [...this.players.values()].filter(player => !player.paused);
    this.active = null;
    if (!players.length) return;
    const startingVolumes = new Map(players.map(player => [player, player.volume]));
    const startedAt = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - startedAt) / fadeDuration);
      for (const player of players) player.volume = (startingVolumes.get(player) ?? 0) * (1 - progress);
      if (progress === 1) {
        for (const player of players) {
          player.pause();
          player.currentTime = 0;
        }
        this.stopFade();
      }
    }, 40);
  }

  private stopFade(): void {
    if (this.fadeTimer === null) return;
    window.clearInterval(this.fadeTimer);
    this.fadeTimer = null;
  }

  private pauseAll = (): void => {
    this.stopFade();
    for (const player of this.players.values()) player.pause();
  };

  private handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.pauseAll();
      return;
    }
    if (!this.enabled || !this.active) return;
    for (const player of this.players.values()) {
      if (player !== this.active) {
        player.pause();
        player.volume = 0;
      }
    }
    this.active.volume = maximumVolume;
    void this.active.play().catch(error => {
      console.warn(`Ambient audio playback failed: ${this.active ? audioPath(this.track) : 'active track'}`, error);
    });
  };
}
