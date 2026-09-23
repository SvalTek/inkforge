export type EasingFn = (value: number) => number;

export const EASINGS: Record<string, EasingFn> = {
  linear: (value) => value,
  ease_in_sine: (value) => 1 - Math.cos(value * Math.PI / 2),
  ease_out_sine: (value) => Math.sin(value * Math.PI / 2),
  ease_in_out_sine: (value) => -(Math.cos(Math.PI * value) - 1) / 2,
  ease_out_cubic: (value) => 1 - Math.pow(1 - value, 3),
  ease_in_cubic: (value) => value * value * value,
  ease_in_out_cubic: (value) => value < 0.5 ? 4 * value ** 3 : 1 - Math.pow(-2 * value + 2, 3) / 2,
};
