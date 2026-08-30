export function posLabel(position: number | null): string {
  if (position === null) return "out of range";
  return `#${position}`;
}

export function difficultyTone(value: number): "good" | "default" | "risk" {
  if (value <= 35) return "good";
  if (value >= 65) return "risk";
  return "default";
}
