export interface ScannerControls {
  stop(): void;
}

export interface ScannerDecoder {
  decodeFromStream(
    stream: MediaStream,
    video: HTMLVideoElement,
    onDetected: (value: string) => void,
  ): Promise<ScannerControls>;
}

export type ScannerStartResult = 'ACTIVE' | 'CANCELLED';

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export class BarcodeScannerSession {
  private generation = 0;
  private controls: ScannerControls | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  constructor(
    private readonly getUserMedia: (
      constraints: MediaStreamConstraints,
    ) => Promise<MediaStream>,
    private readonly decoder: ScannerDecoder,
  ) {}

  async start(
    video: HTMLVideoElement,
    onDetected: (value: string) => void,
  ): Promise<ScannerStartResult> {
    this.stop();
    const generation = this.generation;

    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (error) {
      if (generation !== this.generation) return 'CANCELLED';
      throw error;
    }

    if (generation !== this.generation) {
      stopTracks(stream);
      return 'CANCELLED';
    }

    this.stream = stream;
    this.video = video;
    video.srcObject = stream;

    let controls: ScannerControls;
    try {
      controls = await this.decoder.decodeFromStream(stream, video, onDetected);
    } catch (error) {
      if (generation !== this.generation) {
        stopTracks(stream);
        return 'CANCELLED';
      }
      this.releaseActive();
      throw error;
    }

    if (generation !== this.generation) {
      try {
        controls.stop();
      } finally {
        stopTracks(stream);
        if (video.srcObject === stream) video.srcObject = null;
      }
      return 'CANCELLED';
    }

    this.controls = controls;
    return 'ACTIVE';
  }

  stop(): void {
    this.generation += 1;
    this.releaseActive();
  }

  private releaseActive(): void {
    const controls = this.controls;
    const stream = this.stream;
    const video = this.video;

    this.controls = null;
    this.stream = null;
    this.video = null;

    try {
      controls?.stop();
    } catch {
      // Direct track shutdown below is the authoritative cleanup path.
    }
    if (stream !== null) stopTracks(stream);
    if (video !== null && video.srcObject === stream) video.srcObject = null;
  }
}
