declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    active?: boolean;
    output?: number;
    semitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
  }

  export interface SignalsmithStretchNode extends AudioWorkletNode {
    latency(): Promise<number>;
    schedule(options: StretchSchedule): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
  }

  export default function SignalsmithStretch(
    context: AudioContext,
  ): Promise<SignalsmithStretchNode>;
}
